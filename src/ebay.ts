// eBay-Scraper via Playwright + Akamai-Cookies + SOCKS-Tunnel zur Heim-IP.
//
// Warum so kompliziert:
//   eBay/Akamai Bot Manager blockt headless-Browser-Anfragen aus Datacenter-IPs
//   und von Residential-Proxies (Test mit ScrapingFish bestaetigte das). Was
//   funktioniert: echter Chromium-Browser, der mit den Akamai-Bot-Manager-
//   Cookies eines echten User-Sessions kommt und ueber die echte Heim-IP des
//   Users raus geht. Wir erreichen das so:
//     1. User macht initial 'npm run login-ebay' auf seinem PC → Cookies werden
//        gespeichert in playwright-state/ebay.json.
//     2. VPS hat WireGuard-Tunnel zur Heim-FRITZ!Box (Pakete kommen mit Heim-
//        IP raus).
//     3. microsocks lokaler SOCKS5-Proxy mit Source-Bind 192.168.178.201
//        (wg0-Interface).
//     4. Chromium hier laeuft mit proxy=socks5://127.0.0.1:1080 +
//        storageState=ebay.json.
//
//   Result: Akamai sieht "bekannter User mit gueltigen Cookies von vertrauter
//   IP" und laesst durch.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { EbaySale } from './types.js';

const STATE_FILE = path.join('playwright-state', 'ebay.json');
const HEADFUL = process.env.HEADFUL === '1';
const SOCKS_URL = process.env.SOCKS_URL || 'socks5://127.0.0.1:1080';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureBrowser(): Promise<{ page: Page }> {
  if (!browser) {
    browser = await chromium.launch({
      headless: !HEADFUL,
      proxy: { server: SOCKS_URL },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
      ],
    });
  }
  if (!context) {
    const hasState = await fileExists(STATE_FILE);
    if (!hasState) {
      throw new Error(
        `eBay-Cookies fehlen: ${STATE_FILE}\n` +
        `Loese das durch:\n` +
        `  1. Auf deinem PC: npm run login-ebay (browse 2-3 Min auf ebay.com)\n` +
        `  2. Hochladen: scp playwright-state/ebay.json <vps>:/opt/gradetracker-agent/playwright-state/\n`
      );
    }
    context = await browser.newContext({
      storageState: STATE_FILE,
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
  }
  const page = await context.newPage();
  return { page };
}

export async function persistState(): Promise<void> {
  if (context) await context.storageState({ path: STATE_FILE });
}

export async function closeAll(): Promise<void> {
  if (context) await context.close();
  if (browser) await browser.close();
  context = null;
  browser = null;
}

// ─── API ─────────────────────────────────────────────────────────────────

interface SearchSoldOptions {
  searchTerm: string;
  minPriceUsd: number;
  hoursBack: number;
}

export async function searchSoldListings(opts: SearchSoldOptions): Promise<EbaySale[]> {
  const { page } = await ensureBrowser();
  try {
    const url = buildSearchUrl(opts);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return await extractItemsFromPage(page, opts.minPriceUsd, opts.hoursBack);
  } finally {
    await page.close();
  }
}

interface SearchHistoryOptions {
  query: string;
  daysBack: number;
  sellerWhitelist?: string[];
}

export async function searchSoldHistory(opts: SearchHistoryOptions): Promise<EbaySale[]> {
  const { page } = await ensureBrowser();
  try {
    const url = buildSearchUrl({ searchTerm: opts.query, minPriceUsd: 0, hoursBack: opts.daysBack * 24 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const all = await extractItemsFromPage(page, 0, opts.daysBack * 24);
    if (!opts.sellerWhitelist || opts.sellerWhitelist.length === 0) return all;
    const wl = opts.sellerWhitelist.map(s => s.toLowerCase());
    return all.filter(s => wl.includes(s.seller.toLowerCase()));
  } finally {
    await page.close();
  }
}

// ─── Extraction ──────────────────────────────────────────────────────────

async function extractItemsFromPage(page: Page, minPriceUsd: number, hoursBack: number): Promise<EbaySale[]> {
  // eBay nutzt mittlerweile 'li.s-card' parallel zu 'li.s-item' (gleicher Inhalt,
  // neueres Markup). Wir queryn beide.
  const raw = await page.$$eval('li.s-item, li.s-card', (els) => els.map((el) => {
    const titleEl  = el.querySelector('.s-item__title, .s-card__title, [role="heading"]');
    const priceEl  = el.querySelector('.s-item__price, .s-card__price, [class*="price"]');
    const dateEl   = el.querySelector('.s-item__caption .POSITIVE, .s-item__title--tagblock .POSITIVE, [class*="caption"] [class*="POSITIVE"]');
    const linkEl   = el.querySelector('a.s-item__link, a.s-card__link, a[href*="/itm/"]') as HTMLAnchorElement | null;
    const sellerEl = el.querySelector('.s-item__seller-info-text, [class*="seller-info"]');
    return {
      title:      (titleEl?.textContent || '').trim(),
      priceText:  (priceEl?.textContent || '').trim(),
      dateText:   (dateEl?.textContent || '').trim(),
      listingUrl: linkEl?.href || '',
      sellerText: (sellerEl?.textContent || '').trim(),
    };
  }));

  const nowMs = Date.now();
  const maxAgeMs = hoursBack * 3_600_000;
  const out: EbaySale[] = [];
  for (const it of raw) {
    if (!it.title || it.title === 'Shop on eBay' || it.title === 'Results matching fewer words') continue;
    const priceUsd = parsePriceUsd(it.priceText);
    if (priceUsd === null || priceUsd < minPriceUsd) continue;
    const soldDate = parseSoldDate(it.dateText);
    const ageMs = nowMs - new Date(soldDate).getTime();
    if (ageMs > maxAgeMs) continue;
    out.push({
      title: it.title,
      soldPriceUsd: priceUsd,
      soldDate,
      seller: extractSeller(it.sellerText),
      listingUrl: it.listingUrl,
    });
  }
  return out;
}

// ─── URL + Werte-Helper ──────────────────────────────────────────────────

function buildSearchUrl(opts: SearchSoldOptions): string {
  const q = encodeURIComponent(opts.searchTerm);
  const params = `_nkw=${q}&_sacat=0&LH_Sold=1&LH_Complete=1&LH_Auction=1&_sop=13&_udlo=${opts.minPriceUsd}`;
  return `https://www.ebay.com/sch/i.html?${params}`;
}

function parsePriceUsd(text: string): number | null {
  if (!text) return null;
  const m = text.match(/\$\s*([\d,.]+)/);
  if (!m) return null;
  const cleaned = m[1].replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function parseSoldDate(text: string): string {
  if (!text) return new Date().toISOString();
  const m = text.match(/(?:Sold|Verkauft am)\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function extractSeller(text: string): string {
  if (!text) return '';
  const m = text.match(/([A-Za-z0-9_.\-]+)\s*\(/);
  if (m) return m[1].trim();
  return text.trim().split(/\s+/)[0] || '';
}

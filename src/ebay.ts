// eBay-Scraper (Playwright). Login wird einmalig manuell im HEADFUL-Mode
// gemacht; Cookies werden in playwright-state/ebay.json persistiert und
// danach von headless-Sessions weiterverwendet.
//
// Aktueller Stand: SKELETT mit kompletten Signaturen + Playwright-Boilerplate.
// Die echten Selektoren fuer eBay-Listings landen unten in den TODO-Bloecken
// und sollten beim ersten Live-Test gegen die tatsaechlichen DOM-Strukturen
// gepruegt werden.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { EbaySale } from './types.js';

const STATE_DIR = 'playwright-state';
const STATE_FILE = path.join(STATE_DIR, 'ebay.json');
const HEADFUL = process.env.HEADFUL === '1';

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function ensureBrowser(): Promise<{ page: Page }> {
  if (!browser) {
    // Browser-Args fuer stabilen Lauf auf VPS:
    // - --no-sandbox: kein User-Namespace auf root-VPS
    // - --disable-dev-shm-usage: nutzt /tmp statt /dev/shm (oft nur 64MB auf VPS)
    //   → ohne das crashed Chromium beim Laden grosser Seiten ("Target crashed")
    // - --disable-gpu: keine GPU im headless, weniger Crashes
    browser = await chromium.launch({
      headless: !HEADFUL,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  if (!context) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const storageState = await fileExists(STATE_FILE) ? STATE_FILE : undefined;
    context = await browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
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

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

// ─── API ─────────────────────────────────────────────────────────────────

interface SearchSoldOptions {
  searchTerm: string;
  minPriceUsd: number;
  hoursBack: number;
}

// Sucht abgeschlossene eBay-Auktionen mit den angegebenen Filtern.
// Filter-Konstruktion baut die korrekte eBay-Search-URL mit:
//   LH_Sold=1 LH_Complete=1 _sop=13 (date desc) LH_Auction=1 _udlo=<min>
export async function searchSoldListings(opts: SearchSoldOptions): Promise<EbaySale[]> {
  const { page } = await ensureBrowser();
  try {
    const url = buildSearchUrl(opts);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // TODO Live-Test: Cookie/Consent-Banner schliessen, falls anwesend
    // await page.locator('button:has-text("Accept")').click({ timeout: 2000 }).catch(() => {});

    await page.waitForSelector('li.s-item, [data-testid="item-card"]', { timeout: 15_000 }).catch(() => {});

    const items = await page.$$eval('li.s-item', (els) => {
      return els.map((el) => {
        const titleEl = el.querySelector('.s-item__title');
        const priceEl = el.querySelector('.s-item__price');
        const dateEl  = el.querySelector('.s-item__caption .POSITIVE, .s-item__caption .s-item__caption--row');
        const linkEl  = el.querySelector('a.s-item__link') as HTMLAnchorElement | null;
        const sellerEl = el.querySelector('.s-item__seller-info-text');
        return {
          title:  titleEl?.textContent?.trim() || '',
          priceText: priceEl?.textContent?.trim() || '',
          dateText:  dateEl?.textContent?.trim() || '',
          listingUrl: linkEl?.href || '',
          sellerText: sellerEl?.textContent?.trim() || '',
        };
      });
    });

    const out: EbaySale[] = [];
    for (const it of items) {
      if (!it.title || it.title === 'Shop on eBay') continue;
      const priceUsd = parsePriceUsd(it.priceText);
      if (priceUsd === null || priceUsd < opts.minPriceUsd) continue;
      const soldDate = parseSoldDate(it.dateText);
      const hoursAgo = (Date.now() - new Date(soldDate).getTime()) / 3_600_000;
      if (hoursAgo > opts.hoursBack) continue;
      out.push({
        title: it.title,
        soldPriceUsd: priceUsd,
        soldDate,
        seller: extractSeller(it.sellerText),
        listingUrl: it.listingUrl,
      });
    }
    return out;
  } finally {
    await page.close();
  }
}

// Sucht die History-Sales einer spezifischen Karte fuer den PSA10-Aggregator.
// Filtert nach Verkaeufer-Whitelist (PSA10_PREFERRED_SELLERS).
interface SearchHistoryOptions {
  query: string;             // z.B. "luffy OP09-050 PSA 10"
  daysBack: number;
  sellerWhitelist?: string[];  // Lowercase Usernames
}

export async function searchSoldHistory(opts: SearchHistoryOptions): Promise<EbaySale[]> {
  const { page } = await ensureBrowser();
  try {
    const url = buildSearchUrl({ searchTerm: opts.query, minPriceUsd: 0, hoursBack: opts.daysBack * 24 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('li.s-item, [data-testid="item-card"]', { timeout: 15_000 }).catch(() => {});

    // TODO Live-Test: Pagination ueber bis zu N Ergebnisseiten falls noetig
    const items = await page.$$eval('li.s-item', (els) => els.map((el) => ({
      title:  el.querySelector('.s-item__title')?.textContent?.trim() || '',
      priceText: el.querySelector('.s-item__price')?.textContent?.trim() || '',
      dateText: el.querySelector('.s-item__caption')?.textContent?.trim() || '',
      listingUrl: (el.querySelector('a.s-item__link') as HTMLAnchorElement | null)?.href || '',
      sellerText: el.querySelector('.s-item__seller-info-text')?.textContent?.trim() || '',
    })));

    const wl = opts.sellerWhitelist?.map(s => s.toLowerCase());
    const out: EbaySale[] = [];
    for (const it of items) {
      if (!it.title || it.title === 'Shop on eBay') continue;
      const priceUsd = parsePriceUsd(it.priceText);
      if (priceUsd === null) continue;
      const soldDate = parseSoldDate(it.dateText);
      const daysAgo = (Date.now() - new Date(soldDate).getTime()) / 86_400_000;
      if (daysAgo > opts.daysBack) continue;
      const seller = extractSeller(it.sellerText).toLowerCase();
      if (wl && wl.length > 0 && !wl.includes(seller)) continue;
      out.push({
        title: it.title,
        soldPriceUsd: priceUsd,
        soldDate,
        seller,
        listingUrl: it.listingUrl,
      });
    }
    return out;
  } finally {
    await page.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildSearchUrl(opts: SearchSoldOptions): string {
  const q = encodeURIComponent(opts.searchTerm);
  // LH_Sold=1 LH_Complete=1 = Sold/Completed Listings
  // LH_Auction=1 = nur Auktionen
  // _sop=13 = sortiert nach "Recently Ended"
  // _udlo=<min> = minimaler Endpreis
  const params = `_nkw=${q}&_sacat=0&LH_Sold=1&LH_Complete=1&LH_Auction=1&_sop=13&_udlo=${opts.minPriceUsd}`;
  return `https://www.ebay.com/sch/i.html?${params}`;
}

function parsePriceUsd(text: string): number | null {
  if (!text) return null;
  // "$1,234.56" oder "$1.234,56" — eBay USD ist meistens englisch formatiert
  const m = text.match(/\$\s*([\d,.]+)/);
  if (!m) return null;
  const cleaned = m[1].replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function parseSoldDate(text: string): string {
  if (!text) return new Date().toISOString();
  // Beispiele: "Sold  Nov 16, 2025", "Sold Nov 16 2025"
  const m = text.match(/(?:Sold|Verkauft am)\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: now
  return new Date().toISOString();
}

function extractSeller(text: string): string {
  if (!text) return '';
  // "Seller: probstin123 (12345)" oder direkt "probstin123"
  const m = text.match(/([A-Za-z0-9_.\-]+)\s*\(/);
  if (m) return m[1].trim();
  return text.trim().split(/\s+/)[0] || '';
}

// Cardmarket-Scraper. Sucht pro Karte das guenstigste qualifizierte NM-Listing.
// Disqualifizierer-Heuristik wird per Claude (Haiku) entschieden — Audit-fest
// + erweiterbar ohne Code-Aenderung.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { CatalogEntry, CardmarketListing } from './types.js';
import { anthropic, MODELS, SYSTEM_CONTEXT } from './lib/anthropic.js';

const STATE_DIR = 'playwright-state';
const STATE_FILE = path.join(STATE_DIR, 'cardmarket.json');
const FORCE_HEADED = process.env.HEADFUL === '1' || !!process.env.DISPLAY;
const SOCKS_URL = process.env.CM_SOCKS_URL || 'socks5://127.0.0.1:1080';
const USE_SOCKS = process.env.CM_USE_SOCKS !== '0';  // default an (Tunnel zur Heim-IP)
const THROTTLE_MS = parseInt(process.env.CM_THROTTLE_MS || '2500', 10);

const SHIPPING_DE = parseFloat(process.env.SHIPPING_DE_EUR || '10');
const SHIPPING_EU_AVG = (parseFloat(process.env.SHIPPING_EU_MIN_EUR || '20') + parseFloat(process.env.SHIPPING_EU_MAX_EUR || '40')) / 2;

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function ensureBrowser(): Promise<{ page: Page }> {
  if (!browser) browser = await chromium.launch({
    headless: !FORCE_HEADED,
    proxy: USE_SOCKS ? { server: SOCKS_URL } : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=2048',
    ],
  });
  if (!context) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const storageState = await fileExists(STATE_FILE) ? STATE_FILE : undefined;
    context = await browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'de-DE',
    });
  }
  const page = await context.newPage();
  return { page };
}

export async function persistState(): Promise<void> { if (context) await context.storageState({ path: STATE_FILE }); }
export async function closeAll(): Promise<void> { if (context) await context.close(); if (browser) await browser.close(); context = null; browser = null; }

async function fileExists(p: string): Promise<boolean> { try { await fs.stat(p); return true; } catch { return false; } }

// ─── API ─────────────────────────────────────────────────────────────────

interface FindOptions {
  preferredLanguage: 'Englisch' | 'Japanisch';
  maxListings?: number;       // wie viele Listings durchsehen (default 20)
}

// Findet das guenstigste qualifizierte NM-Listing fuer eine Karte.
// Nutzt die Produkt-URL aus dem Katalog falls vorhanden, sonst geht's ueber
// die Cardmarket-Suche.
// Drosselt aufeinanderfolgende CM-Calls — sonst rate-limited Cloudflare uns
// schnell (HTTP 429). 2.5s zwischen Anfragen scheint sicher.
let lastCallAt = 0;
async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < THROTTLE_MS) await new Promise(r => setTimeout(r, THROTTLE_MS - elapsed));
  lastCallAt = Date.now();
}

export async function findCheapestQualifiedListing(card: CatalogEntry, opts: FindOptions): Promise<CardmarketListing | null> {
  await throttle();
  const { page } = await ensureBrowser();
  try {
    const productUrl = await findProductUrl(page, card, opts.preferredLanguage);
    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // TODO Live-Test: Filter auf NM-Kondition setzen (Cardmarket-Filter-UI)
    // await page.locator('[data-testid="filter-condition-NM"]').click();
    await page.waitForTimeout(500);

    // Erste N Listings extrahieren
    const max = opts.maxListings ?? 20;
    const rawListings = await page.$$eval('.article-row, [data-product-id]', (els, max) => {
      return els.slice(0, max).map((el) => ({
        sellerName: el.querySelector('.seller-info, [data-testid="seller-name"]')?.textContent?.trim() || '',
        sellerCountry: (el.querySelector('.seller-country, [data-testid="seller-country"]') as HTMLElement | null)?.title || '',
        priceText: el.querySelector('.price-container, [data-testid="price"]')?.textContent?.trim() || '',
        condition: el.querySelector('.condition, [data-testid="condition"]')?.textContent?.trim() || '',
        language: el.querySelector('.language-flag, [data-testid="language"]')?.getAttribute('title') || '',
        productInfo: el.querySelector('.product-comments, .article-comments')?.textContent?.trim() || '',
      }));
    }, max);

    // Filter: nur NM oder besser
    const acceptCondition = (c: string) => /(^|\s)(M|Mint|NM|Near Mint)(\s|$)/i.test(c);
    const candidates = rawListings.filter(l => acceptCondition(l.condition));
    if (candidates.length === 0) return null;

    // Disqualifizierer-Check per Claude (Batch)
    const qualifications = await batchEvaluateProductInfo(candidates.map(c => c.productInfo));

    // Mit Versand und Qualification anreichern
    const enriched: CardmarketListing[] = candidates.map((c, i) => {
      const priceEur = parsePriceEur(c.priceText);
      const sellerCountry = (c.sellerCountry || 'DE').slice(0, 2).toUpperCase();
      const shippingEur = sellerCountry === 'DE' ? SHIPPING_DE : SHIPPING_EU_AVG;
      return {
        listingUrl: productUrl,
        sellerName: c.sellerName,
        sellerCountry,
        priceEur,
        shippingEur,
        totalEur: priceEur + shippingEur,
        conditionGrade: c.condition,
        language: c.language,
        productInfoRaw: c.productInfo,
        qualifying: qualifications[i].qualifying,
        qualifyingReason: qualifications[i].reason,
      };
    });

    // Sortieren: qualifiziert nach Total-EUR aufsteigend
    const qualified = enriched.filter(l => l.qualifying).sort((a, b) => a.totalEur - b.totalEur);
    return qualified[0] || null;
  } finally {
    await page.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function findProductUrl(page: Page, card: CatalogEntry, language: 'Englisch' | 'Japanisch'): Promise<string | null> {
  // Cardmarket-Suche: /Products/Search?searchString=...
  // (vorheriger Pfad /Cards/{q} gibt es nicht, war falsch).
  // language-Param ist nicht im Search-URL — den setzen wir spaeter auf der
  // Produkt-Seite via Filter, oder die Cookies haben den default schon.
  const game = mapTcgToGame(card.tcg);
  // Klammern, Punkte und V.x-Marker stoeren Cardmarket-Suche. Nur Name + cardId.
  const cleanName = card.name.replace(/\([^)]*\)/g, '').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  const q = `${cleanName} ${card.cardId || ''}`.trim();
  const searchUrl = `https://www.cardmarket.com/de/${game}/Products/Search?searchString=${encodeURIComponent(q)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wenn Cardmarket direkt zur Produktseite redirected (bei eindeutigem Treffer):
  if (page.url().includes('/Products/Singles/')) {
    return page.url();
  }

  // Sonst: Suchtreffer-Liste. Wir nehmen den ersten Produkt-Link.
  const productLink = await page.$eval(
    'a[href*="/Products/Singles/"]',
    (el: Element) => (el as HTMLAnchorElement).href,
  ).catch(() => null);
  return productLink;
}

function mapTcgToGame(tcg: string): string {
  const map: Record<string, string> = {
    'One Piece': 'OnePiece',
    'Pokemon': 'Pokemon',
    'Riftbound': 'Riftbound',
    'Yu-Gi-Oh': 'YuGiOh',
  };
  return map[tcg] || 'OnePiece';
}

function parsePriceEur(text: string): number {
  if (!text) return 0;
  // "1.234,56 €" deutsch
  const m = text.match(/([\d.]+,\d{2}|\d+,\d{2}|\d+(?:\.\d{3})*)/);
  if (!m) return 0;
  const cleaned = m[1].replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

// Sammelt alle Produktinfos in einem einzigen Claude-Call (Batch),
// um Kosten und Latenz zu sparen.
async function batchEvaluateProductInfo(infos: string[]): Promise<Array<{ qualifying: boolean; reason: string }>> {
  if (infos.length === 0) return [];
  const numbered = infos.map((info, i) => `[${i}] ${info || '<leer>'}`).join('\n');
  const response = await anthropic.messages.create({
    model: MODELS.fast,
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM_CONTEXT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `
Aufgabe: Klassifiziere fuer jede der folgenden Cardmarket-Produktinfos, ob die
Karte fuer ein PSA-10-Grading geeignet ist (qualifying=true) oder nicht
(qualifying=false). Disqualifizierer sind erwaehnte Whitening/weisse Kanten,
Print Lines, Scratches, Centering-Probleme, Knicke, Druckfehler.

Antworte als JSON-Array, ein Eintrag pro Input-Zeile:
[{"index": 0, "qualifying": true, "reason": "leer/keine Hinweise"}, ...]

Halte "reason" extrem kurz (max 8 Worte).
      `.trim() },
    ],
    messages: [{ role: 'user', content: numbered }],
  });
  const text = response.content.find(c => c.type === 'text')?.text || '[]';
  try {
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]') as Array<{ index: number; qualifying: boolean; reason: string }>;
    const map = new Map(arr.map(x => [x.index, x]));
    return infos.map((_, i) => map.get(i) || { qualifying: true, reason: 'unsicher' });
  } catch {
    return infos.map(() => ({ qualifying: true, reason: 'parse-error' }));
  }
}

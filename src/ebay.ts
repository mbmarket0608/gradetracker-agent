// eBay-Scraper via ScrapingFish (kein Browser mehr).
//
// eBay/Akamai blockt Datacenter-IPs hart. ScrapingFish routet ueber
// Residential-IPs. Wir bekommen das HTML zurueck und parsen mit cheerio —
// schneller, robuster, kein Chromium-Memory-Crash mehr moeglich.

import * as cheerio from 'cheerio';
import { scrapeHtml } from './lib/scrapingfish.js';
import type { EbaySale } from './types.js';

// ─── API ─────────────────────────────────────────────────────────────────

interface SearchSoldOptions {
  searchTerm: string;
  minPriceUsd: number;
  hoursBack: number;
}

// Sucht abgeschlossene eBay-Auktionen mit den angegebenen Filtern.
export async function searchSoldListings(opts: SearchSoldOptions): Promise<EbaySale[]> {
  const url = buildSearchUrl(opts);
  // render_js=true: eBay-Suchergebnisse sind groesstenteils SSR aber haben
  // lazy-loaded Bereiche. Sicherheitshalber mit JS-Render, kostet uns ein
  // paar Cent mehr aber liefert verlaesslich.
  const html = await scrapeHtml(url, { renderJs: true });
  return parseSoldListings(html, opts.minPriceUsd, opts.hoursBack);
}

interface SearchHistoryOptions {
  query: string;
  daysBack: number;
  sellerWhitelist?: string[];
}

export async function searchSoldHistory(opts: SearchHistoryOptions): Promise<EbaySale[]> {
  const url = buildSearchUrl({
    searchTerm: opts.query,
    minPriceUsd: 0,
    hoursBack: opts.daysBack * 24,
  });
  const html = await scrapeHtml(url, { renderJs: true });
  const all = parseSoldListings(html, 0, opts.daysBack * 24);
  if (!opts.sellerWhitelist || opts.sellerWhitelist.length === 0) return all;
  const wl = opts.sellerWhitelist.map(s => s.toLowerCase());
  return all.filter(s => wl.includes(s.seller.toLowerCase()));
}

// Kompatibilitaets-Stubs (alte API): noop, kein Browser mehr.
export async function persistState(): Promise<void> { /* no-op */ }
export async function closeAll(): Promise<void>      { /* no-op */ }

// ─── HTML-Parsing mit cheerio ────────────────────────────────────────────

function parseSoldListings(html: string, minPriceUsd: number, hoursBack: number): EbaySale[] {
  const $ = cheerio.load(html);
  const out: EbaySale[] = [];
  const nowMs = Date.now();
  const maxAgeMs = hoursBack * 3_600_000;

  $('li.s-item').each((_i, el) => {
    const $el = $(el);
    const title = $el.find('.s-item__title').first().text().trim();
    if (!title || title === 'Shop on eBay' || title === 'Results matching fewer words') return;

    const priceText = $el.find('.s-item__price').first().text().trim();
    const priceUsd = parsePriceUsd(priceText);
    if (priceUsd === null || priceUsd < minPriceUsd) return;

    const dateText = $el.find('.s-item__caption .POSITIVE, .s-item__caption .s-item__caption--row, .s-item__title--tagblock .POSITIVE').first().text().trim();
    const soldDate = parseSoldDate(dateText);
    const ageMs = nowMs - new Date(soldDate).getTime();
    if (ageMs > maxAgeMs) return;

    const linkEl = $el.find('a.s-item__link').first();
    const listingUrl = linkEl.attr('href') || '';

    const sellerText = $el.find('.s-item__seller-info-text').first().text().trim();
    const seller = extractSeller(sellerText);

    out.push({ title, soldPriceUsd: priceUsd, soldDate, seller, listingUrl });
  });

  return out;
}

// ─── URL- und Wert-Helper ────────────────────────────────────────────────

function buildSearchUrl(opts: SearchSoldOptions): string {
  const q = encodeURIComponent(opts.searchTerm);
  // LH_Sold=1 LH_Complete=1 = Sold/Completed
  // LH_Auction=1 = nur Auktionen
  // _sop=13 = sortiert nach "Recently Ended"
  // _udlo=<min> = minimaler Endpreis
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

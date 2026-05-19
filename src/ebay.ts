// eBay-Scraper via SerpAPI.
//
// Akamai Bot Manager blockt jeden Headless/Headed-Browser-Versuch von der
// VPS und auch durch Heim-Tunnel. SerpAPI hat einen professionellen Bypass-
// Stack mit Residential-IPs und TLS-Fingerprint-Spoofing. Wir bekommen fertige
// JSON-Antworten — kein Browser, kein Cookie-Management, kein Stealth-Plugin
// mehr noetig.

import { ebaySearch, type SerpapiEbayItem } from './lib/serpapi.js';
import type { EbaySale } from './types.js';

// ─── API ─────────────────────────────────────────────────────────────────

interface SearchSoldOptions {
  searchTerm: string;
  minPriceUsd: number;
  hoursBack: number;
}

// Sucht abgeschlossene eBay-Auktionen mit den angegebenen Filtern.
export async function searchSoldListings(opts: SearchSoldOptions): Promise<EbaySale[]> {
  const data = await ebaySearch({
    _nkw: opts.searchTerm,
    show_only: 'Sold',
    buying_format: 'Auction',
    _udlo: String(opts.minPriceUsd),
    _sop: '1',    // Time: ending soonest (bei Sold = zuletzt verkauft zuerst)
  });
  return filterByAge(mapItems(data.organic_results || []), opts.hoursBack);
}

interface SearchHistoryOptions {
  query: string;
  daysBack: number;
  sellerWhitelist?: string[];
  minPriceUsd?: number;
}

export async function searchSoldHistory(opts: SearchHistoryOptions): Promise<EbaySale[]> {
  const params: Record<string, string> = {
    _nkw: opts.query,
    show_only: 'Sold',
    buying_format: 'Auction',
    _sop: '1',
  };
  if (opts.minPriceUsd && opts.minPriceUsd > 0) params._udlo = String(opts.minPriceUsd);
  const data = await ebaySearch(params);
  const all = filterByAge(mapItems(data.organic_results || []), opts.daysBack * 24);
  if (!opts.sellerWhitelist || opts.sellerWhitelist.length === 0) return all;
  const wl = opts.sellerWhitelist.map(s => s.toLowerCase());
  return all.filter(s => wl.includes(s.seller.toLowerCase()));
}

// Kompatibilitaets-Stubs — kein Browser mehr.
export async function persistState(): Promise<void> { /* no-op */ }
export async function closeAll(): Promise<void>      { /* no-op */ }

// ─── Mapping ─────────────────────────────────────────────────────────────

function mapItems(items: SerpapiEbayItem[]): EbaySale[] {
  const out: EbaySale[] = [];
  for (const it of items) {
    const title = it.title?.trim() || '';
    if (!title) continue;
    const priceUsd = it.price?.extracted ?? null;
    if (priceUsd == null) continue;
    const soldDate = parseSoldDate(it.sold_date);
    out.push({
      title,
      soldPriceUsd: priceUsd,
      soldDate,
      seller: (it.seller?.username || '').trim(),
      listingUrl: it.link || '',
    });
  }
  return out;
}

function filterByAge(items: EbaySale[], hoursBack: number): EbaySale[] {
  // SerpAPI liefert sold_date nur tagesgenau (z.B. "May 18, 2026"), parsed als
  // 00:00 UTC. Mit Stunden-Cutoff wuerden Items von heute morgen schon vor
  // 24h "verkauft" sein. Runden auf Tages-Boundary: cutoff = Mitternacht des
  // Tages vor X (Math.ceil(hoursBack/24)) Tagen.
  const daysBack = Math.max(1, Math.ceil(hoursBack / 24));
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  // Mit hoursBack=24 wollen wir "gestern und heute" einschliessen.
  // setDate(-daysBack) bewegt cutoff auf gestern 00:00 (bei daysBack=1).
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffMs = cutoff.getTime();
  return items.filter(it => new Date(it.soldDate).getTime() >= cutoffMs);
}

function parseSoldDate(soldDate: string | undefined): string {
  if (!soldDate) return new Date().toISOString();
  // Format: "Aug 28, 2025" oder "Sep 12, 2025"
  const d = new Date(soldDate);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

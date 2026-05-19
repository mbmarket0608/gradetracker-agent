// SerpAPI eBay-Search-Endpoint.
// Doku: https://serpapi.com/ebay-search-api
// Endpoint: GET https://serpapi.com/search?engine=ebay&api_key=...&...

const API = 'https://serpapi.com/search';

export interface SerpapiSeller {
  username?: string;
  reviews?: number;
  positive_feedback_in_percentage?: number;
}

export interface SerpapiPrice {
  raw?: string;
  extracted?: number;
  from?: { raw: string; extracted: number };
  to?:   { raw: string; extracted: number };
}

export interface SerpapiEbayItem {
  position?: number;
  title?: string;
  link?: string;
  price?: SerpapiPrice;
  seller?: SerpapiSeller;
  condition?: string;
  sold_date?: string;
  unsold_date?: string;
  shipping?: string;
  location?: string;
  thumbnail?: string;
}

export interface SerpapiEbayResponse {
  organic_results?: SerpapiEbayItem[];
  search_information?: { total_results?: number };
  error?: string;
}

export async function ebaySearch(params: Record<string, string>): Promise<SerpapiEbayResponse> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY fehlt in .env');

  const url = new URL(API);
  url.searchParams.set('engine', 'ebay');
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const resp = await fetch(url.toString(), { method: 'GET' });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`SerpAPI ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json() as SerpapiEbayResponse;
  if (data.error) {
    // Soft-Error "eBay hat 0 Treffer fuer diese Query" ist KEIN Fehler — z.B.
    // wenn eine spezifische Karten-Historie keine Sold-Listings hat. Nur echte
    // API-Fehler werfen (Invalid key, Quota, etc.).
    const msg = data.error.toLowerCase();
    if (msg.includes('no results') || msg.includes("hasn't returned") || msg.includes('did not return any results')) {
      return { organic_results: [], search_information: { total_results: 0 } };
    }
    throw new Error(`SerpAPI: ${data.error}`);
  }
  return data;
}

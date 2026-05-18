// ScrapingFish-Client: routet HTTP-Requests durch Residential-Proxies
// (notwendig fuer eBay und ggf. Cardmarket, die VPS-Datacenter-IPs blockieren).
//
// API-Doku: https://scrapingfish.com/docs/api-reference
// Endpoint: GET https://api.scrapingfish.com/api/v1/
// Auth:     ?api_key=...
// Optional: render_js=true (fuer JS-rendered SPAs), session=<id> (persistente
//           Cookies ueber mehrere Calls), screenshot=true (Debug).

const API_URL = 'https://api.scrapingfish.com/api/v1/';

export interface FetchOptions {
  renderJs?: boolean;
  session?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function scrapeHtml(targetUrl: string, opts: FetchOptions = {}): Promise<string> {
  const apiKey = process.env.SCRAPINGFISH_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGFISH_API_KEY fehlt in .env');

  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
  });
  if (opts.renderJs) params.set('render_js', 'true');
  if (opts.session)  params.set('session', opts.session);
  if (opts.headers)  params.set('headers', JSON.stringify(opts.headers));

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60_000);
  try {
    const resp = await fetch(`${API_URL}?${params.toString()}`, {
      method: 'GET',
      signal: ac.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ScrapingFish ${resp.status}: ${errText.slice(0, 200)}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

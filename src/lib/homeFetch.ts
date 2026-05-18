// fetch-Client der ueber den WireGuard-Tunnel zur Heim-FRITZ!Box raus geht.
// Source-IP-Binding via undici-Agent (localAddress = wg0-Interface-IP).
//
// Damit gehen eBay-Calls mit Heim-IP raus (eBay sieht keine VPS-Datacenter-
// IP mehr). Restlicher VPS-Traffic (Supabase, Anthropic, SSH-Replies, Vercel)
// bleibt direkt ueber die VPS-Default-Route — schnell + ohne Tunnel-Overhead.

import { Agent } from 'undici';

const HOME_IPV4 = process.env.WG_LOCAL_IPV4 || '';
const HOME_IPV6 = process.env.WG_LOCAL_IPV6 || '';

let dispatcher: Agent | undefined;
if (HOME_IPV4) {
  dispatcher = new Agent({
    connect: { localAddress: HOME_IPV4 },
    // Generous timeouts — Heim-Internet kann langsamer sein als VPS
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
  });
}

// Holt HTML einer URL ueber den WireGuard-Tunnel (= Heim-IP).
// Wenn WG_LOCAL_IPV4 nicht gesetzt ist, faellt zurueck auf normalen fetch
// (fuer lokale Entwicklung praktisch).
export async function fetchHtmlViaHome(url: string, headers?: Record<string, string>): Promise<string> {
  const init: RequestInit & { dispatcher?: Agent } = {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      ...(headers || {}),
    },
  };
  if (dispatcher) init.dispatcher = dispatcher;

  const resp = await fetch(url, init as RequestInit);
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`fetch ${resp.status} ${resp.statusText} from ${url} — body: ${errBody.slice(0, 200)}`);
  }
  return await resp.text();
}

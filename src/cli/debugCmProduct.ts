// Diagnose: oeffnet eine Cardmarket-Produktseite und prueft welche Selektoren
// fuer die Listings (Verkaeufer-Rows) tatsaechlich matchen.

import { chromium as pwExtraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
pwExtraChromium.use(StealthPlugin());
const chromium = pwExtraChromium;
import fs from 'node:fs/promises';

const SOCKS_URL = process.env.CM_SOCKS_URL || 'socks5://127.0.0.1:1080';
const USE_SOCKS = process.env.CM_USE_SOCKS !== '0';

// Beispiel-Produktseite einer existierenden Karte
const URL = 'https://www.cardmarket.com/de/OnePiece/Products/Singles/The-Best-Vol2/Roronoa-Zoro-OP06-118';

(async () => {
  console.log('USE_SOCKS:', USE_SOCKS, 'URL:', SOCKS_URL);
  const browser = await chromium.launch({
    headless: !process.env.HEADFUL && !process.env.DISPLAY,
    proxy: USE_SOCKS ? { server: SOCKS_URL } : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const stateFile = './playwright-state/cardmarket.json';
  const hasState = await fs.stat(stateFile).then(() => true).catch(() => false);
  const context = await browser.newContext({
    storageState: hasState ? stateFile : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'de-DE',
  });
  const page = await context.newPage();

  console.log('Navigating to:', URL);
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log('Initial HTTP:', resp?.status(), '| Title:', await page.title());

  // Warte auf Cloudflare-Challenge
  for (let i = 0; i < 20; i++) {
    const t = await page.title().catch(() => '');
    if (!/just a moment|checking your browser/i.test(t)) break;
    console.log('  ...warte auf Cloudflare-Resolve, Title:', t);
    await page.waitForTimeout(1000);
  }
  console.log('After-wait Title:', await page.title());

  // Pruefe gaengige Selektoren fuer eine Listing-Row
  const candidates = [
    '.article-row',
    '[data-product-id]',
    '[data-article-id]',
    '.table-body .row',
    '.article-table .row',
    'article',
    'tr[role="row"]',
    '.col-seller',
    '.seller-info',
  ];

  console.log('\nSelektor-Counts:');
  for (const sel of candidates) {
    const n = await page.locator(sel).count().catch(() => -1);
    console.log(`  ${sel.padEnd(35)} → ${n}`);
  }

  // HTML der ersten article-row dumpen
  const article = page.locator('.article-row, [data-product-id], .article-table tr, .table-body > .row').first();
  if (await article.count() > 0) {
    const html = await article.innerHTML();
    console.log('\nErste Listing-Row HTML (gekuerzt auf 2000 chars):');
    console.log(html.slice(0, 2000));
  } else {
    console.log('\nKeine Listing-Row mit den ueblichen Selektoren gefunden.');
    // alle Klassen in der article-section
    const seen = new Set<string>();
    const els = await page.locator('section *[class]').all().catch(() => []);
    for (const el of els.slice(0, 100)) {
      const cls = await el.getAttribute('class') || '';
      cls.split(/\s+/).forEach(c => seen.add(c));
    }
    console.log('Vorkommende Klassen in <section>:', Array.from(seen).slice(0, 50));
  }

  await fs.writeFile('/tmp/cm-product-debug.html', await page.content());
  console.log('\nVolles HTML: /tmp/cm-product-debug.html');

  await browser.close();
})();

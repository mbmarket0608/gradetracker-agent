// Diagnose-Skript: oeffnet eine Cardmarket-Such-URL, prueft ob die VPS-IP
// blockiert ist (analog zu debug-ebay). Wenn HTTP 200 + sinnvoller Content
// → CM funktioniert direkt, kein ScrapingFish noetig. Wenn 403/blocked
// → CM auch ueber ScrapingFish leiten.

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const URL = 'https://www.cardmarket.com/de/OnePiece/Products/Search?searchString=Luffy';

(async () => {
  console.log('Starting browser…');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-software-rasterizer', '--disable-extensions',
      '--js-flags=--max-old-space-size=2048',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'de-DE',
  });

  const page = await context.newPage();

  page.on('crash', () => console.error('[crash] page crashed!'));
  page.on('console', msg => { if (msg.type() === 'error') console.log('[console-error]', msg.text()); });

  try {
    console.log('Navigating to:', URL);
    const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.log('HTTP status:', resp?.status());
    console.log('Final URL :', page.url());
    console.log('Title     :', await page.title());

    await page.screenshot({ path: '/tmp/cm-debug.png', fullPage: false });
    console.log('Screenshot saved: /tmp/cm-debug.png');

    const html = await page.content();
    await fs.writeFile('/tmp/cm-debug.html', html);
    console.log('HTML saved:', html.length, 'bytes → /tmp/cm-debug.html');

    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const lowered = bodyText.slice(0, 3000).toLowerCase();
    const flags: string[] = [];
    if (lowered.includes('captcha') || lowered.includes('verify you')) flags.push('CAPTCHA-hint');
    if (lowered.includes('access denied') || lowered.includes('blocked')) flags.push('Block-hint');
    if (lowered.includes('unusual traffic')) flags.push('Unusual-traffic-hint');
    if (lowered.includes('cloudflare')) flags.push('Cloudflare');
    console.log('Bot-flags:', flags.length ? flags.join(',') : '(none)');
    console.log('Body-snippet (first 400 chars):', bodyText.slice(0, 400).replace(/\s+/g, ' '));
  } catch (e) {
    console.error('FAIL during navigation:', e instanceof Error ? `${e.name}: ${e.message}` : e);
  } finally {
    await browser.close();
  }
})();

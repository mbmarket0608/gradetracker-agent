// Diagnose-Skript: oeffnet die eBay-Such-URL, dumpt Title/Status/HTML/Screenshot
// damit wir sehen was die VPS-IP von eBay tatsaechlich bekommt.
//
// Verwendung auf der VPS:
//   cd /opt/gradetracker-agent && sudo -u agent npm run debug-ebay
//   ls -la /tmp/ebay-debug.{png,html}

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const URL = 'https://www.ebay.com/sch/i.html?_nkw=One+Piece+PSA+10&_sacat=0&LH_Sold=1&LH_Complete=1&LH_Auction=1&_sop=13&_udlo=700';

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
    locale: 'en-US',
  });

  const page = await context.newPage();

  page.on('crash', () => console.error('[crash] page crashed!'));
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('[console-error]', msg.text());
  });
  page.on('response', r => {
    if (!r.ok() && r.url().includes('ebay.com')) console.log('[http]', r.status(), r.url().slice(0, 120));
  });

  try {
    console.log('Navigating to:', URL);
    const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.log('HTTP status:', resp?.status());
    console.log('Final URL :', page.url());
    console.log('Title     :', await page.title());

    await page.screenshot({ path: '/tmp/ebay-debug.png', fullPage: false });
    console.log('Screenshot saved: /tmp/ebay-debug.png');

    const html = await page.content();
    await fs.writeFile('/tmp/ebay-debug.html', html);
    console.log('HTML saved:', html.length, 'bytes → /tmp/ebay-debug.html');

    // Test: wie viele s-item-Elemente?
    const countA = await page.$$eval('li.s-item', els => els.length).catch(e => `eval-failed: ${e.message}`);
    console.log('li.s-item count:', countA);

    // Test: kommt Captcha/Bot-Block-Text vor?
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const lowered = bodyText.slice(0, 2000).toLowerCase();
    const flags: string[] = [];
    if (lowered.includes('robot') || lowered.includes('captcha') || lowered.includes('verify you')) flags.push('CAPTCHA-hint');
    if (lowered.includes('access denied') || lowered.includes('blocked')) flags.push('Block-hint');
    if (lowered.includes('unusual traffic')) flags.push('Unusual-traffic-hint');
    console.log('Bot-flags:', flags.length ? flags.join(',') : '(none)');
    console.log('Body-snippet (first 300 chars):', bodyText.slice(0, 300).replace(/\s+/g, ' '));
  } catch (e) {
    console.error('FAIL during navigation:', e instanceof Error ? `${e.name}: ${e.message}` : e);
  } finally {
    await browser.close();
  }
})();

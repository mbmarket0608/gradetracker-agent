// Diagnose: Chromium auf VPS mit User-Cookies + SOCKS-Proxy (Tunnel zur Heim-IP).
// Testet ob Akamai die Anfrage akzeptiert, wenn Cookies + IP + echter Browser
// zusammenpassen.

import { chromium as pwExtraChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
pwExtraChromium.use(StealthPlugin());
const chromium = pwExtraChromium;

const SOCKS = process.env.SOCKS_URL || 'socks5://127.0.0.1:1080';
const STATE = './playwright-state/ebay.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const URL = 'https://www.ebay.com/sch/i.html?_nkw=One+Piece+PSA+10&LH_Sold=1&LH_Complete=1&LH_Auction=1&_sop=13&_udlo=700';

(async () => {
  console.log('Launching Chromium with SOCKS:', SOCKS);
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: SOCKS },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({
    storageState: STATE,
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  console.log('Navigating:', URL);
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  console.log('HTTP status:', resp?.status());
  console.log('Final URL :', page.url());
  console.log('Title     :', await page.title());

  const cookieCount = (await context.cookies()).length;
  console.log('Active cookies:', cookieCount);

  const items = await page.locator('li.s-item, li.s-card').count();
  console.log('s-item/s-card count:', items);

  // Screenshot zur Begutachtung
  await page.screenshot({ path: '/tmp/ebay-with-cookies.png' });
  console.log('Screenshot: /tmp/ebay-with-cookies.png');

  const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 500);
  console.log('Body-snippet:', bodyText.replace(/\s+/g, ' '));

  await browser.close();
})().catch(e => { console.error('FAIL:', e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });

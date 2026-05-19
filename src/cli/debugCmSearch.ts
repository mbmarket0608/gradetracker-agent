// Diagnose: was bekommen wir bei einer konkreten Cardmarket-Karten-Suche?

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

(async () => {
  const browser = await chromium.launch({
    headless: !process.env.HEADFUL && !process.env.DISPLAY,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const stateFile = './playwright-state/cardmarket.json';
  const hasState = await fs.stat(stateFile).then(() => true).catch(() => false);
  console.log('storageState file exists:', hasState);

  const context = await browser.newContext({
    storageState: hasState ? stateFile : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'de-DE',
  });
  const page = await context.newPage();

  const queries = [
    'Monkey D Luffy OP09-050',
    'Roronoa Zoro OP06-118',
    'Shanks OP01-120',
  ];

  for (const q of queries) {
    const url = `https://www.cardmarket.com/de/OnePiece/Products/Search?searchString=${encodeURIComponent(q)}`;
    console.log('\n--- Query:', q);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log('HTTP:', resp?.status(), '| Final URL:', page.url());
      console.log('Title:', await page.title());
      const singleLinks = await page.locator('a[href*="/Products/Singles/"]').count();
      console.log('Singles-Links found:', singleLinks);
      if (singleLinks > 0) {
        const first = await page.locator('a[href*="/Products/Singles/"]').first().getAttribute('href');
        console.log('First link:', first);
      }
    } catch (e) {
      console.log('FAIL:', e instanceof Error ? e.message : e);
    }
  }

  await browser.close();
})();

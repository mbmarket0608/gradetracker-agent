// Cookie-Erfassungs-Skript fuer eBay (Akamai Bot Manager Tokens).
//
// Hintergrund: eBay/Akamai blockt frische Browser-Instanzen sofort als Bot.
// Aber: wenn unser VPS-Chromium die selben Akamai-Cookies (bm_*, bm_so, ...)
// dabei hat, die ein echter User-Browser hat, sieht es Akamai als
// "vertrauten User mit gueltigem Bot-Manager-Score" und laesst durch.
//
// Verwendung lokal:
//   npm run login-ebay
// Browser oeffnet sich → du browst kurz auf ebay.com (Suche, Klick auf
// Listings, vielleicht einloggen). Damit baut Akamai dir einen sauberen
// Bot-Manager-Score auf. Drueck Enter im Terminal → Cookies gespeichert.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const STATE_DIR = 'playwright-state';
const STATE_FILE = path.join(STATE_DIR, 'ebay.json');

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt + '\n', () => { rl.close(); resolve(); }));
}

(async () => {
  console.log('eBay-Cookie-Sammler.\n');
  console.log('Schritte:');
  console.log('  1. Browser oeffnet sich auf ebay.com');
  console.log('  2. Browse 2-3 Minuten ganz normal — eine Suche, ein Klick auf ein Listing, scrollen.');
  console.log('     Das baut Akamai-Bot-Manager-Score auf.');
  console.log('  3. Wenn du fertig bist, drueck ENTER hier im Terminal.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded' });

  await waitForEnter('Wenn fertig: ENTER druecken.');

  await fs.mkdir(STATE_DIR, { recursive: true });
  await context.storageState({ path: STATE_FILE });
  console.log(`\n✓ Cookies gespeichert: ${path.resolve(STATE_FILE)}`);
  console.log('\nHochladen:');
  console.log('  scp playwright-state/ebay.json root@<vps-ip>:/opt/gradetracker-agent/playwright-state/ebay.json');
  console.log('  ssh root@<vps-ip> "chown agent:agent /opt/gradetracker-agent/playwright-state/ebay.json"');

  await browser.close();
  process.exit(0);
})();

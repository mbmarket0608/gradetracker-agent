// Lokales Login-Helper-Skript: oeffnet einen sichtbaren Browser, du loggst
// dich manuell bei eBay + Cardmarket ein, drueckst danach Enter im Terminal —
// das Skript speichert die Cookies in playwright-state/{ebay,cardmarket}.json.
//
// Verwendung (auf dem lokalen PC, NICHT auf der VPS):
//   npm run login
//
// Danach: scp -r playwright-state root@<vps-ip>:/opt/gradetracker-agent/

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const STATE_DIR = 'playwright-state';

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt + '\n', () => { rl.close(); resolve(); }));
}

async function loginSite(name: string, url: string, stateFile: string, locale: string): Promise<void> {
  console.log(`\n── ${name} ${'─'.repeat(60 - name.length)}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`\n→ Logge dich jetzt im Browser-Fenster bei ${name} ein.`);
  console.log(`  Captcha/2FA durchklicken bis du eingeloggt bist.\n`);
  await waitForEnter(`Wenn fertig: ENTER druecken HIER im Terminal.`);
  await fs.mkdir(STATE_DIR, { recursive: true });
  await context.storageState({ path: stateFile });
  console.log(`✓ Cookies gespeichert: ${stateFile}`);
  await browser.close();
}

(async () => {
  console.log('Initial-Login fuer GradeTracker-Agent.\n');
  console.log('Es oeffnen sich nacheinander 2 Browser-Fenster (eBay, dann Cardmarket).');
  console.log('Logge dich jeweils ein und bestaetige mit ENTER hier im Terminal.\n');

  await loginSite('eBay',       'https://www.ebay.com/signin/',                path.join(STATE_DIR, 'ebay.json'),       'en-US');
  await loginSite('Cardmarket', 'https://www.cardmarket.com/de/Account/Login', path.join(STATE_DIR, 'cardmarket.json'), 'de-DE');

  console.log('\n────────────────────────────────────────────────────────────────');
  console.log('✓ Fertig! Beide Cookie-Files liegen in:  ' + path.resolve(STATE_DIR));
  console.log('\nHochladen auf die VPS:');
  console.log('  scp -r playwright-state root@<vps-ip>:/opt/gradetracker-agent/');
  console.log('  ssh root@<vps-ip> "chown -R agent:agent /opt/gradetracker-agent/playwright-state"');
  process.exit(0);
})();

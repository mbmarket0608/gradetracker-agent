// CLI: einen einzelnen Run lokal triggern (ohne HTTP-Service zu starten).
// Nutzbar fuer Tests + manuelle Re-Runs auf der VPS via `npm run run-once`.

import 'dotenv/config';
import { runDaily } from '../dailyRun.js';

(async () => {
  console.log(`[run-once] starting at ${new Date().toISOString()}`);
  try {
    const { runId, stats } = await runDaily('manual');
    console.log(`[run-once] success: run=${runId}`, stats);
    process.exit(0);
  } catch (e) {
    console.error('[run-once] failed:', e);
    process.exit(1);
  }
})();

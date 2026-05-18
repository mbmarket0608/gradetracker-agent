// HTTP-Server + Cron-Bootstrap.
//
// Exponiert:
//   GET  /health  → { ok, version, lastRunAt }
//   POST /run     → triggert sofortigen Run, returns { runId }
//   GET  /status  → aktuell laufender Run (oder null)
//
// Cron: laeuft im selben Prozess via node-cron. Schedule + Timezone aus .env.

import 'dotenv/config';
import http from 'node:http';
import cron from 'node-cron';
import { runDaily } from './dailyRun.js';
import { supabase } from './lib/supabase.js';

// Safety-Net: ein einzelner gescheiterter Run darf den Service nicht killen.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack}` : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const PORT = parseInt(process.env.PORT || '8080', 10);
const SCHEDULE = process.env.CRON_SCHEDULE || '30 6 * * *';
const TZ = process.env.CRON_TIMEZONE || 'Europe/Berlin';

let activeRun: Promise<{ runId: string }> | null = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      const { data } = await supabase.from('agent_runs').select('started_at').order('started_at', { ascending: false }).limit(1).maybeSingle();
      return json(res, 200, { ok: true, version: '0.1.0', lastRunAt: data?.started_at ?? null });
    }

    if (url.pathname === '/status' && req.method === 'GET') {
      const { data } = await supabase.from('agent_runs').select('*').eq('status', 'running').order('started_at', { ascending: false }).limit(1).maybeSingle();
      return json(res, 200, data ?? null);
    }

    if (url.pathname === '/run' && req.method === 'POST') {
      if (activeRun) {
        return json(res, 409, { error: 'A run is already in progress' });
      }
      activeRun = runDaily('manual')
        .then(r => { activeRun = null; return r; })
        .catch(e => {
          activeRun = null;
          console.error('[manual run] failed:', e instanceof Error ? `${e.name}: ${e.message}` : e);
          return { runId: '' };
        });
      // Antwort sofort senden, Run laeuft im Hintergrund
      return json(res, 202, { ok: true, message: 'Run gestartet' });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(res, 500, { error: msg });
  }
});

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

server.listen(PORT, () => {
  console.log(`[gradetracker-agent] HTTP listening on :${PORT}`);
});

cron.schedule(SCHEDULE, async () => {
  if (activeRun) { console.log('[cron] skipping — run already in progress'); return; }
  console.log(`[cron] ${new Date().toISOString()} — starting daily run`);
  try {
    activeRun = runDaily('cron').then(r => { activeRun = null; return r; });
    const { runId } = await activeRun;
    console.log(`[cron] completed run ${runId}`);
  } catch (e) {
    activeRun = null;
    console.error('[cron] run failed:', e);
  }
}, { timezone: TZ });

console.log(`[cron] scheduled with "${SCHEDULE}" in ${TZ}`);

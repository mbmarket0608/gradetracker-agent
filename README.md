# gradetracker-agent

Daily-Run-Service für [GradeTracker](https://gradetracker-clean.vercel.app/). Läuft auf einer kleinen VPS, scraped jeden Morgen eBay + Cardmarket und befüllt den Einkaufsplan-Tab im GradeTracker.

## Architektur

```
Cron 06:30 Europe/Berlin
    ↓
[Orchestrator]  src/dailyRun.ts
    ├── [eBay-Scraper]      src/ebay.ts
    │       → Last 24h sold One Piece PSA 10 ≥ $700
    │       → pro Karte: 14-Tage-History (Probstin123 / DC Sports 87)
    │
    ├── [Katalog-Match]     src/lib/catalogMatch.ts
    │
    ├── [PSA10-Pricing]     src/psa10Pricing.ts
    │       → gewichteter Schnitt: aktuellster Verkauf 50%, mittlerer 30%, ältester 20%
    │
    ├── [Cardmarket-Pick]   src/cardmarket.ts
    │       → günstigste NM-Karte in EN (oder JP falls EN nicht existiert)
    │       → Disqualifizierer-Heuristik per Claude
    │
    ├── [DQ-Check]
    │       → Bild ↔ Preisniveau-Plausibilität gegen Katalog
    │
    └── [Persist]
            → schreibt purchase_opportunities mit source='agent'
            → flagged agent_data_quality_flags
```

## Local Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# .env mit echten Werten ausfüllen
npm run dev
```

Health-Check: `http://localhost:8080/health`
Manueller Run: `npm run run-once`

## VPS-Deployment (Hetzner CX22, Ubuntu 22.04)

```bash
# Auf der VPS:
apt update && apt install -y nodejs npm git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2

git clone <repo-url> /opt/gradetracker-agent
cd /opt/gradetracker-agent
npm install
npx playwright install --with-deps chromium

# .env hochladen oder via scp uebertragen
# WICHTIG: Service-Role-Key, nicht anon-Key

npm run build
pm2 start dist/index.js --name agent
pm2 startup
pm2 save
```

Cron läuft automatisch über `node-cron` im Service. Health-Endpoint auf Port 8080 (kann über Caddy/nginx + Domain + TLS exponiert werden).

## Initial Login

eBay und Cardmarket verlangen Login + ggf. Captcha. Beim ersten Start:

```bash
HEADFUL=1 npm run dev
```

→ Service startet einen sichtbaren Browser, du loggst dich manuell ein, Cookies werden in `playwright-state/` persistiert. Danach `HEADFUL=0` für headless Daily-Runs.

## Environment-Variablen

Siehe `.env.example`. Wichtig:
- `SUPABASE_SERVICE_ROLE_KEY` (NICHT anon — wir bypassen RLS für DB-Writes)
- `ANTHROPIC_API_KEY` für Disqualifizierer-Heuristik + Datacheck-Bewertungen
- `PSA10_PREFERRED_SELLERS=probstin123,dcsports87` — Komma-getrennt, Reihenfolge = Priorität

## API

- `GET /health` → `{ ok: true, version, lastRunAt }`
- `POST /run` → triggert sofortigen Run, returns `{ runId }`
- `GET /status` → aktueller laufender Run

## Lifecycle

- Logs in Supabase (`agent_runs`, `agent_run_steps`)
- Errors zusätzlich in `pm2 logs`
- Daily-Notification: optional Webhook (Slack/Email) bei Run-Ende oder Fehler

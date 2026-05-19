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

**Ein-Befehl-Setup** (frische Ubuntu 22.04 VM als root):

```bash
curl -fsSL https://raw.githubusercontent.com/mbmarket0608/gradetracker-agent/main/scripts/setup-vps.sh | bash
```

Das Skript installiert Node 22, klont das Repo nach `/opt/gradetracker-agent`, installiert Dependencies + Playwright Chromium, erzeugt einen `systemd`-Service als unprivilegierter User `agent` und öffnet die Firewall.

**Danach manuell** (3 Schritte):

1. **`.env` hochladen** (Werte aus `.env.example` ausfüllen):
   ```bash
   scp .env root@<vps-ip>:/opt/gradetracker-agent/.env
   ssh root@<vps-ip> "chown agent:agent /opt/gradetracker-agent/.env && chmod 600 /opt/gradetracker-agent/.env"
   ```

2. **Initial-Login** auf dem lokalen PC, Cookies hochladen:
   ```bash
   HEADFUL=1 npm run dev
   # → Browser öffnet, bei eBay + Cardmarket einloggen
   scp -r playwright-state root@<vps-ip>:/opt/gradetracker-agent/
   ssh root@<vps-ip> "chown -R agent:agent /opt/gradetracker-agent/playwright-state"
   ```

3. **Service starten**:
   ```bash
   ssh root@<vps-ip> "systemctl enable --now gradetracker-agent && systemctl status gradetracker-agent"
   curl http://<vps-ip>:8080/health
   ```

4. **GradeTracker → Vercel auf den Service zeigen** lassen:
   `Settings → Environment Variables → VITE_AGENT_SERVICE_URL=https://<deine-vps-domain>` → Redeploy.

Cron läuft automatisch über `node-cron` im Service. Logs: `journalctl -fu gradetracker-agent`.

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
- `PSA10_PREFERRED_SELLERS=probstein123,dcsports87` — Komma-getrennt, Reihenfolge = Priorität

## API

- `GET /health` → `{ ok: true, version, lastRunAt }`
- `POST /run` → triggert sofortigen Run, returns `{ runId }`
- `GET /status` → aktueller laufender Run

## Lifecycle

- Logs in Supabase (`agent_runs`, `agent_run_steps`)
- Errors zusätzlich in `pm2 logs`
- Daily-Notification: optional Webhook (Slack/Email) bei Run-Ende oder Fehler

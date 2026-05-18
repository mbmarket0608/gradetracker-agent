#!/usr/bin/env bash
# Hetzner CX22 Ubuntu 22.04 → Daily-Run-Service in einem Rutsch.
#
# Voraussetzungen:
#   - frische Ubuntu-22.04-VM als root oder mit sudo
#   - GitHub-PAT in $GITHUB_TOKEN exportiert (fuer private Repo-Clone)
#
# Verwendung:
#   curl -fsSL https://raw.githubusercontent.com/mbmarket0608/gradetracker-agent/main/scripts/setup-vps.sh | bash
#   (oder: ssh root@vps "bash -s" < setup-vps.sh)
#
# Setzt voraus, dass NACH dem Skript die .env in /opt/gradetracker-agent/.env
# manuell hochgeladen + ein Initial-Login durchgefuehrt wird.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mbmarket0608/gradetracker-agent.git}"
APP_DIR="/opt/gradetracker-agent"
NODE_VER="22"
SVC_USER="agent"
PORT="${PORT:-8080}"

log() { echo -e "\n\033[1;36m>>> $*\033[0m"; }

# ─── 1) System-Pakete ────────────────────────────────────────────────────
# Browser-System-Deps installiert Playwright spaeter selbst via
# `playwright install --with-deps chromium` — das mapped automatisch auf
# die korrekten Paketnamen, egal welche Ubuntu-Version. Hier nur das Minimum.
log "Aktualisiere Paketquellen + installiere Basis-Pakete"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw build-essential

# ─── 2) Node.js 22 ───────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q "^v${NODE_VER}\."; then
  log "Installiere Node.js ${NODE_VER}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VER}.x" | bash -
  apt-get install -y nodejs
fi
log "Node-Version: $(node --version)"

# ─── 3) Service-User ─────────────────────────────────────────────────────
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  log "Lege Service-User '$SVC_USER' an"
  useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# ─── 4) Repo klonen / aktualisieren ──────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  log "Repo existiert, pulle latest (als $SVC_USER)"
  # safe.directory: bei einem fremd-besitzten Verzeichnis verweigert git 2.36+
  # standardmaessig den Zugriff. Wir pullen als der Owner-User.
  chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
  sudo -u "$SVC_USER" git -C "$APP_DIR" pull --rebase --autostash
else
  log "Klone Repo nach $APP_DIR"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git clone "https://oauth2:${GITHUB_TOKEN}@${REPO_URL#https://}" "$APP_DIR"
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
  chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
fi

# ─── 5) Dependencies ─────────────────────────────────────────────────────
# node_modules + lock zusammen weg, damit npm beim Re-Run wirklich die in
# package.json aktualisierten Versionen installiert (sonst sieht es "up to
# date" und uebernimmt nichts).
log "npm install (frisch — node_modules + lock werden zurueckgesetzt)"
sudo -u "$SVC_USER" bash -c "cd $APP_DIR && rm -rf node_modules package-lock.json && npm install"
# Sanity-Check: Playwright-Version anzeigen
sudo -u "$SVC_USER" bash -c "cd $APP_DIR && node -e 'console.log(\"Playwright installiert:\", require(\"playwright/package.json\").version)'"

# Chromium-System-Libs explizit (Playwright kennt Ubuntu 25+/26+ noch nicht
# als bekanntes Image — wir installieren die Libs selbst und skippen die
# Validierung). t64-Varianten fuer aktuelle Ubuntu-Versionen.
log "Installiere Chromium-System-Libs"
apt-get install -y \
  libnss3 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libasound2t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 libdrm2 \
  libxshmfence1 libpango-1.0-0 libcairo2 libxss1 libgtk-3-0t64 || \
apt-get install -y \
  libnss3 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libasound2 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 \
  libxshmfence1 libpango-1.0-0 libcairo2 libxss1 libgtk-3-0 || true

log "playwright install chromium (ubuntu24.04 override)"
# PLAYWRIGHT_HOST_PLATFORM_OVERRIDE zwingt Playwright, ein bekanntes Image-Tag
# zu nehmen — Chromium-Binaries sind auf neueren Ubuntus binaerkompatibel.
sudo -u "$SVC_USER" bash -c "cd $APP_DIR && PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04 PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 npx playwright install chromium"

# ─── 6) Build ────────────────────────────────────────────────────────────
log "Build"
sudo -u "$SVC_USER" bash -c "cd $APP_DIR && npm run build"

# ─── 7) Systemd-Unit ─────────────────────────────────────────────────────
log "Erzeuge systemd-Unit"
cat > /etc/systemd/system/gradetracker-agent.service <<UNIT
[Unit]
Description=GradeTracker Daily-Run Agent
After=network.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04
Environment=PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload

# ─── 8) Firewall ─────────────────────────────────────────────────────────
log "Konfiguriere UFW (SSH + HTTP-Service-Port)"
ufw allow OpenSSH || true
ufw allow "$PORT/tcp" || true
ufw --force enable || true

# ─── 9) Naechste Schritte anzeigen ───────────────────────────────────────
cat <<NEXT

╔═══════════════════════════════════════════════════════════════════════╗
║ VPS-Setup abgeschlossen.                                              ║
║                                                                       ║
║ Naechste Schritte (manuell):                                          ║
║                                                                       ║
║ 1) .env hochladen:                                                    ║
║      scp .env root@<vps-ip>:$APP_DIR/.env                             ║
║      chown $SVC_USER:$SVC_USER $APP_DIR/.env                          ║
║      chmod 600 $APP_DIR/.env                                          ║
║                                                                       ║
║ 2) Initial-Login (eBay + Cardmarket Cookies anlegen):                 ║
║      Auf deinem lokalen PC:                                           ║
║        export HEADFUL=1                                               ║
║        npm run dev                                                    ║
║      → Browser oeffnet, du loggst dich bei beiden ein.                ║
║      → playwright-state/{ebay,cardmarket}.json kopieren auf VPS:      ║
║        scp -r playwright-state root@<vps-ip>:$APP_DIR/                ║
║      → chown -R $SVC_USER:$SVC_USER $APP_DIR/playwright-state         ║
║                                                                       ║
║ 3) Service starten:                                                   ║
║      systemctl enable gradetracker-agent                              ║
║      systemctl start gradetracker-agent                               ║
║      systemctl status gradetracker-agent                              ║
║                                                                       ║
║ 4) Health-Check:                                                      ║
║      curl http://localhost:$PORT/health                               ║
║                                                                       ║
║ 5) GradeTracker-Frontend (Vercel) auf den Service zeigen lassen:      ║
║      VITE_AGENT_SERVICE_URL=https://<deine-vps-domain>                ║
║      In Vercel → Settings → Environment Variables setzen + Redeploy   ║
║                                                                       ║
║ Logs: journalctl -fu gradetracker-agent                               ║
║ Manueller Run: cd $APP_DIR && sudo -u $SVC_USER npm run run-once      ║
╚═══════════════════════════════════════════════════════════════════════╝

NEXT

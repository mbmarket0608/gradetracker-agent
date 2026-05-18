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
  log "Repo existiert, pulle latest"
  git -C "$APP_DIR" pull
else
  log "Klone Repo nach $APP_DIR"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git clone "https://oauth2:${GITHUB_TOKEN}@${REPO_URL#https://}" "$APP_DIR"
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

# ─── 5) Dependencies ─────────────────────────────────────────────────────
log "npm install"
sudo -u "$SVC_USER" bash -c "cd $APP_DIR && npm install"
# Playwright + System-Deps in einem Schritt (root benoetigt fuer apt installs).
# --with-deps mapped auf die korrekten Paketnamen der vorhandenen Ubuntu-Version.
log "playwright install --with-deps chromium"
sudo -u "$SVC_USER" bash -c "cd $APP_DIR && npx playwright install chromium"
(cd "$APP_DIR" && npx playwright install-deps chromium)

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

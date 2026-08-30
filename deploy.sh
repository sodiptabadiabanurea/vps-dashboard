#!/bin/bash
# ============================================================
# VPS Dashboard - Complete Deploy Script for kakibaabu
# ============================================================
# Live-safe deployment: the new release is built entirely in a staging
# directory ($APP_DIR.new) and is only moved into place AFTER the native
# module probe passes. The running service is never overwritten in place —
# that pattern corrupted mmap'ed .node files of the live process and caused
# a SEGV crash loop (incident 2026-08-30). Sequence: stage → install →
# probe → swap dirs → stop → start → health gate (auto-rollback on failure).
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

APP_DIR="/opt/vps-dashboard"
STAGE_DIR="${APP_DIR}.new"
PREV_DIR="${APP_DIR}.prev"
DB_DIR="/var/lib/vps-dashboard"
SECRET_FILE="/etc/vps-dashboard.env"
DOMAIN="kakibaabu.duckdns.org"
PORT=3000
NODE_VERSION="20"

echo ""
echo "============================================================"
echo "  VPS Dashboard - Deploy Script"
echo "  Server: ${DOMAIN}"
echo "============================================================"
echo ""

if [ "$EUID" -eq 0 ]; then
  warn "Running as root. Will create a non-root user for the app."
  RUNNING_AS_ROOT=true
else
  RUNNING_AS_ROOT=false
fi

info "Step 1/8: Checking Node.js..."
if command -v node &> /dev/null; then
  NODE_VER=$(node -v)
  success "Node.js already installed: $NODE_VER"
else
  info "Installing Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
  sudo apt-get install -y nodejs
  success "Node.js installed: $(node -v)"
fi

info "Step 2/8: Checking nginx..."
if command -v nginx &> /dev/null; then
  success "nginx already installed"
else
  info "Installing nginx..."
  sudo apt-get install -y nginx
  sudo systemctl enable nginx
  sudo systemctl start nginx
  success "nginx installed and started"
fi

UNIT_FILE="/etc/systemd/system/vps-dashboard.service"
UNIT_DROPIN_DIR="${UNIT_FILE}.d"
EXISTING_UNIT=""
if [ -f "$UNIT_FILE" ]; then
  EXISTING_UNIT="$UNIT_FILE"
fi

# Rollback safety: snapshot the current unit + drop-ins before touching
# anything, so a failed deploy can be undone without guessing.
if [ -n "$EXISTING_UNIT" ] || [ -d "$UNIT_DROPIN_DIR" ]; then
  BACKUP_DIR="/root/backups/vps-dashboard-deploy-$(date +%Y%m%d-%H%M%S)"
  sudo mkdir -p "$BACKUP_DIR"
  [ -n "$EXISTING_UNIT" ] && sudo cp -a "$UNIT_FILE" "$BACKUP_DIR/" 2>/dev/null || true
  [ -d "$UNIT_DROPIN_DIR" ] && sudo cp -a "$UNIT_DROPIN_DIR" "$BACKUP_DIR/" 2>/dev/null || true
  info "Backed up current service config to $BACKUP_DIR"
fi

info "Step 3/8: Creating directories..."
sudo mkdir -p "$APP_DIR"
sudo mkdir -p "$DB_DIR"
if [ "$RUNNING_AS_ROOT" = true ]; then
  sudo chown -R root:root "$APP_DIR"
  sudo chown -R root:root "$DB_DIR"
else
  sudo chown -R $USER:$USER "$APP_DIR"
  sudo chown -R $USER:$USER "$DB_DIR"
fi
success "Directories created"

info "Step 4/8: Staging release in ${STAGE_DIR} (live tree untouched)..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sudo rm -rf "$STAGE_DIR"
sudo mkdir -p "$STAGE_DIR"
sudo cp -r "$SCRIPT_DIR"/* "$STAGE_DIR/"
sudo cp -r "$SCRIPT_DIR"/.gitignore "$STAGE_DIR/" 2>/dev/null || true
# Never let a checkout's node_modules shadow the deployed one: stale native
# binaries built for a different Node ABI (e.g. an nvm Node v24 build) survive
# `npm install` unchanged when versions already satisfy the lockfile, and then
# crash the service with ERR_DLOPEN_FAILED. npm rebuilds the tree below.
sudo rm -rf "$STAGE_DIR/node_modules"
if [ "$RUNNING_AS_ROOT" = true ]; then
  sudo chown -R root:root "$STAGE_DIR"
else
  sudo chown -R $USER:$USER "$STAGE_DIR"
fi
success "Release staged in $STAGE_DIR"

info "Step 5/8: Installing npm dependencies (staged)..."
cd "$STAGE_DIR"

# 5a. Pin the Node interpreter for the systemd unit BEFORE installing, so
# npm's build scripts run under the same interpreter the service will use.
# Do NOT rely on `which node`: a shell/nvm Node whose ABI differs from the
# one the native modules (better-sqlite3, node-pty) must run under causes an
# ERR_DLOPEN_FAILED / SIGSEGV crash loop at startup. Prefer whatever the
# existing unit already runs, then system locations, then PATH.
NODE_BIN=""
if [ -f "$EXISTING_UNIT" ]; then
  CURRENT_BIN="$(sed -nE 's/^ExecStart=([^ ]+).*$/\1/p' "$EXISTING_UNIT" | head -1)"
  if [ -n "$CURRENT_BIN" ] && [ -x "$CURRENT_BIN" ]; then
    NODE_BIN="$CURRENT_BIN"
    info "Reusing Node from existing service unit: $NODE_BIN ($("$NODE_BIN" -v))"
  fi
fi
if [ -z "$NODE_BIN" ]; then
  for CANDIDATE in /usr/bin/node /usr/local/bin/node "$(command -v node || true)"; do
    if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
      NODE_BIN="$CANDIDATE"
      break
    fi
  done
fi
[ -n "$NODE_BIN" ] || error "No usable Node.js interpreter found"
# npm that ships next to the pinned interpreter; runs under that interpreter
# so any native rebuild targets the right ABI.
NPM_CLI="$(readlink -f "$(dirname "$NODE_BIN")/npm" 2>/dev/null || true)"
if [ -n "$NPM_CLI" ] && [ -f "$NPM_CLI" ]; then
  sudo env PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" "$NPM_CLI" install --production 2>&1 | tail -3
else
  sudo env PATH="$(dirname "$NODE_BIN"):$PATH" npm install --production 2>&1 | tail -3
fi
success "Dependencies installed"

# Real-load probe: better-sqlite3 binds lazily, so a bare require() passes
# even with an ABI-mismatched binary (false negative). Force the native
# binding by opening an in-memory DB and spawning a pty — the exact calls the
# server makes at boot. Exit 0 only if both native modules genuinely load.
NATIVE_CHECK="const D=require('better-sqlite3');const db=new D(':memory:');db.exec('CREATE TABLE t(a)');db.prepare('INSERT INTO t VALUES (1)').run();const P=require('node-pty');const p=P.spawn('/bin/true');p.kill();process.exit(0)"

info "Verifying native modules against $NODE_BIN ($("$NODE_BIN" -v))..."
if ! (cd "$STAGE_DIR" && sudo "$NODE_BIN" -e "$NATIVE_CHECK" >/dev/null 2>&1); then
  warn "Native modules incompatible with $NODE_BIN; rebuilding them..."
  if [ -n "$NPM_CLI" ] && [ -f "$NPM_CLI" ]; then
    (cd "$STAGE_DIR" && sudo env PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" "$NPM_CLI" rebuild better-sqlite3 node-pty 2>&1 | tail -3) || true
  else
    warn "No npm found next to $NODE_BIN; skipping automatic rebuild"
  fi
  (cd "$STAGE_DIR" && sudo "$NODE_BIN" -e "$NATIVE_CHECK" >/dev/null 2>&1) \
    || error "Native modules still fail under $NODE_BIN after rebuild. Install a matching Node or rebuild manually, then re-run."
fi
success "Node interpreter pinned: $NODE_BIN ($("$NODE_BIN" -v))"

info "Step 6/8: Preparing credentials..."
# 64 hex characters (256 bits); config.js requires at least 32 characters.
# Keep credentials outside the repository and out of the systemd unit.
if [ -f "$SECRET_FILE" ]; then
  # Reuse the existing secret so the dashboard login does not rotate on every
  # redeploy. The file stays the single source of truth; nothing is printed.
  DASH_USER="$(sudo sed -nE 's/^DASHBOARD_USER=//p' "$SECRET_FILE" | head -1)"
  DASH_PASS="$(sudo sed -nE 's/^DASHBOARD_PASS=//p' "$SECRET_FILE" | head -1)"
  [ -n "$DASH_PASS" ] || error "Existing ${SECRET_FILE} has no DASHBOARD_PASS — fix or delete the file and re-run"
  [ -n "$DASH_USER" ] || DASH_USER="admin"
  info "Reusing existing credentials from ${SECRET_FILE} (no rotation on redeploy)"
else
  DASH_USER="admin"
  DASH_PASS=$(openssl rand -hex 32)
  # umask + mode 600 prevent other local users from reading the secret file.
  # The password is piped via stdin so it never appears in a process argv.
  printf 'DASHBOARD_USER=%s\nDASHBOARD_PASS=%s\n' "$DASH_USER" "$DASH_PASS" \
    | sudo sh -c "umask 077; cat > '${SECRET_FILE}'"
  sudo chmod 600 "$SECRET_FILE"
  success "Dashboard credential generated and stored in ${SECRET_FILE} (mode 600)"
fi

# Sanitize stale credentials from existing drop-ins. systemd applies
# Environment= (any drop-in) AFTER EnvironmentFile=, so a leftover
# DASHBOARD_PASS= line would silently override the secret in the env file.
if [ -d "$UNIT_DROPIN_DIR" ]; then
  sudo sh -c '
    for conf in "$1"/*.conf; do
      [ -f "$conf" ] || continue
      # Strip any Environment= line carrying dashboard credentials (quoted or
      # not, with optional whitespace around the "="). systemd tolerates
      # "Environment = X", so allow spaces there too.
      cleaned=$(grep -Ev "^[[:space:]]*Environment[[:space:]]*=[[:space:]]*\"?DASHBOARD_(USER|PASS)=" "$conf" || true)
      if [ -z "$cleaned" ]; then
        rm -f "$conf"
        continue
      fi
      # If nothing substantive remains (only section headers/comments), drop
      # the file entirely instead of leaving an empty stub behind.
      if ! printf "%s\n" "$cleaned" | grep -qvE "^[[:space:]]*(\[|#|$)"; then
        rm -f "$conf"
        continue
      fi
      printf "%s\n" "$cleaned" > "$conf"
    done
  ' _ "$UNIT_DROPIN_DIR"
  if [ -z "$(sudo ls -A "$UNIT_DROPIN_DIR" 2>/dev/null)" ]; then
    sudo rmdir "$UNIT_DROPIN_DIR" 2>/dev/null || true
  fi
  info "Sanitized stale dashboard credentials from existing drop-ins (if any)"
fi

info "Step 7/8: Installing systemd service and swapping release..."
sudo tee "$UNIT_FILE" > /dev/null <<EOF
[Unit]
Description=VPS Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=5
Environment=PORT=${PORT}
Environment=HOST=127.0.0.1
Environment=DB_PATH=${DB_DIR}/dashboard.db
EnvironmentFile=${SECRET_FILE}
# Telegram Alerts (uncomment and set values in a root-only credential file):
# Environment=TELEGRAM_TOKEN=your-bot-token
# Environment=TELEGRAM_CHAT_ID=your-chat-id
# Network interface (auto-detected, override if needed):
# Environment=NET_IFACE=enp0s6

[Install]
WantedBy=multi-user.target
EOF

# Leak guard: refuse to continue if any unit or drop-in still carries a
# plaintext dashboard password (EnvironmentFile must be the only source).
if sudo grep -qrE "DASHBOARD_PASS=" "$UNIT_FILE" "$UNIT_DROPIN_DIR" 2>/dev/null; then
  error "Plaintext DASHBOARD_PASS found in systemd config — aborting before restart"
fi

sudo systemctl daemon-reload
sudo systemctl enable vps-dashboard

# --- Live-safe swap -------------------------------------------------------
# Directory renames are atomic and never touch the files the running process
# has open/mmap'ed, so the old service keeps serving from the old inode tree
# until we explicitly stop it. Downtime = stop + start + boot (a few seconds).
sudo rm -rf "$PREV_DIR"
[ -d "$APP_DIR" ] && sudo mv "$APP_DIR" "$PREV_DIR"
sudo mv "$STAGE_DIR" "$APP_DIR"
if [ "$RUNNING_AS_ROOT" = true ]; then
  sudo chown root:root "$APP_DIR"
else
  sudo chown $USER:$USER "$APP_DIR"
fi
sudo systemctl stop vps-dashboard 2>/dev/null || true
sudo systemctl start vps-dashboard
info "Release swapped into ${APP_DIR}; previous release kept at ${PREV_DIR}"

# Health gate: prove the new release actually serves before declaring
# success. On failure, restore the previous release automatically.
rollback_to_prev() {
  warn "Health gate FAILED — rolling back to previous release..."
  sudo systemctl stop vps-dashboard 2>/dev/null || true
  if [ -d "$PREV_DIR" ]; then
    sudo rm -rf "$APP_DIR"
    sudo mv "$PREV_DIR" "$APP_DIR"
    sudo systemctl daemon-reload 2>/dev/null || true
    sudo systemctl start vps-dashboard || true
    sleep 3
    if systemctl is-active --quiet vps-dashboard; then
      error "Rolled back to ${PREV_DIR}; service restored. Investigate before re-deploying."
    else
      error "Rollback completed but service did not start — MANUAL INTERVENTION REQUIRED"
    fi
  else
    error "Health gate failed and no previous release at ${PREV_DIR} — MANUAL INTERVENTION REQUIRED"
  fi
}

GATE_OK=""
for _ in $(seq 1 15); do
  sleep 2
  if systemctl is-active --quiet vps-dashboard; then
    HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" || true)"
    if [ "$HTTP_CODE" = "200" ]; then GATE_OK=1; break; fi
  fi
done
if [ -z "$GATE_OK" ]; then
  rollback_to_prev
fi
# Auth gate: the service must also accept the credential from the env file.
AUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -u "${DASH_USER}:${DASH_PASS}" "http://127.0.0.1:${PORT}/" || true)"
if [ "$AUTH_CODE" != "200" ]; then
  warn "Auth check returned ${AUTH_CODE}"
  rollback_to_prev
fi
success "systemd service running on new release (healthz 200, auth 200)"

info "Step 8/8: Configuring nginx..."

# Guard: if an enabled site already serves this domain (possibly with extra
# routes or certbot-managed config), do NOT create a second server block for
# the same server_name — nginx would warn "conflicting server name" and one
# config would silently shadow the other.
if sudo grep -RlE "server_name[[:space:]]+${DOMAIN}" /etc/nginx/sites-enabled/ >/dev/null 2>&1; then
  info "An nginx site already serves ${DOMAIN} — skipping nginx changes."
  success "nginx untouched (existing site preserved)"
else

# /etc/letsencrypt/live is root-only (0700), so detect the cert as root.
if sudo test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"; then
  info "SSL certificate found, configuring HTTPS..."
  sudo tee /etc/nginx/sites-available/vps-dashboard > /dev/null <<NGINX
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}

server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}
NGINX
else
  warn "No SSL certificate found. Configuring HTTP only."
  warn "Run 'sudo certbot --nginx -d ${DOMAIN}' to get SSL."
  sudo tee /etc/nginx/sites-available/vps-dashboard > /dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
NGINX
fi

sudo ln -sf /etc/nginx/sites-available/vps-dashboard /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
success "nginx configured and reloaded"
fi

# ============================================================
# Done!
# ============================================================
echo ""
echo "============================================================"
echo -e "  ${GREEN}Deploy Complete!${NC}"
echo "============================================================"
echo ""
echo "  Dashboard: https://${DOMAIN}"
echo "  Username:  ${DASH_USER}"
echo "  Password:  stored in ${SECRET_FILE} (root-only)"
echo ""
echo "  Config:    ${UNIT_FILE}"
echo "  Secrets:   ${SECRET_FILE} (mode 600)"
echo "  Database:  ${DB_DIR}/dashboard.db"
echo "  Logs:      journalctl -u vps-dashboard -f"
echo "  Previous release kept at: ${PREV_DIR} (auto-rollback on failed health gate)"
echo ""
echo "  Commands:"
echo "    sudo systemctl restart vps-dashboard"
echo "    sudo systemctl status vps-dashboard"
echo "    journalctl -u vps-dashboard -f"
echo ""
echo "  To enable Telegram alerts:"
echo "    1. Create bot via @BotFather"
echo "    2. Add TELEGRAM_TOKEN and TELEGRAM_CHAT_ID to a root-only env file"
echo "    3. Update the systemd EnvironmentFile= entry"
echo "    4. sudo systemctl daemon-reload && sudo systemctl restart vps-dashboard"
echo ""
echo "  To get SSL (if not already):"
echo "    sudo certbot --nginx -d ${DOMAIN}"
echo ""

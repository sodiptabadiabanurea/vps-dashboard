#!/bin/bash
# ============================================================
# VPS Dashboard - Complete Deploy Script for kakibaabu
# ============================================================
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

info "Step 4/8: Copying application files..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sudo cp -r "$SCRIPT_DIR"/* "$APP_DIR/"
sudo cp -r "$SCRIPT_DIR"/.gitignore "$APP_DIR/" 2>/dev/null || true
if [ "$RUNNING_AS_ROOT" = true ]; then
  sudo chown -R root:root "$APP_DIR"
else
  sudo chown -R $USER:$USER "$APP_DIR"
fi
success "Files copied to $APP_DIR"

info "Step 5/8: Installing npm dependencies..."
cd "$APP_DIR"
sudo npm install --production 2>&1 | tail -3
success "Dependencies installed"

info "Step 6/8: Generating credentials..."
# 64 hex characters (256 bits); config.js requires at least 32 characters.
DASH_PASS=$(openssl rand -hex 32)
# Keep credentials outside the repository and out of the systemd unit.
# umask + mode 600 prevent other local users from reading the secret file.
sudo sh -c "umask 077; printf '%s\\n' 'DASHBOARD_USER=admin' 'DASHBOARD_PASS=${DASH_PASS}' > '${SECRET_FILE}'"
sudo chmod 600 "$SECRET_FILE"
success "Dashboard credential generated and stored in ${SECRET_FILE} (mode 600)"

info "Step 7/8: Creating systemd service..."
sudo tee /etc/systemd/system/vps-dashboard.service > /dev/null <<EOF
[Unit]
Description=VPS Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=$(which node) server.js
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

sudo systemctl daemon-reload
sudo systemctl enable vps-dashboard
sudo systemctl start vps-dashboard
success "systemd service created and started"

info "Step 8/8: Configuring nginx..."

if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
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

# ============================================================
# Done!
# ============================================================
echo ""
echo "============================================================"
echo -e "  ${GREEN}Deploy Complete!${NC}"
echo "============================================================"
echo ""
echo "  Dashboard: https://${DOMAIN}"
echo "  Username:  admin"
echo "  Password:  stored in ${SECRET_FILE} (root-only)"
echo ""
echo "  Config:    /etc/systemd/system/vps-dashboard.service"
echo "  Secrets:   ${SECRET_FILE} (mode 600)"
echo "  Database:  ${DB_DIR}/dashboard.db"
echo "  Logs:      journalctl -u vps-dashboard -f"
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
echo "============================================================"

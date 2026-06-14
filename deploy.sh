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

# ============================================================
# Configuration
# ============================================================
APP_DIR="/opt/vps-dashboard"
DB_DIR="/var/lib/vps-dashboard"
DOMAIN="kakibaabu.duckdns.org"
PORT=3000
NODE_VERSION="20"

# ============================================================
# Pre-flight checks
# ============================================================
echo ""
echo "============================================================"
echo "  VPS Dashboard - Deploy Script"
echo "  Server: ${DOMAIN}"
echo "============================================================"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  warn "Running as root. Will create a non-root user for the app."
  RUNNING_AS_ROOT=true
else
  RUNNING_AS_ROOT=false
fi

# ============================================================
# Step 1: Install Node.js
# ============================================================
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

# ============================================================
# Step 2: Install nginx
# ============================================================
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

# ============================================================
# Step 3: Create directories
# ============================================================
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

# ============================================================
# Step 4: Copy application files
# ============================================================
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

# ============================================================
# Step 5: Install npm dependencies
# ============================================================
info "Step 5/8: Installing npm dependencies..."
cd "$APP_DIR"
sudo npm install --production 2>&1 | tail -3
success "Dependencies installed"

# ============================================================
# Step 6: Generate credentials
# ============================================================
info "Step 6/8: Generating credentials..."
DASH_PASS=$(openssl rand -base64 12 | tr -d '=/+' | head -c 16)
success "Generated dashboard password: ${DASH_PASS}"
echo ""
warn "SAVE THIS PASSWORD! You'll need it to login."
echo ""

# ============================================================
# Step 7: Create systemd service
# ============================================================
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
Environment=DASHBOARD_USER=admin
Environment=DASHBOARD_PASS=${DASH_PASS}
# Telegram Alerts (uncomment and set your values):
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

# ============================================================
# Step 8: Configure nginx
# ============================================================
info "Step 8/8: Configuring nginx..."

# Check if SSL cert exists
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
echo "  Password:  ${DASH_PASS}"
echo ""
echo "  Config:    /etc/systemd/system/vps-dashboard.service"
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
echo "    2. Edit service: sudo nano /etc/systemd/system/vps-dashboard.service"
echo "    3. Uncomment TELEGRAM_TOKEN and TELEGRAM_CHAT_ID"
echo "    4. sudo systemctl daemon-reload && sudo systemctl restart vps-dashboard"
echo ""
echo "  To get SSL (if not already):"
echo "    sudo certbot --nginx -d ${DOMAIN}"
echo ""
echo "============================================================"

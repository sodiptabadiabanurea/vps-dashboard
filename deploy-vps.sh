#!/bin/bash
# ============================================================
# VPS Dashboard - One-Click Deploy Script
# Jalankan di VPS: bash deploy-vps.sh
# ============================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo "============================================================"
echo "  VPS Dashboard - Deploy Script"
echo "  Server: kakibaabu.duckdns.org"
echo "============================================================"
echo ""

# Step 1: Update system
info "Step 1/7: Updating system..."
sudo apt update -y && sudo apt upgrade -y
ok "System updated"

# Step 2: Install Node.js 20
info "Step 2/7: Installing Node.js 20..."
if command -v node &> /dev/null; then
  ok "Node.js already installed: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
  ok "Node.js installed: $(node -v)"
fi

# Step 3: Install dependencies
info "Step 3/7: Installing nginx + build tools..."
sudo apt install -y nginx build-essential python3
ok "Dependencies installed"

# Step 4: Setup app
info "Step 4/7: Setting up application..."
sudo mkdir -p /opt/vps-dashboard /var/lib/vps-dashboard
sudo chown -R $USER:$USER /opt/vps-dashboard /var/lib/vps-dashboard

# Copy from home to /opt
if [ -d "$HOME/vps-dashboard" ]; then
  cp -r $HOME/vps-dashboard/* /opt/vps-dashboard/
  cp -r $HOME/vps-dashboard/.gitignore /opt/vps-dashboard/ 2>/dev/null || true
  ok "Files copied to /opt/vps-dashboard"
else
  echo -e "${RED}[ERROR]${NC} ~/vps-dashboard not found. Copy the project first."
  exit 1
fi

# Install npm deps
info "Step 5/7: Installing npm dependencies..."
cd /opt/vps-dashboard
npm install --production
ok "npm dependencies installed"

# Generate password
DASH_PASS=$(openssl rand -base64 12 | tr -d '=/+' | head -c 16)

# Step 6: Create systemd service
info "Step 6/7: Creating systemd service..."
sudo tee /etc/systemd/system/vps-dashboard.service > /dev/null <<EOF
[Unit]
Description=VPS Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vps-dashboard
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DB_PATH=/var/lib/vps-dashboard/dashboard.db
Environment=DASHBOARD_USER=admin
Environment=DASHBOARD_PASS=${DASH_PASS}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable vps-dashboard
sudo systemctl start vps-dashboard
ok "Service created and started"

# Step 7: Setup nginx
info "Step 7/7: Configuring nginx..."
sudo tee /etc/nginx/sites-available/vps-dashboard > /dev/null <<'NGINX'
server {
    listen 80;
    server_name kakibaabu.duckdns.org;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/vps-dashboard /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
ok "nginx configured"

# Setup SSL
info "Setting up SSL..."
sudo apt install -y certbot python3-certbot-nginx 2>/dev/null || true
sudo certbot --nginx -d kakibaabu.duckdns.org --non-interactive --agree-tos --register-unsafely-without-email 2>/dev/null && ok "SSL configured" || warn "SSL setup skipped (can do later)"

# Done
echo ""
echo "============================================================"
echo -e "  ${GREEN}DEPLOY BERHASIL!${NC}"
echo "============================================================"
echo ""
echo "  Dashboard : https://kakibaabu.duckdns.org"
echo "  Username  : admin"
echo "  Password  : ${DASH_PASS}"
echo ""
echo "  Commands:"
echo "    sudo systemctl status vps-dashboard"
echo "    sudo systemctl restart vps-dashboard"
echo "    journalctl -u vps-dashboard -f"
echo ""
echo "============================================================"

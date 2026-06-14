#!/bin/bash
# VPS Dashboard - Quick Install Script
# For full deployment with nginx/SSL, use deploy.sh instead
set -e

APP_DIR="/opt/vps-dashboard"
DB_DIR="/var/lib/vps-dashboard"

echo "=== VPS Dashboard Installation ==="

# Create directories
echo "[1/4] Creating directories..."
sudo mkdir -p "$DB_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown -R $USER:$USER "$APP_DIR" "$DB_DIR"

# Copy files
echo "[2/4] Copying application files..."
cp -r ./* "$APP_DIR/"
cp -r ./.gitignore "$APP_DIR/" 2>/dev/null || true

# Install dependencies
echo "[3/4] Installing Node.js dependencies..."
cd "$APP_DIR"
npm install --production

# Create systemd service
echo "[4/4] Creating systemd service..."
DASH_PASS=$(openssl rand -base64 12 | tr -d '=/+' | head -c 16)

sudo tee /etc/systemd/system/vps-dashboard.service > /dev/null <<EOF
[Unit]
Description=VPS Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DB_PATH=$DB_DIR/dashboard.db
Environment=DASHBOARD_USER=admin
Environment=DASHBOARD_PASS=$DASH_PASS

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable vps-dashboard
sudo systemctl start vps-dashboard

echo ""
echo "=== Installation Complete ==="
echo "Dashboard: http://127.0.0.1:3000"
echo "Username:  admin"
echo "Password:  $DASH_PASS"
echo ""
echo "Commands:"
echo "  sudo systemctl restart vps-dashboard"
echo "  sudo systemctl status vps-dashboard"
echo "  journalctl -u vps-dashboard -f"
echo ""
echo "For nginx/SSL setup, use: ./deploy.sh"

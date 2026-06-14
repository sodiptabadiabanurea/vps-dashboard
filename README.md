# VPS Dashboard

Modern, real-time VPS monitoring dashboard with WebSocket updates.

![Dashboard](docs/dashboard.png)

## Features

| Feature | Description |
|---|---|
| 📊 **Real-time Monitoring** | CPU, RAM, Swap, Disk, Network via Socket.IO (2s refresh) |
| 📈 **Historical Charts** | 1h/6h/24h/7d/30d trends stored in SQLite |
| ⚡ **Process Manager** | View, search, sort, kill processes |
| 🐳 **Docker Monitor** | Container list, stats, logs, start/stop/restart |
| 📁 **File Manager** | Browse, upload, download, edit, delete files |
| 🖥️ **Web Terminal** | Live terminal access from browser (xterm.js) |
| ⏱️ **Uptime Monitor** | HTTP endpoint checker with history |
| 🔔 **Telegram Alerts** | CPU/RAM/Disk/Swap threshold notifications |
| 🌙/☀️ **Dark/Light Theme** | Toggle with localStorage persistence |
| 📱 **Mobile Responsive** | Works on phone/tablet |
| 🔒 **Basic Auth** | Password-protected destructive actions |

## Screenshots

### Dashboard
![Dashboard](docs/dashboard.png)

### Charts
![Charts](docs/charts.png)

### Process Manager
![Processes](docs/processes.png)

### Docker Monitor
![Docker](docs/docker.png)

### File Manager
![Files](docs/files.png)

### Web Terminal
![Terminal](docs/terminal.png)

### Uptime Monitor
![Uptime](docs/uptime.png)

### Dark/Light Theme
![Light Theme](docs/light-theme.png)

## Quick Start

```bash
# Clone
git clone https://github.com/sodiptabadiabanurea/vps-dashboard.git
cd vps-dashboard

# Install
npm install

# Run
node server.js
```

Dashboard: `http://localhost:3000`

## Deploy to VPS

```bash
chmod +x deploy.sh
./deploy.sh
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `HOST` | 127.0.0.1 | Bind address |
| `DASHBOARD_USER` | admin | Login username |
| `DASHBOARD_PASS` | (generated) | Login password |
| `DB_PATH` | /var/lib/vps-dashboard/dashboard.db | SQLite path |
| `TELEGRAM_TOKEN` | (empty) | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | (empty) | Telegram chat ID |
| `NET_IFACE` | enp0s6 | Network interface |

## Telegram Alerts

1. Create bot via [@BotFather](https://t.me/botfather)
2. Get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Set `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` in systemd service

## Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Database:** SQLite (better-sqlite3)
- **Frontend:** Vanilla JS + Chart.js + xterm.js
- **Terminal:** node-pty + xterm.js
- **Monitoring:** /proc filesystem + systemctl + docker CLI

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/history?range=1h` | No | Historical metrics |
| GET | `/api/processes` | Yes | Top processes |
| POST | `/api/processes/:pid/kill` | Yes | Kill process |
| GET | `/api/docker/containers` | Yes | Docker containers |
| GET | `/api/docker/stats` | Yes | Docker stats |
| GET | `/api/files?path=` | Yes | List directory |
| GET | `/api/files/read?path=` | Yes | Read file |
| POST | `/api/files/write` | Yes | Write file |
| GET | `/api/uptime/targets` | Yes | Uptime targets |
| GET | `/api/alerts/config` | Yes | Alert config |

## License

MIT

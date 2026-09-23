#!/usr/bin/env bash
# Rebuild the whole deployment on a fresh Ubuntu 24.04 box in one go.
#
# Written after the original VPS vanished from its IP with no warning: the code
# was safe in git, but .env, the settings file and the saved-address list lived
# only on the server. This makes the next such morning a ten-minute job.
#
# From your machine:
#   rsync -az --exclude data --exclude .env app/ root@NEW_IP:/opt/liquidation-radar/
#   ssh root@NEW_IP 'RADAR_PASSWORD=... BYBIT_API_KEY=... BYBIT_API_SECRET=... \
#                    bash /opt/liquidation-radar/deploy/restore.sh'
#
# Optional: DOMAIN=radar.example.com (defaults to <ip>.sslip.io), EMAIL=... for
# Let's Encrypt, MODE=live to start live instead of dry-run.
# Optional: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for push notifications.
set -euo pipefail

APP_DIR=/opt/liquidation-radar
cd "$APP_DIR"

: "${RADAR_PASSWORD:?set RADAR_PASSWORD}"
: "${BYBIT_API_KEY:?set BYBIT_API_KEY}"
: "${BYBIT_API_SECRET:?set BYBIT_API_SECRET}"

echo "==> host basics"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw >/dev/null
ufw allow OpenSSH >/dev/null; ufw allow 80,443/tcp >/dev/null; ufw --force enable >/dev/null
if ! swapon --show | grep -q .; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=1month\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald
timedatectl set-ntp true

echo "==> docker"
if ! command -v docker >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
    systemctl enable --now docker >/dev/null
fi

echo "==> .env"
if [[ -f .env ]]; then
    echo "    .env exists, leaving it alone"
else
    cat > .env <<ENV
RADAR_USER=radar
RADAR_PASSWORD=${RADAR_PASSWORD}
HOST=0.0.0.0
PORT=4174
BYBIT_API_KEY=${BYBIT_API_KEY}
BYBIT_API_SECRET=${BYBIT_API_SECRET}
BYBIT_TESTNET=false
# Radar scans on boot so the overview has live data; the trader stays off
# until someone presses the button.
RADAR_AUTOSTART=1
AUTOTRADE_AUTOSTART=0
# Telegram push (optional; empty = off)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
ENV
    chmod 600 .env
fi

echo "==> seed data (settings + saved addresses)"
mkdir -p data
# Settings: the last known good values, but forced to dry-run. Switch to live
# from the panel once you have watched it behave, not by default on a rebuild.
if [[ ! -f data/trading_settings.json ]]; then
    python3 - "$APP_DIR" "${MODE:-dry-run}" <<'PY'
import json,sys
root,mode=sys.argv[1],sys.argv[2]
s=json.load(open(f'{root}/deploy/seed/trading_settings.json'))
s['mode']=mode
json.dump(s,open(f'{root}/data/trading_settings.json','w'),indent=2)
print(f"    settings seeded (mode={mode})")
PY
fi
if [[ ! -f data/saved_addresses.json ]]; then
    cp deploy/seed/saved_addresses.json data/saved_addresses.json
    echo "    $(python3 -c "import json;print(len(json.load(open('data/saved_addresses.json'))))") saved addresses seeded"
fi

echo "==> build and start"
docker compose -f deploy/docker-compose.yml up -d --build
sleep 12
docker ps --format '    {{.Names}}: {{.Status}}' -f name=liquidation-radar

echo "==> TLS"
bash deploy/setup-tls.sh "${DOMAIN:-}"

echo
echo "==> restored"
echo "    Panel:  https://${DOMAIN:-$(curl -fsS https://api.ipify.org).sslip.io}"
echo "    Login:  radar / (RADAR_PASSWORD)"
echo "    Mode:   ${MODE:-dry-run}  — set live in Настройки when ready"
echo "    Do this on the exchange: restrict the Bybit key to this server's IP."

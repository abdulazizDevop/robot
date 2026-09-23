#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/hyperliquid-radar
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

apt-get update
apt-get install -y python3 nodejs npm ca-certificates
if ! id radar >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin radar
fi
install -d -o radar -g radar "$APP_DIR" "$APP_DIR/exports"
install -o radar -g radar -m 0644 "$SCRIPT_DIR/index.html" "$APP_DIR/index.html"
install -o radar -g radar -m 0755 "$SCRIPT_DIR/server.py" "$APP_DIR/server.py"
install -o radar -g radar -m 0644 "$SCRIPT_DIR/autotrade.py" "$APP_DIR/autotrade.py"
install -o radar -g radar -m 0644 "$SCRIPT_DIR/notify.py" "$APP_DIR/notify.py"
# Bybit keys, the auto-trade journal and the internal token live here, never served.
install -d -o radar -g radar -m 0700 "$APP_DIR/data"
# Password, session secret and Telegram settings. Created once, never overwritten.
if [[ ! -f /etc/hyperliquid-radar.env ]]; then
  umask 077
  printf 'RADAR_PASSWORD=%s\nRADAR_SESSION_SECRET=%s\nTELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\n' "${RADAR_PASSWORD:?set RADAR_PASSWORD}" "$(openssl rand -hex 32)" > /etc/hyperliquid-radar.env
fi
install -o radar -g radar -m 0644 "$SCRIPT_DIR/sw.js" "$APP_DIR/sw.js"
install -o radar -g radar -m 0644 "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
install -o radar -g radar -m 0755 "$SCRIPT_DIR/push-server.js" "$APP_DIR/push-server.js"
install -o root -g root -m 0644 "$SCRIPT_DIR/hyperliquid-radar-push.service" /etc/systemd/system/hyperliquid-radar-push.service
runuser -u radar -- npm install --omit=dev --prefix "$APP_DIR"
install -o root -g root -m 0644 "$SCRIPT_DIR/hyperliquid-radar.service" /etc/systemd/system/hyperliquid-radar.service
systemctl daemon-reload
systemctl enable --now hyperliquid-radar.service
systemctl enable --now hyperliquid-radar-push.service
systemctl --no-pager --full status hyperliquid-radar.service
systemctl --no-pager --full status hyperliquid-radar-push.service

#!/usr/bin/env bash
# Provision the radar on a fresh Timeweb Ubuntu VPS (no Docker).
# Run as root:  bash install-vps.sh
set -euo pipefail

APP_DIR=/opt/liquidation-radar
DATA_DIR=/var/lib/liquidation-radar
SERVICE=liquidation-radar

echo "==> packages"
apt-get update
apt-get install -y --no-install-recommends python3 python3-pip python3-venv nginx certbot python3-certbot-nginx

echo "==> user and directories"
id -u radar >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/radar --shell /usr/sbin/nologin radar
mkdir -p "$APP_DIR" "$DATA_DIR/reports"
chown -R radar:radar "$APP_DIR" "$DATA_DIR"

echo "==> application files"
# Copy the whole app/ directory into $APP_DIR before running this, e.g.:
#   rsync -av --exclude data --exclude .env ./app/ root@HOST:$APP_DIR/
for file in server.py trading.py autotrade.py web/index.html web/enhancements.js web/autotrade.js; do
    if [[ ! -f "$APP_DIR/$file" ]]; then
        echo "MISSING: $APP_DIR/$file — copy the application files first." >&2
        exit 1
    fi
done

echo "==> python dependencies (only needed for live/testnet signing)"
pip3 install --break-system-packages -r "$APP_DIR/requirements.txt" || \
    echo "WARNING: SDK install failed. dry-run still works; live Hyperliquid orders will not."

echo "==> .env"
if [[ ! -f "$APP_DIR/.env" ]]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || touch "$APP_DIR/.env"
    PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")
    {
        echo "HOST=127.0.0.1"
        echo "PORT=4174"
        echo "DATA_DIR=$DATA_DIR"
        echo "REPORT_DIR=$DATA_DIR/reports"
        echo "RADAR_USER=radar"
        echo "RADAR_PASSWORD=$PASSWORD"
    } >> "$APP_DIR/.env"
    echo "    generated UI password: $PASSWORD"
    echo "    (stored in $APP_DIR/.env — save it now)"
fi
chown radar:radar "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "==> systemd"
cp "$APP_DIR/deploy/liquidation-radar.service" "/etc/systemd/system/$SERVICE.service" 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 2
systemctl --no-pager --lines=20 status "$SERVICE" || true

echo
echo "==> next steps"
echo "  1. Edit /etc/nginx/sites-available/liquidation-radar and set your domain."
echo "  2. Add to the http{} block of /etc/nginx/nginx.conf:"
echo "     limit_req_zone \$binary_remote_addr zone=radar_login:10m rate=30r/m;"
echo "  3. ln -s /etc/nginx/sites-available/liquidation-radar /etc/nginx/sites-enabled/"
echo "  4. nginx -t && systemctl reload nginx"
echo "  5. certbot --nginx -d YOUR.DOMAIN"
echo "  6. ufw allow 80,443/tcp && ufw enable"
echo
echo "The app starts in dry-run: no exchange keys are required to verify it."

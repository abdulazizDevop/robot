#!/usr/bin/env bash
# Publish the radar over HTTPS.
#
#   bash deploy/setup-tls.sh                      -> uses <public-ip>.sslip.io
#   bash deploy/setup-tls.sh radar.example.com    -> uses your own domain
#   EMAIL=you@example.com bash deploy/setup-tls.sh
#
# sslip.io resolves <ip>.sslip.io to that IP, so Let's Encrypt can issue a real
# certificate without owning a domain. It is a free third-party DNS service:
# fine to start with, worth replacing with a real domain for a client-facing
# deployment, because if sslip.io ever stops resolving the panel stops loading.
set -euo pipefail

SITE=/etc/nginx/sites-available/liquidation-radar
ZONE_FILE=/etc/nginx/conf.d/liquidation-radar-zone.conf
UPSTREAM_PORT="${UPSTREAM_PORT:-4174}"

if [[ $EUID -ne 0 ]]; then
    echo "Run as root: sudo bash deploy/setup-tls.sh" >&2
    exit 1
fi

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
    IP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
    if [[ ! "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Could not detect the public IP. Pass a domain explicitly:" >&2
        echo "  bash deploy/setup-tls.sh radar.example.com" >&2
        exit 1
    fi
    DOMAIN="${IP}.sslip.io"
    echo "==> no domain given, using $DOMAIN"
fi

echo "==> checking that $DOMAIN resolves here"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
LOCAL_IP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
if [[ -z "$RESOLVED" ]]; then
    echo "WARNING: $DOMAIN does not resolve yet. Certbot will fail until it does." >&2
elif [[ -n "$LOCAL_IP" && "$RESOLVED" != "$LOCAL_IP" ]]; then
    echo "WARNING: $DOMAIN resolves to $RESOLVED but this server is $LOCAL_IP." >&2
    echo "         Fix the DNS record before continuing, or certbot will fail." >&2
fi

echo "==> packages"
apt-get update -qq
apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx

echo "==> rate-limit zone"
# limit_req_zone is only valid in the http context. conf.d/ is included from
# there, so dropping it in its own file keeps this idempotent.
cat > "$ZONE_FILE" <<'EOF'
# Slows credential guessing against the panel's Basic auth.
limit_req_zone $binary_remote_addr zone=radar_login:10m rate=30r/m;
EOF

echo "==> nginx site for $DOMAIN"
# Plain HTTP only. certbot --nginx adds the TLS server block, the redirect and
# the renewal hook itself, so writing them here would only fight it.
cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # A whale report can take close to a minute; do not cut it off.
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    location / {
        limit_req zone=radar_login burst=20 nodelay;
        proxy_pass http://127.0.0.1:${UPSTREAM_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # The app checks Basic auth itself, so the header must reach it intact.
        proxy_pass_request_headers on;
    }
}
EOF

ln -sf "$SITE" /etc/nginx/sites-enabled/liquidation-radar
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> certificate"
CERTBOT_ARGS=(--nginx -d "$DOMAIN" --agree-tos --redirect --non-interactive)
if [[ -n "${EMAIL:-}" ]]; then
    CERTBOT_ARGS+=(-m "$EMAIL")
else
    CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
if certbot "${CERTBOT_ARGS[@]}"; then
    echo "==> certificate installed"
else
    echo "WARNING: certbot failed. The panel is up on plain HTTP only." >&2
    echo "         Basic auth over HTTP sends the password in clear text —" >&2
    echo "         fix DNS and re-run before giving anyone the address." >&2
fi

echo "==> hardening security headers"
if ! grep -q 'Strict-Transport-Security' "$SITE"; then
    # certbot has now created the 443 block; add the headers inside it.
    python3 - "$SITE" <<'PY'
import sys
path = sys.argv[1]
lines = open(path).read().splitlines(keepends=True)
headers = [
    '    add_header Strict-Transport-Security "max-age=31536000" always;\n',
    '    add_header X-Content-Type-Options "nosniff" always;\n',
    '    add_header X-Frame-Options "DENY" always;\n',
    '    add_header Referrer-Policy "no-referrer" always;\n',
]
# certbot appends `listen 443 ssl;` at the END of the server block, after the
# location{} it already contains — so anchor on that line rather than trying to
# match the block from its opening brace.
for index, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith('listen 443') or stripped.startswith('listen [::]:443'):
        lines[index + 1:index + 1] = headers
        open(path, 'w').write(''.join(lines))
        print('security headers added')
        break
else:
    print('no 443 listener found, skipping headers')
PY
    nginx -t && systemctl reload nginx
fi

echo
echo "==> done"
echo "    https://${DOMAIN}"
echo "    Expect a login prompt. The username/password are RADAR_USER and"
echo "    RADAR_PASSWORD from app/.env."
echo
echo "    Renewal is handled by the certbot systemd timer:"
echo "      systemctl list-timers | grep certbot"

#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
cat >/etc/caddy/Caddyfile <<'EOF'
144-31-223-144.sslip.io {
    reverse_proxy /push/* 127.0.0.1:8766
    reverse_proxy 127.0.0.1:8765
}
EOF
ufw allow 80/tcp || true
ufw allow 443/tcp || true
systemctl enable --now caddy
systemctl reload caddy
systemctl --no-pager --full status caddy

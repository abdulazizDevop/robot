#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
IP="${IP:-$(curl -fsS https://api.ipify.org)}"
HOST="${DOMAIN:-${IP//./-}.sslip.io}"
# Everything goes through server.py, which checks the login before it proxies
# /push/* to the push service. The bare IP only has Caddy's self-signed
# certificate, so it redirects to the name that has a real one.
cat >/etc/caddy/Caddyfile <<EOF
${HOST} {
    encode gzip
    reverse_proxy 127.0.0.1:8765
}
http://${IP}, https://${IP} {
    tls internal
    redir https://${HOST}{uri} permanent
}
EOF
ufw allow 80/tcp || true
ufw allow 443/tcp || true
systemctl enable --now caddy
systemctl reload caddy
systemctl --no-pager --full status caddy

# Ubuntu 24.04 deployment

The current VPS is reachable, so use the following sequence. The script installs a small Python server and a `systemd` service; the browser still connects directly to Hyperliquid's public WebSocket.

## 1. Upload from Windows PowerShell

Run this locally from the project directory (the password is entered only by SSH):

```powershell
$app = 'C:\Users\1\Documents\Codex\2026-09-12\new-chat-3\outputs\Hyperliquid Radar'
& 'C:\Windows\System32\OpenSSH\scp.exe' -r $app root@144.31.223.144:/root/
```

If the target directory does not exist, first run on Ubuntu:

```bash
mkdir -p /root/hyperliquid-radar
```

## 2. Install and start on Ubuntu

```bash
cd '/root/Hyperliquid Radar'
chmod +x deploy-ubuntu.sh server.py
./deploy-ubuntu.sh
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8766/push/health
```

The expected responses contain `"ok": true`. The web service and the persistent Hyperliquid push listener survive SSH disconnects and server reboots.

## 3. Free HTTPS and Safari push

Let’s Encrypt now supports short-lived certificates for public IP addresses. Run on Ubuntu:

```bash
cd '/root/Hyperliquid Radar'
chmod +x enable-https.sh
./enable-https.sh
```

Then open `https://144-31-223-144.sslip.io/`. This free DNS name resolves to `144.31.223.144`, allowing Caddy to request a normal public certificate. If the shared DNS service is unavailable, use any domain/subdomain pointing to the same IP and replace the address in `/etc/caddy/Caddyfile`.

In the radar interface, click **Включить push** and allow notifications. On iPhone/iPad, add the HTTPS site to the Home Screen before enabling push. The service worker receives events while Safari is closed; the server listener watches the saved addresses and sends only OPEN/CLOSE events.

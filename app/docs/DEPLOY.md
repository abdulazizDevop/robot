# Deploy — Timeweb Cloud

Two supported shapes. Docker is the shorter path; the VPS path gives you the
plain process under systemd. Both keep the app on `127.0.0.1` and publish it
through nginx with TLS.

Read **Before you expose it** first — this app can spend real money.

---

## Before you expose it

The UI has no per-user accounts. Anyone who can reach it and knows the Basic
auth password can place orders with your keys once the mode is not `dry-run`.

What is already enforced in code:

| Guard | Behaviour |
|---|---|
| Static allowlist | Only `index.html`, `enhancements.js`, `autotrade.js` are served. `.env`, `*.sqlite3`, `*.py` return 404. |
| Basic auth | Active whenever `RADAR_PASSWORD` is set. Applies to every GET and POST. |
| Public-bind guard | The process **refuses to start** with `HOST=0.0.0.0` and an empty `RADAR_PASSWORD`. |
| Default mode | `dry-run`. Orders are recorded, never sent. No exchange key required. |

What you still have to do:

1. Put TLS in front of it. Basic auth over plain HTTP sends the password in
   clear text on every request.
2. Use a **Hyperliquid API wallet key**, not your main wallet's seed. Create it
   at `app.hyperliquid.xyz/API`. It can trade but cannot withdraw.
3. Use a **Bybit key scoped to derivatives trading only**, no withdrawal
   permission, and IP-restricted to the server address.
4. Keep `mode=dry-run` until the decision log looks right. Then `testnet`. Then
   `live`.
5. `chmod 600 .env`.

---

## Option A — Docker (recommended)

On the Timeweb server:

```bash
mkdir -p /opt/liquidation-radar && cd /opt/liquidation-radar
# copy the app/ directory here (scp, git, rsync)

cp .env.example .env
python3 -c "import secrets; print('RADAR_PASSWORD=' + secrets.token_urlsafe(24))" >> .env
chmod 600 .env

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f          # expect: "Auto-trade: dry-run"
curl -u radar:PASSWORD http://127.0.0.1:4174/api/health
```

Data lives in the `radar_data` and `radar_reports` volumes, so
`docker compose -f deploy/docker-compose.yml up -d --build` after a code change keeps every captured row.

Then set up nginx as in **TLS** below.

## Option B — VPS without Docker

```bash
mkdir -p /opt/liquidation-radar && cd /opt/liquidation-radar
# copy the app/ directory here, including deploy/

bash deploy/install-vps.sh
```

The script creates the `radar` system user, installs the SDK, generates a UI
password, writes `.env`, and starts the systemd unit. It prints the generated
password once — save it.

```bash
systemctl status liquidation-radar
journalctl -u liquidation-radar -f
```

## TLS (both options)

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/liquidation-radar
# edit: replace radar.example.com with your domain
```

Add to the `http { }` block of `/etc/nginx/nginx.conf` — `limit_req_zone` is
invalid anywhere else and `nginx -t` will fail without it:

```nginx
limit_req_zone $binary_remote_addr zone=radar_login:10m rate=30r/m;
```

Then:

```bash
ln -s /etc/nginx/sites-available/liquidation-radar /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d your.domain
ufw allow 80,443/tcp && ufw allow OpenSSH && ufw enable
```

---

## Going live, in order

1. **dry-run** — open the UI, press *Авто-торговля*, watch the decision log fill
   with real deviations. No keys, no risk. Confirm the numbers look sane.
2. **testnet** — put testnet credentials in `.env`, restart, set mode to
   `testnet` in the settings panel. Confirm an order actually appears on the
   exchange.
3. **live** — real key, small `order_usd`, low `max_orders_per_hour`, low
   `max_account_risk_pct`. Watch the first fills yourself.

Restart after editing `.env`:

```bash
docker compose -f deploy/docker-compose.yml restart   # Docker
systemctl restart liquidation-radar   # systemd
```

Trading settings (venue, leverage, order type, thresholds) are changed in the
UI and stored in `trading_settings.json` inside `DATA_DIR` — no restart needed.

---

## Environment

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` requires `RADAR_PASSWORD`. |
| `PORT` | `4174` | |
| `DATA_DIR` | `app/data` | SQLite DBs, caches, `trading_settings.json`, `.env`. |
| `WEB_DIR` | `app/web` | The three served static files. |
| `REPORT_DIR` | `~/Desktop` | `.txt` reports. Set to a server path. |
| `AUTOTRADE_AUTOSTART` | off | `1` resumes following after a restart. |
| `AUTOTRADE_TARGET` | — | Pin an address for autostart. |
| `RADAR_USER` / `RADAR_PASSWORD` | `radar` / empty | Empty password = no auth (loopback only). |
| `HYPERLIQUID_PRIVATE_KEY` | — | API wallet key. Signs locally, never transmitted. |
| `HYPERLIQUID_ACCOUNT_ADDRESS` | — | Main wallet the API wallet trades for. |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | — | Derivatives permission only. |
| `BYBIT_TESTNET` | `false` | |
| `ARKHAM_API_KEY` | — | Optional; only the Arkham tab needs it. |

## Backup

Everything mutable is in `DATA_DIR`:

```bash
# Docker
docker run --rm -v radar_data:/data -v $PWD:/backup alpine \
  tar czf /backup/radar-$(date +%F).tar.gz -C /data .

# systemd
tar czf radar-$(date +%F).tar.gz -C /var/lib/liquidation-radar .
```

`radar.sqlite3` grows with the captured market stream — it was already ~58 MB
at export time. Budget disk accordingly, or prune the `events` table.

## Known limits

- The whale watcher **polls** every `poll_interval_seconds` (default 3 s). The
  Hyperliquid WebSocket (`userEvents`, `orderUpdates`) would cut that latency
  and is not implemented yet.
- There is no automatic take-profit / stop-loss. The engine opens mirrored
  positions; closing them is manual.
- Hyperliquid rate-limits by IP. All routes share one queue and cache; heavy
  reports can still hit 429 and fall back to cached rows.

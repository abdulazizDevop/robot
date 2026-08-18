# AutoRobot

Hyperliquid whale radar with a copy-trading execution engine.

The radar finds profitable wallets from public on-chain data and watches them.
When a tracked whale opens a position and the market is still within **0.5 %**
of their entry, the engine places the same trade immediately — 1x leverage,
limit order, futures only.

Discovery needs **no API key**. The app ships in `dry-run`, where it prices
everything against the live market and records what it would have done, without
sending a single order.

## Layout

```
app/
├── server.py          HTTP server, radar, whale reports  (stdlib only)
├── trading.py         Hyperliquid + Bybit brokers, risk checks
├── autotrade.py       whale follower: signals, 0.5% rule, order log
├── healthcheck.py     container/host liveness probe
├── web/               index.html, enhancements.js, autotrade.js
├── data/              SQLite databases and caches   (gitignored)
├── deploy/            Dockerfile, compose, systemd unit, nginx, installer
└── docs/
    ├── DEPLOY.md      how to put it on a server
    ├── TIMEWEB.md     what to order at Timeweb and why
    └── OPERATIONS.md  what breaks over months, and what was done about it

_source_export/        original Codex export, kept for reference
```

## Run it locally

```bash
cd app
python3 server.py
```

Open `http://localhost:4174` → tab **Авто-торговля**.

No `.env`, no keys, nothing to install: `server.py`, `trading.py` and
`autotrade.py` are Python standard library only. The two packages in
`requirements.txt` are needed *only* to sign live Hyperliquid orders.

## Deploy

Start with [docs/TIMEWEB.md](app/docs/TIMEWEB.md) to pick the server, then
[docs/DEPLOY.md](app/docs/DEPLOY.md) to install it.

Short version — Docker:

```bash
cd app
cp .env.example .env && chmod 600 .env    # set RADAR_PASSWORD
docker compose -f deploy/docker-compose.yml up -d --build
```

## Safety

- Static allowlist: only the three files in `web/` are served. `.env`, the
  databases and the source return 404 on both GET and HEAD.
- Basic auth on every request once `RADAR_PASSWORD` is set.
- The process **refuses to start** on a public `HOST` without a password.
- Risk checks run before an order is signed: per-order share of equity, minimum
  free balance, max open positions, max orders per hour.
- Modes go `dry-run` → `testnet` → `live`, and `dry-run` is the default.

## Not implemented

No take-profit / stop-loss, and no WebSocket — the follower polls every 3 s.
Both are described in [docs/OPERATIONS.md](app/docs/OPERATIONS.md).

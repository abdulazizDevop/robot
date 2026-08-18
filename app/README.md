# Liquidation Radar + Auto-Trade

Local crypto-monitoring application with a Python backend and SQLite storage,
extended with a whale-following execution engine.

Discovery and analysis need **no API key at all**. Keys are required only to
send real orders, and the app ships in `dry-run` where it sends none.

## Start

```bash
cp .env.example .env      # optional for dry-run
python3 server.py
```

Open `http://localhost:4174`. For a server, see [docs/DEPLOY.md](docs/DEPLOY.md),
[docs/TIMEWEB.md](docs/TIMEWEB.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

Only `hyperliquid-python-sdk` and `eth-account` are ever needed
(`requirements.txt`), and only for signing live Hyperliquid orders. Everything
else — the radar, the whale reports, the dry-run pipeline, all Bybit calls — is
Python standard library.

## Data sources

- Bybit linear futures WebSocket: real-time liquidation events and market prices for tracked USDT pairs.
- Dexscreener: cross-chain DEX candidates filtered by a configurable minimum spread (default 0.5%), with both pool networks, contracts, TVL/liquidity, and 24-hour volume. The result is an opportunity candidate, not guaranteed profit after bridge time, gas, fees, slippage, and token risk.
- Arkham: transfers when no wallet is entered; swaps for a specific wallet. Arkham data requires a key/account plan that permits the configured endpoint.
- Hyperliquid public Info API: recent perpetual market trades, fills/closed PnL, `clearinghouseState`, `openOrders` and `l2Book` for a wallet address, without an API key.

## Auto-trade

Tab **Авто-торговля**.

**Discovery is not reimplemented.** Pressing *Авто-торговля* starts the very
same radar the manual button starts (`radar_start_state` in `server.py`), and
the manual *Анализировать* button calls the existing `/api/hyperliquid/12h-whales`
endpoint with your filters. The thresholds, the age check and the win-rate
filter behave exactly as they did before this feature existed.

What is new is the execution half:

1. The radar confirms profitable addresses (24 h net PnL ≥ `min_pnl`, last fill
   within 60 s, first profitable close ≥ 150 days ago).
2. The engine locks onto the highest-PnL address, or one you pin.
3. Every `poll_interval_seconds` it reads that address's new `Open Long` /
   `Open Short` fills **and** the positions it already holds.
4. For each entry it compares the whale's price with the live market:
   `|market − whale| / whale × 100`.
5. If that is at or under `max_deviation_pct` (default **0.5 %**), the order
   goes out immediately — it does not wait for the whale's next update.
6. Limit price comes from the order book: a buy is posted at the best ask so it
   matches at once. Switch `limit_pricing` to `mid` to rest inside the spread.

Every evaluation is written to `autotrade.sqlite3` — executed orders in
`orders`, and every rejection with its exact deviation in `decisions`. Nothing
is silently dropped.

### Futures only

Bybit orders use `category=linear` (USDT perpetuals) and Hyperliquid uses its
perps universe. Spot is never touched.

### Defaults

| Setting | Default | |
|---|---|---|
| `venue` | `hyperliquid` | or `bybit` |
| `mode` | `dry-run` | then `testnet`, then `live` |
| `leverage` | `1` | |
| `order_type` | `limit` | |
| `max_deviation_pct` | `0.5` | the 0.5 % rule |
| `limit_pricing` | `book` | cross the spread → immediate fill |
| `order_usd` | `100` | |
| `max_open_positions` | `3` | |
| `max_orders_per_hour` | `20` | |
| `max_account_risk_pct` | `25` | share of equity per order |
| `follow_direction` | `both` | mirrors shorts as well as longs |

All of them are editable in the settings panel and stored in
`trading_settings.json`. Leverage and order type were requested as 1x/limit and
that is what they start at.

### Modes

- `dry-run` — no credentials, no network write. Orders are priced against the
  real book and recorded locally. Use this to verify the logic.
- `testnet` — signed orders against the exchange testnet.
- `live` — signed orders against mainnet.

## Persistence

`radar.sqlite3` stores incoming liquidation events and Arkham rows. It is
created automatically and is not transmitted by the application.

The same database stores Hyperliquid market trades and user fills. The
Hyperliquid CSV/JSON buttons export these stored rows.

`hyperliquid_radar.sqlite3` holds radar-confirmed addresses;
`autotrade.sqlite3` holds orders and decisions. All of them live in `DATA_DIR`
(default: this directory).

## Access control

`server.py` serves only `index.html`, `enhancements.js` and `autotrade.js`.
`.env`, the databases and the source files are not reachable over HTTP.

Set `RADAR_PASSWORD` to require Basic auth. The process refuses to start on a
non-loopback `HOST` without one, because a reachable UI can place real orders.

## Arkham configuration

The backend reads `.env` on startup. The browser never sees the key. If Arkham
provided a different API endpoint for the current account plan, change
`ARKHAM_API_URL` in `.env`.

Arkham's current x402 routes are paid per request and require payment-signing
support, so they are deliberately not invoked automatically from this local
application.

## Closing with the leader

When the leader leaves a trade, the copy is closed too.

1. Every poll compares our mirrored positions against the leader's live
   `clearinghouseState`.
2. A position missing from the leader's state increments a counter. Only after
   `close_confirmations` **consecutive** polls agree (default 2) does the close
   fire — one dropped snapshot cannot close a live position by mistake.
3. The close is a `reduceOnly` order for the exact quantity we hold.

`close_order_type` decides how hard it tries:

| Value | Behaviour |
|---|---|
| `limit_chase` *(default)* | Post at the touch. If it has not filled after `close_chase_seconds`, cancel and re-post at the new touch. After `close_chase_attempts`, fall back to a market order. |
| `limit` | Post at the touch and leave it. Cheapest, but a fast move can leave it unfilled. |
| `market` | Immediate, pays the spread. |

`limit_chase` exists because a plain limit close can sit unfilled through
exactly the move you are trying to exit, while a market close always pays the
spread. Chase gets the limit price when the book allows it and guarantees the
exit when it does not.

Manual control is in the same panel: **Закрыть** per position, or
**Закрыть все позиции**. Turning off `auto_close` leaves closing entirely to you.

## Long-running behaviour

Bulk price calls, capped caches, WAL journaling, damped decision logging and
hourly retention keep memory and disk flat on a server left on for months.
Measured figures and the routine checks are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Not implemented

- Hyperliquid WebSocket (`userEvents`, `orderUpdates`). The follower polls
  instead; latency is bounded by `poll_interval_seconds`.
- Take-profit / stop-loss on **our own** PnL. Positions close when the leader
  closes, not when a price target is hit.
- Partial closes. `close_on_shrink_pct` closes the whole copy when the leader
  cuts size past the threshold; it does not scale out proportionally.

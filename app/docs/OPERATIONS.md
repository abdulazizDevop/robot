# Running for months without touching it

What breaks in a bot that is left on, and what this app does about it.

## Measured problems and fixes

Each of these was reproduced on the running app before it was fixed.

### 1. Hyperliquid rate-limit ban

`price()` called `allMids` once **per coin**. Following a whale with 13 open
positions cost 13 requests per poll — and `allMids` returns all 947 coins in one
response anyway.

```
before:  13 coins -> 13 HTTP requests, 8.3 s
after:   13 coins ->  1 HTTP request,  0.95 s
repeat:  13 coins ->  0 requests (2 s cache)
```

At a 3 s poll the old path meant ~4 req/s forever, which ends in a 429 ban.
Fixed with a bulk `prices()` per venue, a 2 s read cache, and a per-host pacer
(`_pace`) that keeps Hyperliquid at ≤ 1 request per 150 ms across every thread.

### 2. Decision log growth

A rejected signal is re-checked on every poll, and each rejection was a row.

```
before:  36 rows / 45 s  ->  ~69,000 rows/day
after:   13 rows / 140 s ->  bounded at 13 keys x 288 windows = ~3,700 rows/day
```

The same `(address, coin, side, decision)` skip is now written at most once per
`DECISION_LOG_INTERVAL` (300 s). Executions and failures are **never** damped —
the audit trail stays complete. The in-memory counters
(`orders_skipped`, `checked_signals`) still increment on every evaluation, so
the UI stays accurate.

### 3. `database is locked`

The radar thread, the follower thread and HTTP handlers all write SQLite. With
the default rollback journal and a 5 s timeout, concurrent writes fail
intermittently once the app has been up a while.

All three databases now open with `journal_mode=WAL`, `busy_timeout=15000`,
`synchronous=NORMAL`.

### 4. Unbounded memory

`HL_CACHE` is keyed by request body — every distinct `userFillsByTime` window
was a new permanent entry. `DEX_CACHE` and the 12 h report cache had the same
shape.

All are capped now (`HL_CACHE_MAX=2000`, `DEX_CACHE_MAX=500`, 32 reports) with
oldest-first eviction. `trading.py`'s read cache is capped at 256.

### 5. Unbounded disk

`radar.sqlite3` was already 58 MB at export and grows with every captured market
trade. `read_db()` only ever reads the newest rows, so the rest is dead weight.

Retention runs hourly and on startup:

| Table | Kept |
|---|---|
| `events` | 20,000 newest (`KEEP_EVENTS`) |
| `hyperliquid` | 60,000 newest (`KEEP_HYPERLIQUID`) |
| `onchain` | 40,000 newest (`KEEP_ONCHAIN`) |
| `orderbook` | 20,000 newest (`KEEP_ORDERBOOK`) |
| `decisions` | 14 days |
| `orders` | 180 days |
| `seen_fills` | 3 days |

The first startup after this change trimmed 27,655 rows.

Deleting rows does not shrink the file — SQLite keeps the freed pages. Measured
on the real database: 56 MB after retention, **41 MB after `VACUUM`**. See
*Routine checks* below; VACUUM is deliberately not automatic because it needs an
exclusive lock.

### 6. Survives a restart

`Restart=always` (systemd) and `restart: always` (Docker). Set
`AUTOTRADE_AUTOSTART=1` to resume following after a reboot or redeploy —
opt-in, because it resumes in whatever mode is configured. `AUTOTRADE_TARGET`
pins an address; without it the radar picks.

Memory ceilings (`MemoryMax=768M` / `mem_limit: 768m`) turn a runaway report
into a restart rather than an OOM-killed VPS. `StartLimitBurst=10` stops a crash
loop from spinning forever.

## What is still not automatic

- **No take-profit / stop-loss on our own PnL.** Positions close when the
  *leader* closes (`auto_close`, two confirmations, `limit_chase` by default).
  Nothing reacts to our position going against us while the leader stays in.
- **No partial closes.** `close_on_shrink_pct` exits the whole copy when the
  leader cuts size past the threshold; it does not scale out proportionally.
- **Polling, not WebSocket.** Latency is bounded by `poll_interval_seconds`
  (default 3 s) plus one bulk price call. Hyperliquid's `userEvents` /
  `orderUpdates` streams would cut it further.
- **No alerting.** Failures land in `decisions.status='failed'` and the journal.
  Nothing pages you.

## Routine checks

```bash
# is it alive and following?
curl -u radar:PASS https://your.domain/api/autotrade/status | jq '{phase,target,orders_sent,last_error}'

# anything failing?
sqlite3 /var/lib/liquidation-radar/autotrade.sqlite3 \
  "SELECT created_at,coin,side,status,error FROM orders WHERE status='failed' ORDER BY id DESC LIMIT 20;"

# database sizes
du -sh /var/lib/liquidation-radar/*.sqlite3

# logs
journalctl -u liquidation-radar --since '1 hour ago' | tail -50
docker compose -f deploy/docker-compose.yml logs --tail=50
```

Symptoms worth acting on:

| Symptom | Likely cause |
|---|---|
| `last_error` mentions 429 | Poll interval too low, or another client shares the IP. Raise `poll_interval_seconds`. |
| `phase` stuck on `searching` | Normal. Radar filters are strict (24 h PnL ≥ $1500, fill < 60 s old, account ≥ 150 days). Pin a target to bypass. |
| Orders `failed` with a lot-size message | `order_usd` is below the venue's minimum lot for that coin. |
| `radar.sqlite3` still growing | Lower `KEEP_HYPERLIQUID`; run `VACUUM` once after a large prune. |

`VACUUM` is not automatic — deleting rows frees pages inside the file but does
not shrink it. After a big retention change:

```bash
systemctl stop liquidation-radar
sqlite3 /var/lib/liquidation-radar/radar.sqlite3 'VACUUM;'
systemctl start liquidation-radar
```

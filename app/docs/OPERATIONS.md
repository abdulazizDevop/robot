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

A count cap turned out not to be enough. A `userFillsByTime` reply for an
active whale is hundreds of KB and every poll mints a new `startTime/endTime`
key, so 2000 entries were still ~570 MB:

```
after 22 h:  container 687 / 768 MiB, python RSS 684 MB  (limit 81 MB away)
fix:         HL_CACHE capped by BYTES (HL_CACHE_MAX_MB=96) and entries past
             4x their TTL dropped on every write
after fix:   RSS 60 MB, HL cache 2.5 MB
```

`GET /api/health` now reports `rss_mb` and every cache's size, so growth is
visible from a browser without ssh.

### 7. Slow aggregate routes and the phone that kept crashing

`saved-leader-summary`, `open-pnl-leaders`, `token-leaders`, `copy-leader` and
the manual-analysis report each walk dozens of addresses through the 1 s
Hyperliquid pacer: 15–65 s per response. The page polled five of them every
15 s, requests overlapped and piled up, and iOS Safari killed the tab.

They are served **stale-while-revalidate** now: a fresh cache answers in
~0.4 s, a stale one answers instantly and refreshes in the background, and the
65 s report returns `202 {computing:true}` on a cold miss so the browser polls
instead of holding a connection open for a minute. `X-Cache: hit|stale|miss`
and `X-Cache-Age` are on every response. Measured on the server:

```
open-pnl-leaders   cold 55.6 s -> warm 0.41 s
saved-leader-summary cold 73.4 s -> warm 0.42 s
12h-whales         202 in 0.44 s -> 200 from cache 90 s later in 0.6 s
```

A pre-warm covers the first load after a restart; after that only what a
visitor actually looks at is refreshed.

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

## The order path, proven

Until 2026-09-02 not one order had ever reached the exchange: 1846 attempts,
all rejected with `10001: position idx not match position mode`. The account is
in hedge mode, where Bybit requires positionIdx 1/2, and trading.py sent none.

Verified live after the fix, on the real account:

```
probe   BUY  LINK limit @ 7.86 (30% below market)  -> accepted, rested, cancelled
open    BUY  LINK limit @ 11.232  0.6 LINK ($7)    -> sent · Filled, positionIdx 1
exchange LINKUSDT idx=1 Buy size=0.6 entry=11.232
close   SELL LINK market reduceOnly 0.6            -> positionIdx 1, filled
result  0 open positions, equity $117.73 -> $117.71
```

The close is the subtle half: in hedge mode positionIdx names the *leg*, not the
order side, so selling to close a long still carries index 1. Both directions are
now confirmed against the live API.

Not exercised by this test: `limit_chase` (the test closed at market for a
guaranteed exit) and the auto-close trigger itself. Their state machines are
covered by unit tests, not by a live fill.

## Why the radar panel showed nothing

The client reported "Покупки и продажи радара" sitting at 0 buys / 0 sells while
claiming "найдено адресов по фильтру: 5 · обновляется из live-сканирования".
Four separate faults, measured on the live box:

1. **One 429 killed the whole scan.** The candidate loop had no try/except, so a
   single rate-limited address aborted every remaining candidate. The worker
   caught it 30 s later and hit the same wall forever. `last_error` was
   permanently "Hyperliquid временно недоступен". Each candidate is now wrapped;
   failures are counted and reported as `last_skipped`.

2. **17-day-old rows were presented as live.** `radar/status` returned every row
   in the database. Rows are now filtered by `RADAR_ROW_TTL` (900 s) and the
   withheld count is reported as `stale_count`.

3. **Those stale rows had no `opened_at`.** They predate that field, so the
   panel's window filter fell back to `last_seen` (17 days) and dropped every
   position — hence 0/0 even with 65 positions stored.

4. **The radar was not running at all**, and nothing started it. `RADAR_AUTOSTART=1`
   now starts it on boot with the operator's saved thresholds, and the radar
   panel's own Start persists what it was given so a restart does not silently
   revert to defaults.

The account-age gate was also hardcoded at 150 days; it is `radar_min_age_days`
now. Lowering it does not help much, which is the honest finding:

```
65 recent-trade participants checked for account age
   6 have any profitable close in history   (all already >150 days old)
  59 have none  -> rejected regardless of the threshold
```

Candidates come from `recentTrades` participants — mostly ordinary counterparties,
not whales. Live discovery is therefore low-yield by construction; the radar
confirmed 5 wallets in its entire lifetime. The productive path is the saved
address list, which works well: `open-pnl-leaders` returns a leader holding
$570,801 in unrealised PnL from the 53 saved wallets.

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

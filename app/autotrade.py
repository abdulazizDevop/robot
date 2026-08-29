#!/usr/bin/env python3
"""Whale-following execution engine.

Discovery is deliberately *not* reimplemented here.  The engine calls straight
into the radar that already exists in ``server.py`` (same filters, same
thresholds, same database), so the selection logic keeps behaving exactly as it
did before this module was added.  What is new is only the part the radar never
had: comparing the whale's entry price against the live market and sending an
order when the gap is inside the configured tolerance.

Auto flow:
  start -> radar discovers profitable addresses -> the engine locks onto the
  best one -> every poll it looks for freshly opened whale positions -> if
  |whale entry - market| / whale entry <= max_deviation_pct it fires the order
  immediately, without waiting for the whale's next update.
"""
import json
import os
import sqlite3
import threading
import time

import trading
from trading import TradingError

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('DATA_DIR', '').strip() or os.path.join(ROOT, 'data')
DB_PATH = os.path.join(DATA_DIR, 'autotrade.sqlite3')

OPEN_ACTIONS = {'Open Long': 'BUY', 'Open Short': 'SELL'}
CLOSE_ACTIONS = {'Close Long', 'Close Short'}

# Injected from server.py so the engine reuses the shared rate limiter, cache
# and fill normaliser instead of opening a second uncoordinated pipe to
# Hyperliquid.
_HOOKS = {}


def configure(**hooks):
    _HOOKS.update(hooks)


def _hook(name):
    handler = _HOOKS.get(name)
    if handler is None:
        raise TradingError(f'autotrade: не подключён обработчик {name}')
    return handler


def _validate_address(address):
    """Reuse the server's address check but report it as a client error."""
    try:
        return _hook('validate_address')(address)
    except ValueError as error:
        raise TradingError(str(error)) from error


# ------------------------------------------------------------- storage

def db():
    connection = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=15)
    connection.row_factory = sqlite3.Row
    # The radar thread, the follower thread and HTTP handlers all write here.
    # Without WAL and a busy timeout that combination produces intermittent
    # "database is locked" failures once the app has been up for a while.
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA busy_timeout=15000')
    connection.execute('PRAGMA synchronous=NORMAL')
    connection.execute(
        'CREATE TABLE IF NOT EXISTS orders ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, address TEXT NOT NULL,'
        'coin TEXT NOT NULL, side TEXT NOT NULL, whale_price REAL NOT NULL, market_price REAL NOT NULL,'
        'deviation_pct REAL NOT NULL, usd REAL NOT NULL, qty REAL NOT NULL, price REAL NOT NULL,'
        'venue TEXT NOT NULL, mode TEXT NOT NULL, order_type TEXT NOT NULL, leverage REAL NOT NULL,'
        'order_id TEXT, source TEXT NOT NULL, status TEXT NOT NULL, error TEXT)')
    connection.execute(
        'CREATE TABLE IF NOT EXISTS decisions ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, address TEXT NOT NULL,'
        'coin TEXT NOT NULL, side TEXT NOT NULL, whale_price REAL, market_price REAL,'
        'deviation_pct REAL, decision TEXT NOT NULL, reason TEXT NOT NULL)')
    connection.execute(
        'CREATE TABLE IF NOT EXISTS seen_fills (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)')
    connection.execute(
        'CREATE TABLE IF NOT EXISTS mirrored (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)')
    # A mirror is not just a lock: closing with the leader needs to know what we
    # copied and how many polls have agreed the leader is out.  Added by
    # migration so an existing database keeps its claims.
    existing = {row['name'] for row in connection.execute('PRAGMA table_info(mirrored)')}
    for column, definition in (
        ('address', 'TEXT'), ('coin', 'TEXT'), ('side', 'TEXT'), ('venue', 'TEXT'),
        ('qty', 'REAL'), ('entry_price', 'REAL'), ('close_checks', 'INTEGER NOT NULL DEFAULT 0'),
        ('closing_order_id', 'TEXT'), ('closing_since', 'INTEGER'), ('close_attempts', 'INTEGER NOT NULL DEFAULT 0'),
        ('leader_size', 'REAL'),
    ):
        if column not in existing:
            connection.execute(f'ALTER TABLE mirrored ADD COLUMN {column} {definition}')
    connection.commit()
    return connection


# A rejected signal is re-evaluated on every poll, so writing every rejection
# would add tens of thousands of near-identical rows per day.  The same
# (address, coin, side, decision) is only written again after this many seconds,
# or immediately when the outcome actually changes.
DECISION_LOG_INTERVAL = 300.0
_DECISION_SEEN = {}
_DECISION_LOCK = threading.Lock()


def _should_log_decision(address, coin, side, decision):
    key = (address, coin, side, decision)
    now = time.monotonic()
    with _DECISION_LOCK:
        last = _DECISION_SEEN.get(key)
        if last is not None and now - last < DECISION_LOG_INTERVAL:
            return False
        if len(_DECISION_SEEN) > 4096:
            _DECISION_SEEN.clear()
        _DECISION_SEEN[key] = now
        return True


# A failed order leaves the signal unseen so a transient problem can be retried,
# but a permanent one (wrong position mode, notional under the venue's minimum
# lot) then repeats every poll forever.  One rejected order was sent 100 times.
# Back off per (address, coin, side) instead, and reset the moment one succeeds.
FAILURE_BACKOFF_START = 30.0
FAILURE_BACKOFF_MAX = 900.0
_FAILURES = {}
_FAILURE_LOCK = threading.Lock()


def _failure_key(address, coin, side):
    return (str(address).lower(), coin, side)


def _blocked_after_failure(address, coin, side):
    """True while a repeatedly failing signal is still in its backoff window."""
    with _FAILURE_LOCK:
        entry = _FAILURES.get(_failure_key(address, coin, side))
        return bool(entry) and time.monotonic() < entry['retry_at']


def _note_failure(address, coin, side):
    key = _failure_key(address, coin, side)
    with _FAILURE_LOCK:
        entry = _FAILURES.get(key) or {'count': 0}
        entry['count'] += 1
        delay = min(FAILURE_BACKOFF_START * (2 ** (entry['count'] - 1)), FAILURE_BACKOFF_MAX)
        entry['retry_at'] = time.monotonic() + delay
        if len(_FAILURES) > 2048:
            _FAILURES.clear()
        _FAILURES[key] = entry
        return delay


def _clear_failure(address, coin, side):
    with _FAILURE_LOCK:
        _FAILURES.pop(_failure_key(address, coin, side), None)


def _record_decision(address, coin, side, whale_price, market_price, deviation, decision, reason):
    # Executions and failures are always kept; only repeated skips are damped.
    if decision == 'skipped' and not _should_log_decision(address, coin, side, decision):
        return
    connection = db()
    connection.execute(
        'INSERT INTO decisions (created_at,address,coin,side,whale_price,market_price,deviation_pct,decision,reason)'
        ' VALUES (?,?,?,?,?,?,?,?,?)',
        (int(time.time() * 1000), address, coin, side, whale_price, market_price, deviation, decision, reason))
    connection.commit()
    connection.close()


def _record_order(row):
    connection = db()
    cursor = connection.execute(
        'INSERT INTO orders (created_at,address,coin,side,whale_price,market_price,deviation_pct,usd,qty,price,'
        'venue,mode,order_type,leverage,order_id,source,status,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (row['created_at'], row['address'], row['coin'], row['side'], row['whale_price'], row['market_price'],
         row['deviation_pct'], row['usd'], row['qty'], row['price'], row['venue'], row['mode'], row['order_type'],
         row['leverage'], row.get('order_id'), row['source'], row['status'], row.get('error')))
    connection.commit()
    order_id = cursor.lastrowid
    connection.close()
    return order_id


def _seen(key):
    connection = db()
    row = connection.execute('SELECT 1 FROM seen_fills WHERE key=?', (key,)).fetchone()
    connection.close()
    return bool(row)


def _mark_seen(key):
    connection = db()
    connection.execute('INSERT OR IGNORE INTO seen_fills (key,created_at) VALUES (?,?)',
                       (key, int(time.time() * 1000)))
    connection.commit()
    connection.close()


def _claim_mirror(key, address=None, coin=None, side=None, venue=None):
    """Reserve a (coin, side) slot.  Returns False when it was already taken."""
    connection = db()
    try:
        connection.execute(
            'INSERT INTO mirrored (key,created_at,address,coin,side,venue) VALUES (?,?,?,?,?,?)',
            (key, int(time.time() * 1000), address, coin, side, venue))
        connection.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        connection.close()


def _update_mirror(key, **fields):
    if not fields:
        return
    assignments = ','.join(f'{name}=?' for name in fields)
    connection = db()
    connection.execute(f'UPDATE mirrored SET {assignments} WHERE key=?',
                       (*fields.values(), key))
    connection.commit()
    connection.close()


def mirrors(address=None):
    connection = db()
    if address:
        rows = [dict(row) for row in connection.execute(
            'SELECT * FROM mirrored WHERE address=? ORDER BY created_at DESC', (address,))]
    else:
        rows = [dict(row) for row in connection.execute(
            'SELECT * FROM mirrored ORDER BY created_at DESC')]
    connection.close()
    return rows


def _release_mirror(key):
    connection = db()
    connection.execute('DELETE FROM mirrored WHERE key=?', (key,))
    connection.commit()
    connection.close()


def _orders_last_hour():
    connection = db()
    since = int(time.time() * 1000) - 3600_000
    # Verified orders are stored as "sent · <exchange status>", so the rate
    # limit has to match the prefix rather than the bare word.  Closes are
    # excluded: the limit exists to cap how often we *enter*, and counting exits
    # against it would let a busy session throttle itself out of new trades.
    row = connection.execute(
        "SELECT COUNT(*) AS n FROM orders"
        " WHERE created_at>=? AND status LIKE 'sent%' AND source<>'close'", (since,)).fetchone()
    connection.close()
    return int(row['n'] if row else 0)


def _open_mirror_count():
    connection = db()
    row = connection.execute('SELECT COUNT(*) AS n FROM mirrored').fetchone()
    connection.close()
    return int(row['n'] if row else 0)


# Retention.  Orders are the audit trail and are kept far longer than the
# decision noise; seen_fills only has to outlive the fill lookback window.
RETENTION_DAYS = {'decisions': 14, 'orders': 180, 'seen_fills': 3}
_PRUNE_INTERVAL = 3600.0
_LAST_PRUNE = 0.0
_PRUNE_LOCK = threading.Lock()


def prune(force=False):
    """Drop rows old enough that nothing reads them, so the database stays flat
    on a machine that runs for months."""
    global _LAST_PRUNE
    now = time.monotonic()
    with _PRUNE_LOCK:
        if not force and now - _LAST_PRUNE < _PRUNE_INTERVAL:
            return None
        _LAST_PRUNE = now
    cutoff_base = int(time.time() * 1000)
    removed = {}
    connection = db()
    try:
        for table, days in RETENTION_DAYS.items():
            cutoff = cutoff_base - days * 86_400_000
            cursor = connection.execute(f'DELETE FROM {table} WHERE created_at<?', (cutoff,))
            removed[table] = cursor.rowcount
        connection.commit()
    finally:
        connection.close()
    return removed


def recent_orders(limit=100):
    connection = db()
    rows = [dict(row) for row in connection.execute(
        'SELECT * FROM orders ORDER BY id DESC LIMIT ?', (min(max(limit, 1), 500),))]
    connection.close()
    return rows


def recent_decisions(limit=100):
    connection = db()
    rows = [dict(row) for row in connection.execute(
        'SELECT * FROM decisions ORDER BY id DESC LIMIT ?', (min(max(limit, 1), 500),))]
    connection.close()
    return rows


# -------------------------------------------------------------- engine

STATE_LOCK = threading.Lock()
STOP_EVENT = threading.Event()
WORKER = None
STATE = {
    'running': False,
    'started_at': 0,
    'target': None,
    'target_locked_at': 0,
    # A target the operator pinned by hand is never rotated automatically.
    'target_pinned': False,
    'target_checked_at': 0,
    'last_poll_at': 0,
    'last_error': None,
    'phase': 'idle',
    'checked_signals': 0,
    'orders_sent': 0,
    'orders_skipped': 0,
}


def snapshot():
    with STATE_LOCK:
        state = dict(STATE)
    settings = trading.load_settings()
    state['settings'] = settings
    state['venue_status'] = trading.venue_status(settings)
    state['open_mirrors'] = _open_mirror_count()
    state['orders_last_hour'] = _orders_last_hour()
    # The close panel needs the leader/our-position pairing, plus how many
    # confirmations each mirror has accumulated.
    rows = [row for row in mirrors(state.get('target')) if row.get('coin')]
    leader = {}
    if state.get('target') and rows:
        try:
            leader = _leader_positions(state['target'])
        except (TradingError, Exception):  # noqa: BLE001 - status must never fail
            leader = {}
    state['mirrors'] = [{
        'coin': row['coin'], 'side': row['side'], 'venue': row.get('venue'),
        'qty': row.get('qty'), 'entry_price': row.get('entry_price'),
        'close_checks': int(row.get('close_checks') or 0),
        'closing_order_id': row.get('closing_order_id'),
        'close_attempts': int(row.get('close_attempts') or 0),
        'leader_still_open': (row['coin'], row['side']) in leader,
        'leader_unrealized_pnl': (leader.get((row['coin'], row['side'])) or {}).get('unrealized_pnl'),
        'leader_position_value': (leader.get((row['coin'], row['side'])) or {}).get('position_value'),
    } for row in rows]
    state['close_confirmations_required'] = int(settings.get('close_confirmations', 2))
    state['only_saved_addresses'] = bool(settings.get('only_saved_addresses'))
    state['saved_addresses'] = saved_addresses()
    state['target_refresh_seconds'] = int(settings.get('target_refresh_seconds', 300))
    try:
        state['target_candidates'] = [
            {'address': row.get('address'), 'total_pnl': row.get('total_pnl'),
             'account_value': row.get('account_value'), 'source': row.get('source') or 'radar'}
            for row in _candidates(settings)[:10]]
    except Exception:  # noqa: BLE001 - status must never fail
        state['target_candidates'] = []
    return state


def _set(**values):
    with STATE_LOCK:
        STATE.update(values)


def start(target=None):
    """Start the radar (unchanged discovery) and the follower thread."""
    global WORKER
    settings = trading.load_settings()
    broker = trading.build_broker(settings)
    ok, reason = broker.ready()
    if not ok:
        raise TradingError(reason)
    address = None
    if target:
        address = _validate_address(target)
    # The radar is the discovery half and is started exactly as the UI would.
    _hook('radar_start')({'window_seconds': 86400, 'min_pnl': 1500})
    with STATE_LOCK:
        STATE.update({
            'running': True, 'started_at': int(time.time() * 1000), 'last_error': None,
            'phase': 'searching', 'target': address, 'target_locked_at': int(time.time() * 1000) if address else 0,
            'target_pinned': bool(address),
        })
        STOP_EVENT.clear()
        if not WORKER or not WORKER.is_alive():
            WORKER = threading.Thread(target=_worker, name='autotrade', daemon=True)
            WORKER.start()
    return snapshot()


def set_target(address):
    """Pin the follower to one address, or clear it to resume auto-selection."""
    resolved = _validate_address(address) if address else None
    if resolved and trading.load_settings().get('only_saved_addresses'):
        allowed = saved_addresses()
        if allowed and resolved.lower() not in allowed:
            raise TradingError(
                'Включён режим «только сохранённые адреса»: сначала добавьте '
                f'{resolved} в список или выключите режим')
    with STATE_LOCK:
        STATE['target'] = resolved
        STATE['target_locked_at'] = int(time.time() * 1000) if resolved else 0
        STATE['target_pinned'] = bool(resolved)
        STATE['phase'] = 'watching' if resolved else 'searching'
    return resolved


def stop():
    with STATE_LOCK:
        STATE.update({'running': False, 'phase': 'idle'})
    STOP_EVENT.set()
    try:
        _hook('radar_stop')()
    except Exception:  # noqa: BLE001 - stopping must always succeed
        pass
    return snapshot()


def _worker():
    while True:
        with STATE_LOCK:
            if not STATE['running']:
                return
            settings = trading.load_settings()
        try:
            prune()
            _tick(settings)
            _set(last_error=None)
        except TradingError as error:
            _set(last_error=str(error))
        except Exception as error:  # noqa: BLE001 - a bad poll must not kill the loop
            _set(last_error=f'{type(error).__name__}: {error}')
        finally:
            _set(last_poll_at=int(time.time() * 1000))
        if STOP_EVENT.wait(max(1, int(settings.get('poll_interval_seconds', 3)))):
            return


def saved_addresses():
    """The operator's own watchlist, lowercased."""
    try:
        return [str(a).strip().lower() for a in _hook('saved_addresses')() if a]
    except Exception:  # noqa: BLE001 - an unreadable list must not stop the engine
        return []


def _candidates(settings):
    """Every address eligible to be followed, strongest first."""
    rows = _hook('radar_rows')(100)
    usable = [row for row in rows if row.get('address')]
    usable.sort(key=lambda row: (row.get('total_pnl') or 0, row.get('account_value') or 0), reverse=True)
    if not settings.get('only_saved_addresses'):
        return usable
    allowed = saved_addresses()
    if not allowed:
        return []
    picked = [row for row in usable if str(row.get('address') or '').lower() in allowed]
    known = {str(row.get('address') or '').lower() for row in picked}
    # Watchlist entries the radar has not confirmed are still followed: pinning
    # a list means following those wallets, not re-applying the radar's filters.
    picked.extend({'address': address, 'total_pnl': None, 'account_value': None, 'source': 'saved'}
                  for address in allowed if address not in known)
    return picked


def _pick_target(settings=None):
    """Choose the address to follow."""
    settings = settings or trading.load_settings()
    rows = _candidates(settings)
    return rows[0] if rows else None


def _rotate_target(target, settings):
    """Reconsider an auto-selected target, returning the address to follow.

    The engine used to lock onto the first whale it found and never look again,
    so the panel showed the same address indefinitely no matter how quiet that
    wallet went or how much stronger a later candidate was.  A target the
    operator pinned by hand is left alone.
    """
    with STATE_LOCK:
        pinned = STATE.get('target_pinned')
        locked_at = STATE.get('target_locked_at') or 0
    if pinned:
        return target
    interval = int(settings.get('target_refresh_seconds', 300)) * 1000
    if int(time.time() * 1000) - locked_at < interval:
        return target
    rows = _candidates(settings)
    _set(target_checked_at=int(time.time() * 1000))
    if not rows:
        return target
    best = rows[0]
    current = next((row for row in rows if str(row.get('address') or '').lower() == str(target).lower()), None)
    if str(best.get('address') or '').lower() == str(target).lower():
        _set(target_locked_at=int(time.time() * 1000))
        return target
    if current is None:
        reason = 'адрес больше не проходит фильтры радара'
    else:
        margin = 1 + float(settings.get('target_switch_margin_pct', 20.0)) / 100.0
        if (best.get('total_pnl') or 0) <= (current.get('total_pnl') or 0) * margin:
            # Close enough to keep: switching on noise would churn positions.
            _set(target_locked_at=int(time.time() * 1000))
            return target
        reason = (f'найден сильнее: PnL {best.get("total_pnl")} против {current.get("total_pnl")}')
    _record_decision(target, '-', '-', None, None, None, 'skipped', f'смена цели — {reason}')
    _set(target=best['address'], target_locked_at=int(time.time() * 1000))
    return best['address']


def _tick(settings):
    with STATE_LOCK:
        target = STATE['target']
    if target and settings.get('only_saved_addresses'):
        # Turning the watchlist on mid-run must drop a target that is not on it,
        # otherwise "buys only from these addresses" would not hold until the
        # next restart.
        allowed = saved_addresses()
        if allowed and str(target).lower() not in allowed:
            _record_decision(target, '-', '-', None, None, None, 'skipped',
                             'адрес вне сохранённого списка — слежение снято')
            target = None
            _set(target=None, target_locked_at=0)
    if not target:
        _set(phase='searching')
        row = _pick_target(settings)
        if not row:
            return
        target = row['address']
        _set(target=target, target_locked_at=int(time.time() * 1000), phase='watching',
             target_pinned=False)
    else:
        target = _rotate_target(target, settings)
        _set(phase='watching')
    _follow(target, settings)


def _signals_for(address, settings):
    """Collect every whale entry that is not mirrored yet."""
    hl_request = _hook('hl_request')
    normalize_fill = _hook('normalize_fill')
    now = int(time.time() * 1000)
    signals = []

    # Freshly opened positions from the fill stream.
    lookback = max(60_000, int(settings.get('poll_interval_seconds', 3)) * 20_000)
    raw_fills = hl_request({'type': 'userFillsByTime', 'user': address,
                            'startTime': now - lookback, 'endTime': now})
    for raw in raw_fills or []:
        fill = normalize_fill(raw, address)
        action = fill.get('action')
        coin = str(fill.get('coin') or '').upper()
        key = f'fill:{fill.get("trade_id")}:{fill.get("time")}:{coin}:{action}'
        if action in CLOSE_ACTIONS:
            # Do NOT free the slot here.  Releasing it would drop the record of
            # a position we still hold; _sync_closes confirms the leader is out
            # and then actually closes our copy before releasing.
            _mark_seen(key)
            continue
        if action not in OPEN_ACTIONS:
            continue
        if _seen(key):
            continue
        price = float(fill.get('price') or 0)
        if price <= 0:
            _mark_seen(key)
            continue
        signals.append({
            'key': key, 'coin': coin, 'side': OPEN_ACTIONS[action],
            'whale_price': price, 'source': 'fill', 'time': int(fill.get('time') or now),
        })

    # Positions the whale already holds when we attach.  The operator asked not
    # to wait for the next whale purchase, so an existing entry is a valid
    # signal as long as the price is still inside the tolerance.
    if settings.get('mirror_existing_positions'):
        state = hl_request({'type': 'clearinghouseState', 'user': address})
        for raw in (state or {}).get('assetPositions') or []:
            position = raw.get('position') or {}
            size = float(position.get('szi') or 0)
            entry = float(position.get('entryPx') or 0)
            coin = str(position.get('coin') or '').upper()
            if not size or entry <= 0 or not coin:
                continue
            side = 'BUY' if size > 0 else 'SELL'
            key = f'position:{address}:{coin}:{side}:{entry}'
            if _seen(key):
                continue
            signals.append({
                'key': key, 'coin': coin, 'side': side,
                'whale_price': entry, 'source': 'position', 'time': now,
            })
    return signals


def _leader_positions(address):
    """The leader's live positions keyed by (coin, mirrored side)."""
    state = _hook('hl_request')({'type': 'clearinghouseState', 'user': address})
    live = {}
    for raw in (state or {}).get('assetPositions') or []:
        position = raw.get('position') or {}
        size = float(position.get('szi') or 0)
        coin = str(position.get('coin') or '').upper()
        if not size or not coin:
            continue
        live[(coin, 'BUY' if size > 0 else 'SELL')] = {
            'size': abs(size),
            'entry_price': float(position.get('entryPx') or 0),
            'unrealized_pnl': float(position.get('unrealizedPnl') or 0),
            'position_value': float(position.get('positionValue') or 0),
        }
    return live


def close_mirror(mirror, settings, broker, reason='лидер закрыл позицию'):
    """Close one mirrored position with a reduceOnly order.

    ``limit_chase`` is the default because a plain limit can sit unfilled
    through exactly the fast move you are trying to exit, while a market order
    always pays the spread.  Chase posts at the touch, re-posts if the market
    walks away, and only then falls back to market.
    """
    coin = mirror['coin']
    side = mirror['side']
    qty = float(mirror.get('qty') or 0)
    if not coin or not side or qty <= 0:
        raise TradingError('Нечего закрывать: в зеркале нет объёма')
    exit_side = 'SELL' if side == 'BUY' else 'BUY'
    style = settings.get('close_order_type', 'limit_chase')
    attempts = int(mirror.get('close_attempts') or 0)

    # A resting close order that the market has walked away from is cancelled
    # before a fresh one goes out at the new touch.
    resting = mirror.get('closing_order_id')
    if resting:
        try:
            state = broker.verify_order(coin, resting)
        except TradingError:
            state = {'status': 'unknown'}
        status = str(state.get('status') or '').lower()
        if status in ('filled', 'closed'):
            _release_mirror(mirror['key'])
            _record_decision(mirror.get('address') or '', coin, exit_side, None, None, None,
                             'closed', f'{reason}: закрытие исполнено')
            return {'ok': True, 'filled': True, 'order_id': resting}
        age = (int(time.time() * 1000) - int(mirror.get('closing_since') or 0)) / 1000.0
        if age < float(settings.get('close_chase_seconds', 8)):
            return {'ok': True, 'waiting': True, 'order_id': resting, 'age_seconds': age}
        try:
            broker.cancel_order(coin, resting)
        except TradingError:
            pass
        attempts += 1

    exhausted = attempts >= int(settings.get('close_chase_attempts', 3))
    if style == 'market' or (style == 'limit_chase' and exhausted):
        order_type, price = 'market', broker.price(coin)
        note = 'рыночный ордер' if style == 'market' else f'после {attempts} попыток лимитом — рыночный'
    else:
        price, _book = broker.entry_price(coin, exit_side, settings)
        order_type, note = 'limit', f'лимит по стакану (попытка {attempts + 1})'

    result = broker.place_order(coin, exit_side, None, price, int(settings.get('leverage', 1)),
                                order_type=order_type, reduce_only=True, qty=qty)
    _record_order({
        'created_at': int(time.time() * 1000), 'address': mirror.get('address') or '',
        'coin': coin, 'side': exit_side, 'whale_price': float(mirror.get('entry_price') or 0),
        'market_price': float(result.get('price') or price), 'deviation_pct': 0.0,
        'usd': float(result.get('usd') or 0), 'qty': float(result.get('qty') or qty),
        'price': float(result.get('price') or price), 'venue': broker.name,
        'mode': settings.get('mode', 'dry-run'), 'order_type': order_type,
        'leverage': int(settings.get('leverage', 1)), 'order_id': str(result.get('order_id') or ''),
        'source': 'close', 'status': 'dry-run' if result.get('dry_run') else 'sent', 'error': None,
    })
    _record_decision(mirror.get('address') or '', coin, exit_side, None,
                     float(result.get('price') or price), None, 'closed', f'{reason}: {note}')
    if order_type == 'market' or result.get('dry_run'):
        _release_mirror(mirror['key'])
        return {'ok': True, 'filled': True, 'order_id': result.get('order_id')}
    _update_mirror(mirror['key'], closing_order_id=str(result.get('order_id') or ''),
                   closing_since=int(time.time() * 1000), close_attempts=attempts)
    return {'ok': True, 'resting': True, 'order_id': result.get('order_id')}


def _sync_closes(settings, broker):
    """Close our copies once each mirror's own leader is confirmed out.

    Every mirror is checked against the address it was copied from, not against
    whoever the follower happens to be watching now.  Following only the current
    target would strand a position whenever the target changes — the radar picks
    a different whale after a restart, or the operator pins a new one — leaving
    real money open with nothing left to close it, and permanently consuming a
    ``max_open_positions`` slot.
    """
    if not settings.get('auto_close', True):
        return
    open_mirrors = [row for row in mirrors() if row.get('coin')]
    if not open_mirrors:
        return
    by_leader = {}
    for row in open_mirrors:
        by_leader.setdefault(row.get('address') or '', []).append(row)
    for leader, group in by_leader.items():
        if not leader:
            continue
        try:
            live = _leader_positions(leader)
        except Exception as error:  # noqa: BLE001
            # Never treat an unreadable leader as "position closed"; one bad
            # address must not stop the others from being synced either.
            _set(last_error=f'автозакрытие {leader[:10]}…: {error}')
            continue
        _sync_leader_closes(leader, group, live, settings, broker)


def _sync_leader_closes(address, open_mirrors, live, settings, broker):
    needed = int(settings.get('close_confirmations', 2))
    shrink_limit = float(settings.get('close_on_shrink_pct', 0.0))
    for mirror in open_mirrors:
        key = (mirror['coin'], mirror['side'])
        position = live.get(key)
        gone = position is None
        if position is not None and shrink_limit > 0:
            baseline = float(mirror.get('leader_size') or 0)
            if baseline <= 0:
                # First sighting sets the reference size; shrink is measured
                # against it from here on.
                _update_mirror(mirror['key'], leader_size=position['size'])
            elif position['size'] < baseline * (1 - shrink_limit / 100.0):
                gone = True
        if mirror.get('closing_order_id'):
            # A close is already in flight: keep chasing it to completion.
            try:
                close_mirror(mirror, settings, broker)
            except TradingError as error:
                _record_decision(address, mirror['coin'], mirror['side'], None, None, None,
                                 'failed', f'закрытие не удалось: {error}')
            continue
        if not gone:
            if mirror.get('close_checks'):
                _update_mirror(mirror['key'], close_checks=0)
            continue
        checks = int(mirror.get('close_checks') or 0) + 1
        _update_mirror(mirror['key'], close_checks=checks)
        if checks < needed:
            # Two agreeing polls, so one missing snapshot cannot close a live
            # position by mistake.
            continue
        try:
            mirror['close_checks'] = checks
            close_mirror(mirror, settings, broker)
        except TradingError as error:
            _record_decision(address, mirror['coin'], mirror['side'], None, None, None,
                             'failed', f'закрытие не удалось: {error}')


def close_all(address=None, reason='ручное закрытие'):
    """Close every mirrored position now, regardless of the leader."""
    settings = trading.load_settings()
    broker = trading.build_broker(settings)
    ok, why = broker.ready()
    if not ok:
        raise TradingError(why)
    results = []
    for mirror in mirrors(address):
        if not mirror.get('coin'):
            continue
        try:
            results.append({'coin': mirror['coin'], 'side': mirror['side'],
                            **close_mirror(mirror, settings, broker, reason=reason)})
        except TradingError as error:
            results.append({'coin': mirror['coin'], 'side': mirror['side'],
                            'ok': False, 'error': str(error)})
    return results


def close_one(coin, side, address=None):
    """Close a single mirrored position on demand."""
    settings = trading.load_settings()
    broker = trading.build_broker(settings)
    ok, why = broker.ready()
    if not ok:
        raise TradingError(why)
    coin = str(coin or '').strip().upper()
    side = str(side or '').strip().upper()
    if side not in ('BUY', 'SELL'):
        raise TradingError('Сторона должна быть BUY или SELL')
    for mirror in mirrors(address):
        if mirror.get('coin') == coin and mirror.get('side') == side:
            return close_mirror(mirror, settings, broker, reason='ручное закрытие')
    raise TradingError(f'Нет скопированной позиции {coin} {side}')


def whale_open_orders(address):
    """The target's resting orders — public data, useful as an early warning
    that a position is about to be opened."""
    rows = _hook('hl_request')({'type': 'openOrders', 'user': _validate_address(address)})
    orders = []
    for row in rows or []:
        try:
            orders.append({
                'coin': str(row.get('coin') or '').upper(),
                'side': 'BUY' if row.get('side') == 'B' else 'SELL',
                'price': float(row.get('limitPx') or 0),
                'size': float(row.get('sz') or 0),
                'order_id': row.get('oid'),
                'time': int(row.get('timestamp') or 0),
            })
        except (TypeError, ValueError):
            continue
    orders.sort(key=lambda item: item['time'], reverse=True)
    return orders


def _follow(address, settings):
    broker = trading.build_broker(settings)
    # Exits first: a leader who has already left the trade must not have their
    # stale entry re-evaluated as a fresh signal in the same tick.  This covers
    # every mirror we hold, including ones copied from a previous target.
    try:
        _sync_closes(settings, broker)
    except TradingError as error:
        _set(last_error=f'автозакрытие: {error}')
    follow_coins = [str(coin).upper() for coin in settings.get('follow_coins') or []]
    direction = settings.get('follow_direction', 'both')
    tolerance = float(settings.get('max_deviation_pct', 0.5))
    signals = _signals_for(address, settings)
    # One bulk price call for every coin in this tick, instead of one request
    # per signal.  On Hyperliquid a single allMids covers the whole universe.
    try:
        quotes = broker.prices({signal['coin'] for signal in signals}) if signals else {}
    except TradingError:
        quotes = {}
    for signal in signals:
        coin = signal['coin']
        side = signal['side']
        with STATE_LOCK:
            STATE['checked_signals'] += 1
        if follow_coins and coin not in follow_coins:
            _mark_seen(signal['key'])
            _record_decision(address, coin, side, signal['whale_price'], None, None,
                             'skipped', f'монета {coin} вне списка follow_coins')
            continue
        if (direction == 'long_only' and side != 'BUY') or (direction == 'short_only' and side != 'SELL'):
            _mark_seen(signal['key'])
            _record_decision(address, coin, side, signal['whale_price'], None, None,
                             'skipped', f'сторона {side} отключена настройкой follow_direction={direction}')
            continue
        if _orders_last_hour() >= int(settings.get('max_orders_per_hour', 20)):
            _record_decision(address, coin, side, signal['whale_price'], None, None,
                             'skipped', 'достигнут лимит ордеров в час')
            return
        mirror_key = f'{address}:{coin}:{side}'
        if _blocked_after_failure(address, coin, side):
            _record_decision(address, coin, side, signal['whale_price'], None, None,
                             'skipped', 'пауза после неудачных ордеров')
            continue
        market = quotes.get(coin)
        if not market:
            try:
                market = broker.price(coin)
            except TradingError as error:
                _record_decision(address, coin, side, signal['whale_price'], None, None,
                                 'skipped', f'нет цены: {error}')
                continue
        whale_price = signal['whale_price']
        deviation = abs(market - whale_price) / whale_price * 100
        if deviation > tolerance:
            # Not marked as seen: the price may come back inside the window
            # before the whale closes, and then the entry is still valid.
            with STATE_LOCK:
                STATE['orders_skipped'] += 1
            _record_decision(address, coin, side, whale_price, market, deviation,
                             'skipped', f'отклонение {deviation:.3f}% > {tolerance:.3f}%')
            continue
        if _open_mirror_count() >= int(settings.get('max_open_positions', 3)):
            _record_decision(address, coin, side, whale_price, market, deviation,
                             'skipped', 'достигнут лимит открытых позиций')
            continue
        if not _claim_mirror(mirror_key, address=address, coin=coin, side=side, venue=broker.name):
            _mark_seen(signal['key'])
            _record_decision(address, coin, side, whale_price, market, deviation,
                             'skipped', 'позиция по этой монете и стороне уже скопирована')
            continue
        try:
            result = execute(
                coin=coin, side=side, usd=float(settings.get('order_usd', 100.0)),
                whale_price=whale_price, market_price=market, deviation=deviation,
                address=address, settings=settings, broker=broker, source=signal['source'],
                enforce_tolerance=tolerance)
            _mark_seen(signal['key'])
            # Remember what we actually got filled for: closing needs the exact
            # quantity, not the dollar figure that was requested.
            _clear_failure(address, coin, side)
            _update_mirror(mirror_key, qty=float(result.get('qty') or 0),
                           entry_price=float(result.get('price') or market))
            with STATE_LOCK:
                STATE['orders_sent'] += 1
            _record_decision(address, coin, side, whale_price, market, deviation,
                             'executed', f'ордер {result.get("order_id")} отправлен')
        except TradingError as error:
            _release_mirror(mirror_key)
            delay = _note_failure(address, coin, side)
            _record_decision(address, coin, side, whale_price, market, deviation,
                             'failed', f'{error} (следующая попытка через {int(delay)} с)')


def execute(coin, side, usd, whale_price, market_price, deviation, address, settings,
            broker=None, source='manual', enforce_tolerance=None):
    """Place one order and persist the outcome (including failures)."""
    settings = settings or trading.load_settings()
    broker = broker or trading.build_broker(settings)
    order_type = settings.get('order_type', 'limit')
    leverage = int(settings.get('leverage', 1))
    offset = float(settings.get('limit_offset_pct', 0.0)) / 100.0
    book = None
    if order_type == 'limit':
        # Price against the resting side of the book so the order matches at
        # once, then apply the operator's offset.
        base_price, book = broker.entry_price(coin, side, settings)
        price = base_price * (1 + offset) if side == 'BUY' else base_price * (1 - offset)
    else:
        price = market_price
    if enforce_tolerance is not None and whale_price:
        # The tolerance was screened against the mid price, but the order goes
        # out at the touch (plus any offset).  Across a wide spread those differ,
        # so the rule is re-checked against the price actually being sent —
        # otherwise "no more than X% from the whale's entry" is only approximate.
        actual = abs(price - whale_price) / whale_price * 100
        if actual > enforce_tolerance:
            raise TradingError(
                f'Цена исполнения {price:.6f} даёт отклонение {actual:.3f}% '
                f'> {enforce_tolerance:.3f}% (по средней цене было {deviation:.3f}%)')
    risk = trading.check_risk(broker, usd, settings)
    row = {
        'created_at': int(time.time() * 1000), 'address': address, 'coin': coin, 'side': side,
        'whale_price': whale_price, 'market_price': market_price, 'deviation_pct': deviation,
        'usd': usd, 'qty': 0.0, 'price': price, 'venue': broker.name,
        'mode': settings.get('mode', 'dry-run'), 'order_type': order_type, 'leverage': leverage,
        'source': source, 'status': 'pending', 'error': None,
    }
    try:
        result = broker.place_order(coin, side, usd, price, leverage, order_type=order_type)
    except TradingError as error:
        row.update({'status': 'failed', 'error': str(error)})
        _record_order(row)
        raise
    row.update({
        'qty': float(result.get('qty') or 0), 'price': float(result.get('price') or price),
        'order_id': str(result.get('order_id') or ''),
        'status': 'dry-run' if result.get('dry_run') else 'sent',
    })
    if settings.get('verify_fills') and not result.get('dry_run') and row['order_id']:
        try:
            result['fill'] = broker.verify_order(coin, row['order_id'])
            row['status'] = f'sent · {result["fill"].get("status")}'
        except TradingError as error:
            result['fill'] = {'status': 'unverified', 'error': str(error)}
    result['risk'] = risk
    if book:
        result['book'] = book
    row['id'] = _record_order(row)
    result['record'] = row
    return result


def manual_buy(address, coin, usd, side='BUY'):
    """Buy the coin a chosen address is in, using the configured order type."""
    settings = trading.load_settings()
    broker = trading.build_broker(settings)
    ok, reason = broker.ready()
    if not ok:
        raise TradingError(reason)
    address = _validate_address(address)
    coin = str(coin or '').strip().upper()
    if not coin:
        raise TradingError('Не указана монета')
    side = str(side or 'BUY').strip().upper()
    if side not in ('BUY', 'SELL'):
        raise TradingError('Сторона должна быть BUY или SELL')
    try:
        usd = float(usd)
    except (TypeError, ValueError):
        raise TradingError('Некорректная сумма покупки')
    if usd <= 0:
        raise TradingError('Сумма покупки должна быть больше нуля')
    market = broker.price(coin)
    whale_price = market
    deviation = 0.0
    state = _hook('hl_request')({'type': 'clearinghouseState', 'user': address})
    for raw in (state or {}).get('assetPositions') or []:
        position = raw.get('position') or {}
        if str(position.get('coin') or '').upper() != coin:
            continue
        entry = float(position.get('entryPx') or 0)
        if entry > 0:
            whale_price = entry
            deviation = abs(market - entry) / entry * 100
        break
    return execute(coin=coin, side=side, usd=usd, whale_price=whale_price, market_price=market,
                   deviation=deviation, address=address, settings=settings, broker=broker,
                   source='manual')

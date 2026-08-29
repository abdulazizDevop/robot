#!/usr/bin/env python3
"""Execution layer for the radar.

The radar itself stays read-only: it discovers whales from public Hyperliquid
data and never needs a key.  This module is the only place that can place an
order, and it refuses to do so unless the operator explicitly leaves
``dry-run``.

Three modes:
  dry-run   no credentials, no network write.  Orders are priced against the
            public market and recorded locally, so the whole pipeline can be
            verified without an API key.
  testnet   real signed orders against the exchange testnet.
  live      real signed orders against mainnet.
"""
import hashlib
import hmac
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('DATA_DIR', '').strip() or os.path.join(ROOT, 'data')
SETTINGS_PATH = os.path.join(DATA_DIR, 'trading_settings.json')
SETTINGS_LOCK = threading.Lock()

USER_AGENT = 'LiquidationRadar/1.0'

# The operator asked for 1x derivatives with limit orders.  These are the
# defaults; every one of them is editable from the settings panel.
DEFAULT_SETTINGS = {
    'venue': 'hyperliquid',        # 'hyperliquid' | 'bybit'
    'mode': 'dry-run',             # 'dry-run' | 'testnet' | 'live'
    'leverage': 1,
    'order_type': 'limit',         # 'limit' | 'market'
    'max_deviation_pct': 0.5,      # whale entry vs current price
    'order_usd': 100.0,            # notional per auto trade
    'limit_offset_pct': 0.0,       # limit price offset from current price
    'poll_interval_seconds': 3,
    'max_open_positions': 3,
    'max_orders_per_hour': 20,
    'mirror_existing_positions': True,
    'follow_coins': [],            # empty = every coin the whale trades
    'follow_direction': 'both',    # 'both' | 'long_only' | 'short_only'
    'limit_pricing': 'book',       # 'book' = cross the spread, 'mid' = rest inside it
    'max_account_risk_pct': 25.0,  # ceiling on notional as a share of equity
    'min_free_balance_usd': 0.0,   # never spend the account below this
    'verify_fills': True,
    # --- closing with the leader ---
    'auto_close': True,            # close our copy when the whale closes theirs
    'close_confirmations': 2,      # consecutive polls that must agree before closing
    'close_order_type': 'limit_chase',  # 'market' | 'limit' | 'limit_chase'
    'close_chase_seconds': 8,      # how long an unfilled close order may rest
    'close_chase_attempts': 3,     # re-posts before falling back to market
    'close_on_shrink_pct': 0.0,    # >0: also close when the whale cuts size by this %
    # When on, the follower ignores whatever the radar ranks highest and only
    # ever locks onto an address from the saved list.
    'only_saved_addresses': False,
    # An auto-selected target is reconsidered on this interval.  Without it the
    # engine stays on the first whale it ever locked onto, however quiet that
    # wallet goes or however much better a later candidate is.  A target pinned
    # by hand is never rotated.
    'target_refresh_seconds': 300,
    # A new candidate has to beat the current one by this much to take over, so
    # near-equal wallets do not make the follower flap between them.
    'target_switch_margin_pct': 20.0,
}

_SETTING_TYPES = {
    'venue': ('choice', ('hyperliquid', 'bybit')),
    'mode': ('choice', ('dry-run', 'testnet', 'live')),
    'order_type': ('choice', ('limit', 'market')),
    'leverage': ('int', 1, 50),
    'max_deviation_pct': ('float', 0.0, 100.0),
    'order_usd': ('float', 1.0, 1_000_000.0),
    'limit_offset_pct': ('float', -5.0, 5.0),
    'poll_interval_seconds': ('int', 1, 300),
    'max_open_positions': ('int', 1, 50),
    'max_orders_per_hour': ('int', 1, 1000),
    'mirror_existing_positions': ('bool',),
    'follow_coins': ('coins',),
    'follow_direction': ('choice', ('both', 'long_only', 'short_only')),
    'limit_pricing': ('choice', ('book', 'mid')),
    'max_account_risk_pct': ('float', 0.0, 100.0),
    'min_free_balance_usd': ('float', 0.0, 1_000_000.0),
    'verify_fills': ('bool',),
    'auto_close': ('bool',),
    'close_confirmations': ('int', 1, 10),
    'close_order_type': ('choice', ('market', 'limit', 'limit_chase')),
    'close_chase_seconds': ('int', 1, 120),
    'close_chase_attempts': ('int', 1, 10),
    'close_on_shrink_pct': ('float', 0.0, 100.0),
    'only_saved_addresses': ('bool',),
    'target_refresh_seconds': ('int', 30, 86_400),
    'target_switch_margin_pct': ('float', 0.0, 1000.0),
}


class TradingError(RuntimeError):
    """Raised for any condition that must stop an order from being sent."""


# ---------------------------------------------------------------- settings

def _coerce(key, value):
    spec = _SETTING_TYPES.get(key)
    if not spec:
        raise TradingError(f'Неизвестная настройка: {key}')
    kind = spec[0]
    if kind == 'choice':
        text = str(value).strip().lower()
        if text not in spec[1]:
            raise TradingError(f'{key}: допустимые значения {", ".join(spec[1])}')
        return text
    if kind == 'bool':
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ('1', 'true', 'yes', 'on')
    if kind == 'int':
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            raise TradingError(f'{key}: ожидается целое число')
        if not spec[1] <= number <= spec[2]:
            raise TradingError(f'{key}: допустимо от {spec[1]} до {spec[2]}')
        return number
    if kind == 'float':
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise TradingError(f'{key}: ожидается число')
        if not math.isfinite(number):
            raise TradingError(f'{key}: некорректное число')
        if not spec[1] <= number <= spec[2]:
            raise TradingError(f'{key}: допустимо от {spec[1]} до {spec[2]}')
        return number
    if kind == 'coins':
        if isinstance(value, str):
            value = value.replace(';', ',').split(',')
        coins = []
        for item in value or []:
            name = str(item).strip().upper()
            if name and re.fullmatch(r'[A-Z0-9@_-]{1,24}', name) and name not in coins:
                coins.append(name)
        return coins
    raise TradingError(f'Неизвестный тип настройки: {key}')


def load_settings():
    with SETTINGS_LOCK:
        return _load_settings_unlocked()


def _load_settings_unlocked():
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, encoding='utf-8') as handle:
            stored = json.load(handle)
    except (OSError, ValueError, TypeError):
        stored = {}
    if isinstance(stored, dict):
        for key, value in stored.items():
            if key in DEFAULT_SETTINGS:
                try:
                    settings[key] = _coerce(key, value)
                except TradingError:
                    # A corrupt field must not make the whole panel unusable.
                    settings[key] = DEFAULT_SETTINGS[key]
    return settings


def save_settings(updates):
    """Validate and merge a partial settings update, then persist atomically."""
    if not isinstance(updates, dict):
        raise TradingError('Ожидается объект настроек')
    clean = {key: _coerce(key, value) for key, value in updates.items() if key in DEFAULT_SETTINGS}
    unknown = [key for key in updates if key not in DEFAULT_SETTINGS]
    if unknown:
        raise TradingError('Неизвестные настройки: ' + ', '.join(sorted(unknown)))
    with SETTINGS_LOCK:
        settings = _load_settings_unlocked()
        settings.update(clean)
        temporary = SETTINGS_PATH + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, SETTINGS_PATH)
        return settings


# ------------------------------------------------------------------ http

# Read paths share one cache and one per-host pacer.  Without this the follower
# asked Hyperliquid for allMids once per coin on every poll — a few requests a
# second, forever, which ends in a 429 ban on a long-running deployment.
_RATE_LOCK = threading.Lock()
_READ_CACHE = {}
_READ_CACHE_MAX = 256
_HOST_NEXT_AT = {}
_HOST_MIN_INTERVAL = {'api.hyperliquid.xyz': 0.15, 'api.hyperliquid-testnet.xyz': 0.15}
_HOST_DEFAULT_INTERVAL = 0.05


def _pace(url):
    """Block just long enough to keep under a host's request rate."""
    host = urllib.parse.urlparse(url).hostname or ''
    interval = _HOST_MIN_INTERVAL.get(host, _HOST_DEFAULT_INTERVAL)
    with _RATE_LOCK:
        now = time.monotonic()
        earliest = _HOST_NEXT_AT.get(host, 0.0)
        wait = max(0.0, earliest - now)
        _HOST_NEXT_AT[host] = max(now, earliest) + interval
    if wait:
        time.sleep(wait)


def _cached_json(url, data=None, headers=None, timeout=15, ttl=0.0, key=None):
    """A read-only request that may be served from a short-lived cache.

    Only used for public market data.  Signed/private calls never pass through
    here, so an order is never answered from a stale response.
    """
    cache_key = key or (url, data)
    if ttl > 0:
        with _RATE_LOCK:
            hit = _READ_CACHE.get(cache_key)
            if hit and time.monotonic() - hit['at'] < ttl:
                return hit['value']
    value = _http_json(url, data=data, headers=headers, timeout=timeout)
    if ttl > 0:
        with _RATE_LOCK:
            if len(_READ_CACHE) >= _READ_CACHE_MAX:
                # Bounded: drop the oldest half rather than growing forever.
                for stale in sorted(_READ_CACHE, key=lambda k: _READ_CACHE[k]['at'])[:_READ_CACHE_MAX // 2]:
                    _READ_CACHE.pop(stale, None)
            _READ_CACHE[cache_key] = {'at': time.monotonic(), 'value': value}
    return value


def _http_json(url, data=None, headers=None, timeout=15):
    _pace(url)
    request = urllib.request.Request(
        url,
        data=data,
        headers={'User-Agent': USER_AGENT, 'Accept': 'application/json', **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        body = ''
        try:
            body = error.read().decode('utf-8', 'replace')[:400]
        except Exception:  # noqa: BLE001 - diagnostics only
            pass
        raise TradingError(f'HTTP {error.code}: {body or error.reason}') from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise TradingError(f'Сеть недоступна: {getattr(error, "reason", error)}') from error
    except ValueError as error:
        raise TradingError('Некорректный JSON от биржи') from error


# ---------------------------------------------------------------- brokers

class Broker:
    """Common surface every venue implements."""

    name = 'base'

    def __init__(self, mode):
        self.mode = mode

    @property
    def dry_run(self):
        return self.mode == 'dry-run'

    @property
    def testnet(self):
        return self.mode == 'testnet'

    def ready(self):
        """Return (ok, reason).  Never raises."""
        raise NotImplementedError

    def price(self, coin):
        raise NotImplementedError

    def prices(self, coins):
        """Price several coins at once.  Venues override this with a single
        bulk call; the fallback keeps the interface usable."""
        result = {}
        for coin in coins:
            try:
                result[str(coin).strip().upper()] = self.price(coin)
            except TradingError:
                continue
        return result

    def book(self, coin):
        """Return {'bid': best bid, 'ask': best ask, 'mid': midpoint}."""
        raise NotImplementedError

    def place_order(self, coin, side, usd, price, leverage, order_type='limit',
                    reduce_only=False, qty=None):
        raise NotImplementedError

    def verify_order(self, coin, order_id):
        """Report what actually happened to a submitted order."""
        raise NotImplementedError

    def cancel_order(self, coin, order_id):
        """Withdraw a resting order. Used when a close order has to be
        re-priced because the market moved away from it."""
        raise NotImplementedError

    def positions(self):
        raise NotImplementedError

    def balance(self):
        raise NotImplementedError

    def entry_price(self, coin, side, settings):
        """Price a new entry off the book so a limit order matches immediately.

        A buy posted at the best ask (and a sell at the best bid) crosses the
        spread and fills against the resting side, which is what "enter now"
        has to mean.  ``mid`` pricing is available for operators who would
        rather rest inside the spread and wait.
        """
        pricing = (settings or {}).get('limit_pricing', 'book')
        if pricing != 'book':
            return self.price(coin), None
        try:
            book = self.book(coin)
        except TradingError:
            return self.price(coin), None
        chosen = book['ask'] if side == 'BUY' else book['bid']
        if not chosen or chosen <= 0:
            return self.price(coin), book
        return chosen, book


# ------------------------------------------------------------- bybit

class BybitBroker(Broker):
    """Bybit v5 linear USDT perpetuals, signed with HMAC SHA256."""

    name = 'bybit'
    RECV_WINDOW = '5000'

    def __init__(self, mode):
        super().__init__(mode)
        self._instrument_cache = {}
        self._hedge_cache = {}
        self._instrument_lock = threading.Lock()

    # -- plumbing -------------------------------------------------

    @property
    def base(self):
        return 'https://api-testnet.bybit.com' if self.testnet else 'https://api.bybit.com'

    def _credentials(self):
        key = os.environ.get('BYBIT_API_KEY', '').strip()
        secret = os.environ.get('BYBIT_API_SECRET', '').strip()
        return key, secret

    def _signed(self, method, path, payload):
        key, secret = self._credentials()
        if not key or not secret:
            raise TradingError('Bybit: не заданы BYBIT_API_KEY и BYBIT_API_SECRET')
        timestamp = str(int(time.time() * 1000))
        if method == 'GET':
            query = urllib.parse.urlencode(payload)
            origin = timestamp + key + self.RECV_WINDOW + query
            url = f'{self.base}{path}' + (f'?{query}' if query else '')
            body = None
        else:
            raw = json.dumps(payload, separators=(',', ':'))
            origin = timestamp + key + self.RECV_WINDOW + raw
            url = f'{self.base}{path}'
            body = raw.encode()
        sign = hmac.new(secret.encode(), origin.encode(), hashlib.sha256).hexdigest()
        headers = {
            'X-BAPI-API-KEY': key,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': self.RECV_WINDOW,
            'X-BAPI-SIGN': sign,
            'Content-Type': 'application/json',
        }
        result = _http_json(url, data=body, headers=headers)
        code = result.get('retCode')
        if code != 0:
            raise TradingError(f'Bybit {code}: {result.get("retMsg") or "ошибка"}')
        return result.get('result') or {}

    # -- public ---------------------------------------------------

    @staticmethod
    def symbol_for(coin):
        return str(coin).strip().upper() + 'USDT'

    def instrument(self, coin):
        symbol = self.symbol_for(coin)
        with self._instrument_lock:
            cached = self._instrument_cache.get(symbol)
            if cached and time.time() - cached['time'] < 3600:
                return cached['data']
        url = f'{self.base}/v5/market/instruments-info?' + urllib.parse.urlencode(
            {'category': 'linear', 'symbol': symbol})
        payload = _cached_json(url, ttl=3600.0)
        rows = (payload.get('result') or {}).get('list') or []
        if not rows:
            raise TradingError(f'Bybit: контракт {symbol} не найден')
        row = rows[0]
        lot = row.get('lotSizeFilter') or {}
        price_filter = row.get('priceFilter') or {}
        data = {
            'symbol': symbol,
            'qty_step': float(lot.get('qtyStep') or 0) or 0.001,
            'min_qty': float(lot.get('minOrderQty') or 0),
            'max_qty': float(lot.get('maxOrderQty') or 0) or float('inf'),
            'tick_size': float(price_filter.get('tickSize') or 0) or 0.01,
            'max_leverage': float((row.get('leverageFilter') or {}).get('maxLeverage') or 100),
        }
        with self._instrument_lock:
            self._instrument_cache[symbol] = {'time': time.time(), 'data': data}
        return data

    def ready(self):
        if self.dry_run:
            return True, 'dry-run: ключи не нужны'
        key, secret = self._credentials()
        if not key or not secret:
            return False, 'Bybit: не заданы BYBIT_API_KEY и BYBIT_API_SECRET'
        try:
            self._signed('GET', '/v5/account/wallet-balance', {'accountType': 'UNIFIED'})
            return True, f'Bybit {"testnet" if self.testnet else "mainnet"}: подключение подтверждено'
        except TradingError as error:
            return False, str(error)

    def prices(self, coins):
        """One tickers call covers every linear symbol, so N coins cost one
        request instead of N."""
        url = f'{self.base}/v5/market/tickers?category=linear'
        payload = _cached_json(url, ttl=2.0)
        rows = (payload.get('result') or {}).get('list') or []
        wanted = {self.symbol_for(coin): str(coin).strip().upper() for coin in coins}
        result = {}
        for row in rows:
            coin = wanted.get(str(row.get('symbol') or ''))
            if not coin:
                continue
            for field in ('lastPrice', 'markPrice', 'indexPrice'):
                try:
                    value = float(row.get(field) or 0)
                except (TypeError, ValueError):
                    continue
                if value > 0:
                    result[coin] = value
                    break
        return result

    def price(self, coin):
        symbol = self.symbol_for(coin)
        url = f'{self.base}/v5/market/tickers?' + urllib.parse.urlencode(
            {'category': 'linear', 'symbol': symbol})
        payload = _cached_json(url, ttl=2.0)
        rows = (payload.get('result') or {}).get('list') or []
        if not rows:
            raise TradingError(f'Bybit: нет цены для {symbol}')
        row = rows[0]
        for field in ('lastPrice', 'markPrice', 'indexPrice'):
            try:
                value = float(row.get(field) or 0)
            except (TypeError, ValueError):
                continue
            if value > 0:
                return value
        raise TradingError(f'Bybit: некорректная цена для {symbol}')

    def book(self, coin):
        symbol = self.symbol_for(coin)
        url = f'{self.base}/v5/market/orderbook?' + urllib.parse.urlencode(
            {'category': 'linear', 'symbol': symbol, 'limit': 1})
        payload = _cached_json(url, ttl=1.0)
        result = payload.get('result') or {}
        bids = result.get('b') or []
        asks = result.get('a') or []
        if not bids or not asks:
            raise TradingError(f'Bybit: пустой стакан для {symbol}')
        bid = float(bids[0][0])
        ask = float(asks[0][0])
        return {'bid': bid, 'ask': ask, 'mid': (bid + ask) / 2}

    def verify_order(self, coin, order_id):
        if self.dry_run or not order_id:
            return {'status': 'dry-run', 'filled_qty': 0.0}
        result = self._signed('GET', '/v5/order/realtime', {
            'category': 'linear', 'symbol': self.symbol_for(coin), 'orderId': str(order_id)})
        rows = result.get('list') or []
        if not rows:
            return {'status': 'unknown', 'filled_qty': 0.0}
        row = rows[0]
        return {
            'status': row.get('orderStatus'),
            'filled_qty': float(row.get('cumExecQty') or 0),
            'avg_price': float(row.get('avgPrice') or 0),
            'leaves_qty': float(row.get('leavesQty') or 0),
        }

    def cancel_order(self, coin, order_id):
        if self.dry_run or not order_id:
            return {'ok': True, 'dry_run': True}
        self._signed('POST', '/v5/order/cancel', {
            'category': 'linear', 'symbol': self.symbol_for(coin), 'orderId': str(order_id)})
        return {'ok': True}

    def hedge_mode(self, coin):
        """True when the account keeps long and short legs separately.

        Bybit rejects an order whose positionIdx does not match the account's
        position mode, so this cannot be assumed: a one-way account needs 0 (or
        the field omitted) and a hedge account needs 1/2.  The mode is a per
        symbol account setting that rarely changes, so it is cached.
        """
        symbol = self.symbol_for(coin)
        with self._instrument_lock:
            cached = self._hedge_cache.get(symbol)
            if cached and time.time() - cached['time'] < 3600:
                return cached['hedge']
        try:
            result = self._signed('GET', '/v5/position/list',
                                  {'category': 'linear', 'symbol': symbol})
        except TradingError:
            return None  # unknown: send no positionIdx rather than a wrong one
        indexes = {str(row.get('positionIdx')) for row in (result.get('list') or [])}
        hedge = bool(indexes - {'0'})
        with self._instrument_lock:
            self._hedge_cache[symbol] = {'time': time.time(), 'hedge': hedge}
        return hedge

    def position_index(self, coin, side, reduce_only):
        """positionIdx for this order, or None when the field must be omitted.

        In hedge mode the index identifies the *leg*, not the order side, so a
        close carries the index of the position it reduces: selling to close a
        long is still index 1.
        """
        if self.dry_run:
            return None
        hedge = self.hedge_mode(coin)
        if not hedge:
            return None
        long_leg = (side == 'BUY') != bool(reduce_only)
        return 1 if long_leg else 2

    def set_leverage(self, coin, leverage):
        if self.dry_run:
            return
        symbol = self.symbol_for(coin)
        try:
            self._signed('POST', '/v5/position/set-leverage', {
                'category': 'linear', 'symbol': symbol,
                'buyLeverage': str(leverage), 'sellLeverage': str(leverage),
            })
        except TradingError as error:
            # 110043 = leverage already set to the requested value.
            if '110043' not in str(error):
                raise

    def place_order(self, coin, side, usd, price, leverage, order_type='limit', reduce_only=False, qty=None):
        instrument = self.instrument(coin)
        step = instrument['qty_step']
        # Entries are sized in dollars; closes are sized in coins, because the
        # exact position quantity is what has to be reduced.
        qty = _floor_step(qty if qty is not None else usd / price, step)
        if usd is None:
            usd = qty * price
        if qty <= 0 or qty < instrument['min_qty']:
            raise TradingError(
                f'Bybit: объём ${usd:,.2f} меньше минимального лота '
                f'{instrument["min_qty"]} {coin} (≈${instrument["min_qty"] * price:,.2f})')
        if qty > instrument['max_qty']:
            raise TradingError(f'Bybit: объём превышает максимальный лот {instrument["max_qty"]}')
        limit_price = _round_step(price, instrument['tick_size'])
        body = {
            'category': 'linear',
            'symbol': instrument['symbol'],
            'side': 'Buy' if side == 'BUY' else 'Sell',
            'orderType': 'Limit' if order_type == 'limit' else 'Market',
            'qty': _format_step(qty, step),
        }
        if order_type == 'limit':
            body['price'] = _format_step(limit_price, instrument['tick_size'])
            body['timeInForce'] = 'GTC'
        if reduce_only:
            body['reduceOnly'] = True
        index = self.position_index(coin, side, reduce_only)
        if index is not None:
            body['positionIdx'] = index
        payload = _order_payload(self.name, instrument['symbol'], coin, side, qty, limit_price,
                                 usd, order_type, leverage)
        if self.dry_run:
            payload.update({'dry_run': True, 'order_id': f'dry-{int(time.time() * 1000)}'})
            return payload
        if not reduce_only:
            # Leverage applies to opening a position.  Bybit rejects a leverage
            # change while a position is open, so doing this before a close
            # would be the one thing able to block an exit.
            self.set_leverage(coin, leverage)
        result = self._signed('POST', '/v5/order/create', body)
        payload.update({'dry_run': False, 'order_id': result.get('orderId'), 'raw': result})
        return payload

    def positions(self):
        if self.dry_run:
            return []
        result = self._signed('GET', '/v5/position/list', {'category': 'linear', 'settleCoin': 'USDT'})
        rows = []
        for item in result.get('list') or []:
            size = float(item.get('size') or 0)
            if not size:
                continue
            rows.append({
                'coin': re.sub(r'USDT$', '', str(item.get('symbol') or '')),
                'side': 'LONG' if str(item.get('side')) == 'Buy' else 'SHORT',
                'size': size,
                'entry_price': float(item.get('avgPrice') or 0),
                'unrealized_pnl': float(item.get('unrealisedPnl') or 0),
                'leverage': float(item.get('leverage') or 0),
            })
        return rows

    def balance(self):
        if self.dry_run:
            return {'account_value': None, 'available': None, 'dry_run': True}
        result = self._signed('GET', '/v5/account/wallet-balance', {'accountType': 'UNIFIED'})
        rows = result.get('list') or []
        if not rows:
            return {'account_value': 0.0, 'available': 0.0}
        row = rows[0]
        return {
            'account_value': float(row.get('totalEquity') or 0),
            'available': float(row.get('totalAvailableBalance') or 0),
        }


# -------------------------------------------------------- hyperliquid

class HyperliquidBroker(Broker):
    """Hyperliquid perpetuals.

    Reading stays on the public Info API (no key).  Signing an order needs the
    official SDK plus a wallet key, so the import is deferred: dry-run works on
    a plain stdlib install and only live/testnet requires the dependency.
    """

    name = 'hyperliquid'

    def __init__(self, mode):
        super().__init__(mode)
        self._meta_cache = None
        self._meta_time = 0.0
        self._meta_lock = threading.Lock()
        self._exchange = None

    @property
    def api_url(self):
        return ('https://api.hyperliquid-testnet.xyz' if self.testnet
                else 'https://api.hyperliquid.xyz')

    def _info(self, body, ttl=0.0):
        payload = json.dumps(body).encode()
        return _cached_json(
            self.api_url + '/info',
            data=payload,
            headers={'Content-Type': 'application/json'},
            ttl=ttl,
            key=(self.api_url, payload),
        )

    def all_mids(self):
        """One request returns every mid price, so pricing N coins costs one
        call rather than N."""
        mids = self._info({'type': 'allMids'}, ttl=2.0)
        if not isinstance(mids, dict):
            raise TradingError('Hyperliquid: некорректный ответ allMids')
        return mids

    def meta(self):
        with self._meta_lock:
            if self._meta_cache and time.time() - self._meta_time < 3600:
                return self._meta_cache
        payload = self._info({'type': 'meta'})
        universe = {}
        for index, item in enumerate(payload.get('universe') or []):
            name = str(item.get('name') or '').upper()
            if not name:
                continue
            universe[name] = {
                'asset': index,
                'sz_decimals': int(item.get('szDecimals') or 0),
                'max_leverage': int(item.get('maxLeverage') or 1),
            }
        if not universe:
            raise TradingError('Hyperliquid: пустой universe')
        with self._meta_lock:
            self._meta_cache = universe
            self._meta_time = time.time()
        return universe

    def asset_info(self, coin):
        name = str(coin).strip().upper()
        universe = self.meta()
        if name not in universe:
            raise TradingError(f'Hyperliquid: монета {name} не торгуется')
        return universe[name]

    def _wallet_key(self):
        return os.environ.get('HYPERLIQUID_PRIVATE_KEY', '').strip()

    def _account_address(self):
        return os.environ.get('HYPERLIQUID_ACCOUNT_ADDRESS', '').strip().lower()

    def _load_exchange(self):
        """Build the signing client lazily; raise a readable error if absent."""
        if self._exchange is not None:
            return self._exchange
        key = self._wallet_key()
        if not key:
            raise TradingError(
                'Hyperliquid: не задан HYPERLIQUID_PRIVATE_KEY '
                '(ключ API-кошелька, создаётся на app.hyperliquid.xyz/API)')
        if not re.fullmatch(r'(0x)?[0-9a-fA-F]{64}', key):
            raise TradingError('Hyperliquid: HYPERLIQUID_PRIVATE_KEY должен быть 32-байтным hex-ключом')
        try:
            from eth_account import Account  # noqa: PLC0415 - optional dependency
            from hyperliquid.exchange import Exchange  # noqa: PLC0415
        except ImportError as error:
            raise TradingError(
                'Hyperliquid: для реальных ордеров нужен пакет hyperliquid-python-sdk. '
                'Установите: pip install hyperliquid-python-sdk eth-account'
            ) from error
        wallet = Account.from_key(key if key.startswith('0x') else '0x' + key)
        account_address = self._account_address() or wallet.address
        self._exchange = Exchange(
            wallet,
            base_url=self.api_url,
            account_address=account_address,
        )
        return self._exchange

    def ready(self):
        if self.dry_run:
            return True, 'dry-run: ключи не нужны'
        if not self._wallet_key():
            return False, 'Hyperliquid: не задан HYPERLIQUID_PRIVATE_KEY'
        try:
            self._load_exchange()
        except TradingError as error:
            return False, str(error)
        address = self._account_address() or 'адрес кошелька из ключа'
        return True, f'Hyperliquid {"testnet" if self.testnet else "mainnet"}: подписант готов ({address})'

    def prices(self, coins):
        mids = self.all_mids()
        result = {}
        for coin in coins:
            name = str(coin).strip().upper()
            try:
                value = float(mids.get(name))
            except (TypeError, ValueError):
                continue
            if value > 0:
                result[name] = value
        return result

    def price(self, coin):
        name = str(coin).strip().upper()
        mids = self.all_mids()
        raw = mids.get(name)
        if raw is None:
            raise TradingError(f'Hyperliquid: нет цены для {name}')
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise TradingError(f'Hyperliquid: некорректная цена для {name}')
        if value <= 0:
            raise TradingError(f'Hyperliquid: нулевая цена для {name}')
        return value

    def book(self, coin):
        name = str(coin).strip().upper()
        payload = self._info({'type': 'l2Book', 'coin': name}, ttl=1.0)
        levels = (payload or {}).get('levels') or []
        if len(levels) < 2 or not levels[0] or not levels[1]:
            raise TradingError(f'Hyperliquid: пустой стакан для {name}')
        bid = float(levels[0][0].get('px') or 0)
        ask = float(levels[1][0].get('px') or 0)
        if bid <= 0 or ask <= 0:
            raise TradingError(f'Hyperliquid: некорректный стакан для {name}')
        return {'bid': bid, 'ask': ask, 'mid': (bid + ask) / 2}

    def open_orders(self, address):
        """Resting orders of any address — public, no key required."""
        rows = self._info({'type': 'openOrders', 'user': str(address).lower()})
        result = []
        for row in rows or []:
            try:
                result.append({
                    'coin': str(row.get('coin') or '').upper(),
                    'side': 'BUY' if row.get('side') == 'B' else 'SELL',
                    'price': float(row.get('limitPx') or 0),
                    'size': float(row.get('sz') or 0),
                    'order_id': row.get('oid'),
                    'time': int(row.get('timestamp') or 0),
                })
            except (TypeError, ValueError):
                continue
        return result

    def verify_order(self, coin, order_id):
        if self.dry_run or not order_id:
            return {'status': 'dry-run', 'filled_qty': 0.0}
        address = self._account_address()
        if not address:
            try:
                address = self._load_exchange().account_address.lower()
            except TradingError:
                return {'status': 'unknown', 'filled_qty': 0.0}
        payload = self._info({'type': 'orderStatus', 'user': address, 'oid': int(order_id)})
        order = (payload or {}).get('order') or {}
        status = order.get('status') or payload.get('status') or 'unknown'
        inner = order.get('order') or {}
        original = float(inner.get('origSz') or 0)
        remaining = float(inner.get('sz') or 0)
        return {
            'status': status,
            'filled_qty': max(0.0, original - remaining),
            'avg_price': float(inner.get('limitPx') or 0),
            'leaves_qty': remaining,
        }

    def cancel_order(self, coin, order_id):
        if self.dry_run or not order_id:
            return {'ok': True, 'dry_run': True}
        result = self._load_exchange().cancel(str(coin).strip().upper(), int(order_id))
        if str(result.get('status')) != 'ok':
            raise TradingError(f'Hyperliquid: отмена не прошла — {json.dumps(result, ensure_ascii=False)[:200]}')
        return {'ok': True, 'raw': result}

    def place_order(self, coin, side, usd, price, leverage, order_type='limit', reduce_only=False, qty=None):
        info = self.asset_info(coin)
        name = str(coin).strip().upper()
        sz_decimals = info['sz_decimals']
        limit_price = _hl_round_price(price, sz_decimals)
        # Entries are sized in dollars; closes are sized in coins.
        size = _hl_round_size(qty if qty is not None else usd / limit_price, sz_decimals)
        if usd is None:
            usd = size * limit_price
        if size <= 0:
            raise TradingError(
                f'Hyperliquid: объём ${usd:,.2f} слишком мал для шага размера '
                f'{10 ** -sz_decimals} {name}')
        if usd < 10 and not reduce_only:
            raise TradingError('Hyperliquid: минимальный ордер $10')
        if leverage > info['max_leverage']:
            raise TradingError(
                f'Hyperliquid: максимальное плечо для {name} — {info["max_leverage"]}x')
        if self.dry_run:
            payload = _order_payload(self.name, name, name, side, size, limit_price, usd,
                                     order_type, leverage)
            payload.update({'dry_run': True, 'order_id': f'dry-{int(time.time() * 1000)}'})
            return payload
        exchange = self._load_exchange()
        if not reduce_only:
            # Leverage belongs to opening a position; a close should not spend a
            # signed request re-setting it.
            try:
                exchange.update_leverage(leverage, name, is_cross=True)
            except Exception:  # noqa: BLE001 - already-set leverage must not block the order
                pass
        send_price = limit_price
        if order_type == 'limit':
            order_spec = {'limit': {'tif': 'Gtc'}}
        else:
            # Hyperliquid has no market order type: an IOC order priced through
            # the book is the documented equivalent.  Only the price sent to the
            # exchange carries the slippage cap — the reported notional stays on
            # the real price, or every market order would look 2% oversized.
            slip = 1.02 if side == 'BUY' else 0.98
            send_price = _hl_round_price(price * slip, sz_decimals)
            order_spec = {'limit': {'tif': 'Ioc'}}
        result = exchange.order(
            name, side == 'BUY', size, send_price, order_spec, reduce_only=reduce_only)
        if str(result.get('status')) != 'ok':
            raise TradingError(f'Hyperliquid: {json.dumps(result, ensure_ascii=False)[:300]}')
        statuses = ((result.get('response') or {}).get('data') or {}).get('statuses') or []
        order_id = None
        for status in statuses:
            if isinstance(status, dict):
                if 'error' in status:
                    raise TradingError(f'Hyperliquid: {status["error"]}')
                target = status.get('resting') or status.get('filled') or {}
                order_id = target.get('oid') or order_id
        payload = _order_payload(self.name, name, name, side, size, limit_price, usd,
                                 order_type, leverage)
        payload.update({'dry_run': False, 'order_id': order_id, 'raw': result})
        return payload

    def positions(self):
        address = self._account_address()
        if not address and not self.dry_run:
            try:
                address = self._load_exchange().account_address.lower()
            except TradingError:
                address = ''
        if not address:
            return []
        state = self._info({'type': 'clearinghouseState', 'user': address})
        rows = []
        for raw in state.get('assetPositions') or []:
            position = raw.get('position') or {}
            size = float(position.get('szi') or 0)
            if not size:
                continue
            rows.append({
                'coin': str(position.get('coin') or '').upper(),
                'side': 'LONG' if size > 0 else 'SHORT',
                'size': abs(size),
                'entry_price': float(position.get('entryPx') or 0),
                'unrealized_pnl': float(position.get('unrealizedPnl') or 0),
                'leverage': float((position.get('leverage') or {}).get('value') or 0),
            })
        return rows

    def balance(self):
        address = self._account_address()
        if not address and not self.dry_run:
            try:
                address = self._load_exchange().account_address.lower()
            except TradingError:
                address = ''
        if not address:
            return {'account_value': None, 'available': None, 'dry_run': self.dry_run}
        state = self._info({'type': 'clearinghouseState', 'user': address})
        margin = state.get('marginSummary') or state.get('crossMarginSummary') or {}
        return {
            'account_value': float(margin.get('accountValue') or 0),
            'available': float(state.get('withdrawable') or 0),
        }


# ------------------------------------------------------------ payload

def _order_payload(venue, symbol, coin, side, qty, price, requested_usd, order_type, leverage):
    """Common order result, including how far the venue's lot size forced the
    notional away from what was requested."""
    filled_usd = qty * price
    shortfall = (requested_usd - filled_usd) / requested_usd * 100 if requested_usd else 0.0
    payload = {
        'ok': True, 'venue': venue, 'symbol': symbol, 'coin': coin, 'side': side,
        'qty': qty, 'price': price, 'usd': filled_usd, 'requested_usd': requested_usd,
        'notional_shortfall_pct': shortfall, 'order_type': order_type, 'leverage': leverage,
    }
    if abs(shortfall) >= 10:
        payload['warning'] = (
            f'Шаг лота {venue} округлил объём до ${filled_usd:,.2f} '
            f'вместо ${requested_usd:,.2f} ({shortfall:+.1f}%)')
    return payload


# ------------------------------------------------------------ rounding

def _floor_step(value, step):
    if step <= 0:
        return value
    return math.floor(value / step + 1e-9) * step


def _step_decimals(step):
    text = f'{step:.16f}'.rstrip('0')
    return len(text.split('.')[1]) if '.' in text and text.split('.')[1] else 0


def _round_step(value, step):
    """Snap to the venue's tick, then drop the binary-float tail the division
    leaves behind, so the reported price matches what is sent on the wire."""
    if step <= 0:
        return value
    return round(round(value / step) * step, _step_decimals(step))


def _format_step(value, step):
    """Render a number with exactly the precision the venue's step implies."""
    return f'{value:.{_step_decimals(step)}f}'


def _hl_round_size(size, sz_decimals):
    return round(math.floor(size * 10 ** sz_decimals + 1e-9) / 10 ** sz_decimals, sz_decimals)


def _hl_round_price(price, sz_decimals):
    """Hyperliquid: <=5 significant figures and <=(6 - szDecimals) decimals.

    Integer prices are always accepted, so large values keep their precision.
    """
    max_decimals = 6 - sz_decimals
    if price >= 100_000:
        return float(round(price))
    rounded = float(f'{price:.5g}')
    return round(rounded, max(0, max_decimals))


# ---------------------------------------------------------------- risk

def check_risk(broker, usd, settings):
    """Refuse an order the account cannot afford before anything is signed.

    In dry-run there is no account to read, so the check reports that it was
    skipped rather than inventing a balance.
    """
    if broker.dry_run:
        return {'checked': False, 'reason': 'dry-run: баланс не проверяется'}
    balance = broker.balance()
    equity = balance.get('account_value')
    available = balance.get('available')
    if equity is None:
        return {'checked': False, 'reason': 'баланс недоступен'}
    ceiling = float(settings.get('max_account_risk_pct', 25.0)) / 100.0 * float(equity)
    if ceiling > 0 and usd > ceiling:
        raise TradingError(
            f'Риск-лимит: ордер ${usd:,.2f} превышает {settings["max_account_risk_pct"]}% '
            f'от счёта ${float(equity):,.2f} (максимум ${ceiling:,.2f})')
    floor = float(settings.get('min_free_balance_usd', 0.0))
    if available is not None and float(available) - usd < floor:
        raise TradingError(
            f'Риск-лимит: свободный баланс ${float(available):,.2f} минус ордер ${usd:,.2f} '
            f'опустится ниже порога ${floor:,.2f}')
    return {'checked': True, 'account_value': float(equity), 'available': available,
            'risk_ceiling_usd': ceiling}


# ------------------------------------------------------------- factory

def build_broker(settings=None):
    settings = settings or load_settings()
    venue = settings.get('venue', 'hyperliquid')
    mode = settings.get('mode', 'dry-run')
    if venue == 'bybit':
        return BybitBroker(mode)
    return HyperliquidBroker(mode)


def venue_status(settings=None):
    settings = settings or load_settings()
    broker = build_broker(settings)
    ok, reason = broker.ready()
    payload = {
        'venue': broker.name,
        'mode': settings.get('mode'),
        'ready': ok,
        'reason': reason,
        'dry_run': broker.dry_run,
        'checked_at': int(time.time() * 1000),
    }
    if ok and not broker.dry_run:
        try:
            payload['balance'] = broker.balance()
        except TradingError as error:
            payload['balance_error'] = str(error)
    return payload

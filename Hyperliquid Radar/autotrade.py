#!/usr/bin/env python3
"""Bybit auto-trading backend for the Linux server.

This is a port of autotrade.ps1, which only runs on Windows. The trading
rules are unchanged:

* follow one or two Hyperliquid addresses;
* the wanted side for a coin is the side of the leader who opened last,
  or "" when no configured leader holds that coin any more;
* "" closes our Bybit position with a reduce-only market order;
* the same side already open is left alone;
* an opposite position is closed only when its PnL is at least $10,
  otherwise the signal is ignored;
* a new position is a market order sized as
  available balance x deposit percent x leverage / price, rounded down to the
  lot step, in hedge mode (positionIdx 1 = long, 2 = short).

What the port adds, because the browser was the only thing driving it:

* the server listens to the leaders itself (push-server.js forwards their
  fills), so trading continues with the browser closed;
* every configured leader is re-read from Hyperliquid on each signal, so a
  restart or a page that missed a fill cannot turn "leader B closed" into
  "close our position" while leader A still holds it;
* signals are handled one at a time, and a position we just opened or closed
  is not acted on again for ten seconds, so a fast pair of fills cannot open
  it twice;
* "leverage not modified" (Bybit 110043) no longer aborts the order;
* a one-way-mode account gets positionIdx 0 instead of an error;
* every action, skip and error is journalled and sent to Telegram.
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import ROUND_FLOOR, Decimal, InvalidOperation
from pathlib import Path

import notify

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("RADAR_DATA_DIR", str(ROOT / "data")))
CONFIG_FILE = DATA_DIR / "autotrade.json"
JOURNAL_FILE = DATA_DIR / "autotrade-log.jsonl"
BYBIT_BASE = os.environ.get("BYBIT_BASE", "https://api.bybit.com").rstrip("/")
HL_INFO_URL = os.environ.get("HL_INFO_URL", "https://api.hyperliquid.xyz/info")
USER_AGENT = "HyperliquidRadar/1.2"
ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
DEBOUNCE_SECONDS = float(os.environ.get("AUTOTRADE_DEBOUNCE", "0.9"))
MAX_FILL_AGE_MS = 120_000
REPEAT_GUARD_SECONDS = 10.0
MIN_OPPOSITE_PNL = Decimal("10")
MSK = timezone(timedelta(hours=3))

_CONFIG_LOCK = threading.Lock()
_TRADE_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()


class AutoTradeError(Exception):
    """A failure whose message is shown to the operator as is."""


class BybitError(AutoTradeError):
    HINTS = {
        10003: "неверный API ключ",
        10004: "неверная подпись: проверьте API Secret",
        10005: "у API ключа нет прав на торговлю деривативами",
        10010: "IP сервера не добавлен в белый список API ключа",
        110007: "недостаточно доступного баланса",
    }

    def __init__(self, code: object, message: object):
        self.code = int(code) if str(code).lstrip("-").isdigit() else -1
        self.raw = str(message or "")
        hint = self.HINTS.get(self.code)
        super().__init__(f"Bybit {self.code}: {self.raw}" + (f" ({hint})" if hint else ""))


# ------------------------------------------------------------------ storage

def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(DATA_DIR, 0o700)
    except OSError:
        pass


def _write_private(path: Path, text: str) -> None:
    _ensure_dir()
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(tmp, path)


def load_config() -> dict | None:
    with _CONFIG_LOCK:
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None


def _key_mask(cfg: dict) -> str:
    last4 = str(cfg.get("apiKeyLast4") or "")
    return ("****" + last4) if last4 else ""


def status() -> dict:
    cfg = load_config()
    out: dict = {"server": True, "events": recent_events(12), "telegram": notify.status(),
                 "listener": dict(LISTENER)}
    if cfg is None:
        out.update(configured=False, enabled=False, addresses=[])
        return out
    out.update(
        configured=bool(cfg.get("apiKey") and cfg.get("apiSecret")),
        enabled=bool(cfg.get("enabled")),
        addresses=list(cfg.get("addresses") or []),
        equityPercent=float(cfg.get("equityPercent") or 0),
        leverage=int(cfg.get("leverage") or 0),
        apiKeyMask=_key_mask(cfg),
    )
    return out


def save_config(data: dict) -> dict:
    if not isinstance(data, dict):
        raise AutoTradeError("Неверный запрос.")
    raw = data.get("addresses") or []
    if isinstance(raw, str):
        raw = re.split(r"[,\s]+", raw)
    addresses: list[str] = []
    for item in raw:
        value = str(item).strip().lower()
        if ADDRESS.fullmatch(value) and value not in addresses:
            addresses.append(value)
    addresses = addresses[:2]
    if not addresses:
        raise AutoTradeError("Укажите один или два адреса Hyperliquid (0x…).")
    try:
        equity = float(data.get("equityPercent"))
        leverage = int(round(float(data.get("leverage"))))
    except (TypeError, ValueError):
        raise AutoTradeError("Процент депозита и плечо должны быть числами.") from None
    if not (0 < equity <= 100):
        raise AutoTradeError("Процент депозита должен быть от 0.01 до 100.")
    if not (1 <= leverage <= 100):
        raise AutoTradeError("Плечо должно быть от 1 до 100.")
    old = load_config() or {}
    api_key = str(data.get("apiKey") or "").strip()
    api_secret = str(data.get("apiSecret") or "").strip()
    if not api_key or not api_secret:
        if not (old.get("apiKey") and old.get("apiSecret")):
            raise AutoTradeError("Введите Bybit API Key и API Secret.")
        api_key, api_secret = old["apiKey"], old["apiSecret"]
    enabled = bool(data.get("enabled"))
    cfg = {
        "apiKey": api_key,
        "apiSecret": api_secret,
        "apiKeyLast4": api_key[-4:],
        "addresses": addresses,
        "equityPercent": equity,
        "leverage": leverage,
        "enabled": enabled,
        "updatedAt": int(time.time() * 1000),
    }
    with _CONFIG_LOCK:
        _write_private(CONFIG_FILE, json.dumps(cfg, indent=2))
    was = bool(old.get("enabled"))
    if enabled != was:
        text = ("▶️ <b>Автоторговля включена</b>" if enabled else "⏹ <b>Автоторговля выключена</b>")
        detail = f"{', '.join(notify.short(a) for a in addresses)} · {equity:g}% депозита · {leverage}x"
        journal("config", ("Включена: " if enabled else "Выключена: ") + detail)
        notify.send(f"{text}\n{detail}", dedupe_key=f"toggle:{enabled}:{cfg['updatedAt']}")
    else:
        journal("config", f"Настройки сохранены: {len(addresses)} адрес(а) · {equity:g}% · {leverage}x")
    return status()


# ------------------------------------------------------------------ journal

EVENTS: collections.deque = collections.deque(maxlen=200)


def journal(kind: str, text: str, **extra: object) -> dict:
    entry = {"t": int(time.time() * 1000), "kind": kind, "text": text}
    entry.update({k: v for k, v in extra.items() if v not in (None, "")})
    with _STATE_LOCK:
        EVENTS.append(entry)
    try:
        _ensure_dir()
        if JOURNAL_FILE.exists() and JOURNAL_FILE.stat().st_size > 2_000_000:
            os.replace(JOURNAL_FILE, JOURNAL_FILE.with_suffix(".jsonl.1"))
        with open(JOURNAL_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
    print(f"autotrade {kind}: {text}", flush=True)
    return entry


def recent_events(limit: int = 50) -> list[dict]:
    with _STATE_LOCK:
        items = list(EVENTS)[-limit:]
    return list(reversed(items))


def _load_journal_tail() -> None:
    try:
        lines = JOURNAL_FILE.read_text(encoding="utf-8").splitlines()[-EVENTS.maxlen:]
    except OSError:
        return
    for line in lines:
        try:
            EVENTS.append(json.loads(line))
        except ValueError:
            continue


# ------------------------------------------------------------------ http

def _http_json(url: str, data: bytes | None = None, headers: dict | None = None,
               method: str | None = None, timeout: float = 15) -> dict:
    request = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    request.add_header("User-Agent", USER_AGENT)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        body = ""
        try:
            body = error.read().decode("utf-8", "replace")[:200]
        except OSError:
            pass
        raise AutoTradeError(f"HTTP {error.code} от {urllib.parse.urlsplit(url).netloc}: {body}") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise AutoTradeError(f"Нет ответа от {urllib.parse.urlsplit(url).netloc}: {error}") from None


def bybit(method: str, path: str, body: object, cfg: dict) -> dict:
    """Signed Bybit v5 call, signed exactly like autotrade.ps1."""
    key, secret = str(cfg.get("apiKey") or ""), str(cfg.get("apiSecret") or "")
    if not key or not secret:
        raise AutoTradeError("Bybit API ключи не заданы.")
    timestamp = str(int(time.time() * 1000))
    window = "10000"
    payload = str(body or "") if method == "GET" else json.dumps(body, separators=(",", ":"))
    signature = hmac.new(secret.encode(), (timestamp + key + window + payload).encode(), hashlib.sha256).hexdigest()
    headers = {"X-BAPI-API-KEY": key, "X-BAPI-SIGN": signature, "X-BAPI-SIGN-TYPE": "2",
               "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": window}
    url = BYBIT_BASE + path
    if method == "GET":
        if payload:
            url += "?" + payload
        response = _http_json(url, headers=headers, method="GET")
    else:
        headers["Content-Type"] = "application/json"
        response = _http_json(url, data=payload.encode(), headers=headers, method="POST")
    if response.get("retCode") != 0:
        raise BybitError(response.get("retCode"), response.get("retMsg"))
    return response.get("result") or {}


def _public(path: str, query: str) -> dict:
    return _http_json(f"{BYBIT_BASE}{path}?{query}", timeout=12)


def _dec(value: object, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value)) if str(value).strip() else Decimal(default)
    except (InvalidOperation, ValueError):
        return Decimal(default)


def _fmt(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text if "." not in text else text.rstrip("0").rstrip(".")


# ------------------------------------------------------------------ symbols

def _symbol_candidates(raw_coin: str) -> list[str]:
    coin = raw_coin.strip()
    upper = coin.upper()
    if upper.endswith("USDT"):
        return [upper]
    base = re.sub(r"^[A-Z0-9]+:", "", upper)
    base = re.sub(r"^@", "", base)
    out = [base + "USDT"]
    # Hyperliquid quotes small coins per thousand (kPEPE); Bybit calls them 1000PEPE.
    bare = re.sub(r"^[A-Za-z0-9]+:", "", coin)
    if re.fullmatch(r"k[A-Z0-9]{2,}", bare):
        out += [f"1000{bare[1:]}USDT", f"{bare[1:]}1000USDT"]
    return out


def resolve_symbol(raw_coin: str) -> tuple[str, dict | None]:
    candidates = _symbol_candidates(raw_coin)
    for symbol in candidates:
        query = "category=linear&symbol=" + urllib.parse.quote(symbol)
        try:
            data = _public("/v5/market/instruments-info", query)
        except AutoTradeError as error:
            raise AutoTradeError(f"Не удалось проверить пару {symbol}: {error}") from None
        items = (data.get("result") or {}).get("list") or [] if data.get("retCode") == 0 else []
        if items and str(items[0].get("status", "Trading")) == "Trading":
            return symbol, items[0]
    return candidates[0], None


# ------------------------------------------------------------------ trading

_RECENT_ACTION: dict[str, tuple[str, float]] = {}


def _order(body: dict, cfg: dict) -> dict:
    try:
        return bybit("POST", "/v5/order/create", body, cfg)
    except BybitError as error:
        # Hedge-mode indexes are rejected by a one-way-mode account.
        if error.code == 10001 and "position idx" in error.raw.lower() and body.get("positionIdx") != 0:
            return bybit("POST", "/v5/order/create", dict(body, positionIdx=0), cfg)
        raise


def _close(symbol: str, position: dict, cfg: dict) -> dict:
    close_side = "Sell" if position.get("side") == "Buy" else "Buy"
    body = {"category": "linear", "symbol": symbol, "side": close_side, "orderType": "Market",
            "qty": str(position.get("size")), "reduceOnly": True,
            "positionIdx": 1 if position.get("side") == "Buy" else 2}
    return _order(body, cfg)


def _side_name(side: str) -> str:
    return "LONG" if side == "Buy" else "SHORT"


def signal(data: dict) -> dict:
    """One leader signal. Thread-safe: signals are handled one at a time."""
    with _TRADE_LOCK:
        return _signal_locked(data)


def _signal_locked(data: dict) -> dict:
    cfg = load_config()
    if cfg is None or not cfg.get("enabled"):
        return {"ok": True, "skipped": "Автоторговля выключена"}
    leader = str(data.get("address") or "").lower()
    if leader not in (cfg.get("addresses") or []):
        return {"ok": True, "skipped": "Адрес не настроен для автоторговли"}
    raw_coin = str(data.get("coin") or "")
    side = str(data.get("side") if data.get("side") is not None else "")
    if side not in ("Buy", "Sell", ""):
        raise AutoTradeError("Неверная сторона ордера.")
    symbol, instrument = resolve_symbol(raw_coin)
    if instrument is None:
        return {"ok": True, "skipped": f"Пары {symbol} нет на Bybit", "symbol": symbol}
    query = "category=linear&symbol=" + urllib.parse.quote(symbol)
    positions = bybit("GET", "/v5/position/list", query, cfg)
    open_positions = [p for p in positions.get("list") or []
                      if _dec(p.get("size")) > 0 and p.get("side") in ("Buy", "Sell")]
    current = open_positions[0] if open_positions else None

    recent = _RECENT_ACTION.get(symbol)
    if recent and time.monotonic() - recent[1] < REPEAT_GUARD_SECONDS:
        wanted = side or "close"
        if recent[0] == wanted:
            return {"ok": True, "skipped": "Ордер по этому сигналу уже отправлен", "symbol": symbol}

    if side == "":
        if current is None:
            return {"ok": True, "skipped": "На Bybit нет позиции", "symbol": symbol}
        _close(symbol, current, cfg)
        _RECENT_ACTION[symbol] = ("close", time.monotonic())
        return {"ok": True, "action": f"Закрыта {_side_name(current['side'])} {symbol} после закрытия лидером",
                "symbol": symbol, "closed": current.get("side"), "qty": str(current.get("size")),
                "pnl": str(current.get("unrealisedPnl") or "")}

    if current is not None and current.get("side") == side:
        return {"ok": True, "skipped": "Такая позиция уже открыта", "symbol": symbol}
    reversed_from = None
    if current is not None:
        pnl = _dec(current.get("unrealisedPnl"))
        if pnl < MIN_OPPOSITE_PNL:
            return {"ok": True, "skipped": f"Противоположный сигнал пропущен: PnL {_fmt(pnl)} меньше $10",
                    "symbol": symbol}
        _close(symbol, current, cfg)
        reversed_from = current

    try:
        bybit("POST", "/v5/position/set-leverage",
              {"category": "linear", "symbol": symbol,
               "buyLeverage": str(cfg["leverage"]), "sellLeverage": str(cfg["leverage"])}, cfg)
    except BybitError as error:
        if error.code != 110043:  # leverage not modified: already at this value
            raise
    wallet = bybit("GET", "/v5/account/wallet-balance", "accountType=UNIFIED", cfg)
    accounts = wallet.get("list") or []
    available = _dec(accounts[0].get("totalAvailableBalance")) if accounts else Decimal(0)
    ticker = _public("/v5/market/tickers", query)
    tickers = (ticker.get("result") or {}).get("list") or []
    price = _dec(tickers[0].get("lastPrice")) if tickers else Decimal(0)
    if price <= 0:
        raise AutoTradeError(f"Нет цены {symbol} на Bybit.")
    lot = instrument.get("lotSizeFilter") or {}
    step = _dec(lot.get("qtyStep"), "0")
    if step <= 0:
        raise AutoTradeError(f"Bybit не вернул шаг лота для {symbol}.")
    notional = available * (Decimal(str(cfg["equityPercent"])) / Decimal(100)) * Decimal(int(cfg["leverage"]))
    qty = (notional / price / step).to_integral_value(rounding=ROUND_FLOOR) * step
    max_qty = _dec(lot.get("maxMktOrderQty"), "0")
    if max_qty > 0 and qty > max_qty:
        qty = (max_qty / step).to_integral_value(rounding=ROUND_FLOOR) * step
    if qty <= 0:
        raise AutoTradeError(f"Доступного баланса ${_fmt(available)} не хватает на минимальный ордер {symbol}.")
    min_qty = _dec(lot.get("minOrderQty"), "0")
    min_notional = _dec(lot.get("minNotionalValue"), "0")
    if qty < min_qty or (min_notional > 0 and qty * price < min_notional):
        raise AutoTradeError(
            f"Объём {_fmt(qty)} {symbol} (~${_fmt((qty * price).quantize(Decimal('0.01')))}) меньше минимума Bybit "
            f"({_fmt(min_qty)} / ${_fmt(min_notional)}). Увеличьте процент депозита или плечо.")
    order = {"category": "linear", "symbol": symbol, "side": side, "orderType": "Market",
             "qty": _fmt(qty), "positionIdx": 1 if side == "Buy" else 2,
             "orderLinkId": "hlr" + secrets.token_hex(9)}
    result = _order(order, cfg)
    _RECENT_ACTION[symbol] = (side, time.monotonic())
    text = f"Открыта {_side_name(side)} {symbol}"
    if reversed_from is not None:
        text = f"Закрыта {_side_name(reversed_from['side'])} (PnL {reversed_from.get('unrealisedPnl')}) и открыта {_side_name(side)} {symbol}"
    return {"ok": True, "action": text, "orderId": result.get("orderId"), "qty": _fmt(qty),
            "symbol": symbol, "side": side, "price": _fmt(price),
            "usd": _fmt((qty * price).quantize(Decimal("0.01"))), "leverage": int(cfg["leverage"])}


def report(source: str, data: dict, out: dict | None, error: Exception | None = None) -> None:
    """Journal a signal outcome and tell Telegram about the ones that matter."""
    leader = str(data.get("address") or "").lower()
    coin = str(data.get("coin") or "")
    who = f"лидер {notify.short(leader)}" if leader else ""
    if error is not None:
        journal("error", str(error), address=leader, coin=coin, source=source)
        notify.send(f"⚠️ <b>Автоторговля: ошибка</b>\n{coin} · {error}\n{who}", dedupe_key=f"err:{coin}:{error}")
        return
    out = out or {}
    symbol = out.get("symbol") or coin
    if out.get("action"):
        journal("trade", out["action"], address=leader, coin=coin, symbol=symbol, source=source,
                qty=out.get("qty"), usd=out.get("usd"))
        if out.get("closed"):
            body = f"⚪ <b>Bybit: {out['action']}</b>\nqty {out.get('qty')} · PnL {out.get('pnl') or '—'}\n{who}"
        else:
            body = (f"🟢 <b>Bybit: {out['action']}</b>\nqty {out.get('qty')} · ~${out.get('usd')} · "
                    f"{out.get('leverage')}x · цена {out.get('price')}\n{who}")
        notify.send(body, dedupe_key=f"trade:{out.get('orderId') or out['action']}:{time.time():.0f}")
    elif out.get("skipped"):
        journal("skip", out["skipped"], address=leader, coin=coin, symbol=symbol, source=source)
        text = out["skipped"]
        if text.startswith("Пары ") or text.startswith("Противоположный"):
            notify.send(f"⏸ <b>Автоторговля пропустила сигнал</b>\n{coin}: {text}\n{who}",
                        dedupe_key=f"skip:{symbol}:{text[:40]}")


# ------------------------------------------------------------------ leaders

LEADERS: dict[tuple[str, str], dict | None] = {}
LISTENER: dict = {"connected": False, "users": [], "updatedAt": 0}
_TIMERS: dict[tuple[str, str], threading.Timer] = {}
_EVALS: "queue.Queue[tuple[str, str, int]]" = queue.Queue()
_WORKER: threading.Thread | None = None
_SEEN_FILLS: collections.OrderedDict = collections.OrderedDict()


def _hl_side(address: str, coin: str) -> str | None:
    body: dict = {"type": "clearinghouseState", "user": address}
    if ":" in coin:
        body["dex"] = coin.split(":", 1)[0]
    data = _http_json(HL_INFO_URL, data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"}, timeout=10)
    for item in data.get("assetPositions") or []:
        position = item.get("position") or {}
        if str(position.get("coin")) == coin:
            size = _dec(position.get("szi"))
            if size > 0:
                return "Buy"
            if size < 0:
                return "Sell"
    return None


def desired_side(trigger: str, coin: str, fill_time: int, addresses: list[str]) -> str:
    """Side of the most recent active leader for this coin, as the browser computed it."""
    for address in addresses:
        key = (address, coin)
        try:
            side = _hl_side(address, coin)
        except AutoTradeError:
            if address == trigger:
                raise
            continue  # keep what we last knew about the other leader
        with _STATE_LOCK:
            if side is None:
                LEADERS[key] = None
            elif address == trigger:
                LEADERS[key] = {"side": side, "time": fill_time}
            else:
                previous = LEADERS.get(key)
                if not previous or previous.get("side") != side:
                    LEADERS[key] = {"side": side, "time": 0}  # opened before we saw it
    with _STATE_LOCK:
        active = [v for (a, c), v in LEADERS.items() if c == coin and v and a in addresses]
    active.sort(key=lambda v: v["time"], reverse=True)
    return active[0]["side"] if active else ""


def _evaluate(address: str, coin: str, fill_time: int) -> None:
    cfg = load_config()
    if not cfg or not cfg.get("enabled") or address not in (cfg.get("addresses") or []):
        return
    data = {"address": address, "coin": coin}
    try:
        data["side"] = desired_side(address, coin, fill_time, list(cfg.get("addresses") or []))
        out = signal(data)
        report("server", data, out)
    except AutoTradeError as error:
        report("server", data, None, error)
    except Exception as error:  # noqa: BLE001 - the worker must survive anything
        report("server", data, None, AutoTradeError(f"{type(error).__name__}: {error}"))


def _worker() -> None:
    while True:
        address, coin, fill_time = _EVALS.get()
        _evaluate(address, coin, fill_time)


def _schedule(address: str, coin: str, fill_time: int) -> None:
    global _WORKER
    if _WORKER is None or not _WORKER.is_alive():
        _WORKER = threading.Thread(target=_worker, daemon=True, name="autotrade")
        _WORKER.start()
    key = (address, coin)
    with _STATE_LOCK:
        old = _TIMERS.pop(key, None)
        if old:
            old.cancel()
        timer = threading.Timer(DEBOUNCE_SECONDS, _EVALS.put, args=((address, coin, fill_time),))
        timer.daemon = True
        _TIMERS[key] = timer
    timer.start()


def browser_signal(data: dict) -> dict:
    """POST /autotrade/signal from an open page.

    The page only knows the leaders whose fills it saw since it loaded, so its
    idea of the wanted side can be wrong. The server re-reads every leader
    and decides itself; the page's request only makes it look now.
    """
    if not isinstance(data, dict):
        raise AutoTradeError("Неверный запрос.")
    cfg = load_config()
    if cfg is None or not cfg.get("enabled"):
        return {"ok": True, "skipped": "Автоторговля выключена"}
    address = str(data.get("address") or "").lower()
    if address not in (cfg.get("addresses") or []):
        return {"ok": True, "skipped": "Адрес не настроен для автоторговли"}
    coin = str(data.get("coin") or "").strip()
    if not coin:
        raise AutoTradeError("Не указана монета.")
    _schedule(address, coin, int(time.time() * 1000))
    return {"ok": True, "skipped": "Сигнал обрабатывает сервер"}


# ------------------------------------------------------------------ fills from push-server

_WHALE_BUFFER: dict[tuple[str, str, str], dict] = {}
_WHALE_LAST: dict[tuple[str, str, str], float] = {}
WHALE_FLUSH_SECONDS = float(os.environ.get("TELEGRAM_AGGREGATE_SECONDS", "3"))
# After a message, further fills of the same address/coin/direction are summed
# into the next one, sent at most once per this interval.
WHALE_REPEAT_SECONDS = float(os.environ.get("TELEGRAM_REPEAT_SECONDS", "60"))


def _dir_kind(direction: str) -> tuple[str, str] | None:
    d = direction.strip().lower()
    if d.startswith("open "):
        return "ОТКРЫТИЕ", "LONG" if "long" in d else "SHORT"
    if d.startswith("close "):
        return "ЗАКРЫТИЕ", "LONG" if "long" in d else "SHORT"
    if ">" in d:
        return "РАЗВОРОТ", "LONG→SHORT" if d.startswith("long") else "SHORT→LONG"
    return None


def _flush_whale(key: tuple[str, str, str]) -> None:
    with _STATE_LOCK:
        item = _WHALE_BUFFER.pop(key, None)
        _WHALE_LAST[key] = time.monotonic()
        if len(_WHALE_LAST) > 5000:
            for stale in sorted(_WHALE_LAST, key=_WHALE_LAST.get)[:2500]:
                _WHALE_LAST.pop(stale, None)
    if not item:
        return
    user, coin, _ = key
    action, position = item["action"], item["position"]
    icon = {"ОТКРЫТИЕ": "🟢", "ЗАКРЫТИЕ": "⚪", "РАЗВОРОТ": "🔄"}.get(action, "•")
    avg = item["usd"] / item["sz"] if item["sz"] else 0
    when = datetime.fromtimestamp(item["time"] / 1000, MSK).strftime("%H:%M:%S")
    fills = f" · {item['count']} сделок" if item["count"] > 1 else ""
    tag = " · автоторговля" if item.get("leader") else ""
    text = (f"{icon} <b>{action} {position} {coin}</b> · {notify.money(item['usd'])}\n"
            f"{notify.short(user)} · цена {avg:,.6g}{fills} · {when} MSK{tag}")
    notify.send(text, dedupe_key=f"whale:{user}:{coin}:{item['first_tid']}", bulk=True)


def _whale_event(user: str, fill: dict, leader: bool) -> None:
    kind = _dir_kind(str(fill.get("dir") or ""))
    if not kind:
        return
    coin = str(fill.get("coin") or "")
    px, sz = float(_dec(fill.get("px"))), abs(float(_dec(fill.get("sz"))))
    key = (user, coin, str(fill.get("dir")))
    start = False
    with _STATE_LOCK:
        item = _WHALE_BUFFER.get(key)
        if item is None:
            item = {"action": kind[0], "position": kind[1], "usd": 0.0, "sz": 0.0, "count": 0,
                    "time": int(fill.get("time") or time.time() * 1000), "first_tid": fill.get("tid") or fill.get("hash"),
                    "leader": leader}
            _WHALE_BUFFER[key] = item
            start = True
        item["usd"] += px * sz
        item["sz"] += sz
        item["count"] += 1
    if start:
        with _STATE_LOCK:
            since = time.monotonic() - _WHALE_LAST.get(key, -1e9)
        delay = max(WHALE_FLUSH_SECONDS, WHALE_REPEAT_SECONDS - since)
        timer = threading.Timer(delay, _flush_whale, args=(key,))
        timer.daemon = True
        timer.start()


def handle_fills(items: list) -> dict:
    """Fills forwarded by push-server.js: [{user, fill, watch}]."""
    cfg = load_config() or {}
    leaders = set(cfg.get("addresses") or [])
    trading = bool(cfg.get("enabled"))
    now = int(time.time() * 1000)
    scheduled = notified = 0
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        user = str(item.get("user") or "").lower()
        fill = item.get("fill") or {}
        if not ADDRESS.fullmatch(user) or not isinstance(fill, dict):
            continue
        ident = f"{user}:{fill.get('tid') or fill.get('hash')}:{fill.get('time')}:{fill.get('oid')}"
        with _STATE_LOCK:
            if ident in _SEEN_FILLS:
                continue
            _SEEN_FILLS[ident] = True
            while len(_SEEN_FILLS) > 20000:
                _SEEN_FILLS.popitem(last=False)
        fill_time = int(_dec(fill.get("time"), "0"))
        fresh = abs(now - fill_time) <= MAX_FILL_AGE_MS
        is_leader = user in leaders
        if fresh and notify.watchlist_enabled() and (item.get("watch") or is_leader):
            _whale_event(user, fill, is_leader)
            notified += 1
        coin = str(fill.get("coin") or "")
        spot = coin.startswith("@") or "/" in coin
        if trading and is_leader and fresh and not spot and _dir_kind(str(fill.get("dir") or "")):
            _schedule(user, coin, fill_time)
            scheduled += 1
    return {"ok": True, "scheduled": scheduled, "notified": notified}


def listener_sync(data: dict) -> dict:
    """push-server.js reports its socket and asks which leaders to follow."""
    LISTENER.update(connected=bool(data.get("connected")),
                    users=[str(u).lower() for u in (data.get("users") or [])][:20],
                    dropped=[str(u).lower() for u in (data.get("dropped") or [])][:100],
                    updatedAt=int(time.time() * 1000))
    cfg = load_config() or {}
    leaders = list(cfg.get("addresses") or []) if cfg.get("enabled") else []
    return {"ok": True, "leaders": leaders}


def telegram_status_text() -> str:
    st = status()
    if not st.get("configured"):
        return "📊 Автоторговля: ключи Bybit не заданы"
    lines = [f"📊 <b>Автоторговля {'включена' if st.get('enabled') else 'выключена'}</b>"]
    if st.get("addresses"):
        lines.append("Адреса: " + ", ".join(notify.short(a) for a in st["addresses"]))
    if st.get("equityPercent"):
        lines.append(f"{st['equityPercent']:g}% депозита · {st.get('leverage')}x · ключ {st.get('apiKeyMask')}")
    listener = st.get("listener") or {}
    lines.append("Сервер слушает Hyperliquid" if listener.get("connected") else "⚠️ Сервер не подключён к Hyperliquid")
    events = [e for e in st.get("events") or [] if e.get("kind") != "config"][:3]
    for event in events:
        when = datetime.fromtimestamp(event["t"] / 1000, MSK).strftime("%d.%m %H:%M")
        lines.append(f"{when} · {event.get('coin', '')} {event['text']}".strip())
    return "\n".join(lines)


_load_journal_tail()

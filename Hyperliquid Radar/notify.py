#!/usr/bin/env python3
"""Telegram notifications for Hyperliquid Radar.

Web push only reaches an iPhone when the site is installed to the Home Screen,
and a browser notification dies with the tab. A Telegram message arrives with
the phone locked, so the server sends one for every auto-trade action and for
every OPEN/CLOSE of a watched address.

One background thread drains a bounded queue and keeps at least a second
between messages, which is Telegram's per-chat limit. A 429 is retried once
after the delay Telegram asks for. Nothing here ever raises into the caller: a
Telegram outage must not delay or fail an order. The worst case is a missed
message, which /autotrade/status reports as ``lastError``.

Configuration (/etc/hyperliquid-radar.env):
    TELEGRAM_BOT_TOKEN   token from @BotFather
    TELEGRAM_CHAT_ID     numeric id of the chat that receives messages
    TELEGRAM_WATCHLIST   1 (default) = also send whale OPEN/CLOSE, 0 = trades only
    TELEGRAM_API_BASE    tests only: point at a local fake instead of Telegram
"""
from __future__ import annotations

import collections
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "HyperliquidRadar/1.2"
SEND_TIMEOUT = 10
MIN_GAP_SECONDS = float(os.environ.get("TELEGRAM_MIN_GAP", "1.1"))
DEDUPE_SECONDS = 300.0
QUEUE_LIMIT = 200
# Whale events are "bulk": a busy address fills hundreds of times a minute,
# so they are capped and always wait behind trades, errors and replies.
BULK_PER_MINUTE = int(os.environ.get("TELEGRAM_BULK_PER_MINUTE", "12"))
BULK_QUEUE_LIMIT = 30

_LOCK = threading.Lock()
_WAKE = threading.Condition(_LOCK)
_QUEUE: collections.deque[str] = collections.deque()
_BULK: collections.deque[str] = collections.deque()
_BULK_TIMES: collections.deque[float] = collections.deque()
_RECENT: dict[str, float] = {}
_WORKER: threading.Thread | None = None
STATUS = {"sent": 0, "failed": 0, "dropped": 0, "lastOkAt": 0, "lastError": None}


def _config() -> tuple[str, str, str]:
    return (
        os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(),
        os.environ.get("TELEGRAM_CHAT_ID", "").strip(),
        os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/"),
    )


def configured() -> bool:
    token, chat, _ = _config()
    return bool(token and chat)


def watchlist_enabled() -> bool:
    return os.environ.get("TELEGRAM_WATCHLIST", "1").strip() not in ("0", "false", "no", "off")


def status() -> dict:
    with _LOCK:
        out = dict(STATUS)
        out["queued"] = len(_QUEUE) + len(_BULK)
    out["configured"] = configured()
    return out


def _post(text: str) -> tuple[bool, float]:
    """Send one message. Returns (ok, retry_after_seconds); -1 = will not work until fixed."""
    token, chat, base = _config()
    body = urllib.parse.urlencode({
        "chat_id": chat, "text": text, "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    request = urllib.request.Request(
        f"{base}/bot{token}/sendMessage", data=body, method="POST",
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
    retry_after = 0.0
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT) as response:
            payload = json.loads(response.read() or b"{}")
        if not payload.get("ok", False):
            raise RuntimeError(str(payload.get("description") or payload)[:200])
        with _LOCK:
            STATUS["sent"] += 1
            STATUS["lastOkAt"] = int(time.time() * 1000)
            STATUS["lastError"] = None
        return True, 0.0
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            raw = error.read().decode("utf-8", "replace")
            detail = raw[:200]
            retry_after = float(json.loads(raw).get("parameters", {}).get("retry_after", 0) or 0)
        except (ValueError, AttributeError, OSError):
            pass
        message = f"HTTP {error.code} {detail}".strip()
        if error.code in (400, 401, 403, 404):
            retry_after = -1.0
    except Exception as error:  # noqa: BLE001 - a notifier must never raise into trading
        message = f"{type(error).__name__}: {error}"
    with _LOCK:
        STATUS["failed"] += 1
        STATUS["lastError"] = message
    return False, retry_after


def _worker() -> None:
    while True:
        with _WAKE:
            while not _QUEUE and not _BULK:
                _WAKE.wait()
            text = _QUEUE.popleft() if _QUEUE else _BULK.popleft()
        ok, retry_after = _post(text)
        if not ok and retry_after < 0:
            # Chat not started, bad token...: whale events queued behind this
            # would all fail the same way, so drop them instead of hammering.
            with _WAKE:
                STATUS["dropped"] += len(_BULK)
                _BULK.clear()
        elif not ok and 0 < retry_after <= 60:
            time.sleep(retry_after)
            _post(text)
        time.sleep(MIN_GAP_SECONDS)


def _ensure_worker() -> None:
    global _WORKER
    if _WORKER is None or not _WORKER.is_alive():
        _WORKER = threading.Thread(target=_worker, daemon=True, name="telegram")
        _WORKER.start()


def send(text: str, dedupe_key: str | None = None, bulk: bool = False) -> bool:
    """Queue one message. Identical keys inside five minutes are sent once."""
    if not configured():
        return False
    key = dedupe_key or text
    now = time.monotonic()
    with _WAKE:
        last = _RECENT.get(key)
        if last is not None and now - last < DEDUPE_SECONDS:
            return False
        _RECENT[key] = now
        if len(_RECENT) > 2048:
            for stale in sorted(_RECENT, key=_RECENT.get)[:1024]:
                _RECENT.pop(stale, None)
        if bulk:
            while _BULK_TIMES and now - _BULK_TIMES[0] > 60:
                _BULK_TIMES.popleft()
            if len(_BULK_TIMES) >= BULK_PER_MINUTE or len(_BULK) >= BULK_QUEUE_LIMIT:
                STATUS["dropped"] += 1
                return False
            _BULK_TIMES.append(now)
            _BULK.append(text)
        else:
            if len(_QUEUE) >= QUEUE_LIMIT:
                _QUEUE.popleft()
                STATUS["dropped"] += 1
            _QUEUE.append(text)
        _ensure_worker()
        _WAKE.notify()
    return True


def test_message() -> dict:
    """Synchronous probe for the «Проверить Telegram» button."""
    if not configured():
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы на сервере"}
    ok, _ = _post("✅ Hyperliquid Radar: бот на связи. Сделки автоторговли и события отслеживаемых адресов будут приходить сюда.")
    out = status()
    out["ok"] = ok
    if not ok:
        error = out.get("lastError") or "Telegram не принял сообщение"
        if "chat not found" in error.lower() or "bot can't initiate" in error.lower():
            error += " — откройте бота в Telegram и нажмите Start (/start), затем повторите"
        out["error"] = error
    return out


WELCOME = ("✅ <b>Hyperliquid Radar подключён</b>\n"
           "Сюда будут приходить сделки автоторговли на Bybit, ошибки и открытия/закрытия "
           "отслеживаемых адресов.\n/status — состояние автоторговли")


def _answer_updates(status_text) -> None:
    """Reply to /start and /status from the configured chat (long polling)."""
    offset = 0
    token, chat, base = _config()
    if token and chat:
        # Tell the panel up front when the owner has not pressed Start yet.
        try:
            query = urllib.parse.urlencode({"chat_id": chat})
            urllib.request.urlopen(urllib.request.Request(f"{base}/bot{token}/getChat?{query}",
                                                          headers={"User-Agent": USER_AGENT}), timeout=15).read()
        except urllib.error.HTTPError as error:
            if error.code == 400:
                with _LOCK:
                    STATUS["lastError"] = "чат не найден — откройте бота в Telegram и нажмите Start"
        except Exception:  # noqa: BLE001
            pass
    while True:
        token, chat, base = _config()
        if not (token and chat):
            time.sleep(60)
            continue
        query = urllib.parse.urlencode({"timeout": 50, "offset": offset, "allowed_updates": '["message"]'})
        try:
            request = urllib.request.Request(f"{base}/bot{token}/getUpdates?{query}", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=65) as response:
                payload = json.loads(response.read() or b"{}")
        except Exception:  # noqa: BLE001 - network hiccups: try again later
            time.sleep(15)
            continue
        for update in payload.get("result") or []:
            offset = max(offset, int(update.get("update_id", 0)) + 1)
            message = update.get("message") or {}
            if str((message.get("chat") or {}).get("id")) != chat:
                continue
            text = str(message.get("text") or "").strip().lower()
            key = f"update:{update.get('update_id')}"
            if text.startswith("/status") and status_text:
                try:
                    send(status_text(), dedupe_key=key)
                except Exception as error:  # noqa: BLE001
                    send(f"Не удалось получить статус: {error}", dedupe_key=key)
            else:
                send(WELCOME, dedupe_key=key)
        if not payload.get("ok", False):
            time.sleep(15)


def start_updates(status_text=None) -> None:
    threading.Thread(target=_answer_updates, args=(status_text,), daemon=True, name="telegram-updates").start()


# ------------------------------------------------------------ formatters

def short(address: object) -> str:
    address = str(address or "")
    return f"{address[:6]}…{address[-4:]}" if len(address) > 12 else address


def money(value: object) -> str:
    try:
        return f"${float(value):,.2f}"
    except (TypeError, ValueError):
        return "—"

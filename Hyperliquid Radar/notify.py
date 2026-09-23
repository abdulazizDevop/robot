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
    TELEGRAM_CHAT_ID     numeric chat id; several separated by commas all get every message
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
# Queue items are (text, chat): chat None means every configured chat.
_QUEUE: collections.deque[tuple[str, str | None]] = collections.deque()
_BULK: collections.deque[tuple[str, str | None]] = collections.deque()
_BULK_TIMES: collections.deque[float] = collections.deque()
_RECENT: dict[str, float] = {}
_WORKER: threading.Thread | None = None
STATUS = {"sent": 0, "failed": 0, "dropped": 0, "lastOkAt": 0}
# Per chat: {"ok": bool | None, "error": str | None, "lastOkAt": ms}
CHATS: dict[str, dict] = {}
NOT_STARTED = "чат не найден — откройте бота в Telegram и нажмите Start"


def _config() -> tuple[str, list[str], str]:
    raw = os.environ.get("TELEGRAM_CHAT_ID", "")
    chats = []
    for part in raw.replace(";", ",").replace(" ", ",").split(","):
        if part.strip() and part.strip() not in chats:
            chats.append(part.strip())
    return (
        os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(),
        chats,
        os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/"),
    )


def configured() -> bool:
    token, chats, _ = _config()
    return bool(token and chats)


def watchlist_enabled() -> bool:
    return os.environ.get("TELEGRAM_WATCHLIST", "1").strip() not in ("0", "false", "no", "off")


def _chat_state(chat: str) -> dict:
    return CHATS.setdefault(chat, {"ok": None, "error": None, "lastOkAt": 0})


def status() -> dict:
    _, chats, _ = _config()
    with _LOCK:
        out = dict(STATUS)
        out["queued"] = len(_QUEUE) + len(_BULK)
        per_chat = {chat: dict(_chat_state(chat)) for chat in chats}
    out["configured"] = configured()
    out["chats"] = per_chat
    errors = [f"{chat}: {state['error']}" for chat, state in per_chat.items() if state["ok"] is False and state["error"]]
    out["lastError"] = "; ".join(errors) or None
    return out


def _post(text: str, chat: str) -> tuple[bool, float]:
    """Send one message to one chat. Returns (ok, retry_after); -1 = will not work until fixed."""
    token, _, base = _config()
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
        now = int(time.time() * 1000)
        with _LOCK:
            STATUS["sent"] += 1
            STATUS["lastOkAt"] = now
            _chat_state(chat).update(ok=True, error=None, lastOkAt=now)
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
        if "chat not found" in detail.lower() or "bot can't initiate" in detail.lower() or "blocked" in detail.lower():
            message = NOT_STARTED
        if error.code in (400, 401, 403, 404):
            retry_after = -1.0
    except Exception as error:  # noqa: BLE001 - a notifier must never raise into trading
        message = f"{type(error).__name__}: {error}"
    with _LOCK:
        STATUS["failed"] += 1
        _chat_state(chat).update(ok=False, error=message)
    return False, retry_after


def _worker() -> None:
    while True:
        with _WAKE:
            while not _QUEUE and not _BULK:
                _WAKE.wait()
            bulk = not _QUEUE
            text, chat = _QUEUE.popleft() if _QUEUE else _BULK.popleft()
        _, chats, _ = _config()
        targets = [chat] if chat else chats
        for target in targets:
            if bulk:
                with _LOCK:
                    if _chat_state(target)["ok"] is False and _chat_state(target)["error"] == NOT_STARTED:
                        continue  # whale events wait until this chat presses Start
            ok, retry_after = _post(text, target)
            if not ok and 0 < retry_after <= 60:
                time.sleep(retry_after)
                _post(text, target)
            time.sleep(MIN_GAP_SECONDS)


def _ensure_worker() -> None:
    global _WORKER
    if _WORKER is None or not _WORKER.is_alive():
        _WORKER = threading.Thread(target=_worker, daemon=True, name="telegram")
        _WORKER.start()


def send(text: str, dedupe_key: str | None = None, bulk: bool = False, chat: str | None = None) -> bool:
    """Queue one message for every chat (or one chat). Identical keys inside five minutes are sent once."""
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
            _BULK.append((text, chat))
        else:
            if len(_QUEUE) >= QUEUE_LIMIT:
                _QUEUE.popleft()
                STATUS["dropped"] += 1
            _QUEUE.append((text, chat))
        _ensure_worker()
        _WAKE.notify()
    return True


def test_message() -> dict:
    """Synchronous probe for the «Проверить Telegram» button: one message to every chat."""
    if not configured():
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы на сервере"}
    _, chats, _ = _config()
    results = [_post("✅ Hyperliquid Radar: бот на связи. Сделки автоторговли и события отслеживаемых адресов будут приходить сюда.", chat)[0]
               for chat in chats]
    out = status()
    out["ok"] = all(results)
    out["delivered"] = sum(results)
    out["total"] = len(chats)
    if not out["ok"]:
        out["error"] = out.get("lastError") or "Telegram не принял сообщение"
    return out


WELCOME = ("✅ <b>Hyperliquid Radar подключён</b>\n"
           "Сюда будут приходить сделки автоторговли на Bybit, ошибки и открытия/закрытия "
           "отслеживаемых адресов.\n/status — состояние автоторговли")


def _probe_chats() -> None:
    """Tell the panel up front which chats have not pressed Start yet."""
    token, chats, base = _config()
    for chat in chats:
        try:
            query = urllib.parse.urlencode({"chat_id": chat})
            urllib.request.urlopen(urllib.request.Request(f"{base}/bot{token}/getChat?{query}",
                                                          headers={"User-Agent": USER_AGENT}), timeout=15).read()
        except urllib.error.HTTPError as error:
            if error.code == 400:
                with _LOCK:
                    _chat_state(chat).update(ok=False, error=NOT_STARTED)
        except Exception:  # noqa: BLE001
            pass


def _answer_updates(status_text) -> None:
    """Reply to /start and /status from the configured chats (long polling)."""
    offset = 0
    if configured():
        _probe_chats()
    while True:
        token, chats, base = _config()
        if not (token and chats):
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
            chat = str((message.get("chat") or {}).get("id"))
            if chat not in chats:
                continue
            text = str(message.get("text") or "").strip().lower()
            key = f"update:{update.get('update_id')}"
            if text.startswith("/status") and status_text:
                try:
                    send(status_text(), dedupe_key=key, chat=chat)
                except Exception as error:  # noqa: BLE001
                    send(f"Не удалось получить статус: {error}", dedupe_key=key, chat=chat)
            else:
                send(WELCOME, dedupe_key=key, chat=chat)
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

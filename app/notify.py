#!/usr/bin/env python3
"""Telegram push for the auto-trader.

The client asked to be told the moment the bot buys. A browser notification
cannot do that on an iPhone unless the site is installed as an app, and it dies
with the tab; a Telegram message arrives with the phone locked. So: one bot,
one chat, plain sendMessage over urllib — no dependency.

Every send runs on its own daemon thread and swallows its own failures. An
outage at Telegram must never delay or fail an order; the worst case is a
missed message, which the panel shows as ``last_error``.

Configuration (``.env``):
    TELEGRAM_BOT_TOKEN   from @BotFather
    TELEGRAM_CHAT_ID     the operator's numeric id (write to @userinfobot)
    TELEGRAM_API_BASE    tests only — point at a local fake instead of Telegram
"""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = 'LiquidationRadar/1.0'
SEND_TIMEOUT = 10
# Identical text inside this window is sent once. The follower re-evaluates the
# same signal every poll, and a stuck error would otherwise page every 3 s.
DEDUPE_SECONDS = 300.0

_LOCK = threading.Lock()
_RECENT = {}
STATUS = {'sent': 0, 'failed': 0, 'last_ok_at': 0, 'last_error': None, 'last_text': None}


def _config():
    return (os.environ.get('TELEGRAM_BOT_TOKEN', '').strip(),
            os.environ.get('TELEGRAM_CHAT_ID', '').strip(),
            os.environ.get('TELEGRAM_API_BASE', 'https://api.telegram.org').rstrip('/'))


def configured():
    """True when both the token and the chat id are present."""
    token, chat, _ = _config()
    return bool(token and chat)


def status():
    with _LOCK:
        out = dict(STATUS)
    out['configured'] = configured()
    return out


def _post(text):
    token, chat, base = _config()
    body = urllib.parse.urlencode({
        'chat_id': chat, 'text': text, 'parse_mode': 'HTML',
        'disable_web_page_preview': 'true',
    }).encode()
    request = urllib.request.Request(
        f'{base}/bot{token}/sendMessage', data=body, method='POST',
        headers={'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT) as response:
            payload = json.loads(response.read() or b'{}')
        if not payload.get('ok', False):
            raise RuntimeError(str(payload.get('description') or payload)[:200])
        with _LOCK:
            STATUS['sent'] += 1
            STATUS['last_ok_at'] = int(time.time() * 1000)
            STATUS['last_error'] = None
            STATUS['last_text'] = text[:120]
        return True
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:200] if error.fp else ''
        message = f'HTTP {error.code} {detail}'.strip()
    except Exception as error:  # noqa: BLE001 - a notifier must never raise into trading
        message = f'{type(error).__name__}: {error}'
    with _LOCK:
        STATUS['failed'] += 1
        STATUS['last_error'] = message
    return False


def send(text, dedupe_key=None, wait=False):
    """Queue one message. Returns True if it was queued (or sent, with wait)."""
    if not configured():
        return False
    key = dedupe_key or text
    now = time.monotonic()
    with _LOCK:
        last = _RECENT.get(key)
        if last is not None and now - last < DEDUPE_SECONDS:
            return False
        _RECENT[key] = now
        if len(_RECENT) > 2048:
            # Bounded like every other in-memory map here.
            for stale in sorted(_RECENT, key=_RECENT.get)[:1024]:
                _RECENT.pop(stale, None)
    if wait:
        return _post(text)
    threading.Thread(target=_post, args=(text,), daemon=True, name='telegram-notify').start()
    return True


def test_message():
    """Synchronous probe for the panel's «Проверить» button."""
    if not configured():
        return {'ok': False, 'error': 'TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы в .env'}
    ok = _post('✅ Liquidation Radar: бот на связи. Уведомления о сделках будут приходить сюда.')
    out = status()
    out['ok'] = ok
    return out


# ------------------------------------------------------------ formatters
# Kept here so the wording lives in one place and the engine stays free of it.

def _short(address):
    address = str(address or '')
    return f'{address[:6]}…{address[-4:]}' if len(address) > 12 else address


def _money(value):
    try:
        return f'${float(value):,.2f}'
    except (TypeError, ValueError):
        return '—'


def order_filled(record, address=None, mode=None):
    side = 'LONG' if record.get('side') == 'BUY' else 'SHORT'
    tag = '' if (mode or record.get('mode')) == 'live' else f' [{mode or record.get("mode")}]'
    lines = [
        f'🟢 <b>Купил {record.get("coin")} {side}</b>{tag}',
        f'{_money(record.get("usd"))} · {record.get("qty")} @ {record.get("price")}',
        f'{record.get("order_type")} · {record.get("leverage")}x · {record.get("venue")}',
    ]
    if address:
        lines.append(f'кит {_short(address)} · вход {record.get("whale_price")} · откл. {float(record.get("deviation_pct") or 0):.2f}%')
    if record.get('status'):
        lines.append(f'статус: {record["status"]}')
    return '\n'.join(lines)


def order_failed(coin, side, error, address=None):
    side_text = 'LONG' if side == 'BUY' else 'SHORT'
    text = f'🔴 <b>Ордер не прошёл: {coin} {side_text}</b>\n{str(error)[:300]}'
    if address:
        text += f'\nкит {_short(address)}'
    return text


def position_closed(coin, side, reason, price=None, address=None, mode=None):
    side_text = 'LONG' if side == 'BUY' else 'SHORT'
    tag = '' if mode == 'live' else (f' [{mode}]' if mode else '')
    text = f'⚪ <b>Закрыл {coin} {side_text}</b>{tag}\n{reason}'
    if price:
        text += f'\nцена {price}'
    if address:
        text += f'\nкит {_short(address)}'
    return text


def engine_started(target, mode, venue):
    where = f'цель {_short(target)}' if target else 'цель выбирает радар'
    return f'▶️ <b>Автоторговля запущена</b>\n{where} · {mode} · {venue}'


def engine_stopped():
    return '⏹ <b>Автоторговля остановлена</b>'


def engine_error(error):
    return f'⚠️ <b>Ошибка движка</b>\n{str(error)[:300]}'

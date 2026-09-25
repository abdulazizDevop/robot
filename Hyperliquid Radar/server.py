#!/usr/bin/env python3
"""Authenticated, dependency-free HTTP server for Hyperliquid Radar.

Serves the page behind the password screen, proxies the push API, and runs the
Bybit auto-trading backend (autotrade.py) that used to exist only in the
Windows server.ps1.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import autotrade
import notify

ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / "exports"
EXPORTS.mkdir(exist_ok=True)
PORT = int(os.environ.get("RADAR_PORT", "8765"))
PUSH_PORT = int(os.environ.get("RADAR_PUSH_PORT", "8766"))
PASSWORD = os.environ.get("RADAR_PASSWORD", "Ask8150")
SESSION_SECRET = os.environ.get("RADAR_SESSION_SECRET", secrets.token_hex(32)).encode("utf-8")
# The code is asked once per device; after that the browser stays signed in.
SESSION_SECONDS = int(float(os.environ.get("RADAR_SESSION_DAYS", "30")) * 24 * 60 * 60)
LOCK_SECONDS = 60 * 60
MAX_ATTEMPTS = 3
FILENAME = re.compile(r"^[A-Za-z0-9._-]+\.csv$")
LOGIN_ATTEMPTS: dict[str, tuple[int, float]] = {}
# Only these files are served. Everything else in the folder (push keys,
# Bybit keys, exports, sources) stays private even to a signed-in browser.
STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "sw.js": "text/javascript; charset=utf-8",
}
# push-server.js authenticates to /internal/* with this token. Both services
# run as the same user and read it from the private data directory.
INTERNAL_TOKEN_FILE = autotrade.DATA_DIR / "internal.token"


def internal_token() -> str:
    try:
        token = INTERNAL_TOKEN_FILE.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    except OSError:
        pass
    token = secrets.token_hex(32)
    autotrade._write_private(INTERNAL_TOKEN_FILE, token)
    return token


INTERNAL_TOKEN = internal_token()


def session_cookie(token: str, secure: bool) -> str:
    flags = [f"radar_session={token}", "Path=/", f"Max-Age={SESSION_SECONDS}", "HttpOnly", "SameSite=Lax"]
    if secure:
        flags.append("Secure")
    return "; ".join(flags)


def expired_cookie(secure: bool) -> str:
    flags = ["radar_session=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]
    if secure:
        flags.append("Secure")
    return "; ".join(flags)


def make_session() -> str:
    payload = f"{int(time.time()) + SESSION_SECONDS}.{secrets.token_urlsafe(24)}"
    signature = hmac.new(SESSION_SECRET, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    raw = f"{payload}.{signature}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def valid_session(value: str) -> bool:
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8")
        expiry, nonce, signature = raw.split(".", 2)
        payload = f"{expiry}.{nonce}"
        expected = hmac.new(SESSION_SECRET, payload.encode("utf-8"), hashlib.sha256).hexdigest()
        return int(expiry) >= int(time.time()) and hmac.compare_digest(signature, expected)
    except (ValueError, TypeError, UnicodeError):
        return False


def client_key(handler: BaseHTTPRequestHandler) -> str:
    forwarded = handler.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
    return forwarded or handler.client_address[0]


def login_page(message: str = "", status: int = HTTPStatus.OK) -> tuple[int, bytes]:
    note = f'<p class="error">{html.escape(message)}</p>' if message else ""
    body = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход · Hyperliquid Radar</title>
<style>html,body{{margin:0;min-height:100%;background:#071014;color:#e8f1ed;font:15px Segoe UI,system-ui,sans-serif}}body{{display:grid;place-items:center;padding:24px}}main{{width:min(390px,100%);background:#0c171c;border:1px solid #29434a;padding:28px;box-shadow:0 16px 50px #0006}}h1{{font-size:21px;margin:0 0 8px}}p{{color:#9bb5ae;margin:0 0 20px}}label{{display:block;color:#b9cbc4;font-size:13px;margin-bottom:7px}}input{{box-sizing:border-box;width:100%;padding:12px;border:1px solid #34545b;background:#091419;color:#e8f1ed;border-radius:4px;font:inherit}}button{{width:100%;margin-top:16px;padding:12px;border:1px solid #52e0a0;background:#52e0a0;color:#062017;border-radius:4px;font-weight:700;font:inherit;cursor:pointer}}.error{{color:#ff9aaa;margin:0 0 16px}}</style></head>
<body><main><h1>Hyperliquid Radar</h1><p>Введите пароль для доступа</p>{note}<form method="post" action="/login"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required><button type="submit">Войти</button></form></main></body></html>"""
    return status, body.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "HyperliquidRadar/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        # push-server.js checks in every few seconds; that is not worth a log line.
        if getattr(self, "path", "").startswith("/internal/") and len(args) > 1 and str(args[1]) == "200":
            return
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def _secure(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def _headers(self, content_type: str, length: int, no_store: bool = True) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz https://api.bybit.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if no_store:
            self.send_header("Cache-Control", "no-store")

    def _bytes(self, status: int, data: bytes, content_type: str = "text/plain; charset=utf-8", cookie: str | None = None) -> None:
        self.send_response(status)
        self._headers(content_type, len(data))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, value: object, cookie: str | None = None) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._bytes(status, data, "application/json; charset=utf-8", cookie)

    def _redirect(self, location: str, cookie: str | None = None) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self._headers("text/plain; charset=utf-8", 0)
        self.send_header("Location", location)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _authenticated(self) -> bool:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        value = cookie.get("radar_session")
        return bool(value and valid_session(value.value))

    def _require_auth(self, html_request: bool = False) -> bool:
        if self._authenticated():
            return True
        if html_request:
            self._redirect("/login")
        else:
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "authentication required"})
        return False

    def _read_body(self, limit: int = 20 * 1024 * 1024) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > limit:
            raise ValueError("invalid request size")
        return self.rfile.read(length)

    def _internal_ok(self) -> bool:
        # Caddy always adds X-Forwarded-For, so a request that carries it came
        # from the internet, whatever token it presents.
        supplied = self.headers.get("X-Radar-Internal", "")
        if self.headers.get("X-Forwarded-For") or not hmac.compare_digest(supplied.encode(), INTERNAL_TOKEN.encode()):
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "forbidden"})
            return False
        return True

    def _json_body(self, limit: int = 64 * 1024) -> object:
        if int(self.headers.get("Content-Length", "0") or 0) <= 0:
            return {}
        return json.loads(self._read_body(limit).decode("utf-8"))

    def _autotrade_post(self, path: str) -> None:
        try:
            data = self._json_body()
            if path == "/autotrade/config":
                self._json(HTTPStatus.OK, autotrade.save_config(data))
            elif path == "/autotrade/signal":
                self._json(HTTPStatus.OK, autotrade.browser_signal(data))
            elif path == "/autotrade/close-position":
                symbol = str((data if isinstance(data, dict) else {}).get("symbol") or "")
                self._json(HTTPStatus.OK, autotrade.close_position(symbol))
            elif path == "/autotrade/close-all":
                results = autotrade.close_all_positions()
                self._json(HTTPStatus.OK, {"ok": True, "results": results})
            else:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
        except autotrade.AutoTradeError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Неверный запрос: {error}"})

    def _proxy_push(self, method: str) -> None:
        target = f"http://127.0.0.1:{PUSH_PORT}{self.path}"
        data = self._read_body(2_000_000) if method == "POST" else None
        request = urllib.request.Request(target, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = response.read(20 * 1024 * 1024)
                self._bytes(response.status, body, response.headers.get("Content-Type", "application/json; charset=utf-8"))
        except urllib.error.HTTPError as error:
            self._bytes(error.code, error.read(), error.headers.get("Content-Type", "application/json; charset=utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            self._json(HTTPStatus.BAD_GATEWAY, {"ok": False, "error": f"push service unavailable: {error}"})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/login":
            key = client_key(self)
            now = time.time()
            failures, locked_until = LOGIN_ATTEMPTS.get(key, (0, 0.0))
            if locked_until > now:
                remaining = max(1, int(locked_until - now))
                status, data = login_page("Слишком много попыток. Повторите через 1 час.", HTTPStatus.TOO_MANY_REQUESTS)
                self.send_response(status)
                self.send_header("Retry-After", str(remaining))
                self._headers("text/html; charset=utf-8", len(data))
                self.end_headers()
                self.wfile.write(data)
                return
            try:
                raw = self._read_body(4096).decode("utf-8")
                if "application/json" in self.headers.get("Content-Type", ""):
                    supplied = str(json.loads(raw).get("password", ""))
                else:
                    supplied = parse_qs(raw).get("password", [""])[0]
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                supplied = ""
            # Case-insensitive: the code was handed out as "ask8150" while the
            # server holds "Ask8150", and phones capitalise the first letter.
            if hmac.compare_digest(supplied.strip().casefold().encode("utf-8"), PASSWORD.strip().casefold().encode("utf-8")):
                LOGIN_ATTEMPTS.pop(key, None)
                self._redirect("/", session_cookie(make_session(), self._secure()))
                return
            failures += 1
            if failures >= MAX_ATTEMPTS:
                LOGIN_ATTEMPTS[key] = (0, now + LOCK_SECONDS)
                message = "Три неверные попытки. Вход заблокирован на 1 час."
            else:
                LOGIN_ATTEMPTS[key] = (failures, 0.0)
                message = f"Неверный пароль. Осталось попыток: {MAX_ATTEMPTS - failures}."
            status, data = login_page(message, HTTPStatus.UNAUTHORIZED)
            self.send_response(status)
            self._headers("text/html; charset=utf-8", len(data))
            self.end_headers()
            self.wfile.write(data)
            return

        if path.startswith("/push/"):
            if self._require_auth():
                self._proxy_push("POST")
            return

        if path.startswith("/internal/"):
            if not self._internal_ok():
                return
            try:
                data = self._json_body(4 * 1024 * 1024)
                if path == "/internal/fills":
                    self._json(HTTPStatus.OK, autotrade.handle_fills(data.get("items") if isinstance(data, dict) else data))
                elif path == "/internal/listener":
                    self._json(HTTPStatus.OK, autotrade.listener_sync(data if isinstance(data, dict) else {}))
                else:
                    self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            except (ValueError, json.JSONDecodeError) as error:
                self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return

        if path.startswith("/autotrade/"):
            if self._require_auth():
                self._autotrade_post(path)
            return

        if path == "/telegram/test":
            if self._require_auth():
                result = notify.test_message()
                self._json(HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_GATEWAY, result)
            return

        if path != "/save-export":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self._require_auth():
            return
        try:
            payload = json.loads(self._read_body().decode("utf-8"))
            name = str(payload.get("filename", ""))
            content = str(payload.get("content", ""))
            if not FILENAME.fullmatch(name):
                raise ValueError("invalid export filename")
            (EXPORTS / name).write_text(content, encoding="utf-8-sig")
            self._json(HTTPStatus.OK, {"ok": True, "filename": name})
        except (ValueError, json.JSONDecodeError, OSError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/login":
            if self._authenticated():
                self._redirect("/")
                return
            status, data = login_page()
            self._bytes(status, data, "text/html; charset=utf-8")
            return
        if path == "/logout":
            self._redirect("/login", expired_cookie(self._secure()))
            return
        if path.startswith("/push/"):
            if self._require_auth():
                self._proxy_push("GET")
            return
        if path == "/autotrade/status":
            if self._require_auth():
                self._json(HTTPStatus.OK, autotrade.status())
            return
        if path == "/autotrade/log":
            if self._require_auth():
                self._json(HTTPStatus.OK, {"ok": True, "events": autotrade.recent_events(200)})
            return
        if path == "/autotrade/positions":
            if self._require_auth():
                self._json(HTTPStatus.OK, {"ok": True, "positions": autotrade.open_positions()})
            return
        if not self._require_auth(html_request=True):
            return
        requested = path.lstrip("/") or "index.html"
        content_type = STATIC_FILES.get(requested)
        candidate = ROOT / requested
        if content_type is None or not candidate.is_file():
            self._bytes(HTTPStatus.NOT_FOUND, b"not found\n")
            return
        self._bytes(HTTPStatus.OK, candidate.read_bytes(), content_type)


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    notify.start_updates(autotrade.telegram_status_text)
    threading.Thread(target=autotrade.cancel_stale_orders, daemon=True, name="stale-orders").start()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Hyperliquid Radar listening on http://127.0.0.1:{PORT}/ · telegram "
          f"{'on' if notify.configured() else 'off'} · autotrade data in {autotrade.DATA_DIR}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

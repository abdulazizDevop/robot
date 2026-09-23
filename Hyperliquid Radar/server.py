#!/usr/bin/env python3
"""Small dependency-free server for the Hyperliquid Radar web app."""
from __future__ import annotations

import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / "exports"
EXPORTS.mkdir(exist_ok=True)
PORT = int(os.environ.get("RADAR_PORT", "8765"))
FILENAME = re.compile(r"^[A-Za-z0-9._-]+\.csv$")


class Handler(BaseHTTPRequestHandler):
    server_version = "HyperliquidRadar/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def _json(self, status: int, value: object) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path != "/save-export":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 20 * 1024 * 1024:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            name = str(payload.get("filename", ""))
            content = str(payload.get("content", ""))
            if not FILENAME.fullmatch(name):
                raise ValueError("invalid export filename")
            target = EXPORTS / name
            target.write_text(content, encoding="utf-8-sig")
            self._json(HTTPStatus.OK, {"ok": True, "filename": name})
        except (ValueError, json.JSONDecodeError, OSError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        requested = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        candidate = (ROOT / requested).resolve()
        if ROOT not in candidate.parents and candidate != ROOT:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Hyperliquid Radar listening on http://127.0.0.1:{PORT}/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

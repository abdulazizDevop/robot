#!/usr/bin/env python3
"""Container healthcheck: the API answers and the process is not wedged.

Kept as a file rather than an inline `python -c` so the Dockerfile has no
fragile shell quoting, and so it can be run by hand while debugging a host.
"""
import base64
import os
import sys
import urllib.error
import urllib.request

url = f'http://127.0.0.1:{os.environ.get("PORT", "4174")}/api/health'
request = urllib.request.Request(url)
password = os.environ.get('RADAR_PASSWORD', '').strip()
if password:
    token = base64.b64encode(
        f'{os.environ.get("RADAR_USER", "radar").strip()}:{password}'.encode()).decode()
    request.add_header('Authorization', 'Basic ' + token)

try:
    with urllib.request.urlopen(request, timeout=5) as response:
        sys.exit(0 if response.status == 200 else 1)
except (urllib.error.URLError, OSError, TimeoutError) as error:
    print(f'healthcheck failed: {error}', file=sys.stderr)
    sys.exit(1)

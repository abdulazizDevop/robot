FROM python:3.12-slim

# The radar and the dry-run path are stdlib-only.  These two packages exist
# solely to sign Hyperliquid orders in testnet/live mode.  Some of their
# transitive dependencies ship source-only wheels, so the toolchain is
# installed for the build and removed in the same layer.
COPY requirements.txt /tmp/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ libc6-dev \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && apt-get purge -y gcc g++ libc6-dev \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/requirements.txt

WORKDIR /app

# Source only.  Databases, .env and reports arrive through volumes, so secrets
# are never baked into an image and captured history survives a redeploy.
COPY server.py trading.py autotrade.py healthcheck.py ./
COPY web/ ./web/

RUN useradd --create-home --uid 10001 radar \
    && mkdir -p /app/data /app/reports \
    && chown -R radar:radar /app
USER radar

ENV HOST=0.0.0.0 \
    PORT=4174 \
    DATA_DIR=/app/data \
    REPORT_DIR=/app/reports \
    PYTHONUNBUFFERED=1

EXPOSE 4174

HEALTHCHECK --interval=30s --timeout=8s --start-period=15s --retries=3 \
    CMD ["python3", "/app/healthcheck.py"]

CMD ["python3", "server.py"]

# Timeweb Cloud — what to order and why

## Recommended: Cloud VPS, not shared hosting or Apps

Timeweb's shared hosting and its "Приложения" (Apps) product both expect a
request/response web app. This one is different in three ways that rule them
out:

- It runs **background threads** that must keep working with nobody on the site
  (the radar scans every 30 s, the follower polls every 3 s). Shared hosting
  suspends idle processes.
- It needs **persistent local disk** for the SQLite databases.
- It holds an **exchange private key** in the process, so you want the isolation
  of your own VM.

So: **Облачные серверы (Cloud VPS)**.

## Sizing

Measured on the running app with both the radar and the follower active:
**70 MB RSS**, **2.7 % of one core**, 5 threads, and ~41 MB of database after
retention plus a VACUUM. It is a small workload; the sizing below is headroom,
not need.

| | Recommendation |
|---|---|
| **Configuration** | 2 vCPU / 2 GB RAM / 40 GB NVMe |
| **Minimum that works** | 1 vCPU / 1 GB RAM / 15 GB |
| **OS** | Ubuntu 24.04 LTS |
| **Location** | **Netherlands (Amsterdam)** — see below |

2 GB is the recommendation rather than 1 GB because the 12 h and 24 h whale
reports build large Python structures in memory, and a Docker build of
`eth-account` needs headroom. `MemoryMax=768M` caps the app itself, so 1 GB does
work — it is just tighter during builds.

40 GB gives room for database growth before retention settles, plus backups.

### Location matters more than size

Latency to the exchange is on the critical path: the whole point is entering
before the price moves 0.5 %.

- Hyperliquid's API is fronted by Cloudflare; European egress is good.
- **Bybit blocks or degrades some Russian IP ranges.** If you plan to trade
  Bybit, do not put the server in a Russian datacentre.

Timeweb offers **Нидерланды (Amsterdam)**, **Казахстан**, **Польша** and Russian
regions. Pick **Amsterdam** for the best path to both exchanges. Kazakhstan is
the fallback if you need to stay closer to home.

Check it before you commit — from a trial server:

```bash
curl -o /dev/null -s -w 'hyperliquid: %{time_total}s\n' \
  -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' -d '{"type":"allMids"}'
curl -o /dev/null -s -w 'bybit:       %{time_total}s\n' \
  'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'
```

Read the *breakdown*, not the total. Measured on the Amsterdam box actually in
use:

```
ping to the API edge      1 ms      <- this is what the region buys you
DNS                      35 ms
TCP + TLS handshake      66 ms
Hyperliquid's own reply ~220 ms     <- same for everyone, not a region problem
total per request       ~285 ms
```

`allMids` returns all 947 coins, so most of the total is the exchange thinking,
not the network. Judge the region by **ping and TCP connect**: ~1 ms means the
CDN edge is local and you cannot do better. A total of ~285 ms with a 1 ms ping
is a healthy result, not a slow one.

What actually means "change region": an HTTP **403** from Bybit, packet loss, or
a ping over ~50 ms.

### A fixed IP is not optional

Both exchanges let you restrict an API key to specific IPs, and you should.
Timeweb VPS come with a dedicated IPv4 — keep it, and do not enable any
floating/NAT option that could change it. Note the address and put it in the
Bybit key's IP allowlist.

## Order checklist

1. **Облачные серверы** → Ubuntu 24.04 → 2 vCPU / 2 GB / 40 GB NVMe → Amsterdam.
2. Add your SSH key during creation. Do not use password login.
3. Enable Timeweb's automatic backups (or the snapshot schedule) — cheap
   insurance for the databases.
4. Note the IPv4 address.
5. A domain is optional: `deploy/setup-tls.sh` falls back to
   `<your-ip>.sslip.io`, which is a real DNS name, so Let's Encrypt still
   issues a certificate. Use a real domain for anything long-lived — sslip.io
   is a free third-party service and the panel stops loading if it ever goes
   away.

## First 15 minutes on the box

```bash
ssh root@YOUR_IP

# 1. basic hardening
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy/
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# 2. firewall — only SSH and HTTPS reach the internet
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw enable

# 3. automatic security updates
apt-get update && apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# 4. cap the journal so logs cannot fill the disk
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=1month\n' \
  > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

# 5. swap — 2 GB box, keeps a spike from OOM-killing the app
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 6. clock — signed exchange requests fail if it drifts
timedatectl set-ntp true && timedatectl status | grep -i sync
```

Step 6 matters: Bybit rejects a request whose timestamp is outside
`recv_window` (5 s), so a drifting clock shows up as random signature errors.

Then follow [DEPLOY.md](DEPLOY.md).

## Cost expectation

A 2 vCPU / 2 GB / 40 GB Ubuntu VPS in Amsterdam is Timeweb's low-to-mid tier —
budget roughly 500–900 ₽/month, plus a little for backups. Prices move; check
the current tariff page. The app has no other running cost: every data source it
depends on is free, and the only optional paid key is Arkham.

## Keeping it alive

The app already restarts itself (`Restart=always`). What Timeweb adds:

- **Snapshots / backups** — enable them. `/var/lib/liquidation-radar` is the
  only thing you cannot rebuild.
- **Monitoring** — Timeweb's panel alerts on CPU/RAM/disk. Set a disk alert at
  80 %; the databases are the only thing that grows.
- **Uptime check** — point any external uptime monitor at `https://your.domain/`
  and expect a **401**. That proves nginx, TLS and the app are all up, without
  giving the monitor a password.

For a client-facing deployment also do this, since neither is automatic:

1. A weekly `sqlite3 ... 'VACUUM;'` after retention has been running (see
   [OPERATIONS.md](OPERATIONS.md)).
2. An off-box copy of the backups. A snapshot in the same account is not a
   backup if the account is lost.

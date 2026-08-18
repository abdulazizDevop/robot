#!/usr/bin/env python3
import base64, csv, hashlib, hmac, io, json, os, re, sqlite3, statistics, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from zoneinfo import ZoneInfo
import autotrade, trading

ROOT=os.path.dirname(os.path.abspath(__file__))
# Databases and mutable state live in DATA_DIR.  It defaults to the source
# directory so a local checkout behaves exactly as before; in Docker it points
# at a mounted volume so a redeploy never wipes captured history.
DATA_DIR=os.environ.get('DATA_DIR','').strip() or os.path.join(ROOT,'data')
WEB_DIR=os.environ.get('WEB_DIR','').strip() or os.path.join(ROOT,'web')
os.makedirs(DATA_DIR,exist_ok=True)
DB=os.path.join(DATA_DIR,'radar.sqlite3'); RADAR_DB=os.path.join(DATA_DIR,'hyperliquid_radar.sqlite3'); ONCHAIN_ADDRESSES=os.path.join(DATA_DIR,'onchain_addresses.json'); SAVED_ADDRESSES=os.path.join(DATA_DIR,'saved_addresses.json'); SAVED_ADDRESSES_LOCK=threading.Lock(); ONCHAIN_LOCK=threading.Lock(); ENV_PATH=os.path.join(DATA_DIR,'.env'); ENV_LOCK=threading.Lock()
def load_env():
    path=ENV_PATH
    if not os.path.exists(path): return
    for raw in open(path,encoding='utf-8'):
        line=raw.strip()
        if line and not line.startswith('#') and '=' in line:
            key,value=line.split('=',1); os.environ.setdefault(key.strip(),value.strip().strip('"').strip("'"))
load_env()
# Deployment surface.  Locally everything stays on the loopback with no
# password; on a server the app is only allowed to listen publicly once a
# password is set, because a reachable UI can place real orders.
BIND_HOST=os.environ.get('HOST','127.0.0.1').strip() or '127.0.0.1'
AUTH_USER=os.environ.get('RADAR_USER','radar').strip()
AUTH_PASSWORD=os.environ.get('RADAR_PASSWORD','').strip()
REPORT_DIR=os.environ.get('REPORT_DIR','').strip() or os.path.expanduser('~/Desktop')
# SimpleHTTPRequestHandler would otherwise serve every file next to it,
# including .env and the SQLite databases.  Only these are public.
STATIC_FILES={'/':'index.html','/index.html':'index.html','/enhancements.js':'enhancements.js','/autotrade.js':'autotrade.js','/favicon.ico':'favicon.ico'}
STATIC_TYPES={'html':'text/html; charset=utf-8','js':'application/javascript; charset=utf-8','css':'text/css; charset=utf-8','ico':'image/x-icon'}
ARKHAM_API_KEY=os.environ.get('ARKHAM_API_KEY','').strip()
ARKHAM_API_URL=os.environ.get('ARKHAM_API_URL','https://api.arkm.com').rstrip('/')
BSCSCAN_API_KEY=os.environ.get('BSCSCAN_API_KEY','').strip()

def bybit_config():
    return {
        'api_key': os.environ.get('BYBIT_API_KEY','').strip(),
        'api_secret': os.environ.get('BYBIT_API_SECRET','').strip(),
        'testnet': os.environ.get('BYBIT_TESTNET','false').strip().lower() in ('1','true','yes','on'),
        'key_type': 'HMAC',
    }

def mask_api_key(value):
    value=str(value or '')
    if not value: return ''
    if len(value) <= 8: return '****'
    return value[:4]+'...'+value[-4:]

def update_env_file(values):
    """Update only known settings and keep user comments/unknown settings intact."""
    clean={}
    for key, value in values.items():
        value=str(value or '').strip()
        if '\n' in value or '\r' in value:
            raise ValueError('Значение .env не может содержать перенос строки')
        clean[key]=value
    with ENV_LOCK:
        try:
            with open(ENV_PATH, encoding='utf-8') as handle:
                lines=handle.readlines()
        except FileNotFoundError:
            lines=[]
        seen=set(); output=[]
        for raw in lines:
            match=re.match(r'^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*?)(\r?\n)?$', raw)
            if match and match.group(2) in clean:
                key=match.group(2); output.append(f'{key}={clean[key]}\n'); seen.add(key)
            else:
                output.append(raw)
        if output and not output[-1].endswith('\n'): output[-1]+='\n'
        for key, value in clean.items():
            if key not in seen: output.append(f'{key}={value}\n')
        temporary=ENV_PATH+'.tmp'
        flags=os.O_WRONLY|os.O_CREAT|os.O_TRUNC
        fd=os.open(temporary, flags, 0o600)
        try:
            with os.fdopen(fd,'w',encoding='utf-8') as handle: handle.writelines(output)
        except Exception:
            try: os.close(fd)
            except OSError: pass
            raise
        os.chmod(temporary,0o600); os.replace(temporary,ENV_PATH); os.chmod(ENV_PATH,0o600)
        for key, value in clean.items(): os.environ[key]=value

def bybit_status_payload():
    config=bybit_config()
    payload={
        'configured': bool(config['api_key'] and config['api_secret']),
        'connected': False,
        'key_type': config['key_type'],
        'environment': 'testnet' if config['testnet'] else 'mainnet',
        'key_masked': mask_api_key(config['api_key']),
        'checked_at': int(time.time()*1000),
    }
    if not payload['configured']:
        payload['error']='API-ключ не задан'
        return payload
    timestamp=str(int(time.time()*1000)); recv_window='5000'; query='accountType=UNIFIED'
    sign=hmac.new(config['api_secret'].encode('utf-8'), (timestamp+config['api_key']+recv_window+query).encode('utf-8'), hashlib.sha256).hexdigest()
    base='https://api-testnet.bybit.com' if config['testnet'] else 'https://api.bybit.com'
    url=base+'/v5/account/wallet-balance?'+query
    request=urllib.request.Request(url, headers={
        'User-Agent':'LiquidationRadar/1.0',
        'Accept':'application/json',
        'Content-Type':'application/json',
        'X-BAPI-API-KEY':config['api_key'],
        'X-BAPI-TIMESTAMP':timestamp,
        'X-BAPI-RECV-WINDOW':recv_window,
        'X-BAPI-SIGN':sign,
    })
    try:
        with urllib.request.urlopen(request, timeout=12) as response: result=json.loads(response.read())
        payload['ret_code']=result.get('retCode')
        if result.get('retCode') != 0:
            payload['error']='Bybit: '+str(result.get('retMsg') or 'проверка не пройдена')
            return payload
        accounts=result.get('result',{}).get('list') or []
        payload['connected']=True
        payload['account_type']=(accounts[0].get('accountType') if accounts else 'UNIFIED')
        payload.pop('error',None)
        return payload
    except urllib.error.HTTPError as error:
        payload['error']=f'Bybit HTTP {error.code}'
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason=getattr(error,'reason',None)
        payload['error']='Не удалось подключиться к Bybit: '+str(reason or error)
    except (ValueError, json.JSONDecodeError):
        payload['error']='Bybit вернул некорректный ответ'
    return payload
# Hyperliquid applies a shared rate limit to this IP.  Keep all routes behind one
# small queue and reuse short-lived real responses instead of issuing duplicate calls.
HL_LOCK=threading.Lock(); HL_CACHE={}; HL_NEXT_REQUEST_AT=0.0; HL_BLOCKED_UNTIL=0.0; HL_ALL_MARKET_CURSOR=0; HL_REQUEST_INTERVAL=1.0
# Every distinct userFillsByTime window is its own cache key, so an app left
# running for days would accumulate them without bound.  Cap both caches.
HL_CACHE_MAX=int(os.environ.get('HL_CACHE_MAX','2000')); DEX_CACHE_MAX=int(os.environ.get('DEX_CACHE_MAX','500'))
def evict_cache(cache,limit):
    """Drop the oldest quarter once the cap is passed. Caller holds the lock."""
    if len(cache)<=limit: return
    for stale in sorted(cache,key=lambda k:cache[k]['time'])[:max(1,len(cache)-limit)+limit//4]:
        cache.pop(stale,None)
HL_12H_REPORT_LOCK=threading.Lock(); HL_12H_REPORT_CACHE={}
HL_DEEP_PERSISTED_CACHE=os.path.join(DATA_DIR,'hyperliquid_24h_deep_cache.json')
HL_ACCOUNT_PERSISTED_CACHE=os.path.join(DATA_DIR,'hyperliquid_account_cache.json')
HL_FIRST_PROFIT_CACHE=os.path.join(DATA_DIR,'hyperliquid_first_profit_cache.json'); HL_FIRST_PROFIT_LOCK=threading.Lock()
HL_MARKETS=['BTC','ETH','SOL','HYPE','XRP','DOGE','SUI','AVAX','LINK','ARB']
DEX_LOCK=threading.Lock(); DEX_CACHE={}; DEX_RPC={'bsc':'https://bsc-rpc.publicnode.com','ethereum':'https://cloudflare-eth.com/','base':'https://mainnet.base.org'}
def sqlite_pragmas(c):
    """WAL plus a busy timeout: the radar thread, the auto-trader and the HTTP
    handlers all write, and the default rollback journal makes that fail with
    'database is locked' once the process has been up for a while."""
    c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA busy_timeout=15000'); c.execute('PRAGMA synchronous=NORMAL'); return c
def db():
    # Endpoints collect wallet data concurrently; each call still uses its own connection.
    c=sqlite_pragmas(sqlite3.connect(DB, check_same_thread=False, timeout=15)); c.row_factory=sqlite3.Row
    c.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    c.execute('CREATE TABLE IF NOT EXISTS onchain (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    c.execute('CREATE TABLE IF NOT EXISTS hyperliquid (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    c.execute('CREATE TABLE IF NOT EXISTS hl_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, coin TEXT NOT NULL, unrealized_pnl REAL NOT NULL DEFAULT 0, account_value REAL NOT NULL DEFAULT 0, payload TEXT NOT NULL, captured_at INTEGER NOT NULL)')
    c.execute('CREATE TABLE IF NOT EXISTS orderbook (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)'); c.commit(); return c
def read_db():
    c=db(); events=[json.loads(x['payload']) for x in c.execute('SELECT payload FROM events ORDER BY id DESC LIMIT 10000')]; onchain=[json.loads(x['payload']) for x in c.execute('SELECT payload FROM onchain ORDER BY id DESC LIMIT 20000')]; hyperliquid=[json.loads(x['payload']) for x in c.execute('SELECT payload FROM hyperliquid ORDER BY id DESC LIMIT 20000')]; orderbook=[json.loads(x['payload']) for x in c.execute('SELECT payload FROM orderbook ORDER BY id DESC LIMIT 10000')]; c.close(); return {'events':events,'onchain':onchain,'hyperliquid':hyperliquid,'orderbook':orderbook}
def append_rows(table,items):
    if not items:return
    c=db();c.executemany('INSERT INTO '+table+' (payload) VALUES (?)',[(json.dumps(x),) for x in items]);c.commit();c.close()
# radar.sqlite3 grows with every captured market trade.  read_db() reads the
# newest rows only, so anything past the cap is dead weight on disk and in the
# page cache.  Trim on a schedule instead of letting the file grow forever.
EVENT_RETENTION={'events':int(os.environ.get('KEEP_EVENTS','20000')),'hyperliquid':int(os.environ.get('KEEP_HYPERLIQUID','60000')),'onchain':int(os.environ.get('KEEP_ONCHAIN','40000')),'orderbook':int(os.environ.get('KEEP_ORDERBOOK','20000'))}
RETENTION_INTERVAL=float(os.environ.get('RETENTION_INTERVAL','3600'))
RETENTION_LOCK=threading.Lock(); RETENTION_LAST=0.0
def prune_events(force=False):
    global RETENTION_LAST
    now=time.monotonic()
    with RETENTION_LOCK:
        if not force and now-RETENTION_LAST<RETENTION_INTERVAL: return None
        RETENTION_LAST=now
    removed={}
    c=db()
    try:
        for table,keep in EVENT_RETENTION.items():
            if keep<=0: continue
            cursor=c.execute(f'DELETE FROM {table} WHERE id NOT IN (SELECT id FROM {table} ORDER BY id DESC LIMIT ?)',(keep,))
            removed[table]=cursor.rowcount
        c.commit()
    finally: c.close()
    return removed
def normalize_addresses(values):
    if isinstance(values,str): values=values.replace(';',',').split(',')
    result=[]
    for value in values or []:
        user=str(value).strip().lower()
        if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in result: result.append(user)
    return result
def _load_saved_addresses():
    try:
        with open(SAVED_ADDRESSES,encoding='utf-8') as f:return normalize_addresses(json.load(f))
    except (OSError,ValueError,TypeError):return []
def load_saved_addresses():
    with SAVED_ADDRESSES_LOCK:return _load_saved_addresses()
def save_saved_addresses(values):
    # Always merge with the file while holding the lock, so parallel clicks cannot
    # overwrite one another or insert a duplicate address.
    with SAVED_ADDRESSES_LOCK:
        addresses=normalize_addresses(_load_saved_addresses()+normalize_addresses(values))
        temporary=SAVED_ADDRESSES+'.tmp'
        with open(temporary,'w',encoding='utf-8') as f:json.dump(addresses,f,ensure_ascii=False,indent=2)
        os.replace(temporary,SAVED_ADDRESSES)
        return addresses
def load_onchain_addresses():
    try:
        with open(ONCHAIN_ADDRESSES,encoding='utf-8') as handle: return normalize_addresses(json.load(handle))
    except (OSError,ValueError,TypeError): return []
def save_onchain_address(value):
    address=normalize_addresses([value])
    if not address: raise ValueError('Некорректный EVM-адрес')
    with ONCHAIN_LOCK:
        addresses=normalize_addresses(load_onchain_addresses()+address)
        temporary=ONCHAIN_ADDRESSES+'.tmp'
        with open(temporary,'w',encoding='utf-8') as handle: json.dump(addresses,handle,ensure_ascii=False,indent=2)
        os.replace(temporary,ONCHAIN_ADDRESSES); return addresses

RADAR_LOCK=threading.Lock(); RADAR_STOP=threading.Event(); RADAR_THREAD=None
RADAR_STATE={'running':False,'scanning':False,'started_at':0,'last_scan_at':0,'last_error':None,'config':{'window_seconds':86400,'min_pnl':1500.0,'max_age_seconds':60}}
def radar_db():
    connection=sqlite_pragmas(sqlite3.connect(RADAR_DB,check_same_thread=False,timeout=15)); connection.row_factory=sqlite3.Row
    connection.execute('CREATE TABLE IF NOT EXISTS radar_addresses (address TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, last_scan INTEGER NOT NULL, account_age_days REAL NOT NULL, account_value REAL NOT NULL, closed_pnl REAL NOT NULL, open_pnl REAL NOT NULL, total_pnl REAL NOT NULL, pnl_duration_seconds REAL NOT NULL, window_seconds INTEGER NOT NULL, actions_json TEXT NOT NULL, positions_json TEXT NOT NULL)')
    connection.commit(); return connection
def radar_rows(limit=100):
    connection=radar_db(); rows=[dict(row) for row in connection.execute('SELECT * FROM radar_addresses ORDER BY last_seen DESC LIMIT ?',(limit,))]; connection.close()
    for row in rows:
        row['actions']=json.loads(row.pop('actions_json') or '{}'); row['positions']=json.loads(row.pop('positions_json') or '[]')
    return rows
def radar_upsert(row):
    connection=radar_db(); existing=connection.execute('SELECT first_seen FROM radar_addresses WHERE address=?',(row['address'],)).fetchone(); first_seen=int(existing['first_seen']) if existing else row['last_seen']
    connection.execute('INSERT OR REPLACE INTO radar_addresses (address,first_seen,last_seen,last_scan,account_age_days,account_value,closed_pnl,open_pnl,total_pnl,pnl_duration_seconds,window_seconds,actions_json,positions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(row['address'],first_seen,row['last_seen'],row['last_scan'],row['account_age_days'],row['account_value'],row['closed_pnl'],row['open_pnl'],row['total_pnl'],row['pnl_duration_seconds'],row['window_seconds'],json.dumps(row['actions']),json.dumps(row['positions'])))
    connection.commit(); connection.close()
def radar_start_state(item,worker):
    """Radar state transition without an HTTP response, so the auto-trader can
    start the very same scanner the UI button starts."""
    global RADAR_THREAD
    window_seconds=min(max(int(item.get('window_seconds',86400) or 86400),1),3*24*60*60)
    min_pnl=max(float(item.get('min_pnl',1500) or 1500),0); config={'window_seconds':window_seconds,'min_pnl':min_pnl,'max_age_seconds':60}
    with RADAR_LOCK:
        RADAR_STATE.update({'running':True,'scanning':False,'started_at':int(time.time()*1000),'last_error':None,'config':config}); RADAR_STOP.clear()
        if not RADAR_THREAD or not RADAR_THREAD.is_alive():
            RADAR_THREAD=threading.Thread(target=worker,name='hyperliquid-radar',daemon=True); RADAR_THREAD.start()
def radar_stop_state():
    with RADAR_LOCK: RADAR_STATE['running']=False; RADAR_STATE['scanning']=False
    RADAR_STOP.set()
class Handler(SimpleHTTPRequestHandler):
    def authorized(self):
        if not AUTH_PASSWORD: return True
        header=self.headers.get('Authorization','') or ''
        if not header.startswith('Basic '): return False
        try: decoded=base64.b64decode(header[6:].strip()).decode('utf-8')
        except (ValueError,UnicodeDecodeError): return False
        user,separator,password=decoded.partition(':')
        if not separator: return False
        # compare_digest on both halves keeps the check constant-time.
        return hmac.compare_digest(user,AUTH_USER) and hmac.compare_digest(password,AUTH_PASSWORD)
    def require_auth(self):
        if self.authorized(): return True
        body=b'{"error":"unauthorized"}'
        self.send_response(401); self.send_header('WWW-Authenticate','Basic realm="Liquidation Radar"')
        self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body)))
        self.end_headers(); self.wfile.write(body); return False
    def serve_static(self,path):
        name=STATIC_FILES.get(path)
        if not name: return self.send_json({'error':'not found'},404)
        full=os.path.join(WEB_DIR,name)
        if not os.path.isfile(full): return self.send_json({'error':'not found'},404)
        with open(full,'rb') as handle: body=handle.read()
        self.send_bytes(body,STATIC_TYPES.get(name.rsplit('.',1)[-1],'application/octet-stream'),name)
    def do_HEAD(self):
        # SimpleHTTPRequestHandler's own do_HEAD serves straight from the
        # working directory, which would answer HEAD /.env with a 200 and skip
        # both the allowlist and the password. Answer it ourselves instead.
        if not self.require_auth(): return
        path=urllib.parse.urlparse(self.path).path
        if path.startswith('/api/') or path not in STATIC_FILES or not os.path.isfile(os.path.join(WEB_DIR,STATIC_FILES[path])):
            return self.send_json({'error':'not found'},404)
        name=STATIC_FILES[path]; size=os.path.getsize(os.path.join(WEB_DIR,name))
        self.send_response(200); self.send_header('Content-Type',STATIC_TYPES.get(name.rsplit('.',1)[-1],'application/octet-stream'))
        self.send_header('Content-Length',str(size)); self.end_headers()
    def do_GET(self):
        if not self.require_auth(): return
        u=urllib.parse.urlparse(self.path)
        if u.path.startswith('/api/'):
            try:
                if u.path=='/api/health': return self.send_json({'ok':True,'database':'sqlite','stored_events':len(read_db()['events'])})
                if u.path=='/api/events': return self.send_json(read_db())
                if u.path=='/api/bybit/kline': return self.bybit_kline(urllib.parse.parse_qs(u.query))
                if u.path=='/api/bybit/trades': return self.bybit_trades(urllib.parse.parse_qs(u.query))
                if u.path=='/api/bybit/api-status': return self.send_json(bybit_status_payload())
                if u.path=='/api/config': return self.send_json({'arkham_configured':bool(ARKHAM_API_KEY),'arkham_url':ARKHAM_API_URL,'database':'sqlite','sources':['bybit','dexscreener']+(['arkham'] if ARKHAM_API_KEY else [])})
                if u.path=='/api/hyperliquid/trades': return self.hyperliquid_trades(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/fills': return self.hyperliquid_fills(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/analysis': return self.hyperliquid_analysis(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/account': return self.hyperliquid_account(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/frequency': return self.hyperliquid_frequency(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/trade-participants': return self.hyperliquid_trade_participants(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/icebergs': return self.hyperliquid_icebergs(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/auto-wallets': return self.hyperliquid_auto_wallets(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/book': return self.hyperliquid_book(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/universe': return self.hyperliquid_universe()
                if u.path=='/api/hyperliquid/saved-addresses': return self.send_json({'addresses':load_saved_addresses(),'path':SAVED_ADDRESSES})
                if u.path=='/api/hyperliquid/radar/status': return self.hyperliquid_radar_status()
                if u.path=='/api/hyperliquid/hour-report': return self.hyperliquid_hour_report(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/24h-analysis': return self.hyperliquid_24h_analysis(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/12h-whales': return self.hyperliquid_12h_whales(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/24h-deep': return self.hyperliquid_24h_deep(urllib.parse.parse_qs(u.query))
                if u.path=='/api/hyperliquid/paper-backtest': return self.hyperliquid_paper_backtest(urllib.parse.parse_qs(u.query))
                if u.path=='/api/dex/onchain': return self.dex_onchain_buys(urllib.parse.parse_qs(u.query))
                if u.path=='/api/dex/onchain/addresses': return self.send_json({'addresses':load_onchain_addresses(),'path':ONCHAIN_ADDRESSES})
                if u.path=='/api/scanner/status': return self.scanner_status()
                if u.path=='/api/scanner/transfers': return self.scanner_transfers(urllib.parse.parse_qs(u.query))
                if u.path=='/api/export': return self.export_data(urllib.parse.parse_qs(u.query))
                if u.path=='/api/arbitrage':
                    return self.dex_arbitrage(urllib.parse.parse_qs(u.query))
                if u.path=='/api/whales':
                    net=urllib.parse.parse_qs(u.query).get('network',['ethereum'])[0]
                    return self.proxy('https://api.geckoterminal.com/api/v2/networks/'+urllib.parse.quote(net)+'/trending_pools')
                if u.path=='/api/arkham/transfers': return self.arkham_transfers(urllib.parse.parse_qs(u.query))
                if u.path=='/api/arkham/swaps': return self.arkham_swaps(urllib.parse.parse_qs(u.query))
                if u.path=='/api/autotrade/status': return self.send_json(autotrade.snapshot())
                if u.path=='/api/autotrade/settings': return self.send_json({'settings':trading.load_settings(),'defaults':trading.DEFAULT_SETTINGS,'venue_status':trading.venue_status()})
                if u.path=='/api/autotrade/orders': return self.send_json({'orders':autotrade.recent_orders(int(urllib.parse.parse_qs(u.query).get('limit',['100'])[0])),'decisions':autotrade.recent_decisions(int(urllib.parse.parse_qs(u.query).get('limit',['100'])[0]))})
                if u.path=='/api/autotrade/price': return self.autotrade_price(urllib.parse.parse_qs(u.query))
                if u.path=='/api/autotrade/book': return self.autotrade_book(urllib.parse.parse_qs(u.query))
                if u.path=='/api/autotrade/whale-orders': return self.send_json({'address':(urllib.parse.parse_qs(u.query).get('address',[''])[0] or '').lower(),'orders':autotrade.whale_open_orders(urllib.parse.parse_qs(u.query).get('address',[''])[0])})
                return self.send_json({'error':'unknown endpoint'},404)
            except Exception as e:return self.send_json({'error':str(e)},502)
        return self.serve_static(u.path)
    def do_POST(self):
        if not self.require_auth(): return
        if self.path=='/api/bybit/api-config':
            try:
                n=int(self.headers.get('Content-Length',0)); item=json.loads(self.rfile.read(n) or b'{}')
                api_key=str(item.get('api_key') or '').strip(); api_secret=str(item.get('api_secret') or '').strip()
                if not api_key or not api_secret: return self.send_json({'error':'Введите API Key и API Secret'},400)
                if not re.fullmatch(r'[^\s\x00-\x1f\x7f]{8,256}',api_key): return self.send_json({'error':'Некорректный формат API Key'},400)
                if not re.fullmatch(r'[^\s\x00-\x1f\x7f]{8,512}',api_secret): return self.send_json({'error':'Некорректный формат API Secret'},400)
                testnet=item.get('testnet') is True or str(item.get('testnet','')).strip().lower() in ('1','true','yes','on')
                update_env_file({'BYBIT_API_KEY':api_key,'BYBIT_API_SECRET':api_secret,'BYBIT_TESTNET':'true' if testnet else 'false','BYBIT_KEY_TYPE':'hmac'})
                return self.send_json({'ok':True,'status':bybit_status_payload()})
            except Exception as e:return self.send_json({'error':str(e)},400)
        if self.path=='/api/hyperliquid/saved-addresses':
            try:
                n=int(self.headers.get('Content-Length',0)); item=json.loads(self.rfile.read(n)); addresses=save_saved_addresses(item.get('addresses',item.get('text',''))); return self.send_json({'ok':True,'addresses':addresses,'path':SAVED_ADDRESSES})
            except Exception as e:return self.send_json({'error':str(e)},400)
        if self.path=='/api/dex/onchain/addresses':
            try:
                n=int(self.headers.get('Content-Length',0)); item=json.loads(self.rfile.read(n) or b'{}'); addresses=save_onchain_address(item.get('address','')); return self.send_json({'ok':True,'addresses':addresses,'path':ONCHAIN_ADDRESSES})
            except Exception as e:return self.send_json({'error':str(e)},400)
        if self.path=='/api/hyperliquid/radar/start':
            try:
                n=int(self.headers.get('Content-Length',0)); return self.hyperliquid_radar_start(json.loads(self.rfile.read(n) or b'{}'))
            except Exception as e:return self.send_json({'error':str(e)},400)
        if self.path=='/api/hyperliquid/radar/stop': return self.hyperliquid_radar_stop()
        if self.path.startswith('/api/autotrade/'): return self.autotrade_post(self.path)
        if self.path!='/api/events':return self.send_json({'error':'unknown endpoint'},404)
        try:
            n=int(self.headers.get('Content-Length',0)); item=json.loads(self.rfile.read(n)); append_rows('events',[item]); self.send_json({'ok':True})
        except Exception as e:self.send_json({'error':str(e)},400)
    def proxy(self,url):
        req=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=15) as r:self.send_json(json.loads(r.read()))
    def dex_request(self,url,ttl=20):
        now=time.time()
        with DEX_LOCK:
            cached=DEX_CACHE.get(url)
            if cached and now-cached['time']<ttl:return cached['data']
        request=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
        with urllib.request.urlopen(request,timeout=12) as response:data=json.loads(response.read())
        with DEX_LOCK: DEX_CACHE[url]={'time':now,'data':data};evict_cache(DEX_CACHE,DEX_CACHE_MAX)
        return data
    def dex_rpc(self,chain,method,params):
        raw=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
        request=urllib.request.Request(DEX_RPC[chain],data=raw,headers={'Content-Type':'application/json','User-Agent':'LiquidationRadar/1.0'})
        with urllib.request.urlopen(request,timeout=12) as response: payload=json.loads(response.read())
        if payload.get('error'): raise ValueError('RPC: '+str(payload['error'].get('message') or 'unknown error'))
        return payload.get('result')
    def dex_onchain_buys(self,query):
        chain=(query.get('chain',['bsc'])[0] or 'bsc').lower(); token=(query.get('token',[''])[0] or '').strip().lower(); min_usd=max(float(query.get('minUsd',['1000'])[0] or 1000),0)
        if chain not in DEX_RPC: raise ValueError('Поддерживаются BSC, Ethereum и Base')
        if not re.fullmatch(r'0x[a-f0-9]{40}',token): raise ValueError('Введите EVM-адрес токена')
        cache_key=f'onchain:{chain}:{token}:{min_usd}'
        with DEX_LOCK:
            cached=DEX_CACHE.get(cache_key)
            if cached and time.time()-cached['time']<30: return self.send_json(cached['data'])
        pairs=self.dex_request(f'https://api.dexscreener.com/token-pairs/v1/{chain}/{token}')
        if not isinstance(pairs,list) or not pairs: raise ValueError('Dexscreener не нашёл активную пару токена в выбранной сети')
        pair=max(pairs,key=lambda row:float((row.get('liquidity') or {}).get('usd') or 0)); pair_address=str(pair.get('pairAddress') or '').lower(); base=str((pair.get('baseToken') or {}).get('address') or '').lower()
        if not re.fullmatch(r'0x[a-f0-9]{40}',pair_address): raise ValueError('У пары отсутствует EVM-адрес')
        def call(address,data): return self.dex_rpc(chain,'eth_call',[{'to':address,'data':data},'latest'])
        token0='0x'+str(call(pair_address,'0x0dfe1681') or '')[-40:].lower(); token1='0x'+str(call(pair_address,'0xd21220a7') or '')[-40:].lower()
        if base not in (token0,token1): raise ValueError('Не удалось определить базовый токен пары')
        decimals_raw=call(base,'0x313ce567'); decimals=int(decimals_raw,16) if decimals_raw else 18
        latest=int(self.dex_rpc(chain,'eth_blockNumber',[]),16); start=max(0,latest-2000)
        logs=self.dex_rpc(chain,'eth_getLogs',[{'address':pair_address,'fromBlock':hex(start),'toBlock':hex(latest)}]) or []
        price=float(pair.get('priceUsd') or 0); base_is_zero=base==token0; buys=[]; stats={}
        for log in logs:
            topics=log.get('topics') or []; data=str(log.get('data') or '')
            if len(topics)!=3 or not data.startswith('0x') or len(data)!=258: continue
            amounts=[int(data[index:index+64],16) for index in range(2,len(data),64)]
            base_in=amounts[0] if base_is_zero else amounts[1]; base_out=amounts[2] if base_is_zero else amounts[3]; recipient='0x'+topics[2][-40:].lower(); block=int(log.get('blockNumber','0x0'),16)
            amount=(base_out or base_in)/(10**decimals); usd=amount*price; item=stats.setdefault(recipient,{'address':recipient,'buy_count':0,'sell_count':0,'buy_amount':0.0,'sell_amount':0.0,'buy_usd':0.0,'sell_usd':0.0,'first_block':block,'last_block':block})
            item['first_block']=min(item['first_block'],block); item['last_block']=max(item['last_block'],block)
            if base_out: item['buy_count']+=1; item['buy_amount']+=amount; item['buy_usd']+=usd
            if base_in: item['sell_count']+=1; item['sell_amount']+=amount; item['sell_usd']+=usd
            if base_out and usd>=min_usd: buys.append({'address':recipient,'amount':amount,'estimated_usd':usd,'tx_hash':log.get('transactionHash'),'block':block})
        buys.sort(key=lambda row:row['estimated_usd'],reverse=True)
        for item in stats.values(): item['estimated_result_usd']=item['sell_usd']-item['buy_usd']; item['total_count']=item['buy_count']+item['sell_count']; item['frequency_blocks']=max(0,item['last_block']-item['first_block'])/max(1,item['total_count']-1)
        payload={'source':'dexscreener+public-rpc','chain':chain,'token':token,'pair':{'address':pair_address,'url':pair.get('url'),'name':f"{(pair.get('baseToken') or {}).get('symbol','?')}/{(pair.get('quoteToken') or {}).get('symbol','?')}",'price_usd':price,'liquidity_usd':float((pair.get('liquidity') or {}).get('usd') or 0),'price_change':pair.get('priceChange') or {},'volume':pair.get('volume') or {}},'blocks_scanned':latest-start,'min_usd':min_usd,'buyers':buys[:50],'address_stats':list(stats.values()),'warning':'Адрес является получателем swap-лога пары. При роутерах он может быть контрактом, а не конечным владельцем. PnL рассчитан приблизительно по текущей цене и не является бухгалтерским closed/open PnL.'}
        with DEX_LOCK: DEX_CACHE[cache_key]={'time':time.time(),'data':payload};evict_cache(DEX_CACHE,DEX_CACHE_MAX)
        self.send_json(payload)
    def bybit_kline(self,query):
        symbol=(query.get('symbol',['BTCUSDT'])[0] or 'BTCUSDT').upper()
        interval=str(query.get('interval',['1'])[0])
        if not re.fullmatch(r'[A-Z0-9]{5,20}',symbol): raise ValueError('Invalid Bybit symbol')
        if interval not in ('1','3','5','15','30','60','120','240','360','720','D','W','M'): raise ValueError('Invalid kline interval')
        limit=min(max(int(query.get('limit',['200'])[0]),20),1000)
        url='https://api.bybit.com/v5/market/kline?'+urllib.parse.urlencode({'category':'linear','symbol':symbol,'interval':interval,'limit':limit})
        req=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as r: payload=json.loads(r.read())
        rows=payload.get('result',{}).get('list',[]); candles=[{'time':int(x[0]),'open':float(x[1]),'high':float(x[2]),'low':float(x[3]),'close':float(x[4]),'volume':float(x[5])} for x in rows]
        candles.sort(key=lambda x:x['time']); self.send_json({'source':'bybit','symbol':symbol,'interval':interval,'candles':candles})
    def bybit_trades(self,query):
        symbol=(query.get('symbol',['BTCUSDT'])[0] or 'BTCUSDT').upper(); limit=min(max(int(query.get('limit',['500'])[0]),1),1000)
        if not re.fullmatch(r'[A-Z0-9]{5,20}',symbol): raise ValueError('Invalid Bybit symbol')
        url='https://api.bybit.com/v5/market/recent-trade?'+urllib.parse.urlencode({'category':'linear','symbol':symbol,'limit':limit})
        req=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as r: payload=json.loads(r.read())
        rows=[]
        for x in payload.get('result',{}).get('list',[]):
            try: rows.append({'time':int(x.get('time',0)),'price':float(x.get('price',0)),'size':float(x.get('size',0)),'side':x.get('side')})
            except (TypeError,ValueError): pass
        self.send_json({'source':'bybit','symbol':symbol,'trades':rows})
    def hyperliquid_cache_ttl(self,body):
        request_type=body.get('type')
        if request_type=='meta': return 300
        if request_type=='recentTrades': return 8
        if request_type=='l2Book': return 2
        if request_type=='clearinghouseState': return 8
        if request_type=='userFillsByTime': return 30
        return 5
    def hyperliquid_request(self,body):
        global HL_NEXT_REQUEST_AT, HL_BLOCKED_UNTIL
        key=json.dumps(body,sort_keys=True,separators=(',',':')); ttl=self.hyperliquid_cache_ttl(body); now=time.time()
        with HL_LOCK:
            cached=HL_CACHE.get(key)
            if cached and now-cached['time']<ttl:return cached['data']
        last_error=None
        for attempt in range(2):
            with HL_LOCK:
                current=time.time(); wait=max(0.0,HL_NEXT_REQUEST_AT-current,HL_BLOCKED_UNTIL-current)
                HL_NEXT_REQUEST_AT=max(current,HL_NEXT_REQUEST_AT,HL_BLOCKED_UNTIL)+HL_REQUEST_INTERVAL
            if wait: time.sleep(wait)
            raw=json.dumps(body).encode(); req=urllib.request.Request('https://api.hyperliquid.xyz/info',data=raw,headers={'Content-Type':'application/json','User-Agent':'LiquidationRadar/1.0'})
            try:
                with urllib.request.urlopen(req,timeout=4) as response:data=json.loads(response.read())
                with HL_LOCK:HL_CACHE[key]={'time':time.time(),'data':data};evict_cache(HL_CACHE,HL_CACHE_MAX)
                return data
            except urllib.error.HTTPError as error:
                last_error=error
                if error.code==429:
                    with HL_LOCK:HL_BLOCKED_UNTIL=max(HL_BLOCKED_UNTIL,time.time()+2*(attempt+1))
                    continue
                # Hyperliquid can return 500/503 while it is shedding load. Do
                # not surface that transient upstream state when a cached value
                # is already available.
                if error.code in (500,502,503,504):
                    with HL_LOCK:cached=HL_CACHE.get(key)
                    if cached:return cached['data']
                    break
                raise
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                last_error=error
                # TLS/connectivity failures are transient on the public API.
                # Retry under the shared rate limiter, then let route-level
                # fallbacks serve locally captured rows when available.
                with HL_LOCK:cached=HL_CACHE.get(key)
                if cached:return cached['data']
                with HL_LOCK:HL_BLOCKED_UNTIL=max(HL_BLOCKED_UNTIL,time.time()+1.5)
                continue
        with HL_LOCK:cached=HL_CACHE.get(key)
        if cached:return cached['data']
        raise RuntimeError('Hyperliquid временно недоступен; локальный кэш не изменён') from last_error
    def cached_recent_trades(self,coins,max_age=90):
        now=time.time(); rows=[]
        with HL_LOCK:
            for coin in coins:
                cached=HL_CACHE.get(json.dumps({'type':'recentTrades','coin':coin},sort_keys=True,separators=(',',':')))
                if cached and now-cached['time']<=max_age:rows.extend(cached['data'])
        return rows
    def recent_market_trades(self,coin,limit):
        global HL_ALL_MARKET_CURSOR, HL_MARKETS
        if coin!='ALL':return self.hyperliquid_request({'type':'recentTrades','coin':coin})[:limit],{'markets_total':1,'markets_refreshed':1,'markets_cached':1}
        try:
            meta=self.hyperliquid_request({'type':'meta'}); coins=[x.get('name') for x in meta.get('universe',[]) if x.get('name')]
            if coins:
                with HL_LOCK:HL_MARKETS=coins[:]
        except Exception:
            # Keep the live table usable while the market catalogue is briefly
            # unavailable. The next refresh retries the complete catalogue.
            with HL_LOCK:coins=HL_MARKETS[:]
        if not coins:return [],{'markets_total':0,'markets_refreshed':0,'markets_cached':0}
        # A fresh browser cannot safely make one request per listed market.  Each
        # refresh advances this real-data window, while prior windows remain cached.
        batch_size=min(len(coins),max(8,min(10,(limit+9)//10)))
        with HL_LOCK:
            start=HL_ALL_MARKET_CURSOR%len(coins); selected=[coins[(start+i)%len(coins)] for i in range(batch_size)]; HL_ALL_MARKET_CURSOR=(start+batch_size)%len(coins)
        def fetch_market(name):
            try:return self.hyperliquid_request({'type':'recentTrades','coin':name})[:10]
            except Exception:return []
        with ThreadPoolExecutor(max_workers=2) as pool:refreshed=[row for group in pool.map(fetch_market,selected) for row in group]
        cached=self.cached_recent_trades(coins)
        unique={}
        for row in refreshed+cached:
            key=(row.get('coin'),row.get('tid'),row.get('time'),row.get('hash'))
            unique[key]=row
        rows=sorted(unique.values(),key=lambda row:row.get('time',0),reverse=True)[:limit]
        cached_markets=sum(1 for name in coins if self.cached_recent_trades([name]))
        return rows,{'markets_total':len(coins),'markets_refreshed':len(selected),'markets_cached':cached_markets}
    def hyperliquid_universe(self):
        meta=self.hyperliquid_request({'type':'meta'}); coins=[x.get('name') for x in meta.get('universe',[]) if x.get('name')]
        self.send_json({'source':'hyperliquid','coins':coins,'count':len(coins)})
    def hyperliquid_trades(self,query):
        raw_coin=(query.get('coin',[''])[0] or '').strip().upper(); coin=raw_coin or 'ALL'; limit=min(max(int(query.get('limit',['100'])[0]),1),500)
        used_local_cache=False; rows=[]; local_rows=[]; now=int(time.time()*1000); seen=set()
        for item in read_db().get('hyperliquid',[]):
            if item.get('kind')!='market_trade': continue
            if int(item.get('time') or 0)<now-24*60*60*1000: continue
            if coin!='ALL' and str(item.get('coin') or '').upper()!=coin: continue
            key=(item.get('coin'),item.get('trade_id'),item.get('time'),item.get('tx_hash'))
            if key in seen: continue
            seen.add(key); local_rows.append({'coin':item.get('coin',coin),'side':'A' if item.get('side')=='SELL' else 'B','px':item.get('price',0),'sz':item.get('size',0),'time':item.get('time'),'hash':item.get('tx_hash'),'tid':item.get('trade_id'),'users':item.get('participants',[])})
        # Real rows already captured by the app are immediately usable. This
        # prevents a temporary TLS failure from blocking the overview screen.
        if local_rows:
            used_local_cache=True; rows=sorted(local_rows,key=lambda row:row.get('time',0),reverse=True)[:limit]; market_info={'markets_total':0,'markets_refreshed':0,'markets_cached':len(rows),'fallback':'local_cache'}
        else:
            try:
                rows,market_info=self.recent_market_trades(coin,limit)
            except Exception:
                rows=[]; market_info={'markets_total':0,'markets_refreshed':0,'markets_cached':0,'fallback':'unavailable'}
        normalized=[{'source':'hyperliquid','kind':'market_trade','coin':x.get('coin',coin),'side':'SELL' if x.get('side')=='A' else 'BUY','price':float(x.get('px',0)),'size':float(x.get('sz',0)),'usd':float(x.get('px',0))*float(x.get('sz',0)),'time':x.get('time'),'tx_hash':x.get('hash'),'trade_id':x.get('tid'),'participants':x.get('users',[])} for x in rows]
        append_rows('hyperliquid',normalized)
        self.send_json({'source':'hyperliquid','coin':coin,'trades':normalized,'count':len(normalized),'market_info':market_info,'cached':used_local_cache,'warning':'Показан последний локально сохранённый поток; повторите обновление позже.' if used_local_cache else None})
    def hyperliquid_book(self,query):
        coin=(query.get('coin',['BTC'])[0] or 'BTC').upper(); depth=min(max(int(query.get('depth',['20'])[0]),1),50)
        book=self.hyperliquid_request({'type':'l2Book','coin':coin}); levels=book.get('levels',[[],[]]); bids=[{'price':float(x['px']),'size':float(x['sz']),'orders':x.get('n',0),'usd':float(x['px'])*float(x['sz'])} for x in levels[0][:depth]]; asks=[{'price':float(x['px']),'size':float(x['sz']),'orders':x.get('n',0),'usd':float(x['px'])*float(x['sz'])} for x in levels[1][:depth]]
        all_sizes=[x['size'] for x in bids+asks]; threshold=max(statistics.quantiles(all_sizes,n=4)[-1] if len(all_sizes)>=4 else 0, (statistics.mean(all_sizes) if all_sizes else 0)*4)
        for x in bids+asks:x['large']=x['size']>=threshold and threshold>0
        result={'source':'hyperliquid','coin':coin,'time':book.get('time'),'bids':bids,'asks':asks,'best_bid':bids[0]['price'] if bids else None,'best_ask':asks[0]['price'] if asks else None,'large_order_threshold':threshold,'spoofing_candidates':[x for x in bids+asks if x['large']]}
        append_rows('orderbook',[result]);self.send_json(result)
    def hyperliquid_auto_wallets(self,query):
        raw_coin=(query.get('coin',[''])[0] or '').strip().upper(); coin=raw_coin or 'ALL'; limit=min(max(int(query.get('limit',['100'])[0]),1),500); use_saved=query.get('useSaved',['0'])[0]=='1'; addresses=normalize_addresses(query.get('addresses',[''])[0]) if use_saved else []
        if use_saved: addresses=normalize_addresses(addresses+load_saved_addresses())
        trade_payload,_=self.recent_market_trades(coin,limit)
        for t in trade_payload:
            for user in t.get('users',[]):
                if re.fullmatch(r'0x[a-fA-F0-9]{40}',user) and user.lower() not in addresses: addresses.append(user.lower())
        addresses=addresses[:limit]
        def analyze_user(user):
            try:
                fills=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':int(query.get('startTime',['0'])[0]),'endTime':int(query.get('endTime',[str(9999999999999)])[0])}); nf=[self.normalize_fill(x,user) for x in fills if coin=='ALL' or str(x.get('coin','')).upper()==coin]; closed=sum(x['closed_pnl'] for x in nf); fees=sum(x['fee'] for x in nf); size=sum(x['usd'] for x in nf); actions={}
                for x in nf:actions[x['action']]=actions.get(x['action'],0)+1
                open_positions=[]
                # The daily table needs a real end-of-day position bucket. Fills
                # alone do not prove whether an address still holds a position.
                try:
                    account=self.hyperliquid_request({'type':'clearinghouseState','user':user})
                    for raw_position in account.get('assetPositions',[]):
                        position=raw_position.get('position',{}); current_size=float(position.get('szi',0) or 0)
                        if not current_size: continue
                        open_positions.append({'coin':position.get('coin'),'side':'LONG' if current_size>0 else 'SHORT','size':current_size,'entry_price':float(position.get('entryPx',0) or 0),'position_value':float(position.get('positionValue',0) or 0),'unrealized_pnl':float(position.get('unrealizedPnl',0) or 0),'liquidation_price':position.get('liquidationPx')})
                except Exception:
                    pass
                closed_positions=[{'coin':x['coin'],'action':x['action'],'size':x['size'],'price':x['price'],'pnl':x['closed_pnl'],'time':x['time']} for x in nf if x['action'] in ('Close Long','Close Short')]
                buy_rows=[x for x in nf if x['action'] in ('Open Long','Open Short')]; sell_rows=[x for x in nf if x['action'] in ('Close Long','Close Short')]
                buy_usd=sum(x['usd'] for x in buy_rows); sell_usd=sum(x['usd'] for x in sell_rows)
                return {'address':user,'coin':coin,'fills':len(nf),'closed_pnl':closed,'fees':fees,'volume_usd':size,'buy_usd':buy_usd,'sell_usd':sell_usd,'buy_count':len(buy_rows),'sell_count':len(sell_rows),'actions':actions,'closed_positions':closed_positions,'open_positions':open_positions,'last_time':max([x.get('time',0) or 0 for x in nf],default=0)}
            except Exception as e:return {'address':user,'coin':coin,'error':str(e),'fills':0,'closed_pnl':0,'fees':0,'volume_usd':0,'buy_usd':0,'sell_usd':0,'buy_count':0,'sell_count':0,'actions':{},'open_positions':[]}
        rows=[]
        with ThreadPoolExecutor(max_workers=len(addresses) or 1) as pool:
            futures=[pool.submit(analyze_user,user) for user in addresses]
            for future in as_completed(futures): rows.append(future.result())
        rows.sort(key=lambda x:(x.get('volume_usd',0),x.get('closed_pnl',0)),reverse=True);append_rows('hyperliquid',rows);self.send_json({'source':'hyperliquid','coin':coin,'wallets':rows,'count':len(rows)})
    def validate_address(self,user):
        if not re.fullmatch(r'0x[a-fA-F0-9]{40}',user or ''): raise ValueError('Hyperliquid address must be a 0x EVM address')
        return user.lower()
    def hyperliquid_fills(self,query):
        user=self.validate_address(query.get('user',[''])[0]); start=int(query.get('startTime',['0'])[0]); end=int(query.get('endTime',[str(9999999999999)])[0])
        body={'type':'userFillsByTime','user':user,'startTime':start,'endTime':end} if start or 'endTime' in query else {'type':'userFills','user':user}
        rows=self.hyperliquid_request(body)
        normalized=[self.normalize_fill(x,user) for x in rows]
        append_rows('hyperliquid',normalized)
        self.send_json({'source':'hyperliquid','user':user,'fills':normalized,'count':len(normalized)})
    def hyperliquid_fills_range(self,user,start,end):
        """Read a full time range without silently losing a 2,000-fill page."""
        # A filled page is split once into two six-hour windows.  This keeps a
        # multi-address report bounded under the public API rate limit.
        page_limit=2000; smallest_window=1000; max_depth=1; max_requests=3; request_count=0
        def fetch_window(window_start,window_end,depth):
            nonlocal request_count
            if request_count>=max_requests: return [],True
            request_count+=1
            rows=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':window_start,'endTime':window_end})
            if len(rows)<page_limit: return rows,False
            if depth>=max_depth or window_end-window_start<=smallest_window or request_count+2>max_requests: return rows,True
            midpoint=(window_start+window_end)//2
            left,left_truncated=fetch_window(window_start,midpoint,depth+1)
            right,right_truncated=fetch_window(midpoint+1,window_end,depth+1)
            return left+right,left_truncated or right_truncated
        raw,truncated=fetch_window(start,end,0)
        unique={}
        for item in raw:
            key=(item.get('tid'),item.get('time'),item.get('coin'),item.get('oid'),item.get('hash'),item.get('dir'))
            unique[key]=item
        return sorted(unique.values(),key=lambda item:int(item.get('time') or 0)),truncated
    def hyperliquid_first_profitable_close(self,user,cutoff):
        """Find and persist proof of a profitable close at or before cutoff."""
        with HL_FIRST_PROFIT_LOCK:
            try:
                with open(HL_FIRST_PROFIT_CACHE,encoding='utf-8') as cache_file: cache=json.load(cache_file)
            except (OSError,ValueError,TypeError):
                cache={}
            cached=cache.get(user) or {}
            cached_time=int(cached.get('first_profitable_close_time') or 0)
            if cached_time and cached_time<=cutoff:
                return cached_time,bool(cached.get('history_truncated'))
            checked_cutoff=int(cached.get('checked_cutoff') or 0)
            if not cached_time and checked_cutoff>=cutoff:
                return 0,bool(cached.get('history_truncated'))
        rows=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':1,'endTime':cutoff})
        positive_times=[int(item.get('time') or 0) for item in rows if float(item.get('closedPnl',0) or 0)>0 and int(item.get('time') or 0)>0]
        first_time=min(positive_times,default=0); truncated=len(rows)>=2000
        with HL_FIRST_PROFIT_LOCK:
            try:
                with open(HL_FIRST_PROFIT_CACHE,encoding='utf-8') as cache_file: cache=json.load(cache_file)
            except (OSError,ValueError,TypeError):
                cache={}
            existing=cache.get(user) or {}; existing_time=int(existing.get('first_profitable_close_time') or 0)
            if existing_time and (not first_time or existing_time<first_time): first_time=existing_time
            cache[user]={'first_profitable_close_time':first_time,'checked_cutoff':cutoff,'history_truncated':truncated,'updated_at':int(time.time()*1000)}
            temporary=HL_FIRST_PROFIT_CACHE+'.tmp'
            with open(temporary,'w',encoding='utf-8') as cache_file: json.dump(cache,cache_file,ensure_ascii=False,indent=2)
            os.replace(temporary,HL_FIRST_PROFIT_CACHE)
        return first_time,truncated
    def normalize_fill(self,x,user):
        px=float(x.get('px',0)); size=float(x.get('sz',0)); side='SELL' if x.get('side')=='A' else 'BUY'
        direction=x.get('dir') or ''
        action=direction if direction in ('Open Long','Close Long','Open Short','Close Short') else ('Settlement' if direction=='Settlement' else ('Buy' if side=='BUY' else 'Sell'))
        return {'source':'hyperliquid','kind':'user_fill','user':user,'coin':x.get('coin'),'side':side,'direction':direction,'action':action,'price':px,'size':size,'usd':px*size,'time':x.get('time'),'start_position':x.get('startPosition'),'closed_pnl':float(x.get('closedPnl',0) or 0),'fee':float(x.get('fee',0) or 0),'fee_token':x.get('feeToken'),'tx_hash':x.get('hash'),'order_id':x.get('oid'),'trade_id':x.get('tid'),'crossed':x.get('crossed')}
    def hyperliquid_analysis(self,query):
        user=self.validate_address(query.get('user',[''])[0]); start=int(query.get('startTime',['0'])[0]); end=int(query.get('endTime',[str(9999999999999)])[0]); rows=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':start,'endTime':end})
        fills=[self.normalize_fill(x,user) for x in rows]; append_rows('hyperliquid',fills); summary={}; action_counts={}; total_pnl=0.0; total_fees=0.0
        for x in fills:
            s=summary.setdefault(x['coin'],{'coin':x['coin'],'buy_usd':0,'sell_usd':0,'buy_size':0,'sell_size':0,'closed_pnl':0,'fees':0,'fills':0,'last_time':0,'last_action':'—'})
            key='sell' if x['side']=='SELL' else 'buy';s[key+'_usd']+=x['usd'];s[key+'_size']+=x['size'];s['closed_pnl']+=x['closed_pnl'];s['fees']+=x['fee'];s['fills']+=1
            action_counts[x['coin']]=action_counts.get(x['coin'],0)+1;total_pnl+=x['closed_pnl'];total_fees+=x['fee']
            if x['time'] and x['time']>=s['last_time']:s['last_time']=x['time'];s['last_action']=x['action']
        result=sorted(summary.values(),key=lambda x:x['last_time'],reverse=True)
        frequent=max(action_counts,key=action_counts.get) if action_counts else None
        self.send_json({'source':'hyperliquid','user':user,'summary':result,'fills':fills,'count':len(fills),'total_closed_pnl':total_pnl,'total_fees':total_fees,'most_frequent_asset':frequent,'date_range':{'start':start,'end':end}})
    def hyperliquid_account(self,query):
        user=self.validate_address(query.get('user',[''])[0]); persisted={}
        try:
            if os.path.exists(HL_ACCOUNT_PERSISTED_CACHE):
                with open(HL_ACCOUNT_PERSISTED_CACHE,encoding='utf-8') as cache_file: persisted=json.load(cache_file)
        except Exception:
            persisted={}
        try:
            state=self.hyperliquid_request({'type':'clearinghouseState','user':user})
            margin=state.get('marginSummary') or state.get('crossMarginSummary') or {}; positions=[]
            for raw in state.get('assetPositions',[]):
                pos=raw.get('position',{}); size=float(pos.get('szi',0) or 0)
                if size: positions.append({'coin':pos.get('coin'),'side':'LONG' if size>0 else 'SHORT','size':size,'entry_price':float(pos.get('entryPx',0) or 0),'position_value':float(pos.get('positionValue',0) or 0),'unrealized_pnl':float(pos.get('unrealizedPnl',0) or 0),'liquidation_price':pos.get('liquidationPx'),'leverage':pos.get('leverage',{})})
            result={'source':'hyperliquid','user':user,'account_value':float(margin.get('accountValue',0) or 0),'total_position_value':float(margin.get('totalNtlPos',0) or 0),'margin_used':float(margin.get('totalRawUsd',0) or 0),'withdrawable':float(state.get('withdrawable',0) or 0),'unrealized_pnl':sum(x['unrealized_pnl'] for x in positions),'positions':positions,'cached':False}
            persisted[user]=result
            try:
                temporary=HL_ACCOUNT_PERSISTED_CACHE+'.tmp'
                with open(temporary,'w',encoding='utf-8') as cache_file: json.dump(persisted,cache_file,ensure_ascii=False)
                os.replace(temporary,HL_ACCOUNT_PERSISTED_CACHE)
            except Exception:
                pass
            self.send_json(result)
        except Exception:
            cached=persisted.get(user)
            if cached:
                cached=dict(cached); cached['cached']=True; cached['warning']='Показано последнее сохранённое состояние аккаунта.'; self.send_json(cached); return
            self.send_json({'source':'hyperliquid','user':user,'error':'Аккаунт временно недоступен. Повторите раскрытие строки через несколько секунд.','retryable':True},503)
    def hyperliquid_frequency(self,query):
        raw_coin=(query.get('coin',[''])[0] or '').strip().upper(); coin=raw_coin or 'ALL'; raw=query.get('addresses',[''])[0]
        addresses=[]
        for user in raw.split(','):
            user=user.strip().lower()
            if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in addresses: addresses.append(user)
        addresses=addresses[:8]; start=int(time.time()*1000)-30*24*60*60*1000
        def analyze(user):
            try:
                rows=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':start,'endTime':int(time.time()*1000)})
                buys=sorted(int(x.get('time',0)) for x in rows if (coin=='ALL' or str(x.get('coin','')).upper()==coin) and x.get('side')=='B')
                days=len({time.strftime('%Y-%m-%d',time.gmtime(x/1000)) for x in buys})
                gaps=[(b-a)/3600000 for a,b in zip(buys,buys[1:])]
                median_gap=statistics.median(gaps) if gaps else None
                if len(buys)<2: label='недостаточно сделок'
                elif median_gap<=2: label='каждый час'
                elif median_gap<=36: label='каждый день'
                elif median_gap<=72: label='раз в 2-3 дня'
                else: label='реже 3 дней'
                return {'address':user,'buy_count':len(buys),'active_days':days,'median_hours':median_gap,'label':label}
            except Exception as e:return {'address':user,'buy_count':0,'active_days':0,'median_hours':None,'label':'нет данных','error':str(e)}
        with ThreadPoolExecutor(max_workers=min(len(addresses),2) or 1) as pool: rows=list(pool.map(analyze,addresses))
        self.send_json({'source':'hyperliquid','coin':coin,'period_days':30,'rows':rows})
    def hyperliquid_trade_participants(self,query):
        coin=(query.get('coin',[''])[0] or '').upper(); trade_id=str(query.get('tradeId',[''])[0]); event_time=int(query.get('time',['0'])[0]); raw=query.get('addresses',[''])[0]
        if not coin or not trade_id or not event_time: raise ValueError('coin, tradeId and time are required')
        users=[]
        for user in raw.split(','):
            user=user.strip().lower()
            if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in users: users.append(user)
        def analyze(user):
            fills=[]; fill_error=None
            try:
                fills=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':event_time-120000,'endTime':event_time+120000})
            except Exception as error:
                fill_error=str(error)
            match=next((x for x in fills if str(x.get('tid'))==trade_id and str(x.get('coin','')).upper()==coin),None)
            account_error=None; account={}
            try:
                account=self.hyperliquid_request({'type':'clearinghouseState','user':user})
            except Exception as error:
                account_error=str(error)
            margin=account.get('marginSummary') or account.get('crossMarginSummary') or {}; positions=[]
            for raw_position in account.get('assetPositions',[]):
                pos=raw_position.get('position',{}); position_size=float(pos.get('szi',0) or 0)
                if position_size: positions.append({'coin':pos.get('coin'),'side':'LONG' if position_size>0 else 'SHORT','size':position_size,'entry_price':float(pos.get('entryPx',0) or 0),'position_value':float(pos.get('positionValue',0) or 0),'unrealized_pnl':float(pos.get('unrealizedPnl',0) or 0),'liquidation_price':pos.get('liquidationPx')})
            if match:
                normalized=self.normalize_fill(match,user); action=normalized['action']; side=normalized['side']; price=normalized['price']; size=normalized['size']; closed_pnl=normalized['closed_pnl']
            else: action='не определено'; side=None; price=None; size=None; closed_pnl=None
            return {'address':user,'matched':bool(match),'action':action,'side':side,'price':price,'size':size,'closed_pnl':closed_pnl,'account_value':float(margin.get('accountValue',0) or 0) if account else None,'withdrawable':float(account.get('withdrawable',0) or 0) if account else None,'unrealized_pnl':sum(x['unrealized_pnl'] for x in positions) if account else None,'positions':positions,'warning':'Точный fill этой сделки не найден, но состояние аккаунта загружено.' if not match and account else (fill_error or account_error)}
        with ThreadPoolExecutor(max_workers=min(len(users),2) or 1) as pool: rows=list(pool.map(analyze,users))
        self.send_json({'source':'hyperliquid','coin':coin,'trade_id':trade_id,'participants':rows})
    def hyperliquid_icebergs(self,query):
        raw_coin=(query.get('coin',[''])[0] or '').strip().upper(); coin=raw_coin or 'ALL'; raw=query.get('addresses',[''])[0]; min_usd=max(float(query.get('minUsd',['0'])[0] or 0),0); start=int(time.time()*1000)-60*60*1000
        users=[]
        for user in raw.split(','):
            user=user.strip().lower()
            if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in users: users.append(user)
        if query.get('useSaved',['0'])[0]=='1': users=normalize_addresses(users+load_saved_addresses())
        if not users:
            for item in read_db().get('hyperliquid',[]):
                for user in normalize_addresses([item.get('user'),item.get('address')]+(item.get('participants') or [])): 
                    if user not in users:users.append(user)
        users=users[:12]
        def analyze(user):
            try:
                fills=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':start,'endTime':int(time.time()*1000)})
                groups={}
                for x in fills:
                    asset=str(x.get('coin','')).upper()
                    if coin!='ALL' and asset!=coin: continue
                    side='BUY' if x.get('side')=='B' else 'SELL'; px=float(x.get('px',0) or 0); size=float(x.get('sz',0) or 0)
                    groups.setdefault((asset,side),[]).append({'price':px,'size':size,'usd':px*size,'time':x.get('time')})
                signals=[]
                for (asset,side),rows in groups.items():
                    if len(rows)<3: continue
                    prices=[x['price'] for x in rows if x['price']>0]; low=min(prices); high=max(prices); band=(high/low-1)*100 if low else 0
                    total_usd=sum(x['usd'] for x in rows)
                    if band<=0.35 and total_usd>=min_usd: signals.append({'address':user,'coin':asset,'side':side,'parts':len(rows),'usd':total_usd,'price_low':low,'price_high':high,'band_pct':band,'first_time':min(x['time'] for x in rows),'last_time':max(x['time'] for x in rows)})
                return signals
            except Exception:return []
        with ThreadPoolExecutor(max_workers=min(len(users),2) or 1) as pool: signals=[s for group in pool.map(analyze,users) for s in group]
        signals.sort(key=lambda x:(x['parts'],x['usd']),reverse=True); self.send_json({'source':'hyperliquid','coin':coin,'lookback_minutes':60,'min_usd':min_usd,'signals':signals})
    def hyperliquid_paper_backtest(self,query):
        """Paper-copy simulation for all locally saved Hyperliquid addresses."""
        fee_rate=0.002
        addresses=load_saved_addresses()
        if not addresses: raise ValueError('Нет сохранённых адресов для paper-backtest')
        now=int(time.time()*1000)
        moscow_now=datetime.now(ZoneInfo('Europe/Moscow'))
        day_start_local=moscow_now.replace(hour=0,minute=0,second=0,microsecond=0)
        day_start=int(day_start_local.astimezone(timezone.utc).timestamp()*1000)
        def analyze(user):
            try:
                fills=[self.normalize_fill(x,user) for x in self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':day_start,'endTime':now})]
                account=self.hyperliquid_request({'type':'clearinghouseState','user':user}); margin=account.get('marginSummary') or account.get('crossMarginSummary') or {}
                closed_pnl=sum(x['closed_pnl'] for x in fills); actual_fees=sum(abs(x['fee']) for x in fills)
                return {'address':user,'fills':fills,'fill_count':len(fills),'volume_usd':sum(x['usd'] for x in fills),'closed_pnl':closed_pnl,'actual_fees':actual_fees,'actual_net':closed_pnl-actual_fees,'account_value':float(margin.get('accountValue',0) or 0),'error':None}
            except Exception as error:
                return {'address':user,'fills':[],'fill_count':0,'volume_usd':0,'closed_pnl':0,'actual_fees':0,'actual_net':0,'account_value':0,'error':str(error)}
        with ThreadPoolExecutor(max_workers=min(len(addresses),3) or 1) as pool: rows=list(pool.map(analyze,addresses))
        ranked=sorted((row for row in rows if not row['error'] and row['account_value']>0),key=lambda row:row['actual_net'],reverse=True)
        if not ranked: raise ValueError('Не удалось получить fills и account value сохранённых адресов')
        leader=ranked[0]; scale=1000.0/leader['account_value']
        def simulate(name,start):
            fills=[x for x in leader['fills'] if int(x.get('time') or 0)>=start]
            closed_pnl=sum(x['closed_pnl'] for x in fills)*scale; copied_volume=sum(x['usd'] for x in fills)*scale
            model_fees=copied_volume*fee_rate; net=closed_pnl-model_fees; percentage=net/1000.0*100
            return {'period':name,'start':start,'fills':len(fills),'reference_closed_pnl':sum(x['closed_pnl'] for x in fills),'copied_volume_usd':copied_volume,'gross_pnl_usd':closed_pnl,'model_fees_usd':model_fees,'net_pnl_usd':net,'return_pct':percentage,'usd_balance':1000.0+net,'rub_pnl':1000.0*percentage/100.0,'rub_balance':1000.0*(1+percentage/100.0)}
        windows=[simulate('За последнюю минуту',now-60*1000),simulate('За последний час',now-60*60*1000),simulate('Сегодня',day_start)]
        def money(value,currency='$'):
            sign='-' if value<0 else ''
            return f'{sign}{currency}{abs(value):,.2f}'
        def rub(value):
            sign='-' if value<0 else ''
            return f'{sign}{abs(value):,.2f} RUB'
        lines=['PAPER-BACKTEST HYPERLIQUID',f'Создан: {moscow_now.strftime("%Y-%m-%d %H:%M:%S")} MSK',f'Период дня: {day_start_local.strftime("%Y-%m-%d %H:%M:%S")} MSK — {moscow_now.strftime("%Y-%m-%d %H:%M:%S")} MSK',f'Сохранённых адресов: {len(addresses)}, успешно проверено: {len([x for x in rows if not x["error"]])}','', 'МЕТОДИКА','Лидер выбран по закрытому PnL за сегодня минус фактические комиссии его fills.','Paper-счёт повторяет fills лидера пропорционально текущему account value лидера.','Комиссия paper-модели: 0.20% от USD-объёма каждого fill, включая покупки и продажи.','Открытый (unrealized) PnL не включён. Это историческая симуляция, не прогноз доходности.','', 'ЛИДЕР']
        lines += [f'Адрес: {leader["address"]}',f'Hyperliquid Explorer: https://app.hyperliquid.xyz/explorer/address/{leader["address"]}',f'Текущий account value: {money(leader["account_value"])}',f'Закрытый PnL за сегодня: {money(leader["closed_pnl"])}',f'Фактические комиссии лидера: {money(leader["actual_fees"])}',f'Фактический net PnL лидера: {money(leader["actual_net"])}',f'Fills: {leader["fill_count"]} · объём: {money(leader["volume_usd"])}',f'Коэффициент копирования для счёта $1,000: {scale:.8f}','', 'PAPER-РЕЗУЛЬТАТЫ']
        for item in windows:
            lines += [f'{item["period"]}: fills {item["fills"]} · доходность {item["return_pct"]:+.4f}%',f'  Копируемый объём: {money(item["copied_volume_usd"])} · gross PnL: {money(item["gross_pnl_usd"])} · комиссия 0.20%: {money(item["model_fees_usd"])}',f'  Счёт $1,000: PnL {money(item["net_pnl_usd"])} · баланс {money(item["usd_balance"])}',f'  Счёт 1,000 RUB: PnL {rub(item["rub_pnl"])} · баланс {rub(item["rub_balance"])}']
        lines += ['', 'РЕЙТИНГ СОХРАНЁННЫХ АДРЕСОВ']
        for index,row in enumerate(sorted(rows,key=lambda x:x['actual_net'],reverse=True),1):
            if row['error']: lines.append(f'{index}. {row["address"]} · ошибка: {row["error"]}')
            else: lines.append(f'{index}. {row["address"]} · net {money(row["actual_net"])} · closed {money(row["closed_pnl"])} · fees {money(row["actual_fees"])} · fills {row["fill_count"]}')
        content='\n'.join(lines)+'\n'; stamp=time.strftime('%Y%m%d_%H%M%S'); report_path=os.path.join(REPORT_DIR,f'hyperliquid_paper_backtest_{stamp}.txt')
        try:
            with open(report_path,'w',encoding='utf-8') as report_file: report_file.write(content)
        except Exception as error:
            report_path=None; lines.append(f'Не удалось записать отчёт на рабочий стол: {error}')
        self.send_json({'source':'hyperliquid','model':{'fee_rate':fee_rate,'fee_percent':fee_rate*100,'initial_usd':1000,'initial_rub':1000,'unrealized_pnl_included':False,'scaling':'current leader account value'},'period':{'start':day_start,'end':now,'timezone':'Europe/Moscow'},'addresses':[{key:value for key,value in row.items() if key!='fills'} for row in rows],'leader':{key:value for key,value in leader.items() if key!='fills'},'windows':windows,'report_path':report_path,'report':content})
    def hyperliquid_24h_analysis(self,query):
        """Analyze up to 500 observed addresses over the last 24 hours.

        Hyperliquid's public recentTrades stream exposes the two participants,
        market side, price and size, but not which participant was the buyer or
        seller.  This report therefore measures observable market flow and
        marks that limitation instead of presenting an inferred wallet PnL.
        """
        coin=(query.get('coin',[''])[0] or '').strip().upper() or 'ALL'
        limit=min(max(int(query.get('limit',['500'])[0] or 500),1),500)
        min_usd=max(float(query.get('minUsd',['5000'])[0] or 5000),0)
        now=int(time.time()*1000); start=now-24*60*60*1000

        # Refresh one real market window first, then combine it with the
        # locally captured 24-hour stream so repeated refreshes do not lose
        # earlier observations.
        try:
            fresh_rows,_=self.recent_market_trades(coin,500)
            fresh=[{'source':'hyperliquid','kind':'market_trade','coin':x.get('coin',coin),'side':'SELL' if x.get('side')=='A' else 'BUY','price':float(x.get('px',0) or 0),'size':float(x.get('sz',0) or 0),'usd':float(x.get('px',0) or 0)*float(x.get('sz',0) or 0),'time':x.get('time'),'tx_hash':x.get('hash'),'trade_id':x.get('tid'),'participants':x.get('users',[])} for x in fresh]
            append_rows('hyperliquid',fresh)
        except Exception:
            fresh=[]

        market_rows=[]; seen=set()
        for item in read_db().get('hyperliquid',[]):
            if item.get('kind')!='market_trade': continue
            event_time=int(item.get('time') or 0)
            if event_time<start or event_time>now: continue
            asset=str(item.get('coin') or '').upper()
            if coin!='ALL' and asset!=coin: continue
            participants=normalize_addresses(item.get('participants') or [])
            if not participants: continue
            key=(asset,item.get('trade_id'),event_time,item.get('tx_hash'),tuple(participants))
            if key in seen: continue
            seen.add(key)
            market_rows.append({'coin':asset or coin,'side':'BUY' if item.get('side')=='BUY' else 'SELL','price':float(item.get('price',0) or 0),'size':float(item.get('size',0) or 0),'usd':float(item.get('usd',0) or 0),'time':event_time,'trade_id':item.get('trade_id'),'participants':participants})
        market_rows.sort(key=lambda row:row['time'],reverse=True)

        # Build per-address events.  A fractional group is three or more
        # same-side observations of one coin inside an hour, within the same
        # 0.35% price band, whose combined USD reaches the threshold.
        events={}
        for row in market_rows:
            for address in row['participants']:
                events.setdefault(address,[]).append(row)
        saved_addresses=load_saved_addresses()
        candidates=set(events).union(saved_addresses)
        selected_addresses=sorted(candidates,key=lambda address:(1 if address in saved_addresses else 0,sum(item['usd'] for item in events.get(address,[]))),reverse=True)[:limit]
        events={address:events.get(address,[]) for address in selected_addresses}
        fractional_indexes={}
        for address,rows in events.items():
            ordered=sorted(enumerate(rows),key=lambda pair:pair[1]['time'])
            marked=set()
            for left,(index,first) in enumerate(ordered):
                window=[]
                for index2,row in ordered[left:]:
                    if row['time']-first['time']>60*60*1000: break
                    if row['coin']==first['coin'] and row['side']==first['side']: window.append((index2,row))
                if len(window)<3: continue
                prices=[row['price'] for _,row in window if row['price']>0]
                total=sum(row['usd'] for _,row in window)
                if prices and max(prices)/min(prices)-1<=0.0035 and total>=min_usd:
                    marked.update(index2 for index2,_ in window)
            fractional_indexes[address]=marked

        stats={}
        for address,rows in events.items():
            row=stats.setdefault(address,{'address':address,'observed_trades':0,'buy_trades':0,'sell_trades':0,'buy_usd':0.0,'sell_usd':0.0,'large_buy_usd':0.0,'large_sell_usd':0.0,'total_usd':0.0,'fractional_trades':0,'fractional_usd':0.0,'other_trades':0,'other_usd':0.0,'large_trades':0,'large_usd':0.0,'last_time':0})
            fractional=fractional_indexes.get(address,set())
            for index,event in enumerate(rows):
                usd=event['usd']; row['observed_trades']+=1; row['total_usd']+=usd; row['last_time']=max(row['last_time'],event['time'])
                if event['side']=='BUY': row['buy_trades']+=1; row['buy_usd']+=usd
                else: row['sell_trades']+=1; row['sell_usd']+=usd
                if index in fractional:
                    row['fractional_trades']+=1; row['fractional_usd']+=usd; row['large_trades']+=1; row['large_usd']+=usd
                    if event['side']=='BUY': row['large_buy_usd']+=usd
                    else: row['large_sell_usd']+=usd
                elif usd>=min_usd:
                    row['other_trades']+=1; row['other_usd']+=usd; row['large_trades']+=1; row['large_usd']+=usd
                    if event['side']=='BUY': row['large_buy_usd']+=usd
                    else: row['large_sell_usd']+=usd

        qualified=[row for row in stats.values() if row['large_usd']>0]
        ranked=sorted(qualified,key=lambda row:(row['large_usd'],row['total_usd']),reverse=True)[:limit]
        for row in ranked:
            total=row['large_buy_usd']+row['large_sell_usd']; classified=row['fractional_usd']+row['other_usd']
            row['buy_pct']=row['large_buy_usd']/total*100 if total else 0.0; row['sell_pct']=row['large_sell_usd']/total*100 if total else 0.0
            row['fractional_pct']=row['fractional_usd']/classified*100 if classified else 0.0; row['other_pct']=row['other_usd']/classified*100 if classified else 0.0
            row['dominance']='ПОКУПКИ' if row['large_buy_usd']>row['large_sell_usd'] else ('ПРОДАЖИ' if row['large_sell_usd']>row['large_buy_usd'] else 'БАЛАНС')

        total_buy=sum(row['large_buy_usd'] for row in ranked); total_sell=sum(row['large_sell_usd'] for row in ranked); total_fractional=sum(row['fractional_usd'] for row in ranked); total_other=sum(row['other_usd'] for row in ranked); classified=total_fractional+total_other
        summary={'coin':coin,'lookback_hours':24,'start':start,'end':now,'requested_accounts':limit,'accounts_found':len(stats),'accounts_qualified':len(qualified),'accounts_returned':len(ranked),'market_trades_24h':len(market_rows),'market_trades_above_threshold':sum(1 for row in market_rows if row['usd']>=min_usd),'min_usd':min_usd,'buy_usd':total_buy,'sell_usd':total_sell,'total_usd':total_buy+total_sell,'fractional_usd':total_fractional,'other_usd':total_other,'buy_pct':total_buy/(total_buy+total_sell)*100 if total_buy+total_sell else 0.0,'sell_pct':total_sell/(total_buy+total_sell)*100 if total_buy+total_sell else 0.0,'fractional_pct':total_fractional/classified*100 if classified else 0.0,'other_pct':total_other/classified*100 if classified else 0.0,'fractional_accounts':sum(1 for row in ranked if row['fractional_usd']>0),'other_accounts':sum(1 for row in ranked if row['other_usd']>0),'buy_dominant_accounts':sum(1 for row in ranked if row['dominance']=='ПОКУПКИ'),'sell_dominant_accounts':sum(1 for row in ranked if row['dominance']=='ПРОДАЖИ'),'balance_accounts':sum(1 for row in ranked if row['dominance']=='БАЛАНС')}
        moscow_now=datetime.now(ZoneInfo('Europe/Moscow'))
        def money(value): return f'${value:,.2f}'
        lines=['ОТЧЁТ HYPERLIQUID: АНАЛИЗ ЗА 24 ЧАСА',f'Монета: {coin}',f'Период MSK: {datetime.fromtimestamp(start/1000,ZoneInfo("Europe/Moscow")).strftime("%Y-%m-%d %H:%M:%S")} — {moscow_now.strftime("%Y-%m-%d %H:%M:%S")}',f'Порог сделки: {money(min_usd)} · проанализировано адресов: {len(stats)} · с объёмом от порога: {len(qualified)} · показано: {len(ranked)}','', 'ИТОГОВЫЕ ПРОЦЕНТЫ',f'Классифицированный объём: {money(summary["total_usd"])}',f'Покупки: {money(total_buy)} ({summary["buy_pct"]:.2f}%)',f'Продажи: {money(total_sell)} ({summary["sell_pct"]:.2f}%)',f'Дробленные исполнения: {money(total_fractional)} ({summary["fractional_pct"]:.2f}% от классифицированного объёма)',f'Другие сделки: {money(total_other)} ({summary["other_pct"]:.2f}% от классифицированного объёма)',f'Аккаунты: покупки больше {summary["buy_dominant_accounts"]} · продажи больше {summary["sell_dominant_accounts"]} · баланс {summary["balance_accounts"]}',f'Сигнал дробления: {summary["fractional_accounts"]} аккаунтов · обычные сделки: {summary["other_accounts"]} аккаунтов','', 'ОГРАНИЧЕНИЕ ДАННЫХ','Это реальный public recentTrades поток Hyperliquid. Он показывает участников сделки, но не раскрывает, какой конкретно адрес был покупателем или продавцом. Поэтому BUY/SELL здесь — рыночная сторона, а PnL аккаунта не подменяется догадкой.','', 'АККАУНТЫ']
        for index,row in enumerate(ranked,1): lines.append(f'{index}. {row["address"]} · {row["dominance"]} · объём от порога {money(row["large_usd"])} · BUY {row["buy_pct"]:.2f}% · SELL {row["sell_pct"]:.2f}% · дробление {row["fractional_pct"]:.2f}% · обычные {row["other_pct"]:.2f}% · сделок {row["observed_trades"]}')
        content='\n'.join(lines)+'\n'; stamp=time.strftime('%Y%m%d_%H%M%S'); report_path=os.path.join(REPORT_DIR,f'hyperliquid_24h_analysis_{stamp}.txt')
        try:
            with open(report_path,'w',encoding='utf-8') as report_file: report_file.write(content)
        except Exception as error:
            report_path=None
        self.send_json({'source':'hyperliquid','summary':summary,'accounts':ranked,'report_path':report_path,'report':content,'method':'real_market_trades','pnl_available':False})
    def hyperliquid_radar_status(self):
        with RADAR_LOCK: state=dict(RADAR_STATE); state['config']=dict(RADAR_STATE['config'])
        rows=radar_rows(); self.send_json({'running':state['running'],'scanning':state['scanning'],'started_at':state['started_at'],'last_scan_at':state['last_scan_at'],'last_error':state['last_error'],'config':state['config'],'count':len(rows),'database_path':RADAR_DB,'addresses':rows})
    def hyperliquid_radar_start(self,item):
        radar_start_state(item,self.hyperliquid_radar_worker); self.hyperliquid_radar_status()
    def hyperliquid_radar_stop(self):
        radar_stop_state(); self.hyperliquid_radar_status()
    def hyperliquid_radar_worker(self):
        while True:
            with RADAR_LOCK:
                if not RADAR_STATE['running']: return
                config=dict(RADAR_STATE['config']); RADAR_STATE['scanning']=True; RADAR_STATE['last_error']=None
            try:
                prune_events()
                self.hyperliquid_radar_scan(config)
            except Exception as error:
                with RADAR_LOCK: RADAR_STATE['last_error']=str(error)
            finally:
                with RADAR_LOCK: RADAR_STATE['scanning']=False; RADAR_STATE['last_scan_at']=int(time.time()*1000)
            if RADAR_STOP.wait(30): return
    def hyperliquid_radar_scan(self,config):
        now=int(time.time()*1000); window_ms=config['window_seconds']*1000; fresh,_=self.recent_market_trades('ALL',100)
        candidates=[]
        for item in fresh:
            event_time=int(item.get('time') or 0)
            if event_time<now-config['max_age_seconds']*1000: continue
            for address in normalize_addresses(item.get('users') or []):
                if address not in candidates: candidates.append(address)
        for user in candidates[:10]:
            fills_raw,_=self.hyperliquid_fills_range(user,now-window_ms,now); fills=[self.normalize_fill(fill,user) for fill in fills_raw]
            last_fill=max((int(fill.get('time') or 0) for fill in fills),default=0)
            closed_pnl=sum(fill['closed_pnl'] for fill in fills); fees=sum(abs(fill['fee']) for fill in fills); net_closed=closed_pnl-fees
            positive_times=[int(fill['time']) for fill in fills if fill['closed_pnl']>0 and fill.get('time')]
            if not positive_times or last_fill<now-config['max_age_seconds']*1000 or net_closed<config['min_pnl']: continue
            age_cutoff=now-150*24*60*60*1000; first_profit,_=self.hyperliquid_first_profitable_close(user,age_cutoff)
            if not first_profit: continue
            account=self.hyperliquid_request({'type':'clearinghouseState','user':user}); margin=account.get('marginSummary') or account.get('crossMarginSummary') or {}; positions=[]
            for raw in account.get('assetPositions',[]):
                position=raw.get('position',{}); size=float(position.get('szi',0) or 0)
                if size: positions.append({'coin':position.get('coin'),'side':'LONG' if size>0 else 'SHORT','unrealized_pnl':float(position.get('unrealizedPnl',0) or 0),'position_value':float(position.get('positionValue',0) or 0)})
            open_pnl=sum(position['unrealized_pnl'] for position in positions); actions={name:sum(1 for fill in fills if fill['action']==name) for name in ('Open Long','Close Long','Open Short','Close Short')}
            radar_upsert({'address':user,'last_seen':last_fill,'last_scan':now,'account_age_days':(now-first_profit)/86400000,'account_value':float(margin.get('accountValue',0) or 0),'closed_pnl':net_closed,'open_pnl':open_pnl,'total_pnl':net_closed+open_pnl,'pnl_duration_seconds':max(0,(max(positive_times)-min(positive_times))/1000),'window_seconds':config['window_seconds'],'actions':actions,'positions':positions})
    def hyperliquid_12h_whales(self,query):
        """Collect a cached 12-hour whale PnL report from exact user fills."""
        coin=(query.get('coin',[''])[0] or '').strip().upper() or 'ALL'
        min_usd=max(float(query.get('minUsd',['500'])[0] or 500),0)
        min_pnl=max(float(query.get('minPnl',['0'])[0] or 0),0)
        min_age_days=max(int(query.get('minAgeDays',['120'])[0] or 120),0)
        require_positive_win_rate=query.get('requirePositiveWinRate',['1'])[0]!='0'
        require_last_trade_today=query.get('requireLastTradeToday',['1'])[0]!='0'
        max_accounts=min(max(int(query.get('maxAccounts',['20'])[0] or 20),5),50)
        cache_key=('12h-v3',coin,min_usd,min_pnl,min_age_days,require_positive_win_rate,require_last_trade_today,max_accounts)
        now=int(time.time()*1000); cache_ttl=5*60*1000
        with HL_12H_REPORT_LOCK:
            cached=HL_12H_REPORT_CACHE.get(cache_key)
            if cached and now-cached['created_at']<cache_ttl:
                payload=dict(cached['payload']); payload['cached']=True; payload['cache_age_seconds']=round((now-cached['created_at'])/1000,1); self.send_json(payload); return
        start=now-12*60*60*1000
        report_zone=ZoneInfo('Europe/Moscow'); report_day=datetime.fromtimestamp(now/1000,report_zone).date(); age_cutoff=now-min_age_days*24*60*60*1000
        # One market refresh per cache window, then use the locally captured
        # stream to discover the largest public participants.
        try:
            fresh_rows,_=self.recent_market_trades(coin,500)
            fresh=[{'source':'hyperliquid','kind':'market_trade','coin':x.get('coin',coin),'side':'SELL' if x.get('side')=='A' else 'BUY','price':float(x.get('px',0) or 0),'size':float(x.get('sz',0) or 0),'usd':float(x.get('px',0) or 0)*float(x.get('sz',0) or 0),'time':x.get('time'),'tx_hash':x.get('hash'),'trade_id':x.get('tid'),'participants':x.get('users',[])} for x in fresh]
            append_rows('hyperliquid',fresh)
        except Exception:
            fresh=[]
        discovered={}; seen=set()
        for item in read_db().get('hyperliquid',[]):
            if item.get('kind')!='market_trade': continue
            event_time=int(item.get('time') or 0)
            if event_time<start or event_time>now: continue
            asset=str(item.get('coin') or '').upper()
            if coin!='ALL' and asset!=coin: continue
            usd=float(item.get('usd',0) or 0)
            if usd<min_usd: continue
            participants=normalize_addresses(item.get('participants') or [])
            key=(asset,item.get('trade_id'),event_time,item.get('tx_hash'),tuple(participants))
            if key in seen: continue
            seen.add(key)
            for address in participants:
                row=discovered.setdefault(address,{'address':address,'market_volume_usd':0.0,'market_trades':0,'last_market_time':0})
                row['market_volume_usd']+=usd; row['market_trades']+=1; row['last_market_time']=max(row['last_market_time'],event_time)
        saved=load_saved_addresses()
        # A temporary gap in public recentTrades must not exclude addresses the
        # user explicitly saved for monitoring and historical PnL analysis.
        for address in saved:
            discovered.setdefault(address,{'address':address,'market_volume_usd':0.0,'market_trades':0,'last_market_time':0})
        candidates=sorted(discovered.values(),key=lambda row:(1 if row['address'] in saved else 0,row['market_volume_usd']),reverse=True)[:max_accounts]
        actions=('Open Long','Close Long','Open Short','Close Short','Settlement','Other')
        def blank_action(): return {action:{'fills':0,'volume_usd':0.0,'closed_pnl':0.0} for action in actions}
        def frequency_label(fill_times):
            if len(fill_times)<2: return 'Нет повторов за период',None
            gaps=[later-earlier for earlier,later in zip(fill_times,fill_times[1:]) if later>earlier]
            if not gaps: return 'Несколько fills в один момент',0
            median_seconds=statistics.median(gaps)/1000
            if median_seconds<60: return f'примерно каждые {median_seconds:.0f} сек',median_seconds
            if median_seconds<3600: return f'примерно каждые {median_seconds/60:.1f} мин',median_seconds
            return f'примерно каждые {median_seconds/3600:.1f} ч',median_seconds
        def analyze(user_row):
            user=user_row['address']
            try:
                raw_fills,fill_history_truncated=self.hyperliquid_fills_range(user,start,now)
                scoped=[self.normalize_fill(item,user) for item in raw_fills if coin=='ALL' or str(item.get('coin','')).upper()==coin]
                fills=[item for item in scoped if item['usd']>=min_usd]
                action_totals=blank_action(); gross_profit=0.0; gross_loss=0.0; closed_pnl=0.0; fees=0.0; volume=0.0; closing_volume=0.0; profitable_closes=0; losing_closes=0
                for fill in fills:
                    action=fill['action'] if fill['action'] in actions else 'Other'; pnl=fill['closed_pnl']; action_totals[action]['fills']+=1; action_totals[action]['volume_usd']+=fill['usd']; action_totals[action]['closed_pnl']+=pnl; gross_profit+=max(pnl,0); gross_loss+=min(pnl,0); closed_pnl+=pnl; fees+=abs(fill['fee']); volume+=fill['usd']
                    if pnl>0: profitable_closes+=1; closing_volume+=fill['usd']
                    elif pnl<0: losing_closes+=1; closing_volume+=fill['usd']
                realized_closes=profitable_closes+losing_closes; win_rate=profitable_closes/realized_closes*100 if realized_closes else None
                net_pnl=closed_pnl-fees; gross_return_pct=gross_profit/volume*100 if volume else None; net_pct_gross=net_pnl/gross_profit*100 if gross_profit else None; net_closed_return_pct=net_pnl/closing_volume*100 if closing_volume else None
                fill_times=sorted(int(fill['time']) for fill in fills if fill.get('time'))
                frequency,typical_gap_seconds=frequency_label(fill_times)
                recent_fills=sorted(fills,key=lambda fill:int(fill.get('time') or 0),reverse=True)[:30]
                last_fill_time=max([int(fill.get('time') or 0) for fill in scoped],default=0); last_trade_today=bool(last_fill_time and datetime.fromtimestamp(last_fill_time/1000,report_zone).date()==report_day)
                base={'address':user,'market_volume_usd':user_row['market_volume_usd'],'market_trades':user_row['market_trades'],'fills':len(fills),'volume_usd':volume,'gross_profit':gross_profit,'gross_loss':gross_loss,'closed_pnl_before_fees':closed_pnl,'fees':fees,'net_pnl':net_pnl,'net_pct_of_gross_profit':net_pct_gross,'gross_return_pct_on_volume':gross_return_pct,'net_closed_return_pct':net_closed_return_pct,'closing_volume_usd':closing_volume,'profitable_close_fills':profitable_closes,'losing_close_fills':losing_closes,'realized_close_fills':realized_closes,'profitable_close_rate_pct':win_rate,'last_fill_time':last_fill_time,'last_trade_today':last_trade_today,'first_profitable_close_time':0,'first_profitable_close_age_days':None,'age_qualified':False,'age_history_truncated':False,'open_pnl':None,'total_pnl_including_open':None,'total_pct_of_gross_profit':None,'account_value':None,'withdrawable':None,'positions':[],'profitable_open_positions':0,'losing_open_positions':0,'flat_open_positions':0,'open_position_profit_rate_pct':None,'profitable_open_pnl':0.0,'losing_open_pnl':0.0,'actions':action_totals,'frequency':frequency,'typical_gap_seconds':typical_gap_seconds,'recent_fills':recent_fills,'fill_history_truncated':fill_history_truncated,'error':None}
                if (require_positive_win_rate and not (win_rate and win_rate>0)) or (require_last_trade_today and not last_trade_today): return base
                state=self.hyperliquid_request({'type':'clearinghouseState','user':user}); margin=state.get('marginSummary') or state.get('crossMarginSummary') or {}; positions=[]
                for raw_position in state.get('assetPositions',[]):
                    position=raw_position.get('position',{}); size=float(position.get('szi',0) or 0)
                    if not size: continue
                    positions.append({'coin':position.get('coin'),'side':'LONG' if size>0 else 'SHORT','size':size,'entry_price':float(position.get('entryPx',0) or 0),'position_value':float(position.get('positionValue',0) or 0),'unrealized_pnl':float(position.get('unrealizedPnl',0) or 0),'liquidation_price':position.get('liquidationPx')})
                open_pnl=sum(position['unrealized_pnl'] for position in positions); total_pnl=net_pnl+open_pnl; total_pct_gross=total_pnl/gross_profit*100 if gross_profit else None
                profitable_positions=[position for position in positions if position['unrealized_pnl']>0]; losing_positions=[position for position in positions if position['unrealized_pnl']<0]; flat_positions=[position for position in positions if position['unrealized_pnl']==0]; decided_positions=len(profitable_positions)+len(losing_positions)
                base.update({'open_pnl':open_pnl,'total_pnl_including_open':total_pnl,'total_pct_of_gross_profit':total_pct_gross,'account_value':float(margin.get('accountValue',0) or 0),'withdrawable':float(state.get('withdrawable',0) or 0),'positions':positions,'profitable_open_positions':len(profitable_positions),'losing_open_positions':len(losing_positions),'flat_open_positions':len(flat_positions),'open_position_profit_rate_pct':len(profitable_positions)/decided_positions*100 if decided_positions else None,'profitable_open_pnl':sum(position['unrealized_pnl'] for position in profitable_positions),'losing_open_pnl':sum(position['unrealized_pnl'] for position in losing_positions)})
                if total_pnl<min_pnl: return base
                first_profitable_time,age_history_truncated=self.hyperliquid_first_profitable_close(user,age_cutoff); first_profitable_age=(now-first_profitable_time)/86400000 if first_profitable_time else None
                base.update({'first_profitable_close_time':first_profitable_time,'first_profitable_close_age_days':first_profitable_age,'age_qualified':first_profitable_age is not None and first_profitable_age>=min_age_days,'age_history_truncated':age_history_truncated})
                return base
            except Exception as error:
                return {'address':user,'market_volume_usd':user_row['market_volume_usd'],'market_trades':user_row['market_trades'],'fills':0,'volume_usd':0.0,'gross_profit':0.0,'gross_loss':0.0,'closed_pnl_before_fees':0.0,'fees':0.0,'net_pnl':0.0,'net_pct_of_gross_profit':None,'gross_return_pct_on_volume':None,'net_closed_return_pct':None,'closing_volume_usd':0.0,'profitable_close_fills':0,'losing_close_fills':0,'realized_close_fills':0,'profitable_close_rate_pct':None,'last_fill_time':0,'last_trade_today':False,'first_profitable_close_time':0,'first_profitable_close_age_days':None,'age_qualified':False,'age_history_truncated':False,'open_pnl':None,'total_pnl_including_open':None,'total_pct_of_gross_profit':None,'account_value':None,'withdrawable':None,'positions':[],'profitable_open_positions':0,'losing_open_positions':0,'flat_open_positions':0,'open_position_profit_rate_pct':None,'profitable_open_pnl':0.0,'losing_open_pnl':0.0,'actions':blank_action(),'frequency':'нет данных','typical_gap_seconds':None,'recent_fills':[],'fill_history_truncated':False,'error':str(error)}
        with ThreadPoolExecutor(max_workers=2) as pool: rows=list(pool.map(analyze,candidates))
        valid=[row for row in rows if not row.get('error')]
        pnl_qualified=[row for row in valid if row.get('total_pnl_including_open') is not None and row['total_pnl_including_open']>=min_pnl]
        win_qualified=[row for row in pnl_qualified if not require_positive_win_rate or (row.get('profitable_close_rate_pct') or 0)>0]
        today_active=[row for row in win_qualified if row.get('last_trade_today')]
        end_of_day_open=[row for row in win_qualified if not row.get('last_trade_today') and row.get('positions')]
        today_qualified=today_active if require_last_trade_today else today_active+end_of_day_open
        qualified=[row for row in today_qualified if row.get('age_qualified')]
        qualified.sort(key=lambda row:(row['total_pnl_including_open'],row['net_pnl'],row['market_volume_usd']),reverse=True)
        rows=qualified
        totals={'gross_profit':sum(row['gross_profit'] for row in qualified),'gross_loss':sum(row['gross_loss'] for row in qualified),'closed_pnl_before_fees':sum(row['closed_pnl_before_fees'] for row in qualified),'fees':sum(row['fees'] for row in qualified),'net_pnl':sum(row['net_pnl'] for row in qualified),'open_pnl':sum(row['open_pnl'] for row in qualified),'volume_usd':sum(row['volume_usd'] for row in qualified),'closing_volume_usd':sum(row['closing_volume_usd'] for row in qualified),'profitable_close_fills':sum(row['profitable_close_fills'] for row in qualified),'losing_close_fills':sum(row['losing_close_fills'] for row in qualified),'profitable_open_positions':sum(row['profitable_open_positions'] for row in qualified),'losing_open_positions':sum(row['losing_open_positions'] for row in qualified),'profitable_open_pnl':sum(row['profitable_open_pnl'] for row in qualified),'losing_open_pnl':sum(row['losing_open_pnl'] for row in qualified)}; totals['realized_close_fills']=totals['profitable_close_fills']+totals['losing_close_fills']; totals['profitable_close_rate_pct']=totals['profitable_close_fills']/totals['realized_close_fills']*100 if totals['realized_close_fills'] else None; totals['net_closed_return_pct']=totals['net_pnl']/totals['closing_volume_usd']*100 if totals['closing_volume_usd'] else None; totals['net_pct_of_gross_profit']=totals['net_pnl']/totals['gross_profit']*100 if totals['gross_profit'] else None; totals['gross_return_pct_on_volume']=totals['gross_profit']/totals['volume_usd']*100 if totals['volume_usd'] else None; totals['total_pnl_including_open']=totals['net_pnl']+totals['open_pnl']; totals['total_pct_of_gross_profit']=totals['total_pnl_including_open']/totals['gross_profit']*100 if totals['gross_profit'] else None
        action_totals=blank_action()
        for row in qualified:
            for action,item in row['actions'].items():
                action_totals[action]['fills']+=item['fills']; action_totals[action]['volume_usd']+=item['volume_usd']; action_totals[action]['closed_pnl']+=item['closed_pnl']
        moscow_now=datetime.now(ZoneInfo('Europe/Moscow'))
        def money(value): return 'нет данных' if value is None else ('$' if value>=0 else '-$')+f'{abs(value):,.2f}'
        def pct(value): return 'нет данных' if value is None else f'{value:+.2f}%'
        def positions_text(row): return '; '.join(f"{position['coin']} {position['side']} value={money(position['position_value'])} uPnL={money(position['unrealized_pnl'])} liq={position['liquidation_price'] or '—'}" for position in row.get('positions',[])) or 'нет открытых позиций'
        activity_requirement=f'последняя сделка {report_day.isoformat()} MSK' if require_last_trade_today else 'адреса без сделки сегодня остаются только при подтверждённой открытой позиции'
        lines=['ОТЧЁТ HYPERLIQUID: PNL ЗА 12 ЧАСОВ',f'Монета: {coin}',f'Период MSK: {datetime.fromtimestamp(start/1000,report_zone).strftime("%Y-%m-%d %H:%M:%S")} — {moscow_now.strftime("%Y-%m-%d %H:%M:%S")}',f'Обязательные фильтры: первая прибыльная закрытая сделка не менее {min_age_days} дней назад · процент прибыльных закрытий > 0% · {activity_requirement}',f'Порог сделки: {money(min_usd)} · порог итогового PnL (net closed + open): {money(min_pnl)} · кандидатов: {len(discovered)} · проверено: {len(valid)} · PnL: {len(pnl_qualified)} · с положительным win rate: {len(win_qualified)} · активны сегодня: {len(today_active)} · открытые на конец дня: {len(end_of_day_open)} · прошло все фильтры: {len(qualified)}','', 'ИТОГ ПО АДРЕСАМ, ПРОШЕДШИМ ВСЕ ФИЛЬТРЫ',f'Объём fills: {money(totals["volume_usd"])}',f'Грязная прибыль (положительный closed PnL): {money(totals["gross_profit"])}',f'Грязный результат до комиссий: {money(totals["closed_pnl_before_fees"])}',f'Убытки в закрытых сделках: {money(totals["gross_loss"])}',f'Комиссии: {money(totals["fees"])}',f'Чистый PnL после комиссий: {money(totals["net_pnl"])}',f'Прибыльные закрытия: {totals["profitable_close_fills"]} из {totals["realized_close_fills"]} · win rate {pct(totals["profitable_close_rate_pct"])}',f'Чистая доходность closed PnL от объёма закрытий: {pct(totals["net_closed_return_pct"])}',f'Открытые позиции в плюсе: {totals["profitable_open_positions"]} · PnL {money(totals["profitable_open_pnl"])}; в минусе: {totals["losing_open_positions"]} · PnL {money(totals["losing_open_pnl"])}',f'Открытый PnL сейчас: {money(totals["open_pnl"])}',f'Итог с открытым PnL: {money(totals["total_pnl_including_open"])} · от грязной прибыли: {pct(totals["total_pct_of_gross_profit"])}','', 'ДЕЙСТВИЯ LONG / SHORT']
        for action in actions:
            item=action_totals[action]; lines.append(f'{action}: fills {item["fills"]} · объём {money(item["volume_usd"])} · closed PnL {money(item["closed_pnl"])}')
        lines += ['', 'АДРЕСА КИТОВ И ПОЛНЫЙ PNL']
        for index,row in enumerate(rows,1):
            first_profitable=datetime.fromtimestamp(row['first_profitable_close_time']/1000,report_zone).strftime('%Y-%m-%d %H:%M:%S MSK') if row.get('first_profitable_close_time') else 'нет данных'; last_fill=datetime.fromtimestamp(row['last_fill_time']/1000,report_zone).strftime('%Y-%m-%d %H:%M:%S MSK') if row.get('last_fill_time') else 'нет данных'
            decided_positions=row['profitable_open_positions']+row['losing_open_positions']
            lines += [f'{index}. {row["address"]}',f'   Hyperliquid Explorer: https://app.hyperliquid.xyz/explorer/address/{row["address"]}',f'   Первая прибыльная закрытая сделка: {first_profitable} · возраст: {row["first_profitable_close_age_days"]:.1f} дней · история возраста: {"частичная" if row.get("age_history_truncated") else "доступная полностью"}',f'   Последняя сделка: {last_fill} · в день отчёта: {"да" if row.get("last_trade_today") else "нет"}',f'   Market-объём кандидата: {money(row["market_volume_usd"])} · fills от порога: {row["fills"]} · объём fills: {money(row["volume_usd"])}',f'   История fills: {"полная за период" if not row.get("fill_history_truncated") else "может быть неполной: API достиг лимита даже после разбиения"}',f'   Прибыльные закрытия: {row["profitable_close_fills"]} из {row["realized_close_fills"]} · win rate {pct(row["profitable_close_rate_pct"])} · дали {money(row["gross_profit"])}',f'   Убыточные закрытия: {row["losing_close_fills"]} · дали {money(row["gross_loss"])} · чистая доходность closed от объёма закрытий: {pct(row["net_closed_return_pct"])}',f'   Чистый PnL: {money(row["net_pnl"])} · комиссии: {money(row["fees"])} · чистый от грязной прибыли: {pct(row["net_pct_of_gross_profit"])}',f'   Открытые позиции в плюсе: {row["profitable_open_positions"]} из {decided_positions} ({pct(row["open_position_profit_rate_pct"])}) · плюс {money(row["profitable_open_pnl"])}; в минусе: {row["losing_open_positions"]} · {money(row["losing_open_pnl"])}',f'   Открытый PnL: {money(row["open_pnl"])} · итог с открытым: {money(row["total_pnl_including_open"])} · account value: {money(row["account_value"])}',f'   Частота fills: {row["frequency"]}',f'   Open Long {row["actions"]["Open Long"]["fills"]} · Close Long {row["actions"]["Close Long"]["fills"]} · Open Short {row["actions"]["Open Short"]["fills"]} · Close Short {row["actions"]["Close Short"]["fills"]}',f'   Позиции: {positions_text(row)}','   Последние fills:']
            for fill in row.get('recent_fills',[]):
                fill_time=datetime.fromtimestamp(int(fill.get('time') or 0)/1000,ZoneInfo('Europe/Moscow')).strftime('%Y-%m-%d %H:%M:%S') if fill.get('time') else 'нет времени'
                lines.append(f'     {fill_time} MSK · {fill.get("coin") or "—"} · {fill.get("action") or "—"} · {fill.get("side") or "—"} · цена {fill.get("price",0):.6f} · USD {money(fill.get("usd",0))} · closed PnL {money(fill.get("closed_pnl",0))} · fee {money(abs(fill.get("fee",0)))}')
            if row.get('error'): lines.append(f'   Ошибка: {row["error"]}')
        lines += ['', 'МЕТОДИКА','Кандидаты выбраны из реального public market-потока и сохранённых адресов. PnL, Long/Short и Open/Close взяты из userFillsByTime Hyperliquid.','Win rate = число fills с closedPnl > 0 / число fills с closedPnl != 0 × 100. Нулевой closedPnl не считается закрытием и не искажает процент.','Возраст считается от первой найденной прибыльной закрытой сделки. Если исторический ответ достиг лимита API, дата остаётся подтверждением возраста не менее порога, но может быть не самой первой сделкой аккаунта.','Последняя сделка обязана иметь московскую дату, совпадающую с датой формирования отчёта. Отчёт кэшируется на 5 минут и не запускается автоматически.']
        content='\n'.join(lines)+'\n'; stamp=time.strftime('%Y%m%d_%H%M%S'); report_path=os.path.join(REPORT_DIR,f'hyperliquid_12h_whales_{stamp}.txt')
        try:
            with open(report_path,'w',encoding='utf-8') as report_file: report_file.write(content)
        except Exception as error:
            report_path=None; content += f'\nНе удалось записать отчёт на рабочий стол: {error}\n'
        payload={'source':'hyperliquid','coin':coin,'period_ms':{'start':start,'end':now},'report_day_msk':report_day.isoformat(),'threshold_usd':min_usd,'min_pnl':min_pnl,'min_age_days':min_age_days,'require_positive_win_rate':require_positive_win_rate,'require_last_trade_today':require_last_trade_today,'requested_whales':max_accounts,'candidate_count':len(discovered),'checked_count':len(candidates),'valid_count':len(valid),'pnl_qualified_count':len(pnl_qualified),'win_qualified_count':len(win_qualified),'today_qualified_count':len(today_active),'end_of_day_open_count':len(end_of_day_open),'qualified_count':len(qualified),'totals':totals,'actions':action_totals,'whales':rows,'report_path':report_path,'report':content,'cached':False,'cache_age_seconds':0,'request_policy':{'report_cache_seconds':300,'max_concurrent_requests':2,'age_history_cache':True}}
        with HL_12H_REPORT_LOCK:
            HL_12H_REPORT_CACHE[cache_key]={'created_at':now,'payload':payload}
            if len(HL_12H_REPORT_CACHE)>32:
                for stale in sorted(HL_12H_REPORT_CACHE,key=lambda k:HL_12H_REPORT_CACHE[k]['created_at'])[:16]: HL_12H_REPORT_CACHE.pop(stale,None)
        self.send_json(payload)
    def hyperliquid_24h_deep(self,query):
        """Deep 24-hour account report with age, order type and modeled fees."""
        coin=(query.get('coin',[''])[0] or '').strip().upper() or 'ALL'
        min_usd=max(float(query.get('minUsd',['150'])[0] or 150),0)
        max_accounts=min(max(int(query.get('maxAccounts',['30'])[0] or 30),5),50)
        min_age_days=max(int(query.get('minAgeDays',['60'])[0] or 60),0)
        fee_rate=max(float(query.get('feeRate',['0.002'])[0] or 0.002),0)
        cache_key=('deep24-v2',coin,min_usd,max_accounts,min_age_days,fee_rate); now=int(time.time()*1000); cache_ttl=10*60*1000
        with HL_12H_REPORT_LOCK:
            cached=HL_12H_REPORT_CACHE.get(cache_key)
            if cached and now-cached['created_at']<cache_ttl:
                payload=dict(cached['payload']); payload['cached']=True; payload['cache_age_seconds']=round((now-cached['created_at'])/1000,1); self.send_json(payload); return
        # Reuse the last completed ALL-coin report after a server restart.
        # This avoids an immediate duplicate burst against Hyperliquid; a
        # different coin or threshold still triggers a fresh collection.
        try:
            if coin=='ALL' and os.path.exists(HL_DEEP_PERSISTED_CACHE):
                with open(HL_DEEP_PERSISTED_CACHE,encoding='utf-8') as persisted_file: persisted=json.load(persisted_file)
                if float(persisted.get('threshold_usd',-1))==min_usd and int(persisted.get('min_age_days',-1))==min_age_days and abs(float(persisted.get('fee_rate',-1))-fee_rate)<1e-12:
                    persisted['cached']=True; persisted['cache_age_seconds']=None; persisted.setdefault('request_policy',{})['persistent_cache']=True; self.send_json(persisted); return
        except Exception:
            pass
        start=now-24*60*60*1000; history_start=now-180*24*60*60*1000
        try:
            fresh_rows,_=self.recent_market_trades(coin,500)
            fresh=[{'source':'hyperliquid','kind':'market_trade','coin':x.get('coin',coin),'side':'SELL' if x.get('side')=='A' else 'BUY','price':float(x.get('px',0) or 0),'size':float(x.get('sz',0) or 0),'usd':float(x.get('px',0) or 0)*float(x.get('sz',0) or 0),'time':x.get('time'),'tx_hash':x.get('hash'),'trade_id':x.get('tid'),'participants':x.get('users',[])} for x in fresh]
            append_rows('hyperliquid',fresh)
        except Exception:
            fresh=[]
        discovered={}; seen=set()
        for item in read_db().get('hyperliquid',[]):
            if item.get('kind')!='market_trade': continue
            event_time=int(item.get('time') or 0)
            if event_time<start or event_time>now: continue
            asset=str(item.get('coin') or '').upper()
            if coin!='ALL' and asset!=coin: continue
            usd=float(item.get('usd',0) or 0)
            if usd<min_usd: continue
            participants=normalize_addresses(item.get('participants') or [])
            key=(asset,item.get('trade_id'),event_time,item.get('tx_hash'),tuple(participants))
            if key in seen: continue
            seen.add(key)
            for address in participants:
                row=discovered.setdefault(address,{'address':address,'market_volume_usd':0.0,'market_trades':0,'last_market_time':0})
                row['market_volume_usd']+=usd; row['market_trades']+=1; row['last_market_time']=max(row['last_market_time'],event_time)
        saved=load_saved_addresses(); candidate_pool=max_accounts*3
        candidates=sorted(discovered.values(),key=lambda row:(1 if row['address'] in saved else 0,row['market_volume_usd']),reverse=True)[:candidate_pool]
        actions=('Open Long','Close Long','Open Short','Close Short','Settlement','Other')
        order_types=('MARKET/TAKER','LIMIT/MAKER','UNKNOWN')
        def blank_action(): return {action:{'fills':0,'volume_usd':0.0,'closed_pnl':0.0} for action in actions}
        def blank_order_type(): return {order_type:{'fills':0,'volume_usd':0.0} for order_type in order_types}
        def analyze(user_row):
            user=user_row['address']
            try:
                # Start with the short window. Most observed market
                # participants have no qualifying user fill; do not spend
                # extra rate-limited requests on their history/state.
                raw_recent=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':start,'endTime':now})
                normalized_recent=[self.normalize_fill(item,user) for item in raw_recent]
                fills=[item for item in normalized_recent if (coin=='ALL' or str(item.get('coin','')).upper()==coin) and item['usd']>=min_usd]
                if not fills:
                    return {'address':user,'first_operation_time':0,'first_operation_age_days':None,'age_qualified':False,'market_volume_usd':user_row['market_volume_usd'],'market_trades':user_row['market_trades'],'fills':0,'volume_usd':0.0,'gross_profit':0.0,'gross_loss':0.0,'closed_pnl_before_fees':0.0,'actual_fees':0.0,'modeled_fees':0.0,'fee_rate':fee_rate,'net_pnl':0.0,'net_pct_of_gross_profit':None,'gross_return_pct_on_volume':None,'open_pnl':0.0,'total_pnl_including_open':0.0,'total_pct_of_gross_profit':None,'account_value':None,'withdrawable':None,'positions':[],'actions':blank_action(),'order_types':blank_order_type(),'operations':[],'error':None}
                # Hyperliquid caps long userFillsByTime responses. Only active
                # candidates need the long window for age and current state.
                raw_history=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':history_start,'endTime':now})
                normalized_history=[self.normalize_fill(item,user) for item in raw_history]
                first_time=min([int(item.get('time') or 0) for item in normalized_history if int(item.get('time') or 0)>0],default=0); age_days=(now-first_time)/86400000 if first_time else None; age_ok=age_days is not None and age_days>=min_age_days
                state=self.hyperliquid_request({'type':'clearinghouseState','user':user}); margin=state.get('marginSummary') or state.get('crossMarginSummary') or {}; positions=[]
                for raw_position in state.get('assetPositions',[]):
                    position=raw_position.get('position',{}); size=float(position.get('szi',0) or 0)
                    if not size: continue
                    positions.append({'coin':position.get('coin'),'side':'LONG' if size>0 else 'SHORT','size':size,'entry_price':float(position.get('entryPx',0) or 0),'position_value':float(position.get('positionValue',0) or 0),'unrealized_pnl':float(position.get('unrealizedPnl',0) or 0),'liquidation_price':position.get('liquidationPx')})
                action_totals=blank_action(); order_totals=blank_order_type(); gross_profit=0.0; gross_loss=0.0; closed_pnl=0.0; actual_fees=0.0; volume=0.0; operations=[]
                for fill in fills:
                    action=fill['action'] if fill['action'] in actions else 'Other'; order_type='MARKET/TAKER' if fill.get('crossed') is True else ('LIMIT/MAKER' if fill.get('crossed') is False else 'UNKNOWN'); pnl=fill['closed_pnl']; action_totals[action]['fills']+=1; action_totals[action]['volume_usd']+=fill['usd']; action_totals[action]['closed_pnl']+=pnl; order_totals[order_type]['fills']+=1; order_totals[order_type]['volume_usd']+=fill['usd']; gross_profit+=max(pnl,0); gross_loss+=min(pnl,0); closed_pnl+=pnl; actual_fees+=abs(fill['fee']); volume+=fill['usd']; operations.append({'time':fill.get('time'),'coin':fill.get('coin'),'action':action,'order_type':order_type,'side':fill.get('side'),'price':fill.get('price'),'size':fill.get('size'),'usd':fill.get('usd'),'closed_pnl':pnl,'actual_fee':fill.get('fee'),'tx_hash':fill.get('tx_hash')})
                modeled_fees=volume*fee_rate; net_pnl=closed_pnl-modeled_fees; open_pnl=sum(position['unrealized_pnl'] for position in positions); total_pnl=net_pnl+open_pnl; net_pct_gross=net_pnl/gross_profit*100 if gross_profit else None; total_pct_gross=total_pnl/gross_profit*100 if gross_profit else None
                operations.sort(key=lambda operation:int(operation.get('time') or 0),reverse=True)
                return {'address':user,'first_operation_time':first_time,'first_operation_age_days':age_days,'age_qualified':age_ok,'market_volume_usd':user_row['market_volume_usd'],'market_trades':user_row['market_trades'],'fills':len(fills),'volume_usd':volume,'gross_profit':gross_profit,'gross_loss':gross_loss,'closed_pnl_before_fees':closed_pnl,'actual_fees':actual_fees,'modeled_fees':modeled_fees,'fee_rate':fee_rate,'net_pnl':net_pnl,'net_pct_of_gross_profit':net_pct_gross,'gross_return_pct_on_volume':gross_profit/volume*100 if volume else None,'open_pnl':open_pnl,'total_pnl_including_open':total_pnl,'total_pct_of_gross_profit':total_pct_gross,'account_value':float(margin.get('accountValue',0) or 0),'withdrawable':float(state.get('withdrawable',0) or 0),'positions':positions,'actions':action_totals,'order_types':order_totals,'operations':operations[:25],'error':None}
            except Exception as error:
                return {'address':user,'first_operation_time':0,'first_operation_age_days':None,'age_qualified':False,'market_volume_usd':user_row['market_volume_usd'],'market_trades':user_row['market_trades'],'fills':0,'volume_usd':0.0,'gross_profit':0.0,'gross_loss':0.0,'closed_pnl_before_fees':0.0,'actual_fees':0.0,'modeled_fees':0.0,'fee_rate':fee_rate,'net_pnl':0.0,'net_pct_of_gross_profit':None,'gross_return_pct_on_volume':None,'open_pnl':None,'total_pnl_including_open':None,'total_pct_of_gross_profit':None,'account_value':None,'withdrawable':None,'positions':[],'actions':blank_action(),'order_types':blank_order_type(),'operations':[],'error':str(error)}
        with ThreadPoolExecutor(max_workers=2) as pool: checked=list(pool.map(analyze,candidates))
        valid=[row for row in checked if not row.get('error')]; eligible=[row for row in valid if row.get('age_qualified')]; eligible.sort(key=lambda row:(row['net_pnl'],row['gross_profit'],row['market_volume_usd']),reverse=True); selected=eligible[:max_accounts]
        totals={'gross_profit':sum(row['gross_profit'] for row in selected),'gross_loss':sum(row['gross_loss'] for row in selected),'closed_pnl_before_fees':sum(row['closed_pnl_before_fees'] for row in selected),'actual_fees':sum(row['actual_fees'] for row in selected),'modeled_fees':sum(row['modeled_fees'] for row in selected),'net_pnl':sum(row['net_pnl'] for row in selected),'open_pnl':sum(row['open_pnl'] for row in selected),'volume_usd':sum(row['volume_usd'] for row in selected)}; totals['net_pct_of_gross_profit']=totals['net_pnl']/totals['gross_profit']*100 if totals['gross_profit'] else None; totals['gross_return_pct_on_volume']=totals['gross_profit']/totals['volume_usd']*100 if totals['volume_usd'] else None; totals['total_pnl_including_open']=totals['net_pnl']+totals['open_pnl']; totals['total_pct_of_gross_profit']=totals['total_pnl_including_open']/totals['gross_profit']*100 if totals['gross_profit'] else None
        action_totals=blank_action(); order_totals=blank_order_type()
        for row in selected:
            for action,item in row['actions'].items(): action_totals[action]['fills']+=item['fills']; action_totals[action]['volume_usd']+=item['volume_usd']; action_totals[action]['closed_pnl']+=item['closed_pnl']
            for order_type,item in row['order_types'].items(): order_totals[order_type]['fills']+=item['fills']; order_totals[order_type]['volume_usd']+=item['volume_usd']
        moscow_now=datetime.now(ZoneInfo('Europe/Moscow'))
        def money(value): return 'нет данных' if value is None else ('$' if value>=0 else '-$')+f'{abs(value):,.2f}'
        def pct(value): return 'нет данных' if value is None else f'{value:+.2f}%'
        def positions_text(row): return '; '.join(f"{position['coin']} {position['side']} value={money(position['position_value'])} uPnL={money(position['unrealized_pnl'])} liq={position['liquidation_price'] or '—'}" for position in row.get('positions',[])) or 'нет открытых позиций'
        lines=['ОТЧЁТ HYPERLIQUID: ГЛУБОКИЙ АНАЛИЗ ЗА 24 ЧАСА',f'Монета: {coin}',f'Период MSK: {datetime.fromtimestamp(start/1000,ZoneInfo("Europe/Moscow")).strftime("%Y-%m-%d %H:%M:%S")} — {moscow_now.strftime("%Y-%m-%d %H:%M:%S")}',f'Порог сделки: {money(min_usd)} · возраст аккаунта: минимум {min_age_days} дней · кандидатов: {len(discovered)} · проверено: {len(checked)} · допущено: {len(selected)}','', 'ИТОГ ПРИБЫЛИ',f'Объём fills от порога: {money(totals["volume_usd"])}',f'Грязная прибыль (положительный closed PnL): {money(totals["gross_profit"])}',f'Закрытый результат до моделируемых комиссий: {money(totals["closed_pnl_before_fees"])}',f'Моделируемые комиссии {fee_rate*100:.2f}% на каждый fill: {money(totals["modeled_fees"])}',f'Фактические комиссии Hyperliquid: {money(totals["actual_fees"])}',f'Чистый PnL после комиссии {fee_rate*100:.2f}%: {money(totals["net_pnl"])}',f'Чистый PnL от грязной прибыли: {pct(totals["net_pct_of_gross_profit"])}',f'Грязная доходность от объёма: {pct(totals["gross_return_pct_on_volume"])}',f'Открытый PnL сейчас: {money(totals["open_pnl"])}',f'Итог с открытым PnL: {money(totals["total_pnl_including_open"])} · от грязной прибыли: {pct(totals["total_pct_of_gross_profit"])}','', 'LONG / SHORT И ТИП ЗАЯВКИ']
        for action in actions:
            item=action_totals[action]; lines.append(f'{action}: fills {item["fills"]} · объём {money(item["volume_usd"])} · closed PnL {money(item["closed_pnl"])}')
        for order_type in order_types:
            item=order_totals[order_type]; lines.append(f'{order_type}: fills {item["fills"]} · объём {money(item["volume_usd"])}')
        lines += ['', 'АДРЕСА, ВОЗРАСТ, PNL И ОПЕРАЦИИ']
        for index,row in enumerate(selected,1):
            first_time=time.strftime('%Y-%m-%d %H:%M:%S UTC',time.gmtime(row['first_operation_time']/1000)) if row['first_operation_time'] else 'нет данных'
            lines += [f'{index}. {row["address"]}',f'   Hyperliquid Explorer: https://app.hyperliquid.xyz/explorer/address/{row["address"]}',f'   Первая операция: {first_time} · возраст: {row["first_operation_age_days"]:.1f} дней · market объём кандидата: {money(row["market_volume_usd"])}',f'   Fills от порога: {row["fills"]} · объём: {money(row["volume_usd"])} · account value: {money(row["account_value"])}',f'   Грязная прибыль: {money(row["gross_profit"])} · closed до fee: {money(row["closed_pnl_before_fees"])} · fee 0.2%/fill: {money(row["modeled_fees"])} · чистый: {money(row["net_pnl"])} · чистый от gross: {pct(row["net_pct_of_gross_profit"])}',f'   Открытый PnL: {money(row["open_pnl"])} · итог с открытым: {money(row["total_pnl_including_open"])} · от gross: {pct(row["total_pct_of_gross_profit"])}',f'   Open Long {row["actions"]["Open Long"]["fills"]} · Close Long {row["actions"]["Close Long"]["fills"]} · Open Short {row["actions"]["Open Short"]["fills"]} · Close Short {row["actions"]["Close Short"]["fills"]}',f'   Market/Taker: {row["order_types"]["MARKET/TAKER"]["fills"]} · Limit/Maker: {row["order_types"]["LIMIT/MAKER"]["fills"]} · неизвестно: {row["order_types"]["UNKNOWN"]["fills"]}',f'   Позиции: {positions_text(row)}','   Последние операции:']
            for operation in row.get('operations',[]): lines.append(f'      {time.strftime("%Y-%m-%d %H:%M:%S",time.gmtime(int(operation.get("time") or 0)/1000))} {operation.get("coin") or "?"} {operation.get("action")} {operation.get("order_type")} USD={money(operation.get("usd"))} closed={money(operation.get("closed_pnl"))} tx={operation.get("tx_hash") or "—"}')
        lines += ['', 'МЕТОДИКА','Возраст проверяется по первой операции, найденной в 180-дневной истории userFillsByTime. В отчёт допущены аккаунты не моложе заданного порога.','Классификация заявки: crossed=true = MARKET/TAKER, crossed=false = LIMIT/MAKER.','Модель комиссии: 0.20% на каждый фактически исполненный fill. Полный open+close получает около 0.40% комиссии от номинала; будущая комиссия закрытия ещё открытой позиции не начисляется.','Отчёт кэшируется на 10 минут и не запускается автоматически.']
        content='\n'.join(lines)+'\n'; stamp=time.strftime('%Y%m%d_%H%M%S'); report_path=os.path.join(REPORT_DIR,f'hyperliquid_24h_deep_{stamp}.txt')
        try:
            with open(report_path,'w',encoding='utf-8') as report_file: report_file.write(content)
        except Exception as error:
            report_path=None; content += f'\nНе удалось записать отчёт на рабочий стол: {error}\n'
        payload={'source':'hyperliquid','coin':coin,'period_ms':{'start':start,'end':now},'threshold_usd':min_usd,'min_age_days':min_age_days,'fee_rate':fee_rate,'candidate_count':len(discovered),'checked_count':len(checked),'valid_count':len(valid),'eligible_count':len(eligible),'selected_count':len(selected),'newer_count':sum(1 for row in valid if row.get('first_operation_age_days') is not None and row['first_operation_age_days']<min_age_days),'unknown_age_count':sum(1 for row in valid if row.get('first_operation_age_days') is None),'totals':totals,'actions':action_totals,'order_types':order_totals,'accounts':selected,'report_path':report_path,'report':content,'cached':False,'cache_age_seconds':0,'request_policy':{'report_cache_seconds':600,'max_concurrent_requests':2,'history_window_days':180}}
        try:
            with open(HL_DEEP_PERSISTED_CACHE,'w',encoding='utf-8') as persisted_file: json.dump(payload,persisted_file,ensure_ascii=False)
        except Exception:
            pass
        with HL_12H_REPORT_LOCK:
            HL_12H_REPORT_CACHE[cache_key]={'created_at':now,'payload':payload}
            if len(HL_12H_REPORT_CACHE)>32:
                for stale in sorted(HL_12H_REPORT_CACHE,key=lambda k:HL_12H_REPORT_CACHE[k]['created_at'])[:16]: HL_12H_REPORT_CACHE.pop(stale,None)
        self.send_json(payload)
    def hyperliquid_hour_report(self,query):
        """Collect one-hour fills plus current account state and write a readable Desktop report."""
        coin=(query.get('coin',['BTC'])[0] or 'BTC').upper()
        now=int(time.time()*1000); start=now-60*60*1000
        raw=query.get('addresses',[''])[0]
        addresses=[]
        for user in raw.split(','):
            user=user.strip().lower()
            if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in addresses: addresses.append(user)
        # Merge addresses from all Hyperliquid columns already collected by the app.
        for item in read_db().get('hyperliquid',[]):
            if item.get('coin') and str(item.get('coin')).upper()!=coin: continue
            candidates=[]
            candidates += item.get('participants',[]) if isinstance(item.get('participants'),list) else []
            candidates += item.get('users',[]) if isinstance(item.get('users'),list) else []
            candidates += [item.get('address'),item.get('user')]
            for user in candidates:
                user=str(user or '').lower()
                if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in addresses: addresses.append(user)
        # If the UI has not loaded a table yet, discover participants from the live market stream.
        if len(addresses)<2:
            for trade in self.hyperliquid_request({'type':'recentTrades','coin':coin})[:500]:
                for user in trade.get('users',[]):
                    user=str(user).lower()
                    if re.fullmatch(r'0x[a-f0-9]{40}',user) and user not in addresses: addresses.append(user)
        addresses=addresses[:100]
        c=db()
        def previous_snapshot(user):
            snapshot_db=db()
            row=snapshot_db.execute('SELECT unrealized_pnl,captured_at FROM hl_snapshots WHERE address=? AND coin=? AND captured_at<? ORDER BY captured_at DESC LIMIT 1',(user,coin,now)).fetchone()
            snapshot_db.close()
            if not row:return None
            age=now-int(row['captured_at'])
            return {'unrealized_pnl':float(row['unrealized_pnl']),'captured_at':int(row['captured_at']),'age_ms':age} if age<=2*60*60*1000 else None
        def analyze(user):
            try:
                fills=self.hyperliquid_request({'type':'userFillsByTime','user':user,'startTime':start,'endTime':now})
                nf=[self.normalize_fill(x,user) for x in fills]
                state=self.hyperliquid_request({'type':'clearinghouseState','user':user})
                margin=state.get('marginSummary') or state.get('crossMarginSummary') or {}
                positions=[]
                for raw_position in state.get('assetPositions',[]):
                    pos=raw_position.get('position',{}); size=float(pos.get('szi',0) or 0)
                    if not size:continue
                    positions.append({'coin':pos.get('coin'),'side':'LONG' if size>0 else 'SHORT','size':size,'entry_price':float(pos.get('entryPx',0) or 0),'position_value':float(pos.get('positionValue',0) or 0),'unrealized_pnl':float(pos.get('unrealizedPnl',0) or 0),'liquidation_price':pos.get('liquidationPx')})
                open_pnl=sum(x['unrealized_pnl'] for x in positions)
                previous=previous_snapshot(user); delta=(open_pnl-previous['unrealized_pnl']) if previous else None
                row={'address':user,'coin':coin,'fills':len(nf),'closed_pnl':sum(x['closed_pnl'] for x in nf),'fees':sum(x['fee'] for x in nf),'volume_usd':sum(x['usd'] for x in nf),'open_pnl':open_pnl,'open_pnl_change_1h':delta,'previous_open_pnl':previous['unrealized_pnl'] if previous else None,'account_value':float(margin.get('accountValue',0) or 0),'withdrawable':float(state.get('withdrawable',0) or 0),'total_position_value':float(margin.get('totalNtlPos',0) or 0),'margin_used':float(margin.get('totalRawUsd',0) or 0),'positions':positions,'error':None}
                return row
            except Exception as e:
                return {'address':user,'coin':coin,'fills':0,'closed_pnl':0,'fees':0,'volume_usd':0,'open_pnl':None,'open_pnl_change_1h':None,'previous_open_pnl':None,'account_value':None,'withdrawable':None,'total_position_value':None,'margin_used':None,'positions':[],'error':str(e)}
        with ThreadPoolExecutor(max_workers=min(len(addresses),8) or 1) as pool: rows=list(pool.map(analyze,addresses))
        for row in rows:
            if row.get('error') is None:
                c.execute('INSERT INTO hl_snapshots (address,coin,unrealized_pnl,account_value,payload,captured_at) VALUES (?,?,?,?,?,?)',(row['address'],coin,row['open_pnl'],row['account_value'],json.dumps(row),now))
        c.commit(); c.close()
        valid=[x for x in rows if not x.get('error')]
        closed_leader=max(valid,key=lambda x:x['closed_pnl'],default=None); open_leader=max(valid,key=lambda x:x['open_pnl'],default=None); change_rows=[x for x in valid if x.get('open_pnl_change_1h') is not None]; change_leader=max(change_rows,key=lambda x:x['open_pnl_change_1h'],default=None)
        def money(value):return 'нет данных' if value is None else ('$' if value>=0 else '-$')+f'{abs(value):,.2f}'
        def positions_text(row):
            return '; '.join(f"{p['coin']} {p['side']} size={abs(p['size']):.6f} value=${p['position_value']:,.2f} uPnL={money(p['unrealized_pnl'])}" for p in row.get('positions',[])) or 'нет открытых позиций'
        lines=[f'ОТЧЁТ HYPERLIQUID ЗА ПОСЛЕДНИЙ ЧАС',f'Монета: {coin}',f'Период UTC: {time.strftime("%Y-%m-%d %H:%M:%S",time.gmtime(start/1000))} — {time.strftime("%Y-%m-%d %H:%M:%S",time.gmtime(now/1000))}',f'Адресов проверено: {len(rows)}, успешно: {len(valid)}', '', 'ЛИДЕРЫ']
        if closed_leader: lines.append(f"Закрытый PnL за час: {closed_leader['address']} · {money(closed_leader['closed_pnl'])} · fills {closed_leader['fills']}")
        if open_leader: lines.append(f"Текущий открытый PnL: {open_leader['address']} · {money(open_leader['open_pnl'])}")
        if change_leader: lines.append(f"Изменение открытого PnL по снимкам: {change_leader['address']} · {money(change_leader['open_pnl_change_1h'])}")
        lines += ['', 'АДРЕСА И ДАННЫЕ АККАУНТОВ']
        for i,row in enumerate(sorted(rows,key=lambda x:(x.get('closed_pnl',0),x.get('open_pnl') or -float('inf')),reverse=True),1):
            lines += [f'{i}. {row["address"]}',f'   Hyperliquid Explorer: https://app.hyperliquid.xyz/explorer/address/{row["address"]}',f'   Closed PnL за час: {money(row.get("closed_pnl"))} · fills: {row.get("fills",0)} · объём: {money(row.get("volume_usd"))}',f'   Открытый PnL сейчас: {money(row.get("open_pnl"))} · изменение по снимку: {money(row.get("open_pnl_change_1h"))}',f'   Account value: {money(row.get("account_value"))} · доступно: {money(row.get("withdrawable"))} · позиции: {money(row.get("total_position_value"))}',f'   Позиции: {positions_text(row)}']
            if row.get('error'):lines.append(f'   Ошибка: {row["error"]}')
        content='\n'.join(lines)+'\n'; stamp=time.strftime('%Y%m%d_%H%M%S'); report_path=os.path.join(REPORT_DIR,f'hyperliquid_hour_report_{stamp}.txt')
        try:
            with open(report_path,'w',encoding='utf-8') as report_file: report_file.write(content)
        except Exception as e:
            report_path=None; lines.append(f'\nНе удалось записать на рабочий стол: {e}')
        self.send_json({'source':'hyperliquid','coin':coin,'period_ms':{'start':start,'end':now},'count':len(rows),'valid_count':len(valid),'leaders':{'closed':closed_leader,'open':open_leader,'open_change':change_leader},'report_path':report_path,'report':content})
    def scanner_status(self):
        return self.send_json({'sources':{'ethereum':{'name':'Blockscout Ethereum','active':True,'key_required':False},'polygon':{'name':'Blockscout Polygon','active':True,'key_required':False},'bsc':{'name':'BscScan / Etherscan V2','active':bool(BSCSCAN_API_KEY),'key_required':True,'reason':None if BSCSCAN_API_KEY else 'Set BSCSCAN_API_KEY in .env'}}})
    def scanner_transfers(self,query):
        address=query.get('address',[''])[0].lower(); chain=query.get('chain',['ethereum'])[0].lower()
        if not re.fullmatch(r'0x[a-f0-9]{40}',address): raise ValueError('Нужен EVM-адрес 0x...')
        bases={'ethereum':'https://eth.blockscout.com/api/v2','polygon':'https://polygon.blockscout.com/api/v2'}
        if chain in bases:
            url=bases[chain]+'/addresses/'+address+'/token-transfers?type=ERC-20,ERC-721,ERC-1155'; req=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
            with urllib.request.urlopen(req,timeout=20) as r:payload=json.loads(r.read())
        elif chain=='bsc' and BSCSCAN_API_KEY:
            url='https://api.etherscan.io/v2/api?'+urllib.parse.urlencode({'chainid':'56','module':'account','action':'tokentx','address':address,'page':'1','offset':'100','sort':'desc','apikey':BSCSCAN_API_KEY}); req=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
            with urllib.request.urlopen(req,timeout=20) as r:payload=json.loads(r.read()); payload={'items':payload.get('result',[]) if isinstance(payload.get('result'),list) else []}
        else:return self.send_json({'active':False,'source':chain,'error':'Для этой сети scanner не настроен; задай BSCSCAN_API_KEY в .env'},503)
        rows=[]
        for x in payload.get('items',[]):
            token=x.get('token') or {};from_raw=x.get('from') or {};to_raw=x.get('to') or {};from_addr=from_raw.get('hash',from_raw) if isinstance(from_raw,dict) else from_raw;to_addr=to_raw.get('hash',to_raw) if isinstance(to_raw,dict) else to_raw;incoming=str(to_addr).lower()==address
            rows.append({'source':'blockscout' if chain in bases else 'bscscan','chain':chain,'time':x.get('timestamp') or x.get('timeStamp'),'direction':'IN' if incoming else 'OUT','address':address,'token':token.get('symbol') or token.get('name') or x.get('tokenSymbol') or 'unknown','token_address':token.get('address') or x.get('contractAddress'),'value':x.get('total',{}).get('value') if isinstance(x.get('total'),dict) else x.get('value') or x.get('valueDecimal'),'from':from_addr,'to':to_addr,'tx_hash':x.get('transaction_hash') or x.get('tx_hash') or x.get('hash')})
        append_rows('onchain',rows);self.send_json({'source':'blockscout','chain':chain,'transfers':rows,'count':len(rows),'active':True})
    def export_data(self,query):
        dataset=query.get('dataset',['onchain'])[0]; fmt=query.get('format',['csv'])[0].lower(); db_data=read_db(); rows=db_data.get(dataset,[])
        if fmt=='json':
            body=json.dumps(rows,ensure_ascii=False,indent=2).encode();return self.send_bytes(body,'application/json',dataset+'.json',download=True)
        flat=[]
        for row in rows:
            flat.append({k:(json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v) for k,v in row.items()})
        keys=sorted({k for r in flat for k in r})
        out=io.StringIO(); w=csv.DictWriter(out,fieldnames=keys);w.writeheader();w.writerows(flat)
        self.send_bytes(('\ufeff'+out.getvalue()).encode('utf-8'),'text/csv; charset=utf-8',dataset+'.csv',download=True)
    def arkham_transfers(self,query):
        return self.arkham('transfers',query,'transfers')
    def arkham_swaps(self,query):
        return self.arkham('swaps',query,'swaps')
    def arkham(self,route,query,result_key):
        if not ARKHAM_API_KEY:
            return self.send_json({'error':'ARKHAM_API_KEY is not configured','needs_key':True},503)
        params={'limit':min(int(query.get('limit',['100'])[0]),500)}
        aliases={'chain':'chains','startTime':'timeGte','endTime':'timeLte'}
        for key in ('chain','base','from','to','startTime','endTime','usdGte','timeLast','flow','tokens'):
            if query.get(key): params[aliases.get(key,key)]=query[key][0]
        url=ARKHAM_API_URL+'/'+route+'?'+urllib.parse.urlencode(params)
        req=urllib.request.Request(url,headers={'API-Key':ARKHAM_API_KEY,'Accept':'application/json','User-Agent':'LiquidationRadar/1.0'})
        with urllib.request.urlopen(req,timeout=20) as r: payload=json.loads(r.read())
        rows=payload.get(result_key,payload.get('data',[])) if isinstance(payload,dict) else []
        append_rows('onchain',rows)
        self.send_json({'source':'arkham','kind':result_key,result_key:rows,'count':len(rows)})
    def dex_arbitrage(self,query):
        term=query.get('query',['bitcoin'])[0]
        url='https://api.dexscreener.com/latest/dex/search?q='+urllib.parse.quote(term)
        req=urllib.request.Request(url,headers={'User-Agent':'LiquidationRadar/1.0','Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=15) as r: payload=json.loads(r.read())
        pools=[]
        for row in payload.get('pairs',[]):
            try:
                price=float(row.get('priceUsd') or 0); liquidity=float((row.get('liquidity') or {}).get('usd') or 0)
                if price<=0: continue
                base=row.get('baseToken') or {}; quote=row.get('quoteToken') or {}; pools.append({'token':base.get('symbol','?'),'token_address':base.get('address',''),'chain':row.get('chainId','?'),'dex':row.get('dexId','?'),'price':price,'tvl_usd':liquidity,'liquidity':liquidity,'volume_24h':float((row.get('volume') or {}).get('h24') or 0),'quote':quote.get('symbol','?'),'pair_address':row.get('pairAddress',''),'url':row.get('url','')})
            except (TypeError,ValueError): pass
        groups={}
        # Cross-chain mode compares the same base ticker across different networks.
        # The API search is token-centric but may include wrapped versions, so the UI
        # keeps the contract and chain visible for manual verification.
        for pool in pools:
            key=pool['token'].upper()
            groups.setdefault(key,[]).append(pool)
        opportunities=[]
        for _,items in groups.items():
            # Search results can contain scam/spoof pools sharing a ticker. Drop
            # extreme price outliers before comparing networks; contracts remain
            # visible in the response for manual verification.
            prices=[x['price'] for x in items if x['price']>0]
            if len(prices)>=3:
                median=statistics.median(prices)
                items=[x for x in items if median*0.5 <= x['price'] <= median*2]
            cross=[]
            for i,buy in enumerate(items):
                for sell in items[i+1:]:
                    if buy['chain'].lower()==sell['chain'].lower(): continue
                    low,high=(buy,sell) if buy['price']<=sell['price'] else (sell,buy); spread=(high['price']/low['price']-1)*100
                    cross.append((spread,low,high))
            for spread,low,high in sorted(cross,key=lambda x:x[0],reverse=True)[:10]:
                if spread < float(query.get('minSpread',['0.5'])[0]): continue
                opportunities.append({'token':low['token'].upper(),'spread_pct':spread,'buy':low,'sell':high,'volume_24h':low['volume_24h']+high['volume_24h'],'tvl_usd':min(low['tvl_usd'],high['tvl_usd']),'pools':items})
        opportunities.sort(key=lambda x:(x['spread_pct'],x['volume_24h']),reverse=True)
        self.send_json({'source':'dexscreener','query':term,'mode':'cross_chain','min_spread_pct':float(query.get('minSpread',['0.5'])[0]),'opportunities':opportunities[:50],'pools':pools[:100]})
    def autotrade_price(self,query):
        coin=(query.get('coin',[''])[0] or '').strip().upper()
        if not re.fullmatch(r'[A-Z0-9@_-]{1,24}',coin): raise ValueError('Укажите монету')
        broker=trading.build_broker()
        self.send_json({'venue':broker.name,'coin':coin,'price':broker.price(coin),'time':int(time.time()*1000)})
    def autotrade_book(self,query):
        coin=(query.get('coin',[''])[0] or '').strip().upper()
        if not re.fullmatch(r'[A-Z0-9@_-]{1,24}',coin): raise ValueError('Укажите монету')
        broker=trading.build_broker(); book=broker.book(coin)
        self.send_json({'venue':broker.name,'coin':coin,'bid':book['bid'],'ask':book['ask'],'mid':book['mid'],'spread_pct':(book['ask']-book['bid'])/book['mid']*100 if book['mid'] else None,'time':int(time.time()*1000)})
    def autotrade_post(self,path):
        try:
            length=int(self.headers.get('Content-Length',0) or 0); item=json.loads(self.rfile.read(length) or b'{}')
        except (TypeError,ValueError) as error:
            return self.send_json({'error':f'Некорректный JSON: {error}'},400)
        try:
            if path=='/api/autotrade/start': return self.send_json(autotrade.start(item.get('address') or None))
            if path=='/api/autotrade/stop': return self.send_json(autotrade.stop())
            if path=='/api/autotrade/settings': return self.send_json({'ok':True,'settings':trading.save_settings(item),'venue_status':trading.venue_status()})
            if path=='/api/autotrade/target':
                autotrade.set_target(item.get('address') or None); return self.send_json(autotrade.snapshot())
            if path=='/api/autotrade/close-all':
                return self.send_json({'ok':True,'closed':autotrade.close_all(item.get('address') or None,reason=item.get('reason') or 'ручное закрытие')})
            if path=='/api/autotrade/close':
                return self.send_json({'ok':True,'closed':autotrade.close_one(item.get('coin'),item.get('side'),item.get('address') or None)})
            if path=='/api/autotrade/buy':
                result=autotrade.manual_buy(item.get('address'),item.get('coin'),item.get('usd'),item.get('side','BUY'))
                return self.send_json({'ok':True,'order':{k:v for k,v in result.items() if k!='raw'}})
            return self.send_json({'error':'unknown endpoint'},404)
        except trading.TradingError as error:
            return self.send_json({'error':str(error)},400)
        except Exception as error:
            return self.send_json({'error':f'{type(error).__name__}: {error}'},500)
    def send_json(self,obj,status=200):
        b=json.dumps(obj).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Access-Control-Allow-Origin','*');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
    def send_bytes(self,b,content_type,name,download=False):
        self.send_response(200);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(b)))
        if download:self.send_header('Content-Disposition',f'attachment; filename="{name}"')
        self.end_headers();self.wfile.write(b)
    def log_message(self,*args):pass
def wire_autotrade():
    """Give the engine the same Hyperliquid pipe and radar the UI already uses.

    ``Handler.__new__`` builds an instance without running the request
    constructor: the helpers below only read module state, so they are safe to
    call outside a request, exactly like the radar worker already does."""
    helper=Handler.__new__(Handler)
    autotrade.configure(
        hl_request=helper.hyperliquid_request,
        normalize_fill=helper.normalize_fill,
        validate_address=helper.validate_address,
        radar_rows=radar_rows,
        radar_start=lambda item: radar_start_state(item,helper.hyperliquid_radar_worker),
        radar_stop=radar_stop_state,
    )
if __name__=='__main__':
    port=int(os.environ.get('PORT','4174'))
    public=BIND_HOST not in ('127.0.0.1','localhost','::1')
    if public and not AUTH_PASSWORD:
        raise SystemExit(
            f'Отказ в запуске: HOST={BIND_HOST} открывает интерфейс наружу, а RADAR_PASSWORD не задан.\n'
            'Любой, кто откроет адрес, сможет отправлять ордера. Задайте RADAR_PASSWORD в .env\n'
            'или оставьте HOST=127.0.0.1 и публикуйте приложение через reverse proxy.')
    os.makedirs(REPORT_DIR,exist_ok=True)
    wire_autotrade()
    trimmed=prune_events(force=True); autotrade.prune(force=True)
    if trimmed and any(trimmed.values()): print(f'Retention: удалено старых строк {trimmed}')
    settings=trading.load_settings()
    print(f'Liquidation Radar: http://{BIND_HOST}:{port}')
    print(f'Отчёты: {REPORT_DIR}')
    print(f'Доступ: {"Basic-аутентификация включена" if AUTH_PASSWORD else "без пароля (только loopback)"}')
    print(f'Auto-trade: venue={settings["venue"]} mode={settings["mode"]} leverage={settings["leverage"]}x order={settings["order_type"]}')
    if settings['mode']=='dry-run': print('Auto-trade: dry-run — ордера не отправляются, ключи не нужны')
    # A restart (deploy, crash, reboot) otherwise leaves the follower stopped
    # until somebody opens the UI.  Opt in explicitly, because it resumes
    # trading in whatever mode was configured.
    if os.environ.get('AUTOTRADE_AUTOSTART','').strip().lower() in ('1','true','yes','on'):
        target=os.environ.get('AUTOTRADE_TARGET','').strip() or None
        try:
            autotrade.start(target); print(f'Auto-trade: автозапуск выполнен (цель: {target or "выбирает радар"})')
        except Exception as error: print(f'Auto-trade: автозапуск не удался — {error}')
    ThreadingHTTPServer((BIND_HOST,port),Handler).serve_forever()

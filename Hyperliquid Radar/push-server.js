#!/usr/bin/env node
// Background listener: web push for watched addresses, and the feed that lets
// the server auto-trade with the browser closed.
//
// One Hyperliquid WebSocket carries userFills for
//   * the auto-trade leaders (asked from server.py every few seconds), and
//   * the watchlist the page syncs here (web push + Telegram).
// Every live fill is forwarded to server.py /internal/fills, which decides
// about Telegram and Bybit. Hyperliquid allows 10 distinct users per
// connection, so leaders are subscribed first and the rest of the watchlist
// fills the remaining slots.
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const webpush = require('web-push');

const ROOT = __dirname;
const DATA_DIR = process.env.RADAR_DATA_DIR || path.join(ROOT, 'push-data');
const PORT = Number(process.env.RADAR_PUSH_PORT || 8766);
const WEB_PORT = Number(process.env.RADAR_PORT || 8765);
const MAX_USERS = Number(process.env.HL_MAX_USERS || 10);
const TOKEN_FILE = process.env.RADAR_INTERNAL_TOKEN_FILE || path.join(ROOT, 'data', 'internal.token');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:radar@localhost';
const HL_WS_URL = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const PING_MS = Number(process.env.HL_PING_MS || 30000);
fs.mkdirSync(DATA_DIR, { recursive: true });
const keysFile = path.join(DATA_DIR, 'vapid.json');
const subsFile = path.join(DATA_DIR, 'subscriptions.json');
const watchFile = path.join(DATA_DIR, 'watchlist.json');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
let vapid = readJson(keysFile, null);
if (!vapid?.publicKey || !vapid?.privateKey) { vapid = webpush.generateVAPIDKeys(); writeJson(keysFile, vapid); }
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
let subscriptions = readJson(subsFile, []);
let watchlist = readJson(watchFile, []);
let leaders = [];
const seen = new Set();
const lastFillTime = new Map();   // user -> newest fill time seen on this process
let socket = null;
let reconnectTimer = null;
let heartbeat = null;
let lastMessageAt = 0;
let subscribed = new Set();
let dropped = [];

function validAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || '')); }
function addressesFrom(value) { return [...new Set((Array.isArray(value) ? value : []).map(x => String(x).toLowerCase()).filter(validAddress))].slice(0, 100); }
function json(res, status, body) { const data = Buffer.from(JSON.stringify(body)); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':data.length}); res.end(data); }
function body(req) { return new Promise((resolve, reject) => { let raw=''; req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); }); }

function token() { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } }
function internal(pathname, payload) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({ host:'127.0.0.1', port:WEB_PORT, path:pathname, method:'POST', timeout:10000,
      headers:{ 'Content-Type':'application/json', 'Content-Length':data.length, 'X-Radar-Internal':token() } }, res => {
      let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(raw) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => { console.error(`server.py ${pathname}:`, e.message); resolve(null); });
    req.end(data);
  });
}

function wanted() {
  const all = [...new Set([...leaders, ...watchlist])];
  dropped = all.slice(MAX_USERS);
  return all.slice(0, MAX_USERS);
}
function applySubscriptions() {
  const target = new Set(wanted());
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  for (const user of subscribed) if (!target.has(user)) socket.send(JSON.stringify({ method:'unsubscribe', subscription:{ type:'userFills', user, aggregateByTime:false } }));
  for (const user of target) if (!subscribed.has(user)) socket.send(JSON.stringify({ method:'subscribe', subscription:{ type:'userFills', user, aggregateByTime:false } }));
  subscribed = target;
  console.log(`Hyperliquid listener: ${subscribed.size} addresses (${leaders.length} auto-trade)` + (dropped.length ? `, ${dropped.length} over the limit of ${MAX_USERS}` : ''));
}

function sendPush(payload) {
  const data = JSON.stringify(payload);
  subscriptions = subscriptions.filter(item => item && item.subscription?.endpoint);
  if (!subscriptions.length) return;
  const jobs = subscriptions.map(async item => { try { await webpush.sendNotification(item.subscription, data); } catch (e) { if ([404, 410].includes(e.statusCode)) item.dead = true; else console.error('push:', e.message); } });
  Promise.all(jobs).then(() => { subscriptions = subscriptions.filter(item => !item.dead); writeJson(subsFile, subscriptions); });
}
function fillEvent(fill, address) {
  const dir = String(fill.dir || '');
  const action = /^Open\s/i.test(dir) ? 'ОТКРЫТИЕ' : /^Close\s/i.test(dir) ? 'ЗАКРЫТИЕ' : '';
  if (!action) return null;
  const position = /Long/i.test(dir) ? 'LONG' : /Short/i.test(dir) ? 'SHORT' : 'N/A';
  const px = Number(fill.px) || 0, sz = Number(fill.sz) || 0, usd = Math.abs(px * sz);
  return { address, coin: String(fill.coin || 'N/A'), px, sz, usd, side: String(fill.side || '').toLowerCase() === 'b' ? 'buy' : 'sell', position, action, time: Number(fill.time) || Date.now(), hash: fill.hash || fill.tid || `${address}:${fill.coin}:${fill.time}:${fill.oid}` };
}
function onFills(user, fills, isSnapshot) {
  // The first message after a subscribe replays recent history. On the first
  // connection it only sets the high-water mark; after a reconnect it
  // delivers what happened while the socket was down.
  const mark = lastFillTime.get(user);
  const fresh = [];
  for (const fill of fills) {
    const t = Number(fill.time) || 0;
    const id = `${user}:${fill.tid || fill.hash}:${t}:${fill.oid}`;
    if (seen.has(id)) continue;
    seen.add(id); if (seen.size > 20000) seen.clear();
    if (isSnapshot && (mark === undefined || t <= mark)) continue;
    fresh.push(fill);
  }
  const newest = Math.max(mark || 0, ...fills.map(f => Number(f.time) || 0));
  lastFillTime.set(user, newest);
  if (!fresh.length) return;
  const watched = watchlist.includes(user);
  internal('/internal/fills', { items: fresh.map(fill => ({ user, fill, watch: watched })) });
  if (!watched) return;
  for (const fill of fresh) {
    const event = fillEvent(fill, user);
    if (!event) continue;
    sendPush({ title: `${event.action} ${event.position} ${event.coin}`, body: `${user.slice(0, 6)}…${user.slice(-4)} · $${event.usd.toLocaleString('en-US', {maximumFractionDigits: 2})} · ${new Date(event.time).toLocaleString('ru-RU', { timeZone:'Europe/Moscow' })} MSK`, event });
  }
}
function connectHyperliquid() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  subscribed = new Set();
  socket = new WebSocket(HL_WS_URL);
  socket.on('open', () => {
    lastMessageAt = Date.now();
    applySubscriptions();
    // Hyperliquid drops a connection that is silent for a minute.
    heartbeat = setInterval(() => {
      if (Date.now() - lastMessageAt > 3 * PING_MS) { console.error('Hyperliquid WS: silent too long, reconnecting'); try { socket.terminate(); } catch {} return; }
      try { socket.send(JSON.stringify({ method:'ping' })); } catch {}
    }, PING_MS);
  });
  socket.on('message', raw => {
    lastMessageAt = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel === 'error') { console.error('Hyperliquid WS error:', JSON.stringify(msg.data).slice(0, 300)); return; }
      if (msg.channel !== 'userFills') return;
      const user = String(msg.data?.user || '').toLowerCase();
      if (!validAddress(user)) return;
      onFills(user, Array.isArray(msg.data?.fills) ? msg.data.fills : [], !!msg.data?.isSnapshot);
    } catch (e) { console.error('message:', e.message); }
  });
  socket.on('error', e => console.error('Hyperliquid WS:', e.message));
  socket.on('close', () => { clearInterval(heartbeat); subscribed = new Set(); reconnectTimer = setTimeout(connectHyperliquid, 3000); });
}
async function syncWithServer() {
  const reply = await internal('/internal/listener', { connected: socket?.readyState === WebSocket.OPEN, users: [...subscribed], dropped });
  if (!reply || !Array.isArray(reply.leaders)) return;
  const next = addressesFrom(reply.leaders);
  if (next.join(',') !== leaders.join(',')) { leaders = next; console.log(`Auto-trade leaders: ${leaders.length ? leaders.join(', ') : 'none'}`); applySubscriptions(); }
}
function setWatchlist(addresses) { watchlist = addressesFrom(addresses); writeJson(watchFile, watchlist); applySubscriptions(); }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/push/health') return json(res, 200, { ok:true, connected: socket?.readyState === WebSocket.OPEN, addresses:watchlist.length, leaders:leaders.length, listening:subscribed.size, overLimit:dropped.length, subscriptions:subscriptions.length });
    if (req.method === 'GET' && url.pathname === '/push/vapid-public-key') return json(res, 200, { publicKey:vapid.publicKey });
    if (req.method === 'POST' && url.pathname === '/push/subscribe') { const data = await body(req); if (!data.subscription?.endpoint) return json(res, 400, {ok:false,error:'subscription required'}); const index = subscriptions.findIndex(x => x.subscription.endpoint === data.subscription.endpoint); const item = { subscription:data.subscription, updatedAt:Date.now() }; if (index >= 0) subscriptions[index] = item; else subscriptions.push(item); if (Array.isArray(data.addresses)) setWatchlist(data.addresses); writeJson(subsFile, subscriptions); return json(res, 200, {ok:true, addresses:watchlist.length}); }
    if (req.method === 'POST' && url.pathname === '/push/watchlist') { const data = await body(req); setWatchlist(data.addresses); return json(res, 200, {ok:true, addresses:watchlist.length, listening:subscribed.size, overLimit:dropped.length}); }
    if (req.method === 'POST' && url.pathname === '/push/test') { sendPush({title:'Hyperliquid Radar', body:'Тестовое push-уведомление'}); return json(res, 200, {ok:true}); }
    return json(res, 404, {ok:false,error:'not found'});
  } catch (e) { return json(res, 400, {ok:false,error:e.message}); }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Push API listening on 127.0.0.1:${PORT}`);
  connectHyperliquid();
  syncWithServer();
  setInterval(syncWithServer, Number(process.env.RADAR_SYNC_MS || 5000));
});

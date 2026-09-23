#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const webpush = require('web-push');

const ROOT = __dirname;
const DATA_DIR = process.env.RADAR_DATA_DIR || path.join(ROOT, 'push-data');
const PORT = Number(process.env.RADAR_PUSH_PORT || 8766);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:radar@localhost';
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
const seen = new Set();
let socket = null;
let reconnectTimer = null;

function validAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || '')); }
function addressesFrom(value) { return [...new Set((Array.isArray(value) ? value : []).map(x => String(x).toLowerCase()).filter(validAddress))].slice(0, 100); }
function json(res, status, body) { const data = Buffer.from(JSON.stringify(body)); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':data.length}); res.end(data); }
function body(req) { return new Promise((resolve, reject) => { let raw=''; req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); }); }
function restartSocket() { if (socket) { try { socket.removeAllListeners('close'); socket.close(); } catch {} } connectHyperliquid(); }
function sendPush(payload) {
  const data = JSON.stringify(payload);
  subscriptions = subscriptions.filter(item => item && item.subscription?.endpoint);
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
function connectHyperliquid() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket('wss://api.hyperliquid.xyz/ws');
  socket.on('open', () => { for (const user of watchlist) socket.send(JSON.stringify({ method:'subscribe', subscription:{ type:'userFills', user, aggregateByTime:false } })); console.log(`Hyperliquid push listener: ${watchlist.length} addresses`); });
  socket.on('message', raw => { try { const msg = JSON.parse(raw.toString()); if (msg.channel !== 'userFills') return; const user = String(msg.data?.user || '').toLowerCase(); for (const fill of (msg.data?.fills || [])) { const event = fillEvent(fill, user); if (!event || seen.has(event.hash)) continue; seen.add(event.hash); if (seen.size > 10000) seen.clear(); sendPush({ title: `${event.action} ${event.position} ${event.coin}`, body: `${user.slice(0, 6)}…${user.slice(-4)} · $${event.usd.toLocaleString('en-US', {maximumFractionDigits: 2})} · ${new Date(event.time).toLocaleString('ru-RU', { timeZone:'Europe/Moscow' })} MSK`, event }); } } catch (e) { console.error('message:', e.message); } });
  socket.on('error', e => console.error('Hyperliquid WS:', e.message));
  socket.on('close', () => { reconnectTimer = setTimeout(connectHyperliquid, 3000); });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/push/health') return json(res, 200, { ok:true, addresses:watchlist.length, subscriptions:subscriptions.length });
    if (req.method === 'GET' && url.pathname === '/push/vapid-public-key') return json(res, 200, { publicKey:vapid.publicKey });
    if (req.method === 'POST' && url.pathname === '/push/subscribe') { const data = await body(req); if (!data.subscription?.endpoint) return json(res, 400, {ok:false,error:'subscription required'}); const index = subscriptions.findIndex(x => x.subscription.endpoint === data.subscription.endpoint); const item = { subscription:data.subscription, updatedAt:Date.now() }; if (index >= 0) subscriptions[index] = item; else subscriptions.push(item); if (Array.isArray(data.addresses)) { watchlist = addressesFrom(data.addresses); writeJson(watchFile, watchlist); restartSocket(); } writeJson(subsFile, subscriptions); return json(res, 200, {ok:true, addresses:watchlist.length}); }
    if (req.method === 'POST' && url.pathname === '/push/watchlist') { const data = await body(req); watchlist = addressesFrom(data.addresses); writeJson(watchFile, watchlist); restartSocket(); return json(res, 200, {ok:true, addresses:watchlist.length}); }
    if (req.method === 'POST' && url.pathname === '/push/test') { sendPush({title:'Hyperliquid Radar', body:'Тестовое push-уведомление'}); return json(res, 200, {ok:true}); }
    return json(res, 404, {ok:false,error:'not found'});
  } catch (e) { return json(res, 400, {ok:false,error:e.message}); }
});
server.listen(PORT, '127.0.0.1', () => { console.log(`Push API listening on 127.0.0.1:${PORT}`); connectHyperliquid(); });

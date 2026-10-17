'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 8080);
const SCAN_INTERVAL_MS = Math.max(60_000, Number(process.env.SCAN_INTERVAL_MS || 60_000));
const ALERT_UNIVERSE_LIMIT = Math.max(10, Math.min(100, Number(process.env.ALERT_UNIVERSE_LIMIT || 40)));
const INTERVAL_MS = { '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000 };
const MIN_QUOTE_VOLUME = Math.max(0, Number(process.env.MIN_QUOTE_VOLUME || 0));
const STABLE_BASES = new Set((process.env.EXCLUDED_STABLE_BASES || 'USDT,USDC,BUSD,FDUSD,TUSD,USDP,DAI,USDE,USDS,USD1,UST,USTC,FRAX,LUSD,USDD,EURC,AEUR,EURI').split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;
const INTERVALS = ['15m', '1h', '4h'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const INTERVAL_LABEL = { '15m': '15 分鐘', '1h': '1 小時', '4h': '4 小時', daily: '每日定投', weekly: '每週定投', monthly: '每月定投' };
const HISTORY_LIMIT = 500;
let state = { alerts: [], subscriptions: [], technicalState: {}, technicalCandidates: {}, lastTechnicalBucket: {}, lastScanAt: null, lastScanError: null };
let exchangeSymbolsCache = { at: 0, symbols: [] };
let scanning = false;

fs.mkdirSync(DATA_DIR, { recursive: true });
try { if (fs.existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { console.error('State load failed:', e.message); }
function saveState() { const tmp = `${STATE_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE_FILE); }
let vapidKeys;
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
try { vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch { vapidKeys = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2)); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('payload too large')); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid JSON')); } }); req.on('error', reject); }); }
function symbolLabel(symbol) { return symbol.replace(/USDT$/, ''); }
function excludedSymbol(symbol, baseAsset) { const base = String(baseAsset || symbol.replace(/USDT$/, '')).toUpperCase(); return STABLE_BASES.has(base) || LEVERAGED.test(symbol) || symbol.includes('_'); }
async function binance(url) { const res = await fetch(url, { headers: { 'User-Agent': 'CryptoPriceChecker/2.0' }, signal: AbortSignal.timeout(20_000) }); if (!res.ok) throw new Error(`Binance HTTP ${res.status}`); return res.json(); }
async function getSymbols() {
  if (Date.now() - exchangeSymbolsCache.at < 6 * 3600_000 && exchangeSymbolsCache.symbols.length) return exchangeSymbolsCache.symbols;
  const info = await binance('https://api.binance.com/api/v3/exchangeInfo');
  exchangeSymbolsCache = { at: Date.now(), symbols: (info.symbols || []).filter(x => x.status === 'TRADING' && x.quoteAsset === 'USDT' && x.isSpotTradingAllowed !== false && !excludedSymbol(x.symbol, x.baseAsset)).map(x => x.symbol) };
  return exchangeSymbolsCache.symbols;
}
function ema(values, period) { const a = 2 / (period + 1), out = []; for (let i = 0; i < values.length; i++) out.push(i ? values[i] * a + out[i - 1] * (1 - a) : values[i]); return out; }
function rsi(values, period = 14) { if (values.length <= period) return []; let g = 0, l = 0; for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; } let ag = g / period, al = l / period; const out = Array(period).fill(null); out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; ag = (ag * (period - 1) + Math.max(d, 0)) / period; al = (al * (period - 1) + Math.max(-d, 0)) / period; out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); } return out; }
function macdHist(values) { const e12 = ema(values, 12), e26 = ema(values, 26), line = e12.map((v, i) => v - e26[i]), sig = ema(line, 9); return line.map((v, i) => v - sig[i]); }
function avgDca(candles, frequency) { const samples = []; let next = Number(candles[0]?.[0] || 0); for (const c of candles) { const ts = Number(c[0]); if (ts + 12 * 3600_000 < next) continue; const p = Number(c[4]); if (p > 0) samples.push(p); if (frequency === 'daily') next = ts + 86400_000; else if (frequency === 'weekly') next = ts + 7 * 86400_000; else { const d = new Date(ts); d.setUTCMonth(d.getUTCMonth() + 1); next = d.getTime(); } } const inv = samples.reduce((s, p) => s + 1 / p, 0); return inv ? samples.length / inv : null; }
function technicalSignal(symbol, ticker, candles, interval) {
  if (!Array.isArray(candles) || candles.length < 65) return null;
  const closed = candles.slice(0, -1), closes = closed.map(c => Number(c[4])), volumes = closed.map(c => Number(c[7]));
  if (closes.length < 55) return null;
  const e9 = ema(closes, 9), e21 = ema(closes, 21), hist = macdHist(closes), rs = rsi(closes, 14);
  const i = closes.length - 1, h = hist[i], hp = hist[i - 1], hpp = hist[i - 2], rvBase = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-21, -1).length);
  const current = closed[closed.length - 1], currentVol = Number(current[7]), relativeVolume = rvBase > 0 ? currentVol / rvBase : 0;
  const price = Number(ticker.lastPrice), r = Number(rs.at(-1)), rp = Number(rs.at(-2));
  const tr = closed.slice(-14).map((c, j, arr) => { const high = Number(c[2]), low = Number(c[3]), prev = j ? Number(arr[j - 1][4]) : Number(closed[Math.max(0, closed.length - 15)][4]); return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)); });
  const atr = tr.reduce((a, b) => a + b, 0) / tr.length;
  const move = (Number(current[4]) - Number(current[1])) / Number(current[1]) * 100;
  const volumeBoost = relativeVolume >= 1.5;
  const longEma = e9[i] > e21[i], shortEma = e9[i] < e21[i], aboveEma = price > e21[i], belowEma = price < e21[i];
  const macdLongStrong = h > 0 && h > hp && hp >= hpp, macdLongEarly = h < 0 && h > hp && hp > hpp;
  const macdShortStrong = h < 0 && h < hp && hp <= hpp, macdShortEarly = h > 0 && h < hp && hp < hpp;
  const rsiLong = (r >= 45 && r <= 68 && r >= rp) || (r < 35 && r > rp + 1.5);
  const rsiShort = (r >= 32 && r <= 55 && r <= rp) || (r > 70 && r < rp - 1.5);
  const green = Number(current[4]) > Number(current[1]), red = Number(current[4]) < Number(current[1]);
  const longScore = (longEma ? 1 : 0) + (aboveEma ? 1 : 0) + (macdLongStrong ? 2 : macdLongEarly ? 1 : 0) + (rsiLong ? 1 : 0) + (volumeBoost && green ? 1 : 0);
  const shortScore = (shortEma ? 1 : 0) + (belowEma ? 1 : 0) + (macdShortStrong ? 2 : macdShortEarly ? 1 : 0) + (rsiShort ? 1 : 0) + (volumeBoost && red ? 1 : 0);
  let direction = null, score = 0;
  // Strict mode: every major component must agree; early/crossing MACD signals alone are not enough.
  // Reject unusually large signal candles to avoid chasing a move after it has already extended.
  if (longScore === 6 && longScore >= shortScore + 3 && relativeVolume >= 1.8 && r >= 48 && r <= 64 && r >= rp && longEma && aboveEma && macdLongStrong && move >= 0 && move <= 2.5) { direction = 'LONG'; score = longScore; }
  else if (shortScore === 6 && shortScore >= longScore + 3 && relativeVolume >= 1.8 && r >= 36 && r <= 52 && r <= rp && shortEma && belowEma && macdShortStrong && move <= 0 && move >= -2.5) { direction = 'SHORT'; score = shortScore; }
  if (!direction) return null;
  const candleCloseTime = Number(current[6]);
  const key = `TECH:${symbol}:${interval}:${direction}:${candleCloseTime}`;
  const reasons = [
    `EMA9/21：${longEma ? '快線在上，趨勢偏多' : shortEma ? '快線在下，趨勢偏空' : '均線糾結'}`,
    `MACD 柱體 ${h >= 0 ? '正值' : '負值'}；${macdLongStrong || macdShortStrong ? '連續擴大，動能延續' : macdLongEarly || macdShortEarly ? '柱體收斂，反向動能增強' : '動能未確認'}`,
    `RSI(14) ${r.toFixed(1)}：${r < 30 ? '超賣，避免盲目追空' : r > 70 ? '超買，避免盲目追多' : rsiLong ? '偏多區間/回升' : rsiShort ? '偏空區間/回落' : '中性'}`,
    `相對成交量 ${relativeVolume.toFixed(2)}×（相對前 20 根已收盤 K 線平均）`,
    `ATR(14) 約 ${atr.toPrecision(6)} USDT（最近 14 根已收盤 K 線平均真實波動）`,
    `當根 K 線變化 ${move >= 0 ? '+' : ''}${move.toFixed(2)}%`,
    `綜合判斷：趨勢、MACD、RSI、量能與 K 線方向全部一致（${score}/6）；已排除早期交叉訊號與單根過度延伸行情` 
  ];
  return { id: key, key, symbol, price, change: Number(ticker.priceChangePercent), interval: INTERVAL_LABEL[interval], intervalCode: interval, direction, score, relativeVolume, rsi: r, atr, kind: `多空共振（${score}/6）`, reasons, timestamp: Date.now(), candleCloseTime };
}
async function getKlines(symbol, interval, limit) { const u = new URL('https://api.binance.com/api/v3/klines'); u.searchParams.set('symbol', symbol); u.searchParams.set('interval', interval); u.searchParams.set('limit', String(limit)); return binance(u.toString()); }
async function mapLimit(items, limit, fn) { let next = 0; const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; try { await fn(items[i], i); } catch (e) { /* per-item errors are counted by caller */ } } }); await Promise.all(workers); }
async function pushToSubscribers(alert) {
  const payload = JSON.stringify({ title: `${alert.direction === 'LONG' ? '🟢 做多' : '🔴 做空'}｜${symbolLabel(alert.symbol)} ${alert.interval}`, body: `${alert.kind} · 現價 ${alert.price}\n${(alert.reasons || []).slice(0, 3).join('；')}`, tag: alert.id, url: '/' });
  const expired = new Set();
  await Promise.all((state.subscriptions || []).map(async sub => { try { await webpush.sendNotification(sub, payload, { TTL: 3600 }); } catch (e) { if (e.statusCode === 404 || e.statusCode === 410) expired.add(sub.endpoint); else console.warn('Push failed:', e.statusCode || e.message); } }));
  if (expired.size) { state.subscriptions = state.subscriptions.filter(s => !expired.has(s.endpoint)); saveState(); }
}
function addAlert(alert, newAlerts) { if (state.alerts.some(a => a.id === alert.id)) return; state.alerts.unshift(alert); state.alerts = state.alerts.slice(0, HISTORY_LIMIT); newAlerts.push(alert); }
async function scanMarket() {
  if (scanning) return; scanning = true; const started = Date.now(); let checked = 0, errors = 0;
  try {
    const [symbols, tickerRows] = await Promise.all([getSymbols(), binance('https://api.binance.com/api/v3/ticker/24hr')]);
    const tickerMap = new Map(tickerRows.filter(t => Number(t.lastPrice) > 0 && Number(t.quoteVolume) >= MIN_QUOTE_VOLUME).map(t => [t.symbol, t]));
    const universe = symbols.filter(s => tickerMap.has(s)).sort((a, b) => Number(tickerMap.get(b).quoteVolume) - Number(tickerMap.get(a).quoteVolume)).slice(0, ALERT_UNIVERSE_LIMIT); const newAlerts = [];
    const now = Date.now();
    await mapLimit(universe, Number(process.env.SCAN_CONCURRENCY || 8), async symbol => {
      const ticker = tickerMap.get(symbol); if (!ticker) return;
      const found = [];
      for (const interval of INTERVALS) {
        const stateKey = `${symbol}:${interval}`;
        const bucket = Math.floor(now / INTERVAL_MS[interval]);
        if (Number(state.lastTechnicalBucket[stateKey]) === bucket) continue;
        try {
          const candles = await getKlines(symbol, interval, 100);
          const signal = technicalSignal(symbol, ticker, candles, interval);
          const candidate = state.technicalCandidates[stateKey];
          if (signal) {
            const duration = INTERVAL_MS[interval];
            const consecutive = candidate && candidate.direction === signal.direction && Number(signal.candleCloseTime) > Number(candidate.candleCloseTime) && Number(signal.candleCloseTime) - Number(candidate.candleCloseTime) <= duration * 1.5;
            if (consecutive && state.technicalState[stateKey] !== signal.direction) {
              signal.reasons = [...signal.reasons, `確認機制：連續兩根已收盤 ${INTERVAL_LABEL[interval]} K 線全部嚴格條件同向成立`];
              addAlert(signal, newAlerts);
              state.technicalState[stateKey] = signal.direction;
            }
            state.technicalCandidates[stateKey] = { direction: signal.direction, candleCloseTime: signal.candleCloseTime };
          } else {
            state.technicalCandidates[stateKey] = null;
            state.technicalState[stateKey] = 'NONE';
          }
          state.lastTechnicalBucket[stateKey] = bucket;
        } catch (e) { errors++; }
      }
      checked++;
    });
    state.lastScanAt = new Date().toISOString(); state.lastScanError = null; state.lastScanCount = checked; state.lastScanErrors = errors; saveState();
    for (const alert of newAlerts) await pushToSubscribers(alert);
    console.log(`[scan] ${checked}/${universe.length} high-volume pairs; ${newAlerts.length} new alerts; ${errors} errors; ${Math.round((Date.now()-started)/1000)}s`);
  } catch (e) { state.lastScanError = e.message; saveState(); console.error('[scan] failed:', e.message); }
  finally { scanning = false; }
}
function serveStatic(req, res) {
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { pathname = '/'; }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep) || file === STATE_FILE || file.startsWith(DATA_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ['.html','.js','.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600' }); res.end(data);
  });
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, scanning, lastScanAt: state.lastScanAt, lastScanError: state.lastScanError, lastScanCount: state.lastScanCount || 0, lastScanErrors: state.lastScanErrors || 0, subscriptionCount: state.subscriptions.length, monitoredPairs: ALERT_UNIVERSE_LIMIT, scanIntervalMs: SCAN_INTERVAL_MS });
    if (url.pathname === '/api/alerts' && req.method === 'GET') return json(res, 200, { alerts: state.alerts, lastScanAt: state.lastScanAt, lastScanError: state.lastScanError, lastScanCount: state.lastScanCount || 0, lastScanErrors: state.lastScanErrors || 0, scanning, monitoredPairs: ALERT_UNIVERSE_LIMIT, scanIntervalMs: SCAN_INTERVAL_MS });
    if (url.pathname === '/api/push/public-key' && req.method === 'GET') return json(res, 200, { publicKey: vapidKeys.publicKey });
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') { const sub = await readBody(req); if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json(res, 400, { error: 'Invalid subscription' }); state.subscriptions = state.subscriptions.filter(s => s.endpoint !== sub.endpoint); state.subscriptions.push(sub); saveState(); return json(res, 201, { ok: true, subscriptionCount: state.subscriptions.length }); }
    if (url.pathname === '/api/push/subscribe' && req.method === 'DELETE') { const body = await readBody(req); state.subscriptions = state.subscriptions.filter(s => s.endpoint !== body.endpoint); saveState(); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/scan' && req.method === 'POST') { if (scanning) return json(res, 202, { ok: true, scanning: true }); scanMarket(); return json(res, 202, { ok: true, scanning: true }); }
    return serveStatic(req, res);
  } catch (e) { return json(res, 400, { error: e.message || 'Request failed' }); }
});
server.listen(PORT, () => { console.log(`Crypto Price Checker listening on ${PORT}`); scanMarket(); setInterval(scanMarket, SCAN_INTERVAL_MS); });

// Test-only mock of the KanAIRy API so the UI can be exercised without network. NOT part of the app.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../static'); const PORT = +process.env.PORT || 8765;
const TF = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN: 2592000 };
function rnd(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function candles(sym, tf, n, before) {
  const step = TF[tf] || 3600, end = Math.floor((before || Date.now() / 1000) / step) * step, r = rnd(sym.length * 97 + step), out = []; let p = sym.startsWith('XAU') ? 2650 : 1.085;
  for (let i = n; i > 0; i--) { const o = p, c = o + (r() - 0.5) * o * 0.004, hi = Math.max(o, c) + r() * o * 0.0015, lo = Math.min(o, c) - r() * o * 0.0015; out.push({ t: end - i * step, o, h: hi, l: lo, c, v: Math.floor(r() * 900 + 50) }); p = c; }
  return out;
}
const syms = [['EURUSD', 'Euro vs US Dollar', 'Forex', 5], ['GBPUSD', 'Pound vs Dollar', 'Forex', 5], ['USDJPY', 'Dollar vs Yen', 'Forex', 3], ['XAUUSD', 'Gold', 'Metals', 2], ['US500', 'S&P 500', 'Indices', 1], ['BTCUSD', 'Bitcoin', 'Crypto', 2]];
const px = { EURUSD: 1.0852, GBPUSD: 1.2931, USDJPY: 149.82, XAUUSD: 2651.4, US500: 5801.2, BTCUSD: 67210 };
const quote = s => { const m = px[s] * (1 + (Math.random() - .5) * 0.0002), d = 10 ** -(syms.find(x => x[0] === s)?.[3] ?? 5) * 8; return { symbol: s, bid: m, ask: m + d, time: Date.now() / 1000 }; };
const pos = [{ id: '1001', symbol: 'EURUSD', side: 'buy', volume: 0.1, openPrice: 1.0801, currentPrice: 1.0852, stopLoss: 1.07, takeProfit: 1.1, profit: 51, swap: -0.2, commission: -0.7, openTime: Date.now() / 1000 - 7200 }];
const account = { name: 'Test User', login: '123456', server: 'Mock-MT5', platform: 'mt5', currency: 'USD', balance: 10000, equity: 10051, margin: 108, freeMargin: 9943, marginLevel: 9306, leverage: 500, broker: 'Mock' };
const json = (res, o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  if (p === '/api/health') return json(res, { ok: true });
  if (p === '/api/public/instruments') return json(res, { instruments: syms.map(([symbol, name, cat, digits]) => ({ symbol, name, cat, digits })) });
  if (p === '/api/public/quotes' || p === '/api/market/quotes') return json(res, { quotes: Object.fromEntries((q.get('symbols') || '').split(',').filter(s => px[s]).map(s => [s, quote(s)])) });
  if (p === '/api/public/candles' || p === '/api/market/candles') return json(res, { candles: candles(q.get('symbol'), q.get('timeframe'), +q.get('limit') || 300, +q.get('before') || 0) });
  if (p === '/api/market/symbols') return json(res, { symbols: syms.map(([symbol, description, category, digits]) => ({ symbol, description, category, digits, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, contractSize: 100000 })) });
  if (p === '/api/brokers/popular') return json(res, { brokers: { Exness: ['Exness-MT5Real8', 'Exness-MT5Trial9'], 'IC Markets': ['ICMarketsSC-Demo'] } });
  if (p === '/api/brokers/search') return json(res, { brokers: { Exness: ['Exness-MT5Real8'] } });
  if (p === '/api/auth/connect' && req.method === 'POST') return json(res, { job: 'j1' }, 202);
  if (p === '/api/auth/connect/j1') return json(res, { state: 'ready', token: 'tok', account });
  if (p === '/api/trading/snapshot') return json(res, { account, positions: pos, orders: [] });
  if (p === '/api/trading/history') return json(res, { deals: [{ kind: 'deal', entry: 'out', time: Date.now() / 1000 - 86400, profit: 42, symbol: 'EURUSD', side: 'buy', volume: .1, price: 1.08 }] });
  if (p === '/api/news') return json(res, { sources: { cnbc: 'CNBC Markets' }, articles: [{ title: 'Markets rally', summary: 'Stocks rose.', url: 'https://example.com', source: 'CNBC Markets', time: Date.now() / 1000 - 600 }] });
  if (p === '/api/calendar') return json(res, { events: [{ title: 'CPI', country: 'USD', impact: 'high', time: Date.now() / 1000 + 3600, forecast: '3.1%', previous: '3.0%' }] });
  let f = p === '/' ? '/index.html' : p.replace(/^\/static/, ''); if (p === '/sw.js') f = '/sw.js'; if (p === '/manifest.json') f = '/manifest.json';
  const fp = path.join(root, f); if (!fp.startsWith(root) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': mime[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log('mock on', PORT));

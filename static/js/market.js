// Market data layer: one interface over broker (MetaApi) and public feeds.
import { api } from './api.js';
import { S, active, isBroker, favorites, emit, inst } from './state.js';

let quoteTimer = null, snapTimer = null, quoteCtl = null;
const dayRefAt = {};

export async function loadInstruments() {
  if (isBroker()) {
    const { symbols } = await api.symbols();
    S.instruments = symbols.map(s => ({ symbol: s.symbol, name: s.description || s.symbol, cat: s.category || 'Other', digits: s.digits ?? 5,
      minVolume: s.minVolume, maxVolume: s.maxVolume, volumeStep: s.volumeStep, contractSize: s.contractSize, tickSize: s.tickSize, path: s.path }));
  } else {
    const { instruments } = await api.pubInstruments();
    S.instruments = instruments;
  }
  emit('instruments');
}

export async function candles(symbol, tf, limit = 500, before = null, signal) {
  if (isBroker()) return (await api.candles(symbol, tf, Math.min(limit, 1000), before, signal)).candles;
  return (await api.pubCandles(symbol, tf, limit, signal)).candles;
}

// symbols we need prices for right now
function watched() {
  const set = new Set(favorites());
  set.add(S.symbol);
  S.positions.forEach(p => set.add(p.symbol)); S.orders.forEach(o => set.add(o.symbol));
  S.alerts.filter(a => !a.fired).forEach(a => set.add(a.symbol));
  if (S.catFilter && S.catFilter !== 'Favorites') S.instruments.filter(i => i.cat === S.catFilter).slice(0, 30).forEach(i => set.add(i.symbol));
  if (S.query) S.instruments.filter(i => (i.symbol + i.name).toLowerCase().includes(S.query.toLowerCase())).slice(0, 20).forEach(i => set.add(i.symbol));
  return [...set].filter(s => !S.instruments.length || inst(s));
}

async function pollQuotes() {
  if (document.hidden) return;
  const syms = watched(); if (!syms.length) return;
  quoteCtl?.abort(); quoteCtl = new AbortController();
  try {
    const res = isBroker() ? (await api.quotes(syms.slice(0, 60), quoteCtl.signal)).quotes : (await api.pubQuotes(syms.slice(0, 40), quoteCtl.signal)).quotes;
    for (const [s, q] of Object.entries(res)) {
      const prev = S.quotes[s];
      S.quotes[s] = { ...prev, ...q, dir: prev ? Math.sign(q.bid - prev.bid) || prev.dir : 0 };
    }
    S.online = true; emit('quotes');
    if (isBroker()) refreshDayRefs(syms);
  } catch (e) { if (e.name !== 'AbortError') { S.online = false; emit('online'); } }
}

// broker quotes carry no previous close; derive it from the last two daily candles
async function refreshDayRefs(syms) {
  const now = Date.now();
  for (const s of syms.slice(0, 12)) {
    if (dayRefAt[s] && now - dayRefAt[s] < 600000) continue;
    dayRefAt[s] = now;
    try {
      const c = await candles(s, 'D1', 2);
      if (c.length >= 2 && S.quotes[s]) S.quotes[s].prevClose = c[c.length - 2].c;
      else if (c.length === 1 && S.quotes[s]) S.quotes[s].prevClose = c[0].o;
      emit('quotes');
    } catch { dayRefAt[s] = 0; }
  }
}

async function pollSnapshot() {
  if (document.hidden || !isBroker()) return;
  try {
    const snap = await api.snapshot();
    S.account = snap.account; S.positions = snap.positions; S.orders = snap.orders; S.lastSnapshot = Date.now();
    S.online = true; emit('snapshot');
  } catch (e) { if (e.status !== 401) { S.online = false; emit('online'); } }
}

export function startPolling() {
  stopPolling();
  const qMs = isBroker() ? 1500 : 5000;
  pollQuotes(); pollSnapshot();
  quoteTimer = setInterval(pollQuotes, qMs);
  snapTimer = setInterval(pollSnapshot, 2000);
}
export function stopPolling() { clearInterval(quoteTimer); clearInterval(snapTimer); quoteCtl?.abort(); }
export const refreshNow = () => { pollQuotes(); pollSnapshot(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });

export const mid = s => { const q = S.quotes[s]; return q ? (q.bid + (q.ask || q.bid)) / 2 : null; };
export function dayChange(s) {
  const q = S.quotes[s]; if (!q || !q.prevClose) return null;
  const d = q.bid - q.prevClose; return { abs: d, pct: d / q.prevClose * 100 };
}
export const accountLabel = () => active()?.label || 'Public prices';

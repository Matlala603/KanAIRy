// API client. Adds the session token, normalises errors, and exposes typed calls.
import { store } from './util.js';

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

let token = null;
let onUnauth = () => {};
export const setToken = t => { token = t; };
export const onUnauthenticated = fn => { onUnauth = fn; };

async function call(method, path, { body, query, signal, auth = true, timeout = 25000, headers } = {}) {
  const url = new URL(path, location.origin);
  if (query) Object.entries(query).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  signal?.addEventListener('abort', () => ctl.abort());
  let res;
  try {
    res = await fetch(url, {
      method, signal: ctl.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, e.name === 'AbortError' ? 'The server took too long to answer.' : 'Cannot reach the server. Check your connection.', 'network');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error || data?.detail?.[0]?.msg || `Request failed (${res.status})`, data?.code);
    if (res.status === 401 && auth && token && ['unauthenticated', 'relink'].includes(err.code)) onUnauth(err);
    throw err;
  }
  return data;
}

const get = (p, o) => call('GET', p, o);
export const api = {
  health: () => get('/api/health', { auth: false }),
  brokersPopular: platform => get('/api/brokers/popular', { query: { platform }, auth: false, timeout: 60000 }),
  brokersSearch: (q, platform, signal) => get('/api/brokers/search', { query: { q, platform }, auth: false, signal }),
  connect: body => call('POST', '/api/auth/connect', { body, auth: false }),
  connectStatus: (job, poll) => get('/api/auth/connect/' + job, { auth: false, headers: { 'X-Poll-Key': poll || '' } }),
  me: () => get('/api/auth/me'),
  logout: () => call('POST', '/api/auth/logout'),
  symbols: () => get('/api/market/symbols', { timeout: 60000 }),
  quotes: (symbols, signal) => get('/api/market/quotes', { query: { symbols: symbols.join(',') }, signal }),
  candles: (symbol, timeframe, limit, before, signal) => get('/api/market/candles', { query: { symbol, timeframe, limit, before }, signal, timeout: 40000 }),
  snapshot: signal => get('/api/trading/snapshot', { signal }),
  history: days => get('/api/trading/history', { query: { days }, timeout: 40000 }),
  order: body => call('POST', '/api/trading/order', { body, timeout: 40000 }),
  orderStatus: id => get('/api/trading/order-status/' + encodeURIComponent(id), { timeout: 15000 }),
  closePosition: (id, volume) => call('POST', `/api/trading/positions/${encodeURIComponent(id)}/close`, { body: volume ? { volume } : {}, timeout: 40000 }),
  modifyPosition: (id, body) => call('PATCH', `/api/trading/positions/${encodeURIComponent(id)}`, { body, timeout: 40000 }),
  modifyOrder: (id, body) => call('PATCH', `/api/trading/orders/${encodeURIComponent(id)}`, { body, timeout: 40000 }),
  cancelOrder: id => call('DELETE', `/api/trading/orders/${encodeURIComponent(id)}`, { timeout: 40000 }),
  pubInstruments: () => get('/api/public/instruments', { auth: false }),
  pubQuotes: (symbols, signal) => get('/api/public/quotes', { query: { symbols: symbols.join(',') }, auth: false, signal }),
  pubCandles: (symbol, timeframe, limit, signal) => get('/api/public/candles', { query: { symbol, timeframe, limit }, auth: false, signal, timeout: 40000 }),
  news: source => get('/api/news', { query: { source }, auth: false }),
  calendar: week => get('/api/calendar', { query: { week }, auth: false }),
};
void store;

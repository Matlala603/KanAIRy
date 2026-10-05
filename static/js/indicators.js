// Technical indicators computed from real candles. Pure functions, no DOM.
// Candle: {t,o,h,l,c,v}. Every series is an array aligned to the candles with
// NaN where the indicator is not yet defined.

const NaNs = n => new Array(n).fill(NaN);

export function sma(src, p) {
  const out = NaNs(src.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!Number.isNaN(v)) { sum += v; cnt++; }
    if (i >= p && !Number.isNaN(src[i - p])) { sum -= src[i - p]; cnt--; }
    if (cnt === p && i >= p - 1) out[i] = sum / p;
  }
  return out;
}

export function ema(src, p) {
  const out = NaNs(src.length), k = 2 / (p + 1);
  let prev = NaN, seed = 0, n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v; n++;
      if (n === p) { prev = seed / p; out[i] = prev; }
    } else { prev = v * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

// Wilder's smoothing (RMA)
export function rma(src, p) {
  const out = NaNs(src.length);
  let prev = NaN, seed = 0, n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v; n++;
      if (n === p) { prev = seed / p; out[i] = prev; }
    } else { prev = (prev * (p - 1) + v) / p; out[i] = prev; }
  }
  return out;
}

export function wma(src, p) {
  const out = NaNs(src.length), den = p * (p + 1) / 2;
  for (let i = p - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < p; j++) { const v = src[i - j]; if (Number.isNaN(v)) { ok = false; break; } s += v * (p - j); }
    if (ok) out[i] = s / den;
  }
  return out;
}

export function stdev(src, p) {
  const out = NaNs(src.length);
  for (let i = p - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < p; j++) { const v = src[i - j]; if (Number.isNaN(v)) { ok = false; break; } s += v; }
    if (!ok) continue;
    const m = s / p; let q = 0;
    for (let j = 0; j < p; j++) q += (src[i - j] - m) ** 2;
    out[i] = Math.sqrt(q / p);
  }
  return out;
}

const highest = (src, p, i) => { let m = -Infinity; for (let j = 0; j < p; j++) m = Math.max(m, src[i - j]); return m; };
const lowest = (src, p, i) => { let m = Infinity; for (let j = 0; j < p; j++) m = Math.min(m, src[i - j]); return m; };

export const col = (cs, k) => cs.map(c => c[k]);
export function source(cs, name = 'c') {
  if (name === 'hl2') return cs.map(c => (c.h + c.l) / 2);
  if (name === 'hlc3') return cs.map(c => (c.h + c.l + c.c) / 3);
  if (name === 'ohlc4') return cs.map(c => (c.o + c.h + c.l + c.c) / 4);
  return col(cs, name);
}

export function trueRange(cs) {
  return cs.map((c, i) => i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c)));
}
export const atr = (cs, p = 14) => rma(trueRange(cs), p);

export function rsi(src, p = 14) {
  const gain = NaNs(src.length), loss = NaNs(src.length);
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    gain[i] = Math.max(d, 0); loss[i] = Math.max(-d, 0);
  }
  const ag = rma(gain, p), al = rma(loss, p);
  return ag.map((g, i) => Number.isNaN(g) ? NaN : (al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
}

export function macd(src, fast = 12, slow = 26, sig = 9) {
  const ef = ema(src, fast), es = ema(src, slow);
  const line = ef.map((v, i) => v - es[i]);
  // signal EMA seeded on first defined MACD value
  const first = line.findIndex(v => !Number.isNaN(v));
  const signal = NaNs(src.length);
  if (first >= 0) {
    const part = ema(line.slice(first), sig);
    part.forEach((v, i) => signal[first + i] = v);
  }
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

export function bollinger(src, p = 20, mult = 2) {
  const mid = sma(src, p), sd = stdev(src, p);
  return { mid, upper: mid.map((m, i) => m + mult * sd[i]), lower: mid.map((m, i) => m - mult * sd[i]) };
}

export function stochastic(cs, kp = 14, smoothK = 3, dp = 3) {
  const h = col(cs, 'h'), l = col(cs, 'l'), c = col(cs, 'c');
  const raw = NaNs(cs.length);
  for (let i = kp - 1; i < cs.length; i++) {
    const hh = highest(h, kp, i), ll = lowest(l, kp, i);
    raw[i] = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
  }
  const k = sma(raw, smoothK);
  return { k, d: sma(k, dp) };
}

export function williamsR(cs, p = 14) {
  const h = col(cs, 'h'), l = col(cs, 'l'), c = col(cs, 'c'), out = NaNs(cs.length);
  for (let i = p - 1; i < cs.length; i++) {
    const hh = highest(h, p, i), ll = lowest(l, p, i);
    out[i] = hh === ll ? -50 : (hh - c[i]) / (hh - ll) * -100;
  }
  return out;
}

export function cci(cs, p = 20) {
  const tp = source(cs, 'hlc3'), m = sma(tp, p), out = NaNs(cs.length);
  for (let i = p - 1; i < cs.length; i++) {
    let dev = 0;
    for (let j = 0; j < p; j++) dev += Math.abs(tp[i - j] - m[i]);
    dev /= p;
    out[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
  }
  return out;
}

export function adx(cs, p = 14) {
  const n = cs.length, pdm = NaNs(n), mdm = NaNs(n);
  for (let i = 1; i < n; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = trueRange(cs); tr[0] = NaN;
  const atrv = rma(tr, p), sp = rma(pdm, p), sm = rma(mdm, p);
  const pdi = sp.map((v, i) => 100 * v / atrv[i]), mdi = sm.map((v, i) => 100 * v / atrv[i]);
  const dx = pdi.map((v, i) => { const s = v + mdi[i]; return s === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / s; });
  return { adx: rma(dx, p), pdi, mdi };
}

export function momentum(src, p = 10) { return src.map((v, i) => i >= p ? v - src[i - p] : NaN); }
export function roc(src, p = 12) { return src.map((v, i) => i >= p ? (v / src[i - p] - 1) * 100 : NaN); }

export function obv(cs) {
  const out = NaNs(cs.length); let acc = 0; out[0] = 0;
  for (let i = 1; i < cs.length; i++) {
    acc += cs[i].c > cs[i - 1].c ? cs[i].v : cs[i].c < cs[i - 1].c ? -cs[i].v : 0;
    out[i] = acc;
  }
  return out;
}

export function mfi(cs, p = 14) {
  const tp = source(cs, 'hlc3'), out = NaNs(cs.length);
  for (let i = p; i < cs.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const flow = tp[j] * cs[j].v;
      if (tp[j] > tp[j - 1]) pos += flow; else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

export function vwap(cs) {
  const out = NaNs(cs.length); let day = -1, pv = 0, vv = 0;
  cs.forEach((c, i) => {
    const d = Math.floor(c.t / 86400);
    if (d !== day) { day = d; pv = 0; vv = 0; }
    const tp = (c.h + c.l + c.c) / 3, vol = c.v || 1;
    pv += tp * vol; vv += vol; out[i] = pv / vv;
  });
  return out;
}

export function donchian(cs, p = 20) {
  const h = col(cs, 'h'), l = col(cs, 'l'), up = NaNs(cs.length), lo = NaNs(cs.length);
  for (let i = p - 1; i < cs.length; i++) { up[i] = highest(h, p, i); lo[i] = lowest(l, p, i); }
  return { upper: up, lower: lo, mid: up.map((v, i) => (v + lo[i]) / 2) };
}

export function keltner(cs, p = 20, mult = 2) {
  const mid = ema(col(cs, 'c'), p), a = atr(cs, p);
  return { mid, upper: mid.map((m, i) => m + mult * a[i]), lower: mid.map((m, i) => m - mult * a[i]) };
}

export function ichimoku(cs, conv = 9, base = 26, spanB = 52, shift = 26) {
  const h = col(cs, 'h'), l = col(cs, 'l'), n = cs.length;
  const mid = p => { const o = NaNs(n); for (let i = p - 1; i < n; i++) o[i] = (highest(h, p, i) + lowest(l, p, i)) / 2; return o; };
  const tenkan = mid(conv), kijun = mid(base), sb = mid(spanB);
  const sa = tenkan.map((v, i) => (v + kijun[i]) / 2);
  const shiftFwd = arr => { const o = NaNs(n); for (let i = 0; i < n; i++) if (i + shift < n) o[i + shift] = arr[i]; return o; };
  const chikou = NaNs(n); for (let i = shift; i < n; i++) chikou[i - shift] = cs[i].c;
  return { tenkan, kijun, spanA: shiftFwd(sa), spanB: shiftFwd(sb), chikou };
}

export function psar(cs, step = 0.02, max = 0.2) {
  const n = cs.length, out = NaNs(n);
  if (n < 2) return out;
  let long = cs[1].c >= cs[0].c, af = step, ep = long ? cs[0].h : cs[0].l, sar = long ? cs[0].l : cs[0].h;
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (long) {
      sar = Math.min(sar, cs[i - 1].l, i > 1 ? cs[i - 2].l : cs[i - 1].l);
      if (cs[i].l < sar) { long = false; sar = ep; ep = cs[i].l; af = step; }
      else if (cs[i].h > ep) { ep = cs[i].h; af = Math.min(af + step, max); }
    } else {
      sar = Math.max(sar, cs[i - 1].h, i > 1 ? cs[i - 2].h : cs[i - 1].h);
      if (cs[i].h > sar) { long = true; sar = ep; ep = cs[i].h; af = step; }
      else if (cs[i].l < ep) { ep = cs[i].l; af = Math.min(af + step, max); }
    }
    out[i] = sar;
  }
  return out;
}

export function supertrend(cs, p = 10, mult = 3) {
  const n = cs.length, a = atr(cs, p), up = NaNs(n), dn = NaNs(n);
  let fu = NaN, fl = NaN, trend = 1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    const hl2 = (cs[i].h + cs[i].l) / 2, bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    const pc = i > 0 ? cs[i - 1].c : cs[i].c;
    fu = Number.isNaN(fu) || bu < fu || pc > fu ? bu : fu;
    fl = Number.isNaN(fl) || bl > fl || pc < fl ? bl : fl;
    if (trend === 1 && cs[i].c < fl) trend = -1; else if (trend === -1 && cs[i].c > fu) trend = 1;
    if (trend === 1) up[i] = fl; else dn[i] = fu;
  }
  return { up, down: dn };
}

// ---- registry used by the UI and the strategy engine ----
// kind 'overlay' draws on the price pane, 'pane' gets its own pane.
// series types: line | hist | dots | band(fill between a & b)
const P = (key, label, def, min = 1, max = 500, step = 1) => ({ key, label, def, min, max, step });
const COLORS = ['#f5b83d', '#3d8bff', '#e56bff', '#20c997', '#ff8a4c', '#19c6d9'];

export const REGISTRY = {
  sma: { name: 'Moving Average (SMA)', kind: 'overlay', params: [P('period', 'Period', 20)],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: sma(col(cs, 'c'), o.period) }] }) },
  ema: { name: 'Exponential MA (EMA)', kind: 'overlay', params: [P('period', 'Period', 21)],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: ema(col(cs, 'c'), o.period) }] }) },
  wma: { name: 'Weighted MA (WMA)', kind: 'overlay', params: [P('period', 'Period', 20)],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: wma(col(cs, 'c'), o.period) }] }) },
  bb: { name: 'Bollinger Bands', kind: 'overlay', params: [P('period', 'Period', 20), P('mult', 'Deviation', 2, 0.1, 10, 0.1)],
    calc: (cs, o) => { const b = bollinger(col(cs, 'c'), o.period, o.mult); return { series: [
      { id: 'band', type: 'band', a: b.upper, b: b.lower }, { id: 'upper', type: 'line', values: b.upper }, { id: 'mid', type: 'line', values: b.mid, dash: true }, { id: 'lower', type: 'line', values: b.lower }] }; } },
  keltner: { name: 'Keltner Channel', kind: 'overlay', params: [P('period', 'Period', 20), P('mult', 'ATR mult', 2, 0.1, 10, 0.1)],
    calc: (cs, o) => { const k = keltner(cs, o.period, o.mult); return { series: [
      { id: 'band', type: 'band', a: k.upper, b: k.lower }, { id: 'upper', type: 'line', values: k.upper }, { id: 'mid', type: 'line', values: k.mid, dash: true }, { id: 'lower', type: 'line', values: k.lower }] }; } },
  donchian: { name: 'Donchian Channel', kind: 'overlay', params: [P('period', 'Period', 20)],
    calc: (cs, o) => { const d = donchian(cs, o.period); return { series: [
      { id: 'band', type: 'band', a: d.upper, b: d.lower }, { id: 'upper', type: 'line', values: d.upper }, { id: 'mid', type: 'line', values: d.mid, dash: true }, { id: 'lower', type: 'line', values: d.lower }] }; } },
  ichimoku: { name: 'Ichimoku Cloud', kind: 'overlay', params: [P('conv', 'Tenkan', 9), P('base', 'Kijun', 26), P('spanB', 'Senkou B', 52)],
    calc: (cs, o) => { const i = ichimoku(cs, o.conv, o.base, o.spanB, o.base); return { series: [
      { id: 'cloud', type: 'band', a: i.spanA, b: i.spanB }, { id: 'tenkan', type: 'line', values: i.tenkan }, { id: 'kijun', type: 'line', values: i.kijun },
      { id: 'spanA', type: 'line', values: i.spanA, thin: true }, { id: 'spanB', type: 'line', values: i.spanB, thin: true }, { id: 'chikou', type: 'line', values: i.chikou, thin: true, dash: true }] }; } },
  psar: { name: 'Parabolic SAR', kind: 'overlay', params: [P('step', 'Step', 0.02, 0.001, 1, 0.001), P('max', 'Maximum', 0.2, 0.01, 1, 0.01)],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'dots', values: psar(cs, o.step, o.max) }] }) },
  supertrend: { name: 'Supertrend', kind: 'overlay', params: [P('period', 'ATR period', 10), P('mult', 'Multiplier', 3, 0.5, 10, 0.1)],
    calc: (cs, o) => { const s = supertrend(cs, o.period, o.mult); return { series: [{ id: 'up', type: 'line', values: s.up, color: 'up' }, { id: 'down', type: 'line', values: s.down, color: 'down' }] }; } },
  vwap: { name: 'VWAP (daily)', kind: 'overlay', params: [], calc: cs => ({ series: [{ id: 'v', type: 'line', values: vwap(cs) }] }) },

  rsi: { name: 'RSI', kind: 'pane', params: [P('period', 'Period', 14)], levels: [30, 70], range: [0, 100],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: rsi(col(cs, 'c'), o.period) }] }) },
  macd: { name: 'MACD', kind: 'pane', params: [P('fast', 'Fast', 12), P('slow', 'Slow', 26), P('signal', 'Signal', 9)], levels: [0],
    calc: (cs, o) => { const m = macd(col(cs, 'c'), o.fast, o.slow, o.signal); return { series: [
      { id: 'hist', type: 'hist', values: m.hist }, { id: 'line', type: 'line', values: m.line }, { id: 'signal', type: 'line', values: m.signal }] }; } },
  stoch: { name: 'Stochastic', kind: 'pane', params: [P('k', '%K', 14), P('smooth', 'Smooth', 3), P('d', '%D', 3)], levels: [20, 80], range: [0, 100],
    calc: (cs, o) => { const s = stochastic(cs, o.k, o.smooth, o.d); return { series: [{ id: 'k', type: 'line', values: s.k }, { id: 'd', type: 'line', values: s.d }] }; } },
  atr: { name: 'ATR', kind: 'pane', params: [P('period', 'Period', 14)], calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: atr(cs, o.period) }] }) },
  cci: { name: 'CCI', kind: 'pane', params: [P('period', 'Period', 20)], levels: [-100, 100, 0],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: cci(cs, o.period) }] }) },
  adx: { name: 'ADX / DMI', kind: 'pane', params: [P('period', 'Period', 14)], levels: [25], range: [0, 100],
    calc: (cs, o) => { const a = adx(cs, o.period); return { series: [{ id: 'adx', type: 'line', values: a.adx }, { id: 'pdi', type: 'line', values: a.pdi, thin: true }, { id: 'mdi', type: 'line', values: a.mdi, thin: true }] }; } },
  willr: { name: 'Williams %R', kind: 'pane', params: [P('period', 'Period', 14)], levels: [-80, -20], range: [-100, 0],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: williamsR(cs, o.period) }] }) },
  mom: { name: 'Momentum', kind: 'pane', params: [P('period', 'Period', 10)], levels: [0],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: momentum(col(cs, 'c'), o.period) }] }) },
  roc: { name: 'Rate of Change', kind: 'pane', params: [P('period', 'Period', 12)], levels: [0],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: roc(col(cs, 'c'), o.period) }] }) },
  obv: { name: 'On-Balance Volume', kind: 'pane', params: [], calc: cs => ({ series: [{ id: 'v', type: 'line', values: obv(cs) }] }) },
  mfi: { name: 'Money Flow Index', kind: 'pane', params: [P('period', 'Period', 14)], levels: [20, 80], range: [0, 100],
    calc: (cs, o) => ({ series: [{ id: 'v', type: 'line', values: mfi(cs, o.period) }] }) },
  volume: { name: 'Volume', kind: 'pane', params: [], calc: cs => ({ series: [{ id: 'v', type: 'hist', values: col(cs, 'v'), byCandle: true }] }) },
};

export const GROUPS = [
  ['Trend', ['sma', 'ema', 'wma', 'ichimoku', 'psar', 'supertrend', 'vwap']],
  ['Volatility', ['bb', 'keltner', 'donchian', 'atr']],
  ['Momentum', ['rsi', 'macd', 'stoch', 'cci', 'willr', 'mom', 'roc', 'adx']],
  ['Volume', ['volume', 'obv', 'mfi']],
];

export function defaults(id) {
  const o = {};
  (REGISTRY[id].params || []).forEach(p => o[p.key] = p.def);
  return o;
}

export function compute(inst, candles) {
  const def = REGISTRY[inst.id];
  return def.calc(candles, { ...defaults(inst.id), ...inst.params });
}

export const PALETTE = COLORS;

// Heikin-Ashi transform for the chart type
export function heikinAshi(cs) {
  const out = [];
  cs.forEach((c, i) => {
    const close = (c.o + c.h + c.l + c.c) / 4;
    const open = i === 0 ? (c.o + c.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ t: c.t, o: open, c: close, h: Math.max(c.h, open, close), l: Math.min(c.l, open, close), v: c.v });
  });
  return out;
}

// Rule-based strategies + a deterministic backtester that runs on real candles.
// No randomness anywhere: the same candles and settings always give the same result.
import { REGISTRY, compute, defaults } from './indicators.js';

const DEFAULT_OUT = { macd: 'line', stoch: 'k', bb: 'mid', keltner: 'mid', donchian: 'mid', adx: 'adx', ichimoku: 'kijun', supertrend: 'up' };
const PARAM_ORDER = Object.fromEntries(Object.entries(REGISTRY).map(([k, v]) => [k, (v.params || []).map(p => p.key)]));

// "ema:21", "macd:hist", "bb:upper:20:2", "close", "30"
export function parseOperand(text) {
  const s = String(text).trim();
  if (s === '') throw new Error('Empty operand');
  if (!Number.isNaN(Number(s))) return { value: Number(s) };
  const parts = s.split(':');
  const head = parts[0].toLowerCase();
  if (['open', 'high', 'low', 'close'].includes(head)) return { price: head[0] };
  if (!REGISTRY[head]) throw new Error(`Unknown indicator "${head}"`);
  const op = { ind: head, params: {}, out: null };
  const order = PARAM_ORDER[head]; let k = 0;
  parts.slice(1).forEach(tok => {
    if (tok !== '' && !Number.isNaN(Number(tok))) { if (k < order.length) op.params[order[k++]] = Number(tok); }
    else op.out = tok;
  });
  return op;
}

export function operandText(op) {
  if (op.value != null) return String(op.value);
  if (op.price) return { o: 'open', h: 'high', l: 'low', c: 'close' }[op.price];
  const order = PARAM_ORDER[op.ind];
  const p = { ...defaults(op.ind), ...op.params };
  return [op.ind, ...(op.out && op.out !== DEFAULT_OUT[op.ind] ? [op.out] : []), ...order.map(k => p[k])].join(':');
}

function series(op, cs, memo) {
  if (op.value != null) return cs.map(() => op.value);
  if (op.price) return cs.map(c => c[op.price]);
  const key = operandText({ ...op, out: op.out });
  if (memo.has(key)) return memo.get(key);
  const res = compute({ id: op.ind, params: op.params }, cs);
  const want = op.out || DEFAULT_OUT[op.ind] || res.series.find(s => s.values)?.id;
  const found = res.series.find(s => s.id === want && s.values) || res.series.find(s => s.values);
  memo.set(key, found.values);
  return found.values;
}

function evalCond(cond, cs, i, memo) {
  const a = series(cond.a, cs, memo), b = series(cond.b, cs, memo);
  if (i < 1 || [a[i], a[i - 1], b[i], b[i - 1]].some(v => !(v === v))) return false;
  if (cond.type === 'cross') return cond.dir === 'above' ? a[i - 1] <= b[i - 1] && a[i] > b[i] : a[i - 1] >= b[i - 1] && a[i] < b[i];
  return cond.op === '>' ? a[i] > b[i] : a[i] < b[i];
}

const allTrue = (conds, cs, i, memo) => conds.length > 0 && conds.every(c => evalCond(c, cs, i, memo));

// Signal at bar i (using bar i's close): 'long' | 'short' | null, plus exit flags.
export function signalAt(strat, cs, i, memo = new Map()) {
  return {
    enterLong: allTrue(strat.rules.enterLong, cs, i, memo),
    enterShort: allTrue(strat.rules.enterShort, cs, i, memo),
    exitLong: allTrue(strat.rules.exitLong, cs, i, memo),
    exitShort: allTrue(strat.rules.exitShort, cs, i, memo),
  };
}

export function validate(s) {
  const errs = [];
  if (!s.name) errs.push('Give the strategy a name.');
  const r = s.rules;
  if (!r.enterLong.length && !r.enterShort.length) errs.push('Add at least one entry rule.');
  if (!(s.risk.lots > 0)) errs.push('Lots must be greater than zero.');
  if (s.risk.slAtr != null && s.risk.slAtr <= 0) errs.push('Stop loss multiple must be positive.');
  if (s.risk.tpAtr != null && s.risk.tpAtr <= 0) errs.push('Take profit multiple must be positive.');
  return errs;
}

// ---------- backtest ----------
export function backtest(strat, cs, opt = {}) {
  const { balance = 10000, contractSize = 100000, spread = 0 } = opt;
  const errs = validate(strat);
  if (errs.length) throw new Error(errs[0]);
  const memo = new Map();
  const atrArr = compute({ id: 'atr', params: { period: strat.risk.atrPeriod || 14 } }, cs).series[0].values;
  const trades = []; let pos = null;
  const lots = strat.risk.lots;
  const close = (i, price, reason) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const pnl = (price - pos.entry) * dir * contractSize * lots;
    trades.push({ ...pos, exit: price, exitT: cs[i].t, exitIdx: i, reason, pnl, bars: i - pos.idx });
    pos = null;
  };
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i];
    // manage open position inside this bar (entered at this bar's open or earlier)
    if (pos) {
      const long = pos.side === 'long';
      const hitSL = pos.sl != null && (long ? c.l <= pos.sl : c.h >= pos.sl);
      const hitTP = pos.tp != null && (long ? c.h >= pos.tp : c.l <= pos.tp);
      if (hitSL) close(i, long ? Math.min(pos.sl, c.o) : Math.max(pos.sl, c.o), 'stop loss');   // conservative: stop wins ties, gaps fill at the open
      else if (hitTP) close(i, long ? Math.max(pos.tp, c.o) : Math.min(pos.tp, c.o), 'take profit');
    }
    // evaluate the signal on this bar's close, act on the next bar's open
    if (i >= cs.length - 1) break;
    const sig = signalAt(strat, cs, i, memo), next = cs[i + 1];
    if (pos) {
      if ((pos.side === 'long' && sig.exitLong) || (pos.side === 'short' && sig.exitShort)) close(i + 1, next.o - (pos.side === 'long' ? 0 : -spread) * 0, 'exit rule');
      else if (!strat.rules.exitLong.length && !strat.rules.exitShort.length) {
        if (pos.side === 'long' && sig.enterShort) close(i + 1, next.o, 'reversal');
        if (pos && pos.side === 'short' && sig.enterLong) close(i + 1, next.o + spread, 'reversal');
      }
    }
    if (!pos && (sig.enterLong || sig.enterShort)) {
      const side = sig.enterLong ? 'long' : 'short';
      const a = atrArr[i];
      const entry = side === 'long' ? next.o + spread : next.o;
      const sl = strat.risk.slAtr && a === a ? (side === 'long' ? entry - a * strat.risk.slAtr : entry + a * strat.risk.slAtr) : null;
      const tp = strat.risk.tpAtr && a === a ? (side === 'long' ? entry + a * strat.risk.tpAtr : entry - a * strat.risk.tpAtr) : null;
      pos = { side, entry, entryT: next.t, idx: i + 1, sl, tp };
    }
  }
  if (pos) close(cs.length - 1, cs[cs.length - 1].c, 'end of data');
  return { trades, stats: stats(trades, balance), equity: equityCurve(trades, balance) };
}

function equityCurve(trades, balance) {
  let eq = balance; const out = [{ t: trades[0]?.entryT ?? 0, v: eq }];
  trades.forEach(t => { eq += t.pnl; out.push({ t: t.exitT, v: eq }); });
  return out;
}

export function stats(trades, balance) {
  const n = trades.length, wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  let eq = balance, peak = balance, maxDD = 0, maxDDPct = 0, streak = 0, worstStreak = 0;
  trades.forEach(t => {
    eq += t.pnl; peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq); maxDDPct = Math.max(maxDDPct, (peak - eq) / peak * 100);
    streak = t.pnl <= 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak);
  });
  return {
    trades: n, wins: wins.length, losses: losses.length,
    winRate: n ? wins.length / n * 100 : 0,
    net: gp - gl, grossProfit: gp, grossLoss: gl,
    profitFactor: gl === 0 ? (gp > 0 ? Infinity : 0) : gp / gl,
    avgWin: wins.length ? gp / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
    expectancy: n ? (gp - gl) / n : 0,
    maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, worstLosingStreak: worstStreak,
    returnPct: (gp - gl) / balance * 100,
    avgBars: n ? trades.reduce((a, t) => a + t.bars, 0) / n : 0,
  };
}

// ---------- templates ----------
const cross = (a, b, dir) => ({ type: 'cross', a: parseOperand(a), b: parseOperand(b), dir });
const cmp = (a, op, b) => ({ type: 'cmp', a: parseOperand(a), op, b: parseOperand(b) });
const empty = () => ({ enterLong: [], enterShort: [], exitLong: [], exitShort: [] });

export const TEMPLATES = {
  ema_cross: () => ({ name: 'EMA crossover', timeframe: 'H1', risk: { lots: 0.1, slAtr: 1.5, tpAtr: 3, atrPeriod: 14 },
    rules: { ...empty(), enterLong: [cross('ema:9', 'ema:21', 'above')], enterShort: [cross('ema:9', 'ema:21', 'below')] } }),
  rsi_reversion: () => ({ name: 'RSI reversion', timeframe: 'H1', risk: { lots: 0.1, slAtr: 2, tpAtr: 2, atrPeriod: 14 },
    rules: { ...empty(), enterLong: [cross('rsi:14', '30', 'above')], enterShort: [cross('rsi:14', '70', 'below')] } }),
  bb_bounce: () => ({ name: 'Bollinger bounce', timeframe: 'M15', risk: { lots: 0.1, slAtr: 1.5, tpAtr: 2, atrPeriod: 14 },
    rules: { ...empty(), enterLong: [cross('close', 'bb:lower:20:2', 'above')], enterShort: [cross('close', 'bb:upper:20:2', 'below')] } }),
  macd_trend: () => ({ name: 'MACD with trend filter', timeframe: 'H4', risk: { lots: 0.1, slAtr: 2, tpAtr: 4, atrPeriod: 14 },
    rules: { ...empty(), enterLong: [cross('macd:line', 'macd:signal', 'above'), cmp('close', '>', 'ema:200')], enterShort: [cross('macd:line', 'macd:signal', 'below'), cmp('close', '<', 'ema:200')] } }),
};

// ---------- XML import / export ----------
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const SIDES = [['enterLong', 'long', 'enter'], ['enterShort', 'short', 'enter'], ['exitLong', 'long', 'exit'], ['exitShort', 'short', 'exit']];

export function toXML(s) {
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<strategy name="${esc(s.name)}">`, `  <timeframe>${esc(s.timeframe || 'H1')}</timeframe>`,
    `  <lots>${s.risk.lots}</lots>`];
  if (s.risk.slAtr) lines.push(`  <stoploss atr="${s.risk.slAtr}" period="${s.risk.atrPeriod || 14}"/>`);
  if (s.risk.tpAtr) lines.push(`  <takeprofit atr="${s.risk.tpAtr}" period="${s.risk.atrPeriod || 14}"/>`);
  SIDES.forEach(([k, side, action]) => {
    if (!s.rules[k].length) return;
    lines.push(`  <rule side="${side}" action="${action}">`);
    s.rules[k].forEach(c => lines.push(c.type === 'cross'
      ? `    <cross a="${esc(operandText(c.a))}" b="${esc(operandText(c.b))}" dir="${c.dir}"/>`
      : `    <compare a="${esc(operandText(c.a))}" op="${c.op === '>' ? 'gt' : 'lt'}" b="${esc(operandText(c.b))}"/>`));
    lines.push('  </rule>');
  });
  lines.push('</strategy>');
  return lines.join('\n');
}

export function fromXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid XML.');
  const root = doc.documentElement;
  if (root.tagName !== 'strategy') throw new Error('Expected a <strategy> root element.');
  const s = { name: root.getAttribute('name') || 'Imported strategy', timeframe: 'H1', risk: { lots: 0.1, atrPeriod: 14 }, rules: empty() };
  const tf = root.querySelector('timeframe')?.textContent.trim(); if (tf) s.timeframe = tf;
  const lots = parseFloat(root.querySelector('lots')?.textContent); if (lots > 0) s.risk.lots = lots;
  const sl = root.querySelector('stoploss'), tp = root.querySelector('takeprofit');
  if (sl) { s.risk.slAtr = parseFloat(sl.getAttribute('atr')) || null; s.risk.atrPeriod = parseInt(sl.getAttribute('period')) || 14; }
  if (tp) { s.risk.tpAtr = parseFloat(tp.getAttribute('atr')) || null; }
  root.querySelectorAll('rule').forEach(r => {
    const side = r.getAttribute('side'), action = r.getAttribute('action') || 'enter';
    const key = SIDES.find(x => x[1] === side && x[2] === action)?.[0];
    if (!key) throw new Error(`Rule has unknown side/action: ${side}/${action}`);
    r.querySelectorAll('cross, compare').forEach(c => {
      if (c.tagName === 'cross') s.rules[key].push(cross(c.getAttribute('a'), c.getAttribute('b'), c.getAttribute('dir') === 'below' ? 'below' : 'above'));
      else s.rules[key].push(cmp(c.getAttribute('a'), c.getAttribute('op') === 'lt' ? '<' : '>', c.getAttribute('b')));
    });
  });
  const errs = validate(s); if (errs.length) throw new Error(errs[0]);
  return s;
}

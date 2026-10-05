import { backtest, TEMPLATES, parseOperand, operandText, validate } from '../static/js/strategy.js';
// deterministic trending/oscillating candles
let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
let p = 1.1; const cs = [];
for (let i = 0; i < 1500; i++) { const o = p, c = p + Math.sin(i / 40) * 0.0006 + (rnd() - .5) * 0.001, h = Math.max(o, c) + rnd() * .0005, l = Math.min(o, c) - rnd() * .0005; cs.push({ t: 1700000000 + i * 3600, o, h, l, c, v: 100 }); p = c; }
for (const [k, f] of Object.entries(TEMPLATES)) {
  const st = f(); if (validate(st).length) throw new Error(k + ' invalid');
  const a = backtest(st, cs, { balance: 10000, contractSize: 100000, spread: 0.00005 });
  const b = backtest(st, cs, { balance: 10000, contractSize: 100000, spread: 0.00005 });
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('non-deterministic');
  const net = a.trades.reduce((x, t) => x + t.pnl, 0);
  if (Math.abs(net - a.stats.net) > 1e-6) throw new Error('net mismatch');
  for (const t of a.trades) { if (t.exitIdx < t.idx) throw new Error('exit before entry'); if (t.side === 'long' && t.sl && t.exit < t.sl - 1e-9 && t.reason === 'take profit') throw new Error('bad fill'); }
  console.log(k.padEnd(14), 'trades', a.stats.trades, 'win%', a.stats.winRate.toFixed(1), 'PF', a.stats.profitFactor.toFixed(2), 'net', a.stats.net.toFixed(2), 'maxDD%', a.stats.maxDrawdownPct.toFixed(2));
}
for (const t of ['ema:21', 'macd:hist', 'bb:upper:20:2', 'close', '30']) console.log(t, '->', operandText(parseOperand(t)));
console.log('STRATEGY OK');

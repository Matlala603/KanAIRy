import * as I from '../static/js/indicators.js';
let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
let p = 100; const cs = [];
for (let i = 0; i < 400; i++) { const o = p, c = p + (rnd() - 0.5) * 2, h = Math.max(o, c) + rnd(), l = Math.min(o, c) - rnd(); cs.push({ t: 1700000000 + i * 3600, o, h, l, c, v: 100 + Math.floor(rnd() * 50) }); p = c; }
const c = I.col(cs, 'c');
const out = { cs, sma: I.sma(c, 20), ema: I.ema(c, 21), rsi: I.rsi(c, 14), macd: I.macd(c), bb: I.bollinger(c, 20, 2), atr: I.atr(cs, 14), stoch: I.stochastic(cs, 14, 3, 3), adx: I.adx(cs, 14), cci: I.cci(cs, 20), willr: I.williamsR(cs, 14) };
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' && Number.isNaN(v)) ? null : v));

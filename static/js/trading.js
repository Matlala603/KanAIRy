// Order ticket + positions / orders / history panel.
import { h, icon, clear, toast, money, signed, cls, dt, $, num } from './util.js';
import { S, on, emit, inst, digitsOf, isBroker } from './state.js';
import { api } from './api.js';
import { refreshNow } from './market.js';
import { brokerDirectory } from './connect.js';
import { openSheet, confirmSheet } from './ui.js';
import { hooks, pickSymbol, selectSymbol } from './terminal.js';

const fmt = (v, d) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const pipSize = d => Math.pow(10, -(d >= 3 ? d - 1 : d === 2 ? 1 : d));
const decimals = step => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };

// ---------------- order ticket ----------------
export function mountTicket(root) {
  const T = { type: 'market', pending: 'limit', volume: S.settings.defaultVolume || 0.01, price: '', limitPrice: '', sl: '', tp: '' };
  let busy = false;

  function draw() {
    clear(root);
    root.append(h('div', { class: 'panel-head' }, 'New order'));
    if (!isBroker()) {
      root.append(h('div', { class: 'ticket' },
        h('div', { class: 'lock' }, h('b', {}, 'Connect a broker to trade'), h('p', {}, 'Prices and charts work without an account. To place orders, link your MetaTrader 4 or 5 account.'),
          h('button', { class: 'btn primary', onclick: () => hooks.openConnect() }, icon('link', 16), 'Connect broker')),
        h('div', { class: 'lbl' }, 'Available brokers'), brokerDirectory((name, servers, plat) => hooks.openConnect({ name, servers, plat }))));
      return;
    }
    const i = inst(S.symbol) || {}, d = digitsOf(S.symbol);
    const step = i.volumeStep || 0.01, vmin = i.minVolume || 0.01;
    const sell = h('button', { class: 'sb sell', id: 'tkSell', onclick: () => place('sell') }, h('small', {}, 'Sell'), h('b', {}, '—'));
    const buy = h('button', { class: 'sb buy', id: 'tkBuy', onclick: () => place('buy') }, h('small', {}, 'Buy'), h('b', {}, '—'));
    const typeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Order type', style: { width: '100%' } },
      [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop'], ['stop_limit', 'Stop-limit']].map(([k, l]) => h('button', { style: { flex: 1 }, 'aria-pressed': String(T.type === k), onclick: () => { T.type = k; draw(); } }, l)));
    const vol = h('input', { class: 'input', id: 'tkVol', inputmode: 'decimal', value: T.volume, 'aria-label': 'Volume in lots', oninput: e => { T.volume = e.target.value; calc(); } });
    const bump = dir => { const v = (num(T.volume) || 0) + dir * step; T.volume = Math.max(vmin, +v.toFixed(decimals(step))); vol.value = T.volume; calc(); };
    const inputField = (key, label, ph) => h('div', { class: 'field' }, h('label', {}, label), h('input', { class: 'input', inputmode: 'decimal', placeholder: ph || 'Optional', value: T[key], 'aria-label': label, oninput: e => { T[key] = e.target.value; calc(); } }));
    const slInput = inputField('sl', 'Stop loss (price)'), tpInput = inputField('tp', 'Take profit (price)');
    const quickDist = (key, mult) => h('button', { class: 'chip', onclick: () => setDist(key, mult) }, `${key === 'sl' ? 'SL' : 'TP'} ${mult} pips`);
    root.append(h('div', { class: 'ticket' },
      h('button', { class: 'sym-btn', onclick: () => pickSymbol(selectSymbol), style: { padding: 0 } }, h('div', {}, h('div', { class: 's' }, S.symbol), h('div', { class: 'd' }, i.name || '')), icon('swap', 15)),
      h('div', { class: 'sellbuy' }, sell, buy), h('div', { class: 'spreadline', id: 'tkSpread' }, ''),
      typeSeg,
      T.type !== 'market' ? h('div', { class: 'two' }, inputField('price', T.type === 'stop_limit' ? 'Stop trigger price' : 'Entry price', 'Price'), T.type === 'stop_limit' ? inputField('limitPrice', 'Limit price', 'Price') : h('div', { class: 'field' }, h('label', {}, 'Distance'), h('div', { class: 'input mute', id: 'tkDist' }, '—'))) : null,
      h('div', { class: 'field' }, h('label', {}, `Volume (lots)${i.minVolume ? ` · min ${i.minVolume}${i.maxVolume ? `, max ${i.maxVolume}` : ''}` : ''}`),
        h('div', { class: 'stepper' }, h('button', { 'aria-label': 'Decrease volume', onclick: () => bump(-1) }, '−'), vol, h('button', { 'aria-label': 'Increase volume', onclick: () => bump(1) }, '+'))),
      h('div', { class: 'chips' }, [0.01, 0.05, 0.1, 0.5, 1].map(v => h('button', { class: 'chip', onclick: () => { T.volume = v; vol.value = v; calc(); } }, String(v)))),
      h('div', { class: 'two' }, slInput, tpInput),
      h('div', { class: 'chips' }, quickDist('sl', 10), quickDist('sl', 25), quickDist('tp', 20), quickDist('tp', 50), h('button', { class: 'chip', onclick: () => { T.sl = ''; T.tp = ''; draw(); } }, 'Clear')),
      h('div', { class: 'info' }, h('div', {}, h('span', {}, 'Risk at stop'), h('b', { id: 'tkRisk' }, '—')), h('div', {}, h('span', {}, 'Potential at target'), h('b', { id: 'tkRew' }, '—')), h('div', {}, h('span', {}, 'Free margin'), h('b', { id: 'tkFree' }, '—'))),
      h('div', { class: 'err', id: 'tkErr' }), h('p', { class: 'hint' }, 'Risk uses the symbol’s contract size and assumes your account currency matches the quote currency, so treat it as an estimate.')));
    calc(); paintPrices();
  }

  function ref(side) {
    const q = S.quotes[S.symbol]; if (!q) return null;
    if (T.type === 'market') return side === 'buy' ? q.ask : q.bid;
    return num(T.price) || null;
  }
  function setDist(key, pips) {
    const side = T.side || 'buy', r = ref('buy') || ref('sell'); if (!r) return;
    const dist = pips * pipSize(digitsOf(S.symbol)), d = digitsOf(S.symbol);
    // stop loss goes against the side, take profit with it; default to the buy side until a side is clicked
    const v = (key === 'sl') === (side === 'buy') ? r - dist : r + dist;
    T[key] = v.toFixed(d); draw();
  }
  function calc() {
    const i = inst(S.symbol) || {}, vol = num(T.volume), cs = i.contractSize || 100000, acc = S.account;
    const entry = ref('buy') || ref('sell'), sl = num(T.sl), tp = num(T.tp), ccy = acc?.currency || 'USD';
    const set = (id, v) => { const el = root.querySelector('#' + id); if (el) el.textContent = v; };
    if (entry && vol > 0 && sl > 0) { const risk = Math.abs(entry - sl) * cs * vol; set('tkRisk', `${money(risk, ccy)} (${(risk / (acc?.balance || 1) * 100).toFixed(1)}%)`); } else set('tkRisk', '—');
    if (entry && vol > 0 && tp > 0) set('tkRew', money(Math.abs(tp - entry) * cs * vol, ccy)); else set('tkRew', '—');
    set('tkFree', acc ? money(acc.freeMargin, ccy) : '—');
    const dist = root.querySelector('#tkDist'), q = S.quotes[S.symbol], p = num(T.price);
    if (dist && q && p) dist.textContent = `${((p - q.bid) / pipSize(digitsOf(S.symbol))).toFixed(1)} pips from bid`;
  }
  function paintPrices() {
    const q = S.quotes[S.symbol], d = digitsOf(S.symbol), s = root.querySelector('#tkSell b'), b = root.querySelector('#tkBuy b'), sp = root.querySelector('#tkSpread');
    if (!s || !q) return;
    s.textContent = fmt(q.bid, d); b.textContent = fmt(q.ask, d);
    sp.textContent = `Spread ${((q.ask - q.bid) / pipSize(d)).toFixed(1)} pips`;
    calc();
  }

  function validate(side) {
    const i = inst(S.symbol) || {}, q = S.quotes[S.symbol], vol = num(T.volume), d = digitsOf(S.symbol);
    if (!q) return 'Waiting for a live price for this symbol.';
    if (!(vol > 0)) return 'Enter a volume.';
    if (i.minVolume && vol < i.minVolume - 1e-9) return `Minimum volume is ${i.minVolume} lots.`;
    if (i.maxVolume && vol > i.maxVolume + 1e-9) return `Maximum volume is ${i.maxVolume} lots.`;
    if (i.volumeStep) { const k = vol / i.volumeStep; if (Math.abs(k - Math.round(k)) > 1e-6) return `Volume must be a multiple of ${i.volumeStep}.`; }
    const sl = T.sl === '' ? null : num(T.sl), tp = T.tp === '' ? null : num(T.tp);
    if ((T.sl !== '' && !(sl > 0)) || (T.tp !== '' && !(tp > 0))) return 'Stop loss and take profit must be prices.';
    let entry = side === 'buy' ? q.ask : q.bid;
    if (T.type !== 'market') {
      const p = num(T.price); if (!(p > 0)) return 'Enter the order price.';
      if (T.type === 'limit' && (side === 'buy' ? p >= q.ask : p <= q.bid)) return side === 'buy' ? 'A buy limit must be below the current ask.' : 'A sell limit must be above the current bid.';
      if (T.type === 'stop' && (side === 'buy' ? p <= q.ask : p >= q.bid)) return side === 'buy' ? 'A buy stop must be above the current ask.' : 'A sell stop must be below the current bid.';
      if (T.type === 'stop_limit' && !(num(T.limitPrice) > 0)) return 'Enter the limit price.';
      entry = p;
    }
    if (sl != null && (side === 'buy' ? sl >= entry : sl <= entry)) return side === 'buy' ? 'For a buy, the stop loss must be below the entry price.' : 'For a sell, the stop loss must be above the entry price.';
    if (tp != null && (side === 'buy' ? tp <= entry : tp >= entry)) return side === 'buy' ? 'For a buy, the take profit must be above the entry price.' : 'For a sell, the take profit must be below the entry price.';
    void d; return null;
  }

  async function place(side) {
    if (busy) return; busy = true; root.querySelectorAll('.sb').forEach(b => { b.disabled = true; });
    try { await placeInner(side); } finally { busy = false; root.querySelectorAll('.sb').forEach(b => { b.disabled = false; }); }
  }
  async function placeInner(side) {
    T.side = side;
    const err = root.querySelector('#tkErr'); err.textContent = '';
    const bad = validate(side); if (bad) { err.textContent = bad; return; }
    const d = digitsOf(S.symbol), q = S.quotes[S.symbol];
    const body = { symbol: S.symbol, side, type: T.type, volume: num(T.volume) };
    if (T.type !== 'market') body.price = num(T.price);
    if (T.type === 'stop_limit') body.stopLimitPrice = num(T.limitPrice);
    if (T.sl !== '') body.stopLoss = num(T.sl);
    if (T.tp !== '') body.takeProfit = num(T.tp);
    const acct = S.account;
    if (S.settings.confirmOrders) {
      const rows = [['Order', `${side.toUpperCase()} ${T.type.replace('_', '-')} ${body.volume} ${S.symbol}`], ['Price', T.type === 'market' ? `Market (${fmt(side === 'buy' ? q.ask : q.bid, d)})` : fmt(body.price, d)],
        ['Stop loss', body.stopLoss ? fmt(body.stopLoss, d) : 'None'], ['Take profit', body.takeProfit ? fmt(body.takeProfit, d) : 'None'], ['Account', `${acct?.login || ''} · ${acct?.server || ''}`]];
      const ok = await confirmSheet({ title: 'Confirm order', message: acct?.type === 'ACCOUNT_TRADE_MODE_REAL' || /real|live/i.test(acct?.server || '') ? 'This is a live account. Real money is at risk.' : 'Review the order before sending it to your broker.',
        okText: `${side === 'buy' ? 'Buy' : 'Sell'} ${S.symbol}`, details: h('div', { class: 'info' }, rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v)))) });
      if (!ok) return;
    }
    try {
      const r = await api.order(body);
      toast(`${r.message || 'Order accepted'}${r.positionId ? ' · #' + r.positionId : ''}`, 'ok'); refreshNow();
      if (T.type !== 'market') hooks.showScreen('positions');
    } catch (e) { err.textContent = e.message; toast(e.message, 'error'); }
  }

  hooks.openTicket = ({ side, type, price } = {}) => {
    if (!isBroker()) { hooks.showScreen('trade'); return; }
    if (type) { T.type = type; T.price = price != null ? String(price) : ''; }
    else if (side && T.type !== 'market' && price == null) { /* keep pending settings */ }
    draw(); hooks.showScreen('trade');
    if (side && !type) { root.querySelector(side === 'buy' ? '#tkBuy' : '#tkSell')?.focus(); }
  };
  on('quotes', paintPrices);
  on('snapshot', calc);
  on('symbol', () => { T.price = ''; T.limitPrice = ''; T.sl = ''; T.tp = ''; draw(); });
  on('mode', draw); on('instruments', draw);
  draw();
}

// ---------------- positions / orders / history ----------------
export function mountPositions(root) {
  let tab = 'positions', histDays = 30, deals = null, dealsErr = null;
  const body = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column' } });
  const bar = h('div', { class: 'acct-bar' });
  const tabs = h('div', { class: 'tabs', style: { padding: '8px 12px', borderBottom: '1px solid var(--line)' } });
  clear(root).append(tabs, body, bar);

  const drawTabs = () => {
    clear(tabs).append(...[['positions', `Positions (${S.positions.length})`], ['orders', `Orders (${S.orders.length})`], ['history', 'History']].map(([k, l]) =>
      h('button', { class: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawTabs(); render(true); if (k === 'history') loadHistory(); } }, l)));
  };
  function lock() {
    return h('div', { class: 'empty' }, h('b', {}, 'No account connected'), 'Connect a MetaTrader account to see positions, pending orders and trade history.',
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => hooks.openConnect() }, icon('link', 16), 'Connect broker')));
  }

  let sig = '';
  function render(force) {
    if (!isBroker()) { sig = ''; clear(body).append(lock()); clear(bar); return; }
    drawBar();
    if (tab === 'positions') renderPositions(force);
    else if (tab === 'orders') renderOrders();
    else renderHistory();
  }

  function drawBar() {
    const a = S.account; if (!a) { clear(bar); return; }
    const c = a.currency, tot = S.positions.reduce((s, p) => s + p.profit, 0);
    clear(bar).append(...[['Balance', money(a.balance, c)], ['Equity', money(a.equity, c)], ['Margin', money(a.margin, c)], ['Free', money(a.freeMargin, c)], ['Level', a.marginLevel ? a.marginLevel.toFixed(0) + '%' : '—']].map(([k, v]) => h('span', {}, k, h('b', {}, v))),
      h('span', {}, 'Open P/L', h('b', { class: cls(tot) }, signed(tot) + ' ' + c)));
  }

  function renderPositions(force) {
    const ps = S.positions, s = ps.map(p => p.id + p.stopLoss + p.takeProfit + p.volume).join('|');
    if (!force && s === sig && body.dataset.tab === 'positions') { ps.forEach(p => { body.querySelectorAll(`[data-pid="${p.id}"] [data-f=profit]`).forEach(el => { el.textContent = signed(p.profit); el.className = (el.dataset.r ? 'r ' : '') + cls(p.profit); }); body.querySelectorAll(`[data-pid="${p.id}"] [data-f=cur]`).forEach(el => { el.textContent = fmt(p.currentPrice, digitsOf(p.symbol)); }); }); return; }
    sig = s; clear(body).dataset.tab = 'positions';
    if (!ps.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'No open positions'), 'Orders you place appear here instantly.')); return; }
    const d = p => digitsOf(p.symbol);
    const actions = p => h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => modify(p) }, 'Edit'), h('button', { class: 'btn sm', onclick: () => partial(p) }, 'Part'), h('button', { class: 'btn sm danger', onclick: () => closePos(p) }, 'Close'));
    const table = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Symbol', 'Type', 'Volume', 'Open', 'Price', 'SL', 'TP', 'Swap', 'Profit', ''].map((t, i) => h('th', { class: i > 1 && i < 9 ? 'r' : '' }, t)))),
      h('tbody', {}, ps.map(p => h('tr', { dataset: { pid: p.id } }, h('td', {}, h('b', {}, p.symbol)), h('td', {}, h('span', { class: 'pill ' + p.side }, p.side)), h('td', { class: 'r' }, p.volume), h('td', { class: 'r' }, fmt(p.openPrice, d(p))),
        h('td', { class: 'r', dataset: { f: 'cur' } }, fmt(p.currentPrice, d(p))), h('td', { class: 'r' }, p.stopLoss ? fmt(p.stopLoss, d(p)) : '—'), h('td', { class: 'r' }, p.takeProfit ? fmt(p.takeProfit, d(p)) : '—'),
        h('td', { class: 'r' }, signed(p.swap)), h('td', { class: 'r ' + cls(p.profit), dataset: { f: 'profit', r: '1' } }, signed(p.profit)), h('td', {}, actions(p))))));
    const cards = h('div', { class: 'cards' }, ps.map(p => h('div', { class: 'pcard', dataset: { pid: p.id } },
      h('div', { class: 'top' }, h('div', {}, h('b', {}, p.symbol), ' ', h('span', { class: 'pill ' + p.side }, `${p.side} ${p.volume}`)), h('b', { class: cls(p.profit), dataset: { f: 'profit' } }, signed(p.profit))),
      h('div', { class: 'meta' }, h('span', {}, `Open ${fmt(p.openPrice, d(p))}`), h('span', {}, h('span', {}, 'Now '), h('span', { dataset: { f: 'cur' } }, fmt(p.currentPrice, d(p))))),
      h('div', { class: 'meta' }, h('span', {}, `SL ${p.stopLoss ? fmt(p.stopLoss, d(p)) : '—'}`), h('span', {}, `TP ${p.takeProfit ? fmt(p.takeProfit, d(p)) : '—'}`)), actions(p))));
    body.append(h('div', { class: 'table-wrap' }, table), cards);
  }

  function renderOrders() {
    clear(body).dataset.tab = 'orders'; sig = '';
    if (!S.orders.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'No pending orders'), 'Right-click (or long-press) a price on the chart to place a limit or stop order.')); return; }
    const d = o => digitsOf(o.symbol);
    const act = o => h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => editOrder(o) }, 'Edit'), h('button', { class: 'btn sm danger', onclick: () => cancel(o) }, 'Cancel'));
    body.append(h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Symbol', 'Type', 'Volume', 'Price', 'SL', 'TP', 'Placed', ''].map((t, i) => h('th', { class: i > 1 && i < 6 ? 'r' : '' }, t)))),
      h('tbody', {}, S.orders.map(o => h('tr', {}, h('td', {}, h('b', {}, o.symbol)), h('td', {}, h('span', { class: 'pill ' + o.side }, o.type.replace('_', ' '))), h('td', { class: 'r' }, o.volume), h('td', { class: 'r' }, fmt(o.price, d(o))), h('td', { class: 'r' }, o.stopLoss ? fmt(o.stopLoss, d(o)) : '—'), h('td', { class: 'r' }, o.takeProfit ? fmt(o.takeProfit, d(o)) : '—'), h('td', {}, dt(o.time)), h('td', {}, act(o))))))),
      h('div', { class: 'cards' }, S.orders.map(o => h('div', { class: 'pcard' }, h('div', { class: 'top' }, h('div', {}, h('b', {}, o.symbol), ' ', h('span', { class: 'pill ' + o.side }, `${o.type.replace('_', ' ')} ${o.volume}`)), h('b', {}, fmt(o.price, d(o)))),
        h('div', { class: 'meta' }, h('span', {}, `SL ${o.stopLoss ? fmt(o.stopLoss, d(o)) : '—'}`), h('span', {}, `TP ${o.takeProfit ? fmt(o.takeProfit, d(o)) : '—'}`)), act(o)))));
  }

  async function loadHistory() {
    deals = null; dealsErr = null; renderHistory();
    try { deals = (await api.history(histDays)).deals; } catch (e) { dealsErr = e.message; }
    if (tab === 'history') renderHistory();
  }
  function renderHistory() {
    clear(body).dataset.tab = 'history'; sig = '';
    const seg = h('div', { class: 'seg', style: { margin: '10px 12px' } }, [7, 30, 90, 365].map(n => h('button', { 'aria-pressed': String(n === histDays), onclick: () => { histDays = n; loadHistory(); } }, n === 365 ? '1y' : n + 'd')));
    body.append(seg);
    if (dealsErr) { body.append(h('div', { class: 'empty' }, h('b', {}, 'History unavailable'), dealsErr, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: loadHistory }, 'Try again')))); return; }
    if (!deals) { for (let i = 0; i < 4; i++) body.append(h('div', { class: 'skeleton', style: { margin: '6px 12px' } })); return; }
    const closed = deals.filter(x => x.kind === 'deal' && x.entry !== 'in');
    const net = closed.reduce((s, x) => s + x.profit + x.swap + x.commission, 0), wins = closed.filter(x => x.profit > 0).length;
    body.append(h('div', { class: 'acct-bar', style: { borderTop: 0, borderBottom: '1px solid var(--line)' } }, h('span', {}, 'Closed deals', h('b', {}, closed.length)), h('span', {}, 'Win rate', h('b', {}, closed.length ? (wins / closed.length * 100).toFixed(0) + '%' : '—')), h('span', {}, 'Net', h('b', { class: cls(net) }, signed(net) + ' ' + (S.account?.currency || '')))));
    if (!deals.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'No deals in this period'), 'Try a longer range.')); return; }
    body.append(h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Time', 'Symbol', 'Type', 'Volume', 'Price', 'Profit'].map((t, i) => h('th', { class: i > 2 ? 'r' : '' }, t)))),
      h('tbody', {}, deals.slice(0, 300).map(x => h('tr', {}, h('td', {}, dt(x.time)), h('td', {}, x.kind === 'balance' ? h('span', { class: 'mute' }, x.comment) : h('b', {}, x.symbol)),
        h('td', {}, x.kind === 'balance' ? 'Balance' : h('span', { class: 'pill ' + x.side }, `${x.side} ${x.entry === 'in' ? 'in' : 'out'}`)), h('td', { class: 'r' }, x.kind === 'deal' ? x.volume : ''), h('td', { class: 'r' }, x.kind === 'deal' ? fmt(x.price, digitsOf(x.symbol)) : ''),
        h('td', { class: 'r ' + cls(x.profit) }, x.profit ? signed(x.profit) : '—')))))),
      h('div', { class: 'cards' }, deals.slice(0, 200).map(x => h('div', { class: 'pcard' }, h('div', { class: 'top' }, h('div', {}, h('b', {}, x.kind === 'balance' ? 'Balance' : x.symbol), ' ', x.kind === 'deal' ? h('span', { class: 'pill ' + x.side }, `${x.side} ${x.entry === 'in' ? 'in' : 'out'} ${x.volume}`) : null), h('b', { class: cls(x.profit) }, x.profit ? signed(x.profit) : '—')), h('div', { class: 'meta' }, h('span', {}, dt(x.time)), h('span', {}, x.kind === 'deal' ? fmt(x.price, digitsOf(x.symbol)) : x.comment))))));
  }

  // ----- actions -----
  async function closePos(p) {
    const ok = await confirmSheet({ title: 'Close position', message: `Close ${p.side.toUpperCase()} ${p.volume} ${p.symbol} at market? Floating P/L is ${signed(p.profit)}.`, okText: 'Close position', danger: true }); if (!ok) return;
    try { await api.closePosition(p.id); toast('Position closed', 'ok'); refreshNow(); } catch (e) { toast(e.message, 'error'); }
  }
  async function partial(p) {
    const inp = h('input', { class: 'input', inputmode: 'decimal', value: (p.volume / 2).toFixed(2), 'aria-label': 'Volume to close' });
    const s = openSheet({ title: `Close part of ${p.symbol}`, body: h('div', { class: 'field' }, h('label', {}, `Volume to close (open: ${p.volume} lots)`), inp),
      footer: [h('button', { class: 'btn', onclick: () => s.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
        const v = num(inp.value); if (!(v > 0 && v < p.volume)) { inp.classList.add('bad'); return; }
        try { await api.closePosition(p.id, v); toast(`Closed ${v} lots`, 'ok'); s.close(); refreshNow(); } catch (e) { toast(e.message, 'error'); } } }, 'Close volume')] });
  }
  function levelsSheet(title, o, apply, withPrice) {
    const d = digitsOf(o.symbol);
    const price = withPrice ? h('input', { class: 'input', inputmode: 'decimal', value: fmt(o.price, d), 'aria-label': 'Price' }) : null;
    const sl = h('input', { class: 'input', inputmode: 'decimal', value: o.stopLoss ? fmt(o.stopLoss, d) : '', placeholder: 'None', 'aria-label': 'Stop loss' });
    const tp = h('input', { class: 'input', inputmode: 'decimal', value: o.takeProfit ? fmt(o.takeProfit, d) : '', placeholder: 'None', 'aria-label': 'Take profit' });
    const err = h('div', { class: 'err' });
    const s = openSheet({ title, body: h('div', { class: 'stack' }, h('p', { class: 'hint' }, 'Leave a field empty to remove it.'),
      price ? h('div', { class: 'field' }, h('label', {}, 'Price'), price) : null, h('div', { class: 'field' }, h('label', {}, 'Stop loss'), sl), h('div', { class: 'field' }, h('label', {}, 'Take profit'), tp), err),
      footer: [h('button', { class: 'btn', onclick: () => s.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
        const vals = { stopLoss: sl.value.trim() === '' ? 0 : num(sl.value), takeProfit: tp.value.trim() === '' ? 0 : num(tp.value) };
        if (Number.isNaN(vals.stopLoss) || Number.isNaN(vals.takeProfit) || vals.stopLoss < 0 || vals.takeProfit < 0) { err.textContent = 'Enter valid prices.'; return; }
        if (price) { vals.price = num(price.value); if (!(vals.price > 0)) { err.textContent = 'Enter a valid price.'; return; } }
        try { await apply(vals); toast('Updated', 'ok'); s.close(); refreshNow(); } catch (e) { err.textContent = e.message; } } }, 'Save')] });
  }
  const modify = p => levelsSheet(`Edit ${p.symbol} position`, p, v => api.modifyPosition(p.id, v), false);
  const editOrder = o => levelsSheet(`Edit ${o.symbol} order`, o, v => api.modifyOrder(o.id, v), true);
  async function cancel(o) {
    if (!await confirmSheet({ title: 'Cancel order', message: `Cancel ${o.type.replace('_', ' ')} ${o.volume} ${o.symbol} at ${fmt(o.price, digitsOf(o.symbol))}?`, okText: 'Cancel order', danger: true })) return;
    try { await api.cancelOrder(o.id); toast('Order cancelled', 'ok'); refreshNow(); } catch (e) { toast(e.message, 'error'); }
  }

  on('snapshot', () => { drawTabs(); render(false); });
  on('mode', () => { deals = null; drawTabs(); render(true); });
  drawTabs(); render(true);
  hooks.refreshPositions = () => { drawTabs(); render(true); };
  void $; void emit;
}

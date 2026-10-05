// Secondary screens: news, calendar, account, strategies, learn, settings, about, developer, assistant.
import { h, icon, clear, toast, money, signed, cls, ago, dt, store } from './util.js';
import { S, on, emit, active, isBroker, inst, digitsOf, persist, TFS, TF_SEC } from './state.js';
import { api } from './api.js';
import { candles } from './market.js';
import { openSheet, confirmSheet } from './ui.js';
import { hooks } from './terminal.js';
import { TEMPLATES, backtest, toXML, fromXML, validate, signalAt } from './strategy.js';

const page = (id, ...kids) => clear(document.getElementById('view-' + id)).append(h('div', { class: 'inner' }, ...kids));
const lock = (what) => h('div', { class: 'card empty' }, h('b', {}, 'Connect a broker first'), `${what} comes from your MetaTrader account.`,
  h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => hooks.openConnect() }, icon('link', 16), 'Connect broker')));

// ---------------- news ----------------
export function mountNews() {
  let source = 'all', timer = null, data = null, err = null;
  const render = () => {
    const list = h('div', {});
    if (err) list.append(h('div', { class: 'empty' }, h('b', {}, 'News unavailable'), err, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: load }, 'Try again'))));
    else if (!data) for (let i = 0; i < 5; i++) list.append(h('div', { class: 'skeleton', style: { margin: '10px 0', height: '84px' } }));
    else if (!data.articles.length) list.append(h('div', { class: 'empty' }, h('b', {}, 'No headlines right now'), 'The publishers’ feeds returned nothing. Try another source.'));
    else data.articles.forEach(a => list.append(h('a', { class: 'news-item', href: a.url, target: '_blank', rel: 'noopener noreferrer' },
      h('div', { class: 'nt' }, a.title), a.summary ? h('div', { class: 'ns' }, a.summary) : null, h('div', { class: 'nm' }, h('b', {}, a.source), ago(a.time), icon('external', 12)))));
    const srcs = [['all', 'All'], ...Object.entries(data?.sources || { fxstreet: 'FXStreet', investing: 'Investing.com', cnbc: 'CNBC Markets', marketwatch: 'MarketWatch', bloomberg: 'Bloomberg Markets', cointelegraph: 'Cointelegraph' })];
    page('news', h('div', { class: 'h1' }, 'Market news'), h('p', { class: 'lead' }, 'Live headlines from publishers’ own feeds. Tap one to read it at the source.'),
      h('div', { class: 'tabs', style: { padding: '0 0 10px' } }, srcs.map(([k, l]) => h('button', { class: 'tab', 'aria-selected': String(k === source), onclick: () => { source = k; data = null; err = null; render(); load(); } }, l))), list);
  };
  async function load() {
    try { err = null; data = await api.news(source); } catch (e) { err = e.message; }
    render();
  }
  hooks.onNews = () => { render(); load(); clearInterval(timer); timer = setInterval(() => { if (document.body.dataset.screen === 'news') load(); }, 300000); };
}

// ---------------- calendar ----------------
export function mountCalendar() {
  let week = 'this', impact = 'all', ccy = 'all', data = null, err = null;
  const FLAG = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳', ZAR: '🇿🇦' };
  const render = () => {
    const body = h('div', {});
    if (err) body.append(h('div', { class: 'empty' }, h('b', {}, 'Calendar unavailable'), err, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: load }, 'Try again'))));
    else if (!data) for (let i = 0; i < 6; i++) body.append(h('div', { class: 'skeleton', style: { margin: '8px 0', height: '40px' } }));
    else {
      const evs = data.filter(e => (impact === 'all' || e.impact === impact || (impact === 'high' && false)) && (ccy === 'all' || e.country === ccy));
      if (!evs.length) body.append(h('div', { class: 'empty' }, h('b', {}, 'No events match'), 'Change the impact or currency filter.'));
      let day = '';
      evs.forEach(e => {
        const d = new Date(e.time * 1000), label = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
        if (label !== day) { day = label; body.append(h('div', { class: 'cal-day' }, label)); }
        body.append(h('div', { class: 'cal-row' + (e.time < Date.now() / 1000 ? ' past' : '') },
          h('div', { class: 'mute' }, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), h('div', {}, (FLAG[e.country] || '') + ' ' + e.country),
          h('div', {}, h('span', { class: 'impact ' + e.impact, title: e.impact + ' impact' }), ' ', e.title), h('div', { class: 'f' }, e.forecast ? `F ${e.forecast}` : '', e.previous ? h('div', {}, `P ${e.previous}`) : null)));
      });
    }
    const ccys = ['all', ...new Set((data || []).map(e => e.country))];
    page('calendar', h('div', { class: 'h1' }, 'Economic calendar'), h('p', { class: 'lead' }, `Times shown in your local time zone. F = forecast, P = previous.`),
      h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '8px' } },
        h('div', { class: 'seg' }, [['this', 'This week'], ['next', 'Next week']].map(([k, l]) => h('button', { 'aria-pressed': String(week === k), onclick: () => { week = k; data = null; render(); load(); } }, l))),
        h('div', { class: 'seg' }, ['all', 'high', 'medium', 'low'].map(k => h('button', { 'aria-pressed': String(impact === k), onclick: () => { impact = k; render(); } }, k === 'all' ? 'All impact' : k[0].toUpperCase() + k.slice(1)))),
        h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Currency', onchange: e => { ccy = e.target.value; render(); } }, ccys.map(c => h('option', { value: c, selected: c === ccy }, c === 'all' ? 'All currencies' : c)))),
      body);
  };
  async function load() { try { err = null; data = (await api.calendar(week)).events; } catch (e) { err = e.message; } render(); }
  hooks.onCalendar = () => { render(); if (!data) load(); };
}

// ---------------- account ----------------
export function mountAccount() {
  let deals = null, dealsErr = null;
  const render = () => {
    if (!isBroker()) { page('account', h('div', { class: 'h1' }, 'Account'), h('p', { class: 'lead' }, 'Balance, margin and performance for your connected MetaTrader account.'), lock('Account data'), accountsCard()); return; }
    const a = S.account, c = a?.currency || 'USD', open = S.positions.reduce((s, p) => s + p.profit, 0);
    const kpi = (k, v, extra) => h('div', { class: 'card kpi' }, h('div', { class: 'v ' + (extra || '') }, v), h('div', { class: 'k' }, k));
    const closed = (deals || []).filter(d => d.kind === 'deal' && d.entry !== 'in');
    const wins = closed.filter(d => d.profit > 0), loss = closed.filter(d => d.profit < 0);
    const gp = wins.reduce((s, d) => s + d.profit, 0), gl = Math.abs(loss.reduce((s, d) => s + d.profit, 0));
    const canvas = h('canvas', { class: 'eq-canvas', 'aria-label': 'Balance curve over the last 90 days' });
    page('account', h('div', { class: 'h1' }, a?.name || 'Account'), h('p', { class: 'lead' }, a ? `${a.broker || active()?.broker || ''} · ${a.server} · #${a.login} · ${a.platform.toUpperCase()} · 1:${a.leverage || '—'}` : 'Loading…'),
      h('div', { class: 'grid' }, kpi('Balance', money(a?.balance, c)), kpi('Equity', money(a?.equity, c)), kpi('Open P/L', signed(open) + ' ' + c, cls(open)), kpi('Free margin', money(a?.freeMargin, c)), kpi('Margin level', a?.marginLevel ? a.marginLevel.toFixed(0) + '%' : '—')),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'card' }, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('b', { class: 'grow' }, 'Balance, last 90 days'), h('span', { class: 'hint' }, 'From your broker’s deal history')), dealsErr ? h('div', { class: 'err' }, dealsErr) : canvas,
        deals && !closed.length ? h('p', { class: 'hint' }, 'No closed trades in this period yet.') : null),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'grid' }, kpi('Closed trades (90d)', closed.length), kpi('Win rate', closed.length ? (wins.length / closed.length * 100).toFixed(0) + '%' : '—'), kpi('Profit factor', gl ? (gp / gl).toFixed(2) : (gp ? '∞' : '—')),
        kpi('Best trade', wins.length ? signed(Math.max(...wins.map(d => d.profit))) : '—', 'up'), kpi('Worst trade', loss.length ? signed(Math.min(...loss.map(d => d.profit))) : '—', 'down')),
      h('div', { style: { height: '14px' } }), accountsCard());
    if (deals) drawBalance(canvas, deals, a?.balance || 0);
  };
  function accountsCard() {
    return h('div', { class: 'card' }, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('b', { class: 'grow' }, 'Linked accounts'), h('button', { class: 'btn sm primary', onclick: () => hooks.openConnect() }, icon('plus', 14), 'Add account')),
      S.accounts.length ? S.accounts.map(acc => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, acc.label), h('div', { class: 'd' }, `${acc.server} · ${acc.platform.toUpperCase()}${acc.id === S.activeId ? ' · active' : ''}`)),
        acc.id === S.activeId ? h('button', { class: 'btn sm danger', onclick: () => hooks.disconnect(acc.id) }, icon('logout', 14), 'Disconnect') : [h('button', { class: 'btn sm', onclick: () => hooks.switchAccount(acc.id) }, 'Switch'), h('button', { class: 'btn sm danger', onclick: () => hooks.disconnect(acc.id) }, 'Remove')]))
        : h('p', { class: 'hint' }, 'No accounts linked. Prices and charts still work without one.'));
  }
  async function load() {
    if (!isBroker()) { render(); return; }
    deals = null; dealsErr = null; render();
    try { deals = (await api.history(90)).deals; } catch (e) { dealsErr = e.message; }
    render();
  }
  function drawBalance(cv, ds, bal) {
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const ev = ds.filter(d => d.time).slice().sort((a, b) => a.time - b.time);
    const net = ev.reduce((s, d) => s + d.profit + (d.swap || 0) + (d.commission || 0), 0);
    let v = bal - net; const pts = [{ t: (ev[0]?.time || Date.now() / 1000) - 1, v }];
    ev.forEach(d => { v += d.profit + (d.swap || 0) + (d.commission || 0); pts.push({ t: d.time, v }); });
    pts.push({ t: Date.now() / 1000, v });
    const W = r.width, H = r.height, lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)), span = hi - lo || 1, t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const X = t => 8 + (t - t0) / ((t1 - t0) || 1) * (W - 16), Y = val => H - 18 - (val - lo) / span * (H - 36);
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, H - 8.5); ctx.lineTo(W, H - 8.5); ctx.stroke();
    ctx.beginPath(); pts.forEach((p, i) => { const x = X(p.t), y = i ? Y(p.v) : Y(p.v); if (i) { ctx.lineTo(x, Y(pts[i - 1].v)); ctx.lineTo(x, y); } else ctx.moveTo(x, y); });
    ctx.strokeStyle = css('--brand'); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = css('--mute'); ctx.font = '11px system-ui'; ctx.fillText(money(hi, S.account?.currency), 8, 12); ctx.fillText(money(lo, S.account?.currency), 8, H - 12);
  }
  hooks.onAccount = load;
  on('snapshot', () => { if (document.body.dataset.screen === 'account') render(); });
  on('mode', () => { deals = null; });
}

// ---------------- strategies ----------------
export function mountStrategies() {
  let strat = TEMPLATES.ema_cross(), result = null, running = false, watching = false, log = store.get('signalLog', []), watchTimer = null, lastBar = null;
  const opts = { bars: 1000, balance: 10000, spread: 0, contract: null };
  const render = () => {
    const i = inst(S.symbol) || {}, cs = opts.contract ?? i.contractSize ?? guessContract(S.symbol);
    const xml = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Strategy XML' }); xml.value = toXML(strat);
    const msg = h('div', { class: 'err' });
    const num = (key, label, step = 1) => h('div', { class: 'field' }, h('label', {}, label), h('input', { class: 'input', type: 'number', step, value: key === 'contract' ? cs : opts[key], onchange: e => { opts[key] = parseFloat(e.target.value); } }));
    const file = h('input', { type: 'file', accept: '.xml,text/xml', class: 'hide', onchange: async e => { const f = e.target.files[0]; if (!f) return; try { strat = fromXML(await f.text()); result = null; render(); toast('Strategy imported: ' + strat.name, 'ok'); } catch (er) { toast(er.message, 'error'); } } });
    page('strategies', h('div', { class: 'h1' }, 'Strategy lab'), h('p', { class: 'lead' }, 'Test a rule-based strategy on real price history, then watch it for live signals. Nothing here places trades for you.'),
      h('div', { class: 'card stack' },
        h('div', { class: 'lbl' }, 'Start from a template or import your own XML'),
        h('div', { class: 'chips' }, Object.entries(TEMPLATES).map(([k, f]) => h('button', { class: 'chip', onclick: () => { strat = f(); result = null; render(); } }, f().name)), h('button', { class: 'chip', onclick: () => file.click() }, icon('upload', 12), ' Import XML'), file),
        xml, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { try { strat = fromXML(xml.value); msg.textContent = ''; result = null; toast('Rules applied', 'ok'); render(); } catch (e) { msg.textContent = e.message; } } }, 'Apply changes'),
          h('button', { class: 'btn sm', onclick: () => download(strat.name.replace(/\W+/g, '_') + '.xml', xml.value) }, icon('download', 14), 'Export XML')), msg,
        h('p', { class: 'hint' }, 'Operands: ema:21, sma:50, rsi:14, macd:hist, bb:upper:20:2, close, or a number. Rules: <cross a b dir="above|below"/> and <compare a op="gt|lt" b/>. Entries fill at the next bar’s open; stops win ties.')),
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, `Test on ${S.symbol} · ${strat.timeframe}`), h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Timeframe', onchange: e => { strat.timeframe = e.target.value; render(); } }, TFS.map(t => h('option', { selected: t === strat.timeframe }, t)))),
        h('div', { class: 'two' }, num('bars', 'Bars to test (max 5000)', 100), num('balance', 'Starting balance', 100)), h('div', { class: 'two' }, num('spread', 'Spread (price units)', 'any'), num('contract', 'Contract size')),
        h('button', { class: 'btn primary', id: 'btRun', disabled: running, onclick: run }, running ? 'Testing…' : 'Run backtest')),
      result ? resultCard() : null,
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, 'Live signal watch'), h('div', { class: 'hint' }, 'Checks each newly closed bar on the chart symbol and timeframe.')),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: watching, 'aria-label': 'Watch live signals', onchange: e => toggleWatch(e.target.checked) }), h('i'))),
        log.length ? log.slice(0, 8).map(l => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${l.side.toUpperCase()} signal · ${l.symbol} ${l.tf}`), h('div', { class: 'd' }, `${l.name} · ${dt(l.time)}`)), isBroker() ? h('button', { class: 'btn sm', onclick: () => { hooks.setSymbol(l.symbol); hooks.openTicket({ side: l.side }); } }, 'Open ticket') : null)) : h('p', { class: 'hint' }, 'No signals yet.')));
  };
  const guessContract = s => { const c = inst(s)?.cat || ''; return /forex/i.test(c) ? 100000 : /metal/i.test(c) ? 100 : 1; };
  const download = (name, text) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/xml' })), download: name }); document.body.append(a); a.click(); a.remove(); };

  async function fetchBars(n) {
    let all = await candles(S.symbol, strat.timeframe, Math.min(n, 1000));
    while (isBroker() && all.length < n && all.length) {
      const more = await candles(S.symbol, strat.timeframe, Math.min(1000, n - all.length), all[0].t);
      if (!more.length) break; all = more.concat(all);
    }
    return all;
  }
  async function run() {
    const errs = validate(strat); if (errs.length) { toast(errs[0], 'error'); return; }
    running = true; render();
    try {
      const n = Math.max(100, Math.min(5000, Math.round(opts.bars) || 1000));
      const cs = await fetchBars(n);
      if (cs.length < 60) throw new Error('Not enough price history for this symbol and timeframe.');
      const i = inst(S.symbol) || {};
      const r = backtest(strat, cs, { balance: opts.balance, spread: opts.spread || 0, contractSize: opts.contract ?? i.contractSize ?? guessContract(S.symbol) });
      result = { ...r, bars: cs.length, from: cs[0].t, to: cs[cs.length - 1].t, symbol: S.symbol, tf: strat.timeframe, balance: opts.balance };
    } catch (e) { toast(e.message, 'error'); }
    running = false; render();
    if (result) drawEquity();
  }
  function resultCard() {
    const s = result.stats, c = S.account?.currency || 'quote ccy';
    const k = (l, v, x) => h('div', { class: 'kpi' }, h('div', { class: 'v ' + (x || '') }, v), h('div', { class: 'k' }, l));
    return h('div', { class: 'card stack', style: { marginTop: '12px' } },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, `Result · ${result.bars} bars of ${result.symbol} ${result.tf}`), h('button', { class: 'btn sm', onclick: () => { hooks.markers = result.trades.flatMap(t => [{ t: t.entryT, side: t.side === 'long' ? 'buy' : 'sell' }, { t: t.exitT, side: t.side === 'long' ? 'sell' : 'buy', color: 'var(--mute)' }]); emit('markers'); hooks.showScreen('chart'); toast('Trades marked on the chart'); } }, 'Show on chart')),
      h('p', { class: 'hint' }, `${dt(result.from)} → ${dt(result.to)}. Profit is in the symbol’s quote currency (${c}), before swaps and commissions.`),
      h('div', { class: 'grid' }, k('Net profit', signed(s.net), cls(s.net)), k('Return', signed(s.returnPct) + '%', cls(s.returnPct)), k('Trades', s.trades), k('Win rate', s.winRate.toFixed(1) + '%'), k('Profit factor', Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'), k('Max drawdown', s.maxDrawdownPct.toFixed(2) + '%', 'down'), k('Avg win / loss', `${s.avgWin.toFixed(2)} / ${s.avgLoss.toFixed(2)}`), k('Worst losing streak', s.worstLosingStreak)),
      h('canvas', { class: 'eq-canvas', id: 'eqCanvas', 'aria-label': 'Equity curve' }),
      s.trades < 30 ? h('p', { class: 'hint' }, 'Fewer than 30 trades is too few to trust these numbers. Test more bars or another symbol.') : null,
      h('div', { class: 'table-wrap', style: { maxHeight: '260px' } }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Side', 'Entry', 'Exit', 'Reason', 'Bars', 'P/L'].map((t, i) => h('th', { class: i > 3 ? 'r' : '' }, t)))),
        h('tbody', {}, result.trades.slice(-100).reverse().map(t => h('tr', {}, h('td', {}, h('span', { class: 'pill ' + (t.side === 'long' ? 'buy' : 'sell') }, t.side)), h('td', {}, dt(t.entryT)), h('td', {}, dt(t.exitT)), h('td', {}, t.reason), h('td', { class: 'r' }, t.bars), h('td', { class: 'r ' + cls(t.pnl) }, signed(t.pnl))))))));
  }
  function drawEquity() {
    const cv = document.getElementById('eqCanvas'); if (!cv || !result) return;
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const pts = result.equity, W = r.width, H = r.height, lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)), span = hi - lo || 1;
    const X = i => 8 + i / Math.max(1, pts.length - 1) * (W - 16), Y = v => H - 18 - (v - lo) / span * (H - 36);
    ctx.strokeStyle = css('--line'); ctx.beginPath(); const y0 = Y(result.balance); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))); ctx.strokeStyle = result.stats.net >= 0 ? css('--up') : css('--down'); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = css('--mute'); ctx.font = '11px system-ui'; ctx.fillText(hi.toFixed(2), 8, 12); ctx.fillText(lo.toFixed(2), 8, H - 6);
  }

  async function toggleWatch(on_) {
    watching = on_; clearInterval(watchTimer); lastBar = null;
    if (!on_) { toast('Signal watch off'); return; }
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    const check = async () => {
      if (document.hidden) return;
      try {
        const cs = await candles(S.symbol, strat.timeframe, 400); if (cs.length < 60) return;
        const closed = cs.slice(0, -1), bar = closed[closed.length - 1].t;
        if (lastBar === null) { lastBar = bar; return; }
        if (bar === lastBar) return; lastBar = bar;
        const sig = signalAt(strat, closed, closed.length - 1);
        const side = sig.enterLong ? 'buy' : sig.enterShort ? 'sell' : null; if (!side) return;
        const entry = { side, symbol: S.symbol, tf: strat.timeframe, name: strat.name, time: Date.now() / 1000 };
        log.unshift(entry); log = log.slice(0, 50); store.set('signalLog', log);
        toast(`${side.toUpperCase()} signal: ${S.symbol} ${strat.timeframe} (${strat.name})`, 'ok');
        if ('Notification' in window && Notification.permission === 'granted') new Notification(`KanAIRY ${side.toUpperCase()} signal`, { body: `${S.symbol} ${strat.timeframe} · ${strat.name}` });
        if (document.body.dataset.screen === 'strategies') render();
      } catch { /* retry next tick */ }
    };
    watchTimer = setInterval(check, Math.max(10000, Math.min(60000, TF_SEC[strat.timeframe] * 250)));
    check(); toast(`Watching ${S.symbol} ${strat.timeframe}`, 'ok');
  }
  hooks.onStrategies = render;
  on('theme', () => { if (result && document.body.dataset.screen === 'strategies') drawEquity(); });
}

// ---------------- static pages ----------------
export function mountLearn() {
  const sec = (t, ...ps) => h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', { style: { marginBottom: '8px' } }, t), ...ps);
  const ul = items => h('ul', { style: { paddingLeft: '20px', color: 'var(--mute)' } }, items.map(i => h('li', { style: { marginBottom: '5px' } }, i)));
  page('learn', h('div', { class: 'h1' }, 'Learn trading'), h('p', { class: 'lead' }, 'The essentials, kept short. Practise on a demo account before risking real money.'),
    sec('How forex works', h('p', { class: 'mute' }, 'You buy one currency while selling another, so every price is a pair such as EUR/USD. The price tells you how much of the second currency one unit of the first costs.'),
      ul(['Pip: the usual unit of price movement (0.0001 for most pairs, 0.01 for JPY pairs).', 'Lot: trade size. 1.00 lot is 100,000 units of the base currency; 0.01 is a micro lot.', 'Spread: the gap between bid (you sell) and ask (you buy). It is your entry cost.', 'Leverage: lets you control a larger position with less margin, and magnifies losses as much as gains.', 'Margin: the funds your broker sets aside to keep a position open.'])),
    sec('Reading the chart', ul(['Candles show open, high, low and close for each period. Green/blue closed higher, red/orange lower (you can change the palette in Settings).', 'Moving averages smooth price. When a fast one crosses a slow one, the trend may be changing.', 'RSI above 70 or below 30 hints at stretched moves, but strong trends can stay stretched.', 'MACD tracks momentum; Bollinger Bands show how wide the recent range is; ATR measures typical movement and is a good basis for stop distances.', 'Support and resistance are price levels the market has reacted to before. Draw them with the horizontal line tool.'])),
    sec('Protecting your account', ul(['Risk a small fixed share of the balance per trade (1–2% is a common rule).', 'Set a stop loss before you enter. The ticket shows the money you risk at that stop.', 'Aim for a reward bigger than the risk, but remember win rate matters as much as the ratio.', 'Check the economic calendar. High-impact releases can move price hundreds of pips in seconds and widen spreads.', 'Keep a journal. The History tab shows every deal your broker recorded.'])),
    sec('Position size formula', h('p', { class: 'mute' }, 'Lots = (balance × risk %) ÷ (stop distance in price × contract size). Example: 10,000 balance, 1% risk, 0.0020 stop on EUR/USD (contract size 100,000) → 100 ÷ 200 = 0.50 lots.')),
    sec('Honest expectations', h('p', { class: 'mute' }, 'Most retail traders lose money. Leverage, costs and emotion are the usual reasons. No indicator, robot or strategy removes that risk, and a backtest only shows what would have happened in the past.')));
}

export function mountAbout() {
  page('about', h('div', { class: 'h1' }, 'About KanAIRY'), h('p', { class: 'lead' }, 'A MetaTrader terminal that runs in your browser or on your phone.'),
    h('div', { class: 'card prose' },
      h('h3', {}, 'What it does'), h('ul', {}, ['Connects to any MetaTrader 4 or 5 broker through MetaApi, the same servers your desktop terminal uses.', 'Shows live prices, candlestick charts in nine timeframes, 25+ indicators and drawing tools.', 'Places market, limit, stop and stop-limit orders with stop loss and take profit, and lets you drag those levels on the chart.', 'Tracks open positions, pending orders, history and account balance.', 'Streams market news and the economic calendar from public sources.', 'Tests rule-based strategies on real price history in the Strategy lab.']),
      h('h3', {}, 'How your login is handled'), h('p', {}, 'Your broker password is sent once to MetaApi to link the account and is not stored by KanAIRY. The app keeps a signed session token in this browser, which you can remove any time with Disconnect.'),
      h('h3', {}, 'Where prices come from'), h('p', {}, 'With a broker connected, prices and candles come from that broker’s own feed. Without one, the app shows delayed public market data so you can look around first. Public futures-based prices for gold, oil and indices can differ from your broker’s spot prices.'),
      h('h3', {}, 'Risk warning'), h('p', {}, 'Trading leveraged products carries a high risk of losing money. KanAIRY is a tool, not financial advice, and makes no promise of profit.')));
}

export function mountDeveloper() {
  page('developer', h('div', { class: 'h1' }, 'About the developer'), h('p', { class: 'lead' }, 'Thakgalo Matlala · Soshanguve, Pretoria, South Africa'),
    h('div', { class: 'card prose' }, h('p', {}, 'Thakgalo is a self-taught programmer and trader who started with forex at 13. He built KanAIRY to make a capable trading terminal available to anyone with a phone.'),
      h('p', {}, 'He plans to keep growing the platform, study computer science and finance, and mentor other young people in South Africa who are interested in trading and technology.')));
}

export function mountAssistant() {
  const v = document.getElementById('view-assistant');
  hooks.onAssistant = () => { if (!v.firstChild) v.append(h('iframe', { src: 'https://helpful-taiyaki-620c2c.netlify.app/', title: 'KanAIRY AI assistant', allow: 'clipboard-write', referrerpolicy: 'no-referrer' })); };
}

// ---------------- settings ----------------
export function mountSettings() {
  const render = () => {
    const set = (k, v) => { S.settings[k] = v; persist(); emit('settings'); };
    const row = (t, d, control) => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, t), d ? h('div', { class: 'd' }, d) : null), control);
    const toggle = (k) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!S.settings[k], 'aria-label': k, onchange: e => set(k, e.target.checked) }), h('i'));
    page('settings', h('div', { class: 'h1' }, 'Settings'), h('p', { class: 'lead' }, 'Saved on this device.'),
      h('div', { class: 'card' },
        row('Theme', 'Dark suits low light; light suits daylight.', h('div', { class: 'seg' }, ['dark', 'light'].map(t => h('button', { 'aria-pressed': String(S.settings.theme === t), onclick: () => { set('theme', t); render(); } }, t[0].toUpperCase() + t.slice(1))))),
        row('Colour-blind palette', 'Uses blue and orange instead of green and red.', toggle('colorblind')),
        row('Confirm orders', 'Show a summary before every order is sent. Turning this off sends orders immediately.', toggle('confirmOrders')),
        row('Default volume', 'Lots pre-filled in the order ticket.', h('input', { class: 'input', style: { width: '90px' }, type: 'number', step: '0.01', min: '0.01', value: S.settings.defaultVolume, onchange: e => set('defaultVolume', Math.max(0.01, parseFloat(e.target.value) || 0.01)) })),
        row('Alerts and signals', 'Allow browser notifications for price alerts and strategy signals.', h('button', { class: 'btn sm', onclick: async () => { if (!('Notification' in window)) { toast('This browser does not support notifications.', 'error'); return; } const r = await Notification.requestPermission(); toast('Notifications ' + r); } }, 'Enable'))),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'card' }, row('Clear local data', 'Removes linked accounts, favourites, drawings, alerts and settings from this device. Your broker account is not affected.',
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmSheet({ title: 'Clear local data', message: 'This signs you out and removes everything KanAIRY saved on this device.', okText: 'Clear everything', danger: true })) { Object.keys(localStorage).filter(k => k.startsWith('kanairy.')).forEach(k => localStorage.removeItem(k)); location.reload(); } } }, 'Clear'))));
  };
  hooks.onSettings = render;
}

// ---------------- alerts sheet ----------------
export function openAlerts() {
  const body = h('div', { class: 'stack' }); const s = openSheet({ title: 'Price alerts', body });
  const draw = () => {
    clear(body);
    if (!S.alerts.length) { body.append(h('div', { class: 'empty' }, h('b', {}, 'No alerts'), 'Right-click (or long-press) a price on the chart and choose “Price alert”, or use the Alert button above the chart.')); return; }
    S.alerts.slice().reverse().forEach(a => body.append(h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${a.symbol} ${a.dir === 'above' ? '≥' : '≤'} ${a.price}`), h('div', { class: 'd' }, a.fired ? `Triggered ${ago(a.firedAt / 1000)}` : 'Waiting')),
      h('button', { class: 'btn sm danger', 'aria-label': 'Delete alert', onclick: () => { S.alerts = S.alerts.filter(x => x.id !== a.id); persist(); emit('alerts'); draw(); } }, icon('trash', 14)))));
  };
  draw(); return s;
}
void digitsOf;

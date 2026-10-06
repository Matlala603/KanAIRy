// Market watch + chart panel.
import { h, icon, clear, $, toast, signed, cls, arrow, num } from './util.js';
import { S, on, emit, inst, digitsOf, favorites, toggleFavorite, isBroker, persist, TFS, TF_SEC, drawingsFor, saveDrawings } from './state.js';
import { candles, dayChange, refreshNow } from './market.js';
import { Chart, DRAW_TOOLS } from './chart.js';
import { REGISTRY, GROUPS, PALETTE, defaults } from './indicators.js';
import { openSheet, contextMenu, promptSheet, confirmSheet } from './ui.js';
import { api } from './api.js';

export const hooks = { showScreen: () => {}, openTicket: () => {}, openConnect: () => {}, markers: [] };

const fmt = (v, d) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

// ---------------- symbol picker ----------------
export function pickSymbol(onPick) {
  const input = h('input', { type: 'search', placeholder: 'Search symbols…', 'aria-label': 'Search symbols' });
  const list = h('div', { class: 'scroll', style: { maxHeight: '55vh' } });
  const cats = ['All', ...new Set(S.instruments.map(i => i.cat))];
  let cat = 'All';
  const tabs = h('div', { class: 'tabs', style: { padding: '0 0 8px' } }, cats.map(c => h('button', { class: 'tab' + (c === cat ? ' on' : ''), onclick: e => { cat = c; tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === e.currentTarget)); draw(); } }, c)));
  const draw = () => {
    const q = input.value.trim().toLowerCase(); clear(list);
    const rows = S.instruments.filter(i => (cat === 'All' || i.cat === cat) && (!q || (i.symbol + ' ' + i.name).toLowerCase().includes(q))).slice(0, 120);
    if (!rows.length) list.append(h('div', { class: 'empty' }, h('b', {}, 'No symbols'), 'Try a different search or category.'));
    rows.forEach(i => list.append(h('button', { class: 'bk-card', style: { marginBottom: '6px' }, onclick: () => { sheet.close(); onPick(i.symbol); } },
      h('div', { class: 'grow' }, h('div', { class: 'n' }, i.symbol), h('div', { class: 'c' }, i.name)), h('span', { class: 'tag mute' }, i.cat))));
  };
  input.addEventListener('input', draw);
  const sheet = openSheet({ title: 'Symbols', body: h('div', {}, h('div', { class: 'search', style: { margin: '0 0 8px' } }, icon('search', 16), input), tabs, list) });
  draw();
}

// ---------------- market watch ----------------
export function mountWatchlist(root) {
  const input = h('input', { type: 'search', placeholder: 'Search symbols', 'aria-label': 'Search symbols' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const head = h('div', { class: 'qhead' }, h('span'), h('span', {}, 'Symbol'), h('span', {}, isBroker() ? 'Bid' : 'Price'), h('span', {}, isBroker() ? 'Ask' : ''), h('span', {}, 'Day'));
  const list = h('div', { class: 'scroll' });
  const rows = new Map();
  clear(root).append(h('div', { class: 'panel-head' }, 'Market watch', h('span', { class: 'sub', id: 'wlCount' })), h('div', { class: 'search' }, icon('search', 16), input), tabs, head, list);

  function drawTabs() {
    const cats = ['Favorites', ...[...new Set(S.instruments.map(i => i.cat))]];
    clear(tabs).append(...cats.map(c => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(c === S.catFilter), onclick: () => { S.catFilter = c; drawTabs(); drawList(); emit('watch'); } }, c)));
    head.children[2].textContent = isBroker() ? 'Bid' : 'Price'; head.children[3].textContent = isBroker() ? 'Ask' : '';
  }
  function visible() {
    const q = input.value.trim().toLowerCase();
    if (q) return S.instruments.filter(i => (i.symbol + ' ' + i.name).toLowerCase().includes(q));
    if (S.catFilter === 'Favorites') { const f = favorites(); return f.map(inst).filter(Boolean); }
    return S.instruments.filter(i => i.cat === S.catFilter);
  }
  function drawList() {
    S.query = input.value.trim();
    clear(list); rows.clear();
    const items = visible();
    $('#wlCount', root).textContent = items.length ? `${items.length}` : '';
    if (!S.instruments.length) { for (let i = 0; i < 8; i++) list.append(h('div', { class: 'skeleton', style: { margin: '8px 12px', height: '44px' } })); return; }
    if (!items.length) {
      list.append(h('div', { class: 'empty' }, h('b', {}, S.catFilter === 'Favorites' && !S.query ? 'No favourites yet' : 'Nothing found'),
        S.catFilter === 'Favorites' && !S.query ? 'Open a category and tap the star on any symbol to pin it here.' : 'Try another search or category.'));
      return;
    }
    items.slice(0, 250).forEach(i => {
      const fav = favorites().includes(i.symbol);
      const row = h('div', { class: 'qrow' + (i.symbol === S.symbol ? ' sel' : ''), role: 'button', tabindex: '0', dataset: { sym: i.symbol },
        onclick: () => { selectSymbol(i.symbol); hooks.showScreen('chart'); }, onkeydown: e => { if (e.key === 'Enter') row.click(); } },
        h('button', { class: 'star' + (fav ? ' on' : ''), 'aria-label': fav ? 'Remove from favourites' : 'Add to favourites', onclick: e => { e.stopPropagation(); toggleFavorite(i.symbol); drawList(); } }, icon('star', 15)),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'sym' }, i.symbol), h('div', { class: 'desc' }, i.name)),
        h('div', { class: 'px', dataset: { f: 'bid' } }, '—'), h('div', { class: 'px', dataset: { f: 'ask' } }, '—'), h('div', { class: 'chg', dataset: { f: 'chg' } }, '—'));
      rows.set(i.symbol, row); list.append(row); paint(i.symbol);
    });
  }
  function paint(sym) {
    const row = rows.get(sym), q = S.quotes[sym]; if (!row || !q) return;
    const d = digitsOf(sym), bid = row.querySelector('[data-f=bid]'), ask = row.querySelector('[data-f=ask]'), chg = row.querySelector('[data-f=chg]');
    const nb = fmt(q.bid, d);
    if (bid.textContent !== nb) { if (bid.textContent !== '—') { bid.classList.remove('flash-up', 'flash-down'); void bid.offsetWidth; bid.classList.add(q.dir >= 0 ? 'flash-up' : 'flash-down'); } bid.textContent = nb; }
    bid.className = 'px ' + (q.dir > 0 ? 'up' : q.dir < 0 ? 'down' : '') + (bid.classList.contains('flash-up') ? ' flash-up' : bid.classList.contains('flash-down') ? ' flash-down' : '');
    ask.textContent = isBroker() ? fmt(q.ask, d) : '';
    const dc = dayChange(sym);
    chg.textContent = dc ? `${dc.pct >= 0 ? '+' : '−'}${Math.abs(dc.pct).toFixed(2)}%` : '—'; chg.className = 'chg ' + (dc ? cls(dc.pct) : '');
  }
  input.addEventListener('input', () => { drawList(); emit('watch'); });
  on('quotes', () => rows.forEach((_, s) => paint(s)));
  on('instruments', () => { if (!favorites().length && isBroker()) S.catFilter = S.instruments[0] ? S.instruments[0].cat : 'Favorites'; drawTabs(); drawList(); });
  on('favorites', drawList);
  on('mode', () => { S.catFilter = isBroker() && !favorites().length ? (S.instruments[0]?.cat || 'Favorites') : 'Favorites'; drawTabs(); drawList(); });
  on('symbol', () => rows.forEach((row, s) => row.classList.toggle('sel', s === S.symbol)));
  drawTabs(); drawList();
}

export function selectSymbol(sym) {
  if (!sym) return;
  S.symbol = sym; persist(); emit('symbol', sym);
}

// ---------------- chart panel ----------------
export function mountChart(root) {
  let chart = null, loadCtl = null, tailTimer = null, loadId = 0, draftTool = null;
  const symBtn = h('button', { class: 'sym-btn', onclick: () => pickSymbol(selectSymbol), 'aria-label': 'Change symbol' }, h('div', {}, h('div', { class: 's' }), h('div', { class: 'd' })), icon('swap', 15));
  const px = h('div', { class: 'bigpx' }, '—'), chg = h('div', { class: 'bigchg mute' }, '');
  const tfSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Timeframe' }, TFS.map(t => h('button', { 'aria-pressed': String(t === S.tf), onclick: () => setTf(t) }, t)));
  const typeBtn = h('button', { class: 'tbtn', onclick: e => typeMenu(e) }, icon('chart', 16), h('span', { class: 'lbl-type' }, 'Candles'));
  const indBtn = h('button', { class: 'tbtn', onclick: openIndicators }, icon('indicator', 16), 'Indicators');
  const drawBtn = h('button', { class: 'tbtn', onclick: e => drawMenu(e) }, icon('draw', 16), 'Draw');
  const alertBtn = h('button', { class: 'tbtn', onclick: () => addAlert() }, icon('bell', 16), 'Alert');
  const wrap = h('div', { class: 'chart-wrap' });
  const msg = h('div', { class: 'empty hide', style: { position: 'absolute', inset: '0', display: 'grid', placeContent: 'center', zIndex: 4, background: 'var(--chart-bg)' } });
  const sellBtn = h('button', { class: 'qbtn sell', onclick: () => hooks.openTicket({ side: 'sell' }) }, 'Sell', h('small', {}, '—'));
  const buyBtn = h('button', { class: 'qbtn buy', onclick: () => hooks.openTicket({ side: 'buy' }) }, 'Buy', h('small', {}, '—'));
  const quick = h('div', { class: 'chart-quick' }, sellBtn, buyBtn);
  const latest = h('button', { class: 'fab hide', onclick: () => chart.goLatest() }, 'Latest ›');
  wrap.append(msg, quick, h('div', { class: 'chart-fab' }, latest));
  clear(root).append(h('div', { class: 'chart-top' }, symBtn, h('div', {}, px, chg), h('div', { class: 'tools' }, tfSeg, typeBtn, indBtn, drawBtn, alertBtn)), wrap);

  const TYPES = [['candles', 'Candles'], ['hollow', 'Hollow candles'], ['heikin', 'Heikin-Ashi'], ['bars', 'OHLC bars'], ['line', 'Line'], ['area', 'Area']];
  const typeLabel = () => TYPES.find(t => t[0] === S.chartType)?.[1] || 'Candles';
  function typeMenu(e) { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, 'Chart type', TYPES.map(([k, l]) => ({ label: (S.chartType === k ? '✓ ' : '   ') + l, run: () => { S.chartType = k; persist(); chart.setType(k); typeBtn.querySelector('.lbl-type').textContent = l; } }))); }

  function drawMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, 'Drawing tools', [
      ...Object.entries(DRAW_TOOLS).map(([k, t]) => ({ label: t.name, run: () => { chart.setTool(k); draftTool = k; drawBtn.classList.add('on'); toast(t.pts === 1 ? 'Tap the chart to place it.' : 'Drag on the chart to draw. Esc cancels.'); } })),
      { label: 'Delete selected', run: () => { if (!chart.deleteSelected()) toast('Tap a drawing to select it first.'); } },
      { label: 'Clear all drawings', run: async () => { if (await confirmSheet({ title: 'Clear drawings', message: `Remove every drawing on ${S.symbol}?`, okText: 'Clear all', danger: true })) chart.clearDrawings(); } },
    ]);
  }

  function ensureChart() {
    if (chart) return chart;
    chart = new Chart(wrap, {
      drawColor: null,
      onNeedMore: loadOlder,
      onDrawingsChange: list => saveDrawings(S.symbol, list),
      onToolChange: () => { draftTool = null; drawBtn.classList.remove('on'); },
      onTextRequest: cb => promptSheet({ title: 'Add text', label: 'Label', okText: 'Add' }).then(v => cb(v && v.trim())),
      onIndicator: (uid, act) => { if (act === 'remove') removeIndicator(uid); else editIndicator(uid); },
      onLevelDrag: handleLevelDrag,
      onContext: handleContext,
      onCrosshair: () => latest.classList.toggle('hide', chart.isAtEnd()),
    });
    chart.setType(S.chartType); applyIndicators();
    new MutationObserver(() => chart.refreshTheme()).observe(document.documentElement, { attributes: true });
    wrap.addEventListener('pointerup', () => setTimeout(() => latest.classList.toggle('hide', chart.isAtEnd()), 60));
    wrap.addEventListener('wheel', () => setTimeout(() => latest.classList.toggle('hide', chart.isAtEnd()), 60), { passive: true });
    return chart;
  }

  function header() {
    const i = inst(S.symbol);
    symBtn.querySelector('.s').textContent = S.symbol; symBtn.querySelector('.d').textContent = i?.name || '';
    tfSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.textContent === S.tf)));
    typeBtn.querySelector('.lbl-type').textContent = typeLabel();
  }
  function setTf(t) { S.tf = t; persist(); header(); load(); }

  function paintPrice() {
    const q = S.quotes[S.symbol], d = digitsOf(S.symbol);
    if (!q) return;
    px.textContent = fmt(q.bid, d); px.className = 'bigpx ' + (q.dir > 0 ? 'up' : q.dir < 0 ? 'down' : '');
    const dc = dayChange(S.symbol);
    chg.textContent = dc ? `${arrow(dc.abs)} ${signed(dc.abs, d)} (${signed(dc.pct)}%)` : (isBroker() ? '' : 'Public feed'); chg.className = 'bigchg ' + (dc ? cls(dc.abs) : 'mute');
    sellBtn.querySelector('small').textContent = fmt(q.bid, d); buyBtn.querySelector('small').textContent = isBroker() ? fmt(q.ask, d) : fmt(q.bid, d);
    quick.classList.toggle('hide', !isBroker());
  }

  async function load() {
    if (!S.instruments.length) return;
    ensureChart(); loadCtl?.abort(); loadCtl = new AbortController(); const id = ++loadId;
    clear(msg).classList.add('hide'); chart.setData([], {}); chart.opts.emptyText = 'Loading prices…';
    header();
    try {
      const cs = await candles(S.symbol, S.tf, isBroker() ? 500 : 800, null, loadCtl.signal);
      if (id !== loadId) return;
      if (!cs.length) throw new Error('No price history for this symbol and timeframe yet.');
      chart.setData(cs, { tfSeconds: TF_SEC[S.tf], digits: digitsOf(S.symbol) });
      chart.setDrawings(drawingsFor(S.symbol)); chart.setMarkers(hooks.markers);
      paintLevels(); paintQuote();
      clearInterval(tailTimer); tailTimer = setInterval(refreshTail, isBroker() ? 5000 : 12000);
    } catch (e) {
      if (e.name === 'AbortError' || id !== loadId) return;
      msg.classList.remove('hide'); clear(msg).append(h('b', {}, 'Chart unavailable'), h('div', { style: { margin: '4px 0 12px' } }, e.message), h('button', { class: 'btn sm', onclick: load }, 'Try again'));
    }
  }
  async function refreshTail() {
    if (document.hidden || !chart?.raw.length || $('body').dataset.group !== 'terminal') return;
    try { const cs = await candles(S.symbol, S.tf, 4); chart.mergeTail(cs.slice(-4)); } catch { /* next tick */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTail(); });
  async function loadOlder() {
    if (!isBroker() || !chart.raw.length) return;
    const id = loadId, first = chart.raw[0].t;
    try { const cs = await candles(S.symbol, S.tf, 500, first); if (id === loadId) chart.prependCandles(cs); } catch { /* ignore */ }
  }
  function paintQuote() { const q = S.quotes[S.symbol]; if (chart) chart.setQuote(isBroker() && q ? q.bid : null, q?.ask); }

  // ----- trade levels -----
  function paintLevels() {
    if (!chart) return;
    const lv = [], d = digitsOf(S.symbol);
    S.positions.filter(p => p.symbol === S.symbol).forEach(p => {
      const c = p.side === 'buy' ? 'var(--up)' : 'var(--down)';
      lv.push({ kind: 'position', id: p.id, price: p.openPrice, color: cssVar(p.side === 'buy' ? '--up' : '--down'), label: `${p.side.toUpperCase()} ${p.volume} · ${signed(p.profit)}` });
      if (p.stopLoss) lv.push({ kind: 'sl', pos: p, price: p.stopLoss, color: cssVar('--down'), label: `SL ${fmt(p.stopLoss, d)}`, draggable: true });
      if (p.takeProfit) lv.push({ kind: 'tp', pos: p, price: p.takeProfit, color: cssVar('--up'), label: `TP ${fmt(p.takeProfit, d)}`, draggable: true });
      void c;
    });
    S.orders.filter(o => o.symbol === S.symbol).forEach(o => lv.push({ kind: 'order', order: o, price: o.price, color: cssVar('--warn'), label: `${o.type.replace('_', ' ').toUpperCase()} ${o.volume}`, draggable: true }));
    S.alerts.filter(a => a.symbol === S.symbol && !a.fired).forEach(a => lv.push({ kind: 'alert', price: a.price, color: cssVar('--brand'), label: 'Alert' }));
    chart.setLevels(lv);
  }
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#3d8bff';

  async function handleLevelDrag(l, price) {
    const d = digitsOf(S.symbol), p = +price.toFixed(d), q = S.quotes[S.symbol];
    if (l.kind === 'sl' || l.kind === 'tp') {
      const pos = S.positions.find(x => x.id === l.pos.id), label = l.kind === 'sl' ? 'stop loss' : 'take profit';
      if (!pos) { toast('That position is no longer open.', 'error'); paintLevels(); return; }
      const ref = q ? (pos.side === 'buy' ? q.bid : q.ask) : pos.currentPrice;
      const wrongSide = l.kind === 'sl' ? (pos.side === 'buy' ? p >= ref : p <= ref) : (pos.side === 'buy' ? p <= ref : p >= ref);
      if (wrongSide) { toast(`A ${label} for a ${pos.side} must be ${(l.kind === 'sl') === (pos.side === 'buy') ? 'below' : 'above'} the current price.`, 'error'); paintLevels(); return; }
      const ok = await confirmSheet({ title: 'Move ' + label, message: `Move ${label} for ${pos.side.toUpperCase()} ${pos.symbol} (${pos.volume} lots) to ${p}?`, okText: 'Move' });
      if (!ok) { paintLevels(); return; }
      try { await api.modifyPosition(pos.id, l.kind === 'sl' ? { stopLoss: p } : { takeProfit: p }); toast('Updated ' + label, 'ok'); refreshNow(); }
      catch (e) { toast(e.message, 'error'); paintLevels(); }
    } else if (l.kind === 'order') {
      const o = S.orders.find(x => x.id === l.order.id);
      if (!o) { toast('That order is no longer pending.', 'error'); paintLevels(); return; }
      if (o.type === 'buy_stop_limit' || o.type === 'sell_stop_limit') { toast('Edit stop-limit orders from the Orders tab.', 'error'); paintLevels(); return; }
      const ok = await confirmSheet({ title: 'Move pending order', message: `Move ${o.type.replace('_', ' ')} ${o.symbol} to ${p}?`, okText: 'Move' });
      if (!ok) { paintLevels(); return; }
      try { await api.modifyOrder(o.id, { price: p }); toast('Order moved', 'ok'); refreshNow(); }
      catch (e) { toast(e.message, 'error'); paintLevels(); }
    }
  }

  function handleContext(c) {
    const d = digitsOf(S.symbol), p = +c.price.toFixed(d), q = S.quotes[S.symbol];
    const items = [];
    if (isBroker() && q) {
      const buyType = p < q.ask ? 'limit' : 'stop', sellType = p > q.bid ? 'limit' : 'stop';
      items.push({ label: `Buy ${buyType} at ${p}`, run: () => hooks.openTicket({ side: 'buy', type: buyType, price: p }) });
      items.push({ label: `Sell ${sellType} at ${p}`, run: () => hooks.openTicket({ side: 'sell', type: sellType, price: p }) });
    }
    items.push({ label: `Price alert at ${p}`, run: () => createAlert(p) });
    items.push({ label: `Horizontal line at ${p}`, run: () => { const list = drawingsFor(S.symbol); list.push({ id: Date.now(), tool: 'hline', pts: [{ t: c.time, p }] }); saveDrawings(S.symbol, list); chart.setDrawings(list); } });
    contextMenu(c.clientX, c.clientY, `${S.symbol} @ ${p}`, items);
  }

  function createAlert(price) {
    const q = S.quotes[S.symbol]; if (!q) { toast('Waiting for a live price.', 'error'); return; }
    S.alerts.push({ id: Date.now(), symbol: S.symbol, price, dir: price > q.bid ? 'above' : 'below', created: Date.now(), fired: false });
    persist(); emit('alerts'); paintLevels();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    toast(`Alert set: ${S.symbol} ${price > q.bid ? 'rises to' : 'falls to'} ${price}`, 'ok');
  }
  async function addAlert() {
    const q = S.quotes[S.symbol]; const d = digitsOf(S.symbol);
    const v = await promptSheet({ title: `Alert for ${S.symbol}`, label: `Notify me when price reaches (now ${q ? fmt(q.bid, d) : '—'})`, type: 'number', value: q ? fmt(q.bid, d) : '', okText: 'Set alert' });
    const n = num(v); if (v == null) return; if (!(n > 0)) { toast('Enter a valid price.', 'error'); return; } createAlert(n);
  }

  // ----- indicators -----
  const nextUid = () => Math.max(0, ...S.indicators.map(i => i.uid)) + 1;
  function applyIndicators() {
    S.indicators.forEach((i, k) => { i.slot = k; i.color = i.color || PALETTE[k % PALETTE.length]; });
    chart?.setIndicators(S.indicators.map(i => ({ ...i })));
  }
  function addIndicator(id) {
    const colors = PALETTE.filter(c => !S.indicators.some(i => i.color === c));
    S.indicators.push({ uid: nextUid(), id, params: defaults(id), color: colors[0] || PALETTE[S.indicators.length % PALETTE.length] });
    persist(); applyIndicators(); toast(REGISTRY[id].name + ' added', 'ok');
  }
  function removeIndicator(uid) { S.indicators = S.indicators.filter(i => i.uid !== uid); persist(); applyIndicators(); }
  function editIndicator(uid) {
    const ind = S.indicators.find(i => i.uid === uid); if (!ind) return;
    const def = REGISTRY[ind.id], inputs = {};
    const color = h('input', { type: 'color', value: ind.color, 'aria-label': 'Colour', style: { width: '100%', height: '40px', border: 0, background: 'none' } });
    const fields = (def.params || []).map(p => { const inp = h('input', { class: 'input', type: 'number', min: p.min, max: p.max, step: p.step, value: ind.params?.[p.key] ?? p.def }); inputs[p.key] = inp; return h('div', { class: 'field' }, h('label', {}, p.label), inp); });
    const s = openSheet({ title: def.name, body: h('div', { class: 'stack' }, ...fields, h('div', { class: 'field' }, h('label', {}, 'Colour'), color)),
      footer: [h('button', { class: 'btn danger', onclick: () => { removeIndicator(uid); s.close(); } }, 'Remove'),
        h('button', { class: 'btn primary', onclick: () => { (def.params || []).forEach(p => { const v = num(inputs[p.key].value); ind.params[p.key] = Math.min(p.max, Math.max(p.min, Number.isFinite(v) ? v : p.def)); }); ind.color = color.value; persist(); applyIndicators(); s.close(); } }, 'Apply')] });
  }
  function openIndicators() {
    const body = h('div', { class: 'stack' }); const sheet = openSheet({ title: 'Indicators', body });
    const draw = () => {
      clear(body);
      if (S.indicators.length) body.append(h('div', {}, h('div', { class: 'lbl', style: { marginBottom: '6px' } }, 'On this chart'),
        h('div', { class: 'chips' }, S.indicators.map(i => h('span', { class: 'chip', style: { borderColor: i.color, color: 'var(--text)' } }, REGISTRY[i.id].name.replace(/ \(.*\)/, ''), ' ',
          h('button', { 'aria-label': 'Edit', onclick: () => { sheet.close(); editIndicator(i.uid); } }, '⚙'), ' ', h('button', { 'aria-label': 'Remove', onclick: () => { removeIndicator(i.uid); draw(); } }, '✕'))))));
      GROUPS.forEach(([g, ids]) => body.append(h('div', {}, h('div', { class: 'lbl', style: { margin: '4px 0 6px' } }, g),
        h('div', { class: 'chips' }, ids.map(id => h('button', { class: 'chip', onclick: () => { addIndicator(id); draw(); } }, '+ ', REGISTRY[id].name.replace(/ \(.*\)/, '')))))));
    };
    draw();
  }

  // ----- wiring -----
  on('symbol', () => { header(); paintPrice(); load(); });
  on('instruments', () => { header(); load(); });
  on('mode', () => { header(); paintPrice(); load(); });
  on('quotes', () => {
    paintPrice(); paintQuote(); const q = S.quotes[S.symbol];
    if (chart && q && q.bid) chart.tick(q.bid, q.time || Date.now() / 1000);
  });
  on('snapshot', paintLevels); on('alerts', paintLevels);
  on('theme', () => chart?.refreshTheme());
  on('markers', () => chart?.setMarkers(hooks.markers));
  on('resize', () => chart?.resize());
  header();
  hooks.refreshChart = load;
  hooks.chart = () => chart;
  hooks.visible = () => { ensureChart(); chart.resize(); };
}

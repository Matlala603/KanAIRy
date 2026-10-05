// KanAIRY chart engine: canvas candlestick chart with indicator panes,
// live-updating last candle, trade levels, drawing tools and touch gestures.
import { REGISTRY, compute, heikinAshi, PALETTE } from './indicators.js';

const AXIS_W = 66, TIME_H = 24, MIN_BS = 1.5, MAX_BS = 42;

export const DRAW_TOOLS = {
  trend: { name: 'Trend line', pts: 2 },
  ray: { name: 'Ray', pts: 2 },
  arrow: { name: 'Arrow', pts: 2 },
  hline: { name: 'Horizontal line', pts: 1 },
  vline: { name: 'Vertical line', pts: 1 },
  rect: { name: 'Rectangle', pts: 2 },
  fib: { name: 'Fibonacci retracement', pts: 2 },
  text: { name: 'Text', pts: 1 },
};
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function niceStep(range, target) {
  const raw = range / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}
const pad2 = n => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class Chart {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'kc-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Price chart');
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.raw = []; this.disp = [];
    this.tf = 3600; this.digits = 5;
    this.type = 'candles';
    this.bs = 8; this.rightIdx = 0;
    this.indicators = []; this.cache = new Map();
    this.levels = []; this.markers = []; this.drawings = [];
    this.quote = null;
    this.tool = null; this.sel = null; this.draft = null;
    this.cross = null;       // {x,y,idx}
    this.regions = [];
    this.pointers = new Map();
    this.dragState = null;
    this.dirty = false;
    this.loadingMore = false;
    this.theme = {};
    this.refreshTheme();
    this._bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.timer = setInterval(() => { if (this.raw.length && !document.hidden) this.invalidate(); }, 1000);
    this.resize();
  }

  destroy() { this.ro.disconnect(); clearInterval(this.timer); this.canvas.remove(); }

  refreshTheme() {
    const cs = getComputedStyle(this.root);
    const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
    this.theme = {
      bg: v('--chart-bg', '#0a0f1a'), grid: v('--chart-grid', '#18233a'), text: v('--mute', '#8394b0'),
      ink: v('--text', '#e8eef8'), up: v('--up', '#20c997'), down: v('--down', '#ff5b6e'),
      brand: v('--brand', '#3d8bff'), panel: v('--panel', '#101827'), line: v('--line', '#223049'), warn: v('--warn', '#f5b83d'),
    };
    this.invalidate();
  }

  // ---------- data ----------
  setData(candles, { tfSeconds, digits, keepView } = {}) {
    if (tfSeconds) this.tf = tfSeconds;
    if (digits != null) this.digits = digits;
    this.raw = candles.slice();
    this._rebuild();
    if (!keepView) { this.bs = Math.max(MIN_BS, Math.min(MAX_BS, this.bs)); this.rightIdx = this.raw.length - 1 + 6; }
    this.invalidate();
  }

  prependCandles(older) {
    if (!older.length) return;
    const firstT = this.raw.length ? this.raw[0].t : Infinity;
    const add = older.filter(c => c.t < firstT);
    if (!add.length) return;
    this.raw = add.concat(this.raw);
    this.rightIdx += add.length;
    this._rebuild();
    this.invalidate();
  }

  // merge freshly fetched tail candles (replace same-time, append newer)
  mergeTail(tail) {
    if (!tail.length || !this.raw.length) return;
    const map = new Map(this.raw.map(c => [c.t, c]));
    const hadLast = this.rightIdx >= this.raw.length - 1;
    tail.forEach(c => map.set(c.t, c));
    this.raw = [...map.values()].sort((a, b) => a.t - b.t);
    if (hadLast) this.rightIdx = Math.max(this.rightIdx, this.raw.length - 1 + 2);
    this._rebuild();
    this.invalidate();
  }

  // apply a live price to the forming candle; opens a new candle at bucket rollover
  tick(price, tSec) {
    if (!this.raw.length || !(price > 0)) return;
    const last = this.raw[this.raw.length - 1];
    const bucket = tSec - (tSec % this.tf);
    if (this.tf < 604800 && bucket >= last.t + this.tf) {
      const prevAtEnd = this.rightIdx >= this.raw.length - 1;
      this.raw.push({ t: last.t + Math.floor((bucket - last.t) / this.tf) * this.tf, o: price, h: price, l: price, c: price, v: 0 });
      if (prevAtEnd) this.rightIdx += 1;
    } else {
      last.c = price; if (price > last.h) last.h = price; if (price < last.l) last.l = price;
    }
    this._rebuild();
    this.invalidate();
  }

  _rebuild() {
    this.disp = this.type === 'heikin' ? heikinAshi(this.raw) : this.raw;
    this.cache.clear();
  }

  setType(t) { this.type = t; this._rebuild(); this.invalidate(); }
  setIndicators(list) { this.indicators = list; this.cache.clear(); this.invalidate(); }
  setLevels(l) { this.levels = l; this.invalidate(); }
  setMarkers(m) { this.markers = m; this.invalidate(); }
  setQuote(bid, ask) { this.quote = bid ? { bid, ask } : null; this.invalidate(); }
  setDrawings(d) { this.drawings = d; this.sel = null; this.invalidate(); }
  setTool(t) { this.tool = t; this.draft = null; this.canvas.style.cursor = t ? 'crosshair' : ''; this.invalidate(); }
  deleteSelected() {
    if (this.sel == null) return false;
    this.drawings = this.drawings.filter(d => d.id !== this.sel);
    this.sel = null; this.opts.onDrawingsChange?.(this.drawings); this.invalidate(); return true;
  }
  clearDrawings() { this.drawings = []; this.sel = null; this.opts.onDrawingsChange?.(this.drawings); this.invalidate(); }
  goLatest() { this.rightIdx = this.raw.length - 1 + 6; this.invalidate(); }
  resetView() { this.bs = 8; this.goLatest(); }
  isAtEnd() { return this.rightIdx >= this.raw.length - 1 + 0.5; }

  // ---------- geometry ----------
  resize() {
    const r = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(120, r.width); this.H = Math.max(120, r.height);
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  get pw() { return this.W - AXIS_W; }
  xOf(i) { return this.pw - this.bs / 2 - (this.rightIdx - i) * this.bs; }
  idxOf(x) { return this.rightIdx - (this.pw - this.bs / 2 - x) / this.bs; }
  idxOfTime(t) {
    const n = this.raw.length; if (!n) return 0;
    const first = this.raw[0].t, last = this.raw[n - 1].t;
    if (t >= last) return n - 1 + (t - last) / this.tf;
    if (t <= first) return (t - first) / this.tf;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.raw[m].t <= t) lo = m; else hi = m; }
    return lo + (t - this.raw[lo].t) / (this.raw[hi].t - this.raw[lo].t);
  }
  timeOfIdx(i) {
    const n = this.raw.length; if (!n) return 0;
    if (i >= n - 1) return this.raw[n - 1].t + (i - (n - 1)) * this.tf;
    if (i <= 0) return this.raw[0].t + i * this.tf;
    const lo = Math.floor(i), f = i - lo;
    return this.raw[lo].t + f * (this.raw[lo + 1].t - this.raw[lo].t);
  }

  _layout() {
    const subs = this.indicators.filter(i => REGISTRY[i.id].kind === 'pane');
    const plotH = this.H - TIME_H;
    const subH = Math.max(70, Math.min(150, plotH * 0.2));
    const room = Math.max(0, plotH * 0.58);
    const per = subs.length ? Math.min(subH, room / subs.length) : 0;
    const mainH = plotH - per * subs.length;
    this.panes = [{ kind: 'main', y: 0, h: mainH }];
    subs.forEach((inst, k) => this.panes.push({ kind: 'sub', inst, y: mainH + per * k, h: per }));
  }

  _calc(inst) {
    const key = inst.uid + JSON.stringify(inst.params || {});
    let r = this.cache.get(key);
    if (!r) { r = compute(inst, this.raw); this.cache.set(key, r); }
    return r;
  }

  // ---------- render ----------
  invalidate() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => { this.dirty = false; this.draw(); });
  }

  draw() {
    const { ctx, W, H, theme: T } = this;
    if (!W) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    this.regions = [];
    this._layout();
    const n = this.disp.length;
    if (!n) {
      ctx.fillStyle = T.text; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(this.opts.emptyText || 'Loading prices…', this.pw / 2, H / 2); return;
    }
    const i0 = Math.max(0, Math.floor(this.idxOf(0)) - 1), i1 = Math.min(n - 1, Math.ceil(this.idxOf(this.pw)) + 1);
    this.vis = [i0, i1];
    if (i0 < 25 && !this.loadingMore && this.opts.onNeedMore) { this.loadingMore = true; Promise.resolve(this.opts.onNeedMore()).finally(() => { this.loadingMore = false; }); }

    const main = this.panes[0];
    this._drawMain(main, i0, i1);
    this.panes.slice(1).forEach(p => this._drawSub(p, i0, i1));
    this._drawTimeAxis(i0, i1);
    this._drawCrosshair();
    // frame lines
    ctx.strokeStyle = T.line; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(this.pw + .5, 0); ctx.lineTo(this.pw + .5, H - TIME_H); ctx.moveTo(0, H - TIME_H + .5); ctx.lineTo(W, H - TIME_H + .5); ctx.stroke();
  }

  _priceRange(i0, i1) {
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { const c = this.disp[i]; if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    this.indicators.filter(x => REGISTRY[x.id].kind === 'overlay').forEach(inst => {
      this._calc(inst).series.forEach(s => {
        const arrs = s.type === 'band' ? [s.a, s.b] : [s.values];
        arrs.forEach(a => { for (let i = i0; i <= i1; i++) { const v = a[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } } });
      });
    });
    if (!(hi > lo)) { hi = lo + Math.abs(lo) * 0.001 + 1e-6; }
    const padv = (hi - lo) * 0.08;
    return [lo - padv, hi + padv];
  }

  _drawMain(p, i0, i1) {
    const { ctx, theme: T } = this;
    const [lo, hi] = this._priceRange(i0, i1);
    p.lo = lo; p.hi = hi;
    const y = v => p.y + (hi - v) / (hi - lo) * p.h;
    p.yOf = y;
    ctx.save(); ctx.beginPath(); ctx.rect(0, p.y, this.pw, p.h); ctx.clip();
    // grid
    const step = niceStep(hi - lo, Math.max(3, p.h / 60));
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v < hi; v += step) ticks.push(v);
    ctx.beginPath();
    ticks.forEach(v => { const yy = Math.round(y(v)) + .5; ctx.moveTo(0, yy); ctx.lineTo(this.pw, yy); });
    this._vgrid(i0, i1);
    ctx.stroke();
    // right axis labels (drawn after clip restore via a second pass)
    this.axisTicks = { ticks, y, p };

    // overlays: bands first
    const overlays = this.indicators.filter(x => REGISTRY[x.id].kind === 'overlay');
    overlays.forEach(inst => this._drawSeries(inst, p, i0, i1, y, true));
    this._drawPrice(p, i0, i1, y);
    overlays.forEach(inst => this._drawSeries(inst, p, i0, i1, y, false));
    this._drawLevels(p, y);
    this._drawDrawings(p, y);
    this._drawMarkers(p, y, i0, i1);
    this._drawLastPrice(p, y);
    this._drawLegend(p);
    ctx.restore();
    // axis labels
    ctx.fillStyle = T.text; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ticks.forEach(v => ctx.fillText(v.toFixed(this.digits), this.pw + 6, y(v)));
    this._axisTags(p, y);
  }

  _vgrid(i0, i1) {
    const { ctx } = this;
    const every = Math.max(1, Math.round(90 / this.bs));
    for (let i = Math.ceil(i0 / every) * every; i <= i1; i += every) {
      const x = Math.round(this.xOf(i)) + .5;
      ctx.moveTo(x, 0); ctx.lineTo(x, this.H - TIME_H);
    }
  }

  _drawPrice(p, i0, i1, y) {
    const { ctx, theme: T } = this;
    const bw = Math.max(1, Math.min(this.bs * 0.7, this.bs - 1.5));
    const type = this.type;
    if (type === 'line' || type === 'area') {
      ctx.beginPath(); let started = false;
      for (let i = i0; i <= i1; i++) { const xx = this.xOf(i), yy = y(this.disp[i].c); if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy); }
      ctx.strokeStyle = T.brand; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      if (type === 'area' && started) {
        ctx.lineTo(this.xOf(i1), p.y + p.h); ctx.lineTo(this.xOf(i0), p.y + p.h); ctx.closePath();
        const g = ctx.createLinearGradient(0, p.y, 0, p.y + p.h); g.addColorStop(0, T.brand + '55'); g.addColorStop(1, T.brand + '00');
        ctx.fillStyle = g; ctx.fill();
      }
      return;
    }
    for (let i = i0; i <= i1; i++) {
      const c = this.disp[i], x = this.xOf(i), up = c.c >= c.o, col = up ? T.up : T.down;
      const yh = y(c.h), yl = y(c.l), yo = y(c.o), yc = y(c.c);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      if (type === 'bars') {
        ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x, yl); ctx.moveTo(x - bw / 2, yo); ctx.lineTo(x, yo); ctx.moveTo(x, yc); ctx.lineTo(x + bw / 2, yc); ctx.stroke();
        continue;
      }
      const wx = this.bs >= 4 ? Math.round(x) + .5 : x;
      ctx.beginPath(); ctx.moveTo(wx, yh); ctx.lineTo(wx, yl); ctx.stroke();
      const top = Math.min(yo, yc), h = Math.max(1, Math.abs(yc - yo));
      if (type === 'hollow' && up) { ctx.fillStyle = T.bg; ctx.fillRect(x - bw / 2, top, bw, h); ctx.strokeRect(x - bw / 2 + .5, top + .5, bw - 1, Math.max(0, h - 1)); }
      else ctx.fillRect(x - bw / 2, top, bw, h);
    }
  }

  _color(inst, s, k) {
    if (s.color === 'up') return this.theme.up;
    if (s.color === 'down') return this.theme.down;
    return inst.color || PALETTE[(k) % PALETTE.length];
  }

  _drawSeries(inst, p, i0, i1, y, bandsOnly) {
    const { ctx } = this;
    const r = this._calc(inst);
    r.series.forEach((s, k) => {
      const col = this._color(inst, s, inst.slot + k);
      if (s.type === 'band') {
        if (!bandsOnly) return;
        ctx.beginPath(); let open = false;
        for (let i = i0; i <= i1; i++) {
          const a = s.a[i], b = s.b[i]; if (!(a === a && b === b)) continue;
          const xx = this.xOf(i); if (!open) { ctx.moveTo(xx, y(a)); open = true; } else ctx.lineTo(xx, y(a));
        }
        for (let i = i1; i >= i0; i--) { const a = s.a[i], b = s.b[i]; if (a === a && b === b) ctx.lineTo(this.xOf(i), y(b)); }
        ctx.closePath(); ctx.fillStyle = (inst.color || PALETTE[inst.slot % PALETTE.length]) + '1c'; ctx.fill();
        return;
      }
      if (bandsOnly) return;
      if (s.type === 'dots') {
        ctx.fillStyle = col;
        for (let i = i0; i <= i1; i++) { const v = s.values[i]; if (v === v) { ctx.beginPath(); ctx.arc(this.xOf(i), y(v), 1.8, 0, 6.3); ctx.fill(); } }
        return;
      }
      ctx.beginPath(); let pen = false;
      for (let i = i0; i <= i1; i++) {
        const v = s.values[i];
        if (!(v === v)) { pen = false; continue; }
        const xx = this.xOf(i), yy = y(v);
        if (!pen) { ctx.moveTo(xx, yy); pen = true; } else ctx.lineTo(xx, yy);
      }
      ctx.strokeStyle = col; ctx.lineWidth = s.thin ? 1 : 1.5; ctx.setLineDash(s.dash ? [4, 3] : []); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  _drawSub(p, i0, i1) {
    const { ctx, theme: T } = this;
    const inst = p.inst, def = REGISTRY[inst.id], r = this._calc(inst);
    // separator
    ctx.strokeStyle = T.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, p.y + .5); ctx.lineTo(this.W, p.y + .5); ctx.stroke();
    let lo = Infinity, hi = -Infinity;
    if (def.range) { [lo, hi] = def.range; }
    else {
      r.series.forEach(s => { for (let i = i0; i <= i1; i++) { const v = s.values?.[i]; if (v === v && v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } } });
      (def.levels || []).forEach(l => { lo = Math.min(lo, l); hi = Math.max(hi, l); });
      if (r.series.some(s => s.type === 'hist')) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      if (!(hi > lo)) { lo = 0; hi = 1; }
      const pv = (hi - lo) * 0.1; lo -= pv; hi += pv;
    }
    const top = p.y + 18, h = p.h - 22;
    const y = v => top + (hi - v) / (hi - lo) * h;
    ctx.save(); ctx.beginPath(); ctx.rect(0, p.y + 1, this.pw, p.h - 1); ctx.clip();
    ctx.setLineDash([3, 3]); ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    (def.levels || []).forEach(l => { ctx.beginPath(); ctx.moveTo(0, Math.round(y(l)) + .5); ctx.lineTo(this.pw, Math.round(y(l)) + .5); ctx.stroke(); });
    ctx.setLineDash([]);
    const bw = Math.max(1, Math.min(this.bs * 0.7, this.bs - 1));
    const legendVals = [];
    r.series.forEach((s, k) => {
      const col = this._color(inst, s, inst.slot + k);
      if (s.type === 'hist') {
        const zero = Math.min(Math.max(0, lo), hi), y0 = y(zero);
        for (let i = i0; i <= i1; i++) {
          const v = s.values[i]; if (!(v === v)) continue;
          const c = this.disp[i];
          ctx.fillStyle = (s.byCandle ? (c.c >= c.o) : v >= 0) ? T.up + 'aa' : T.down + 'aa';
          const yy = y(v); ctx.fillRect(this.xOf(i) - bw / 2, Math.min(yy, y0), bw, Math.max(1, Math.abs(yy - y0)));
        }
      } else {
        ctx.beginPath(); let pen = false;
        for (let i = i0; i <= i1; i++) {
          const v = s.values[i]; if (!(v === v)) { pen = false; continue; }
          const xx = this.xOf(i), yy = y(v); if (!pen) { ctx.moveTo(xx, yy); pen = true; } else ctx.lineTo(xx, yy);
        }
        ctx.strokeStyle = col; ctx.lineWidth = s.thin ? 1 : 1.5; ctx.stroke();
      }
      const idx = this.cross ? Math.min(this.disp.length - 1, Math.max(0, Math.round(this.cross.idx))) : this.disp.length - 1;
      legendVals.push([col, s.values?.[idx]]);
    });
    ctx.restore();
    // legend
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const params = Object.values({ ...Object.fromEntries((def.params || []).map(q => [q.key, q.def])), ...(inst.params || {}) }).join(',');
    let title = def.name.replace(/ \(.*\)/, '') + (params ? ` (${params})` : '');
    ctx.fillStyle = T.ink; ctx.fillText(title, 8, p.y + 11);
    let x = 8 + ctx.measureText(title).width + 10;
    legendVals.forEach(([c, v]) => { if (v == null || v !== v) return; const t = this._fmtCompact(v); ctx.fillStyle = c; ctx.fillText(t, x, p.y + 11); x += ctx.measureText(t).width + 8; });
    this._legendButtons(this.pw - 44, p.y + 2, inst);
    // axis labels
    ctx.fillStyle = T.text; ctx.textAlign = 'left';
    const lv = def.levels || [lo + (hi - lo) * 0.2, hi - (hi - lo) * 0.2];
    lv.filter(l => l > lo && l < hi).forEach(l => ctx.fillText(this._fmtCompact(l), this.pw + 6, y(l)));
    const idx = this.cross ? Math.round(this.cross.idx) : null;
    void idx;
    p.yOf = y; p.lo = lo; p.hi = hi;
  }

  _fmtCompact(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    if (a >= 100) return v.toFixed(2);
    if (a >= 1) return v.toFixed(Math.min(4, this.digits));
    return v.toFixed(Math.min(6, this.digits + 1));
  }

  _legendButtons(x, y, inst) {
    const { ctx, theme: T } = this;
    ctx.fillStyle = T.text; ctx.textAlign = 'center';
    ctx.fillText('⚙', x + 8, y + 9); ctx.fillText('✕', x + 30, y + 9);
    this.regions.push({ x: x - 2, y, w: 20, h: 18, act: () => this.opts.onIndicator?.(inst.uid, 'edit') });
    this.regions.push({ x: x + 20, y, w: 20, h: 18, act: () => this.opts.onIndicator?.(inst.uid, 'remove') });
    ctx.textAlign = 'left';
  }

  _drawLegend(p) {
    const { ctx, theme: T } = this;
    const n = this.disp.length;
    const i = this.cross ? Math.min(n - 1, Math.max(0, Math.round(this.cross.idx))) : n - 1;
    const c = this.raw[i]; if (!c) return;
    const prev = this.raw[i - 1];
    const chg = prev ? c.c - prev.c : 0, pct = prev ? chg / prev.c * 100 : 0;
    ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const col = c.c >= c.o ? T.up : T.down;
    let x = 8; const yy = 14;
    const parts = [['O', c.o], ['H', c.h], ['L', c.l], ['C', c.c]];
    parts.forEach(([k, v]) => {
      ctx.fillStyle = T.text; ctx.fillText(k, x, yy); x += ctx.measureText(k).width + 3;
      const t = v.toFixed(this.digits); ctx.fillStyle = col; ctx.fillText(t, x, yy); x += ctx.measureText(t).width + 9;
    });
    const t = `${chg >= 0 ? '+' : ''}${chg.toFixed(this.digits)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    ctx.fillStyle = col; ctx.fillText(t, x, yy);
    // overlay legends
    let ly = 32;
    this.indicators.filter(i2 => REGISTRY[i2.id].kind === 'overlay').forEach(inst => {
      const def = REGISTRY[inst.id], r = this._calc(inst);
      const params = Object.values({ ...Object.fromEntries((def.params || []).map(q => [q.key, q.def])), ...(inst.params || {}) }).join(',');
      const label = def.name.replace(/ \(.*\)/, '') + (params ? ` (${params})` : '');
      const first = r.series.find(s => s.values);
      const v = first?.values?.[i];
      ctx.fillStyle = inst.color || PALETTE[inst.slot % PALETTE.length]; ctx.fillRect(8, ly - 4, 8, 8);
      ctx.fillStyle = T.ink; ctx.fillText(label, 21, ly);
      let ex = 21 + ctx.measureText(label).width + 8;
      if (v === v && v != null) { ctx.fillStyle = T.text; const tv = v.toFixed(this.digits); ctx.fillText(tv, ex, ly); ex += ctx.measureText(tv).width + 8; }
      ctx.fillStyle = T.text; ctx.textAlign = 'center';
      ctx.fillText('⚙', ex + 6, ly); ctx.fillText('✕', ex + 26, ly); ctx.textAlign = 'left';
      this.regions.push({ x: ex - 2, y: ly - 9, w: 20, h: 18, act: () => this.opts.onIndicator?.(inst.uid, 'edit') });
      this.regions.push({ x: ex + 18, y: ly - 9, w: 20, h: 18, act: () => this.opts.onIndicator?.(inst.uid, 'remove') });
      ly += 18;
    });
  }

  _tag(text, y, bg, fg = '#fff') {
    const { ctx } = this;
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = AXIS_W - 2;
    ctx.fillStyle = bg; ctx.fillRect(this.pw + 1, y - 9, w, 18);
    ctx.fillStyle = fg; ctx.fillText(text, this.pw + 6, y);
  }

  _axisTags(p, y) {
    const { theme: T } = this;
    const last = this.disp[this.disp.length - 1];
    if (this.quote) {
      this._tag(this.quote.ask.toFixed(this.digits), y(this.quote.ask), T.up + 'cc');
      this._tag(this.quote.bid.toFixed(this.digits), y(this.quote.bid), T.down + 'cc');
    }
    const col = last.c >= last.o ? T.up : T.down;
    const ly = y(last.c);
    if (ly > p.y && ly < p.y + p.h) {
      this._tag(last.c.toFixed(this.digits), ly - (this.opts.countdown !== false ? 7 : 0), col);
      if (this.opts.countdown !== false) {
        const left = Math.max(0, last.t + this.tf - Date.now() / 1000);
        if (this.tf < 604800 && left < this.tf * 1.02) {
          const s = Math.floor(left);
          const txt = s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor(s % 3600 / 60))}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
          this._tag(txt, ly + 11, T.panel, T.text);
        }
      }
    }
    this.levels.forEach(l => {
      if (l.price == null) return;
      const yy = y(l.price); if (yy < p.y || yy > p.y + p.h) return;
      this._tag(l.price.toFixed(this.digits), yy, l.color || T.brand);
    });
    if (this.cross && this.cross.pane === 0) {
      const price = p.hi - (this.cross.y - p.y) / p.h * (p.hi - p.lo);
      this._tag(price.toFixed(this.digits), this.cross.y, T.ink, T.bg);
    }
    if (this.draft?.price != null) this._tag(this.draft.price.toFixed(this.digits), y(this.draft.price), T.brand);
  }

  _drawLastPrice(p, y) {
    const { ctx, theme: T } = this;
    const last = this.disp[this.disp.length - 1], ly = y(last.c);
    ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    ctx.strokeStyle = last.c >= last.o ? T.up : T.down; ctx.beginPath(); ctx.moveTo(0, Math.round(ly) + .5); ctx.lineTo(this.pw, Math.round(ly) + .5); ctx.stroke();
    if (this.quote) {
      ctx.strokeStyle = T.up + '88'; ctx.beginPath(); ctx.moveTo(0, Math.round(y(this.quote.ask)) + .5); ctx.lineTo(this.pw, Math.round(y(this.quote.ask)) + .5); ctx.stroke();
      ctx.strokeStyle = T.down + '88'; ctx.beginPath(); ctx.moveTo(0, Math.round(y(this.quote.bid)) + .5); ctx.lineTo(this.pw, Math.round(y(this.quote.bid)) + .5); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _drawLevels(p, y) {
    const { ctx, theme: T } = this;
    this.levels.forEach(l => {
      if (l.price == null) return;
      const yy = y(l.price); if (yy < -20 || yy > p.h + 20) return;
      ctx.strokeStyle = l.color || T.brand; ctx.lineWidth = l.kind === 'position' ? 1.5 : 1;
      ctx.setLineDash(l.kind === 'position' ? [] : [6, 4]);
      ctx.beginPath(); ctx.moveTo(0, Math.round(yy) + .5); ctx.lineTo(this.pw, Math.round(yy) + .5); ctx.stroke(); ctx.setLineDash([]);
      if (l.label) {
        ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(l.label).width + 12, x = Math.max(60, this.pw - w - 70);
        ctx.fillStyle = T.bg; ctx.fillRect(x, yy - 9, w, 18);
        ctx.strokeStyle = l.color || T.brand; ctx.lineWidth = 1; ctx.strokeRect(x + .5, yy - 8.5, w - 1, 17);
        ctx.fillStyle = l.color || T.brand; ctx.fillText(l.label, x + 6, yy);
      }
    });
  }

  _drawMarkers(p, y, i0, i1) {
    const { ctx, theme: T } = this;
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center';
    this.markers.forEach(m => {
      const i = this.idxOfTime(m.t); if (i < i0 - 1 || i > i1 + 1) return;
      const c = this.raw[Math.min(this.raw.length - 1, Math.max(0, Math.round(i)))];
      const x = this.xOf(i), buy = m.side === 'buy';
      const yy = buy ? y(c.l) + 12 : y(c.h) - 12;
      ctx.fillStyle = m.color || (buy ? T.up : T.down);
      ctx.beginPath();
      if (buy) { ctx.moveTo(x, yy - 7); ctx.lineTo(x - 5, yy + 3); ctx.lineTo(x + 5, yy + 3); } else { ctx.moveTo(x, yy + 7); ctx.lineTo(x - 5, yy - 3); ctx.lineTo(x + 5, yy - 3); }
      ctx.closePath(); ctx.fill();
      if (m.text) { ctx.fillStyle = T.ink; ctx.fillText(m.text, x, buy ? yy + 13 : yy - 11); }
    });
  }

  // ---------- drawings ----------
  _pt(pt) { const m = this.panes[0]; return { x: this.xOf(this.idxOfTime(pt.t)), y: m.yOf(pt.p) }; }
  _fromXY(x, y) { const m = this.panes[0]; return { t: Math.round(this.timeOfIdx(this.idxOf(x))), p: m.hi - (y - m.y) / m.h * (m.hi - m.lo) }; }

  _drawDrawings(p) {
    const { ctx, theme: T } = this;
    const list = this.draft?.drawing ? [...this.drawings, this.draft.drawing] : this.drawings;
    list.forEach(d => {
      const sel = d.id === this.sel;
      const col = d.color || T.brand;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.setLineDash([]);
      const a = this._pt(d.pts[0]), b = d.pts[1] ? this._pt(d.pts[1]) : null;
      if (d.tool === 'hline') { ctx.beginPath(); ctx.moveTo(0, a.y); ctx.lineTo(this.pw, a.y); ctx.stroke(); this._pill(d.pts[0].p.toFixed(this.digits), 6, a.y, col); }
      else if (d.tool === 'vline') { ctx.beginPath(); ctx.moveTo(a.x, 0); ctx.lineTo(a.x, p.h); ctx.stroke(); }
      else if (d.tool === 'text') { ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(d.text || 'Text', a.x, a.y); }
      else if (b && (d.tool === 'trend' || d.tool === 'arrow' || d.tool === 'ray')) {
        let ex = b.x, ey = b.y;
        if (d.tool === 'ray' && a.x !== b.x) { const k = (b.y - a.y) / (b.x - a.x); ex = b.x > a.x ? this.pw + 50 : -50; ey = a.y + k * (ex - a.x); }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
        if (d.tool === 'arrow') { const ang = Math.atan2(b.y - a.y, b.x - a.x); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - 10 * Math.cos(ang - .4), b.y - 10 * Math.sin(ang - .4)); ctx.lineTo(b.x - 10 * Math.cos(ang + .4), b.y - 10 * Math.sin(ang + .4)); ctx.closePath(); ctx.fill(); }
      } else if (b && d.tool === 'rect') {
        ctx.globalAlpha = .12; ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.globalAlpha = 1;
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (b && d.tool === 'fib') {
        const p0 = d.pts[0].p, p1 = d.pts[1].p;
        ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x, x0 + 120);
        FIB.forEach(r => {
          const price = p1 + (p0 - p1) * r, yy = this.panes[0].yOf(price);
          ctx.globalAlpha = .75; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.globalAlpha = 1;
          ctx.fillText(`${(r * 100).toFixed(1)}%  ${price.toFixed(this.digits)}`, x0 + 4, yy - 2);
        });
        ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      }
      if (sel) { [a, b].forEach(pp => { if (pp) { ctx.fillStyle = T.bg; ctx.beginPath(); ctx.arc(pp.x, pp.y, 5, 0, 6.3); ctx.fill(); ctx.stroke(); } }); }
    });
  }

  _pill(text, x, y, col) {
    const { ctx, theme: T } = this;
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 8; ctx.fillStyle = T.bg; ctx.fillRect(x, y - 8, w, 16); ctx.fillStyle = col; ctx.fillText(text, x + 4, y);
  }

  _hitDrawing(x, y) {
    const m = this.panes[0];
    const segDist = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)); return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)); };
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k], a = this._pt(d.pts[0]), b = d.pts[1] ? this._pt(d.pts[1]) : null;
      let hit = false;
      if (d.tool === 'hline') hit = Math.abs(y - a.y) < 7;
      else if (d.tool === 'vline') hit = Math.abs(x - a.x) < 7;
      else if (d.tool === 'text') hit = x >= a.x - 4 && x <= a.x + 120 && Math.abs(y - a.y) < 10;
      else if (b && (d.tool === 'trend' || d.tool === 'arrow' || d.tool === 'ray')) hit = segDist(a, b) < 8;
      else if (b && d.tool === 'rect') { const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y); hit = x >= x0 - 6 && x <= x1 + 6 && y >= y0 - 6 && y <= y1 + 6; }
      else if (b && d.tool === 'fib') { const x0 = Math.min(a.x, b.x); hit = x >= x0 - 6 && FIB.some(r => Math.abs(y - m.yOf(d.pts[1].p + (d.pts[0].p - d.pts[1].p) * r)) < 6); }
      if (hit) return d;
    }
    return null;
  }

  _hitLevel(x, y) {
    const m = this.panes[0];
    if (!m.yOf) return null;
    return this.levels.find(l => l.draggable && l.price != null && Math.abs(m.yOf(l.price) - y) < 7 && x < this.pw) || null;
  }

  // ---------- axes / crosshair ----------
  _drawTimeAxis(i0, i1) {
    const { ctx, theme: T } = this;
    const y = this.H - TIME_H;
    ctx.fillStyle = T.bg; ctx.fillRect(0, y + 1, this.W, TIME_H);
    ctx.fillStyle = T.text; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const every = Math.max(1, Math.round(95 / this.bs));
    let prev = null;
    for (let i = Math.ceil(i0 / every) * every; i <= i1; i += every) {
      const d = new Date(this.timeOfIdx(i) * 1000);
      ctx.fillStyle = T.text;
      ctx.fillText(this._timeLabel(d, prev), this.xOf(i), y + TIME_H / 2 + 1);
      prev = d;
    }
    if (this.cross && this.cross.x < this.pw) {
      const d = new Date(this.timeOfIdx(this.cross.idx) * 1000);
      const txt = this.tf >= 86400 ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      const w = ctx.measureText(txt).width + 14;
      const x = Math.min(this.pw - w / 2, Math.max(w / 2, this.cross.x));
      ctx.fillStyle = T.ink; ctx.fillRect(x - w / 2, y + 2, w, TIME_H - 4); ctx.fillStyle = T.bg; ctx.fillText(txt, x, y + TIME_H / 2 + 1);
    }
  }

  _timeLabel(d, prev) {
    if (this.tf >= 2592000) return d.getMonth() === 0 || !prev ? String(d.getFullYear()) : MONTHS[d.getMonth()];
    if (this.tf >= 86400) {
      if (!prev || d.getFullYear() !== prev.getFullYear()) return String(d.getFullYear());
      if (d.getMonth() !== prev.getMonth()) return MONTHS[d.getMonth()];
      return String(d.getDate());
    }
    if (!prev || d.getDate() !== prev.getDate()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  _drawCrosshair() {
    const c = this.cross; if (!c) return;
    const { ctx, theme: T } = this;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.pw, this.H - TIME_H); ctx.clip();
    ctx.strokeStyle = T.text; ctx.globalAlpha = .55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(c.x) + .5, 0); ctx.lineTo(Math.round(c.x) + .5, this.H - TIME_H); ctx.moveTo(0, Math.round(c.y) + .5); ctx.lineTo(this.pw, Math.round(c.y) + .5); ctx.stroke();
    ctx.restore();
    // price tag for the hovered pane
    const pane = this.panes[c.pane];
    if (pane && pane.kind === 'sub' && pane.hi != null) {
      const v = pane.hi - (c.y - pane.y - 18) / (pane.h - 22) * (pane.hi - pane.lo);
      this._tag(this._fmtCompact(v), c.y, T.ink, T.bg);
    }
  }

  // ---------- input ----------
  _bind() {
    const cv = this.canvas;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', e => this._down(e));
    cv.addEventListener('pointermove', e => this._move(e));
    cv.addEventListener('pointerup', e => this._up(e));
    cv.addEventListener('pointercancel', e => this._up(e));
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !this.dragState) { this.cross = null; this.opts.onCrosshair?.(null); this.invalidate(); } });
    cv.addEventListener('wheel', e => { e.preventDefault(); this._zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, this._local(e).x); }, { passive: false });
    cv.addEventListener('dblclick', () => this.resetView());
    cv.addEventListener('contextmenu', e => { e.preventDefault(); this._context(e); });
    this._keyHandler = e => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel != null && document.activeElement?.tagName !== 'INPUT' && this.root.offsetParent) { this.deleteSelected(); }
      if (e.key === 'Escape') { this.setTool(null); this.opts.onToolChange?.(null); this.sel = null; this.invalidate(); }
    };
    window.addEventListener('keydown', this._keyHandler);
  }

  destroyKeys() { window.removeEventListener('keydown', this._keyHandler); }

  _local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _zoom(f, anchorX) {
    const before = this.idxOf(anchorX);
    this.bs = Math.max(MIN_BS, Math.min(MAX_BS, this.bs * f));
    this.rightIdx = before + (this.pw - this.bs / 2 - anchorX) / this.bs;
    this._clamp(); this.invalidate();
  }

  _clamp() {
    const n = this.raw.length;
    this.rightIdx = Math.min(n - 1 + this.pw / this.bs * 0.6, Math.max(Math.min(n - 1, 8), this.rightIdx));
  }

  _paneAt(y) { for (let i = this.panes.length - 1; i >= 0; i--) if (y >= this.panes[i].y) return i; return 0; }

  _down(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const pt = this._local(e);
    this.pointers.set(e.pointerId, { ...pt, sx: pt.x, sy: pt.y, t: Date.now() });
    if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.dragState = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), bs0: this.bs }; return; }
    // legend buttons
    const reg = this.regions.find(r => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h);
    if (reg) { reg.act(); this.dragState = { mode: 'none' }; return; }
    if (pt.x > this.pw) { this.dragState = { mode: 'none' }; return; }
    const m = this.panes[0];
    // drawing tool
    if (this.tool && pt.y < m.h) {
      const pos = this._fromXY(pt.x, pt.y);
      const t = DRAW_TOOLS[this.tool];
      if (t.pts === 1) {
        const drawing = { id: Date.now() + Math.random(), tool: this.tool, pts: [pos], color: this.opts.drawColor };
        if (this.tool === 'text') {
          const txt = this.opts.onTextRequest ? null : prompt('Label text');
          const finish = text => { if (!text) return; drawing.text = text; this.drawings.push(drawing); this.opts.onDrawingsChange?.(this.drawings); this.invalidate(); };
          if (this.opts.onTextRequest) this.opts.onTextRequest(finish); else finish(txt);
        } else { this.drawings.push(drawing); this.opts.onDrawingsChange?.(this.drawings); }
        this.setTool(null); this.opts.onToolChange?.(null); this.dragState = { mode: 'none' }; return;
      }
      this.draft = { drawing: { id: Date.now() + Math.random(), tool: this.tool, pts: [pos, pos], color: this.opts.drawColor } };
      this.dragState = { mode: 'draw' }; return;
    }
    // level drag
    const lvl = this._hitLevel(pt.x, pt.y);
    if (lvl) { this.dragState = { mode: 'level', level: lvl, price: lvl.price }; this.draft = { price: lvl.price }; return; }
    // drawing select / move
    const hit = pt.y < m.h ? this._hitDrawing(pt.x, pt.y) : null;
    if (hit) {
      this.sel = hit.id; this.dragState = { mode: 'move', d: hit, last: this._fromXY(pt.x, pt.y), moved: false }; this.invalidate(); return;
    }
    if (this.sel != null) { this.sel = null; this.invalidate(); }
    this.dragState = { mode: 'pan', x0: pt.x, r0: this.rightIdx, touch: e.pointerType !== 'mouse', moved: false };
    if (e.pointerType !== 'mouse') {
      this._lp = setTimeout(() => { if (this.dragState?.mode === 'pan' && !this.dragState.moved) { this.dragState.mode = 'long'; this._context(e, pt); } }, 550);
    }
  }

  _move(e) {
    const pt = this._local(e);
    const p = this.pointers.get(e.pointerId);
    if (p) { p.x = pt.x; p.y = pt.y; }
    const ds = this.dragState;
    if (ds?.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      const anchor = (a.x + b.x) / 2; const before = this.idxOf(anchor);
      this.bs = Math.max(MIN_BS, Math.min(MAX_BS, ds.bs0 * d / ds.d0));
      this.rightIdx = before + (this.pw - this.bs / 2 - anchor) / this.bs; this._clamp(); this.invalidate(); return;
    }
    if (ds?.mode === 'pan') {
      const dx = pt.x - ds.x0;
      if (Math.abs(dx) > 3) { ds.moved = true; clearTimeout(this._lp); }
      if (ds.moved) { this.rightIdx = ds.r0 - dx / this.bs; this._clamp(); this.cross = null; this.invalidate(); return; }
    }
    if (ds?.mode === 'draw') { const pos = this._fromXY(pt.x, pt.y); this.draft.drawing.pts[1] = pos; this.invalidate(); return; }
    if (ds?.mode === 'level') { const m = this.panes[0]; const price = m.hi - (pt.y - m.y) / m.h * (m.hi - m.lo); ds.price = price; this.draft = { price }; ds.level.preview = price; this.invalidate(); return; }
    if (ds?.mode === 'move') {
      const pos = this._fromXY(pt.x, pt.y), dt = pos.t - ds.last.t, dp = pos.p - ds.last.p;
      ds.d.pts = ds.d.pts.map(q => ({ t: q.t + dt, p: q.p + dp })); ds.last = pos; ds.moved = true; this.invalidate(); return;
    }
    if (e.pointerType === 'mouse' || (this.pointers.size === 1 && ds?.mode === 'none')) this._setCross(pt);
    if (e.pointerType === 'mouse') {
      const hl = this._hitLevel(pt.x, pt.y);
      this.canvas.style.cursor = this.tool ? 'crosshair' : (hl ? 'ns-resize' : (this._hitDrawing(pt.x, pt.y) ? 'pointer' : ''));
    }
  }

  _setCross(pt) {
    const n = this.raw.length; if (!n || pt.x > this.pw) { this.cross = null; this.invalidate(); return; }
    const idx = this.idxOf(pt.x); const pane = this._paneAt(pt.y);
    this.cross = { x: pt.x, y: pt.y, idx, pane };
    this.opts.onCrosshair?.(this.raw[Math.min(n - 1, Math.max(0, Math.round(idx)))]);
    this.invalidate();
  }

  _up(e) {
    clearTimeout(this._lp);
    const pt = this._local(e);
    const p0 = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const ds = this.dragState;
    if (this.pointers.size === 0) this.dragState = null;
    if (!ds) return;
    if (ds.mode === 'draw') {
      const d = this.draft.drawing; this.draft = null;
      const a = this._pt(d.pts[0]), b = this._pt(d.pts[1]);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 6) { this.drawings.push(d); this.opts.onDrawingsChange?.(this.drawings); }
      this.setTool(null); this.opts.onToolChange?.(null);
    } else if (ds.mode === 'level') {
      this.draft = null; const lvl = ds.level; delete lvl.preview;
      if (Math.abs(ds.price - lvl.price) > 0) this.opts.onLevelDrag?.(lvl, ds.price);
      this.invalidate();
    } else if (ds.mode === 'move') {
      if (ds.moved) this.opts.onDrawingsChange?.(this.drawings);
    } else if (ds.mode === 'pan' && !ds.moved && p0 && ds.touch) {
      this._setCross(pt);
    }
    this.invalidate();
  }

  _context(e, ptOverride) {
    const pt = ptOverride || this._local(e);
    const m = this.panes[0];
    if (!m || pt.y > m.h || pt.x > this.pw) return;
    const price = m.hi - (pt.y - m.y) / m.h * (m.hi - m.lo);
    this.opts.onContext?.({ price, time: Math.round(this.timeOfIdx(this.idxOf(pt.x))), clientX: e.clientX, clientY: e.clientY });
  }

  // used by the app to render sparkline-ish things / screenshots
  toDataURL() { return this.canvas.toDataURL('image/png'); }
}

// Sheets (bottom sheet on phones, dialog on desktop) and context menus.
import { h, icon, $, clear } from './util.js';

const root = () => $('#sheetRoot');
const stack = [];

export function openSheet({ title, body, footer, onClose, wide }) {
  const r = root();
  const scrim = h('div', { class: 'scrim', onclick: () => api.close() });
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => api.close() }, icon('x'));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: wide ? { width: 'min(760px,96vw)' } : {} },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), closeBtn),
    h('div', { class: 'sheet-body' }, body),
    footer ? h('div', { class: 'sheet-foot' }, footer) : null);
  const layer = h('div', { style: { position: 'absolute', inset: 0 } }, scrim, sheet);
  r.append(layer); r.classList.add('open'); stack.push(layer);
  const prevFocus = document.activeElement;
  const api = {
    el: sheet, body: sheet.querySelector('.sheet-body'),
    setFooter(f) { let ft = sheet.querySelector('.sheet-foot'); if (!ft) { ft = h('div', { class: 'sheet-foot' }); sheet.append(ft); } clear(ft).append(...[].concat(f)); },
    close() {
      const i = stack.indexOf(layer); if (i < 0) return;
      stack.splice(i, 1); layer.remove(); if (!stack.length) r.classList.remove('open');
      onClose?.(); prevFocus?.focus?.();
    },
  };
  setTimeout(() => sheet.querySelector('input,select,button.btn')?.focus?.({ preventScroll: true }), 50);
  return api;
}
export const closeAllSheets = () => { while (stack.length) { const l = stack.pop(); l.remove(); } root().classList.remove('open'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && stack.length) { const l = stack[stack.length - 1]; l.querySelector('.scrim').click(); } });

export function confirmSheet({ title, message, okText = 'Confirm', danger = false, details }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const s = openSheet({ title, onClose: () => finish(false),
      body: h('div', { class: 'stack' }, h('p', { class: 'mute' }, message), details || null),
      footer: [h('button', { class: 'btn', onclick: () => s.close() }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { finish(true); s.close(); } }, okText)] });
  });
}

export function promptSheet({ title, label, value = '', type = 'text', okText = 'Save' }) {
  return new Promise(resolve => {
    let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    const inp = h('input', { class: 'input', type, value, onkeydown: e => { if (e.key === 'Enter') { finish(inp.value); s.close(); } } });
    const s = openSheet({ title, onClose: () => finish(null),
      body: h('div', { class: 'field' }, h('label', {}, label), inp),
      footer: [h('button', { class: 'btn', onclick: () => s.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => { finish(inp.value); s.close(); } }, okText)] });
  });
}

let ctxEl = null;
export function contextMenu(x, y, header, items) {
  closeContext();
  ctxEl = h('div', { class: 'ctx', role: 'menu' }, header ? h('div', { class: 'hd' }, header) : null,
    items.map(it => h('button', { role: 'menuitem', onclick: () => { closeContext(); it.run(); } }, it.label)));
  document.body.append(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  ctxEl.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  // close on any press outside the menu; presses inside must survive so the item's click can fire
  const menu = ctxEl;
  setTimeout(() => {
    if (ctxEl !== menu) return;
    ctxOff = ev => { if (menu.contains(ev.target)) return; closeContext(); };
    document.addEventListener('pointerdown', ctxOff, true);
  }, 0);
}
let ctxOff = null;
export function closeContext() {
  if (ctxOff) { document.removeEventListener('pointerdown', ctxOff, true); ctxOff = null; }
  ctxEl?.remove(); ctxEl = null;
}

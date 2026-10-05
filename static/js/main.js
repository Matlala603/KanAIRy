// App bootstrap: routing, navigation, accounts, alerts, theme.
import { h, icon, clear, toast, store } from './util.js';
import { S, on, emit, active, isBroker, persist } from './state.js';
import { api, setToken, onUnauthenticated } from './api.js';
import { loadInstruments, startPolling, stopPolling, mid } from './market.js';
import { closeAllSheets, openSheet, confirmSheet } from './ui.js';
import { openConnect } from './connect.js';
import { hooks, mountWatchlist, mountChart, selectSymbol } from './terminal.js';
import { mountTicket, mountPositions } from './trading.js';
import * as scr from './screens.js';

const $ = id => document.getElementById(id);
const TERMINAL = ['quotes', 'chart', 'trade', 'positions'];
const NAV_MAIN = [['quotes', 'Markets', 'quotes'], ['chart', 'Chart', 'chart'], ['trade', 'Trade', 'trade'], ['positions', 'Positions', 'list'], ['more', 'More', 'menu']];
const MENU = [['news', 'News', 'news'], ['calendar', 'Calendar', 'cal'], ['account', 'Account', 'user'], ['strategies', 'Strategy lab', 'flask'], ['learn', 'Learn', 'book'], ['assistant', 'AI assistant', 'bot'], ['settings', 'Settings', 'gear'], ['about', 'About', 'info'], ['developer', 'Developer', 'user']];
const SCREENS = [...TERMINAL, ...MENU.map(m => m[0])];

// ---------- theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  if (S.settings.colorblind) document.documentElement.dataset.cb = '1'; else delete document.documentElement.dataset.cb;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', S.settings.theme === 'dark' ? '#0b0d11' : '#ffffff');
  emit('theme');
}
on('settings', applyTheme);

// ---------- routing ----------
function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'chart';
  closeAllSheets(); document.body.classList.remove('drawer-open');
  document.body.dataset.screen = name;
  document.body.dataset.group = TERMINAL.includes(name) ? 'terminal' : 'page';
  document.querySelectorAll('#rail button, #bottomNav button').forEach(b => b.dataset.k === name || (b.dataset.k === 'more' && !TERMINAL.includes(name)) ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (TERMINAL.includes(name)) { hooks.visible?.(); if (name === 'positions') hooks.refreshPositions?.(); }
  const fn = { news: 'onNews', calendar: 'onCalendar', account: 'onAccount', strategies: 'onStrategies', settings: 'onSettings', assistant: 'onAssistant' }[name];
  if (fn) hooks[fn]?.();
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
  scrollTo(0, 0);
}
hooks.showScreen = showScreen;
hooks.setSymbol = selectSymbol;

function buildNav() {
  const mk = ([k, l, i]) => h('button', { 'data-k': k, onclick: () => k === 'more' ? openDrawer() : showScreen(k) }, icon(i, 22), h('span', {}, l));
  clear($('bottomNav')).append(...NAV_MAIN.map(mk));
  // Desktop rail: terminal group + pages. Markets/Trade are always visible in the 3-column grid.
  clear($('rail')).append(mk(['chart', 'Terminal', 'chart']), ...MENU.slice(0, 4).map(mk), mk(['settings', 'Settings', 'gear']), mk(['learn', 'Learn', 'book']), mk(['assistant', 'AI', 'bot']));
}
function openDrawer() {
  const d = clear($('drawer'));
  d.append(h('div', { class: 'row', style: { padding: '14px 16px' } }, h('b', { class: 'grow' }, 'KanAIRY'), h('button', { class: 'icon-btn', 'aria-label': 'Close menu', onclick: () => document.body.classList.remove('drawer-open') }, icon('x', 20))),
    ...MENU.map(([k, l, i]) => h('button', { class: 'drawer-item', onclick: () => showScreen(k) }, icon(i, 20), l)));
  document.body.classList.add('drawer-open');
}
$('drawerScrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));
$('btnMenu').append(icon('menu', 22)); $('btnMenu').onclick = openDrawer;
$('btnAlerts').append(icon('bell', 22), h('span', { class: 'dot hide', id: 'alertDot' }));
$('btnAlerts').onclick = () => scr.openAlerts();
$('btnTheme').onclick = () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); drawThemeBtn(); };
const drawThemeBtn = () => { clear($('btnTheme')).append(icon(S.settings.theme === 'dark' ? 'sun' : 'moon', 22)); };

// ---------- accounts ----------
function paintAccount() {
  const a = active();
  $('acctLbl').textContent = a ? a.label : 'Public prices';
  const acc = S.account;
  $('acctVal').textContent = a ? (acc ? `${acc.balance?.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${acc.currency}` : 'Connecting…') : 'Connect a broker';
  $('statusDot').className = 'status' + (a ? (S.online ? ' live' : ' bad') : '');
  const b = $('banner');
  if (!a) {
    clear(b).append(h('span', {}, h('b', {}, 'Public prices'), ' are delayed. Connect your MetaTrader account to trade and see live broker prices.'), h('button', { class: 'btn sm primary', onclick: () => hooks.openConnect() }, 'Connect'));
    b.classList.remove('hide'); document.body.classList.add('has-banner');
  } else if (!S.online) {
    clear(b).append(h('span', {}, h('b', {}, 'Offline'), ' — reconnecting to your broker…')); b.classList.remove('hide'); document.body.classList.add('has-banner');
  } else { b.classList.add('hide'); document.body.classList.remove('has-banner'); }
}
on('snapshot', paintAccount); on('online', paintAccount);

function accountSheet() {
  const body = h('div', { class: 'stack' });
  const s = openSheet({ title: 'Accounts', body });
  S.accounts.forEach(acc => body.append(h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, acc.label), h('div', { class: 'd' }, `${acc.server} · ${acc.platform.toUpperCase()}${acc.id === S.activeId ? ' · active' : ''}`)),
    acc.id === S.activeId ? h('button', { class: 'btn sm danger', onclick: () => { s.close?.(); hooks.disconnect(acc.id); } }, 'Disconnect') : h('button', { class: 'btn sm', onclick: () => { closeAllSheets(); hooks.switchAccount(acc.id); } }, 'Switch'))));
  body.append(h('button', { class: 'btn primary', onclick: () => { closeAllSheets(); hooks.openConnect(); } }, icon('plus', 16), S.accounts.length ? 'Add another account' : 'Connect a broker'));
}
$('acctChip').onclick = accountSheet;

async function enterMode(afterSwitch) {
  stopPolling();
  S.account = null; S.positions = []; S.orders = []; S.quotes = {}; S.instruments = []; S.online = true;
  setToken(active()?.token || null);
  emit('mode'); paintAccount();
  try { await loadInstruments(); } catch (e) {
    if (isBroker() && e.status !== 401) toast(e.message, 'error');
  }
  if (!S.instruments.find(i => i.symbol === S.symbol) && S.instruments.length) selectSymbol((S.instruments.find(i => /^EURUSD/.test(i.symbol)) || S.instruments[0]).symbol);
  emit('mode'); startPolling(); paintAccount();
  void afterSwitch;
}

hooks.openConnect = preset => openConnect(res => {
  closeAllSheets();
  const id = `${res.login}@${res.server}`;
  S.accounts = S.accounts.filter(a => a.id !== id);
  S.accounts.push({ id, label: `${res.broker || res.server} · ${res.login}`, broker: res.broker, login: res.login, server: res.server, platform: res.platform, token: res.token });
  S.activeId = id; persist();
  toast('Connected to ' + (res.broker || res.server), 'ok');
  enterMode().then(() => showScreen('chart'));
}, preset);

hooks.switchAccount = id => { S.activeId = id; persist(); enterMode(); toast('Switched account'); };
hooks.disconnect = async id => {
  const acc = S.accounts.find(a => a.id === id); if (!acc) return;
  if (!await confirmSheet({ title: 'Disconnect', message: `Remove ${acc.label} from this device? Your broker account is not affected.`, okText: 'Disconnect', danger: true })) return;
  if (id === S.activeId) { try { await api.logout(); } catch { /* token may already be invalid */ } }
  S.accounts = S.accounts.filter(a => a.id !== id);
  if (S.activeId === id) S.activeId = null;
  persist(); await enterMode(); toast('Disconnected');
  if (document.body.dataset.screen === 'account') hooks.onAccount?.();
};
onUnauthenticated(() => {
  const a = active(); if (!a) return;
  S.accounts = S.accounts.filter(x => x.id !== a.id); S.activeId = null; persist();
  enterMode(); toast('Your session expired. Connect your account again.', 'error');
});

// ---------- alerts ----------
const lastSide = {};
function checkAlerts() {
  let fired = false;
  for (const a of S.alerts) {
    if (a.fired) continue;
    const p = mid(a.symbol); if (p == null) continue;
    const hit = a.dir === 'above' ? p >= a.price : p <= a.price;
    if (hit) {
      a.fired = true; a.firedAt = Date.now(); fired = true;
      const msg = `${a.symbol} ${a.dir === 'above' ? 'rose to' : 'fell to'} ${a.price}`;
      toast('🔔 ' + msg, 'ok');
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('KanAIRY price alert', { body: msg }); } catch { /* ignore */ }
    }
  }
  if (fired) { persist(); emit('alerts'); }
}
function paintAlertDot() { $('alertDot').classList.toggle('hide', !S.alerts.some(a => !a.fired)); }
on('quotes', checkAlerts); on('alerts', paintAlertDot); void lastSide;

// ---------- boot ----------
async function boot() {
  applyTheme(); drawThemeBtn(); buildNav();
  mountWatchlist($('panelQuotes')); mountChart($('panelChart')); mountTicket($('panelTrade')); mountPositions($('panelPositions'));
  scr.mountNews(); scr.mountCalendar(); scr.mountAccount(); scr.mountStrategies(); scr.mountLearn(); scr.mountAbout(); scr.mountDeveloper(); scr.mountAssistant(); scr.mountSettings();
  hooks.openTicket ??= () => showScreen('trade');
  paintAlertDot();
  const start = location.hash.slice(1);
  showScreen(SCREENS.includes(start) ? start : 'chart');
  addEventListener('hashchange', () => { const n = location.hash.slice(1); if (SCREENS.includes(n) && n !== document.body.dataset.screen) showScreen(n); });
  addEventListener('resize', () => emit('resize'));
  addEventListener('online', () => { S.online = true; emit('online'); }); addEventListener('offline', () => { S.online = false; emit('online'); });
  await enterMode();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot().catch(e => { console.error(e); toast('Startup problem: ' + e.message, 'error'); });
void store;

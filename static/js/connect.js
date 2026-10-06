// Broker directory + connect flow. The directory comes live from MetaApi's list
// of known MetaTrader servers, so it covers every broker MetaApi can reach.
import { h, icon, clear, store } from './util.js';
import { api } from './api.js';
import { openSheet } from './ui.js';

const hue = s => { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };
const initials = s => s.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const serverKind = n => /demo|practice|test|paper/i.test(n) ? 'Demo' : /live|real|prod/i.test(n) ? 'Live' : '';
let cachedPopular = {};

export function brokerCard(name, servers, onPick) {
  return h('button', { class: 'bk-card', onclick: () => onPick(name, servers) },
    h('div', { class: 'bk-logo', style: { background: `hsl(${hue(name)} 55% 42%)` } }, initials(name)),
    h('div', { class: 'grow' }, h('div', { class: 'n' }, name), h('div', { class: 'c' }, `${servers.length} server${servers.length === 1 ? '' : 's'}`)),
    icon('plus', 16));
}

// Reusable directory: search box + popular list. `onPick(brokerName, servers, platform)`.
export function brokerDirectory(onPick, { platform = store.get('platform', 5) } = {}) {
  let plat = platform, ctl = null, timer = null;
  const list = h('div', { class: 'bk-list' });
  const note = h('div', { class: 'hint', style: { margin: '6px 2px' } });
  const input = h('input', { type: 'search', placeholder: 'Search any broker, e.g. Exness, IC Markets, Standard Bank…', 'aria-label': 'Search brokers',
    oninput: () => { clearTimeout(timer); timer = setTimeout(run, 320); } });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Platform' },
    [5, 4].map(v => h('button', { 'aria-pressed': String(v === plat), onclick: e => { plat = v; store.set('platform', v); seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); run(true); } }, 'MT' + v)));
  const show = (brokers, label) => {
    clear(list);
    const names = Object.keys(brokers).sort((a, b) => brokers[b].length - brokers[a].length || a.localeCompare(b));
    note.textContent = names.length ? label : '';
    if (!names.length) list.append(h('div', { class: 'empty' }, h('b', {}, 'No broker found'), 'Check the spelling, or switch between MT4 and MT5. You can also type your server name by hand on the next step.',
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn sm', onclick: () => onPick(input.value.trim() || 'My broker', [], plat) }, 'Enter server manually'))));
    names.slice(0, 80).forEach(n => list.append(brokerCard(n, brokers[n], (name, servers) => onPick(name, servers, plat))));
  };
  const skeleton = () => { clear(list); for (let i = 0; i < 5; i++) list.append(h('div', { class: 'skeleton' })); };
  async function run(force) {
    ctl?.abort(); ctl = new AbortController();
    const q = input.value.trim();
    skeleton();
    try {
      if (q.length < 2) {
        const key = 'p' + plat;
        if (!cachedPopular[key] || force === true) cachedPopular[key] = (await api.brokersPopular(plat)).brokers;
        show(cachedPopular[key], `Popular MT${plat} brokers`);
      } else {
        const { brokers } = await api.brokersSearch(q, plat, ctl.signal);
        show(brokers, `${Object.keys(brokers).length} MT${plat} broker${Object.keys(brokers).length === 1 ? '' : 's'} matching “${q}”`);
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      clear(list).append(h('div', { class: 'empty' }, h('b', {}, 'Broker directory unavailable'), e.message,
        h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn sm', onclick: () => run(true) }, 'Try again'),
          ' ', h('button', { class: 'btn sm', onclick: () => onPick(input.value.trim() || 'My broker', [], plat) }, 'Enter server manually'))));
    }
  }
  const el = h('div', {}, h('div', { class: 'bk-search' }, h('div', { class: 'row' }, h('div', { class: 'search grow', style: { margin: 0 } }, icon('search', 16), input), seg), note), list);
  setTimeout(run, 0);
  return el;
}

const STEPS = [['provisioning', 'Registering your account'], ['deploying', 'Starting your trading terminal'], ['connecting', 'Signing in to the broker'], ['syncing', 'Loading positions and prices']];

export function openConnect(onConnected, preset) {
  const sheet = openSheet({ title: 'Connect a broker', wide: true, body: h('div') });
  const body = sheet.body;
  const pickBroker = () => { clear(body).append(h('p', { class: 'hint', style: { marginBottom: '10px' } }, 'Pick your broker. Your login stays between you and the broker; KanAIRY never stores your password.'),
    brokerDirectory((name, servers, plat) => pickServer(name, servers, plat))); sheet.setFooter([]); };

  const pickServer = (broker, servers, plat) => {
    const manual = h('input', { class: 'input', placeholder: 'Server name exactly as in MetaTrader, e.g. Exness-MT5Real8', 'aria-label': 'Server name' });
    const filter = h('input', { class: 'input', type: 'search', placeholder: 'Filter servers…' });
    const wrap = h('div', { class: 'srv' });
    const draw = () => { clear(wrap); const q = filter.value.toLowerCase();
      servers.filter(s => s.toLowerCase().includes(q)).slice(0, 200).forEach(s => wrap.append(h('button', { onclick: () => credentials(broker, s, plat) }, h('span', {}, s), serverKind(s) ? h('span', { class: 'tag' }, serverKind(s)) : null)));
      if (!wrap.children.length && servers.length) wrap.append(h('div', { class: 'hint' }, 'No server matches that filter.')); };
    filter.addEventListener('input', draw); draw();
    clear(body).append(h('button', { class: 'btn sm', onclick: pickBroker }, '← Brokers'),
      h('h3', { style: { margin: '12px 0 2px' } }, broker), h('p', { class: 'hint', style: { marginBottom: '10px' } }, `MT${plat} · choose the server shown on your trading account`),
      ...(servers.length ? [filter, h('div', { style: { height: '8px' } }), wrap] : []),
      h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, servers.length ? 'Not listed? Enter it manually' : 'Server name'), manual,
        h('button', { class: 'btn primary', style: { marginTop: '6px' }, onclick: () => { const v = manual.value.trim(); if (v.length < 2) { manual.classList.add('bad'); manual.focus(); return; } credentials(broker, v, plat); } }, 'Continue')));
    sheet.setFooter([]);
  };

  const credentials = (broker, server, plat) => {
    const login = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'username', placeholder: 'Account number (digits)', 'aria-label': 'Account number' });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Trading password', 'aria-label': 'Password' });
    const err = h('div', { class: 'err' });
    const show = h('button', { class: 'btn sm', type: 'button', onclick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; show.textContent = pw.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const go = h('button', { class: 'btn primary block' }, 'Connect');
    go.onclick = () => {
      err.textContent = '';
      if (!/^\d{3,12}$/.test(login.value.trim())) { login.classList.add('bad'); err.textContent = 'Account number must be digits only.'; return; }
      if (!pw.value) { pw.classList.add('bad'); err.textContent = 'Enter your trading password (not the investor password).'; return; }
      run(broker, server, plat, login.value.trim(), pw.value);
    };
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
    clear(body).append(h('button', { class: 'btn sm', onclick: () => pickServer(broker, [], plat) }, '← Server'),
      h('div', { class: 'info', style: { margin: '12px 0' } }, h('div', {}, h('span', {}, 'Broker'), h('b', {}, broker)), h('div', {}, h('span', {}, 'Server'), h('b', {}, server)), h('div', {}, h('span', {}, 'Platform'), h('b', {}, 'MT' + plat))),
      h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', {}, 'Account number'), login),
        h('div', { class: 'field' }, h('label', {}, 'Password'), h('div', { class: 'row' }, h('div', { class: 'grow' }, pw), show)),
        err, go,
        h('p', { class: 'hint' }, 'Use the trading password. A demo account is the safest way to try KanAIRY first.')));
    sheet.setFooter([]); login.focus();
  };

  async function run(broker, server, plat, login, password) {
    const stepEls = STEPS.map(([k, label]) => h('div', { class: 'step', dataset: { k } }, h('span', { class: 'spin', style: { visibility: 'hidden' } }), label));
    const msg = h('div', { class: 'hint' }, 'Starting…');
    clear(body).append(h('h3', {}, 'Connecting to ' + broker), h('p', { class: 'hint' }, 'The first connection can take a minute or two while your terminal starts.'), h('div', { class: 'steps' }, stepEls), msg);
    sheet.setFooter([h('button', { class: 'btn', onclick: () => sheet.close() }, 'Cancel')]);
    let cancelled = false; const prevClose = sheet.close; sheet.close = () => { cancelled = true; prevClose(); };
    try {
      const { job, poll } = await api.connect({ login, password, server, platform: 'mt' + plat, broker_name: broker });
      const t0 = Date.now();
      while (!cancelled) {
        await new Promise(r => setTimeout(r, 1500));
        if (Date.now() - t0 > 240000) throw new Error('Connecting is taking too long. Check the server name, account number and trading password, then try again.');
        const st = await api.connectStatus(job, poll);
        const idx = STEPS.findIndex(s => s[0] === st.state);
        stepEls.forEach((el, i) => { el.className = 'step' + (i < idx ? ' done' : i === idx ? ' now' : ''); el.firstChild.style.visibility = i === idx ? 'visible' : 'hidden'; el.firstChild.className = i < idx ? '' : 'spin'; if (i < idx) { el.firstChild.textContent = '✓'; el.firstChild.style.visibility = 'visible'; } });
        msg.textContent = st.message || '';
        if (st.state === 'failed') throw Object.assign(new Error(st.message), { code: st.code });
        if (st.state === 'ready') { prevClose(); onConnected({ token: st.token, account: st.account, broker, server, platform: 'mt' + plat, login }); return; }
      }
    } catch (e) {
      if (cancelled) return;
      clear(body).append(h('div', { class: 'empty' }, h('b', {}, 'Could not connect'), e.message,
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn primary', onclick: () => credentials(broker, server, plat) }, 'Check details'))));
      sheet.setFooter([h('button', { class: 'btn', onclick: () => sheet.close() }, 'Close')]);
    }
  }
  if (preset) pickServer(preset.name, preset.servers || [], preset.plat || 5); else pickBroker();
  return sheet;
}

// App state, persistence and a tiny event bus.
import { store } from './util.js';

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => { bus.addEventListener(name, e => fn(e.detail)); };

const DEFAULT_FAVS_PUBLIC = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'US500', 'NAS100', 'BTCUSD', 'ETHUSD', 'AAPL', 'USDZAR'];

export const S = {
  accounts: store.get('accounts', []),          // [{id,label,broker,login,server,platform,token}]
  activeId: store.get('activeId', null),
  account: null,                                 // live account info (broker mode)
  positions: [], orders: [], deals: [],
  instruments: [],                               // [{symbol,name,cat,digits,...}]
  quotes: {},                                    // symbol -> {bid,ask,time,prevClose?,dayRef?}
  symbol: store.get('symbol', 'EURUSD'),
  tf: store.get('tf', 'H1'),
  chartType: store.get('chartType', 'candles'),
  indicators: store.get('indicators', [{ uid: 1, id: 'ema', params: { period: 21 } }]),
  alerts: store.get('alerts', []),               // [{id,symbol,price,dir,created,fired}]
  settings: { theme: 'dark', confirmOrders: true, colorblind: false, defaultVolume: 0.01, ...store.get('settings', {}) },
  online: true,
  lastSnapshot: 0,
  catFilter: 'Favorites',
  query: '',
};

export const active = () => S.accounts.find(a => a.id === S.activeId) || null;
export const isBroker = () => !!active();
export const favKey = () => 'favs.' + (active()?.id || 'public');
export const favorites = () => store.get(favKey(), isBroker() ? [] : DEFAULT_FAVS_PUBLIC);
export const setFavorites = f => store.set(favKey(), f);
export const toggleFavorite = sym => {
  const f = favorites(); const i = f.indexOf(sym);
  if (i >= 0) f.splice(i, 1); else f.push(sym);
  setFavorites(f); emit('favorites');
};
export const inst = sym => S.instruments.find(i => i.symbol === sym);
export const digitsOf = sym => inst(sym)?.digits ?? (S.quotes[sym]?.bid > 500 ? 2 : S.quotes[sym]?.bid > 20 ? 3 : 5);

export function persist() {
  store.set('accounts', S.accounts); store.set('activeId', S.activeId);
  store.set('symbol', S.symbol); store.set('tf', S.tf); store.set('chartType', S.chartType);
  store.set('indicators', S.indicators); store.set('alerts', S.alerts); store.set('settings', S.settings);
}

export const drawingsFor = sym => store.get('draw.' + sym, []);
export const saveDrawings = (sym, list) => store.set('draw.' + sym, list);

export const TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'];
export const TF_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN: 2592000 };

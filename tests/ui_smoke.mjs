import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
const base = 'http://localhost:8765', out = process.env.OUT || '/tmp/shots'; import fs from 'node:fs'; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const errs = [];
for (const [name, vp] of [['desktop', { width: 1366, height: 800 }], ['mobile', { width: 390, height: 780 }]]) {
  const ctx = await b.newContext({ viewport: vp }); const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(name + ' pageerror: ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(name + ' console: ' + m.text()); });
  await pg.goto(base + '/#chart'); await pg.waitForTimeout(2500); await pg.screenshot({ path: `${out}/${name}-chart.png` });
  if (name === 'mobile') for (const s of ['quotes', 'trade', 'positions', 'news', 'calendar', 'strategies', 'settings']) { await pg.evaluate(s => location.hash = s, s); await pg.waitForTimeout(700); await pg.screenshot({ path: `${out}/${name}-${s}.png` }); }
  else for (const s of ['news', 'strategies', 'account']) { await pg.evaluate(s => location.hash = s, s); await pg.waitForTimeout(800); await pg.screenshot({ path: `${out}/${name}-${s}.png` }); }
  await ctx.close();
}
await b.close(); console.log(errs.length ? errs.join('\n') : 'no errors');

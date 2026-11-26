import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, signIn } from './helpers.js';

/* The Scoreboard also shows real bugs from the project's own history (D52). It is read only: starting a replay is a command. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-history-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const CART = 'export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n';
const BUG = `${CART}\nexport function render(el, text) {\n  el.innerHTML = text;\n  return el;\n}\n`;
const FIXED = BUG.replace('el.innerHTML = text;', 'el.textContent = text;');
const commits = [
  { files: { 'src/cart.js': CART }, message: 'Base' },
  { files: { 'src/cart.js': BUG }, message: 'Show errors in the cart <b>now</b>' },
  { files: { 'src/cart.js': FIXED }, message: 'fix: show errors as text' }
];

test('the page’s data says how to start a replay, then carries the scoreboard of one, and starting is not something the page can do', async () => {
  const repo = makeRepo(commits, 'shop-website');
  const d = await startDashboard({ repo: repo.dir });
  try {
    const page = await signIn(d);
    const before = (await page.get('/api/calibration')).json;
    assert.equal(before.past.board, null);
    assert.match(before.past.command, /^assay calibrate history start --repo "/);
    assert.equal((await page.post('/api/history/start', {})).status, 404, 'there is no way to start one from the page');
    core.calibration.startHistory(repo.dir);
    const after = (await page.get('/api/calibration')).json;
    assert.equal(after.past.board.total, 1);
    assert.equal(after.past.board.rows[0].id, 'free');
    assert.match(after.past.prompt, /Review 1 case with Assay's reviewer panel/);
  } finally { await d.close(); }
});

t('the Scoreboard tab shows the replay: the free checks scored, the commit it came in at as text, and how to forget it', async () => {
  const repo = makeRepo(commits, 'shop-website');
  core.calibration.startHistory(repo.dir);
  const d = await startDashboard({ repo: repo.dir });
  const browser = await core.Browser.launch(core.findBrowser()!);
  try {
    const p = await browser.newPage();
    await p.viewport(1280, 900, false);
    await p.goto(d.url);
    const text = (sel: string): Promise<string> => p.evaluate<string>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:''})()`);
    const count = (sel: string): Promise<number> => p.evaluate<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const until = async (what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(150); }
      throw new Error(`${what} never happened: ${await text('#main')}`);
    };
    await until('the timeline', async () => (await count('table.tl')) > 0);
    await p.evaluate("document.querySelector('#nav a[href=\"#/reviewers\"]').click()");
    await until('the panel', async () => (await count('.rgrid .rcard')) > 0);
    await p.evaluate("document.querySelector('[data-act=\"rv-tab\"][data-v=\"score\"]').click()");
    await until('your own history', async () => /From your own history/.test(await text('#main')) && /real past bugs were caught by the free checks alone/.test(await text('#main')));
    const main = await text('#main');
    assert.match(main, /src\/cart\.js:\d+/);
    assert.match(main, /came in with “Show errors in the cart <b>now<\/b>”, fixed by “fix: show errors as text”/, 'a commit subject is shown as text');
    assert.equal(await count('.pastbugs b'), 0, 'it did not become an element');
    assert.match(main, /assay calibrate history clean/);
    assert.match(main, /A removed line is a proxy for the defect/);
    assert.ok((await count('.pastbugs li')) === 1);
    assert.deepEqual(p.events.exceptions, [], 'no uncaught errors');
    assert.deepEqual(p.events.consoleErrors, [], 'no console errors');
    await p.close();
  } finally { await browser.close(); await d.close(); }
});

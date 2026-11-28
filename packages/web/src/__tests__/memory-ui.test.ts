import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo } from './helpers.js';

/* The Memory screen in a real browser: the list, the detail, search, the packs, and learning from history, start to finish.
   Skipped, loudly, where there is no Chromium-based browser. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-memui-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const call = (name: string, fn: string): string => `export function ${name}(view, items) {\n  return view.${fn}(items);\n}\n`;

t('memory in the page: browse, search, switch a pack, learn from history and add what it finds', async () => {
  const repo = makeRepo([
    { files: { 'src/a.js': call('a', 'legacyTotals'), 'src/b.js': call('b', 'legacyTotals'), 'src/c.js': call('c', 'legacyTotals') }, message: 'Totals' },
    { files: { 'src/a.js': call('a', 'totals') }, message: 'fix: a was stale <img src=x onerror="window.__pwned=1">' },
    { files: { 'src/b.js': call('b', 'totals') }, message: 'fix: b was stale' },
    { files: { 'src/c.js': call('c', 'totals') }, message: 'fix: c ignored shipping' }
  ]);
  const d = await startDashboard({ repo: repo.dir });
  const browser = await core.Browser.launch(core.findBrowser()!);
  try {
    const p = await browser.newPage();
    await p.viewport(1280, 800, false);
    await p.goto(d.url);
    const text = (sel: string): Promise<string> => p.evaluate<string>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:''})()`);
    const count = (sel: string): Promise<number> => p.evaluate<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const waitFor = async (sel: string, ms = 20_000): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await p.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)) return; await sleep(100); }
      throw new Error(`${sel} never showed up: ${await text('#main')}`);
    };
    const click = (sel: string): Promise<unknown> => p.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

    await waitFor('table.tl');
    assert.match(await text('#nav'), /Memory/, 'Memory is in the sidebar');
    await click('#nav a[href="#/memory"]');
    await waitFor('.mem .memrow');
    assert.equal(await text('.page-title'), 'Memory');

    // the list: every entry, the detail of the first, a different detail after a click
    assert.ok((await count('.memrow')) >= 50, 'the bundled packs fill the list');
    assert.match(await text('.mem article h3'), /\S/);
    const first = await text('.mem article h3');
    await p.evaluate("document.querySelectorAll('.memrow')[3].click()");
    await sleep(300);
    assert.notEqual(await text('.mem article h3'), first, 'a click shows another entry');
    assert.match(await p.evaluate<string>('location.hash'), /^#\/memory\?id=/, 'and it is in the address');

    // search narrows the list without rebuilding the page (the box keeps its place)
    const all = await count('.memrow');
    await p.evaluate("(function(){var q=document.querySelector('#memq');q.focus();q.value='html';q.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await sleep(300);
    const n = await count('.memrow');
    assert.ok(n >= 1 && n <= 10 && n < all / 4, `search found ${n} of ${all}`);
    assert.equal(await p.evaluate<boolean>("document.activeElement && document.activeElement.id === 'memq'"), true, 'typing never loses its place');
    await click('[data-act="mem-kind"][data-v="question"]');
    await sleep(300);
    assert.ok((await count('.memrow')) === 0 || (await text('#memlist')).length > 0);
    await p.evaluate("(function(){var q=document.querySelector('#memq');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await sleep(300);
    assert.ok((await count('.memrow')) >= 15, 'the starter questions are there');
    await click('[data-act="mem-kind"][data-v="all"]');

    // standards: switching a pack off is kept
    await click('[data-act="mem-tab"][data-v="standards"]');
    await waitFor('.pack');
    assert.equal(await count('.pack'), 6);
    assert.match(await text('#main'), /OWASP Top 10/);
    assert.match(await text('#main'), /2025/);
    await click('input[data-act="mem-pack"][data-id="review-questions"]');
    await sleep(700);
    const packs = await p.evaluate<Array<{ id: string; on: boolean }>>("fetch('/api/memory', { credentials: 'same-origin' }).then(function(r){return r.json()}).then(function(j){return j.packs.map(function(x){return {id:x.id,on:x.on}})})");
    assert.equal(packs.find(x => x.id === 'review-questions')!.on, false);
    await click('input[data-act="mem-pack"][data-id="review-questions"]');
    await sleep(700);

    // learn from history: read it, see what recurs, add it
    await click('[data-act="mem-tab"][data-v="mine"]');
    await waitFor('[data-act="mem-mine"]');
    await click('[data-act="mem-mine"]');
    await waitFor('.pack-2', 30_000);
    assert.match(await text('#main'), /Read 3 commits/);
    assert.match(await text('#main'), /3 are fixes/);
    assert.match(await text('.pack-2'), /\.legacyTotals\(/);
    assert.match(await text('.pack-2'), /Worth a detector/);
    assert.match(await text('.pack-2'), /replaced by\s+\.totals\(/);
    assert.equal(await p.evaluate<boolean>('typeof window.__pwned === "undefined"'), true, 'a commit subject with markup in it did not run');
    await click('[data-act="mem-add"]');
    for (let i = 0; i < 100 && !/Added as L-1/.test(await text('.pack-2')); i++) await sleep(100);
    assert.match(await text('.pack-2'), /Added as L-1/);

    // and it is now an entry of its own, with a pattern and the fixes behind it
    await click('[data-act="mem-tab"][data-v="mistakes"]');
    await waitFor('.mem .memrow');
    await click('[data-act="mem-kind"][data-v="learned"]');
    await sleep(300);
    assert.equal(await count('.memrow'), 1);
    await click('.memrow');
    await sleep(300);
    assert.match(await text('.mem article'), /Pattern/);
    assert.match(await text('.mem article'), /Fixed before in this project \(3 times\)/);
    await click('[data-act="mem-remove"]');
    await sleep(300);
    assert.match(await text('.mem article'), /Press again to forget it/);
    await click('[data-act="mem-remove"]');
    await sleep(700);
    assert.equal(await count('.memrow'), 0, 'forgotten');

    assert.deepEqual(p.events.exceptions, [], 'no uncaught errors');
    assert.deepEqual(p.events.consoleErrors, [], 'no console errors');
    assert.deepEqual(p.events.failed.filter(f => !/favicon/.test(f.url)), [], 'every request the page made worked');
    await p.close();
  } finally {
    await browser.close();
    await d.close();
  }
});

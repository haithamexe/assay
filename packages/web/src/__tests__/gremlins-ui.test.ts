import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, signIn } from './helpers.js';

/* The Gremlins screen: the kept runs, what each found with its steps, the comparison with the run before, and no button that runs
   anything (it needs the person's own `allow-run --writes`, so the page shows the command). Skipped, loudly, where there is no
   Chromium-based browser. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-gremlins-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const EVIL = '<img src=x onerror="window.__pwned=1">';

function report(repo: string, seed: number, findings: Array<{ kind: 'exception' | 'server'; text: string; step: number }>): import('@assay/core').GremlinsReport {
  const trail = [{ click: 'text=Save' }, { type: 'x', into: '#note' }, { click: 'text=Load', double: true }, { press: 'Enter' as const }];
  return {
    schema: 'assay.gremlins/1', id: `gr-2026112710000${seed}-abcde${seed}`, repo, name: 'shop-website', commit: 'a'.repeat(40), mode: 'running', url: 'http://127.0.0.1:3000', seed, planned: 40, actions: 40, phone: false, bold: false,
    browser: 'chrome', before: 0, pages: ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000/about'], skipped: ['Delete everything'], blocked: ['pay.example.test'], notes: ['The browser refused to talk to pay.example.test: not on this computer.'],
    replay: `assay gremlins --url http://127.0.0.1:3000 --seed ${seed} --actions 40`, start: '/', signedIn: seed === 2, trail, previous: null, gone: [], secs: 12, createdAt: `2026-11-27T10:00:0${seed}.000Z`,
    findings: findings.map((f, i) => ({
      id: `g-${f.kind}${i}${seed}`, kind: f.kind, severity: f.kind === 'exception' ? 'high' as const : 'medium' as const, tier: 'proven' as const, title: f.kind === 'exception' ? 'The page throws an uncaught error' : 'The server answers with an error',
      text: f.text, count: 2, step: f.step, steps: trail.slice(0, f.step), fix: 'Handle it.'
    }))
  };
}

t('gremlins in the page: the kept runs, the steps behind a problem, the comparison, and a command instead of a run button', async () => {
  const repo = makeRepo([{ files: { 'README.md': '# shop\n' }, message: 'Start' }]);
  const one = report(repo.dir, 1, [{ kind: 'exception', text: `TypeError: ${EVIL}`, step: 2 }, { kind: 'server', text: 'GET /api/items → 500', step: 3 }]);
  core.compareGremlinRuns(one);
  core.keepGremlinRun(one);
  const two = report(repo.dir, 2, [{ kind: 'server', text: 'GET /api/items → 500', step: 3 }, { kind: 'exception', text: 'Error: another one', step: 4 }]);
  two.findings[0].id = one.findings[1].id;
  core.compareGremlinRuns(two);
  core.keepGremlinRun(two);
  assert.deepEqual(two.findings.map(f => f.since), ['before', 'new']);
  assert.deepEqual(two.gone.map(g => g.kind), ['exception'], 'what the first run had and this one did not meet');

  const d = await startDashboard({ repo: repo.dir });
  // the interface: nothing about the trail, the steps as sentences, commands for the terminal, and only this project's runs
  const s = await signIn(d);
  const list = (await s.get('/api/gremlins')).json;
  assert.deepEqual([list.allowed, list.writes], [false, false]);
  assert.match(list.command, /assay allow-run --writes/);
  assert.deepEqual(list.runs.map((r: { id: string }) => r.id), [two.id, one.id], 'newest first');
  assert.deepEqual([list.runs[0].findings, list.runs[0].newCount, list.runs[0].goneCount], [2, 1, 1]);
  const run = (await s.get(`/api/gremlins/run?id=${two.id}`)).json;
  assert.equal(run.trail, undefined);
  assert.equal(run.trailLength, 4);
  assert.deepEqual(run.findings[1].stepsText, ['click “Save”', 'type "x" into #note', 'double-click “Load”', 'press Enter'].slice(0, 4));
  assert.match(run.findings[1].replayCommand, /^assay gremlins replay gr-\d+-[0-9a-f]+ --finding g-exception1/);
  assert.equal((await s.get('/api/gremlins/run?id=gr-nothing')).status, 404);
  assert.equal((await s.get('/api/gremlins/run')).status, 400);
  assert.equal((await s.post('/api/gremlins', {})).status, 404, 'there is no request that starts a run');

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
    assert.match(await text('#nav'), /Gremlins/, 'Gremlins is in the sidebar');
    await click('#nav a[href="#/gremlins"]');
    await waitFor('.mem .memrow');
    assert.equal(await text('.page-title'), 'Gremlins');
    assert.equal(await count('.memrow'), 2);
    // switched off: the page says why, shows the commands, and has no button that would run anything
    assert.match(await text('.callout'), /Running gremlins needs your OK first/);
    assert.match(await text('#main'), /assay allow-run --writes/);
    assert.equal(await count('button[data-act="copycmd"]') > 0, true);
    assert.ok(!/\bRun now\b|\bStart a run\b/i.test(await text('#main')));

    // the newest run is open: its problems, with a New badge on the one the last run didn't have, and the steps in words
    assert.match(await text('.mem article'), /gr-\d+-abcde2/);
    assert.match(await text('.mem article'), /Error: another one/);
    assert.match(await text('.mem article'), /New/);
    assert.match(await text('.mem article'), /There before/);
    assert.match(await text('.mem article'), /click “Save”/);
    assert.match(await text('.mem article'), /double-click “Load”/);
    assert.match(await text('.mem article'), /1 problem gone since the last run/);
    assert.match(await text('.mem article'), /refused to talk to pay\.example\.test/);
    assert.match(await text('.mem article'), /Left alone because they look destructive: Delete everything/);
    assert.match(await text('.mem article'), /Signed in/);
    assert.match(await text('.mem article'), /assay gremlins replay/);

    // another run, from the list; the first run has nothing to compare with, and its markup is text
    await p.evaluate("document.querySelectorAll('.memrow')[1].click()");
    await sleep(500);
    assert.match(await p.evaluate<string>('location.hash'), /^#\/gremlins\?id=gr-/);
    assert.match(await text('.mem article'), /TypeError: <img src=x/);
    assert.match(await text('.mem article'), /nothing yet: this is the first run/);
    assert.equal(await count('.mem article img'), 0, 'markup from the browser is shown as text');
    assert.equal(await p.evaluate<boolean>('typeof window.__pwned === "undefined"'), true);
    // the link to the run it was compared with
    await p.evaluate("document.querySelectorAll('.memrow')[0].click()");
    await sleep(400);
    await click('.linkbtn');
    await sleep(500);
    assert.match(await text('.mem article'), /gr-\d+-abcde1/);

    // once a person has said yes in the terminal, the page shows how to run it, still without running it
    core.setRepoSettings(repo.dir, { allow: true, writes: true });
    await p.goto(`${d.origin}/?again=1#/gremlins`);
    await waitFor('.mem .memrow');
    await sleep(300);
    assert.match(await text('#main'), /Run it in a terminal/);
    assert.match(await text('#main'), /assay gremlins --url http:\/\/localhost:3000/);
    assert.ok(!/needs your OK first/.test(await text('#main')));
  } finally { await browser.close(); await d.close(); }
});

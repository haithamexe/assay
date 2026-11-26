import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo } from './helpers.js';

/* The Scoreboard in a real browser: what would be planted, planting, the free checks scored, and the table filling in as reviewers report.
   Skipped, loudly, where there is no Chromium-based browser. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-calui-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

t('the scoreboard in the page: what would be planted, plant, the free checks scored, then reviewers reporting', async () => {
  const repo = makeRepo([{ files: { 'README.md': '# shop\n', 'web/app.js': 'export const a = 1;\n', 'web/site.css': '.a { color: red; }\n', 'api/server.py': 'x = 1\n', 'package.json': '{ "name": "shop" }\n' }, message: 'Base' }]);
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
    const click = (sel: string): Promise<unknown> => p.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

    await until('the timeline', async () => (await count('table.tl')) > 0);
    await click('#nav a[href="#/reviewers"]');
    await until('the panel', async () => (await count('.rgrid .rcard')) > 0);
    assert.match(await text('.segmented'), /The panel/);
    await click('[data-act="rv-tab"][data-v="score"]');
    await until('the scoreboard intro', async () => /Who do you trust\?/.test(await text('#main')));
    assert.match(await text('#main'), /would get \d+ planted bugs/);
    assert.match(await text('#main'), /Nothing in your project is touched/);
    assert.match(await p.evaluate<string>('location.hash'), /tab=score/, 'the tab is in the address');

    await click('[data-act="rv-calibrate"]');
    await until('the scoreboard', async () => (await count('.mx-row.mx-8')) > 5 && /planted bugs were caught by the free checks alone/.test(await text('#main')));
    assert.match(await text('.callout'), /no false alarms on the clean twins/);
    assert.equal(await count('table.table tbody tr'), 8, 'the free checks, six reviewers and the plain review');
    assert.match(await text('table.table'), /Free checks \(no model\)/);
    assert.match(await p.evaluate<string>("document.querySelector('#main textarea.brief').value"), /Review two cases with Assay's reviewer panel/);
    assert.ok((await count('.mx-row.mx-8 .C')) >= 1, 'a bug caught with proof');
    assert.ok((await count('.mx-row.mx-8 .m')) >= 1, 'a bug the free checks missed');
    assert.match(await text('#main'), /The reviewers have not been run yet/);

    // the agent (this test) runs the reviewers; the table fills in by itself
    const run = core.calibration.latestRun(repo.dir)!;
    const at = (id: string): { file: string; line: number } => { const b = run.planted.bugs.find(x => x.id === id)!; return { file: b.file, line: b.line }; };
    const report = (which: 'planted' | 'control', who: string, claims: Array<{ file: string; line: number }>): void => {
      const c = core.loadCase(which === 'planted' ? run.planted.case : run.control.case)!;
      const lens = core.reviewers.reviewerFor(who)!.lens;
      const gated = core.applyClaims(c.repo, c, claims.map(x => ({ title: 'Something is wrong here', lens, file: x.file, line: x.line, what: 'This line does something it should not, and here is why it matters.', source: `reviewer:${lens}` })));
      core.saveCase(c);
      core.reviewers.recordSubmission(c, who, gated, { round: 1, done: true, tokens: 1200, claims: claims.length, disputes: [] });
    };
    for (const lens of ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Performance']) {
      report('planted', lens, lens === 'Correctness' ? [at('off-by-one'), at('swapped-args')] : lens === 'Security' ? [at('html-sink')] : []);
      report('control', lens, []);
    }
    await until('the reviewers on the board', async () => !/The reviewers have not been run yet/.test(await text('#main')) && /With the reviewers: \d+ of \d+ flagged by someone/.test(await text('#main')), 15_000);
    assert.match(await text('table.table'), /Keep|Caught none of/);
    assert.equal(await count('#main textarea.brief'), 0, 'the prompt goes away once they have run');
    assert.ok((await count('.mx-row.mx-8 .h')) >= 3, 'flags without proof');

    // clearing
    await click('[data-act="rv-calclear"]');
    await until('cleared', async () => /Who do you trust\?/.test(await text('#main')));

    assert.deepEqual(p.events.exceptions, [], 'no uncaught errors');
    assert.deepEqual(p.events.consoleErrors, [], 'no console errors');
    assert.deepEqual(p.events.failed.filter(f => !/favicon/.test(f.url)), [], 'every request the page made worked');
    await p.close();
  } finally {
    await browser.close();
    await d.close();
  }
});

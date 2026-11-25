import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo } from './helpers.js';

/* The Reviewers screen in a real browser: the preview and its cost, the budget, planning, and the screen following an agent that reports.
   Skipped, loudly, where there is no Chromium-based browser. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-rvui-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const logic = Array.from({ length: 16 }, (_, i) => `def step_${i}(order):\n    return order.total + ${i}\n`).join('\n');

t('reviewers in the page: the cost first, a budget, a kept plan, and the screen following what an agent reports', async () => {
  const repo = makeRepo([
    { files: { 'README.md': '# shop\n' }, message: 'Base' },
    { files: { 'src/cart.py': `import os\n\n${logic}\ndef export(cmd):\n    os.system(cmd)\n`, 'web/app.css': '.badge { position: absolute; right: 10px; }\n' }, message: 'Add the cart' }
  ]);
  const d = await startDashboard({ repo: repo.dir });
  const browser = await core.Browser.launch(core.findBrowser()!);
  try {
    const p = await browser.newPage();
    await p.viewport(1280, 900, false);
    await p.goto(d.url);
    const text = (sel: string): Promise<string> => p.evaluate<string>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:''})()`);
    const count = (sel: string): Promise<number> => p.evaluate<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const until = async (what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(150); }
      throw new Error(`${what} never happened: ${await text('#main')}`);
    };
    const click = (sel: string): Promise<unknown> => p.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const setValue = (sel: string, v: string, ev: string): Promise<unknown> => p.evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event(${JSON.stringify(ev)},{bubbles:true}));})()`);

    await until('the timeline', async () => (await count('table.tl')) > 0);
    assert.match(await text('#nav'), /Reviewers/, 'Reviewers is in the sidebar');
    await click('#nav a[href="#/reviewers"]');
    await until('the panel', async () => (await count('.rgrid .rcard')) > 0);
    assert.equal(await text('.page-title'), 'Reviewers');
    assert.equal(await count('.rcard'), 7);
    assert.equal(await count('.step'), 6);
    assert.match(await text('.callout'), /This is a preview/);
    assert.match(await text('.callout'), /Assay doesn.t call a model/);
    assert.match(await text('#main'), /tokens not spent/);
    assert.match(await p.evaluate<string>('location.hash'), /^#\/reviewers\?id=c-/, 'the case is in the address');
    assert.ok((await count('.rcard.skipped')) >= 1, 'a reviewer the change doesn’t touch says so');

    // a free-only budget switches every reviewer off, and the page says why
    await setValue('#rvbudget', '0', 'change');
    await until('free only', async () => /Free checks only/.test(await text('.callout')));
    assert.equal(await count('.rcard.skipped'), 7);
    await setValue('#rvbudget', '40000', 'change');
    await until('40k again', async () => /This is a preview/.test(await text('.callout')));

    // plan them: kept with the case, and the prompt to give an agent is there
    await setValue('#rvreq', 'Add the cart with an export', 'input');
    await click('[data-act="rv-plan"]');
    await until('kept', async () => /Kept with the case/.test(await text('#main')));
    assert.match(await text('#main'), /Where it stands: waiting/);
    assert.match(await p.evaluate<string>("document.querySelector('textarea.brief').value"), /reviewers_plan with case "c-.*request "Add the cart with an export"/);
    assert.ok(core.loadCase(core.listCases()[0].id)!.panel, 'the plan is on the case');

    // the agent (this test) fetches a brief and reports; the page follows by itself
    const caseId = core.listCases()[0].id;
    const c = core.loadCase(caseId)!;
    core.reviewers.reviewerBrief(c, 'Security');
    await until('Working', async () => /Working/.test(await text('.rgrid')), 8000);
    const c2 = core.loadCase(caseId)!;
    const r = core.applyClaims(repo.dir, c2, [{ title: 'A command is run from an argument', lens: 'Security', file: 'src/cart.py', line: 36, what: 'export passes cmd to os.system, so whoever controls it runs anything.', source: 'reviewer:Security' }, { title: 'Cites nothing', lens: 'Security', file: 'src/missing.py', line: 3, what: 'This is not a line of the change at all.', source: 'reviewer:Security' }]);
    core.saveCase(c2);
    core.reviewers.recordSubmission(c2, 'Security', r, { round: 1, done: true, tokens: 2100, claims: 2, disputes: [] });
    await until('Reported', async () => /Reported/.test(await text('.rgrid')), 10_000);
    assert.match(await text('.rgrid'), /2\.1k tokens reported/);
    await until('the gate', async () => /were dropped|was dropped/.test(await text('#main')), 8000);
    assert.match(await text('#main'), /Cites nothing/);
    assert.match(await text('#main'), /Cross-examination opens when every reviewer has reported|Cross-examination is open/);

    // the case file and settings know about it
    await p.evaluate('location.hash = "#/case?id=" + ' + JSON.stringify(caseId));
    await until('the case file', async () => (await count('.verdict')) > 0);
    assert.match(await text('.verdict-foot'), /Reviewers: \d+ of \d+ reported/);
    await p.evaluate("location.hash = '#/settings'");
    await until('settings', async () => (await count('.section')) > 0);
    assert.match(await text('#main'), /Stop hook|Stop hook makes/);
    assert.match(await text('#main'), /assay hook install/);

    assert.deepEqual(p.events.exceptions, [], 'no uncaught errors');
    assert.deepEqual(p.events.consoleErrors, [], 'no console errors');
    assert.deepEqual(p.events.failed.filter(f => !/favicon/.test(f.url)), [], 'every request the page made worked');
    await p.close();
  } finally {
    await browser.close();
    await d.close();
  }
});

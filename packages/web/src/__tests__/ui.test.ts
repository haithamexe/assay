import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, SECRET } from './helpers.js';

/* The real page in a real browser (whichever Chromium-based one is installed), driven by Assay's own DevTools client.
   Skipped, loudly, where there is none. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-ui-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

t('the page loads, shows the timeline and the case file, escapes what came from git, and the policy stops inline script', async () => {
  const repo = makeRepo([
    { files: { 'README.md': '# shop\n' }, message: 'Base' },
    { files: { 'config/settings.py': `AWS_KEY = "${SECRET}"\n` }, message: 'Add settings <img src=x onerror="window.__pwned=1">' }
  ]);
  const d = await startDashboard({ repo: repo.dir });
  const browser = await core.Browser.launch(core.findBrowser()!);
  try {
    const p = await browser.newPage();
    const violations: string[] = [];
    p.cdp.on('Log.entryAdded', (params: { entry?: { text?: string; source?: string } }) => { if (/Content Security Policy|Refused to/i.test(params.entry?.text ?? '')) violations.push(String(params.entry?.text)); });
    await p.viewport(1280, 800, false);
    await p.goto(d.url);

    const text = (sel: string): Promise<string> => p.evaluate<string>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:''})()`);
    const waitFor = async (sel: string, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await p.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)) return; await sleep(100); }
      throw new Error(`${sel} never showed up: ${await text('#main')}`);
    };

    await waitFor('table.tl');
    assert.equal(await text('.page-title'), 'Timeline');
    assert.match(await text('#project'), /shop-website/);
    const subjects = await p.evaluate<string[]>("[].map.call(document.querySelectorAll('.c-msg'), function(e){return e.textContent})");
    assert.ok(subjects.includes('Add settings <img src=x onerror="window.__pwned=1">'), `what came from git is shown as text: ${subjects.join(' | ')}`);
    assert.equal(await p.evaluate<number>("document.querySelectorAll('.c-msg img').length"), 0, 'it did not become an element');
    assert.equal(await p.evaluate<boolean>('typeof window.__pwned === "undefined"'), true, 'and nothing ran');

    // pick the whole branch and open the case file
    await p.evaluate("document.querySelector('[data-act=\"openCase\"]').click()");
    await waitFor('.verdict');
    assert.match(await text('.verdict h2'), /Blocked: 1 proven problem/);
    assert.match(await text('.citem'), /AWS access key/);
    assert.ok(!(await text('#main')).includes('QWERTYUIOP123456'), 'a secret is not on the page');
    assert.match(await text('#main'), /AKIA…\(20 characters\)/);
    assert.match(await p.evaluate<string>('location.hash'), /^#\/case\?id=c-[0-9a-f]{7}-/, 'the case has an address');

    // running the project's code is off: the button says so and shows the command, and changes nothing
    await p.evaluate("document.querySelector('[data-act=\"run\"][data-v=\"prove\"]').click()");
    await waitFor('#jobpanel .cmdline');
    assert.match(await text('#jobpanel'), /needs your OK first/);
    assert.match(await text('#jobpanel .cmdline'), /assay allow-run --repo/);
    assert.equal(core.repoSettings(repo.dir).allow, undefined);

    // the brief, dismiss and undo
    await p.evaluate("document.querySelector('[data-act=\"brief\"]').click()");
    await sleep(500);
    assert.match(await p.evaluate<string>("document.querySelector('#brieftext').value"), /MUST FIX/);
    await p.evaluate("document.querySelector('[data-act=\"closebrief\"]').click()");
    await p.evaluate("document.querySelector('[data-how=\"dismissed\"]').click()");
    await sleep(800);
    assert.match(await text('.verdict h2'), /Clear to merge|Nothing significant/);
    assert.match(await text('.detail-actions'), /Dismissed/);
    await p.evaluate("document.querySelector('[data-how=\"reopen\"]').click()");
    await sleep(800);
    assert.match(await text('.verdict h2'), /Blocked/);

    // settings, and the theme
    await p.evaluate("location.hash = '#/settings'");
    await waitFor('.section');
    assert.match(await text('#main'), /Running this project’s code/);
    await p.evaluate("document.querySelector('[data-act=\"theme\"][data-v=\"dark\"]').click()");
    assert.equal(await p.evaluate<string>("document.documentElement.getAttribute('data-theme')"), 'dark');

    // the policy: an inline handler put into the page by hand does not run
    await p.evaluate("document.body.insertAdjacentHTML('beforeend', '<img src=\"x\" onerror=\"window.__inline=1\">')");
    await sleep(500);
    assert.equal(await p.evaluate<boolean>('typeof window.__inline === "undefined"'), true, 'inline script is blocked by the page’s policy');

    assert.deepEqual(p.events.exceptions, [], 'no uncaught errors');
    assert.deepEqual(p.events.consoleErrors, [], 'no console errors');
    // (the picture made by hand above has no file behind it: that request is the test's own, so it is left out)
    const own = p.events.failed.filter(f => !/favicon/.test(f.url) && f.url !== `${d.origin}/x`);
    assert.deepEqual(own, [], 'every request the page made worked');
    assert.ok(violations.every(v => /inline event handler|script-src|Refused to execute/i.test(v)) || violations.length === 0, violations.join(' | '));
    await p.close();
  } finally {
    await browser.close();
    await d.close();
  }
});

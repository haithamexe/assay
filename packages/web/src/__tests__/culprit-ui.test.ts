import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo } from './helpers.js';

/* The run panel says which commit broke the tests (D49), in a real browser. Skipped, loudly, where there is no Chromium-based browser. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-culprit-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
const t = core.findBrowser() ? test : test.skip;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const files = (add: string): Record<string, string> => ({
  'package.json': '{"name":"p","type":"module","scripts":{"test":"node --test"}}\n',
  'src/add.js': add,
  'test/add.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add adds two numbers', () => { assert.equal(add(2, 3), 5); });\n"
});

t('the run panel names the first commit where the tests fail, and the case lists it as evidence', async () => {
  const repo = makeRepo([
    { files: files('export const add = (a, b) => a + b;\n'), message: 'Base' },
    { files: { 'README.md': 'one\n' }, message: 'Add a readme' },
    { files: { 'src/add.js': 'export const add = (a, b) => a - b;\n' }, message: 'Refactor add <b>now</b>' },
    { files: { 'README.md': 'two\n' }, message: 'Edit the readme' }
  ], 'adder');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, span: { base: repo.hashes[0], head: repo.hashes[3] } });
  const d = await startDashboard({ repo: repo.dir });
  const browser = await core.Browser.launch(core.findBrowser()!);
  try {
    const p = await browser.newPage();
    await p.viewport(1280, 900, false);
    await p.goto(d.url);
    const text = (sel: string): Promise<string> => p.evaluate<string>(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:''})()`);
    const until = async (what: string, fn: () => Promise<boolean>, ms = 90_000): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return; await sleep(200); }
      throw new Error(`${what} never happened: ${await text('#main')}`);
    };
    await until('the timeline', async () => p.evaluate<boolean>("!!document.querySelector('table.tl')"));
    await p.evaluate(`location.hash = '#/case?id=${c.id}'`);
    await until('the case', async () => p.evaluate<boolean>("!!document.querySelector('.verdict')"));
    await p.evaluate("document.querySelector('[data-act=\"run\"][data-v=\"prove\"]').click()");
    await until('the culprit row', async () => /First failing commit/.test(await text('#jobpanel')));

    const panel = await text('#jobpanel');
    assert.match(panel, new RegExp(`First failing commit\\s+${repo.hashes[2].slice(0, 7)}`));
    assert.match(panel, /Refactor add <b>now<\/b>/, 'the subject is shown as text');
    assert.equal(await p.evaluate<number>("document.querySelectorAll('#jobpanel b').length"), 0, 'it did not become an element');
    assert.match(panel, /passed at\s+\S+/);
    assert.match(panel, /found with 2 runs of 3 commits/, 'three commits (the range is the commits after the base), two runs');
    assert.match(await text('#main'), new RegExp(`starting at ${repo.hashes[2].slice(0, 7)}`), 'and the finding’s title says it too');
    assert.deepEqual(p.events.exceptions, [], 'no uncaught errors');
    assert.deepEqual(p.events.consoleErrors, [], 'no console errors');
    await p.close();
  } finally {
    await browser.close();
    await d.close();
  }
});

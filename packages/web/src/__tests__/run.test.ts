import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, signIn } from './helpers.js';

/* The dashboard runs the project's own tests only after a person allowed it (here: the test does what `assay allow-run` does),
   shows what is happening while it runs, and can stop it. Real `node --test` runs, in clean copies of commits. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-run-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');

const files = (add: string): Record<string, string> => ({
  'package.json': '{"name":"p","type":"module","scripts":{"test":"node --test"}}\n',
  'src/add.js': add,
  'test/add.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add adds two numbers', () => { assert.equal(add(2, 3), 5); });\n"
});

test('the tests run from the page prove a regression, and the case keeps it', async () => {
  const repo = makeRepo([{ files: files('export const add = (a, b) => a + b;\n'), message: 'Base' }, { files: { 'src/add.js': 'export const add = (a, b) => a - b;\n' }, message: 'Refactor add' }], 'adder');
  const d = await startDashboard({ repo: repo.dir });
  try {
    const page = await signIn(d);
    const opened = (await page.post('/api/open', { mode: 'span', from: repo.hashes[1], to: repo.hashes[1] })).json;
    assert.notEqual(opened.verdict.tone, 'blocked', 'nothing is wrong yet by reading alone');
    assert.equal((await page.post('/api/prove', { case: opened.case.id })).status, 403, 'not allowed yet');
    core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
    assert.equal((await page.get('/api/state')).json.allowed, true, 'the page sees that a person allowed it');

    const j = await page.job('/api/prove', { case: opened.case.id, mutants: 0, reverts: 0, budget: 120 });
    assert.equal(j.state, 'done', JSON.stringify(j).slice(0, 500));
    assert.ok(j.messages.some((m: string) => /Running npm test/.test(m)), 'it says what it is doing as it goes');
    assert.equal(j.result.report.ran, true);
    assert.match(j.result.report.regressions.join(' '), /add adds two numbers/);
    assert.equal(j.result.verdict.tone, 'blocked');
    const reg = j.result.case.findings.find((f: { origin: string }) => f.origin === 'run');
    assert.equal(reg.tier, 'proven');
    assert.equal(reg.file, 'src/add.js');
    assert.ok(j.result.case.runs[0].summary.includes('npm test'));
    assert.deepEqual(j.result.case.runs[0].findingIds, [reg.id]);
    // reopening keeps what was run, and the proof can be replayed from the page
    const again = (await page.get(`/api/case?id=${opened.case.id}`)).json;
    assert.equal(again.verdict.tone, 'blocked');
    const re = await page.job('/api/replay', { case: opened.case.id, evidence: reg.evidence[0].id });
    assert.equal(re.state, 'done', JSON.stringify(re));
    assert.equal(re.result.reproduced, true);
  } finally { await d.close(); }
});

test('a run can be stopped from the page, and what it was doing is not kept', async () => {
  const repo = makeRepo([{ files: files('export const add = (a, b) => a + b;\n'), message: 'Base' }, { files: { 'src/add.js': 'export const add = (a, b) => b + a;\n' }, message: 'Swap' }], 'slow');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120, command: 'node -e "setTimeout(function(){},60000)"' });
  const d = await startDashboard({ repo: repo.dir });
  try {
    const page = await signIn(d);
    const opened = (await page.post('/api/open', { mode: 'span', from: repo.hashes[1], to: repo.hashes[1] })).json;
    assert.equal((await page.post('/api/stop', { id: 'j-nothere' })).status, 404);
    const started = (await page.post('/api/prove', { case: opened.case.id, mutants: 0, reverts: 0, budget: 120 })).json;
    // while it runs the case can't be changed under it, and the page can see what is running
    let running = false;
    for (let i = 0; i < 40 && !running; i++) { running = (await page.get(`/api/job?id=${started.id}`)).json.state === 'running'; if (!running) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(running, 'it started');
    assert.equal((await page.get('/api/state')).json.job.id, started.id);
    const fid = opened.case.findings[0]?.id ?? 'f-x';
    assert.equal((await page.post('/api/resolve', { case: opened.case.id, finding: fid, how: 'dismissed' })).status, 409);
    const t0 = Date.now();
    assert.equal((await page.post('/api/stop', { id: started.id })).status, 200);
    let j = (await page.get(`/api/job?id=${started.id}`)).json;
    for (let i = 0; i < 100 && (j.state === 'running' || j.state === 'queued'); i++) { await new Promise(r => setTimeout(r, 150)); j = (await page.get(`/api/job?id=${started.id}`)).json; }
    assert.equal(j.state, 'stopped', JSON.stringify(j).slice(0, 400));
    assert.ok(Date.now() - t0 < 20_000, 'the run was killed, not waited for');
    assert.match(String(j.result?.report?.stopped), /stopped by the person/);
    assert.equal(core.loadCase(opened.case.id)!.runs.length, 0, 'a stopped run keeps nothing');
    assert.equal((await page.get('/api/state')).json.job, null);
  } finally { await d.close(); }
});

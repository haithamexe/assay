import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeRepo, request, signIn } from './helpers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-cal-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { reviewers: rv, calibration: cal } = core;
const { startDashboard } = await import('../index.js');
type Dash = Awaited<ReturnType<typeof startDashboard>>;

const repo = makeRepo([
  { files: { 'README.md': '# shop\n', 'web/app.js': 'export const a = 1;\n', 'web/site.css': '.a { color: red; }\n', 'api/server.py': 'x = 1\n', 'package.json': '{ "name": "shop" }\n' }, message: 'Base' }
]);

let d: Dash;
let page: Awaited<ReturnType<typeof signIn>>;
before(async () => { d = await startDashboard({ repo: repo.dir }); page = await signIn(d); });
after(async () => { await d.close(); });

test('before a run, the scoreboard says what would be planted and plants nothing', async () => {
  const r = await page.get('/api/calibration');
  assert.equal(r.status, 200);
  assert.equal(r.json.board, null);
  assert.equal(r.json.run, null);
  assert.equal(r.json.prompt, '');
  assert.ok(r.json.preview.fit.length >= 15);
  assert.equal(r.json.preview.shape.js, 'web');
  assert.equal(r.json.preview.shape.py, 'api');
  assert.deepEqual(r.json.routedOut, []);
  assert.equal(cal.latestRun(repo.dir), null);
});

test('only the page itself can plant bugs or clear them', async () => {
  for (const p of ['/api/calibration/start', '/api/calibration/clean']) {
    assert.equal((await request(d.port, 'POST', p, { cookie: page.cookie, body: {}, headers: { 'content-type': 'application/json' } })).status, 403, `${p}: no origin`);
    assert.equal((await request(d.port, 'POST', p, { body: {}, headers: { origin: d.origin, 'content-type': 'application/json' } })).status, 401, `${p}: no key`);
  }
  assert.equal(cal.latestRun(repo.dir), null, 'nothing was planted');
});

test('planting is a job: the free checks are scored on the spot and the prompt for the agent is ready', async () => {
  const job = await page.job('/api/calibration/start', {});
  assert.equal(job.state, 'done', JSON.stringify(job).slice(0, 400));
  assert.ok(job.messages.length >= 1);
  const r = (await page.get('/api/calibration')).json;
  assert.ok(r.board, 'there is a scoreboard');
  assert.equal(r.board.planted, 17);
  assert.equal(r.board.complete, false);
  assert.equal(r.board.reviewersRan, 0);
  assert.equal(r.board.rows.length, 9, 'the free checks, six lenses, the attack pass and the plain review (the baseline)');
  assert.equal(r.board.rows.at(-2).id, 'attack');
  assert.equal(r.board.rows.at(-1).id, 'plain');
  assert.equal(r.board.rows[0].id, 'free');
  assert.equal(r.board.rows[0].alarms, 0, 'no false alarm on the clean twins');
  assert.ok(r.board.freeProven >= 1 && r.board.freeSeen > r.board.freeProven);
  assert.match(r.run.id, /^cal-[0-9a-f]{8}$/);
  assert.match(r.prompt, new RegExp(r.board.cases.planted));
  assert.match(r.prompt, new RegExp(r.board.cases.control));
  assert.match(r.prompt, /don't read anything under ~\/\.assay\/calibration/);
  assert.equal(r.preview, null);
});

test('the throwaway cases belong to no project: the dashboard won’t open them as the project’s own', async () => {
  const r = (await page.get('/api/calibration')).json;
  assert.equal((await page.get(`/api/case?id=${r.board.cases.planted}`)).status, 404);
  assert.equal((await page.get(`/api/panel?case=${r.board.cases.control}`)).status, 404);
});

test('the scoreboard moves as an agent’s reviewers report, and a finished run is kept for routing', async () => {
  const run = cal.latestRun(repo.dir)!;
  const report = (which: 'planted' | 'control', who: string, claims: Array<{ file: string; line: number }>): void => {
    const c = core.loadCase(which === 'planted' ? run.planted.case : run.control.case)!;
    const lens = rv.reviewerFor(who)!.lens;
    const gated = core.applyClaims(c.repo, c, claims.map(x => ({ title: 'Something is wrong here', lens, file: x.file, line: x.line, what: 'This line does something it should not, and here is why it matters.', source: `reviewer:${lens}` })));
    core.saveCase(c);
    rv.recordSubmission(c, who, gated, { round: 1, done: true, tokens: 1500, claims: claims.length, disputes: [] });
  };
  const at = (id: string): { file: string; line: number } => { const b = run.planted.bugs.find(x => x.id === id)!; return { file: b.file, line: b.line }; };
  report('planted', 'Security', [at('html-sink'), at('sql-concat')]);
  let r = (await page.get('/api/calibration')).json;
  assert.equal(r.board.complete, false, 'only one reviewer has reported');
  assert.equal(r.board.reviewersRan, 1);
  assert.equal(r.board.rows.find((x: any) => x.id === 'Security').ran, true);
  assert.match(r.board.rows.find((x: any) => x.id === 'UI').advice, /Not reported yet/);

  report('control', 'Security', []);
  for (const lens of ['Correctness', 'UI', 'Tests', 'Supply chain', 'Performance']) {
    report('planted', lens, lens === 'Correctness' ? [at('off-by-one')] : []);
    report('control', lens, []);
  }
  r = (await page.get('/api/calibration')).json;
  assert.equal(r.board.complete, true);
  assert.equal(r.board.reviewersRan, 6);
  const sec = r.board.rows.find((x: any) => x.id === 'Security');
  assert.equal(sec.hits, 2);
  assert.equal(sec.chances, 5);
  assert.equal(sec.alarms, 0);
  assert.equal(sec.tokens, 3000);
  assert.equal(r.history, 1, 'a finished run is kept once, however often it is read');
  await page.get('/api/calibration');
  assert.equal((await page.get('/api/calibration')).json.history, 1);
  assert.ok(r.board.seen > r.board.freeSeen, 'the reviewers flagged what the free checks missed');
});

test('clearing removes the throwaway repositories and keeps what they showed', async () => {
  const run = cal.latestRun(repo.dir)!;
  const r = await page.post('/api/calibration/clean', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.board, null);
  assert.equal(fs.existsSync(run.dir), false);
  assert.equal(r.json.history, 1, 'the record stays');
});

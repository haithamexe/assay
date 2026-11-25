import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeRepo, request, signIn } from './helpers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-rv-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { reviewers: rv } = core;
const { startDashboard } = await import('../index.js');
type Dash = Awaited<ReturnType<typeof startDashboard>>;

const logic = Array.from({ length: 16 }, (_, i) => `def step_${i}(order):\n    return order.total + ${i}\n`).join('\n');
const repo = makeRepo([
  { files: { 'README.md': '# shop\n' }, message: 'Base' },
  { files: { 'src/cart.py': `import os\n\n${logic}\ndef export(cmd):\n    os.system(cmd)\n`, 'web/app.css': '.badge { position: absolute; right: 10px; }\n', 'package.json': '{ "dependencies": { "reactt": "^1.0.0" } }\n' }, message: 'Add the cart' }
]);

let d: Dash;
let page: Awaited<ReturnType<typeof signIn>>;
let caseId = '';
before(async () => { d = await startDashboard({ repo: repo.dir }); page = await signIn(d); caseId = (await page.post('/api/open', { mode: 'branch' })).json.case.id; });
after(async () => { await d.close(); });

const panel = async (): Promise<any> => (await page.get(`/api/panel?case=${caseId}`)).json;

test('the panel is planned and priced before anything is spent, and nothing is kept by looking', async () => {
  const r = await page.get(`/api/panel?case=${caseId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.kept, false);
  assert.equal(r.json.budget, 40000);
  assert.equal(r.json.panel.reviewers.length, 7);
  const run = r.json.panel.reviewers.filter((x: any) => x.run).map((x: any) => x.lens);
  for (const lens of ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain']) assert.ok(run.includes(lens), `${lens}: ${JSON.stringify(r.json.panel.reviewers.find((x: any) => x.lens === lens))}`);
  assert.ok(r.json.panel.estimate.total > 0 && r.json.panel.estimate.total <= 40000);
  assert.match(r.json.prompt, /reviewers_plan with case "c-/);
  assert.match(r.json.prompt, /one sub-agent per reviewer/);
  assert.match(r.json.prompt, /Don't show the reviewers each other's work/);
  assert.equal(r.json.status.phase, 'off');
  assert.equal(core.loadCase(caseId)!.panel, undefined, 'a preview keeps nothing');
  const view = (await page.get(`/api/case?id=${caseId}`)).json;
  assert.equal(view.case.panel, undefined);
});

test('the budget is a number the page may set, and a free-only budget turns every reviewer off', async () => {
  const off = await page.post('/api/panel/budget', { budget: 0 });
  assert.equal(off.status, 200);
  assert.equal(off.json.budget, 0);
  const p = await panel();
  assert.equal(p.budget, 0);
  assert.equal(p.prompt, '', 'nothing to hand an agent');
  assert.ok(p.panel.reviewers.every((x: any) => !x.run && x.skip === 'off'));
  assert.equal((await page.post('/api/panel/budget', { budget: 'lots' })).status, 400);
  assert.equal((await page.post('/api/panel/budget', {})).status, 400);
  assert.equal((await page.post('/api/panel/budget', { budget: 9_999_999 })).json.budget, 400000, 'capped');
  assert.equal((await page.post('/api/panel/budget', { budget: 40000 })).json.budget, 40000);
  assert.equal(core.repoSettings(repo.dir).allow, undefined, 'setting a budget never touches what may be run');
  const s = (await page.get('/api/settings')).json;
  assert.equal(s.budget, 40000);
  assert.equal(s.hookCommand, 'assay hook install');
});

test('only the page itself can plan or change the budget', async () => {
  for (const [p, body] of [['/api/panel/plan', { case: caseId }], ['/api/panel/budget', { budget: 0 }]] as const) {
    assert.equal((await request(d.port, 'POST', p, { cookie: page.cookie, body, headers: { 'content-type': 'application/json' } })).status, 403, `${p}: no origin`);
    assert.equal((await request(d.port, 'POST', p, { body, headers: { origin: d.origin, 'content-type': 'application/json' } })).status, 401, `${p}: no key`);
  }
  assert.equal((await page.get('/api/panel')).status, 400, 'which case?');
  assert.equal((await page.get('/api/panel?case=c-0000000-root')).status, 404);
  assert.equal((await page.get('/api/panel?case=../../etc')).status, 404, 'a case id is only ever its fixed shape');
});

test('planning keeps the panel with the case, and what an agent does next shows on the screen', async () => {
  const kept = await page.post('/api/panel/plan', { case: caseId, request: 'Add the cart with an export' });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.kept, true);
  assert.equal(kept.json.panel.request, 'Add the cart with an export');
  assert.equal(kept.json.panel.reviewers.find((x: any) => x.lens === 'Scope').run, true, 'a request brings in Triage');
  assert.ok(core.loadCase(caseId)!.panel);
  assert.equal(kept.json.status.phase, 'waiting');
  assert.match(kept.json.prompt, /request "Add the cart with an export"/);
  assert.equal((await page.get(`/api/case?id=${caseId}`)).json.case.panel.id, kept.json.panel.id, 'the case carries its panel');

  // the agent (here, this test) fetches briefs and reports, exactly as the MCP tools do
  const c = core.loadCase(caseId)!;
  assert.match(rv.reviewerBrief(c, 'Security').text, /REVIEWER BRIEF · Security/);
  let now = await panel();
  assert.equal(now.panel.reviewers.find((x: any) => x.lens === 'Security').state, 'briefed');

  const claim = (who: string, title: string, file: string, line: number, what: string) => ({ title, lens: 'Correctness' as const, file, line, what, source: `reviewer:${who}` });
  const rounds: Array<[string, ReturnType<typeof claim>[]]> = [
    ['Security', [claim('Security', 'A command is run from an argument', 'src/cart.py', 36, 'export passes cmd to os.system, so whoever controls it runs anything.'), claim('Security', 'Cites nothing', 'src/missing.py', 4, 'This line is not in the change at all, so it cannot stand.')]],
    ['Correctness', [claim('Correctness', 'The totals ignore tax', 'src/cart.py', 4, 'step_0 returns the total plus a constant and never applies tax, so it differs from the order.')]],
    ['UI', []], ['Tests', []], ['Supply chain', []], ['Scope', []]
  ];
  for (const [who, claims] of rounds) {
    const cc = core.loadCase(caseId)!;
    const r = core.applyClaims(repo.dir, cc, claims);
    core.saveCase(cc);
    rv.recordSubmission(cc, who, r, { round: 1, done: true, tokens: 1000, claims: claims.length, disputes: [] });
  }
  now = await panel();
  assert.equal(now.status.phase, 'cross', 'every reviewer has reported');
  const sec = now.panel.reviewers.find((x: any) => x.lens === 'Security');
  assert.equal(sec.state, 'reported');
  assert.equal(sec.claims, 2);
  assert.equal(sec.dropped, 1);
  assert.equal(now.dropped.length, 1);
  assert.match(now.dropped[0].why, /not in the change|cited no file/);
  assert.equal(now.dropped[0].by, 'Security');
  assert.ok(now.panel.reviewers.reduce((n: number, r: any) => n + r.kept + r.merged, 0) >= 2, 'what the gate kept is counted, whether it became a finding or joined one');
  assert.equal(now.cross.state, 'open', 'asking for the screen opens cross-examination when every reviewer has reported');
  assert.ok(Object.keys(now.cross.assigned).length >= 1);
  assert.ok(now.tokensReported >= 6000);
});

test('a dispute shows on the screen and on the finding, and changes no tier', async () => {
  const before = await panel();
  const [examiner, ids] = Object.entries(before.cross.assigned as Record<string, string[]>)[0];
  const cc = core.loadCase(caseId)!;
  const target = cc.findings.find(f => f.id === ids[0])!;
  rv.recordSubmission(cc, examiner, { kept: [], merged: [], dropped: [] }, { round: 2, done: true, claims: 0, disputes: [{ finding: target.id, reason: 'That line is only reached after the argument was checked.' }] });
  const after = await panel();
  assert.equal(after.disputes.length, 1);
  assert.equal(after.disputes[0].title, target.title);
  assert.equal(after.disputes[0].by, examiner);
  const view = (await page.get(`/api/case?id=${caseId}`)).json;
  assert.equal(view.case.panel.cross.disputes[0].finding, target.id);
  assert.equal(view.states[target.id], 'hint', 'what a reviewer says alone stays a hint');
  assert.notEqual(view.verdict.tone, 'blocked', 'nothing a reviewer says can block');
});

test('a budget set after planning doesn’t hide the kept panel: the screen says so', async () => {
  await page.post('/api/panel/budget', { budget: 80000 });
  const p = await panel();
  assert.equal(p.kept, true);
  assert.equal(p.budget, 40000, 'the plan was made with the budget it was made with');
  assert.equal(p.repoBudget, 80000);
  assert.equal(p.panel.reviewers.find((x: any) => x.lens === 'Security').state, 'reported', 'its progress is still there');
  await page.post('/api/panel/budget', { budget: 40000 });
});

test('the reviewers script is served', async () => {
  const js = await page.get('/js/reviewers.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'] ?? '', /javascript/);
});

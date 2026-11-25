import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { makeRepo, plantedRepo, SECRET, tempHome } from './fixtures.js';

const home = tempHome();
const core = await import('../index.js');
const { reviewers: rv, memory } = core;
const { repo, hashes } = plantedRepo();
const FULL = `${hashes[0]}..${hashes[5]}`;
after(() => memory.closeMemory());

const fresh = (): import('../types.js').Case => core.openCase({ repo: repo.dir, range: FULL });
const by = (p: import('../types.js').Panel, lens: import('../types.js').Lens): import('../types.js').PanelReviewer => p.reviewers.find(r => r.lens === lens)!;

test('the plan says who is worth running, why, and what it costs, before anything is spent', () => {
  const c = fresh();
  const p = rv.previewPanel(c, { budget: 60000 });
  assert.equal(p.budget, 60000);
  const run = p.reviewers.filter(r => r.run).map(r => r.lens);
  for (const lens of ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain'] as const) assert.ok(run.includes(lens), `${lens} is worth running here: ${by(p, lens).why}`);
  assert.match(by(p, 'Security').why, /free checks flagged|sensitive|logic/);
  assert.match(by(p, 'Supply chain').why, /dependency or build file/);
  assert.match(by(p, 'UI').why, /page, style or component/);
  assert.equal(by(p, 'Scope').run, false);
  assert.equal(by(p, 'Scope').skip, 'no-request');
  assert.match(by(p, 'Scope').why, /no request/i);
  assert.ok(p.reviewers.filter(r => r.run).every(r => r.tokens >= 800 && r.tokens < 60000), 'each costs something real');
  assert.equal(p.estimate.specialists, p.reviewers.reduce((n, r) => n + r.tokens, 0));
  assert.equal(p.estimate.total, p.estimate.specialists + p.cross.tokens);
  assert.ok(p.cross.run && p.cross.tokens > 0 && p.cross.tokens <= 4500, 'two or more reviewers can cross-examine');
  assert.ok(p.estimate.total <= 60000);
  assert.equal(c.panel, undefined, 'a preview keeps nothing');
});

test('a request brings in Triage, and nothing is planned on a free-only budget', () => {
  const c = fresh();
  const withRequest = rv.previewPanel(c, { budget: 60000, request: 'Show coupon errors in the cart' });
  assert.equal(by(withRequest, 'Scope').run, true);
  assert.match(by(withRequest, 'Scope').why, /every changed file/);
  const off = rv.previewPanel(c, { budget: 0, request: 'x' });
  assert.ok(off.reviewers.every(r => !r.run && r.skip === 'off' && r.tokens === 0));
  assert.equal(off.estimate.total, 0);
  assert.equal(off.cross.run, false);
});

test('a small budget pays for the most justified reviewers and says why the rest were left out', () => {
  const c = fresh();
  const all = rv.previewPanel(c, { budget: 100000 });
  const small = rv.previewPanel(c, { budget: 6000 });
  const run = small.reviewers.filter(r => r.run);
  assert.ok(run.length >= 1 && run.length < all.reviewers.filter(r => r.run).length, 'fewer reviewers fit');
  assert.ok(small.estimate.total <= 6000, `${small.estimate.total} within 6000`);
  const over = small.reviewers.filter(r => r.skip === 'budget');
  assert.ok(over.length >= 1);
  for (const r of over) assert.match(r.why, /^Over budget: needs [\d.]+k?, [\d.]*k? left\.$/);
  const highest = [...all.reviewers].filter(r => r.run).sort((a, b) => b.tokens - a.tokens)[0];
  assert.ok(highest, 'the plan names who it would have run');
  const tiny = rv.previewPanel(c, { budget: 300 });
  assert.equal(tiny.reviewers.filter(r => r.run).length, 0);
  assert.equal(tiny.estimate.total, 0);
  assert.ok(tiny.reviewers.filter(r => r.skip === 'budget').length >= 1);
});

test('a plan is kept with the case; planning again keeps the progress, a new budget starts over', () => {
  const c = fresh();
  const a = rv.planPanel(c, { budget: 60000 });
  assert.equal(core.loadCase(c.id)!.panel!.id, a.id);
  const b = rv.planPanel(c, { budget: 60000 });
  assert.equal(b.id, a.id);
  assert.equal(b.createdAt, a.createdAt);
  const again = core.openCase({ repo: repo.dir, range: FULL });
  assert.equal(again.panel?.id, a.id, 'opening the case again keeps its panel');
  const other = rv.planPanel(core.loadCase(c.id)!, { budget: 80000 });
  assert.notEqual(other.id, a.id);
  rv.planPanel(core.loadCase(c.id)!, { budget: 60000 });
});

test('a brief is one reviewer’s lens, its slice with the numbers a claim cites, and what the free checks already know', () => {
  const c = core.loadCase(fresh().id)!;
  const sup = rv.reviewerBrief(c, 'supply-chain');
  assert.match(sup.text, /REVIEWER BRIEF · Supply chain/);
  assert.match(sup.text, /look-alike|install/i, 'its own prompt');
  assert.match(sup.text, /── package\.json/);
  assert.ok(!/── src\/cart\.py/.test(sup.text), 'a supply chain reviewer is not shown application code');
  assert.match(sup.text, /^\+\s+\d+\s+"reactt"/m, 'the added line, with its number');
  assert.match(sup.text, /finding_submit with case "c-/);
  assert.match(sup.text, /done: true/);
  assert.ok(sup.text.length < 12000, 'a brief stays small');

  const sec = rv.reviewerBrief(core.loadCase(c.id)!, 'Security');
  assert.match(sec.text, /Who is asking|Input that reaches/, 'the security prompt');
  assert.match(sec.text, /── web\/CouponError\.tsx/);
  assert.match(sec.text, /dangerouslySetInnerHTML/);
  assert.match(sec.text, /ALREADY FOUND BY THE FREE CHECKS/);
  assert.match(sec.text, /Text may be inserted as HTML/, 'what the free checks found is named so it is not repeated');
  assert.ok(!sec.text.includes('QWERTYUIOP123456'), 'a secret is never in a brief');

  const ui = rv.reviewerBrief(core.loadCase(c.id)!, 'ui');
  assert.match(ui.text, /QUESTIONS THIS PROJECT ASKS/);
  assert.match(ui.text, /translatable/, 'the project memory’s questions for this lens');
  assert.ok(!/is the money held|floating point/i.test(ui.text), 'and not the questions of another lens');
});

test('a reviewer that isn’t in the panel gets no brief, and a name that isn’t a reviewer is refused', () => {
  const c = core.loadCase(fresh().id)!;
  assert.throws(() => rv.reviewerBrief(c, 'Triage'), /not part of this panel.*no request/i);
  assert.throws(() => rv.reviewerBrief(c, 'Astrology'), /no reviewer called/);
  const none = makeRepo('nopanel');
  none.commit({ 'README.md': '# x\n' }, 'Base');
  const h = none.commit({ 'a.js': 'export const a = 1;\n' }, 'Add a');
  const lone = core.openCase({ repo: none.dir, range: h });
  assert.throws(() => rv.reviewerBrief(lone, 'Security'), /reviewers_plan/);
});

test('Triage is handed the request and the list of changed files, and no code', () => {
  const c = core.loadCase(fresh().id)!;
  rv.planPanel(c, { budget: 60000, request: 'Show coupon errors in the cart' });
  const t = rv.reviewerBrief(core.loadCase(c.id)!, 'triage');
  assert.match(t.text, /THE REQUEST\nShow coupon errors in the cart/);
  assert.match(t.text, /web\/CouponError\.tsx\s+\+\d+ −\d+/);
  assert.ok(!/dangerouslySetInnerHTML/.test(t.text), 'names and counts, not code');
  rv.planPanel(core.loadCase(c.id)!, { budget: 60000 });
});

test('a reviewer never sees another’s claims in its brief, and the lens prompt can be replaced by a file of yours', () => {
  let c = core.loadCase(fresh().id)!;
  const claim = { title: 'Empty list crashes the price lookup', lens: 'Correctness' as const, file: 'src/totals.py', line: 16, what: 'first_price indexes items[0] with no guard, so an empty cart raises IndexError.', source: 'reviewer:Correctness' };
  const r = core.applyClaims(repo.dir, c, [claim]);
  core.saveCase(c);
  rv.recordSubmission(c, 'Correctness', r, { round: 1, done: true, tokens: 3100, claims: 1, disputes: [] });
  c = core.loadCase(c.id)!;
  const sec = rv.reviewerBrief(c, 'Security');
  assert.ok(!sec.text.includes('Empty list crashes'), 'blind: it was not shown');
  assert.ok(!sec.text.includes('IndexError'));

  const dir = path.join(home, 'lenses');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'security.md'), 'You are a very particular auditor of OUR house rules.\nLook for tabs.');
  assert.match(rv.reviewerBrief(core.loadCase(c.id)!, 'security').text, /very particular auditor of OUR house rules/);
  fs.rmSync(path.join(dir, 'security.md'));
  assert.match(rv.reviewerBrief(core.loadCase(c.id)!, 'security').text, /Who is asking|Input that reaches/);
});

test('what comes back is counted by what the gate did with it, and a reviewer must say it is done', () => {
  let c = core.loadCase(fresh().id)!;
  const p0 = c.panel!;
  assert.equal(by(p0, 'Correctness').state, 'reported');
  assert.equal(by(p0, 'Correctness').claims, 1);
  assert.equal(by(p0, 'Correctness').kept, 1);
  assert.equal(by(p0, 'Correctness').reportedTokens, 3100);
  assert.equal(by(p0, 'Security').state, 'briefed', 'it fetched its brief but has not said it is done');

  const st = (): ReturnType<typeof rv.statusOf> => rv.statusOf(core.loadCase(c.id)!.panel);
  assert.equal(st().phase, 'reviewing');
  assert.match(st().next, /still to report: .*Security/);

  const bad = { title: 'Something is off', lens: 'Security' as const, file: 'src/nowhere.py', line: 3, what: 'This cites a file that is not in the change at all.', source: 'reviewer:Security' };
  const gated = core.applyClaims(repo.dir, c, [bad]);
  core.saveCase(c);
  rv.recordSubmission(c, 'Security', gated, { round: 1, done: true, claims: 1, disputes: [] });
  c = core.loadCase(c.id)!;
  assert.equal(by(c.panel!, 'Security').dropped, 1);
  assert.equal(by(c.panel!, 'Security').state, 'reported');

  for (const lens of ['UI', 'Tests', 'Supply chain']) {
    rv.recordSubmission(c, lens, { kept: [], merged: [], dropped: [] }, { round: 1, done: true, claims: 0, disputes: [] });
    c = core.loadCase(c.id)!;
  }
  assert.equal(by(c.panel!, 'Tests').state, 'reported');
  assert.equal(st().phase, 'cross', 'everyone has reported: cross-examination can open');
});

test('cross-examination hands each claim to a different reviewer, anonymously, and a confirmation is a second signal', () => {
  let c = core.loadCase(fresh().id)!;
  const earlier = core.applyClaims(repo.dir, c, [{ title: 'Loop adds rows with no cap', lens: 'Security', file: 'src/totals.py', line: 11, what: 'count adds every quantity with no upper bound; a hostile quantity overflows a report.', source: 'reviewer:Security' }]);
  core.saveCase(c);
  assert.equal(earlier.kept.length, 1);

  const cross = rv.openCross(core.loadCase(c.id)!)!;
  c = core.loadCase(c.id)!;
  assert.equal(c.panel!.cross.state, 'open');
  const assigned = Object.entries(cross.assigned);
  assert.ok(assigned.length >= 1);
  const claim = c.findings.find(f => f.title === 'Empty list crashes the price lookup')!;
  const examiner = assigned.find(([, ids]) => ids.includes(claim.id))![0];
  assert.notEqual(examiner, 'Correctness', 'never its own author');
  assert.ok(assigned.every(([, ids]) => ids.length <= 5));

  const idle = c.panel!.reviewers.filter(r => r.run).map(r => r.lens).find(l => !cross.assigned[l]);
  assert.ok(idle, 'someone has nothing to examine');
  assert.match(rv.reviewerBrief(c, idle, { round: 2 }).text, /Nothing was assigned to you/, 'a reviewer with nothing to examine is told so');
  const brief = rv.reviewerBrief(c, examiner, { round: 2 });
  assert.match(brief.text, /CROSS-EXAMINATION/);
  assert.ok(brief.text.includes(claim.id), 'the claim to examine');
  assert.ok(brief.text.includes('Empty list crashes the price lookup'));
  assert.ok(!/reviewer:Correctness|by Correctness|the Correctness reviewer/i.test(brief.text), 'anonymous: it isn’t told who said it');
  assert.match(brief.text, /round 2/);

  // the examiner confirms with a claim of its own at the same line: a second, independent source
  const confirm = core.applyClaims(repo.dir, c, [{ title: 'Unguarded index', lens: 'Correctness', file: 'src/totals.py', line: 16, what: 'Reading items[0] of an empty list raises IndexError: I see the same thing.', source: `reviewer:${examiner}` }]);
  core.saveCase(c);
  assert.equal(confirm.merged.length, 1);
  rv.recordSubmission(c, examiner, confirm, { round: 2, done: true, claims: 1, disputes: [{ finding: earlier.kept[0].id, reason: 'The loop is bounded by the number of items, so there is nothing to overflow.' }] });
  c = core.loadCase(c.id)!;
  assert.equal(c.panel!.cross.confirmed, 1);
  assert.equal(c.panel!.cross.disputes.length, 1);
  assert.equal(c.panel!.cross.disputes[0].by, examiner);
  assert.equal(c.findings.find(f => f.id === claim.id)!.tier, 'corroborated', 'two reviewers who each saw it');
  assert.equal(c.findings.find(f => f.id === earlier.kept[0].id)!.tier, 'hint', 'a dispute changes no tier');
  assert.ok(!core.verdictOf(c).must.some(f => f.origin === 'claim'), 'nothing a reviewer says can block');
});

test('the panel reads out as text an agent can act on, and says exactly what to do next', () => {
  const c = core.loadCase(fresh().id)!;
  const fresher = rv.planPanel(c, { budget: 60000, request: 'Show coupon errors in the cart' });
  assert.ok(fresher);
  const t = rv.panelText(core.loadCase(c.id)!, core.loadCase(c.id)!.panel!);
  assert.match(t, /Reviewer panel for case c-/);
  assert.match(t, /RUN\s+Security/);
  assert.match(t, /skip\s+Performance\s+.*not needed/);
  assert.match(t, /Not spent: about [\d.]+k? on lenses/);
  assert.match(t, /start one sub-agent per reviewer still to report/);
  assert.match(t, /reviewer_brief with case "c-[0-9a-f]{7}-[0-9a-f]{7}" and lens/);
  assert.ok(t.length < 2600, `short: ${t.length}`);
});

test('the stop hook blocks "done" while the verdict is Blocked, lets go after a few tries, and never traps a session', () => {
  const { repo: r } = plantedRepo('hooked');
  const input = (extra: Record<string, unknown> = {}): { cwd: string; session_id: string } => ({ cwd: r.dir, session_id: 'sess-1', ...extra }) as never;
  assert.equal(rv.stopDecision(input()).block, false, 'on the default branch there is no branch to review');
  assert.match(rv.stopDecision(input()).note ?? '', /not left the default branch/);

  r.git('checkout', '-q', '-b', 'feature');
  r.commit({ 'config/prod.py': `STRIPE = "${SECRET}"\nREGION = "eu"\n` }, 'Add prod settings');
  const d1 = rv.stopDecision(input());
  assert.equal(d1.block, true);
  assert.match(d1.reason ?? '', /Assay: not done yet/);
  assert.match(d1.reason ?? '', /Blocked: 1 proven problem/);
  assert.match(d1.reason ?? '', /prod\.py/);
  assert.ok(!(d1.reason ?? '').includes('QWERTYUIOP123456'), 'a secret is never in what the agent is told');
  assert.match(d1.reason ?? '', /Asked 1 of 2 times/);
  assert.equal(rv.stopDecision(input()).block, true);
  const d3 = rv.stopDecision(input());
  assert.equal(d3.block, false, 'after two tries it lets the session stop');
  assert.match(d3.note ?? '', /lets go/);

  // another session is counted on its own, and fixing the problem ends it
  assert.equal(rv.stopDecision(input({ session_id: 'sess-2' })).block, true);
  r.commit({ 'config/prod.py': 'STRIPE = None\nREGION = "eu"\n' }, 'Remove the key');
  const ok = rv.stopDecision(input({ session_id: 'sess-2' }));
  assert.equal(ok.block, false);
  assert.match(ok.note ?? '', /Clear to merge|Can merge/);

  // a panel the person asked for must be finished, when they say so
  const steps = Array.from({ length: 14 }, (_, i) => `def step_${i}(order):\n    return order.total + ${i}\n`).join('\n');
  r.commit({ 'src/pay.py': steps }, 'Add payment steps');
  const c = core.openCase({ repo: r.dir });
  rv.planPanel(c, { budget: 60000 });
  assert.ok(core.loadCase(c.id)!.panel!.reviewers.some(x => x.run), 'there is something worth reviewing');
  assert.equal(rv.stopDecision(input({ session_id: 'sess-3' }), { requirePanel: false }).block, false);
  const waiting = rv.stopDecision(input({ session_id: 'sess-3' }), { requirePanel: true });
  assert.equal(waiting.block, true);
  assert.match(waiting.reason ?? '', /panel you were asked to run is not finished/);

  assert.equal(rv.stopDecision({ cwd: path.join(home, 'nowhere') }).block, false, 'not a repository: nothing to review');
});

test('with --always the last commits are reviewed even on the default branch', () => {
  const { repo: r } = plantedRepo('always');
  const d = rv.stopDecision({ cwd: r.dir, session_id: 'sess-a' }, { always: true });
  assert.equal(d.block, false, 'the key was removed again in the last commit, so nothing is open');
  r.commit({ 'config/live.py': `KEY = "${SECRET}"\n` }, 'Add live key');
  assert.equal(rv.stopDecision({ cwd: r.dir, session_id: 'sess-a' }, { always: true }).block, true);
  assert.equal(rv.stopDecision({ cwd: r.dir, session_id: 'sess-b' }).block, false, 'without it, a default branch is left alone');
});

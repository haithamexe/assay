import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { makeRepo, plantedRepo, SECRET, tempHome } from './fixtures.js';

/* The attack pass (D50): one more reviewer, outside the lenses, whose only job is to break the change. */
tempHome();
const core = await import('../index.js');
const { reviewers: rv, memory } = core;
const { repo, hashes } = plantedRepo();
const FULL = `${hashes[0]}..${hashes[5]}`;
after(() => memory.closeMemory());

const { casePath } = await import('../store.js');
/** A case that has never been kept: an opened case keeps its panel, claims and progress, so every test starts from none. */
const fresh = (): import('../types.js').Case => {
  fs.rmSync(casePath(core.caseId(hashes[5], hashes[0])), { force: true });
  return core.openCase({ repo: repo.dir, range: FULL });
};
const bare = { kept: [], merged: [], dropped: [] };

test('the attack pass is for big budgets, and only when something that runs changed; its cost is in the total', () => {
  const c = fresh();
  const small = rv.previewPanel(c, { budget: 40000 });
  assert.equal(small.attack?.run, false);
  assert.equal(small.attack?.skip, 'budget');
  assert.match(String(small.attack?.why), /80k or more; this one is 40k/);
  assert.equal(small.estimate.total, small.estimate.specialists + small.cross.tokens, 'no cost for what is not run');
  assert.equal(rv.previewPanel(c, { budget: 0 }).attack?.skip, 'off');

  const big = rv.previewPanel(c, { budget: 100000 });
  const a = big.attack!;
  assert.equal(a.run, true, a.why);
  assert.match(a.why, /break \d+ changed files? /);
  assert.ok(a.tokens >= 1000 && a.tokens < 60000, `a real cost: ${a.tokens}`);
  assert.equal(big.estimate.attack, a.tokens);
  assert.equal(big.estimate.total, big.estimate.specialists + big.cross.tokens + a.tokens);
  assert.ok(big.estimate.total <= 100000);
  assert.equal(c.panel, undefined, 'a preview keeps nothing');

  // nothing that runs or is shown: nothing to break
  const docs = makeRepo();
  const b = docs.commit({ 'README.md': '# app\n' }, 'Base');
  docs.commit({ 'README.md': '# app\nA few words about it.\n' }, 'Docs');
  const d = core.openCase({ repo: docs.dir, range: `${b}..HEAD` });
  const none = rv.previewPanel(d, { budget: 100000 }).attack!;
  assert.equal(none.run, false);
  assert.equal(none.skip, 'not-needed');
  assert.match(none.why, /nothing to attack|nothing to break/i);
});

test('its brief: every changed file that runs, numbered for citing, the free checks’ findings, and never a secret or another reviewer’s claim', () => {
  const c = fresh();
  rv.planPanel(c, { budget: 100000 });
  // a Security reviewer has already said something; the attacker must not be shown it
  core.applyClaims(repo.dir, c, [{ title: 'Zebra claim that must stay private', lens: 'Security', file: 'src/totals.py', line: 16, what: 'A reviewer’s reading that no other reviewer may see.', source: 'reviewer:Security' }]);
  core.saveCase(c);
  const b = rv.reviewerBrief(c, 'attack');
  assert.equal(b.round, 1);
  assert.match(b.text, /^REVIEWER BRIEF · Attack · case c-/);
  assert.match(b.text, /You are the attacker/);
  assert.match(b.text, /Your only job is to break it/, 'the prompt that ships');
  assert.match(b.text, /THE CHANGE \(page 1 of \d+; \d+ files? that run or are shown\)/);
  assert.match(b.text, /── src\/totals\.py/);
  assert.match(b.text, /── web\/CouponError\.tsx/);
  assert.match(b.text, /^\+\s+\d+\s+def total/m, 'a changed line is printed with the number a claim must cite');
  assert.match(b.text, /NO TEST FILE CHANGED/);
  assert.match(b.text, /ALREADY FOUND BY THE FREE CHECKS/);
  assert.match(b.text, /finding_submit with case "c-[0-9a-f]{7}-[0-9a-f]{7}", reviewer "Attack"/);
  assert.ok(!b.text.includes(SECRET), 'a key in the diff is masked, as everywhere');
  assert.ok(!b.text.includes('Zebra'), 'the attacker is as blind as the rest');
  assert.equal(c.panel?.attack?.state, 'briefed', 'fetching page 1 marks it briefed');
  assert.equal(c.panel?.attack?.briefedAt !== undefined, true);
});

test('it is refused when the plan did not include it, and it has no second round', () => {
  const c = fresh();
  assert.throws(() => rv.reviewerBrief(c, 'attack'), /No panel is planned/);
  rv.planPanel(c, { budget: 40000 });
  assert.throws(() => rv.reviewerBrief(c, 'attack'), /not part of this panel: The attack pass is for budgets of 80k or more/);
  const big = fresh();
  rv.planPanel(big, { budget: 100000 });
  assert.throws(() => rv.reviewerBrief(big, 'attack', { round: 2 }), /one round/);
  assert.ok(rv.isAttack('attack') && rv.isAttack('Attack') && rv.isAttack('attack-pass') && !rv.isAttack('Attacker of lens'));
  assert.equal(rv.reviewerFor('attack'), undefined, 'it is not a lens: no finding belongs to "attack"');
});

test('a prompt of yours in the lenses folder replaces the one that ships', () => {
  const c = fresh();
  rv.planPanel(c, { budget: 100000 });
  const dir = rv.lensesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'attack.md');
  fs.writeFileSync(file, 'Pretend to be a very suspicious raccoon.');
  try {
    const b = rv.reviewerBrief(c, 'attack');
    assert.match(b.text, /very suspicious raccoon/);
    assert.ok(!/Your only job is to break it/.test(b.text));
  } finally { fs.rmSync(file, { force: true }); }
});

test('what it claims meets the same gate: a second source corroborates, a line outside the change is dropped, and nothing it says blocks', () => {
  const c = fresh();
  rv.planPanel(c, { budget: 100000 });
  const html = c.findings.find(f => f.evidence.some(e => e.source.startsWith('rule:html-injection')))!;
  assert.ok(html, 'the free check saw the innerHTML');
  const before = core.verdictOf(c).tone;
  const r = core.applyClaims(repo.dir, c, [
    { title: 'Markup from the error reaches the page', lens: 'Security', severity: 'high', file: html.file, line: html.line, what: 'Input: an error string with a tag. The code: puts it into the page as markup. Should: show it as text.', source: 'reviewer:Attack' },
    { title: 'The first price of an empty order raises', lens: 'Correctness', file: 'src/totals.py', line: 16, what: 'Input: an empty list. The code: indexes element 0, which raises IndexError. Should: return nothing.', source: 'reviewer:Attack' },
    { title: 'Cites nothing of the change', lens: 'Correctness', file: 'src/never.py', line: 9, what: 'A break in a file that is not part of this change at all.', source: 'reviewer:Attack' }
  ]);
  rv.recordSubmission(c, 'Attack', r, { round: 1, done: true, tokens: 5200, claims: 3, disputes: [] });
  assert.equal(r.merged.length, 1, 'the claim at the flagged line was added to it');
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped.length, 1);
  const merged = c.findings.find(f => f.id === html.id)!;
  assert.ok(merged.evidence.some(e => e.source === 'reviewer:Attack'));
  assert.equal(merged.tier, 'corroborated', 'a free signal and the attacker are two sources, and that is not proof');
  const fresh1 = r.kept[0];
  assert.equal(fresh1.tier, 'hint', 'whatever its severity, what only the attacker says is a hint');
  assert.ok(!core.verdictOf(c).must.some(f => f.id === fresh1.id || f.id === html.id), 'nothing the attacker says blocks');
  assert.equal(core.verdictOf(c).tone === 'blocked', before === 'blocked');
  const a = c.panel!.attack!;
  assert.deepEqual([a.state, a.claims, a.kept, a.merged, a.dropped, a.reportedTokens], ['reported', 3, 1, 1, 1, 5200]);
});

test('the panel counts it with the others, and cross-examination waits for it and then examines what it claimed', () => {
  const c = fresh();
  const p = rv.planPanel(c, { budget: 100000 });
  const ran = p.reviewers.filter(r => r.run);
  for (const r of ran) rv.recordSubmission(c, r.lens, bare, { round: 1, done: true, claims: 0, disputes: [] });
  let s = rv.statusOf(c.panel);
  assert.equal(s.phase, 'reviewing', 'the specialists are done but the attack pass is not');
  assert.equal(s.running, ran.length + 1);
  assert.equal(s.reported, ran.length);
  assert.match(s.next, /1 reviewer still to report: Attack/);
  assert.equal(rv.openCross(c)?.state, 'planned', 'cross-examination waits for the attacker');

  const r = core.applyClaims(repo.dir, c, [{ title: 'The first price of an empty order raises', lens: 'Correctness', file: 'src/totals.py', line: 16, what: 'Input: an empty list. The code: indexes element 0, which raises IndexError. Should: return nothing.', source: 'reviewer:Attack' }]);
  rv.recordSubmission(c, 'attack', r, { round: 1, done: true, claims: 1, disputes: [] });
  s = rv.statusOf(c.panel);
  assert.equal(s.phase, 'cross');
  const cross = rv.openCross(c)!;
  assert.equal(cross.state, 'open');
  assert.ok(Object.values(cross.assigned).flat().includes(r.kept[0].id), 'a reviewer examines what the attacker claimed');
});

test('the panel as text lists the attack pass when it is on offer, and says how to run it', () => {
  const c = fresh();
  const big = rv.planPanel(c, { budget: 100000 });
  const text = rv.panelText(c, big);
  assert.match(text, /attack pass \d/);
  assert.match(text, /RUN\s+Attack\s+~[\d.]+k\s+Tries to break/);
  assert.match(text, /Run it: .*Attack/);
  assert.match(text, /You are the attacker for case c-.*lens "attack"/);
  const small = rv.panelText(fresh(), rv.previewPanel(fresh(), { budget: 40000 }));
  assert.ok(!/Attack/.test(small), 'below 80k it is not on offer, so it is not listed');
  const over = rv.panelText(fresh(), rv.previewPanel(fresh(), { budget: 80000 }));
  assert.match(over, /Attack/, 'at 80k it is on offer: it runs or says why not');
});

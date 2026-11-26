import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { makeRepo, SECRET, tempHome } from './fixtures.js';

/* The plain review (D51): one reviewer with no lens and no free findings, the stick the panel is measured against in a calibration run. */
tempHome();
const core = await import('../index.js');
const { calibration: cal, reviewers: rv, memory } = core;
after(() => memory.closeMemory());

function project(): ReturnType<typeof makeRepo> {
  const r = makeRepo('shop');
  r.commit({ 'src/web/app.js': 'export const a = 1;\n', 'src/web/ui.css': '.a { color: red; }\n', 'api/server.py': 'x = 1\n', 'package.json': '{ "name": "shop" }\n' }, 'Base');
  return r;
}

type Run = ReturnType<typeof cal.startCalibration>;
const at = (run: Run, id: string): { file: string; line: number } => { const b = run.planted.bugs.find(x => x.id === id)!; return { file: b.file, line: b.line }; };

/** What an agent does: a pass reads its brief and reports through the gate. */
function report(caseId: string, name: string, claims: Array<{ file: string; line: number }>, tokens = 2000): void {
  const c = core.loadCase(caseId)!;
  const lens = rv.reviewerFor(name)?.lens ?? 'Correctness';
  const gated = core.applyClaims(c.repo, c, claims.map(x => ({ title: 'Something is wrong here', lens, file: x.file, line: x.line, what: 'This line does something it should not, and here is why it matters.', source: `reviewer:${name}` })));
  core.saveCase(c);
  rv.recordSubmission(c, name, gated, { round: 1, done: true, tokens, claims: claims.length, disputes: [] });
}

test('a calibration run plans the plain review on both cases, and a real review never does', () => {
  const p = project();
  const run = cal.startCalibration(p.dir);
  for (const id of [run.planted.case, run.control.case]) {
    const panel = core.loadCase(id)!.panel!;
    assert.equal(panel.baseline?.run, true);
    assert.ok((panel.baseline?.tokens ?? 0) >= 800, 'it costs the length of the diff');
    assert.equal(panel.estimate.baseline, panel.baseline?.tokens);
    assert.equal(panel.estimate.total, panel.estimate.specialists + panel.cross.tokens + (panel.attack?.tokens ?? 0) + panel.baseline!.tokens);
  }
  assert.match(cal.handoffPrompt(run.planted.case, run.control.case), /plain review, lens "plain"/);
  const c = core.openCase({ repo: p.dir, range: 'HEAD' });
  assert.equal(rv.previewPanel(c, { budget: 100000 }).baseline, undefined, 'it is a measuring stick, not a reviewer you would want in a real review');
  assert.match(rv.panelText(core.loadCase(run.planted.case)!, core.loadCase(run.planted.case)!.panel!), /RUN\s+Plain review\s+~[\d.]+k/);
});

test('its brief is the whole change and nothing else: no lens, no free findings, no questions, no secret', () => {
  const p = project();
  const run = cal.startCalibration(p.dir);
  const c = core.loadCase(run.planted.case)!;
  const b = rv.reviewerBrief(c, 'plain');
  assert.match(b.text, /^REVIEWER BRIEF · Plain review · case c-/);
  assert.match(b.text, /Review this change as one capable engineer would/);
  assert.match(b.text, /THE CHANGE \(page 1 of \d+; \d+ files?\)/);
  assert.match(b.text, /── package\.json/, 'every changed file, not a lens’s slice');
  assert.match(b.text, /reviewer "Plain"/);
  assert.ok(!/ALREADY FOUND BY THE FREE CHECKS|QUESTIONS THIS PROJECT ASKS/.test(b.text), 'what the free checks and the memory know is what a plain review would not have had');
  assert.ok(!b.text.includes(SECRET) && !b.text.includes('AKIAQWERTY'), 'a key is masked');
  assert.equal(core.loadCase(run.planted.case)!.panel!.baseline!.state, 'briefed');
  assert.throws(() => rv.reviewerBrief(c, 'plain', { round: 2 }), /one round/);
  const real = core.openCase({ repo: p.dir, range: 'HEAD' });
  rv.planPanel(real, { budget: 100000 });
  assert.throws(() => rv.reviewerBrief(real, 'plain'), /only part of a calibration run/);
  assert.ok(rv.isPlain('Plain') && rv.isPlain('plain review') && !rv.isPlain('plainer'));
  assert.equal(rv.reviewerFor('plain'), undefined, 'not a lens');
});

test('the scoreboard has a row for it: caught, flagged, missed, false alarms, and what the lenses add over it', () => {
  const p = project();
  const run = cal.startCalibration(p.dir);
  let b = cal.scoreRun(run, { persist: false });
  const early = b.rows.find(r => r.id === 'plain')!;
  assert.equal(early.ran, false);
  assert.match(early.advice, /Not reported yet/);
  assert.equal(b.plainRan, false);
  assert.ok(b.bugs.every(x => x.plain === 'n'));

  // one plain review flags the committed key (the free checks prove it), two bugs only a reading could find, and cries wolf once on the clean twin
  report(run.planted.case, 'Plain', [at(run, 'hardcoded-key'), at(run, 'off-by-one'), at(run, 'swapped-args')], 6000);
  report(run.control.case, 'Plain', [{ file: 'src/web/comment_list.js', line: 5 }], 2500);
  b = cal.scoreRun(run, { persist: false });
  const row = b.rows.find(r => r.id === 'plain')!;
  assert.equal(b.rows.at(-1)!.id, 'plain', 'the baseline row comes last');
  assert.equal(row.ran, true);
  assert.deepEqual([row.caught, row.flagged, row.alarms, row.hits], [1, 2, 1, 3]);
  assert.equal(row.missed, b.planted - 3);
  assert.equal(row.tokens, 8500);
  assert.equal(row.tokensKind, 'reported');
  assert.equal(row.perCatch, Math.round(8500 / 3));
  assert.equal(b.plainSeen, 3);
  assert.equal(b.bugs.find(x => x.bug.id === 'hardcoded-key')!.plain, 'C');
  assert.equal(b.bugs.find(x => x.bug.id === 'off-by-one')!.plain, 'h');
  assert.equal(b.bugs.find(x => x.bug.id === 'html-sink')!.plain, 'm');
  assert.match(row.advice, /flagged 3 of \d+\. Run the reviewers to compare/);

  // then the panel: Security flags five bugs, so the lenses have something to show over one plain review
  report(run.planted.case, 'Security', [at(run, 'hardcoded-key'), at(run, 'html-sink'), at(run, 'sql-concat-py'), at(run, 'shell-py'), at(run, 'n-plus-one')], 3000);
  b = cal.scoreRun(run, { persist: false });
  assert.match(b.rows.find(r => r.id === 'plain')!.advice, /One plain review flagged 3 of \d+; the panel flagged \d+\. The lenses are adding something\./);
});

test('every pass reports first, then cross-examination opens, and what only the plain review claimed is left alone', () => {
  const p = project();
  const run = cal.startCalibration(p.dir);
  const id = run.planted.case;
  const claimed = [at(run, 'off-by-one')];
  report(id, 'Plain', claimed, 100);
  let c = core.loadCase(id)!;
  const passes = [...c.panel!.reviewers.filter(r => r.run).map(r => r.lens as string), ...(c.panel!.attack?.run ? ['Attack'] : [])];
  let s = rv.statusOf(c.panel);
  assert.equal(s.running, passes.length + 1, 'the plain review is counted with the others');
  assert.match(s.next, /still to report/);
  assert.equal(rv.openCross(c)?.state, 'planned', 'cross-examination waits for every pass');
  // a lens reviewer claims something at its own place, so there is something to examine
  for (const who of passes) report(id, who, who === 'Security' ? [at(run, 'swapped-args')] : [], 100);
  c = core.loadCase(id)!;
  s = rv.statusOf(c.panel);
  assert.equal(s.phase, 'cross');
  const cross = rv.openCross(c)!;
  const assigned = Object.values(cross.assigned).flat();
  const plainOnly = c.findings.filter(f => f.origin === 'claim' && f.evidence.some(e => e.source === 'reviewer:Plain') && f.evidence.filter(e => e.source.startsWith('reviewer:')).length === 1);
  assert.ok(plainOnly.length >= 1, 'the plain review claimed something no one else did');
  assert.ok(plainOnly.every(f => !assigned.includes(f.id)), 'and no one is asked to confirm it');
  assert.ok(assigned.length >= 1, 'what a lens reviewer claimed alone is still examined');
});

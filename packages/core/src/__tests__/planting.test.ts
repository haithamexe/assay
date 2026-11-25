import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

tempHome();
const core = await import('../index.js');
const { calibration: cal, reviewers: rv, memory } = core;
after(() => memory.closeMemory());

/** A small project: JavaScript and CSS under src/web, Python under api, and a package.json. */
function project(): ReturnType<typeof makeRepo> {
  const r = makeRepo('shop');
  r.commit({ 'src/web/app.js': 'export const a = 1;\n', 'src/web/ui.css': '.a { color: red; }\n', 'api/server.py': 'x = 1\n', 'package.json': '{ "name": "shop" }\n' }, 'Base');
  return r;
}

test('calibration plants what fits the project, in the folders the project already uses, and says what it left out', () => {
  const p = project();
  const pre = cal.previewCalibration(p.dir);
  assert.ok(pre.fit.length >= 15);
  assert.equal(pre.skipped.length, 1);
  assert.match(pre.skipped[0].why, /HTML/);
  assert.equal(pre.shape.js, 'src/web');
  assert.equal(pre.shape.py, 'api');
  assert.equal(pre.shape.css, 'src/web');

  const onlyPy = makeRepo('pyonly');
  onlyPy.commit({ 'app/main.py': 'x = 1\n' }, 'Base');
  const py = cal.previewCalibration(onlyPy.dir);
  assert.ok(py.fit.every(f => /py|Python|Security|Correctness|Tests/.test(f.lens)));
  assert.ok(py.fit.length >= 4 && py.fit.length < pre.fit.length);
  assert.ok(py.skipped.some(s => /package\.json/.test(s.why)), 'no package.json, no look-alike dependency');

  const docs = makeRepo('docs');
  docs.commit({ 'README.md': '# nothing to plant after\n' }, 'Base');
  assert.throws(() => cal.startCalibration(docs.dir), /nothing to plant/);
});

test('the bugs go into a throwaway repository, with an exact line each, and a clean twin; the project is not touched', () => {
  const p = project();
  const before = p.git('status', '--porcelain') + p.git('rev-parse', 'HEAD');
  const run = cal.startCalibration(p.dir, { budget: 100000 });
  assert.equal(p.git('status', '--porcelain') + p.git('rev-parse', 'HEAD'), before, 'the project is only read');
  assert.match(run.id, /^cal-[0-9a-f]{8}$/);
  assert.ok(run.dir.startsWith(path.join(process.env.ASSAY_HOME!, 'calibration')), 'it lives in Assay’s own folder');
  assert.equal(run.planted.bugs.length, 17);
  for (const bug of run.planted.bugs) {
    const file = path.join(run.dir, ...bug.file.split('/'));
    assert.ok(fs.existsSync(file) || bug.side === 'removed', `${bug.file} exists on the planted branch`);
    const text = (bug.side === 'removed' ? 'x' : fs.readFileSync(file, 'utf8')).split('\n');
    if (bug.side === 'added') assert.ok(text[bug.line - 1] !== undefined && text[bug.line - 1].trim().length > 0, `${bug.id}: line ${bug.line} is a line of ${bug.file}`);
  }
  const names = run.planted.bugs.map(b => path.basename(b.file));
  assert.ok(!names.some(n => /plant|bug|calib|test_bug/i.test(n)), 'a file name must not say where to look');
  assert.ok(run.planted.bugs.some(b => b.file === 'src/web/comment_list.js'), 'in the project’s JavaScript folder');
  assert.ok(run.planted.bugs.some(b => b.file === 'api/order_store.py'), 'and its Python folder');
  assert.ok(run.planted.bugs.some(b => b.file === 'tests/price_totals.test.js'), 'tests under tests/');
  const guard = run.planted.bugs.find(b => b.id === 'removed-guard')!;
  assert.equal(guard.side, 'removed');
  assert.equal(run.planted.head === run.control.head, false);
  assert.equal(core.loadCase(run.planted.case)!.panel?.budget, 100000);
  assert.ok(core.loadCase(run.control.case)!.panel, 'both cases have a panel planned');
  const messages = [run.planted.head, run.control.head].map(h => p.git('-C', run.dir, 'log', '-1', '--format=%s', h).trim() || 'x');
  assert.ok(messages.length === 2);
});

test('the free checks are scored on the spot: some bugs caught, some flagged, some only a reviewer could find, and no false alarm on the clean twins', () => {
  const p = project();
  const run = cal.startCalibration(p.dir);
  const b = cal.scoreRun(run, { persist: false });
  assert.equal(b.planted, 17);
  assert.equal(b.complete, false, 'no reviewer has reported');
  assert.equal(b.reviewersRan, 0);
  const free = (id: string): string => b.bugs.find(x => x.bug.id === id)!.free;
  assert.equal(free('hardcoded-key'), 'C', 'a committed key is proven');
  for (const id of ['html-sink', 'sql-concat', 'removed-guard', 'lookalike-dependency', 'physical-side', 'sql-concat-py', 'shell-py', 'removed-guard-py']) assert.equal(free(id), 'h', `${id} is flagged, not proven`);
  for (const id of ['off-by-one', 'swapped-args', 'weak-assertion', 'n-plus-one', 'fixed-width', 'faint-text', 'off-by-one-py', 'weak-assertion-py']) assert.equal(free(id), 'm', `${id} is something only a reviewer can find`);
  assert.equal(b.freeProven, 1);
  assert.equal(b.freeSeen, 9);
  assert.equal(b.rows[0].alarms, 0, 'the clean twins raise no flag: these are Assay’s own false alarms, and there are none');
  assert.equal(b.rows[0].advice, 'Keep. Free.');
  const sec = b.rows.find(r => r.id === 'Security')!;
  assert.equal(sec.ran, false);
  assert.equal(sec.chances, 5);
  assert.match(sec.advice, /Not reported yet/);
  assert.ok(b.bugs.every(x => x.cells.Security === 'n'));
});

/** What an agent does: reviewers read their slice and report through the gate; here, with claims chosen to be right or wrong. */
function report(run: ReturnType<typeof cal.startCalibration>, which: 'planted' | 'control', who: string, claims: Array<{ file: string; line: number; title?: string; lens?: string }>, tokens = 2000): void {
  const caseId = which === 'planted' ? run.planted.case : run.control.case;
  const c = core.loadCase(caseId)!;
  const lens = rv.reviewerFor(who)!.lens;
  const gated = core.applyClaims(c.repo, c, claims.map(x => ({ title: x.title ?? 'Something is wrong here', lens: (x.lens ?? lens) as never, file: x.file, line: x.line, what: 'This line does something it should not, and here is why it matters.', source: `reviewer:${lens}` })));
  core.saveCase(c);
  rv.recordSubmission(c, who, gated, { round: 1, done: true, tokens, claims: claims.length, disputes: [] });
}

test('reviewers are scored against the truth: caught with or without proof, missed, false alarms on the clean twins, tokens per catch', () => {
  const p = project();
  const run = cal.startCalibration(p.dir);
  const at = (id: string): { file: string; line: number } => { const b = run.planted.bugs.find(x => x.id === id)!; return { file: b.file, line: b.line }; };
  const all = (c: string): string[] => core.loadCase(c)!.panel!.reviewers.filter(r => r.run).map(r => r.lens);
  const planned = all(run.planted.case);
  for (const lens of ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Performance']) assert.ok(planned.includes(lens), `${lens} is in the panel for the planted case`);

  // Security finds the key (proven by the free checks) and the html sink, and misses sql-concat; it also cries wolf once on the clean twin.
  report(run, 'planted', 'Security', [at('hardcoded-key'), at('html-sink'), at('sql-concat-py'), at('shell-py'), at('n-plus-one')], 3000);
  report(run, 'control', 'Security', [{ file: 'src/web/comment_list.js', line: 5 }], 1000);
  // Correctness finds off-by-one and swapped-args, nothing else, and nothing false.
  report(run, 'planted', 'Correctness', [at('off-by-one'), at('swapped-args')], 2000);
  report(run, 'control', 'Correctness', [], 800);
  // UI finds nothing at all.
  report(run, 'planted', 'UI', [], 1500);
  report(run, 'control', 'UI', [], 500);
  // Tests finds the weakened assertion.
  report(run, 'planted', 'Tests', [at('weak-assertion')], 900);
  report(run, 'control', 'Tests', [], 400);
  for (const lens of ['Supply chain', 'Performance']) { report(run, 'planted', lens, [], 700); report(run, 'control', lens, [], 300); }

  const b = cal.scoreRun(run, { persist: false });
  assert.equal(b.complete, true, 'every planned reviewer reported on both cases');
  assert.equal(b.reviewersRan, 6);
  const row = (id: string): ReturnType<typeof cal.scoreRun>['rows'][number] => b.rows.find(r => r.id === id)!;
  const cell = (bug: string, lens: string): string | undefined => b.bugs.find(x => x.bug.id === bug)!.cells[lens as 'Security'];

  assert.equal(cell('hardcoded-key', 'Security'), 'C', 'its claim landed on a finding the free checks proved');
  assert.equal(cell('html-sink', 'Security'), 'h', 'flagged, no proof');
  assert.equal(cell('sql-concat', 'Security'), 'm', 'a bug in its lens that it did not mention');
  assert.equal(cell('n-plus-one', 'Security'), 'h', 'a catch outside its own lens still counts');
  assert.equal(cell('off-by-one', 'Security'), '-', 'not its lens, and not flagged');
  assert.equal(cell('off-by-one', 'Correctness'), 'h');
  assert.equal(cell('weak-assertion', 'Tests'), 'h');
  assert.equal(cell('fixed-width', 'UI'), 'm');

  const sec = row('Security');
  assert.equal(sec.caught, 1);
  assert.equal(sec.flagged, 4);
  assert.equal(sec.hits, 4, 'own-lens hits: key, html sink, sql py, shell py');
  assert.equal(sec.chances, 5);
  assert.equal(sec.alarms, 1, 'one flag on the clean twin');
  assert.equal(sec.tokens, 4000);
  assert.equal(sec.tokensKind, 'reported');
  assert.equal(sec.perCatch, 800, '4000 tokens for 5 catches');
  assert.match(sec.advice, /Keep/);
  assert.equal(row('Correctness').hits, 2);
  assert.equal(row('Correctness').chances, 5);
  assert.equal(row('UI').hits, 0);
  assert.equal(row('UI').chances, 3);
  assert.match(row('UI').advice, /Caught none of 3/);
  assert.equal(row('Performance').chances, 1);
  assert.ok(b.seen >= 9);
});

test('a reviewer that catches none of the bugs planted in its lens in two runs in a row is left out of plans, and can be brought back', () => {
  const p = project();
  const plan = (): ReturnType<typeof rv.previewPanel> => rv.previewPanel(core.openCase({ repo: p.dir, last: 1 }), { budget: 100000 });
  const runOnce = (): void => {
    const run = cal.startCalibration(p.dir);
    const at = (id: string): { file: string; line: number } => { const b = run.planted.bugs.find(x => x.id === id)!; return { file: b.file, line: b.line }; };
    report(run, 'planted', 'Security', [at('html-sink')]);
    report(run, 'control', 'Security', []);
    report(run, 'planted', 'UI', []);
    report(run, 'control', 'UI', []);
    for (const lens of ['Correctness', 'Tests', 'Supply chain', 'Performance']) { report(run, 'planted', lens, []); report(run, 'control', lens, []); }
    cal.scoreRun(run);
  };
  p.commit({ 'src/web/more.css': '.b { right: 1px; }\n', 'src/web/more.js': Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' }, 'Change the pages');
  assert.equal(cal.routedOut(p.dir).size, 0, 'nothing yet');
  assert.equal(plan().reviewers.find(r => r.lens === 'UI')!.run, true, 'UI is worth running here');

  runOnce();
  assert.equal(cal.history(p.dir).length, 1);
  assert.equal(cal.routedOut(p.dir).size, 0, 'one run is a hint, not a record');
  assert.equal(plan().reviewers.find(r => r.lens === 'UI')!.run, true);

  runOnce();
  assert.equal(cal.history(p.dir).length, 2);
  const out = cal.routedOut(p.dir);
  assert.deepEqual([...out.keys()].sort(), ['Correctness', 'Performance', 'Supply chain', 'Tests', 'UI']);
  assert.ok(!out.has('Security'), 'Security caught a bug both times');
  assert.match(out.get('UI')!, /caught none of the 6 bugs planted in its lens/);

  const left = plan();
  const ui = left.reviewers.find(r => r.lens === 'UI')!;
  assert.equal(ui.run, false);
  assert.equal(ui.skip, 'calibration');
  assert.match(ui.why, /^Left out: .*last 2 calibration runs\. Bring it back with: assay reviewers plan --include ui$/);
  assert.notEqual(left.reviewers.find(r => r.lens === 'Security')!.skip, 'calibration', 'a reviewer that did catch bugs is never left out');
  assert.ok(left.estimate.total < rv.previewPanel(core.openCase({ repo: p.dir, last: 1 }), { budget: 100000, include: ['UI', 'Correctness', 'Tests', 'Supply chain', 'Performance'] }).estimate.total, 'leaving them out saves their tokens');

  const back = rv.previewPanel(core.openCase({ repo: p.dir, last: 1 }), { budget: 100000, include: ['UI'] });
  assert.equal(back.reviewers.find(r => r.lens === 'UI')!.run, true, '--include brings it back');
  assert.notEqual(back.id, left.id, 'and it is a different plan');
  assert.equal(rv.previewPanel(core.openCase({ repo: p.dir, last: 1 }), { budget: 0 }).reviewers.find(r => r.lens === 'UI')!.skip, 'off', 'a free-only budget says so, not "calibration"');
});

test('old throwaway repositories are cleaned, what they showed is kept, and a run id can only be its fixed shape', () => {
  const p = project();
  const first = cal.startCalibration(p.dir);
  for (let i = 0; i < 6; i++) cal.startCalibration(p.dir);
  assert.ok(cal.listRuns(p.dir).length <= 6);
  assert.equal(fs.existsSync(first.dir), false, 'a run beyond the newest five is removed when another starts');
  assert.ok(cal.latestRun(p.dir));
  const n = cal.cleanRuns(p.dir, true);
  assert.ok(n >= 5);
  assert.equal(cal.latestRun(p.dir), null);
  assert.equal(cal.history(p.dir).length, 0, 'nothing had finished');
  assert.equal(cal.loadRun('../../etc'), null, 'a run id is only ever its fixed shape, so it can name no other folder');
  assert.equal(cal.loadRun('cal-00000000'), null);
});

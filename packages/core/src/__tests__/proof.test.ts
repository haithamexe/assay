import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* A real project with a real test suite (Node's own runner), so the proof is real: nothing here is faked. */
tempHome();
const core = await import('../index.js');

const PKG = '{\n  "name": "calc",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n';
const CALC_OK = `export function discount(total, pct) {
  return total - (total * pct) / 100;
}

export function isAdult(age) {
  return age >= 18;
}
`;
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { discount, isAdult } from '../src/calc.js';

test('discount takes a percentage off', () => {
  assert.equal(discount(200, 10), 180);
});

test('an adult is 18 or over', () => {
  assert.equal(isAdult(30), true);
  assert.equal(isAdult(5), false);
});
`;
// breaks discount: the tests notice
const CALC_BROKEN = CALC_OK.replace('(total * pct) / 100', '(total * pct) * 100');
// the same behaviour written another way (a covered line a mutation can be noticed on), plus logic the tests never touch, with a risky pattern in it
const EXTRA = `${CALC_OK.replace('(total * pct) / 100', 'total * pct / 100')}
export function render(el, text) {
  const shown = text.length > 3;
  if (shown === true) {
    el.innerHTML = text;
  }
  return shown;
}

export function tier(points) {
  return points >= 100 ? 'gold' : 'basic';
}
`;

function project() {
  const repo = makeRepo();
  const base = repo.commit({ 'package.json': PKG, 'src/calc.js': CALC_OK, 'test/calc.test.js': TEST }, 'Base');
  return { repo, base };
}

test('proof is refused until a person allows it, and the refusal says how', async () => {
  const { repo, base } = project();
  repo.commit({ 'src/calc.js': CALC_BROKEN }, 'Refactor discount');
  const c = core.openCase({ repo: repo.dir, range: `${base}..HEAD` });
  assert.equal(core.isAllowed(repo.dir), false);
  await assert.rejects(() => core.proveCase(c), /assay allow-run/);
});

test('a run that is stopped runs nothing, keeps nothing and says who stopped it', async () => {
  const { repo, base } = project();
  const head = repo.commit({ 'src/calc.js': CALC_BROKEN }, 'Refactor discount');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const ctl = new AbortController();
  ctl.abort();
  const t0 = Date.now();
  const report = await core.proveCase(c, { mutants: 0, reverts: 0, signal: ctl.signal });
  assert.match(String(report.stopped), /stopped by the person/);
  assert.equal(report.ran, false);
  assert.equal(c.runs.length, 0);
  assert.ok(c.findings.every(f => f.origin !== 'run'));
  assert.ok(Date.now() - t0 < 5000, 'no test run was started');
  const look = await core.lookCase(c, { signal: ctl.signal });
  assert.equal(look.ran, false);
  assert.equal(c.runs.length, 0);
});

test('a real regression is proven: the tests passed at the base and fail at the head', async () => {
  const { repo, base } = project();
  const head = repo.commit({ 'src/calc.js': CALC_BROKEN }, 'Refactor discount');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });
  assert.equal(report.ran, true);
  assert.equal(report.command, 'npm test');
  assert.equal(report.base?.exit, 0);
  assert.notEqual(report.head?.exit, 0);
  assert.ok(report.regressions.some(n => /discount takes a percentage off/.test(n)), `named the failing test: ${report.regressions}`);
  const f = c.findings.find(x => x.origin === 'run' && /now fail/.test(x.title))!;
  assert.equal(f.tier, 'proven');
  assert.equal(f.severity, 'high');
  assert.equal(f.file, 'src/calc.js');
  assert.equal(core.verdictOf(c).tone, 'blocked');
  assert.ok(f.evidence.every(e => e.kind === 'test-fail'));
  // run again: everything comes from the cache, and the case keeps its proof when reopened
  const again = await core.proveCase(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), { mutants: 0, reverts: 0 });
  assert.equal(again.base?.cached, true);
  assert.equal(again.head?.cached, true);
  const reopened = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  assert.ok(reopened.findings.some(x => x.origin === 'run' && x.tier === 'proven'));
  assert.equal(core.verdictOf(reopened).tone, 'blocked');
  // and replaying it runs the suite again, for real
  const r = await core.replayEvidence(reopened, f.evidence[0].id);
  assert.equal(r.reproduced, true);
  assert.match(r.detail, /passed at the base, failed at the head/);
});

test('a green change: the revert test and mutation find what the tests do not cover', async () => {
  const { repo, base } = project();
  const head = repo.commit({ 'src/calc.js': EXTRA }, 'Add render and tier');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const html = c.findings.find(f => f.evidence.some(e => e.source === 'rule:html-injection'))!;
  assert.ok(html, 'the free check saw the innerHTML');
  const report = await core.proveCase(c, { mutants: 6, reverts: 2 });
  assert.equal(report.regressions.length, 0);
  assert.equal(report.head?.exit, 0);

  // reverting the risky hunk changes no test result
  assert.ok(report.reverts.some(r => r.result === 'unnoticed' && r.file === 'src/calc.js'), JSON.stringify(report.reverts));
  const revert = c.findings.find(f => f.origin === 'run' && /No test notices/.test(f.title))!;
  assert.equal(revert.tier, 'proven');
  assert.equal(revert.lens, 'Tests');
  assert.notEqual(revert.severity, 'high', 'untested is not the same as broken: it must not block');
  assert.ok(revert.evidence.some(e => e.kind === 'revert-test'));

  // and the risky pattern now has a second, independent signal
  const after = c.findings.find(f => f.id === html.id)!;
  assert.ok(after.evidence.some(e => e.source === 'coverage:revert'));
  assert.ok(after.tier === 'corroborated' || after.tier === 'proven');
  assert.notEqual(after.tier, 'proven', 'a coverage signal corroborates; it does not prove the pattern is a bug');

  // deliberate changes the tests don't notice
  const survived = report.mutants.filter(m => m.result === 'survived');
  assert.ok(survived.length >= 1, JSON.stringify(report.mutants));
  const mut = c.findings.find(f => f.origin === 'run' && /deliberate changes/.test(f.title))!;
  assert.equal(mut.tier, 'proven');
  assert.ok(mut.evidence.every(e => e.kind === 'mutation-survivor' && e.replay?.run?.kind === 'mutant'));
  // a mutant on a line the tests do cover is noticed
  assert.ok(report.mutants.some(m => m.result === 'killed'), 'the discount line is covered, so changing it is noticed');
  assert.equal(core.verdictOf(c).tone === 'blocked', false);

  // the project's own files were never touched, and no checkout is left behind
  assert.equal(repo.git('status', '--porcelain').trim(), '');
});

test('without a test command there is nothing to run, and it says so', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'README.md': '# x\n' }, 'Base');
  const head = repo.commit({ 'src/a.js': 'export const a = 1;\n' }, 'Add');
  core.setRepoSettings(repo.dir, { allow: true });
  const report = await core.proveCase(core.openCase({ repo: repo.dir, range: `${base}..${head}` }));
  assert.equal(report.ran, false);
  assert.match(report.reason ?? '', /allow-run --command/);
});

test('a time budget stops new runs and keeps what was done', async () => {
  const { repo, base } = project();
  const head = repo.commit({ 'src/calc.js': EXTRA }, 'Add');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const r = await core.proveCase(c, { budgetSeconds: 0, mutants: 3, reverts: 1, fresh: true });
  assert.equal(r.ran, false);
  assert.match(r.stopped ?? '', /budget/);
});

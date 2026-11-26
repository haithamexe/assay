import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchFirstBad, type Judged } from '../proof/bisect.js';
import { makeRepo, tempHome } from './fixtures.js';

/* Which commit broke it (D49). The search itself knows nothing about tests, so it is checked on its own first; then on a real project. */
tempHome();
const core = await import('../index.js');
const git = await import('../git.js');

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`);
const idx = (c: string): number => Number(c.slice(1));

test('the search finds the first bad commit, never judges the head, and needs at most log2 of the commits', async () => {
  for (let n = 2; n <= 40; n++) {
    for (let k = 0; k < n; k++) {
      const seen: string[] = [];
      const s = await searchFirstBad(names(n), async c => { seen.push(c); return idx(c) >= k ? 'bad' : 'good'; });
      assert.deepEqual([s.found, s.hi, s.lo], [true, k, k - 1], `n=${n} k=${k}`);
      assert.ok(seen.length <= Math.ceil(Math.log2(n)), `n=${n} k=${k}: ${seen.length} runs`);
      assert.ok(!seen.includes(`c${n - 1}`), 'the head is known to fail and is not run again');
      assert.equal(s.tried, seen.length);
    }
  }
});

test('a line that goes bad, good, bad again still ends on a real change: good just before, bad right there', async () => {
  let seed = 7;
  const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 300; round++) {
    const n = 2 + Math.floor(next() * 30);
    const pattern: Judged[] = Array.from({ length: n }, () => (next() < 0.5 ? 'good' : 'bad'));
    pattern[n - 1] = 'bad';
    const s = await searchFirstBad(names(n), async c => pattern[idx(c)]);
    assert.equal(s.found, true);
    assert.equal(s.hi, s.lo + 1);
    assert.equal(pattern[s.hi], 'bad');
    assert.ok(s.lo < 0 || pattern[s.lo] === 'good', 'what it calls the last good commit is good');
  }
});

test('a result that can’t be judged, or a stop, ends the search with what is known so far', async () => {
  const unclear = await searchFirstBad(names(10), async () => 'unclear');
  assert.deepEqual([unclear.found, unclear.stopped, unclear.lo, unclear.hi, unclear.tried], [false, 'unclear', -1, 9, 1]);
  // the middle is c4 (good), then c6 is where it is stopped
  const stop = await searchFirstBad(names(10), async c => (idx(c) === 6 ? 'stop' : idx(c) <= 4 ? 'good' : 'bad'));
  assert.equal(stop.found, false);
  assert.equal(stop.stopped, 'stop');
  assert.ok(stop.lo === 4 && stop.hi === 9, `narrowed to 4..9, got ${stop.lo}..${stop.hi}`);
});

test('the commits to search are the first-parent line from the base to the head, and only when it starts at the base', () => {
  const repo = makeRepo();
  const m1 = repo.commit({ 'a.txt': '1\n' }, 'One');
  repo.git('checkout', '-q', '-b', 'feature');
  const f1 = repo.commit({ 'f.txt': '1\n' }, 'Feature one');
  const f2 = repo.commit({ 'f.txt': '2\n' }, 'Feature two');
  repo.git('checkout', '-q', 'main');
  const m2 = repo.commit({ 'a.txt': '2\n' }, 'Two');
  repo.git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
  const merge = repo.git('rev-parse', 'HEAD').trim();
  assert.deepEqual(git.firstParentChain(repo.dir, m1, m2), [m2]);
  assert.deepEqual(git.firstParentChain(repo.dir, m1, merge), [m2, merge], 'a merge is one step: the branch it joined is not walked');
  assert.equal(git.firstParentChain(repo.dir, f1, merge), null, 'f1 is on the side branch, not on the first-parent line of the merge');
  assert.equal(git.firstParentChain(repo.dir, f2, m2), null, 'a base that is not behind the head');
});

/* A real project with a real test suite, so the search runs the real thing. */
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
const BREAK_DISCOUNT = (s: string): string => s.replace('(total * pct) / 100', '(total * pct) * 100');
const BREAK_ADULT = (s: string): string => s.replace('age >= 18', 'age < 18');

function project(): { repo: ReturnType<typeof makeRepo>; base: string } {
  const repo = makeRepo();
  const base = repo.commit({ 'package.json': PKG, 'src/calc.js': CALC_OK, 'test/calc.test.js': TEST }, 'Base');
  return { repo, base };
}

test('five commits, one of them breaks the tests: it is found, named, and anchored on the code it changed', async () => {
  const { repo, base } = project();
  const v1 = `${CALC_OK}// 1\n`;
  const c1 = repo.commit({ 'src/calc.js': v1 }, 'Add a note');
  const c2 = repo.commit({ 'README.md': '# calc\n' }, 'Add a readme');
  const v3 = BREAK_DISCOUNT(v1);
  const c3 = repo.commit({ 'src/calc.js': v3 }, 'Refactor discount');
  repo.commit({ 'docs/notes.md': 'notes\n' }, 'Write notes');
  const head = repo.commit({ 'src/calc.js': `${v3}// 5\n` }, 'Another note');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });

  const cu = report.culprit!;
  assert.ok(cu, 'a culprit was looked for');
  assert.equal(cu.commit, c3);
  assert.equal(cu.lastGood, c2);
  assert.equal(cu.subject, 'Refactor discount');
  assert.deepEqual([cu.commits, cu.runs, cu.cached, cu.span], [5, 2, 0, 1], 'five commits took two runs, not three');
  assert.equal(c1.length > 0, true);

  const f = c.findings.find(x => x.origin === 'run' && /now fail/.test(x.title))!;
  assert.match(f.title, new RegExp(`starting at ${c3.slice(0, 7)}`));
  assert.equal(f.tier, 'proven');
  assert.equal(f.file, 'src/calc.js');
  assert.equal(f.commit, head, 'the finding keeps its id: it is about the range, and the culprit is evidence about it');
  assert.ok(f.observed.some(o => o.includes(c3.slice(0, 7)) && /first commit in the range where it fails/.test(o)));
  assert.ok(f.inferred.some(o => /probably broke it/.test(o) && o.includes(c3.slice(0, 7))));
  const ev = f.evidence.find(e => e.source === 'proof:bisect')!;
  assert.equal(ev.kind, 'test-fail', 'it is proof: both ends were run');
  assert.deepEqual(ev.replay?.run?.between, { good: c2, bad: c3 });
  assert.match(ev.what, /discount takes a percentage off/, 'it says what failed there');
  assert.equal(core.verdictOf(c).tone, 'blocked');

  // asking again costs nothing: every run in the search comes from the cache
  const again = await core.proveCase(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), { mutants: 0, reverts: 0 });
  assert.deepEqual([again.culprit?.commit, again.culprit?.runs, again.culprit?.cached], [c3, 2, 2]);

  // a reopened case keeps it, and the evidence replays for real: the two commits are run again
  const reopened = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const kept = reopened.findings.find(x => x.id === f.id)!;
  const r = await core.replayEvidence(reopened, kept.evidence.find(e => e.source === 'proof:bisect')!.id);
  assert.equal(r.reproduced, true, r.detail);
  assert.match(r.detail, new RegExp(`passed at ${c2.slice(0, 7)} and failed at ${c3.slice(0, 7)}|at ${c2.slice(0, 7)} and ${c3.slice(0, 7)}: it passed at the first and failed at the second`));
});

test('the head itself can be the one that broke it, and the first commit can be', async () => {
  const { repo, base } = project();
  const c1 = repo.commit({ 'src/calc.js': BREAK_DISCOUNT(CALC_OK) }, 'Break it first');
  const c2 = repo.commit({ 'README.md': 'x\n' }, 'Then something else');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const first = await core.proveCase(core.openCase({ repo: repo.dir, range: `${base}..${c2}` }), { mutants: 0, reverts: 0 });
  assert.equal(first.culprit?.commit, c1);
  assert.equal(first.culprit?.lastGood, base, 'the base is the last commit known to pass');

  const { repo: r2, base: b2 } = project();
  r2.commit({ 'README.md': 'x\n' }, 'Harmless');
  const h2 = r2.commit({ 'src/calc.js': BREAK_DISCOUNT(CALC_OK) }, 'Break it last');
  core.setRepoSettings(r2.dir, { allow: true, timeout: 120 });
  const last = await core.proveCase(core.openCase({ repo: r2.dir, range: `${b2}..${h2}` }), { mutants: 0, reverts: 0 });
  assert.equal(last.culprit?.commit, h2);
});

test('a one-commit range has nothing to search, and --no-bisect skips the search and says how to get it', async () => {
  const { repo, base } = project();
  const head = repo.commit({ 'src/calc.js': BREAK_DISCOUNT(CALC_OK) }, 'Break it');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const one = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const rep = await core.proveCase(one, { mutants: 0, reverts: 0 });
  assert.equal(rep.culprit, undefined);
  assert.ok(!/starting at/.test(one.findings.find(x => x.origin === 'run')!.title));

  const { repo: r2, base: b2 } = project();
  r2.commit({ 'README.md': 'x\n' }, 'Harmless');
  const h2 = r2.commit({ 'src/calc.js': BREAK_DISCOUNT(CALC_OK) }, 'Break it');
  core.setRepoSettings(r2.dir, { allow: true, timeout: 120 });
  const c2 = core.openCase({ repo: r2.dir, range: `${b2}..${h2}` });
  const off = await core.proveCase(c2, { mutants: 0, reverts: 0, bisect: false });
  assert.equal(off.culprit, undefined);
  const f = c2.findings.find(x => x.origin === 'run')!;
  assert.ok(f.inferred.some(s => /--no-bisect/.test(s)));
  assert.ok(!f.evidence.some(e => e.source === 'proof:bisect'));
  assert.equal(f.tier, 'proven', 'it is still proven: the culprit is extra');
});

test('tests that already failed at the base can’t say which commit first failed, and it says so', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'package.json': PKG, 'src/calc.js': BREAK_DISCOUNT(CALC_OK), 'test/calc.test.js': TEST }, 'Base with a failing test');
  repo.commit({ 'README.md': 'x\n' }, 'Harmless');
  const head = repo.commit({ 'src/calc.js': BREAK_ADULT(BREAK_DISCOUNT(CALC_OK)) }, 'Break another');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });
  assert.ok(report.regressions.some(n => /adult/.test(n)), `a new failure is still a regression: ${report.regressions}`);
  assert.equal(report.culprit?.commit, null);
  assert.match(String(report.culprit?.why), /already failed at the base/);
  assert.equal(report.culprit?.runs, 0, 'nothing was run for it');
  const f = c.findings.find(x => x.origin === 'run' && /now fail/.test(x.title))!;
  assert.equal(f.tier, 'proven');
  assert.ok(f.inferred.some(s => /already failed at the base/.test(s)));
});

test('a stopped search says it stopped, and the next call carries on from what was kept', async () => {
  const { repo, base } = project();
  repo.commit({ 'README.md': '1\n' }, 'One');
  repo.commit({ 'README.md': '2\n' }, 'Two');
  const c3 = repo.commit({ 'src/calc.js': BREAK_DISCOUNT(CALC_OK) }, 'Break it');
  repo.commit({ 'README.md': '3\n' }, 'Four');
  const head = repo.commit({ 'README.md': '4\n' }, 'Five');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  // the base and the head run, then the first commit in the middle is the last one the budget allows
  const ctl = new AbortController();
  const report = await core.proveCase(c, { mutants: 0, reverts: 0, signal: ctl.signal, onProgress: m => { if (/Which commit broke it/.test(m)) ctl.abort(); } });
  assert.match(String(report.stopped), /stopped by the person/);
  assert.equal(report.culprit?.commit, null);
  assert.ok(report.culprit && report.culprit.span > 1, 'it is known only to be somewhere in the range');
  assert.match(String(report.culprit?.why), /run it again to carry on/);

  const done = await core.proveCase(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), { mutants: 0, reverts: 0 });
  assert.equal(done.culprit?.commit, c3);
  assert.equal(done.base?.cached, true, 'what finished before the stop was kept');
});

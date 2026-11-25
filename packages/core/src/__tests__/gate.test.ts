import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plantedRepo, tempHome } from './fixtures.js';
import type { Claim } from '../types.js';

tempHome();
const core = await import('../index.js');
const { repo, hashes } = plantedRepo();
const FULL = `${hashes[0]}..${hashes[5]}`;

const claim = (over: Partial<Claim>): Claim => ({ title: 'A reviewer’s point', lens: 'Correctness', file: 'src/totals.py', line: 1, what: 'This function is called with an empty list in the cart page.', source: 'reviewer:Correctness', ...over });

test('a claim must point at a line inside the diff, or it is dropped', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const r = core.applyClaims(repo.dir, c, [
    claim({ file: 'README.md' }),
    claim({ file: 'src/totals.py', line: 500 }),
    claim({ what: '' }),
    claim({ file: 'src/nope.py' })
  ]);
  assert.deepEqual(r.dropped.map(d => d.reason).sort(), ['empty', 'no-location', 'no-location', 'outside-diff']);
  assert.equal(r.kept.length, 0);
  assert.equal(c.dropped.length, 4, 'the case remembers what was thrown away');
});

test('a claim next to a finding adds a second source and corroborates a hint', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const hint = c.findings.find(f => f.check === 'tests' && f.file === 'src/totals.py')!;
  assert.equal(hint.tier, 'hint');
  const r = core.applyClaims(repo.dir, c, [claim({ line: hint.line })]);
  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0].findingId, hint.id);
  assert.equal(hint.tier, 'corroborated');
  assert.ok(hint.evidence.some(e => e.source === 'reviewer:Correctness' && e.kind === 'claim'));
  assert.equal(core.applyClaims(repo.dir, c, [claim({ line: hint.line })]).merged.length, 0, 'running it again adds nothing');
});

test('a claim far from any finding is a new hint, and a reviewer cannot claim proof', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const n = c.findings.length;
  const r = core.applyClaims(repo.dir, c, [claim({ title: 'First price on empty', line: 16, severity: 'high', evidence: [{ kind: 'test-fail', source: 'reviewer:Correctness', what: 'a test fails on an empty cart' }] })]);
  assert.equal(r.kept.length, 1);
  const f = r.kept[0];
  assert.equal(c.findings.length, n + 1);
  assert.equal(f.origin, 'claim');
  assert.equal(f.tier, 'hint', 'a reviewer’s own "test-fail" is a reading until Assay runs it');
  assert.ok(f.evidence.every(e => e.kind === 'claim'));
  assert.ok(f.evidence.some(e => e.what.startsWith('[unverified]')));
  assert.equal(core.verdictOf(c).must.length, 0, 'a hint can’t block, whatever severity it claims');
  assert.equal(f.snippet.rows.find(r2 => r2.sig)?.text.includes('items[0]'), true);
});

test('two different reviewers agreeing corroborate each other', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const a = core.applyClaims(repo.dir, c, [claim({ title: 'Empty list', line: 16, source: 'reviewer:Correctness' })]).kept[0];
  assert.equal(a.tier, 'hint');
  const r = core.applyClaims(repo.dir, c, [claim({ title: 'Empty list too', line: 16, source: 'reviewer:Tests', lens: 'Tests', what: 'No test passes an empty list to first_price.' })]);
  assert.equal(r.merged.length, 1);
  assert.equal(a.tier, 'corroborated');
});

test('claims survive reopening the case: the gate runs again over them', () => {
  const c = core.openCase({ repo: repo.dir, range: `${hashes[1]}..${hashes[3]}` });
  core.applyClaims(repo.dir, c, [claim({ title: 'Kept across a reopen', line: 16 })]);
  core.saveCase(c);
  const again = core.openCase({ repo: repo.dir, range: `${hashes[1]}..${hashes[3]}` });
  assert.equal(again.claims.length, 1);
  assert.ok(again.findings.some(f => f.title === 'Kept across a reopen' && f.origin === 'claim'));
});

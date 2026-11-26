import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { plantedRepo, SECRET, tempHome } from './fixtures.js';

const home = tempHome();
const core = await import('../index.js');
const { repo, hashes } = plantedRepo();
const FULL = `${hashes[0]}..${hashes[5]}`;

function allFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('the planted mistakes are found, with the right tier', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  assert.equal(c.commits.length, 5);
  const secret = c.findings.find(f => f.check === 'secrets')!;
  assert.equal(secret.tier, 'proven');
  assert.equal(secret.severity, 'high');
  assert.equal(secret.commit, hashes[3]);
  assert.equal(secret.present, false, 'a later commit in the range removed it');

  const html = c.findings.find(f => f.evidence.some(e => e.source === 'rule:html-injection'))!;
  assert.equal(html.commit, hashes[1]);
  assert.equal(html.tier, 'corroborated', 'the pattern, plus no test changed in that commit');
  assert.ok(html.evidence.some(e => e.source === 'diff:no-test'));
  assert.equal(html.present, true);
  assert.ok(html.snippet.rows.some(r => r.sig && r.text.includes('dangerouslySetInnerHTML')));

  const guard = c.findings.find(f => f.evidence.some(e => e.source === 'rule:guard-removed'))!;
  assert.equal(guard.file, 'src/cart.py');
  assert.equal(guard.anchor.side, 'removed');
  assert.equal(guard.tier, 'corroborated');
  assert.equal(guard.present, true);

  const dep = c.findings.find(f => /New dependency: reactt/.test(f.title))!;
  assert.equal(dep.tier, 'corroborated');
  assert.ok(dep.evidence.some(e => e.source === 'rule:name-distance'));
  assert.equal(dep.lens, 'Supply chain');
  const hook = c.findings.find(f => /install script/.test(f.title))!;
  assert.equal(hook.tier, 'corroborated');

  const noTest = c.findings.filter(f => f.check === 'tests');
  assert.ok(noTest.length >= 2 && noTest.every(f => f.tier === 'hint'), 'a lone fact about the diff is only a hint');
});

test('findings are ranked: proven first, hints last', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const risks = c.findings.map(f => f.risk);
  assert.deepEqual(risks, [...risks].sort((a, b) => b - a));
  assert.equal(c.findings[0].tier, 'proven');
  assert.equal(c.findings.at(-1)!.tier, 'hint');
});

test('verdict: only an open proven high finding blocks, and a fixed one does not', () => {
  const blocked = core.openCase({ repo: repo.dir, range: `${hashes[2]}..${hashes[4]}` });
  const v = core.verdictOf(blocked);
  assert.equal(v.tone, 'blocked');
  assert.equal(v.must.length, 1);
  assert.equal(v.must[0].check, 'secrets');
  const brief = core.briefOf(blocked);
  assert.match(brief, /MUST FIX/);
  assert.match(brief, /rotate it/);
  assert.match(brief, /Replay: assay replay f-/);
  assert.ok(!brief.includes('QWERTYUIOP123456'));

  const fixed = core.openCase({ repo: repo.dir, range: FULL });
  const v2 = core.verdictOf(fixed);
  assert.equal(v2.must.length, 0);
  assert.equal(v2.tone, 'mergeable');
  assert.ok(v2.decide.length >= 3);
});

test('a secret never reaches the case file, the cache, or any output', () => {
  const c = core.openCase({ repo: repo.dir, range: `${hashes[2]}..${hashes[4]}` });
  assert.ok(!JSON.stringify(c).includes('QWERTYUIOP123456'));
  assert.ok(!core.briefOf(c).includes(SECRET));
  const leaks = allFiles(home).filter(f => fs.readFileSync(f, 'utf8').includes('QWERTYUIOP123456'));
  assert.deepEqual(leaks, []);
  const secret = c.findings.find(f => f.check === 'secrets')!;
  assert.ok(secret.snippet.rows.some(r => r.text.includes('AKIA…(20 characters)')));
});

test('per-commit analyses are cached by hash, and a case is kept and reopened', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const cached = allFiles(path.join(home, 'cache')).filter(f => f.endsWith('.json'));
  assert.ok(cached.length >= 5);
  const again = core.openCase({ repo: repo.dir, range: FULL });
  assert.equal(again.createdAt, c.createdAt);
  assert.ok(core.listCases().some(x => x.id === c.id));
  assert.equal(core.loadCase(c.id)!.findings.length, c.findings.length);
  const t = core.timeline({ repo: repo.dir, limit: 10 });
  assert.equal(t.length, 6);
  assert.equal(t[0].subject, 'Remove the key');
  assert.equal(t[5].subject, 'Base');
});

test('a dismissed finding stops counting, and stays dismissed when the case is reopened', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const before = core.verdictOf(c).decide.length;
  const html = c.findings.find(f => f.evidence.some(e => e.source === 'rule:html-injection'))!;
  core.resolveFinding(c, html.id, 'dismissed');
  const again = core.openCase({ repo: repo.dir, range: FULL });
  assert.equal(again.resolved[html.id], 'dismissed');
  assert.equal(core.verdictOf(again).decide.length, before - 1);
  core.resolveFinding(again, html.id, null);
});

test('replay runs the check again from scratch', async () => {
  const c = core.openCase({ repo: repo.dir, range: `${hashes[2]}..${hashes[4]}` });
  const secret = c.findings.find(f => f.check === 'secrets')!;
  const r = await core.replayEvidence(c, secret.evidence[0].id);
  assert.equal(r.reproduced, true);
  assert.match(r.detail, /again from scratch/);
  assert.equal((await core.replayEvidence(c, 'f-00000000.1')).reproduced, false);
});

test('the timeline says which lenses each commit’s findings are about', () => {
  const t = core.timeline({ repo: repo.dir, limit: 10 });
  const byId = (n: string) => t.find(r => r.subject === n)!;
  assert.ok(byId('Add settings').lenses.includes('Security'), 'the committed key is a security finding');
  assert.ok(byId('Add reactt').lenses.includes('Supply chain'));
  assert.deepEqual(byId('Base').lenses, []);
  assert.ok(t.every(r => Array.isArray(r.lenses)));
});

test('a case can be opened from exactly the span a caller picked, and the branch has a span of its own', () => {
  const viaRange = core.openCase({ repo: repo.dir, range: `${hashes[1]}..${hashes[3]}` });
  const viaSpan = core.openCase({ repo: repo.dir, span: { base: hashes[1], head: hashes[3] } });
  assert.equal(viaSpan.id, viaRange.id);
  assert.deepEqual(viaSpan.commits.map(c => c.hash), viaRange.commits.map(c => c.hash));
  const fromStart = core.openCase({ repo: repo.dir, span: { base: null, head: hashes[1] } });
  assert.equal(fromStart.base, null);
  assert.equal(fromStart.commits.length, 2, 'from the first commit up to the head');
  assert.throws(() => core.openCase({ repo: repo.dir, span: { base: '--output=x', head: hashes[1] } }), /not a commit/);

  const b = core.branchSpan({ repo: repo.dir });
  assert.equal(b.head, hashes[5]);
  assert.equal(b.fallback, true, 'a fixture has no main branch to compare with, so the last five commits stand in');
  assert.deepEqual(b.hashes, [hashes[5], hashes[4], hashes[3], hashes[2], hashes[1]], 'newest first');
  assert.equal(b.base, hashes[0]);
});

test('a finding’s state is its tier, unless a person resolved it or a later commit fixed it', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const secret = c.findings.find(f => f.check === 'secrets')!;
  const html = c.findings.find(f => f.evidence.some(e => e.source === 'rule:html-injection'))!;
  assert.equal(core.findingState(c, secret), 'fixed');
  assert.equal(core.findingState(c, html), 'corroborated');
  core.resolveFinding(c, html.id, 'intended');
  assert.equal(core.findingState(c, html), 'intended');
  core.resolveFinding(c, html.id, 'dismissed');
  assert.equal(core.findingState(c, html), 'dismissed');
  core.resolveFinding(c, html.id, null);
  assert.equal(core.findingState(c, html), 'corroborated');
});

test('doctor says what is there: git and node are needed, the rest is optional', () => {
  const rows = core.doctor();
  assert.equal(rows.find(r => r.id === 'git')!.ok, true);
  assert.equal(rows.find(r => r.id === 'node')!.ok, true);
  assert.equal(rows.find(r => r.id === 'state')!.ok, true);
  for (const id of ['semgrep', 'gitleaks', 'osv-scanner']) assert.notEqual(rows.find(r => r.id === id)!.ok, false, `${id} is optional: never a problem`);
});

test('ranges: default, a single commit, and refusing anything that looks like an option', () => {
  assert.deepEqual(core.resolveRange(repo.dir), { base: hashes[0], head: hashes[5] });
  assert.deepEqual(core.resolveRange(repo.dir, hashes[2]), { base: hashes[1], head: hashes[2] });
  assert.deepEqual(core.resolveRange(repo.dir, `${hashes[1]}..${hashes[3]}`), { base: hashes[1], head: hashes[3] });
  assert.throws(() => core.resolveRange(repo.dir, '--output=/tmp/x'), /not a commit/);
  assert.throws(() => core.resolveRange(repo.dir, `${hashes[1]}..--exec=x`), /not a commit/);
  assert.throws(() => core.resolveRange(repo.dir, 'nope'), /not a commit/);
  assert.throws(() => core.openCase({ repo: repo.dir, range: FULL, max: 2 }), /limit is 2/);
});

test('one folder is one repository however it is spelled: a link to it, or the name git reports, has the same key', async () => {
  const { repoKey } = await import('../git.js');
  const via = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assay-link-')), 'via-link');
  fs.symlinkSync(repo.dir, via, process.platform === 'win32' ? 'junction' : 'dir'); // macOS keeps /var behind a link; Windows temp folders have 8.3 names
  assert.equal(repoKey(via), repoKey(repo.dir));
  assert.equal(repoKey(core.repoRoot(via)), repoKey(via));
});

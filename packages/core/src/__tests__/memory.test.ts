import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { makeRepo, plantedRepo, tempHome } from './fixtures.js';

const home = tempHome();
const core = await import('../index.js');
const { memory } = core;
const { repo, hashes } = plantedRepo();
const FULL = `${hashes[0]}..${hashes[5]}`;
const entry = (dir: string, id: string): import('../memory/entries.js').Entry => {
  const e = memory.listEntries(dir).find(x => x.id === id);
  assert.ok(e, `entry ${id} exists`);
  return e;
};

after(() => memory.closeMemory());

test('memory is available here (it needs node:sqlite, Node 22.13 or newer)', () => {
  const s = memory.memoryStatus();
  assert.equal(s.available, true, s.why ?? '');
  assert.ok(fs.existsSync(path.join(home, 'memory.db')));
});

test('the packs that ship with Assay are all valid, and every rule says how it is decided', () => {
  const { packs, problems } = memory.loadPacks();
  assert.deepEqual(problems, []);
  assert.deepEqual(packs.map(p => p.id).sort(), ['basics', 'owasp-top10', 'pages', 'review-questions', 'tests', 'wcag22']);
  for (const p of packs) for (const r of p.rules) assert.ok(r.sources.length || r.question, `${p.id}/${r.id} has sources or a question`);
  const owasp = packs.find(p => p.id === 'owasp-top10')!;
  assert.equal(owasp.edition, '2025');
  for (let i = 1; i <= 10; i++) assert.ok(owasp.rules.some(r => r.ref?.startsWith(`A${String(i).padStart(2, '0')} `)), `category A${i} is covered`);
});

test('a pack of yours wins over a bundled one, and a bad file is reported and skipped', () => {
  const dir = memory.packsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'basics.json'), JSON.stringify({ id: 'basics', name: 'My basics', rules: [{ id: 'one', name: 'One', question: 'Is it one?' }] }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ "id": "broken", "name": "Broken", "rules": [{ "id": "x", "name": "No way to decide it" }] }');
  fs.writeFileSync(path.join(dir, 'worse.json'), 'not json at all');
  const { packs, problems } = memory.loadPacks();
  const mine = packs.find(p => p.id === 'basics')!;
  assert.equal(mine.name, 'My basics');
  assert.equal(mine.origin, 'yours');
  assert.ok(!packs.some(p => p.id === 'broken'));
  assert.equal(problems.length, 2);
  assert.ok(problems.some(p => /broken\.json.*sources.*question/.test(p)), problems.join(' | '));
  assert.ok(packs.some(p => p.id === 'owasp-top10'), 'the other packs still load');
  for (const f of ['basics.json', 'broken.json', 'worse.json']) fs.rmSync(path.join(dir, f));
  assert.equal(memory.loadPacks().packs.find(p => p.id === 'basics')!.origin, 'bundled');
});

test('a pack file is checked field by field', () => {
  const bad = (raw: unknown, re: RegExp): void => assert.throws(() => memory.parsePack(raw, 'x.json', 'yours'), re);
  bad([], /JSON object/);
  bad({ id: 'Bad Id', name: 'x', rules: [{ id: 'a', name: 'a', question: 'q' }] }, /lower case/);
  bad({ id: 'ok', name: 'x', source: 'javascript:alert(1)', rules: [{ id: 'a', name: 'a', question: 'q' }] }, /http or https/);
  bad({ id: 'ok', name: 'x', rules: [] }, /at least one rule/);
  bad({ id: 'ok', name: 'x', rules: [{ id: 'a', name: 'a', question: 'q' }, { id: 'a', name: 'b', question: 'q' }] }, /used twice/);
  bad({ id: 'ok', name: 'x', rules: [{ id: 'a', name: 'a', sources: ['not a source'] }] }, /not an evidence source/);
});

test('what a case finds is counted against the entries it belongs to, once', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const html = c.findings.find(f => f.evidence.some(e => e.source === 'rule:html-injection'))!;
  assert.ok(memory.linksFor(c)[html.id].includes('owasp-top10/a05-html'));
  const a05 = entry(repo.dir, 'owasp-top10/a05-html');
  assert.equal(a05.stats.hits, 1);
  assert.equal(a05.status, 'active');
  assert.equal(a05.stats.lastReal?.slice(0, 10), '2025-11-02', 'a hit is dated by its commit');
  assert.ok(entry(repo.dir, 'basics/secret-committed').stats.hits >= 1, 'a committed secret is a hit on its entry');
  assert.ok(entry(repo.dir, 'owasp-top10/a03-lookalike').stats.hits >= 1);
  core.openCase({ repo: repo.dir, range: FULL });
  core.openCase({ repo: repo.dir, range: FULL, fresh: true });
  assert.equal(entry(repo.dir, 'owasp-top10/a05-html').stats.hits, 1, 'opening it again does not count it again');
  assert.equal(entry(repo.dir, 'owasp-top10/a06-abuse').status, 'question');
  assert.equal(entry(repo.dir, 'owasp-top10/a06-abuse').stats.hits, 0);
});

test('dismissing a finding is a false alarm for its entries, and taking it back undoes that', () => {
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const html = c.findings.find(f => f.evidence.some(e => e.source === 'rule:html-injection'))!;
  core.resolveFinding(c, html.id, 'dismissed');
  assert.equal(entry(repo.dir, 'owasp-top10/a05-html').stats.falseAlarms, 1);
  core.resolveFinding(c, html.id, 'intended');
  assert.equal(entry(repo.dir, 'owasp-top10/a05-html').stats.falseAlarms, 0, 'intended is a real hit that was meant, not a false alarm');
  core.resolveFinding(c, html.id, null);
  assert.equal(entry(repo.dir, 'owasp-top10/a05-html').stats.falseAlarms, 0);
});

test('switching a pack off drops what only it asks for; switching it on brings it back', () => {
  const found = (): boolean => core.openCase({ repo: repo.dir, range: FULL }).findings.some(f => f.evidence.some(e => e.source === 'rule:html-injection'));
  assert.equal(found(), true);
  memory.setPack(repo.dir, 'owasp-top10', false);
  assert.equal(entry(repo.dir, 'owasp-top10/a05-html').status, 'off');
  assert.equal(found(), false, 'the cached analysis was not reused: memory is part of its key');
  assert.equal(memory.memoryRuntime(repo.dir).isMuted('rule:html-injection'), true);
  memory.setPack(repo.dir, 'owasp-top10', true);
  assert.equal(found(), true);
  assert.equal(memory.memoryRuntime(repo.dir).digest, '', 'nothing switched off and nothing learned: the caches of before are valid');
});

test('proof is never muted, even when the entry is off', () => {
  memory.setEntry(repo.dir, 'basics/secret-committed', false);
  const c = core.openCase({ repo: repo.dir, range: FULL });
  const secret = c.findings.find(f => f.check === 'secrets');
  assert.ok(secret, 'a committed key still shows');
  assert.equal(secret.tier, 'proven');
  memory.setEntry(repo.dir, 'basics/secret-committed', true);
});

test('an entry that cries wolf switches itself off; a person can turn it back on', () => {
  const r = makeRepo('wolf');
  const hs: string[] = [r.commit({ 'README.md': '# wolf\n' }, 'Base')];
  for (let i = 1; i <= 5; i++) hs.push(r.commit({ [`src/run${i}.js`]: `export const run${i} = input => eval(input);\n` }, `Add run ${i}`));
  const c = core.openCase({ repo: r.dir, range: `${hs[0]}..${hs[5]}` });
  const evals = c.findings.filter(f => f.evidence.some(e => e.source === 'rule:eval'));
  assert.equal(evals.length, 5);
  const id = 'owasp-top10/a05-code-from-text';
  assert.equal(entry(r.dir, id).stats.hits, 5);
  assert.equal(entry(r.dir, id).status, 'active');
  core.resolveFinding(c, evals[0].id, 'dismissed');
  assert.equal(entry(r.dir, id).on, true, 'one dismissal is not enough');
  core.resolveFinding(c, evals[1].id, 'dismissed');
  const e = entry(r.dir, id);
  assert.equal(e.status, 'expired', '5 hits, 2 dismissed (40%), nothing real in the last 60 days');
  assert.equal(e.off, 'expired');
  assert.equal(e.on, false);
  const after = core.openCase({ repo: r.dir, range: `${hs[0]}..${hs[5]}` });
  assert.equal(after.findings.filter(f => f.evidence.some(x => x.source === 'rule:eval')).length, 0, 'what it found is no longer reported');
  assert.equal(core.timeline({ repo: r.dir, limit: 6 }).filter(x => x.counts.corroborated + x.counts.hint > 0).length, 0, 'the timeline agrees with the case');
  memory.setEntry(r.dir, id, true);
  assert.equal(entry(r.dir, id).on, true);
  assert.equal(entry(r.dir, id).status, 'expiring');
  assert.equal(entry(r.dir, id).on, true, 'a person turning it on is not undone straight away');
  assert.equal(core.openCase({ repo: r.dir, range: `${hs[0]}..${hs[5]}` }).findings.filter(f => f.evidence.some(x => x.source === 'rule:eval')).length, 5);
});

test('a pattern is refused when it could hang, matches everything, or is not a pattern', () => {
  assert.throws(() => memory.checkPattern('(a+)+$'), /repeat/);
  assert.throws(() => memory.checkPattern('(.*)*x'), /repeat/);
  assert.throws(() => memory.checkPattern('.*'), /almost every line/);
  assert.throws(() => memory.checkPattern('(ab'), /not a valid pattern/);
  assert.throws(() => memory.checkPattern('x'), /two characters/);
  assert.throws(() => memory.checkPattern('a'.repeat(201)), /200/);
  assert.throws(() => memory.checkPattern('abc', 'g'), /flag/);
  assert.deepEqual(memory.checkPattern('\\.legacyRender\\(', 'i'), { source: '\\.legacyRender\\(', flags: 'i' });
});

test('the words a changed line is made of: calls, members, new, CSS', () => {
  assert.deepEqual(memory.tokensOf('el.innerHTML = message;', false), ['.innerHTML']);
  assert.deepEqual(memory.tokensOf('const d = new Date(str);', false), ['new Date(']);
  assert.ok(memory.tokensOf('view.legacyRender(data, "x.y(z)")', false).includes('.legacyRender('));
  assert.ok(!memory.tokensOf('view.legacyRender(data, "x.y(z)")', false).includes('.y('), 'text inside a string is not code');
  assert.deepEqual(memory.tokensOf('  right: 12px;', true), ['right: Npx']);
  assert.deepEqual(memory.tokensOf('  color: #6e6895;', true), ['color: #HEX']);
  assert.deepEqual(memory.tokensOf('// el.innerHTML = nope', false), []);
  assert.deepEqual(memory.tokensOf('if (x) return;', false), []);
  assert.ok(!memory.tokensOf('items = [...rest]', false).some(t => t.includes('rest')), 'a spread is not a member access');
});

test('a token becomes a literal pattern that matches it and not its neighbours', () => {
  const re = (t: string, css = false): RegExp => { const p = memory.patternOf(t, css); return new RegExp(p.source, p.flags); };
  assert.ok(re('.legacyRender(').test('a.legacyRender(1)'));
  assert.ok(re('.legacyRender(').test('a . legacyRender ( 1 )'));
  assert.ok(!re('.legacyRender(').test('a.legacyRenderer(1)'));
  assert.ok(re('.innerHTML').test('el.innerHTML = x'));
  assert.ok(!re('.innerHTML').test('el.innerHTMLish = x'));
  assert.ok(re('new Date(').test('const d = new Date (s)'));
  assert.ok(re('eval(').test('x = eval(y)') && !re('eval(').test('x = obj.eval(y)') && !re('eval(').test('retrieval(y)'));
  assert.ok(re('right: Npx', true).test('  right: 12px;') && re('right: Npx', true).test('RIGHT: -3.5px') && !re('right: Npx', true).test('copyright: 12px;'));
});

test('what counts as a fix commit', () => {
  for (const s of ['fix: empty cart crashed the totals', 'fix(cart): totals', 'Fixes #12 crash on load', 'bugfix badge flipped', 'hotfix the login', 'Fixed the badge']) assert.ok(memory.isFixSubject(s), s);
  for (const s of ['Add a feature', 'docs: fix a typo', 'Revert "fix: totals"', 'chore: fix lint', 'refactor: prefix the names']) assert.ok(!memory.isFixSubject(s), s);
});

test('learning from history: what fixes keep removing is suggested, and added only when a person says so', async () => {
  const r = makeRepo('learn');
  const files = ['a', 'b', 'c', 'd'];
  const hs: string[] = [r.commit(Object.fromEntries(files.map(f => [`src/${f}.js`, `export function ${f}(view, data) {\n  view.legacyRender(data);\n  return data.map(x => x);\n}\n`])), 'Base')];
  for (const f of files.slice(0, 3)) hs.push(r.commit({ [`src/${f}.js`]: `export function ${f}(view, data) {\n  view.render(data);\n  return data.map(x => x);\n}\n` }, `fix: ${f} showed stale data after legacyRender`));
  for (const f of files) hs.push(r.commit({ [`src/${f}.js`]: `export function ${f}(view, data) {\n  view.render(data);\n  return data.filter(Boolean);\n}\n` }, `Tidy ${f}`));
  const steps: string[] = [];
  const report = await memory.mineHistory(r.dir, { onProgress: m => steps.push(m) });
  assert.equal(report.commits, 7, 'the commits that changed existing code: the base only added files');
  assert.equal(report.fixes, 3);
  const c = report.candidates.find(x => x.token === '.legacyRender(')!;
  assert.ok(c, report.candidates.map(x => x.token).join(', '));
  assert.equal(c.fixes, 3);
  assert.equal(c.worth, true);
  assert.deepEqual(c.langs, ['JavaScript']);
  assert.equal(c.examples.length, 3);
  assert.match(c.examples[0].bad, /legacyRender/);
  assert.match(c.examples[0].good, /view\.render/);
  assert.ok(!report.candidates.some(x => x.token === '.map('), 'something removed by plain tidying is not a fix pattern');
  assert.ok(steps.length > 0);

  // Nothing is in memory until a person adds it.
  assert.equal(memory.listEntries(r.dir).filter(e => e.kind === 'learned').length, 0);
  const view = memory.lastMined(r.dir);
  assert.equal(view.report?.candidates.length, report.candidates.length);
  assert.deepEqual(view.added, {});
  assert.throws(() => memory.addMined(r.dir, 'm-nothing'), /last reading/);
  const before = core.timeline({ repo: r.dir, limit: 10 });
  const added = memory.addMined(r.dir, c.id, 'Legacy render call');
  assert.equal(added.id, 'L-1');
  assert.equal(added.kind, 'learned');
  assert.equal(added.fixes, 3);
  assert.deepEqual(memory.lastMined(r.dir).added, { [c.id]: 'L-1' });
  assert.throws(() => memory.addMined(r.dir, c.id), /already in memory/);
  assert.notEqual(memory.memoryRuntime(r.dir).digest, '');

  // The next commit that writes it again is flagged: its own history says it was fixed three times before.
  const bad = r.commit({ 'src/e.js': 'export function e(view, data) {\n  view.legacyRender(data);\n  return data;\n}\n', 'src/e.test.js': 'view.legacyRender(1);\n' }, 'Add e');
  const case1 = core.openCase({ repo: r.dir, range: bad });
  const f = case1.findings.find(x => x.check === 'memory')!;
  assert.ok(f, 'the learned pattern fired');
  assert.equal(f.title, 'Legacy render call');
  assert.equal(f.file, 'src/e.js', 'and not in a test file');
  assert.equal(f.tier, 'corroborated', 'the pattern plus its own history of fixes: two independent signals');
  assert.deepEqual(f.evidence.map(e => e.source).sort(), ['history:fixes', 'memory:L-1']);
  assert.match(f.evidence.find(e => e.source === 'history:fixes')!.what, /fixed the same pattern 3 times before/);
  assert.ok(!f.evidence.some(e => core.isProof(e.kind)), 'a learned pattern is never proof');
  assert.notEqual(f.severity, 'high');
  assert.ok(memory.linksFor(case1)[f.id].includes('L-1'));
  assert.equal(core.verdictOf(case1).tone, 'mergeable', 'it asks for a look and can never block');
  assert.match(core.briefOf(case1), /fixed the same pattern before/);
  assert.equal(entry(r.dir, 'L-1').stats.hits, 1);
  assert.equal(core.timeline({ repo: r.dir, limit: 10 }).length, before.length + 1);

  memory.removeLearned(r.dir, 'L-1');
  assert.equal(memory.memoryRuntime(r.dir).digest, '');
  assert.equal(core.openCase({ repo: r.dir, range: bad }).findings.some(x => x.check === 'memory'), false);
  assert.throws(() => memory.removeLearned(r.dir, 'owasp-top10/a05-html'), /learned entry/);
});

test('a pattern added by hand with no fixes behind it is only a hint', () => {
  const r = makeRepo('hand');
  const base = r.commit({ 'README.md': '# hand\n' }, 'Base');
  const c1 = r.commit({ 'src/x.py': 'import pickle_helper\nvalue = old_api.fetch_all(1)\n' }, 'Add x');
  const e = memory.addLearned(r.dir, { name: 'old_api is going away', pattern: 'old_api\\.fetch_all\\(', langs: ['Python'], good: 'new_api.list(…)' });
  assert.equal(e.fixes, 0);
  assert.throws(() => memory.addLearned(r.dir, { name: 'again', pattern: 'old_api\\.fetch_all\\(' }), /already/);
  const f = core.openCase({ repo: r.dir, range: `${base}..${c1}` }).findings.find(x => x.check === 'memory')!;
  assert.equal(f.tier, 'hint');
  assert.deepEqual(f.evidence.map(x => x.source), [`memory:${e.id}`]);
});

test('review questions come from the packs that are on, for the languages asked about', () => {
  const all = memory.questions(repo.dir);
  assert.ok(all.length >= 15, 'the bundled packs hold plenty of questions');
  assert.ok(all.every(q => q.how === 'question' && q.question));
  assert.ok(all.some(q => q.id === 'review-questions/money-float'));
  const py = memory.questions(repo.dir, ['Python']).map(q => q.id);
  assert.ok(py.includes('review-questions/money-float'), 'a question with no language applies to every language');
  memory.setPack(repo.dir, 'review-questions', false);
  assert.ok(!memory.questions(repo.dir).some(q => q.pack === 'review-questions'));
  memory.setPack(repo.dir, 'review-questions', true);
});

test('stats are read from the hits, so they cannot drift, and a repository only sees its own', () => {
  const other = makeRepo('other');
  other.commit({ 'README.md': '# other\n' }, 'Base');
  assert.equal(memory.listEntries(other.dir).reduce((n, e) => n + e.stats.hits, 0), 0, 'another project has its own stats');
  assert.ok(memory.listEntries(repo.dir).reduce((n, e) => n + e.stats.hits, 0) > 0);
  const e = entry(repo.dir, 'owasp-top10/a05-html');
  assert.equal(e.stats.weeks.length, 12);
});

test('if the memory file is broken, memory is off and everything else carries on', () => {
  memory.closeMemory();
  fs.writeFileSync(path.join(home, 'memory.db'), 'this is not a database');
  fs.rmSync(path.join(home, 'memory.db-wal'), { force: true });
  fs.rmSync(path.join(home, 'memory.db-shm'), { force: true });
  const s = memory.memoryStatus();
  assert.equal(s.available, false);
  assert.match(s.why ?? '', /memory/i);
  assert.equal(memory.memoryRuntime(repo.dir).digest, '');
  const c = core.openCase({ repo: repo.dir, range: FULL, fresh: true });
  assert.ok(c.findings.length > 0, 'a case still opens');
  assert.ok(memory.listEntries(repo.dir).length > 20, 'the packs can still be read');
  assert.ok(memory.listEntries(repo.dir).every(e => e.stats.hits === 0));
  assert.throws(() => memory.setPack(repo.dir, 'owasp-top10', false), /not available/);
});

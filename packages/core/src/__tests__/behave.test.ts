import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { functionsIn, inputsFor } from '../proof/behave.js';
import { makeRepo, tempHome } from './fixtures.js';

/* Function before and after (D53): behaviour of code, not pages. Real functions in real checkouts, called with the same inputs at both ends. */
tempHome();
const core = await import('../index.js');
after(() => core.memory.closeMemory());

test('the shapes of function Assay recognises, and what it says about each', () => {
  const js = `export function a(x, y = 2) { return x + y; }
export const b = (n) => n * 2;
export const c = async s => s.trim();
const d = function (p, q) { return p - q; };
exports.e = function (k) { return k; };
function f({ a, b }) { return a + b; }
export function g(...rest) { return rest.length; }
module.exports = { d };
`;
  const fns = functionsIn(js, 'js');
  const by = (n: string): ReturnType<typeof functionsIn>[number] => fns.find(f => f.name === n)!;
  assert.deepEqual(by('a').params, ['x', 'y']);
  assert.equal(by('a').exported, true);
  assert.deepEqual(by('b').params, ['n']);
  assert.equal(by('c').async, true);
  assert.deepEqual(by('c').params, ['s']);
  assert.equal(by('d').exported, true, 'named in module.exports');
  assert.equal(by('e').exported, true);
  assert.equal(by('f').params, null, 'destructured parameters are not plain names');
  assert.equal(by('g').params, null, 'a rest parameter is not either');
  const py = functionsIn('def area(w, h=1):\n    return w * h\n\ndef _private(n):\n    return n\n\nasync def later(n):\n    return n\n', 'py');
  assert.deepEqual(py.map(f => [f.name, f.exported, f.async]), [['area', true, false], ['_private', false, false], ['later', true, true]]);
  assert.deepEqual(py[0].params, ['w', 'h']);
});

test('inputs come from the names of the parameters, are the same every time, and are at most forty', () => {
  const a = inputsFor({ name: 'f', params: ['a', 'b', 'c', 'd'] });
  assert.ok(a.length <= 40 && a.length > 1);
  assert.deepEqual(a, inputsFor({ name: 'f', params: ['a', 'b', 'c', 'd'] }), 'deterministic');
  assert.deepEqual(inputsFor({ name: 'g', params: [] }), [[]]);
  assert.deepEqual(inputsFor({ name: 'h', params: ['isAdmin'] }), [[true], [false]]);
  assert.ok(inputsFor({ name: 'i', params: ['text'] }).some(x => x[0] === ''), 'a string parameter is tried empty');
  assert.ok(inputsFor({ name: 'j', params: ['items'] }).some(x => Array.isArray(x[0]) && (x[0] as unknown[]).length === 0), 'a list is tried empty');
  assert.ok(inputsFor({ name: 'k', params: ['mystery'] }).some(x => x[0] === null), 'an unknown parameter is tried with null');
});

const PKG = '{\n  "name": "calc",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n';
const TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { same } from '../src/calc.js';\ntest('same doubles', () => { assert.equal(same(2), 4); });\n";
const BASE = `export function discount(total, pct) {
  return total - (total * pct) / 100;
}

export function isAdult(age) {
  return age >= 18;
}

export function slug(text) {
  return text.trim().toLowerCase().replace(/\\s+/g, '-');
}

export function stamp(n) {
  return n + ':' + Date.now();
}

function hidden(n) {
  return n + 1;
}

export function same(n) {
  return n * 2;
}
`;
const HEAD = BASE
  .replace('(total * pct) / 100', '(total * pct) * 100')
  .replace("replace(/\\s+/g, '-')", "replace(/\\s+/g, '_')")
  .replace("n + ':' + Date.now()", "n + '/' + Date.now()")
  .replace('return n + 1;', 'return n + 2;')
  .replace('return n * 2;', 'return n + n;')
  + '\nexport function brandNew(n) {\n  return n;\n}\n';

function project(extra: Record<string, string> = {}): { repo: ReturnType<typeof makeRepo>; base: string; head: string } {
  const repo = makeRepo();
  const base = repo.commit({ 'package.json': PKG, 'src/calc.js': BASE, 'test/calc.test.js': TEST }, 'Base');
  const head = repo.commit({ 'src/calc.js': HEAD, ...extra }, 'Change several functions');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  return { repo, base, head };
}

test('the functions a range changed are called with the same inputs before and after, and a difference is shown as it happened', async () => {
  const { repo, base, head } = project();
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });
  assert.equal(report.regressions.length, 0, 'the tests still pass: this is about what they do not notice');
  const b = report.behaviour!;
  const fn = (name: string): NonNullable<typeof b>['functions'][number] => b.functions.find(f => f.name === name)!;
  assert.equal(fn('discount').status, 'differs');
  assert.equal(fn('slug').status, 'differs');
  assert.equal(fn('same').status, 'same', 'n + n answers like n * 2: a rewrite that keeps the behaviour is not reported');
  assert.equal(fn('stamp').status, 'skipped');
  assert.match(String(fn('stamp').why), /uses Date\.now/);
  assert.match(String(fn('hidden').why), /not exported/);
  assert.match(String(fn('brandNew').why), /new/);
  assert.ok(!b.functions.some(f => f.name === 'isAdult'), 'a function no changed line is in is left alone');
  assert.deepEqual([b.compared, b.differ], [3, 2]);

  const found = c.findings.filter(f => f.origin === 'run' && f.evidence.some(e => e.kind === 'behaviour-diff'));
  assert.equal(found.length, 2);
  const d = found.find(f => /^discount\(\)/.test(f.title))!;
  assert.equal(d.tier, 'proven');
  assert.equal(d.severity, 'medium', 'no test changed in the range');
  assert.equal(d.file, 'src/calc.js');
  assert.match(d.title, /answers differently for \d+ of \d+ inputs: discount\(.*\) was .*, is now /);
  assert.match(d.evidence[0].what, /returned .* at the base and .* at the head\. \d+ of the \d+ inputs tried give a different answer/);
  assert.ok(d.observed.length >= 1 && d.observed.every(o => /discount\(.*\): .* at the base, .* at the head\./.test(o)));
  assert.ok(d.inferred.some(i => /may be what was meant/.test(i)) && d.inferred.some(i => /No test file changed/.test(i)));
  assert.notEqual(core.verdictOf(c).tone, 'blocked', 'a different answer is for a person to judge: it never blocks');
  assert.ok(found.every(f => f.severity !== 'high'));

  // it replays: the same inputs, called again at both ends
  const reopened = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const kept = reopened.findings.find(f => f.id === d.id)!;
  const r = await core.replayEvidence(reopened, kept.evidence[0].id);
  assert.equal(r.reproduced, true, r.detail);
  assert.match(r.detail, /Called discount again with the same \d+ inputs at both ends: \d+ answers? differ/);
  assert.ok(reopened.runs.some(x => x.kind === 'behaviour' && /3 functions compared before and after, 2 answer differently/.test(x.summary)));
});

test('--no-behaviour leaves it out, and a test that changed in the range lowers the severity', async () => {
  // a note, so this is a different commit from the first test: the same content gives the same hash, and so the same case
  const off = project({ 'NOTES.md': 'a note\n' });
  const c1 = core.openCase({ repo: off.repo.dir, range: `${off.base}..${off.head}` });
  const rep1 = await core.proveCase(c1, { mutants: 0, reverts: 0, behaviour: false });
  assert.equal(rep1.behaviour, undefined);
  assert.ok(!c1.findings.some(f => f.evidence.some(e => e.kind === 'behaviour-diff')));

  const withTest = project({ 'test/other.test.js': "import test from 'node:test';\ntest('nothing', () => {});\n" });
  const c2 = core.openCase({ repo: withTest.repo.dir, range: `${withTest.base}..${withTest.head}` });
  await core.proveCase(c2, { mutants: 0, reverts: 0 });
  const f = c2.findings.find(x => x.origin === 'run' && x.evidence.some(e => e.kind === 'behaviour-diff'))!;
  assert.equal(f.severity, 'low', 'a test file changed, so the new behaviour may be covered');
  assert.ok(f.inferred.some(i => /may be covered/.test(i)));
});

test('a module that cannot be loaded is skipped with the reason, and does not stop the rest', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'package.json': PKG, 'src/ok.js': 'export function twice(n) {\n  return n * 2;\n}\n', 'src/broken.js': 'export function f(n) {\n  return n;\n}\n', 'test/t.test.js': TEST.replace('../src/calc.js', '../src/ok.js').replace('same', 'twice') }, 'Base');
  const head = repo.commit({ 'src/ok.js': 'export function twice(n) {\n  return n * 3;\n}\n', 'src/broken.js': 'throw new Error("this module fails when it loads");\nexport function f(n) {\n  return n + 1;\n}\n' }, 'Change both');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });
  const by = (n: string): { status: string; why?: string } => report.behaviour!.functions.find(f => f.name === n)!;
  assert.equal(by('twice').status, 'differs');
  assert.equal(by('f').status, 'skipped');
  assert.match(String(by('f').why), /could not be loaded: this module fails when it loads/);
});

const python = ((): string | null => { for (const p of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) { const r = spawnSync(p, ['--version'], { encoding: 'utf8' }); if (r.status === 0) return p; } return null; })();
const py = python ? test : test.skip;

py('Python functions are compared the same way', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'calc.py': 'def double(n):\n    return n * 2\n\n\ndef label(text):\n    return text.strip().title()\n' }, 'Base');
  const head = repo.commit({ 'calc.py': 'def double(n):\n    return n * 3\n\n\ndef label(text):\n    return text.strip().title()\n' }, 'Change double');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120, command: 'node -e "process.exit(0)"' });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });
  const f = report.behaviour?.functions.find(x => x.name === 'double');
  assert.equal(f?.status, 'differs', JSON.stringify(report.behaviour));
  assert.ok(!report.behaviour?.functions.some(x => x.name === 'label'), 'label has no changed line');
  const found = c.findings.find(x => x.origin === 'run' && x.evidence.some(e => e.kind === 'behaviour-diff'))!;
  assert.match(found.title, /^double\(\) answers differently/);
});

test('an escaping helper that stops escaping quotes is a difference: the inputs for text carry markup characters', async () => {
  const esc = (re: string): string => `const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };\nexport const esc = s => String(s ?? '').replace(${re}, c => MAP[c]);\n`;
  const repo = makeRepo();
  const base = repo.commit({ 'package.json': PKG, 'src/esc.js': esc('/[&<>"\']/g'), 'test/e.test.js': "import test from 'node:test';\ntest('ok', () => {});\n" }, 'Base');
  const head = repo.commit({ 'src/esc.js': esc('/[&<>]/g') }, 'Simpler esc');
  core.setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.proveCase(c, { mutants: 0, reverts: 0 });
  const f = report.behaviour!.functions.find(x => x.name === 'esc')!;
  assert.equal(f.status, 'differs', 'a quote that used to be escaped is not');
  const found = c.findings.find(x => x.origin === 'run' && x.evidence.some(e => e.kind === 'behaviour-diff'))!;
  assert.match(found.title, /^esc\(\)/);
  assert.match(JSON.stringify(found.observed), /&quot;|&#39;/, 'the answers shown are the escaped and the unescaped text');
});

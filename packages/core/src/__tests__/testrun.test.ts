import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeRepo, SECRET, tempHome } from './fixtures.js';

/* assay test (D61): the project's own tests once, read from each runner's own report, in a clean copy or (allowed separately) in the folder. */
tempHome();
const core = await import('../index.js');
const { detectRunner, parseJestJson, parseJunit, parseGoJson, parseCoverageSummary, parsePytestCoverage, parseGoCover, parseV8Coverage, runTests, setRepoSettings } = core;

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
function folder(files: Record<string, string>): string {
  const dir = tmp('assay-runner-');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  return dir;
}

test('the runner comes from the dependencies and the test script, and vitest or jest only when installed', () => {
  const vitestPkg = { name: 'shop', devDependencies: { vitest: '^3' }, scripts: { test: 'vitest' } };
  const installed = folder({ 'package.json': JSON.stringify(vitestPkg), 'node_modules/vitest/package.json': JSON.stringify({ bin: { vitest: 'vitest.mjs' } }), 'node_modules/vitest/vitest.mjs': '' });
  const r = detectRunner(installed)!;
  assert.equal(r.framework, 'vitest');
  assert.equal(r.bin?.replace(/\\/g, '/'), 'node_modules/vitest/vitest.mjs');
  const missing = detectRunner(folder({ 'package.json': JSON.stringify(vitestPkg) }))!;
  assert.equal(missing.framework, 'other', 'not installed: read from the output instead');
  assert.match(missing.note ?? '', /vitest isn't installed/);
  assert.equal(detectRunner(folder({ 'package.json': JSON.stringify({ scripts: { test: 'node --test tests/' } }) }))?.framework, 'node');
  assert.equal(detectRunner(folder({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), null);
  assert.equal(detectRunner(folder({ 'go.mod': 'module example.com/shop\n' }))?.framework, 'go');
  assert.equal(detectRunner(folder({ 'pytest.ini': '[pytest]\n' }))?.framework, 'pytest');
  assert.equal(detectRunner(folder({ 'Cargo.toml': '[package]\nname = "shop"\n' }))?.framework, 'other');
  assert.equal(detectRunner(installed, 'make check')?.framework, 'other', 'a command the person chose wins');
});

test('reads vitest and jest JSON', () => {
  const dir = path.resolve('/work/shop-website');
  const at = (f: string): string => path.join(dir, 'src', f);
  const r = parseJestJson(JSON.stringify({
    numPassedTests: 4, numFailedTests: 1, numPendingTests: 1,
    testResults: [
      { name: at('cart.test.ts'), status: 'failed', assertionResults: [
        { title: 'totals', fullName: 'cart totals', status: 'failed', location: { line: 12, column: 5 }, failureMessages: [`AssertionError: expected 5 to be 6\n\nExpected: 6\nReceived: 5\n    at ${at('cart.test.ts')}:12:20\n    at node_modules/vitest/dist/x.js:1:1`] },
        { title: 'empty', status: 'passed' }
      ] },
      { name: at('broken.test.ts'), status: 'failed', message: 'SyntaxError: Unexpected token (3:9)', assertionResults: [] }
    ]
  }), dir);
  assert.deepEqual([r.passed, r.failed, r.skipped], [4, 2, 1]);
  const f = r.failures[0];
  assert.deepEqual({ name: f.name, file: f.file, line: f.line, expected: f.expected, actual: f.actual }, { name: 'cart totals', file: 'src/cart.test.ts', line: 12, expected: '6', actual: '5' });
  assert.ok(!f.stack?.some(l => l.includes('node_modules')), 'library frames are left out');
  assert.equal(r.failures[1].name, "src/broken.test.ts (didn't run)");
});

test('reads pytest’s JUnit XML', () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.test_cart" name="test_total" file="tests/test_cart.py" line="4"><failure message="assert 5 == 6">def test_total():
&gt;       assert total() == 6
E       assert 5 == 6
E        +  where 5 = total()

tests/test_cart.py:6: AssertionError</failure></testcase>
<testcase classname="tests.test_cart" name="test_empty"/>
<testcase classname="tests.test_cart" name="test_later"><skipped message="later"/></testcase>
</testsuite></testsuites>`;
  const r = parseJunit(xml, '/work/api');
  assert.deepEqual([r.passed, r.skipped, r.failed], [1, 1, 1]);
  const f = r.failures[0];
  assert.deepEqual({ name: f.name, file: f.file, line: f.line, message: f.message }, { name: 'tests.test_cart::test_total', file: 'tests/test_cart.py', line: 6, message: 'assert 5 == 6' });
});

test('reads go test -json, keeping the failing subtest rather than its parent', () => {
  const ev = (o: object): string => JSON.stringify(o);
  const out = [
    ev({ Action: 'run', Package: 'example.com/shop', Test: 'TestCart' }),
    ev({ Action: 'output', Package: 'example.com/shop', Test: 'TestCart/total', Output: '    cart_test.go:14: got 5, want 6\n' }),
    ev({ Action: 'fail', Package: 'example.com/shop', Test: 'TestCart/total' }),
    ev({ Action: 'fail', Package: 'example.com/shop', Test: 'TestCart' }),
    ev({ Action: 'pass', Package: 'example.com/shop', Test: 'TestEmpty' })
  ].join('\n');
  const r = parseGoJson(out);
  assert.deepEqual([r.passed, r.failed], [1, 1]);
  const f = r.failures[0];
  assert.deepEqual({ name: f.name, file: f.file, line: f.line, message: f.message }, { name: 'TestCart/total', file: 'cart_test.go', line: 14, message: 'got 5, want 6' });
});

test('coverage: the istanbul summary, pytest-cov and go, the least covered files first', () => {
  const dir = path.resolve('/work/shop');
  const file = (n: string): string => path.join(dir, 'src', n);
  const k = parseCoverageSummary(JSON.stringify({
    total: { lines: { pct: 81.25 }, statements: { pct: 80 }, functions: { pct: 70.5 }, branches: { pct: 60 } },
    [file('cart.ts')]: { lines: { pct: 100 } }, [file('tax.ts')]: { lines: { pct: 40 } }, [file('empty.ts')]: { lines: { pct: 'Unknown' } }
  }), dir)!;
  assert.deepEqual([k.lines, k.statements, k.functions, k.branches, k.fileCount], [81.3, 80, 70.5, 60, 2]);
  assert.deepEqual(k.files, [{ file: 'src/tax.ts', lines: 40 }, { file: 'src/cart.ts', lines: 100 }]);
  assert.equal(parseCoverageSummary(JSON.stringify({ total: { lines: { pct: 'Unknown' } } }), dir), undefined);
  const p = parsePytestCoverage(JSON.stringify({ totals: { percent_covered: 87.456 }, files: { 'app/a.py': { summary: { percent_covered: 100 } }, 'app/b.py': { summary: { percent_covered: 62.5 } } } }), '/work/api')!;
  assert.deepEqual([p.lines, p.files.map(f => f.file)], [87.5, ['app/b.py', 'app/a.py']]);
  const g = parseGoCover(['mode: set', 'example.com/shop/cart.go:10.2,12.3 2 1', 'example.com/shop/cart.go:14.2,16.3 2 0', 'example.com/shop/tax.go:5.1,6.2 4 1', ''].join('\n'))!;
  assert.deepEqual([g.lines, g.statements, g.fileCount], [75, 75, 2]);
  assert.equal(parseGoCover('mode: set\n'), undefined);
});

test('V8’s raw coverage becomes line coverage of the project’s own files, leaving out tests and node_modules', () => {
  const dir = tmp('assay-cov-v8-');
  const src = 'export function add(a, b) {\n  return a + b;\n}\nexport function unused() {\n  return 1;\n}\n';
  const lib = path.join(dir, 'src', 'lib.mjs');
  fs.mkdirSync(path.dirname(lib), { recursive: true });
  fs.writeFileSync(lib, src);
  fs.writeFileSync(path.join(dir, 'lib.test.mjs'), "test('x')\n");
  const start = src.indexOf('export function unused');
  const out = tmp('assay-cov-v8-out-');
  const script = (f: string, ranges: [number, number, number][]): object => ({ scriptId: '1', url: pathToFileURL(f).href, functions: [{ functionName: '', ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) }] });
  fs.writeFileSync(path.join(out, 'coverage-1.json'), JSON.stringify({ result: [
    script(lib, [[0, src.length, 1], [start, src.length, 0]]), script(path.join(dir, 'lib.test.mjs'), [[0, 10, 1]]),
    script(path.join(dir, 'node_modules', 'dep', 'index.js'), [[0, 10, 1]]), { scriptId: '2', url: 'node:internal/x', functions: [] }
  ] }));
  const k = parseV8Coverage(out, dir)!;
  assert.deepEqual(k.files, [{ file: 'src/lib.mjs', lines: 50 }]);
  assert.equal(k.lines, 50, 'add’s two code lines ran, unused’s two didn’t (lone braces and blank lines aren’t counted)');
  assert.equal(parseV8Coverage(tmp('assay-cov-none-'), dir), undefined);
});

const PKG = JSON.stringify({ name: 'todo-app', type: 'module', scripts: { test: 'node --test' } });
const LIB = 'export function add(a, b) {\n  return a + b;\n}\nexport function unused() {\n  const x = 1;\n  return x + 1;\n}\n';
const TESTS = [
  "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { add } from './src/lib.mjs';",
  "test('adds up the cart', () => { assert.equal(add(1, 1), 3); });",
  "test('empty cart is zero', () => { assert.equal(add(0, 0), 0); });",
  "test('later', { skip: true }, () => {});",
  `test('keeps the key out', () => { assert.equal('${SECRET}', 'x'); });`, ''
].join('\n');

test('a node:test project, run in a clean copy: each failure with its file, line, expected and actual, a key masked, and the repository untouched', async () => {
  const repo = makeRepo('todo-app');
  const head = repo.commit({ 'package.json': PKG, 'src/lib.mjs': LIB, 'cart.test.mjs': TESTS }, 'cart');
  await assert.rejects(runTests({ repo: repo.dir }), /assay allow-run/, 'nothing runs until a person allows it');
  setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  const status = repo.git('status', '--porcelain');
  const r = await runTests({ repo: repo.dir });
  assert.equal(r.schema, 'assay.test/1');
  assert.deepEqual([r.where, r.commit, r.framework, r.ok, r.passed, r.failed, r.skipped], ['copy', head, 'node', false, 1, 2, 1], JSON.stringify(r));
  const f = r.failures.find(x => x.name === 'adds up the cart')!;
  assert.deepEqual({ file: f.file, line: f.line, expected: f.expected, actual: f.actual }, { file: 'cart.test.mjs', line: 4, expected: '3', actual: '2' });
  assert.ok(!JSON.stringify(r).includes(SECRET), 'a key in a failure message is masked');
  assert.equal(repo.git('status', '--porcelain'), status, 'the repository is only read');
  assert.equal(repo.git('rev-parse', 'HEAD').trim(), head);

  const only = await runTests({ repo: repo.dir, match: 'empty cart' });
  assert.deepEqual([only.ok, only.passed, only.failed], [true, 1, 0], JSON.stringify(only));

  const cov = await runTests({ repo: repo.dir, match: 'empty cart', coverage: true });
  assert.ok(cov.coverage, cov.coverageNote);
  const lib = cov.coverage!.files.find(x => x.file === 'src/lib.mjs');
  assert.ok(lib && lib.lines > 0 && lib.lines < 100, JSON.stringify(cov.coverage));
  assert.ok(!cov.coverage!.files.some(x => /test/.test(x.file)), 'the test file isn’t counted');
  assert.equal(only.coverage, undefined, 'no coverage unless asked');
  assert.equal(only.coverageNote, undefined);
});

test('--here runs in the folder only when a person allowed that too, and counts what is uncommitted', async () => {
  const repo = makeRepo('todo-here');
  repo.commit({ 'package.json': PKG, 'src/lib.mjs': LIB, 'cart.test.mjs': TESTS }, 'cart');
  setRepoSettings(repo.dir, { allow: true, timeout: 120 });
  await assert.rejects(runTests({ repo: repo.dir, here: true }), /assay allow-run --here/);
  await assert.rejects(runTests({ repo: repo.dir, changed: true }), /--changed/, 'a clean copy has no uncommitted changes');
  setRepoSettings(repo.dir, { here: true });
  await assert.rejects(runTests({ repo: repo.dir, here: true, ref: 'HEAD' }), /no --ref/);
  // An uncommitted fix is what --here is for: the copy still fails, the folder passes.
  fs.writeFileSync(path.join(repo.dir, 'cart.test.mjs'), TESTS.replace('add(1, 1), 3', 'add(1, 1), 2'));
  fs.writeFileSync(path.join(repo.dir, 'notes.txt'), 'new\n');
  const here = await runTests({ repo: repo.dir, here: true, match: 'adds up' });
  assert.deepEqual([here.where, here.ok, here.uncommitted], ['here', true, 2], JSON.stringify(here));
  const copy = await runTests({ repo: repo.dir, match: 'adds up' });
  assert.deepEqual([copy.where, copy.ok, copy.uncommitted], ['copy', false, undefined]);
});

test('a name filter or file can’t become an option, leave the repository, or reach a shell', async () => {
  const repo = makeRepo('shop-vitest');
  // A stand-in for vitest: it writes a vitest-shaped report whose failure message is exactly the arguments it was given.
  const fake = [
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const out = args.find(a => a.startsWith('--outputFile='));",
    "fs.writeFileSync(out.slice('--outputFile='.length), JSON.stringify({ numPassedTests: 0, numFailedTests: 1, testResults: [{ name: 'a.test.js', status: 'failed', assertionResults: [{ title: 'args', status: 'failed', failureMessages: [JSON.stringify(args)] }] }] }));",
    'process.exit(1);', ''
  ].join('\n');
  repo.commit({ 'package.json': JSON.stringify({ name: 'shop', devDependencies: { vitest: '^3' }, scripts: { test: 'vitest' } }), '.gitignore': 'node_modules\n', 'a.test.js': '' }, 'shop');
  for (const [f, c] of Object.entries({ 'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', bin: { vitest: './vitest.mjs' } }), 'node_modules/vitest/vitest.mjs': fake })) {
    fs.mkdirSync(path.dirname(path.join(repo.dir, f)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, f), c);
  }
  setRepoSettings(repo.dir, { allow: true, timeout: 60 });
  const evil = 'cart" & echo INJECTED > pwned.txt & "';
  const r = await runTests({ repo: repo.dir, match: evil, files: ['a.test.js'], coverage: true });
  assert.equal(r.framework, 'vitest');
  const args = JSON.parse(r.failures[0].message) as string[];
  assert.equal(args[0], 'run');
  assert.ok(args.includes('a.test.js'));
  assert.ok(args.includes(`--testNamePattern=${evil}`), 'the filter arrives whole, as one argument');
  assert.ok(!fs.existsSync(path.join(repo.dir, 'pwned.txt')), 'no shell ran it');
  assert.match(r.coverageNote ?? '', /npm install -D @vitest\/coverage-v8/, 'no provider: what to install, and the tests still ran');
  for (const match of ['--config=evil.js', '-t', 'a\nb']) await assert.rejects(runTests({ repo: repo.dir, match }), /name filter/);
  for (const file of ['../outside.test.js', '/etc/passwd', 'C:\\x.test.js', '--watch']) await assert.rejects(runTests({ repo: repo.dir, files: [file] }), /test file/);
});

test('a command the person chose is run as typed, read from its output, and says what it couldn’t apply', async () => {
  const repo = makeRepo('custom');
  repo.commit({ 'check.mjs': "console.log('ℹ pass 3');\nconsole.log('ℹ fail 0');\n" }, 'check');
  setRepoSettings(repo.dir, { allow: true, command: 'node check.mjs', timeout: 60 });
  const r = await runTests({ repo: repo.dir, match: 'cart', coverage: true });
  assert.deepEqual([r.framework, r.ok, r.passed, r.failed], ['other', true, 3, 0], JSON.stringify(r));
  assert.ok(r.notes.some(n => /name filter can’t be applied/.test(n)));
  assert.match(r.coverageNote ?? '', /can’t measure node check\.mjs/);
});

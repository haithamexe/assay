import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* More false positives found by running the free checks over the recent history of eight real projects (565 commits).
   The names and values here are made up; the shapes are the ones that were found. */
tempHome();
const core = await import('../index.js');

function review(files: Record<string, string>, base: Record<string, string> = { 'README.md': '# x\n' }) {
  const repo = makeRepo();
  repo.commit(base, 'Base');
  repo.commit(files, 'Change');
  return core.openCase({ repo: repo.dir, range: 'HEAD' });
}
type Found = { file: string; tier: string; title: string; evidence: Array<{ source: string }> };
const find = (c: { findings: Found[] }, file: string, source: string): Found | undefined =>
  c.findings.find(f => f.file === file && f.evidence.some(e => e.source === source));

/* Hosts are built from parts so the public-data scan does not read a URL with a password as an email address. */
const dot = (...p: string[]): string => p.join('.');
test('a development database in a URL is not a proven leak, a password to a real host still is', () => {
  const sample = dot('db', 'example', 'com');
  const real = dot('db', 'internal-company', 'net');
  const evil = dot('evil', 'net');
  const local = review({
    '.env.example': 'DATABASE_URL=postgresql://app:t7Kq92xLm@localhost:5432/app\nCACHE_URL=redis://cache:q8Wm41zPd@127.0.0.1:6379\n',
    '.github/workflows/ci.yml': 'env:\n  TEST_DATABASE_URL: postgresql://app:t7Kq92xLm@127.0.0.1:5432/app_test\n',
    'src/config.ts': 'export const url = process.env.DB ?? "postgresql://app:t7Kq92xLm@postgres:5432/app";\n',
    'docs/readme-sample.md': `Connect with \`mysql://reader:t7Kq92xLm@${sample}/app\`.\n`
  });
  for (const file of ['.env.example', '.github/workflows/ci.yml', 'src/config.ts', 'docs/readme-sample.md']) {
    assert.equal(find(local, file, 'fact:url-credentials'), undefined, `${file}: a local or example address is not a fact`);
  }
  assert.equal(find(local, '.env.example', 'rule:url-credentials')?.tier, 'hint', 'still shown, as a hint');
  assert.notEqual(core.verdictOf(local).tone, 'blocked', 'a project with a local database URL is not blocked for it');

  const remote = review({
    'src/remote.ts': `export const url = "postgresql://app:Zq8vK2mT4x@${real}:5432/app";\n`,
    'infra/.env.example': `DATABASE_URL=postgresql://app:Zq8vK2mT4x@${real}:5432/app\n`,
    'src/mixed.ts': `const urls = ["http://a:pw123456@localhost/", "http://a:pw123456@${evil}/"];\n`
  });
  assert.equal(find(remote, 'src/remote.ts', 'fact:url-credentials')?.tier, 'proven', 'a real host');
  assert.equal(find(remote, 'infra/.env.example', 'fact:url-credentials')?.tier, 'proven', 'an example file does not excuse a real host');
  assert.equal(find(remote, 'src/mixed.ts', 'fact:url-credentials')?.tier, 'proven', 'one remote address on the line is enough');
  assert.equal(core.verdictOf(remote).tone, 'blocked');
  const text = JSON.stringify([local, remote]);
  for (const pw of ['t7Kq92xLm', 'q8Wm41zPd', 'Zq8vK2mT4x', 'pw123456']) assert.ok(!text.includes(pw), 'no password is kept');
});

test('a function deleted with its guards is not a removed guard, a guard dropped from one that stays is', () => {
  const gone = review(
    { 'src/util.ts': 'export function keep() {\n  return 1;\n}\n' },
    { 'README.md': '# x\n', 'src/util.ts': 'export function keep() {\n  return 1;\n}\n\nexport function decode(param: string | null) {\n  if (!param) return null;\n  const v = JSON.parse(param);\n  return v;\n}\n' }
  );
  assert.equal(find(gone, 'src/util.ts', 'rule:guard-removed'), undefined, 'the whole function went');

  const dropped = review(
    { 'src/load.ts': 'export function load(param: string | null) {\n  return JSON.parse(param as string);\n}\n' },
    { 'README.md': '# x\n', 'src/load.ts': 'export function load(param: string | null) {\n  if (!param) return null;\n  return JSON.parse(param);\n}\n' }
  );
  assert.ok(find(dropped, 'src/load.ts', 'rule:guard-removed'), 'the function stays and its check does not');
});

test('a rewritten signature with a dropped guard is still a removed guard, and a handler deleted whole is not', () => {
  const rewritten = review(
    { 'src/load.ts': 'export function load(param: string) {\n  return JSON.parse(param);\n}\n' },
    { 'README.md': '# x\n', 'src/load.ts': 'export function load(param: string | null) {\n  if (!param) return null;\n  return JSON.parse(param);\n}\n' }
  );
  assert.ok(find(rewritten, 'src/load.ts', 'rule:guard-removed'), 'the body stays: only the header changed');

  const handler = review(
    { 'src/form.ts': 'export function form() {\n  const a = 1;\n  return a;\n}\n' },
    { 'README.md': '# x\n', 'src/form.ts': 'export function form() {\n  const a = 1;\n  const handle = () => {\n    if (busy) return;\n    send();\n  };\n  return a;\n}\n' }
  );
  assert.equal(find(handler, 'src/form.ts', 'rule:guard-removed'), undefined, 'a nested handler removed with its body');
});

test('a second guard in the same hunk is found after one that went with its block', () => {
  const c = review(
    { 'src/mix.ts': 'export function keep(x: string | null) {\n  return x;\n}\n' },
    { 'README.md': '# x\n', 'src/mix.ts': 'export function old(y: string | null) {\n  if (!y) return null;\n  return y;\n}\n\nexport function keep(x: string | null) {\n  if (!x) return null;\n  return x;\n}\n' }
  );
  const hit = find(c, 'src/mix.ts', 'rule:guard-removed');
  assert.ok(hit, 'the guard in the function that stays is still reported');
  assert.match(hit.title, /guard/i);
});

const pkg = (name: string, deps: Record<string, string> = {}): string => JSON.stringify({ name, version: '1.0.0', dependencies: deps }, null, 2) + '\n';
const ROOT = JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2) + '\n';

test('a "*" next to a package of the same repository is the workspace link, next to any other it is an open range', () => {
  const base = { 'README.md': '# x\n', 'package.json': ROOT, 'packages/a/package.json': pkg('@acme/a'), 'packages/b/package.json': pkg('@acme/b') };
  const c = review({ 'packages/b/package.json': pkg('@acme/b', { '@acme/a': '*', 'some-outside-lib': '*' }) }, base);
  assert.equal(find(c, 'packages/b/package.json', 'rule:unpinned-spec')?.title, 'New dependency: some-outside-lib', 'an outside package at "*" is still an open range');
  assert.equal(c.findings.filter(f => f.evidence.some(e => e.source === 'rule:unpinned-spec')).length, 1, 'the workspace package is not');
  assert.equal(c.findings.filter(f => f.tier === 'corroborated' && /@acme\/a/.test(f.title)).length, 0);
});

test('a manifest that is itself new brings its dependencies as the baseline, a look-alike in it is still named', () => {
  const base = { 'README.md': '# x\n', 'package.json': ROOT, 'packages/a/package.json': pkg('@acme/a', { zod: '3.0.0' }) };
  const added = review({ 'packages/c/package.json': pkg('@acme/c', { 'left-pad-x': '1.0.0', 'tiny-case': '2.0.0', reactt: '1.0.0', react: '19.0.0' }) }, base);
  const titles = added.findings.map(f => f.title);
  assert.ok(!titles.includes('New dependency: left-pad-x') && !titles.includes('New dependency: tiny-case'), 'plain dependencies of a new package are the baseline');
  assert.ok(titles.includes('New dependency: reactt'), 'a look-alike is still named');

  const grown = review({ 'packages/a/package.json': pkg('@acme/a', { zod: '3.0.0', 'tiny-case': '2.0.0' }) }, base);
  assert.ok(grown.findings.some(f => f.title === 'New dependency: tiny-case'), 'a dependency added to a manifest that already existed is still said');
});

test('removing a branch on a value is not removing a guard, a refusal on a value still is', () => {
  const branch = review(
    { 'src/search.ts': 'export function search(kind: string) {\n  return run(kind);\n}\n' },
    { 'README.md': '# x\n', 'src/search.ts': 'export function search(kind: string) {\n  if (kind === "multi") {\n    runMany();\n    return;\n  }\n  return run(kind);\n}\n' }
  );
  assert.equal(find(branch, 'src/search.ts', 'rule:guard-removed'), undefined, 'a case was removed');

  const refusal = review(
    { 'src/access.ts': 'export function open(role: string) {\n  return run(role);\n}\n' },
    { 'README.md': '# x\n', 'src/access.ts': 'export function open(role: string) {\n  if (role === "guest") throw new Error("no");\n  return run(role);\n}\n' }
  );
  assert.ok(find(refusal, 'src/access.ts', 'rule:guard-removed'), 'a check that refuses on a value is still a guard');

  const negated = review(
    { 'src/access2.ts': 'export function open(role: string) {\n  return run(role);\n}\n' },
    { 'README.md': '# x\n', 'src/access2.ts': 'export function open(role: string) {\n  if (role !== "admin") return null;\n  return run(role);\n}\n' }
  );
  assert.ok(find(negated, 'src/access2.ts', 'rule:guard-removed'), '"not equal" is a check, not a branch');
});

test('a guard that was replaced by a call to a check helper is not gone', () => {
  const moved = review(
    { 'src/key.ts': 'export function load(key: string) {\n  checkKey(key);\n  return get(key);\n}\n' },
    { 'README.md': '# x\n', 'src/key.ts': 'export function load(key: string) {\n  if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error("bad key");\n  return get(key);\n}\n' }
  );
  assert.equal(find(moved, 'src/key.ts', 'rule:guard-removed'), undefined, 'the check moved into checkKey');

  const gone = review(
    { 'src/key2.ts': 'const lib = require("lib");\nexport function load(key: string) {\n  return lib.get(key);\n}\n' },
    { 'README.md': '# x\n', 'src/key2.ts': 'export function load(key: string) {\n  if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error("bad key");\n  return get(key);\n}\n' }
  );
  assert.ok(find(gone, 'src/key2.ts', 'rule:guard-removed'), 'loading a module is not a check');
});

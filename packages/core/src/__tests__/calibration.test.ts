import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* Each test here is a false positive (or a miss) found by running assay on real repositories. */
tempHome();
const core = await import('../index.js');

function review(files: Record<string, string>, base: Record<string, string> = { 'README.md': '# x\n' }) {
  const repo = makeRepo();
  repo.commit(base, 'Base');
  repo.commit(files, 'Change');
  return core.openCase({ repo: repo.dir, range: 'HEAD' });
}
const has = (c: { findings: Array<{ file: string; evidence: Array<{ source: string }> }> }, file: string, source: string): boolean =>
  c.findings.some(f => f.file === file && f.evidence.some(e => e.source === source));

test('a tagged SQL template is parameterised, a plain template literal is not', () => {
  const c = review({
    'src/safe.ts': 'export const a = (tx: any, id: string) => tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id}`;\n',
    'src/multi.ts': 'export const b = (db: any, id: string) => db.sql`\n  SELECT id\n  FROM accounts WHERE id = ${id}\n`;\n',
    'src/typed.ts': 'export const t = (tx: any, id: string) => tx.$queryRaw<{ id: string }[]>`\n  SELECT id FROM organisations WHERE id = ${id}::uuid FOR UPDATE`;\n',
    'src/unsafe.ts': 'export const c = (db: any, id: string) => db.query(`SELECT id FROM accounts WHERE id = ${id}`);\n'
  });
  assert.equal(has(c, 'src/typed.ts', 'rule:sql-concat'), false, 'a tag with type arguments is still a tag');
  assert.equal(has(c, 'src/safe.ts', 'rule:sql-concat'), false);
  assert.equal(has(c, 'src/multi.ts', 'rule:sql-concat'), false);
  assert.equal(has(c, 'src/unsafe.ts', 'rule:sql-concat'), true);
});

test('an HTML attribute value like new-password is not a credential, a real assignment is', () => {
  const c = review({
    'src/form.ts': "const f = fld('a-pass', 'Password', 'password', up ? 'new-password' : 'current-password');\n",
    'src/config.ts': 'export const dbPassword = "x9kLm2pQz7wRtV4n";\n'
  });
  assert.equal(has(c, 'src/form.ts', 'rule:generic-secret'), false);
  assert.equal(has(c, 'src/config.ts', 'rule:generic-secret'), true);
  const f = c.findings.find(x => x.file === 'src/config.ts')!;
  assert.equal(f.tier, 'corroborated', 'a secret-looking value in production code: the pattern plus the path');
  assert.ok(!JSON.stringify(c).includes('x9kLm2pQz7wRtV4n'));
});

test('demo, preview, docs and test folders are not the product', () => {
  const c = review({
    'docs/preview/page.js': 'el.innerHTML = markup;\n',
    'src/demos/x.js': 'el.innerHTML = markup;\n',
    'src/page.js': 'el.innerHTML = markup;\n'
  });
  assert.equal(has(c, 'docs/preview/page.js', 'rule:html-injection'), false);
  assert.equal(has(c, 'src/demos/x.js', 'rule:html-injection'), false);
  assert.equal(has(c, 'src/page.js', 'rule:html-injection'), true);
});

test('deleting a whole file is not removing a guard', () => {
  const guarded = 'function f(x) {\n  if (!x) return null;\n  return x.y;\n}\n';
  const c = review({ 'src/old.ts': null as unknown as string }, { 'README.md': '# x\n', 'src/old.ts': guarded });
  assert.equal(c.findings.some(f => f.evidence.some(e => e.source === 'rule:guard-removed')), false);
});

test('many hits of one rule in one file are capped, and the last one says how many were left out', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `el${i}.innerHTML = markup${i};`).join('\n') + '\n';
  const c = review({ 'src/many.js': lines });
  const hits = c.findings.filter(f => f.evidence.some(e => e.source === 'rule:html-injection'));
  assert.equal(hits.length, 3);
  assert.ok(hits.some(f => f.observed.some(o => /5 more lines in this file match the same rule/.test(o))));
});

test('a physical side is only flagged in a file that already mirrors', () => {
  const c = review({ 'src/mirror.css': '.a { margin-inline-start: 4px; }\n.b { right: 12px; }\n', 'src/plain.css': '.c { right: 12px; }\n' });
  assert.equal(has(c, 'src/mirror.css', 'rule:physical-css-side'), true);
  assert.equal(has(c, 'src/plain.css', 'rule:physical-css-side'), false);
});

test('a shell variable is not a credential', () => {
  const c = review({ 'infra/backup.sh': 'export DB_PASSWORD="$(cat /run/secrets/db_password)"\nexport TOKEN="${BACKUP_TOKEN_VALUE}"\n' });
  assert.equal(has(c, 'infra/backup.sh', 'rule:generic-secret'), false);
});

test('in the first commit plain dependencies are the baseline, but a look-alike is still named', () => {
  const repo = makeRepo();
  repo.commit({ 'package.json': '{"dependencies":{"react":"^19.0.0","reactt":"^1.0.0","zod":"^3.0.0"}}\n' }, 'Initial');
  const c = core.openCase({ repo: repo.dir, range: 'HEAD' });
  assert.equal(c.findings.some(f => /New dependency: zod/.test(f.title)), false);
  assert.equal(c.findings.some(f => /New dependency: reactt/.test(f.title)), true);
});

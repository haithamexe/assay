import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepo, SECRET, tempHome } from './fixtures.js';

tempHome();
const core = await import('../index.js');

test('a token-shaped string in a test, or a key header with no key, is a hint; a real key block is proven', () => {
  const repo = makeRepo();
  repo.commit({ 'README.md': '# x\n' }, 'Base');
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
  repo.commit({
    'tests/fixture.test.ts': `const k = "${SECRET}";\n`,
    'src/header.ts': 'const h = "-----BEGIN PRIVATE KEY-----";\n',
    'src/real.ts': `const pem = \`\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n\`;\n`,
    'src/config.ts': `export const aws = "${SECRET}";\n`
  }, 'Add things');
  const c = core.openCase({ repo: repo.dir, range: 'HEAD' });
  const tier = (file: string) => c.findings.find(f => f.check === 'secrets' && f.file === file)?.tier;
  assert.equal(tier('tests/fixture.test.ts'), 'hint', 'in a test path it may be a fixture');
  assert.equal(tier('src/header.ts'), 'hint', 'a header with no key under it');
  assert.equal(tier('src/real.ts'), 'proven');
  assert.equal(tier('src/config.ts'), 'proven', 'the same string in production code is a fact');
  const v = core.verdictOf(c);
  assert.equal(v.tone, 'blocked');
  assert.deepEqual(v.must.map(f => f.file).sort(), ['src/config.ts', 'src/real.ts']);
  assert.ok(!JSON.stringify(c).includes(body), 'the key body is never kept');
});

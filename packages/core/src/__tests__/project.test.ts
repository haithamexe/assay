import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, SECRET, tempHome } from './fixtures.js';

tempHome();
const { checkPagePath, checkUrl, checkupFails, InputError, listCheckups, normalizeParams, readFlows, readHar, readOpenApiText, routesFromFiles, runCheckup } = await import('../index.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-inputs-'));
const file = (name: string, content: unknown): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
};

test('checkUrl takes only an app on this computer, without a password, and drops the query', () => {
  assert.equal(checkUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(checkUrl('https://127.0.0.1:8443/app/?x=1#y'), 'https://127.0.0.1:8443/app');
  assert.equal(checkUrl('http://[::1]:5173'), 'http://[::1]:5173');
  assert.equal(checkUrl('http://shop.localhost:3000'), 'http://shop.localhost:3000');
  for (const bad of ['https://example.com', 'http://10.0.0.5:3000', 'http://localhost.example.com', 'http://user:pw@localhost:3000', 'ftp://localhost', 'localhost:3000', 'file:///etc/passwd']) {
    assert.throws(() => checkUrl(bad), InputError, bad);
  }
});

test('checkPagePath takes a path with one leading slash and drops the fragment', () => {
  assert.equal(checkPagePath('/cart'), '/cart');
  assert.equal(checkPagePath(' /search?q=shoes#top '), '/search?q=shoes');
  for (const bad of ['cart', '//evil.example/x', '/a\\b', '/a b', 'http://localhost/x', '']) assert.throws(() => checkPagePath(bad), InputError, bad);
});

test('parameters written by any router become {name}', () => {
  assert.equal(normalizeParams('/items/:id/edit'), '/items/{id}/edit');
  assert.equal(normalizeParams('/items/[id]'), '/items/{id}');
  assert.equal(normalizeParams('/docs/[...slug]'), '/docs/{slug}');
  assert.equal(normalizeParams('/docs/[[...slug]]'), '/docs/{slug}');
  assert.equal(normalizeParams('/users/$userId'), '/users/{userId}');
  assert.equal(normalizeParams('/items/{id}'), '/items/{id}');
});

test('readHar keeps the recording’s own site, folds ids, and never keeps a header, cookie, query value or body', () => {
  const entry = (method: string, url: string, kind: string, mime: string, status = 200, body?: string) => ({
    _resourceType: kind,
    request: { method, url, headers: [{ name: 'Authorization', value: 'Bearer sk-very-secret-token' }, { name: 'Cookie', value: 'session=abc123cookie' }], postData: body ? { mimeType: 'application/json', text: body } : undefined },
    response: { status, content: { mimeType: mime } }
  });
  const har = file('visit.har', { log: { entries: [
    entry('GET', 'http://localhost:5173/', 'document', 'text/html'),
    entry('GET', 'http://localhost:5173/main.js', 'script', 'text/javascript'),
    entry('GET', 'http://localhost:5173/api/items/42?token=query-secret', 'fetch', 'application/json'),
    entry('GET', 'http://localhost:5173/api/items/43', 'fetch', 'application/json'),
    entry('POST', 'http://localhost:5173/api/cart', 'xhr', 'application/json', 201, '{"card":"4111111111111111"}'),
    entry('GET', 'http://localhost:5173/cart', 'document', 'text/html'),
    entry('GET', 'http://localhost:5173/missing', 'document', 'text/html', 404),
    entry('GET', 'https://analytics.example.com/collect', 'fetch', 'application/json'),
    entry('GET', 'https://fonts.example.net/a.woff2', 'font', 'font/woff2')
  ] } });
  const r = readHar(har);
  assert.deepEqual(r.pages.map(p => p.path).sort(), ['/', '/cart']);
  assert.deepEqual(r.endpoints.map(e => `${e.method} ${e.path}`).sort(), ['GET /api/items/{id}', 'POST /api/cart']);
  assert.match(r.notes.join(' '), /2 requests in the HAR went to other sites/);
  const kept = JSON.stringify(r);
  for (const s of ['sk-very-secret-token', 'abc123cookie', 'query-secret', '4111111111111111', 'analytics.example.com']) assert.ok(!kept.includes(s), s);
  // Recorded on another address than the app: the paths are used on the app's address, and the app's own requests count too.
  const other = readHar(har, { url: 'http://127.0.0.1:3000' });
  assert.match(other.notes.join(' '), /recorded on another address/);
  assert.throws(() => readHar(file('nope.har', { entries: [] })), /no log\.entries/);
  assert.throws(() => readHar(file('bad.har', '{')), /not valid JSON/);
  assert.throws(() => readHar(path.join(tmp, 'absent.har')), /No HAR file/);
});

test('readFlows checks every step strictly and refuses the whole file with where it is wrong', () => {
  const ok = file('flow.json', { assay: 'flow/1', name: 'Checkout', start: '/cart', steps: [
    { click: 'text=Checkout' }, { type: 'octocat@example.com', into: '#email' }, { press: 'Enter' }, { waitFor: 'url=/thanks', timeoutMs: 5000 }, { goto: '/orders' }, { back: true }, { click: '#again', double: true }
  ] });
  const [f] = readFlows(ok);
  assert.equal(f.name, 'Checkout');
  assert.equal(f.start, '/cart');
  assert.equal(f.steps.length, 7);
  assert.deepEqual(f.steps[1], { type: 'octocat@example.com', into: '#email' });
  const bad = (steps: unknown[], extra: Record<string, unknown> = {}): RegExp | string => {
    try { readFlows(file('bad-flow.json', { assay: 'flow/1', start: '/', steps, ...extra })); return 'accepted'; } catch (e) { return (e as Error).message; }
  };
  assert.match(String(bad([{ click: 'a', press: 'Enter' }])), /step 1 must do exactly one thing/);
  assert.match(String(bad([{ click: 'a' }, { run: 'rm -rf /' }])), /step 2 has a field Assay doesn't know: run/);
  assert.match(String(bad([{ press: 'F12' }])), /press takes one of/);
  assert.match(String(bad([{ goto: '//evil.example/' }])), /not a page path/);
  assert.match(String(bad([{ type: 'x', double: true }])), /double goes only with click/);
  assert.match(String(bad([{ waitFor: 'x', timeoutMs: 999999 }])), /timeoutMs/);
  assert.match(String(bad([], { start: 'http://localhost/' })), /not a page path/);
  assert.match(String(bad([], { assay: 'flow/2' })), /must say "assay": "flow\/1"/);
  assert.equal(readFlows(file('flows.json', [{ assay: 'flow/1', start: '/', steps: [] }, { assay: 'flow/1', start: '/b', steps: [] }])).length, 2);
});

test('a Chrome DevTools Recorder export becomes a flow, and steps with no equivalent are counted, not guessed', () => {
  const [f] = readFlows(file('recording.json', { title: 'Sign in', steps: [
    { type: 'setViewport', width: 1280, height: 800 },
    { type: 'navigate', url: 'https://staging.example.com/login?next=%2F' },
    { type: 'click', selectors: [['aria/Email'], ['#email']] },
    { type: 'change', value: 'octocat@example.com', selectors: [['#email']] },
    { type: 'keyDown', key: 'Enter' }, { type: 'keyUp', key: 'Enter' },
    { type: 'click', selectors: [['aria/Sign in[role="button"]'], ['xpath///button']] },
    { type: 'scroll', x: 0, y: 400 },
    { type: 'doubleClick', selectors: [['.card']] },
    { type: 'waitForElement', selectors: [['text/Welcome']] },
    { type: 'navigate', url: 'https://staging.example.com/account' }
  ] }));
  assert.equal(f.name, 'Sign in');
  assert.equal(f.start, '/login', 'only the path is kept: the host and the query are not');
  assert.deepEqual(f.steps, [
    { click: '#email' }, { type: 'octocat@example.com', into: '#email' }, { press: 'Enter' }, { click: 'text=Sign in' },
    { click: '.card', double: true }, { waitFor: 'text=Welcome' }, { goto: '/account' }
  ]);
  assert.equal(f.skipped, 2, 'setViewport and scroll');
  assert.throws(() => readFlows(file('rec-nonav.json', { title: 'x', steps: [{ type: 'click', selectors: [['#a']] }] })), /never opens a page/);
});

test('readOpenApiText reads OpenAPI 3 JSON and Swagger 2 YAML, with the base path in front, and refuses what isn’t one', () => {
  const oas = readOpenApiText(JSON.stringify({ openapi: '3.0.3', servers: [{ url: 'http://localhost:3000/api' }], paths: { '/items': { get: {}, post: {} }, '/items/{id}': { delete: {}, parameters: [] } } }), 'openapi.json');
  assert.deepEqual(oas.map(e => `${e.method} ${e.path}`), ['GET /api/items', 'POST /api/items', 'DELETE /api/items/{id}']);
  const sw = readOpenApiText('swagger: "2.0"\nbasePath: /v1\npaths:\n  /users:\n    get:\n      summary: List\n', 'swagger.yaml');
  assert.deepEqual(sw.map(e => `${e.method} ${e.path}`), ['GET /v1/users']);
  assert.throws(() => readOpenApiText('{"name":"not a spec"}', 'x.json'), /not an OpenAPI 3 or Swagger 2/);
  assert.throws(() => readOpenApiText('openapi: 3.0.0\npaths: &p\n  /a: *p\n', 'a.yaml'), /anchors/);
});

test('routes come from the framework’s own folders, and a folder named pages means nothing without the framework', () => {
  const texts: Record<string, string> = {
    'web/package.json': '{"dependencies":{"next":"15.0.0"}}',
    'web/app/api/items/route.ts': 'export async function GET() {}\nexport const POST = () => {};',
    'api/package.json': '{"dependencies":{"@nestjs/core":"10","express":"4"}}',
    'api/src/users.controller.ts': "@Controller('users')\nexport class Users {\n  @Get()\n  all() {}\n  @Get(':id')\n  one() {}\n  @Post()\n  add() {}\n}",
    'api/src/health.ts': "app.get('/health', (req, res) => res.send('ok'));\nrouter.delete('/items/:id', h);",
    'api/openapi.yaml': 'openapi: 3.0.0\npaths:\n  /orders:\n    get: {}\n'
  };
  const files = [
    ...Object.keys(texts),
    'web/app/page.tsx', 'web/app/(shop)/cart/page.tsx', 'web/app/items/[id]/page.tsx', 'web/app/_lib/page.tsx', 'web/app/@modal/login/page.tsx',
    'web/pages/about.tsx', 'web/pages/_app.tsx', 'web/pages/api/legacy.ts',
    'index.html', 'public/about.html', 'docs/guide.html', 'node_modules/x/index.html', 'web/app/page.test.tsx'
  ];
  const r = routesFromFiles(files, p => texts[p]);
  const pages = r.pages.map(p => `${p.path}${p.dynamic ? ' (dynamic)' : ''}`).sort();
  assert.deepEqual(pages, ['/', '/', '/about', '/about.html', '/cart', '/items/{id} (dynamic)']);
  const eps = r.endpoints.map(e => `${e.method} ${e.path}`).sort();
  assert.deepEqual(eps, ['* /api/legacy', 'DELETE /items/{id}', 'GET /api/items', 'GET /health', 'GET /orders', 'GET /users', 'GET /users/{id}', 'POST /api/items', 'POST /users']);
  assert.deepEqual(r.frameworks, ['express', 'nest', 'next']);
  // Without Next, Nuxt or Astro a pages folder holds components, not routes.
  assert.deepEqual(routesFromFiles(['package.json', 'src/pages/Home.tsx'], () => '{"dependencies":{"react":"19"}}').pages, []);
  const kit = routesFromFiles(['svelte.config.js', 'src/routes/+page.svelte', 'src/routes/(app)/blog/[slug]/+page.svelte', 'src/routes/api/ping/+server.ts'], p => (p.endsWith('+server.ts') ? 'export const GET = () => {}' : ''));
  assert.deepEqual(kit.pages.map(p => p.path), ['/', '/blog/{slug}']);
  assert.deepEqual(kit.endpoints.map(e => `${e.method} ${e.path}`), ['GET /api/ping']);
  const remix = routesFromFiles(['remix.config.js', 'app/routes/_index.tsx', 'app/routes/cart.$id.tsx', 'app/routes/_auth.login.tsx', 'app/routes/account/route.tsx'], () => '');
  assert.deepEqual(remix.pages.map(p => p.path), ['/', '/cart/{id}', '/login', '/account']);
});

test('a checkup reads every tracked file at the commit, proves a committed key without printing it, and never reads what isn’t committed', () => {
  const repo = makeRepo('shop-website');
  repo.commit({
    'README.md': '# shop\n',
    'src/config.js': `export const key = "${SECRET}";\n`,
    'deploy/id_rsa': 'not really a key\n',
    '.env': 'DATABASE_URL=postgres://u:hunter2secret@localhost/db\n',
    'package.json': '{"dependencies":{"next":"15"}}',
    'app/page.tsx': 'export default function Page() {}\n'
  }, 'Shop');
  fs.writeFileSync(path.join(repo.dir, '.env.local'), `TOKEN="${SECRET.replace('AKIA', 'ASIA')}"\n`);
  fs.writeFileSync(path.join(repo.dir, 'README.md'), '# shop, changed\n');
  const statusBefore = repo.git('status', '--porcelain');
  const c = runCheckup({ repo: repo.dir, url: 'http://localhost:3000', pages: ['/cart'] });
  assert.equal(c.schema, 'assay.checkup/1');
  assert.equal(c.name, 'shop-website');
  assert.equal(c.previous, null);
  const titles = c.findings.map(f => f.title);
  assert.ok(titles.includes('AWS access key id in config.js'), titles.join(' | '));
  assert.ok(titles.includes('A key file is tracked: id_rsa'), titles.join(' | '));
  assert.ok(titles.includes('A .env file is tracked: .env'), titles.join(' | '));
  const key = c.findings.find(f => f.title.startsWith('AWS'))!;
  assert.equal(key.tier, 'proven');
  assert.equal(key.since, 'first');
  assert.equal(key.line, 1);
  assert.equal(key.snippet.rows[0].t, ' ', 'a file as it is shows plain lines, not added ones');
  assert.ok(!c.findings.some(f => f.file === '.env.local'), 'an uncommitted file is not read');
  const all = JSON.stringify(c);
  assert.ok(!all.includes(SECRET.slice(4)), 'the key is masked everywhere');
  assert.ok(!all.includes('hunter2secret'));
  assert.equal(c.uncommitted, 1);
  assert.equal(c.summary.tone, 'act');
  assert.match(c.summary.headline, /First checkup/);
  assert.deepEqual(c.inventory!.pages.map(p => `${p.path} ${p.from.join('+')}`), ['/ router', '/cart pages']);
  assert.equal(c.inventory!.url, 'http://localhost:3000');
  assert.equal(repo.git('status', '--porcelain'), statusBefore, 'the repository is only read');
  assert.equal(listCheckups(repo.dir).length, 1);
  assert.ok(checkupFails(c, 'new'), 'a first checkup with a proven problem fails on new');
});

test('the next checkup says what is new, what was already there and what is gone, by the line’s text, not its number', () => {
  const repo = makeRepo('compare-me');
  repo.commit({ 'src/a.js': `const k = "${SECRET}";\n`, 'src/b.js': 'ok\n' }, 'One');
  const first = runCheckup({ repo: repo.dir });
  assert.equal(first.findings.length, 1);
  repo.commit({ 'src/a.js': `// moved down\n\nconst k = "${SECRET}";\n`, 'src/b.js': 'const t = "ghp_' + 'a'.repeat(36) + '";\n' }, 'Two');
  const second = runCheckup({ repo: repo.dir });
  assert.equal(second.previous?.id, first.id);
  const since = Object.fromEntries(second.findings.map(f => [f.file, f.since]));
  assert.deepEqual(since, { 'src/a.js': 'before', 'src/b.js': 'new' }, 'the moved key is the same finding');
  assert.equal(second.summary.new, 1);
  assert.equal(second.summary.before, 1);
  assert.ok(checkupFails(second, 'new'));
  repo.commit({ 'src/a.js': 'const k = process.env.KEY;\n' }, 'Three');
  const third = runCheckup({ repo: repo.dir });
  assert.deepEqual(third.gone.map(g => g.file), ['src/a.js']);
  assert.deepEqual(third.findings.map(f => f.since), ['before']);
  assert.ok(!checkupFails(third, 'new'), 'nothing new');
  assert.ok(checkupFails(third, 'any'));
  // An older commit can be checked too, without saving it.
  const old = runCheckup({ repo: repo.dir, ref: 'HEAD~2', save: false });
  assert.equal(old.findings.length, 1);
  assert.equal(old.branch, null);
  assert.equal(listCheckups(repo.dir).length, 3);
});

test('only the secrets check: no list of pages, and HAR, flow and OpenAPI files feed the list when it is wanted', () => {
  const repo = makeRepo('inputs-repo');
  repo.commit({ 'index.html': '<h1>hi</h1>\n', 'openapi.json': JSON.stringify({ openapi: '3.1.0', paths: { '/api/items': { get: {} } } }) }, 'Base');
  assert.equal(runCheckup({ repo: repo.dir, checks: ['secrets'], inventory: false, save: false }).inventory, null);
  const har = file('inputs.har', { log: { entries: [{ _resourceType: 'fetch', request: { method: 'PATCH', url: 'http://localhost:3000/api/items/7' }, response: { status: 200, content: { mimeType: 'application/json' } } }] } });
  const flow = file('inputs-flow.json', { assay: 'flow/1', name: 'Buy', start: '/shop', steps: [{ click: 'text=Buy' }, { goto: '/done' }] });
  const spec = file('extra.yaml', 'openapi: 3.0.0\npaths:\n  /api/orders:\n    post: {}\n');
  const c = runCheckup({ repo: repo.dir, har, flow, openapi: spec, save: false });
  const inv = c.inventory!;
  assert.deepEqual(inv.pages.map(p => `${p.path} ${p.from.join('+')}`), ['/ html', '/done flow', '/shop flow']);
  assert.deepEqual(inv.endpoints.map(e => `${e.method} ${e.path} ${e.from.join('+')}`), ['GET /api/items openapi', 'PATCH /api/items/{id} har', 'POST /api/orders openapi']);
  assert.deepEqual(inv.flows, [{ name: 'Buy', start: '/shop', steps: 2, skipped: 0, file: 'inputs-flow.json' }]);
  assert.throws(() => runCheckup({ repo: repo.dir, url: 'https://example.com', save: false }), /running on this computer/);
});

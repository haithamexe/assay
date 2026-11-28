import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* D64: attack my app. A made-up app with one weakness per check, and a fixed one to compare with. Both only ever listen on
   127.0.0.1, and the attack only talks to the origin it is given. */
tempHome();
const core = await import('../index.js');
const browser = core.findBrowser();

interface Counts { posts: number; comments: string[] }
function app(safe: boolean, counts: Counts): http.Server {
  let logins = 0;
  const esc = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return http.createServer((q, r) => {
    let body = '';
    q.on('data', c => (body += c));
    q.on('end', () => {
      if (q.method !== 'GET') counts.posts++;
      const url = new URL(q.url ?? '/', 'http://x');
      const json = (status: number, b: unknown, h: Record<string, string> = {}): void => { r.writeHead(status, { 'content-type': 'application/json', ...h }); r.end(JSON.stringify(b)); };
      const page = (html: string): void => {
        r.writeHead(200, { 'content-type': 'text/html', 'set-cookie': safe ? 'sid=abc; Path=/; HttpOnly; SameSite=Lax' : 'sid=abc; Path=/', ...(safe ? { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' } : {}) });
        r.end(`<!doctype html><html lang="en"><body>${html}</body></html>`);
      };
      const signed = /sid=good/.test(q.headers.cookie ?? '');
      const cors: Record<string, string> = !safe && q.headers.origin ? { 'access-control-allow-origin': q.headers.origin, 'access-control-allow-credentials': 'true' } : {};
      if (url.pathname === '/search') return page(`<p>Results for ${safe ? esc(url.searchParams.get('q') ?? '') : (url.searchParams.get('q') ?? '')}</p>`);
      if (url.pathname === '/comments') return page(`<ul>${counts.comments.map(c => `<li>${safe ? esc(c) : c}</li>`).join('')}</ul>`);
      if (url.pathname === '/api/comments' && q.method === 'POST') {
        if (!signed) return json(401, { error: 'sign in' });
        if (safe && q.headers.origin && q.headers.origin !== `http://127.0.0.1:${(q.socket.localPort ?? 0)}`) return json(403, { error: 'cross-site' });
        try { counts.comments.push(String((JSON.parse(body) as { text: string }).text)); } catch (err) { return safe ? json(400, { error: 'bad json' }) : json(500, { error: (err as Error).stack }); }
        return json(201, { ok: true });
      }
      if (url.pathname === '/api/login' && q.method === 'POST') { logins++; if (safe && logins > 5) return json(429, { error: 'slow down' }, { 'retry-after': '60' }); return json(401, { error: 'wrong password' }); }
      const order = /^\/api\/orders\/(.+)$/.exec(url.pathname);
      if (order) {
        if (safe && !signed) return json(401, { error: 'sign in' });
        if (!/^\d+$/.test(order[1])) return json(500, { error: safe ? 'bad id' : `SQLITE_ERROR: unrecognized token: "${order[1]}"` });
        if (safe && order[1] !== '42') return json(404, { error: 'not yours' });
        return json(200, { id: Number(order[1]), total: 12.5 * Number(order[1]) }, cors);
      }
      json(404, { error: 'no' });
    });
  });
}

const SPEC = JSON.stringify({
  openapi: '3.0.0', info: { title: 'shop', version: '1' },
  paths: {
    '/api/orders/{id}': { get: {} },
    '/api/comments': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Comment' } } } } } },
    '/api/login': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } } } },
    '/api/logout': { get: {} }
  },
  components: { schemas: { Comment: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, id: { type: 'integer', readOnly: true } } } } }
}, null, 1);

const badCounts: Counts = { posts: 0, comments: [] };
const goodCounts: Counts = { posts: 0, comments: [] };
let bad: http.Server, good: http.Server;
let badUrl = '', goodUrl = '';
const listen = (s: http.Server): Promise<number> => new Promise(res => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
before(async () => { bad = app(false, badCounts); good = app(true, goodCounts); badUrl = `http://127.0.0.1:${await listen(bad)}`; goodUrl = `http://127.0.0.1:${await listen(good)}`; });
after(() => { bad.close(); good.close(); });

function project(name: string, writes: boolean): string {
  const repo = makeRepo(name);
  repo.commit({ 'openapi.json': SPEC }, 'Describe the API');
  core.setRepoSettings(repo.dir, { allow: true, ...(writes ? { writes: true } : {}) });
  return repo.dir;
}
const SESSION = { cookie: 'sid=good' };
const PAGES = ['/search', '/comments'];

test('body shapes come from the OpenAPI file: names and types only, a $ref followed, read-only properties left out, and kept out of a checkup unless asked for', () => {
  const repo = makeRepo('shapes');
  repo.commit({ 'openapi.json': SPEC }, 'Describe the API');
  const eps = core.readOpenApiText(SPEC, 'openapi.json');
  assert.deepEqual(eps.find(e => e.path === '/api/comments')?.body, [{ name: 'text', type: 'string', required: true }]);
  assert.deepEqual(eps.find(e => e.path === '/api/login')?.body?.map(f => f.name), ['email', 'password']);
  assert.equal(eps.find(e => e.path === '/api/orders/{id}')?.body, undefined);
  assert.ok(!JSON.stringify(core.runCheckup({ repo: repo.dir, save: false })).includes('"body"'), 'a checkup lists endpoints without bodies');
  assert.ok(JSON.stringify(core.runCheckup({ repo: repo.dir, save: false, checks: [], bodies: true })).includes('"body"'));
});

test('attack my app: each weakness is found, with the request that shows it, and a hint says it is a hint', async () => {
  const dir = project('shop-website', true);
  const r = await core.runAttack({ repo: dir, pages: PAGES, url: badUrl, writes: true, session: SESSION, browser: !!browser });
  const checks = new Set(r.findings.map(f => f.check));
  for (const c of ['headers', 'cookie', 'cors', 'no-auth', 'idor', 'sql-error', 'stack-trace', 'xss-reflected', 'csrf', 'login-rate']) assert.ok(checks.has(c as never), `${c}: ${JSON.stringify(r.findings.map(f => f.check))}`);
  if (browser) assert.ok(checks.has('xss-stored'), 'stored script shows on /comments');
  const cors = r.findings.find(f => f.check === 'cors')!;
  assert.deepEqual([cors.severity, cors.tier, cors.where], ['high', 'proven', 'openapi.json']);
  assert.match(cors.proof, /Origin: https:\/\/evil\.example/);
  assert.match(r.findings.find(f => f.check === 'login-rate')!.proof, /20 × POST \/api\/login/);
  assert.match(r.findings.find(f => f.check === 'csrf')!.proof, /Origin: https:\/\/evil\.example and the session cookie.*\(without the cookie: 401\)/);
  assert.deepEqual(['no-auth', 'idor'].map(c => r.findings.find(f => f.check === c)!.tier), ['hint', 'hint'], 'what depends on what was meant is a hint');
  assert.ok(['sql-error', 'xss-reflected', 'csrf'].every(c => r.findings.find(f => f.check === c)!.tier === 'proven'));
  assert.equal(r.findings[0].severity, 'high', 'serious first');
  assert.equal(core.attackFails(r, 'high'), true);
  assert.deepEqual([r.schema, r.writes, r.url], ['assay.attack/1', true, badUrl]);
  assert.ok(!JSON.stringify(r).includes('sid=good'), 'the session isn’t in the report');
  assert.ok(r.skipped.some(s => /\/api\/logout/.test(s)), 'a GET that is named like an action is not sent');
  assert.ok(badCounts.comments.some(c => c.includes('<assay')), 'the writes saved the test text');
});

test('attack my app: a fixed app has nothing proven that is serious', async () => {
  const dir = project('shop-fixed', true);
  const r = await core.runAttack({ repo: dir, pages: PAGES, url: goodUrl, writes: true, session: SESSION, browser: !!browser });
  assert.deepEqual(r.findings.filter(f => f.severity === 'high').map(f => f.title), []);
  assert.equal(core.attackFails(r, 'high'), false);
});

test('without --writes nothing is sent but GET requests, and the data-changing checks say why they were left out', async () => {
  const dir = project('shop-reads', true);
  const before = badCounts.posts;
  const r = await core.runAttack({ repo: dir, pages: PAGES, url: badUrl, session: SESSION, browser: false });
  assert.equal(badCounts.posts, before, 'no POST, PUT, PATCH or DELETE was sent');
  assert.equal(r.writes, false);
  assert.ok(r.skipped.some(s => /need --writes/.test(s)));
  assert.ok(!r.tried.some(t => /wrong password|saved through|CSRF/.test(t)));
  assert.ok(r.findings.some(f => f.check === 'cors') && r.findings.some(f => f.check === 'xss-reflected'));
  // and without a session the signed-in checks say what they need
  const anon = await core.runAttack({ repo: dir, pages: PAGES, url: badUrl, browser: false });
  assert.ok(anon.skipped.some(s => /ASSAY_ATTACK_COOKIE/.test(s)));
  assert.ok(!anon.findings.some(f => f.check === 'idor' || f.check === 'no-auth'));
});

test('running is refused until allowed, data-changing checks until their own yes, and only this computer is attacked', async () => {
  const repo = makeRepo('guarded');
  repo.commit({ 'openapi.json': SPEC }, 'Describe the API');
  await assert.rejects(core.runAttack({ repo: repo.dir, url: badUrl }), /assay allow-run/);
  core.setRepoSettings(repo.dir, { allow: true });
  await assert.rejects(core.runAttack({ repo: repo.dir, url: badUrl, writes: true }), /assay allow-run --writes/);
  for (const url of ['http://example.com', 'http://192.168.1.5:3000', 'http://user:pw@localhost:3000', 'ftp://localhost']) await assert.rejects(core.runAttack({ repo: repo.dir, url, browser: false }), /computer|address|user name/, url);
  // an app that isn't there is said so, not an error
  const none = await core.runAttack({ repo: repo.dir, url: 'http://127.0.0.1:1', browser: false });
  assert.ok(none.skipped.some(s => /Nothing answered/.test(s)));
});

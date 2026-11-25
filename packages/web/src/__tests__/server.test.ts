import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeRepo, request, SECRET, signIn } from './helpers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-home-'));
process.env.ASSAY_HOME = home;
const core = await import('@assay/core');
const { startDashboard } = await import('../index.js');
type Dash = Awaited<ReturnType<typeof startDashboard>>;

const repo = makeRepo([
  { files: { 'README.md': '# shop\n' }, message: 'Base' },
  { files: { 'config/settings.py': `AWS_KEY = "${SECRET}"\nREGION = "eu-west-1"\n` }, message: 'Add settings <b>bold</b>' },
  { files: { 'src/cart.py': 'def total(items):\n    return sum(i.price for i in items)\n' }, message: 'Add totals' }
]);

let d: Dash;
let page: Awaited<ReturnType<typeof signIn>>;
before(async () => {
  d = await startDashboard({ repo: repo.dir });
  page = await signIn(d);
});
after(async () => { await d.close(); });

test('it answers only with this run’s key, and only on the loopback address', async () => {
  assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  assert.equal((await request(d.port, 'GET', '/')).status, 401, 'no key, no page');
  assert.equal((await request(d.port, 'GET', '/api/state')).status, 401, 'no key, no data');
  const wrong = await request(d.port, 'GET', '/?token=not-the-key');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const ok = await request(d.port, 'GET', `/?token=${d.token}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/', 'the key is taken out of the address');
  const cookie = String(ok.headers['set-cookie']?.[0]);
  assert.match(cookie, /HttpOnly/, 'the page’s own script can’t read the key');
  assert.match(cookie, /SameSite=Strict/);
  // a web page whose name was pointed at this address (DNS rebinding) is refused, even with the key
  assert.equal((await request(d.port, 'GET', '/api/state', { cookie: page.cookie, headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request(d.port, 'GET', '/api/state', { cookie: page.cookie, headers: { host: `evil.example:${d.port}` } })).status, 403);
  assert.equal((await page.get('/api/state')).status, 200);
});

test('a post must come from the page itself, as JSON', async () => {
  const body = { mode: 'branch' };
  const send = (headers: Record<string, string>): Promise<{ status: number }> => request(d.port, 'POST', '/api/open', { cookie: page.cookie, body, headers });
  assert.equal((await send({ 'content-type': 'application/json' })).status, 403, 'no origin');
  assert.equal((await send({ origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403, 'another origin');
  assert.equal((await send({ origin: d.origin, 'content-type': 'text/plain' })).status, 415, 'not JSON');
  assert.equal((await request(d.port, 'POST', '/api/open', { cookie: page.cookie, raw: 'x'.repeat(70_000), headers: { origin: d.origin, 'content-type': 'application/json' } })).status, 413, 'too big');
  assert.equal((await request(d.port, 'POST', '/api/open', { cookie: page.cookie, raw: '{nope', headers: { origin: d.origin, 'content-type': 'application/json' } })).status, 400, 'not valid JSON');
  assert.equal((await request(d.port, 'DELETE', '/api/state', { cookie: page.cookie })).status, 405);
  assert.equal((await page.post('/api/open', body)).status, 200);
});

test('the page may load only from this server, and nothing runs inline', async () => {
  const r = await page.get('/');
  assert.equal(r.status, 200);
  const csp = String(r.headers['content-security-policy']);
  for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(part), `${part} in ${csp}`);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(r.text), 'no inline script');
  assert.ok(!/\sstyle=|<style/i.test(r.text), 'no inline style');
  assert.ok(!/\son[a-z]+=/i.test(r.text), 'no inline handlers');
  // the module files it loads are served; the stylesheet has its fonts pointed here instead of embedded
  for (const f of ['main', 'lib', 'state', 'timeline', 'case', 'compare', 'settings', 'theme']) assert.equal((await page.get(`/js/${f}.js`)).status, 200, f);
  const css = await page.get('/css/base.css');
  assert.equal(css.status, 200);
  assert.ok(!css.text.includes('data:font') && !css.text.includes('__GEIST'), 'fonts come from this server');
  assert.equal((await page.get('/fonts/geist.woff2')).headers['content-type'], 'font/woff2');
});

test('only the named files are served: a path can’t reach anything else', async () => {
  for (const p of ['/js/..%2f..%2fpackage.json', '/js/../../package.json', '/js/nothere.js', '/js/main.js.map', '/fonts/other.woff2', '/fonts/..%2fgeist.woff2', '/node_modules/typescript/package.json', '/package.json', '/src/server.ts', '/css/other.css']) {
    assert.equal((await page.get(p)).status, 404, p);
  }
});

test('state and timeline: what the free checks found on each commit', async () => {
  const s = (await page.get('/api/state')).json;
  assert.equal(s.name, 'shop-website');
  assert.equal(s.branch, 'main');
  assert.equal(s.head, repo.hashes[2]);
  assert.equal(s.allowed, false, 'running the project’s code is off until a person turns it on');
  const t = (await page.get('/api/timeline?limit=10')).json;
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0].subject, 'Add totals');
  const settings = t.rows.find((r: { subject: string }) => r.subject.startsWith('Add settings'));
  assert.equal(settings.counts.proven, 1);
  assert.ok(settings.lenses.includes('Security'), 'the lens each commit’s findings are about');
  assert.ok(Array.isArray(t.branch.hashes) && t.branch.hashes.length >= 1);
  assert.equal(typeof t.branch.fallback, 'boolean');
});

let caseId = '';
let secretId = '';

test('opening a case gives the verdict, a state for every finding and the findings in order, with the secret masked', async () => {
  const r = await page.post('/api/open', { mode: 'span', from: repo.hashes[0], to: repo.hashes[2] });
  assert.equal(r.status, 200, r.text);
  const v = r.json;
  caseId = v.case.id;
  assert.equal(v.verdict.tone, 'blocked');
  assert.equal(v.verdict.must.length, 1);
  assert.equal(v.case.commits.length, 3);
  const f = v.case.findings.find((x: { title: string }) => /AWS access key/.test(x.title));
  secretId = f.id;
  assert.equal(f.tier, 'proven');
  assert.equal(f.lang, 'Python');
  assert.equal(v.states[f.id], 'proven');
  assert.equal(v.order[0], f.id, 'most important first');
  assert.ok(!r.text.includes('QWERTYUIOP123456'), 'a secret is never sent to the page');
  assert.ok(r.text.includes('AKIA…(20 characters)'));
  // one commit, picked on its own: the case is everything after its parent
  const one = (await page.post('/api/open', { mode: 'span', from: repo.hashes[1], to: repo.hashes[1] })).json;
  assert.equal(one.case.commits.length, 1);
  assert.equal(one.case.base, repo.hashes[0]);
  // the first commit has no parent: the case starts at the beginning
  const root = (await page.post('/api/open', { mode: 'span', from: repo.hashes[0], to: repo.hashes[0] })).json;
  assert.equal(root.case.base, null);
  assert.equal((await page.post('/api/open', { mode: 'span', from: 'nope', to: repo.hashes[2] })).status, 400);
  assert.equal((await page.post('/api/open', { mode: 'span', from: '--output=x', to: repo.hashes[2] })).status, 400, 'a flag is not a commit');
  assert.equal((await page.post('/api/open', {})).status, 400);
  assert.equal((await page.get(`/api/case?id=${caseId}`)).json.case.id, caseId, 'a kept case opens again');
});

test('dismissing a finding changes the verdict, and Undo puts it back', async () => {
  const dismissed = (await page.post('/api/resolve', { case: caseId, finding: secretId, how: 'dismissed' })).json;
  assert.equal(dismissed.states[secretId], 'dismissed');
  assert.equal(dismissed.verdict.tone, 'clear');
  const back = (await page.post('/api/resolve', { case: caseId, finding: secretId, how: 'reopen' })).json;
  assert.equal(back.states[secretId], 'proven');
  assert.equal(back.verdict.tone, 'blocked');
  assert.equal((await page.post('/api/resolve', { case: caseId, finding: 'f-nothere', how: 'dismissed' })).status, 404);
  assert.equal((await page.post('/api/resolve', { case: caseId, finding: secretId, how: 'delete' })).status, 400);
});

test('the brief is what an agent would receive', async () => {
  const b = (await page.get(`/api/brief?case=${caseId}`)).json;
  assert.match(b.text, /MUST FIX/);
  assert.ok(b.words > 10 && b.tokens > b.words);
  assert.ok(!b.text.includes('QWERTYUIOP123456'));
});

test('a case id can only be a case of this project', async () => {
  assert.equal((await page.get('/api/case?id=../../etc/passwd')).status, 404);
  assert.equal((await page.get('/api/case')).status, 400);
  const other = makeRepo([{ files: { 'a.txt': 'a\n' }, message: 'One' }, { files: { 'a.txt': 'b\n' }, message: 'Two' }], 'other-project');
  const c = core.openCase({ repo: other.dir, range: `${other.hashes[0]}..${other.hashes[1]}` });
  assert.equal((await page.get(`/api/case?id=${c.id}`)).status, 404, 'a case of another repository is not shown here');
  assert.equal((await page.post('/api/resolve', { case: c.id, finding: 'f-x', how: 'dismissed' })).status, 404);
  const kept = (await page.get('/api/cases')).json as Array<{ id: string }>;
  assert.ok(kept.some(k => k.id === caseId));
  assert.ok(!kept.some(k => k.id === c.id));
});

test('a picture is served only if the case recorded it', async () => {
  const c = core.loadCase(caseId)!;
  const dir = core.assayPath('shots', c.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['p-index.base.jpg', 'p-index.head.jpg', 'p-index.diff.jpg', 'unlisted.jpg']) fs.writeFileSync(path.join(dir, n), `JPEG ${n}`);
  c.runs.push({ id: 'r-shots', kind: 'browser', at: new Date().toISOString(), secs: 1, command: 'chrome', summary: 'looked', findings: [], signals: [], shots: [{ page: '/', combo: 'desktop|light|native', changed: 0.01, box: null, base: 'p-index.base.jpg', head: 'p-index.head.jpg', diff: 'p-index.diff.jpg', marks: [{ kind: 'overlap', x: 1, y: 2, w: 3, h: 4, label: 'x' }] }] });
  core.saveCase(c);
  const ok = await page.get(`/api/shot?case=${caseId}&name=p-index.head.jpg`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/jpeg');
  assert.equal(ok.text, 'JPEG p-index.head.jpg');
  assert.equal((await page.get(`/api/shot?case=${caseId}&name=unlisted.jpg`)).status, 404, 'on disk but not recorded');
  for (const name of ['../x.jpg', '..%5Cx.jpg', 'p-index.head.png', '']) assert.equal((await page.get(`/api/shot?case=${caseId}&name=${name}`)).status, 404, name);
  assert.equal((await page.get('/api/shot?name=p-index.head.jpg')).status, 400);
  const view = (await page.get(`/api/case?id=${caseId}`)).json;
  assert.equal(view.case.runs[0].shots[0].marks[0].kind, 'overlap', 'the page gets the measured boxes');
  assert.deepEqual(view.case.runs[0].findingIds, []);
});

test('running the project’s code is refused until a person allows it, and the answer says how', async () => {
  for (const p of ['/api/prove', '/api/look']) {
    const r = await page.post(p, { case: caseId });
    assert.equal(r.status, 403, p);
    assert.equal(r.json.code, 'not-allowed');
    assert.match(r.json.command, /^assay allow-run --repo /);
    assert.match(r.json.error, /a person has to switch it on/i);
  }
  // nothing in the dashboard can switch it on
  const stillOff = (await page.get('/api/settings')).json;
  assert.equal(stillOff.settings.allow, false);
  for (const p of ['/api/allow', '/api/allow-run', '/api/settings']) assert.equal((await page.post(p, { allow: true })).status, 404, p);
  assert.equal(core.repoSettings(repo.dir).allow, undefined);
});

test('evidence from a free check can be replayed from the page, as a job', async () => {
  const v = (await page.get(`/api/case?id=${caseId}`)).json;
  const f = v.case.findings.find((x: { id: string }) => x.id === secretId);
  const j = await page.job('/api/replay', { case: caseId, evidence: f.evidence[0].id });
  assert.equal(j.state, 'done', JSON.stringify(j));
  assert.equal(j.result.reproduced, true);
  assert.match(j.result.detail, /came back/);
  assert.equal((await page.post('/api/replay', { case: caseId, evidence: 'f-nothere.1' })).status, 404);
  assert.equal((await page.get('/api/job?id=j-nothere')).status, 404);
});

test('settings say what Assay found, and never a secret', async () => {
  const s = (await page.get('/api/settings')).json;
  assert.equal(s.name, 'shop-website');
  assert.ok(s.doctor.some((r: { id: string; ok: boolean }) => r.id === 'git' && r.ok === true));
  assert.match(s.allowCommand, /^assay allow-run --repo "/);
  assert.equal(s.home, home);
  for (const p of ['/api/state', '/api/timeline', '/api/cases', '/api/settings', `/api/case?id=${caseId}`]) assert.ok(!(await page.get(p)).text.includes('QWERTYUIOP123456'), p);
});

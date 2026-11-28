import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* D65: gremlins. A made-up app with one bug of each kind, and a fixed one to compare with. The apps only ever listen on 127.0.0.1;
   the page tries to call a payment service on another host, and the browser must refuse it. */
tempHome();
const core = await import('../index.js');
const browser = core.findBrowser();
const skip = browser ? false : 'no Chromium-based browser on this computer';

interface Counts { wipes: number; saves: number }

/** The app's request handler as a function with no closure, so the same source runs in this process and, as text, in a project's server.js. */
function makeHandler(buggy: boolean, counts: Counts): http.RequestListener {
  return (q, r) => {
    const url = new URL(q.url ?? '/', 'http://x');
    const send = (status: number, type: string, body: string): void => { r.writeHead(status, { 'content-type': type }); r.end(body); };
    if (q.method === 'POST' && url.pathname === '/api/wipe') { counts.wipes++; return send(200, 'application/json', '{}'); }
    if (url.pathname === '/api/items') return buggy ? send(500, 'application/json', '{"error":"boom"}') : send(200, 'application/json', '{"n":3}');
    if (url.pathname === '/private') {
      const signed = /(^|; )sid=good(;|$)/.test(q.headers.cookie ?? '') || q.headers.authorization === 'Bearer tok-4711';
      return send(200, 'text/html', signed
        ? '<!doctype html><html lang="en"><body><h1>Your orders</h1><button id="go" onclick="console.error(\'cookie \' + document.cookie); throw new Error(\'private boom\')">Go</button></body></html>'
        : '<!doctype html><html lang="en"><body><h1>Sign in</h1><p>You are not signed in.</p></body></html>');
    }
    if (url.pathname === '/about') return send(200, 'text/html', '<!doctype html><html lang="en"><body><h1>About</h1><a href="/">Home</a></body></html>');
    const guard = buggy ? "if (!v.trim()) throw new Error('empty note');" : '';
    send(200, 'text/html', `<!doctype html><html lang="en"><body>
<h1>Notes</h1><a href="/about">About</a> <a href="https://example.com/elsewhere">Elsewhere</a>
<form id="f"><input name="note" id="note" placeholder="A note"><button type="submit">Save</button></form>
<button id="load">Load</button> <button id="pay">Pay</button> <button id="wipe">Delete everything</button>
<p id="out"></p>
<script>
document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); var v = document.getElementById('note').value; ${guard} document.getElementById('out').textContent = v.trim() ? 'saved ' + v.length : 'nothing to save'; });
document.getElementById('load').onclick = function () { fetch('/api/items').then(function (r) { return r.json(); }).then(function (j) { document.getElementById('out').textContent = 'items ' + j.n; }); };
document.getElementById('pay').onclick = function () { fetch('https://pay.example.test/charge', { method: 'POST' }).catch(function (err) { console.error('payment failed', err.message); }); };
document.getElementById('wipe').onclick = function () { fetch('/api/wipe', { method: 'POST' }); };
</script></body></html>`);
  };
}

const badCounts: Counts = { wipes: 0, saves: 0 };
const goodCounts: Counts = { wipes: 0, saves: 0 };
let bad: http.Server, good: http.Server, flip: http.Server;
let badUrl = '', goodUrl = '', flipUrl = '';
let flipBuggy = true;
const listen = (s: http.Server): Promise<number> => new Promise(res => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
before(async () => {
  bad = http.createServer(makeHandler(true, badCounts));
  good = http.createServer(makeHandler(false, goodCounts));
  const badHandler = makeHandler(true, badCounts), goodHandler = makeHandler(false, goodCounts);
  flip = http.createServer((q, r) => (flipBuggy ? badHandler : goodHandler)(q, r));
  flipUrl = `http://127.0.0.1:${await listen(flip)}`;
  badUrl = `http://127.0.0.1:${await listen(bad)}`;
  goodUrl = `http://127.0.0.1:${await listen(good)}`;
});
after(() => { bad.close(); good.close(); flip.close(); });

function project(name: string, o: { allow?: boolean; writes?: boolean } = { allow: true, writes: true }): string {
  const repo = makeRepo(name);
  repo.commit({ 'README.md': '# app\n' }, 'Start');
  core.setRepoSettings(repo.dir, { ...(o.allow === false ? {} : { allow: true }), ...(o.writes ? { writes: true } : {}) });
  return repo.dir;
}

/** A project whose own server.js is the app, started by Assay from a clean copy of each commit. */
function served(name: string, versions: boolean[]): { dir: string; commits: string[] } {
  const repo = makeRepo(name);
  const commits: string[] = [];
  for (const [i, buggy] of versions.entries()) {
    const js = `// version ${i}
const http = require('http');\nconst counts = { wipes: 0, saves: 0 };\nconst handler = (${makeHandler.toString()})(${buggy}, counts);\nhttp.createServer(handler).listen(Number(process.env.PORT), '127.0.0.1');\n`;
    commits.push(repo.commit({ 'server.js': js }, buggy ? 'Reject nothing' : 'Handle the empty note'));
  }
  core.setRepoSettings(repo.dir, { allow: true, writes: true, serve: 'node server.js' });
  return { dir: repo.dir, commits };
}

test('seeded: the same seed gives the same numbers, another gives others; a step reads as a sentence', () => {
  const a = core.seeded(42), b = core.seeded(42), c = core.seeded(43);
  const xs = Array.from({ length: 20 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 20 }, () => b()));
  assert.notDeepEqual(xs, Array.from({ length: 20 }, () => c()));
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.equal(core.describeStep({ click: 'text=Save' }), 'click “Save”');
  assert.equal(core.describeStep({ click: '#go', double: true }), 'double-click #go');
  assert.equal(core.describeStep({ type: 'x'.repeat(50), into: '#note' }), `type "${'x'.repeat(30)}…" into #note`);
  assert.equal(core.describeStep({ press: 'Enter' }), 'press Enter');
  assert.ok(core.JUNK.length >= 15 && core.JUNK.some(j => j.includes('<script>')) && core.JUNK.some(j => j.includes('DROP TABLE')));
});

test('running is refused until allowed, then until its own yes; one origin or two commits, and only this computer', async () => {
  const repo = makeRepo('guarded');
  repo.commit({ 'README.md': '# app\n' }, 'Start');
  await assert.rejects(core.runGremlins({ repo: repo.dir, url: badUrl }), /assay allow-run/);
  core.setRepoSettings(repo.dir, { allow: true });
  await assert.rejects(core.runGremlins({ repo: repo.dir, url: badUrl }), /assay allow-run --writes/, 'clicking and typing can change data');
  core.setRepoSettings(repo.dir, { writes: true });
  await assert.rejects(core.runGremlins({ repo: repo.dir, url: badUrl, base: 'HEAD' }), /one or the other/);
  for (const url of ['http://example.com', 'http://192.168.1.5:3000', 'http://user:pw@localhost:3000', 'ftp://localhost']) await assert.rejects(core.runGremlins({ repo: repo.dir, url }), /computer|address|user name/, url);
  await assert.rejects(core.runGremlins({ repo: repo.dir, url: badUrl, page: '//evil.example/x' }), /page path/);
  core.setRepoSettings(repo.dir, { writes: false });
  await assert.rejects(core.runGremlins({ repo: repo.dir, url: badUrl }), /assay allow-run --writes/, 'turned off again');
});

test('gremlins on a running app: the bugs are found with the steps that led to them, the payment service is never reached, destructive controls are left alone', { skip, timeout: 180_000 }, async () => {
  const dir = project('shop-website');
  const r = await core.runGremlins({ repo: dir, url: badUrl, actions: 40, seed: 7 });
  assert.deepEqual([r.schema, r.mode, r.url, r.seed, r.planned], ['assay.gremlins/1', 'running', badUrl, 7, 40]);
  assert.ok(r.actions >= 20, `it did ${r.actions} actions`);
  const kinds = new Set(r.findings.map(f => f.kind));
  assert.ok(kinds.has('exception'), JSON.stringify(r.findings.map(f => [f.kind, f.text])));
  assert.ok(kinds.has('server'), 'the items call answers 500');
  const ex = r.findings.find(f => f.kind === 'exception')!;
  assert.match(ex.text, /empty note/);
  assert.deepEqual([ex.severity, ex.tier], ['high', 'proven']);
  assert.ok(ex.steps.length > 0 && ex.steps.length <= 15 && ex.step >= ex.steps.length);
  assert.ok(ex.steps.some(s => s.click === 'text=Save' || s.press === 'Enter'), `it was a submit: ${ex.steps.map(core.describeStep).join(' → ')}`);
  assert.match(r.findings.find(f => f.kind === 'server')!.text, /GET \/api\/items → 500/);
  assert.equal(r.findings[0].severity, 'high', 'serious first');
  assert.equal(core.gremlinsFail(r, 'high'), true);
  assert.deepEqual(r.blocked, ['pay.example.test'], 'the browser refused to talk to another host, and said so');
  assert.ok(!r.findings.some(f => /pay\.example|payment failed|Failed to fetch/.test(f.text)), 'a request the browser refused is not the app’s fault');
  assert.ok(r.skipped.includes('Delete everything') && badCounts.wipes === 0, 'a control that looks destructive was left alone and never clicked');
  assert.ok(r.pages.every(p => p.startsWith(badUrl)), 'it never left the app');
  assert.match(r.replay, new RegExp(`assay gremlins --url ${badUrl.replace(/[.:/]/g, '\\$&')} --seed 7 --actions 40`));
  assert.ok(!JSON.stringify(r).includes(dir), 'no path of the project in the report');
});

test('the same seed does the same things, and a fixed app has nothing serious', { skip, timeout: 240_000 }, async () => {
  const dir = project('shop-fixed');
  const a = await core.runGremlins({ repo: dir, url: goodUrl, actions: 30, seed: 11 });
  const b = await core.runGremlins({ repo: dir, url: goodUrl, actions: 30, seed: 11 });
  assert.deepEqual(a.findings.filter(f => f.severity !== 'low').map(f => f.title), [], JSON.stringify(a.findings));
  assert.equal(core.gremlinsFail(a, 'high'), false);
  assert.deepEqual([a.actions, a.pages], [b.actions, b.pages], 'the same seed went through the same pages');
  assert.deepEqual(a.findings.map(f => f.id), b.findings.map(f => f.id));
  assert.ok(a.blocked.every(h => h === 'pay.example.test'), 'only the payment service was ever refused');
  // the destructive control is clicked only when asked for
  const bold = await core.runGremlins({ repo: dir, url: goodUrl, actions: 60, seed: 3, bold: true });
  assert.equal(bold.bold, true);
  assert.deepEqual(bold.skipped, []);
});

test('on a range: the app is started from a clean copy of each commit, the same seed runs at both, and only what is new is reported', { skip, timeout: 300_000 }, async () => {
  const { dir, commits } = served('shop-range', [false, true]);
  const r = await core.runGremlins({ repo: dir, ref: commits[1], base: commits[0], actions: 30, seed: 7 });
  assert.deepEqual([r.mode, r.url, r.commit, r.base], ['copy', undefined, commits[1], commits[0]]);
  assert.ok(r.findings.some(f => f.kind === 'exception' && /empty note/.test(f.text)), JSON.stringify(r.findings.map(f => [f.kind, f.text])));
  assert.equal(r.before, 0, 'the base had none of it');
  assert.match(r.replay, new RegExp(`--ref ${commits[1].slice(0, 7)} --base ${commits[0].slice(0, 7)} --seed 7 --actions 30`));
  // the recorded steps, done again in a clean copy of the same commit, bring the problem back
  const again = await core.replayGremlins({ repo: dir, run: r.id, finding: r.findings.find(f => f.kind === 'exception')!.id });
  assert.equal(again.reproduced, true, JSON.stringify(again));
  assert.match(again.where, /a clean copy of/);
  // what the base already did is not new
  const same = served('shop-same', [true, true]);
  const old = await core.runGremlins({ repo: same.dir, ref: same.commits[1], base: same.commits[0], actions: 30, seed: 7 });
  assert.ok(old.before >= 1, 'met at the base too');
  assert.deepEqual(old.findings.filter(f => f.kind === 'exception'), []);
  assert.ok(old.notes.some(n => /met there too/.test(n)));
  // a fixed head has nothing the base didn't
  const fixed = served('shop-fixes', [true, false]);
  const clean = await core.runGremlins({ repo: fixed.dir, ref: fixed.commits[1], base: fixed.commits[0], actions: 30, seed: 7 });
  assert.deepEqual(clean.findings.filter(f => f.severity !== 'low'), []);
  assert.equal(fixed.commits.length, 2);
});

test('signed in: a session from the environment opens what is behind the login, goes only to the app, and is in no report', { skip, timeout: 240_000 }, async () => {
  const dir = project('shop-private');
  const out = await core.runGremlins({ repo: dir, url: badUrl, page: '/private', actions: 6, seed: 2, save: false });
  assert.equal(out.signedIn, false);
  assert.deepEqual(out.findings.filter(f => /private boom/.test(f.text)), [], 'signed out, the page is only a login');
  for (const session of [{ cookie: 'sid=good' }, { authorization: 'Bearer tok-4711' }]) {
    const r = await core.runGremlins({ repo: dir, url: badUrl, page: '/private', actions: 6, seed: 2, session, save: false });
    assert.equal(r.signedIn, true);
    const f = r.findings.find(x => /private boom/.test(x.text));
    assert.ok(f, JSON.stringify(r.findings.map(x => x.text)));
    const json = JSON.stringify(r);
    assert.ok(!json.includes('tok-4711') && !/sid=good/.test(json), 'the session is in no report');
    if (session.cookie) assert.ok(r.findings.some(x => x.kind === 'console' && /cookie \[session\]/.test(x.text)), 'a page that echoes the session shows it as [session]');
  }
  // a clean copy of a commit has nobody's session in it: it is not sent there, and the report says so
  const { dir: copy, commits } = served('shop-private-copy', [true]);
  const c = await core.runGremlins({ repo: copy, ref: commits[0], actions: 5, seed: 1, session: { cookie: 'sid=good' }, save: false });
  assert.equal(c.signedIn, false);
  assert.ok(c.notes.some(n => /only used with --url/.test(n)));
  assert.deepEqual(core.sessionValues({ cookie: 'sid=abcd1234; theme=dark', authorization: 'Bearer longtoken99' }).sort(), ['Bearer longtoken99', 'abcd1234', 'dark', 'longtoken99', 'sid=abcd1234; theme=dark'].sort());
  assert.equal(core.sessionFromEnv({ ASSAY_ATTACK_COOKIE: 'a=1234' } as NodeJS.ProcessEnv)?.cookie, 'a=1234', 'the older names work');
  assert.equal(core.sessionFromEnv({ ASSAY_SESSION_COOKIE: 'new=1234', ASSAY_ATTACK_COOKIE: 'old=1234' } as NodeJS.ProcessEnv)?.cookie, 'new=1234');
  assert.equal(core.sessionFromEnv({} as NodeJS.ProcessEnv), undefined);
});

test('runs are kept and compared with the last one of the same app: new, already there and gone', { skip, timeout: 300_000 }, async () => {
  const dir = project('shop-history');
  flipBuggy = true;
  const one = await core.runGremlins({ repo: dir, url: flipUrl, actions: 30, seed: 7 });
  assert.ok(one.findings.length > 0 && one.findings.every(f => f.since === 'first'));
  assert.deepEqual([one.previous, one.gone], [null, []]);
  assert.match(one.id, /^gr-\d{14}-[0-9a-f]{6}$/);
  const two = await core.runGremlins({ repo: dir, url: flipUrl, actions: 30, seed: 7 });
  assert.equal(two.previous?.id, one.id);
  assert.ok(two.findings.length > 0 && two.findings.every(f => f.since === 'before'), JSON.stringify(two.findings.map(f => [f.title, f.since])));
  assert.equal(two.gone.length, 0);
  // the bug is fixed: nothing is found, and the old problems are listed as gone
  flipBuggy = false;
  const three = await core.runGremlins({ repo: dir, url: flipUrl, actions: 30, seed: 7 });
  assert.deepEqual(three.findings.filter(f => f.severity !== 'low'), []);
  assert.ok(three.gone.some(g => g.kind === 'exception'), JSON.stringify(three.gone));
  assert.equal(three.previous?.id, two.id);
  // and back: new again, against the run that had none
  flipBuggy = true;
  const four = await core.runGremlins({ repo: dir, url: flipUrl, actions: 30, seed: 7, save: false });
  assert.ok(four.findings.some(f => f.since === 'new' && f.kind === 'exception'));
  const kept = core.listGremlinRuns(dir);
  assert.deepEqual(kept.map(r => r.id), [three.id, two.id, one.id], 'newest first, and a run made with save: false is not kept');
  assert.equal(core.loadGremlinRun(dir, one.id)?.id, one.id);
  assert.equal(core.loadGremlinRun(dir, one.id.slice(0, -1))?.id, one.id, 'the start of an id is enough when it is only one');
  assert.equal(core.loadGremlinRun(dir, one.id.slice(0, 10)), null, 'and not when it fits several');
  assert.equal(core.loadGremlinRun(dir, 'gr-nothing'), null);
  assert.equal(core.loadGremlinRun(dir, 'gr'), null);
  // another app is not compared with this one
  const other = await core.runGremlins({ repo: dir, url: goodUrl, actions: 5, seed: 1 });
  assert.equal(other.previous, null);
});

test('replay does the recorded steps again, exactly and in order, and says whether the problem came back', { skip, timeout: 300_000 }, async () => {
  const dir = project('shop-replay');
  const r = await core.runGremlins({ repo: dir, url: badUrl, actions: 40, seed: 7 });
  assert.ok(r.trail.length >= r.actions && r.start === '/');
  const ex = r.findings.find(f => f.kind === 'exception')!;
  assert.deepEqual(r.trail.slice(0, ex.step).slice(-ex.steps.length), ex.steps, 'the steps of a finding are the end of the trail up to it');
  const before = core.listGremlinRuns(dir).length;
  const again = await core.replayGremlins({ repo: dir, run: r.id.slice(0, 14), finding: ex.id });
  assert.equal(again.reproduced, true, JSON.stringify(again));
  assert.equal(again.finding.id, ex.id);
  assert.ok(again.done >= 1 && again.done <= ex.step);
  assert.equal(core.listGremlinRuns(dir).length, before, 'a replay is not a run: nothing is kept');
  // the first problem when none is named; and another app that no longer has the bug
  const first = await core.replayGremlins({ repo: dir, run: r.id });
  assert.equal(first.finding.id, r.findings[0].id);
  const fixed = await core.replayGremlins({ repo: dir, run: r.id, finding: ex.id, url: goodUrl });
  assert.equal(fixed.reproduced, false);
  assert.match(fixed.where, /127\.0\.0\.1/);
  // refusals
  await assert.rejects(core.replayGremlins({ repo: dir, run: 'gr-20000101000000-abcdef' }), /no kept run/);
  await assert.rejects(core.replayGremlins({ repo: dir, run: r.id, finding: 'g-nope' }), /no problem/);
  await assert.rejects(core.replayGremlins({ repo: dir, run: r.id, url: 'http://example.com' }), /computer/);
  core.setRepoSettings(dir, { writes: false });
  await assert.rejects(core.replayGremlins({ repo: dir, run: r.id }), /assay allow-run --writes/);
});

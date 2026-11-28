import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* D62: what moved into look from a sister tool's per-commit page checks: four accessibility rules, the page's speed, and what changed underneath (its calls, warnings and title). */
tempHome();
const core = await import('../index.js');
const { slowerThan, heavierThan, callsOf, compareCalls, medianPerf, foldPath } = await import('../browser/health.js');
const browser = core.findBrowser();
const t = browser ? test : test.skip;

test('slower only when the middle moved clearly and every head load was slower than every base load', () => {
  const base = [{ lcpMs: 400, loadMs: 300 }, { lcpMs: 420, loadMs: 310 }, { lcpMs: 900, loadMs: 320 }];
  assert.match(slowerThan([{ lcpMs: 1000 }, { lcpMs: 1100 }, { lcpMs: 1200 }], base) ?? '', /largest paint 420 ms → 1\.1 s/);
  assert.equal(slowerThan([{ lcpMs: 850 }, { lcpMs: 1100 }, { lcpMs: 1200 }], base), undefined, 'one slow base load overlaps a head load: noise, not proof');
  assert.equal(slowerThan([{ lcpMs: 600 }, { lcpMs: 610 }, { lcpMs: 620 }], [{ lcpMs: 400 }, { lcpMs: 410 }, { lcpMs: 420 }]), undefined, 'under 300 ms is not clear');
  assert.equal(slowerThan([{ lcpMs: 2000 }], base), undefined, 'one load is not enough');
  assert.match(slowerThan([{ tbtMs: 400 }, { tbtMs: 420 }], [{ tbtMs: 0 }, { tbtMs: 10 }]) ?? '', /main thread blocked 5 ms → 410 ms/);
  assert.match(heavierThan({ jsBytes: 100 * 1024 }, { jsBytes: 60 * 1024 }) ?? '', /JavaScript 60 KB → 100 KB/);
  assert.equal(heavierThan({ jsBytes: 70 * 1024 }, { jsBytes: 60 * 1024 }), undefined, 'under 20 KB more');
  assert.deepEqual(medianPerf([{ lcpMs: 3 }, { lcpMs: 1 }, { lcpMs: 2 }])?.lcpMs, 2);
});

test('calls are data calls by method and folded path, never a query value, and compared by what got worse', () => {
  const origin = 'http://127.0.0.1:5000';
  const req = (method: string, url: string, type: string, status: number | null, error?: string) => ({ method, url, type, status, error });
  const calls = callsOf([
    req('GET', `${origin}/`, 'Document', 200), req('GET', `${origin}/app.js`, 'Script', 200), req('GET', `${origin}/@vite/client`, 'Fetch', 200),
    req('GET', `${origin}/api/orders/42?token=abc`, 'Fetch', 200), req('GET', `${origin}/api/orders/43`, 'Fetch', 200),
    req('POST', `${origin}/api/cart`, 'XHR', 500), req('GET', 'https://api.example.com/v1/rates', 'Fetch', null, 'net::ERR_FAILED')
  ], origin);
  assert.deepEqual(calls, [
    { key: 'GET /api/orders/{id}', count: 2, statuses: ['200'] },
    { key: 'GET api.example.com/v1/rates', count: 1, statuses: ['failed'] },
    { key: 'POST /api/cart', count: 1, statuses: ['500'] }
  ]);
  assert.ok(!JSON.stringify(calls).includes('token'), 'no query value is kept');
  assert.equal(foldPath('/users/6f1c2a9b3d/items/7'), '/users/{id}/items/{id}');
  const changes = compareCalls(
    { calls: [{ key: 'GET /api/cart', count: 1, statuses: ['200'] }, { key: 'GET /api/old', count: 1, statuses: ['200'] }], warnings: ['React: key 12 missing'], title: 'Shop' },
    { calls: [{ key: 'GET /api/cart', count: 3, statuses: ['500'] }, { key: 'GET /api/new', count: 1, statuses: ['200'] }], warnings: ['React: key 99 missing', 'deprecated'], title: 'Shop' }
  );
  assert.deepEqual(changes.map(c => [c.kind, c.tone]), [['call-count', 'worse'], ['status', 'worse'], ['warning-new', 'worse'], ['call-added', 'change'], ['call-removed', 'change']]);
  assert.match(changes[0].text, /GET \/api\/cart is called 3 times, was 1/);
  assert.ok(!changes.some(c => /key 99/.test(c.text)), 'a warning that differs only in its numbers is the same warning');
});

const BASE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title><script src="app.js"></script></head>
<body><main><h1>Cart</h1>
<h2 class="items-heading">Items</h2>
<label for="email">Email</label><input id="email" class="email-field">
<button class="pay">Pay</button></main>
<script>fetch('/data.json');</script>
</body></html>
`;
const HEAD = BASE
  .replace('<html lang="en">', '<html>')
  .replace('<h2 class="items-heading">Items</h2>', '<h4 class="items-heading">Items</h4>')
  .replace('<button class="pay">', '<button class="pay" tabindex="2">')
  .replace('<input id="email" class="email-field">', '<input id="email" class="email-field"><span id="email" class="hint">We never share it</span>')
  .replace("<script>fetch('/data.json');</script>", "<script>fetch('/data.json');fetch('/data.json');console.warn('cart v1 is deprecated');</script>");
const APP_BASE = 'window.app = 1;\n';
// Blocks the page for 400 ms while it loads, and carries 40 KB more script.
const APP_HEAD = `var started = Date.now();\nwhile (Date.now() - started < 400) {}\nwindow.app = 2;\n/* ${'x'.repeat(40 * 1024)} */\n`;

t('look finds the language, heading, keyboard-order and duplicate-id problems, a slower and heavier page, a call made twice and a new warning, each anchored and replayable', async () => {
  const repo = makeRepo('shop-website');
  const base = repo.commit({ 'index.html': BASE, 'app.js': APP_BASE, 'data.json': '{}\n' }, 'Base');
  const head = repo.commit({ 'index.html': HEAD, 'app.js': APP_HEAD }, 'Rework the cart');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false, screens: false });
  assert.equal(report.ran, true, report.reason);
  const found = (re: RegExp) => c.findings.find(f => f.origin === 'run' && re.test(f.title));
  const titles = c.findings.map(f => f.title).join(' | ');

  for (const [re, ref] of [[/has no language/, 'WCAG 3.1.1'], [/Heading levels skip/, 'WCAG 1.3.1'], [/positive tabindex/, 'WCAG 2.4.3'], [/id is used more than once/, 'Measured']] as const) {
    const f = found(re);
    assert.ok(f, `${re} in: ${titles}`);
    assert.deepEqual([f!.tier, f!.severity, f!.lens, f!.ref, f!.file], ['proven', 'low', 'UI', ref, 'index.html']);
  }
  assert.ok(found(/Heading levels skip/)!.snippet.rows.some(r => r.sig && /items-heading/.test(r.text)), 'anchored on the heading it is about');
  assert.ok(found(/id is used more than once/)!.snippet.rows.some(r => r.sig && /email/.test(r.text)));

  const calls = found(/calls the same thing more often/)!;
  assert.ok(calls, titles);
  assert.deepEqual([calls.tier, calls.severity, calls.lens, calls.evidence[0].kind], ['proven', 'low', 'Performance', 'behaviour-diff']);
  assert.match(calls.evidence[0].what, /GET \/data\.json is called 2 times, was 1/);
  assert.ok(calls.snippet.rows.some(r => r.sig && /data\.json/.test(r.text)), 'anchored on the line that makes the call');

  const warn = found(/logs a new warning/)!;
  assert.ok(warn, titles);
  assert.match(warn.evidence[0].what, /cart v1 is deprecated/);

  const slow = found(/loads clearly slower/)!;
  assert.ok(slow, `${titles} :: ${JSON.stringify(report.speed)}`);
  assert.deepEqual([slow.severity, slow.lens, slow.file], ['medium', 'Performance', 'app.js']);
  assert.match(slow.evidence[0].what, /every load at the head slower than every load at the base/);
  const heavy = found(/loads clearly more script/)!;
  assert.ok(heavy, JSON.stringify(report.speed));
  assert.match(heavy.evidence[0].what, /JavaScript \d+ KB → \d+ KB/);

  assert.equal(report.speed?.length, 1);
  assert.ok(report.speed![0].slower && report.speed![0].heavier);
  assert.ok((report.speed![0].head.lcpMs ?? report.speed![0].head.loadMs ?? 0) > (report.speed![0].base.lcpMs ?? report.speed![0].base.loadMs ?? 0));
  const under = report.calls?.[0].changes.map(x => x.text) ?? [];
  assert.ok(under.some(x => /is called 2 times, was 1/.test(x)) && under.some(x => /new console warning/.test(x)), under.join(' | '));
  assert.equal(core.verdictOf(c).tone, 'mergeable', 'none of these blocks');

  // A comparison replays as a comparison: both ends opened again.
  const again = await core.replayEvidence(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), calls.evidence[0].id);
  assert.equal(again.reproduced, true, again.detail);
  assert.match(again.detail, /called 2 times, was 1/);
});

t('speed can be left out, and then nothing about speed is reported', async () => {
  const repo = makeRepo('shop-quick');
  const base = repo.commit({ 'index.html': BASE, 'app.js': APP_BASE, 'data.json': '{}\n' }, 'Base');
  const head = repo.commit({ 'app.js': APP_HEAD }, 'Heavier app');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false, screens: false, speed: false });
  assert.equal(report.ran, true, report.reason);
  assert.equal(report.speed, undefined);
  assert.ok(!c.findings.some(f => /slower|more script/.test(f.title)));
});

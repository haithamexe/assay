import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* Real pages in a real browser (whichever Chromium-based one is installed). Skipped, loudly, where there is none. */
tempHome();
const core = await import('../index.js');
const browser = core.findBrowser();
const t = browser ? test : test.skip;

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title><link rel="stylesheet" href="style.css"></head>
<body><main><h1>Order summary</h1>
<div class="item"><img class="thumb" alt="" src="${GIF}"><div class="title">Canvas tote bag</div><span class="price-badge">$24.00</span></div>
<p class="muted">Free shipping</p>
<button class="place-order">Confirm order and complete payment</button></main></body></html>
`;
const CSS_BASE = `body{font:16px system-ui;margin:16px;color:#111;background:#fff}
.item{position:relative;display:flex;gap:12px;padding:12px;border:1px solid #ccc;align-items:center}
.thumb{width:48px;height:48px;flex:none}
.title{flex:1;margin-inline-end:90px}
.price-badge{position:absolute;top:12px;inset-inline-end:12px;padding:2px 8px;background:#eef}
.muted{color:#555}
.place-order{min-width:148px;padding:0 12px;min-height:44px;font:600 14px system-ui}
`;
const CSS_BROKEN = CSS_BASE
  .replace('inset-inline-end:12px', 'right:12px')
  .replace('.muted{color:#555}', '.muted{color:#ddd}')
  .replace('.place-order{min-width:148px;', '.place-order{width:148px;overflow:hidden;white-space:nowrap;');

const SEARCH_SAFE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search</title></head><body><form><label>Find <input name="q"></label></form><div id="out"></div>
<script>var q=new URLSearchParams(location.search).get('q')||'';document.getElementById('out').textContent=q;</script></body></html>
`;
const SEARCH_UNSAFE = SEARCH_SAFE.replace("textContent=q", "innerHTML=q");

t('layout problems that appear only at the head are measured in a real browser, and found where the change was made', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'index.html': INDEX, 'style.css': CSS_BASE }, 'Base');
  const head = repo.commit({ 'style.css': CSS_BROKEN }, 'Restyle the summary');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false });
  assert.equal(report.ran, true, report.reason);
  assert.equal(report.mode, 'static');
  assert.deepEqual(report.pages, ['/']);
  assert.equal(report.combos, 12, 'two sizes, two colour schemes, and as loaded, mirrored and with Arabic text');

  const found = (re: RegExp) => c.findings.find(f => f.origin === 'run' && f.check === 'browser' && re.test(f.title));
  const overlap = found(/Things overlap/)!;
  assert.ok(overlap, c.findings.map(f => f.title).join(' | '));
  assert.match(overlap.title, /when mirrored/, 'it only happens when the layout is mirrored');
  assert.equal(overlap.tier, 'proven');
  assert.equal(overlap.lens, 'UI');
  assert.equal(overlap.file, 'style.css');
  assert.ok(overlap.snippet.rows.some(r => r.sig && /right:12px/.test(r.text)), 'anchored on the line that made it');
  assert.ok(overlap.evidence.every(e => e.kind === 'measurement' && e.replay?.run?.kind === 'look'));
  assert.match(overlap.evidence[0].what, /Not there at/);

  const clip = found(/Text is cut off/)!;
  assert.ok(clip, 'the button text is cut off');
  assert.doesNotMatch(clip.title, /mirrored/, 'cut off in every direction');
  const contrast = found(/Text is hard to read/)!;
  assert.ok(contrast);
  assert.equal(contrast.ref, 'WCAG 1.4.3');
  assert.ok(contrast.observed.some(o => /Free shipping/.test(o)));

  // nothing was wrong at the base, so every one of these is new; none of them blocks (medium)
  assert.equal(c.findings.filter(f => f.check === 'browser').length, 3);
  assert.notEqual(core.verdictOf(c).tone, 'blocked');
  assert.ok(core.verdictOf(c).should.length >= 3);

  // before and after, with the share of pixels that changed
  const rec = c.runs.find(r => r.kind === 'browser')!;
  assert.equal(rec.shots?.length, 4, 'as loaded on desktop and phone, mirrored on desktop, and with Arabic text on desktop');
  const mirrored = rec.shots!.find(s => s.combo.endsWith('|rtl'))!;
  assert.ok(mirrored.changed >= 0.0001, `the mirrored page looks different: ${mirrored.changed}`);

  // the boxes: what was measured in that very picture, as it was laid out, and nothing that isn't a finding
  const boxes = mirrored.marks ?? [];
  const over = boxes.filter(m => m.kind === 'overlap');
  assert.ok(over.length >= 1, `the overlap is marked on the mirrored picture: ${JSON.stringify(boxes)}`);
  for (const m of boxes) {
    assert.ok(m.w > 0 && m.h > 0 && m.x >= 0 && m.y >= 0 && m.x + m.w <= 1280 + 1 && m.y + m.h <= 800 + 1, `inside the 1280 x 800 picture: ${JSON.stringify(m)}`);
    assert.ok(found(new RegExp(m.kind === 'overlap' ? 'overlap' : m.kind === 'clip' ? 'cut off' : 'hard to read'))!, `${m.kind} is a finding of its own`);
  }
  const native = rec.shots!.find(s => s.combo === 'desktop|light|native')!;
  assert.ok(!(native.marks ?? []).some(m => m.kind === 'overlap'), 'the overlap is not there when the page is as loaded');

  // and it replays: open the page again at both ends
  const r = await core.replayEvidence(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), overlap.evidence[0].id);
  assert.equal(r.reproduced, true, r.detail);
});

t('an uncaught error on a page is high severity and blocks, and a page that is the same as before has nothing to report', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'index.html': INDEX, 'style.css': CSS_BASE }, 'Base');
  const head = repo.commit({ 'index.html': INDEX.replace('</body>', "<script>throw new Error('boom from the head');</script></body>") }, 'Add a script');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  await core.lookCase(c, { probe: false, screens: false });
  const ex = c.findings.find(f => f.check === 'browser' && /uncaught error/.test(f.title))!;
  assert.ok(ex);
  assert.equal(ex.severity, 'high');
  assert.equal(ex.tier, 'proven');
  assert.ok(ex.observed.some(o => /boom from the head/.test(o)));
  assert.equal(core.verdictOf(c).tone, 'blocked');

  const quiet = makeRepo();
  const b2 = quiet.commit({ 'index.html': INDEX, 'style.css': CSS_BASE, 'README.md': '# a\n' }, 'Base');
  const h2 = quiet.commit({ 'README.md': '# b\n' }, 'Docs only');
  core.setRepoSettings(quiet.dir, { allow: true });
  const c2 = core.openCase({ repo: quiet.dir, range: `${b2}..${h2}` });
  const r2 = await core.lookCase(c2, { probe: false });
  assert.equal(r2.newProblems, 0);
  assert.equal(c2.findings.filter(f => f.check === 'browser').length, 0);
});

t('the probe proves that text typed into the page, or put in its address, becomes markup: only at the head', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'search.html': SEARCH_SAFE }, 'Base');
  const head = repo.commit({ 'search.html': SEARCH_UNSAFE }, 'Show the query live');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { screens: false });
  assert.deepEqual(report.pages, ['/search.html']);
  assert.equal(report.probeHits, 1);
  const f = c.findings.find(x => x.check === 'browser' && /becomes markup/.test(x.title))!;
  assert.ok(f);
  assert.equal(f.lens, 'Security');
  assert.equal(f.severity, 'high');
  assert.equal(f.ref, 'CWE-79');
  assert.equal(f.tier, 'proven');
  assert.equal(f.evidence[0].kind, 'probe');
  assert.ok(f.snippet.rows.some(r => r.sig && /innerHTML/.test(r.text)), 'anchored on the sink');
  assert.equal(core.verdictOf(c).tone, 'blocked');
  assert.ok(!JSON.stringify(c).includes('QWERTY'), 'nothing odd leaks');
});

t('the project’s own dev server can be used instead of plain files', async () => {
  const repo = makeRepo();
  const server = `import http from 'node:http';
import fs from 'node:fs';
http.createServer((q, r) => {
  const p = q.url.split('?')[0];
  const f = p === '/' ? 'index.html' : p.slice(1);
  try { const body = fs.readFileSync(f); r.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/html' }); r.end(body); }
  catch { r.writeHead(404); r.end('nope'); }
}).listen(process.env.PORT, '127.0.0.1', () => console.log('ready at http://127.0.0.1:' + process.env.PORT));
`;
  const base = repo.commit({ 'package.json': '{"type":"module"}\n', 'server.js': server, 'index.html': INDEX, 'style.css': CSS_BASE }, 'Base');
  const head = repo.commit({ 'style.css': CSS_BROKEN }, 'Restyle');
  core.setRepoSettings(repo.dir, { allow: true, serve: 'node server.js', pages: ['/'] });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false, screens: false });
  assert.equal(report.ran, true, report.reason);
  assert.equal(report.mode, 'dev');
  assert.ok(c.findings.some(f => f.check === 'browser' && /Things overlap/.test(f.title)));
  // the server was stopped and the checkouts removed
  assert.equal(repo.git('status', '--porcelain').trim(), '');
});

t('pages given from outside are paths on the local server and nothing else', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'index.html': INDEX, 'style.css': CSS_BASE }, 'Base');
  const head = repo.commit({ 'style.css': CSS_BASE + '/* c */\n' }, 'Touch');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { pages: ['http://evil.example/steal', '//evil.example/x', '/index.html'], probe: false, screens: false, persist: false });
  assert.deepEqual(report.pages, ['/index.html']);
});

test('without a browser the answer says how to fix that', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'index.html': INDEX }, 'Base');
  const head = repo.commit({ 'index.html': INDEX + '\n' }, 'Touch');
  core.setRepoSettings(repo.dir, { allow: true, browser: 'C:/definitely/not/here.exe' });
  const saved = process.env.ASSAY_BROWSER;
  const path = process.env.PATH;
  const found = core.findBrowser('C:/definitely/not/here.exe');
  if (found) return; // a browser is installed in a standard place: nothing to test here
  process.env.PATH = '';
  try {
    const r = await core.lookCase(core.openCase({ repo: repo.dir, range: `${base}..${head}` }));
    assert.equal(r.ran, false);
    assert.match(r.reason ?? '', /allow-run --browser/);
  } finally { process.env.PATH = path; if (saved) process.env.ASSAY_BROWSER = saved; }
});

const AR_INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pay</title><link rel="stylesheet" href="style.css"></head>
<body><main><h1>Checkout</h1><p class="note">Your total is 24.00</p><button id="pay" class="pay">Place order now</button></main>
<script>
// the button is as wide as its English label (plus two pixels), the way a box sized for the words you have looks
var b = document.getElementById('pay');
var s = document.createElement('span');
s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(b).font;
s.textContent = b.textContent;
document.body.appendChild(s);
b.style.width = (Math.ceil(s.getBoundingClientRect().width) + 2) + 'px';
s.remove();
</script></body></html>
`;
// content-box, so the width the script sets is the room the text has, whatever the platform's default border on a button is
const AR_CSS_BASE = 'body{font:16px system-ui;margin:16px}\n.pay{padding:0;min-height:44px;font:600 14px system-ui;box-sizing:content-box}\n';
const AR_CSS_HEAD = AR_CSS_BASE.replace('.pay{padding:0;', '.pay{padding:0;overflow:hidden;white-space:nowrap;');

t('text that fits in English and not in Arabic is found, and the finding says it is the Arabic text that does it', async () => {
  const repo = makeRepo();
  const base = repo.commit({ 'index.html': AR_INDEX, 'style.css': AR_CSS_BASE }, 'Base');
  const head = repo.commit({ 'style.css': AR_CSS_HEAD }, 'Keep the pay button on one line');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false, screens: false });
  assert.equal(report.ran, true, report.reason);
  const clip = c.findings.find(f => f.origin === 'run' && f.check === 'browser' && /Text is cut off/.test(f.title))!;
  assert.ok(clip, c.findings.map(f => f.title).join(' | '));
  assert.match(clip.title, /with Arabic text$/, 'English fits: it is the longer Arabic text that is cut off');
  assert.equal(clip.tier, 'proven');
  assert.ok(clip.evidence.every(e => /with Arabic text/.test(e.what)), clip.evidence.map(e => e.what).join(' | '));
  assert.equal(clip.file, 'style.css');
  assert.ok(clip.snippet.rows.some(r => r.sig && /overflow:hidden/.test(r.text)), 'anchored on the line that made it');
  // and it replays: the same swap, at both ends
  const r = await core.replayEvidence(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), clip.evidence[0].id);
  assert.equal(r.reproduced, true, r.detail);

  // the same page with a box that has room is clean, in English and in Arabic
  const roomy = makeRepo();
  const b2 = roomy.commit({ 'index.html': AR_INDEX, 'style.css': AR_CSS_BASE }, 'Base');
  const h2 = roomy.commit({ 'style.css': AR_CSS_BASE.replace('.pay{padding:0;', '.pay{padding:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;') }, 'Ellipsis, which says it is cut');
  core.setRepoSettings(roomy.dir, { allow: true });
  const c2 = core.openCase({ repo: roomy.dir, range: `${b2}..${h2}` });
  await core.lookCase(c2, { probe: false, screens: false });
  assert.ok(!c2.findings.some(f => f.origin === 'run' && f.check === 'browser' && /Text is cut off/.test(f.title)), 'text-overflow: ellipsis says the text is shortened on purpose');
});

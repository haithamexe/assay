import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeRepo, request, signIn } from './helpers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-web-mem-home-'));
process.env.ASSAY_HOME = home;
const { startDashboard } = await import('../index.js');
type Dash = Awaited<ReturnType<typeof startDashboard>>;

const call = (cart: string, fn: string): string => `export function ${cart}(view, items) {\n  return view.${fn}(items);\n}\n`;
const repo = makeRepo([
  { files: { 'src/a.js': call('a', 'legacyTotals'), 'src/b.js': call('b', 'legacyTotals'), 'src/c.js': call('c', 'legacyTotals'), 'src/d.js': call('d', 'legacyTotals') }, message: 'Totals for four pages' },
  { files: { 'src/a.js': call('a', 'totals') }, message: 'fix: page a showed stale totals' },
  { files: { 'src/b.js': call('b', 'totals') }, message: 'fix: page b used the old totals' },
  { files: { 'src/c.js': call('c', 'totals') }, message: 'fix: page c ignored shipping' },
  { files: { 'src/e.js': `export const e = (view, items) => view.legacyTotals(items);\nexport const risky = text => { document.body.innerHTML = text; };\n` }, message: 'Add page e' }
]);

let d: Dash;
let page: Awaited<ReturnType<typeof signIn>>;
before(async () => { d = await startDashboard({ repo: repo.dir }); page = await signIn(d); });
after(async () => { await d.close(); });

test('memory: the packs and every entry, with nothing learned yet', async () => {
  const r = await page.get('/api/memory');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, true);
  assert.deepEqual(r.json.packs.map((p: any) => p.id), ['basics', 'owasp-top10', 'pages', 'review-questions', 'tests', 'wcag22']);
  assert.ok(r.json.packs.every((p: any) => p.on));
  const html = r.json.entries.find((e: any) => e.id === 'owasp-top10/a05-html');
  assert.equal(html.status, 'new');
  assert.equal(html.stats.hits, 0);
  assert.equal(r.json.entries.filter((e: any) => e.kind === 'learned').length, 0);
  assert.equal(r.json.mined, null);
  assert.equal(r.json.expiry.minHits, 4);
  assert.match(r.json.packsDir, /packs$/);
});

test('memory can be changed only by a post from the page itself', async () => {
  const body = { id: 'owasp-top10', on: false };
  assert.equal((await request(d.port, 'POST', '/api/memory/pack', { cookie: page.cookie, body, headers: { 'content-type': 'application/json' } })).status, 403, 'no origin');
  assert.equal((await request(d.port, 'POST', '/api/memory/pack', { cookie: page.cookie, body, headers: { origin: 'https://evil.example', 'content-type': 'application/json' } })).status, 403, 'another origin');
  assert.equal((await request(d.port, 'POST', '/api/memory/pack', { body, headers: { origin: d.origin, 'content-type': 'application/json' } })).status, 401, 'no key');
  assert.equal((await page.get('/api/memory')).json.packs.find((p: any) => p.id === 'owasp-top10').on, true, 'nothing changed');
});

test('a pack and an entry can be switched, and an unknown one is refused with a sentence', async () => {
  const off = await page.post('/api/memory/pack', { id: 'review-questions', on: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.packs.find((p: any) => p.id === 'review-questions').on, false);
  assert.equal(off.json.entries.find((e: any) => e.id === 'review-questions/money-float').status, 'off');
  assert.equal((await page.post('/api/memory/pack', { id: 'review-questions', on: true })).json.packs.find((p: any) => p.id === 'review-questions').on, true);
  const e = await page.post('/api/memory/entry', { id: 'basics/types-off', on: false });
  assert.equal(e.json.entries.find((x: any) => x.id === 'basics/types-off').status, 'off');
  await page.post('/api/memory/entry', { id: 'basics/types-off', on: true });
  const bad = await page.post('/api/memory/pack', { id: 'no-such-pack', on: true });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /no pack/);
  assert.equal((await page.post('/api/memory/entry', { id: 'nope/nope', on: true })).status, 400);
  assert.equal((await page.post('/api/memory/pack', {})).status, 400);
});

test('learning from history is a job, and only what it suggests can be added: the page can’t send a pattern of its own', async () => {
  const job = await page.job('/api/memory/mine', {});
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.ok(job.messages.length > 0 || job.result.report.commits > 0);
  const mined = (await page.get('/api/memory')).json;
  assert.equal(mined.mined.fixes, 3);
  const c = mined.mined.candidates.find((x: any) => x.token === '.legacyTotals(');
  assert.ok(c && c.worth && c.replacedBy === '.totals(', JSON.stringify(mined.mined.candidates.map((x: any) => x.token)));
  assert.deepEqual(mined.minedAdded, {});

  // a made-up suggestion, or a pattern in the body, is not a way in
  assert.equal((await page.post('/api/memory/add', { id: 'm-invented', pattern: '.*', name: 'everything' })).status, 400);
  assert.equal((await page.post('/api/memory/add', { pattern: '.*', name: 'everything' })).status, 400);
  assert.equal((await page.get('/api/memory')).json.entries.filter((e: any) => e.kind === 'learned').length, 0);

  const added = await page.post('/api/memory/add', { id: c.id, name: 'Old totals call' });
  assert.equal(added.status, 200);
  const e = added.json.entries.find((x: any) => x.kind === 'learned');
  assert.equal(e.id, 'L-1');
  assert.equal(e.name, 'Old totals call');
  assert.equal(added.json.minedAdded[c.id], 'L-1');
  assert.equal((await page.post('/api/memory/add', { id: c.id })).status, 400, 'twice is refused');
});

test('a case shows which remembered mistakes its findings match, and dismissing one is a false alarm for them', async () => {
  const open = await page.post('/api/open', { mode: 'branch' });
  assert.equal(open.status, 200);
  const D = open.json;
  const learned = D.case.findings.find((f: any) => f.check === 'memory' && f.file === 'src/e.js');
  assert.ok(learned, 'the learned pattern found the new call');
  assert.equal(learned.file, 'src/e.js');
  assert.deepEqual(D.memory[learned.id].map((m: any) => m.id), ['L-1']);
  assert.equal(D.memory[learned.id][0].kind, 'learned');
  assert.equal(D.memory[learned.id][0].hits, 5, 'the four pages that were fixed later were found too: they were committed');
  const html = D.case.findings.find((f: any) => f.evidence.some((e: any) => e.source === 'rule:html-injection'));
  assert.ok(html, 'a standard rule fired too');
  assert.ok(D.memory[html.id].some((m: any) => m.id === 'owasp-top10/a05-html'));
  assert.equal(D.states[learned.id], 'corroborated', 'the pattern and the fixes behind it');
  assert.equal(D.verdict.tone, 'mergeable', 'nothing from memory blocks');

  const dismissed = await page.post('/api/resolve', { case: D.case.id, finding: learned.id, how: 'dismissed' });
  assert.equal(dismissed.status, 200);
  const stats = (await page.get('/api/memory')).json.entries.find((x: any) => x.id === 'L-1').stats;
  assert.equal(stats.hits, 5);
  assert.equal(stats.falseAlarms, 1);
  await page.post('/api/resolve', { case: D.case.id, finding: learned.id, how: 'reopen' });
  assert.equal((await page.get('/api/memory')).json.entries.find((x: any) => x.id === 'L-1').stats.falseAlarms, 0);
});

test('a learned entry can be forgotten; a standard one can only be switched off', async () => {
  const bad = await page.post('/api/memory/remove', { id: 'owasp-top10/a05-html' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /learned entry/);
  const gone = await page.post('/api/memory/remove', { id: 'L-1' });
  assert.equal(gone.status, 200);
  assert.equal(gone.json.entries.filter((e: any) => e.kind === 'learned').length, 0);
  const D = (await page.post('/api/open', { mode: 'branch' })).json;
  assert.ok(!D.case.findings.some((f: any) => f.check === 'memory'), 'what it found is no longer reported');
});

test('the page for memory is served and the memory script is one of the named files', async () => {
  const js = await page.get('/js/memory.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'] ?? '', /javascript/);
});

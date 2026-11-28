import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* D63: text the page shows that no translation file has, taken over from a sister tool's Languages check. */
tempHome();
const core = await import('../index.js');
const { findTranslationFiles, readTranslations, translationLibrary, translationMatcher, looksLikeData, untranslatedTexts, addedLineWith } = await import('../browser/i18n.js');
const t = core.findBrowser() ? test : test.skip;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-i18n-'));
const write = (f: string, c: string): void => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
write('src/locales/en.json', JSON.stringify({ nav: { orders: 'Your orders' }, cart: { items: '{count, plural, one {# item} other {# items}}', total: 'Total: {{amount}}' }, hi: 'Hello, {name}!' }));
write('messages/de.yml', 'save: Speichern\nnested:\n  cancel: Abbrechen\n');
write('messages/fr.po', 'msgid "Sign in"\nmsgstr "Se connecter"\n');
write('node_modules/lib/locales/en.json', JSON.stringify({ x: 'From a library' }));
write('package.json', JSON.stringify({ dependencies: { 'react-i18next': '^14.0.0' } }));

test('translation files are found in locale folders, never node_modules, and read as JSON, YAML and .po', () => {
  assert.deepEqual(findTranslationFiles(dir).map(f => path.relative(dir, f).split(path.sep).join('/')), ['messages/de.yml', 'messages/fr.po', 'src/locales/en.json']);
  const values = readTranslations(findTranslationFiles(dir));
  for (const v of ['Your orders', 'Speichern', 'Abbrechen', 'Sign in', 'Se connecter']) assert.ok(values.includes(v), v);
  assert.ok(!values.includes('From a library'));
  assert.equal(translationLibrary(dir), 'react-i18next');
});

test('page text matches translations with their placeholders filled in; data is not words to translate', () => {
  const match = translationMatcher(readTranslations(findTranslationFiles(dir)));
  for (const s of ['Your orders', '  your   ORDERS ', 'Total: 40 €', 'Hello, Ada!', '3 items', 'Speichern']) assert.equal(match(s), true, s);
  for (const s of ['Welcome back to the shop', 'Your ordering history']) assert.equal(match(s), false, s);
  for (const s of ['42', '€ 12.50', '2026-11-05', 'ORD-2041', 'a1b2c3', 'ada@example.com', 'https://example.com/x', 'logo.svg']) assert.equal(looksLikeData(s), true, s);
  for (const s of ['Save changes', 'Orders', 'No results']) assert.equal(looksLikeData(s), false, s);
  const left = untranslatedTexts([{ text: 'Your orders', where: 'a' }, { text: 'Wireless mouse', where: 'span' }, { text: 'Place order', where: 'button' }, { text: 'ORD-2041', where: 'td' }], '{"name":"Wireless mouse"}', match);
  assert.deepEqual(left.map(x => x.text), ['Place order'], 'translated, data from the page’s JSON and codes are left out');
});

test('only an added line of a source file counts as where a text was written', () => {
  const hunk = (lines: string[]) => [{ header: '@@', oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((text, i) => ({ t: '+' as const, o: null, n: i + 1, text })) }];
  const net = [
    { path: 'src/locales/en.json', status: 'modified', binary: false, hunks: hunk(['"buy": "Place order"']) },
    { path: 'src/__tests__/cart.test.tsx', status: 'modified', binary: false, hunks: hunk(['expect("Place order")']) },
    { path: 'src/Cart.tsx', status: 'modified', binary: false, hunks: hunk(['<div>', '<button>Place order</button>']) }
  ] as unknown as Parameters<typeof addedLineWith>[0];
  assert.deepEqual(addedLineWith(net, 'Place order'), { file: 'src/Cart.tsx', line: 2 });
  assert.equal(addedLineWith(net, 'Not written anywhere'), null);
});

const LOCALE = JSON.stringify({ nav: { orders: 'Your orders' }, cart: { total: 'Total: {{amount}}' } }, null, 1);
const BASE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head>
<body><nav><a href="/">Your orders</a></nav>
<h1>Welcome back</h1>
</body></html>
`;
const HEAD = BASE.replace('<h1>Welcome back</h1>', `<h1>Welcome back</h1>
<p class="total">Total: 40 €</p>
<p class="ref">ORD-2041</p>
<script type="application/json" id="data">{"name":"Wireless mouse"}</script>
<span class="item">Wireless mouse</span>
<button class="buy">Place order now</button>`);

t('look finds the text a changed line wrote that no translation file has, and leaves translated, data and old text alone', async () => {
  const repo = makeRepo('shop-website');
  const base = repo.commit({ 'index.html': BASE, 'locales/en.json': LOCALE }, 'Base');
  const head = repo.commit({ 'index.html': HEAD }, 'Add the order button');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false, screens: false, speed: false });
  assert.equal(report.ran, true, report.reason);
  const f = c.findings.filter(x => /isn’t in the translation files/.test(x.title));
  assert.equal(f.length, 1, c.findings.map(x => x.title).join(' | '));
  const it = f[0];
  assert.deepEqual([it.tier, it.severity, it.lens, it.file], ['proven', 'low', 'UI', 'index.html']);
  assert.equal(it.evidence.length, 1, it.evidence.map(e => e.what).join(' | '));
  assert.match(it.evidence[0].what, /shows "Place order now" \(a button\), written at index\.html:\d+, and none of the 1 translation file has it/);
  assert.ok(it.snippet.rows.some(r => r.sig && /Place order now/.test(r.text)), 'anchored on the line that wrote it');
  assert.equal(report.translation?.files, 1);
  assert.ok((report.translation?.untranslated ?? 0) >= 2, 'the old "Welcome back" is counted, not reported');
  const again = await core.replayEvidence(core.openCase({ repo: repo.dir, range: `${base}..${head}` }), it.evidence[0].id);
  assert.equal(again.reproduced, true, again.detail);
});

t('a project with no translation files gets no finding, and one with a library but no files is told why', async () => {
  const repo = makeRepo('no-locales');
  const base = repo.commit({ 'index.html': BASE, 'package.json': JSON.stringify({ name: 'shop', dependencies: { 'vue-i18n': '^9.0.0' } }) }, 'Base');
  const head = repo.commit({ 'index.html': HEAD }, 'Add the order button');
  core.setRepoSettings(repo.dir, { allow: true });
  const c = core.openCase({ repo: repo.dir, range: `${base}..${head}` });
  const report = await core.lookCase(c, { probe: false, screens: false, speed: false });
  assert.equal(report.ran, true, report.reason);
  assert.ok(!c.findings.some(x => /translation files/.test(x.title)));
  assert.match(report.translation?.note ?? '', /uses vue-i18n, but no translation file was found/);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* D67: try an upgrade. A fake registry on 127.0.0.1 serves one package in a few versions, and a made-up project depends on it. The package
   manager is the real npm, pointed at that registry, so nothing here reaches the internet. */
tempHome();
const core = await import('../index.js');
const browser = core.findBrowser();
const skip = browser ? false : 'no Chromium-based browser on this computer';

/** A package as npm wants it: a gzipped tar with everything under package/. */
function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(`package/${name}`, 0, 100);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/* fake-ui 1.0.0 and 1.5.0 greet the same way, 2.0.0 greets differently (the project's test expects the old greeting), 3.0.0-beta.1 is only on the "next" tag. */
const VERSIONS: Record<string, string> = {
  '1.0.0': "module.exports = { greet: n => 'hello ' + n };",
  '1.5.0': "module.exports = { greet: n => 'hello ' + n, extra: true };",
  '2.0.0': "module.exports = { greet: n => 'HI THERE, ' + String(n).toUpperCase() + '!!! (the whole page now shouts)' };",
  '3.0.0-beta.1': "module.exports = { greet: n => 'hey ' + n };"
};
const TAGS: Record<string, string> = { latest: '2.0.0', next: '3.0.0-beta.1' };
const tars = new Map<string, Buffer>();
for (const [v, code] of Object.entries(VERSIONS)) tars.set(v, tarball({ 'package.json': JSON.stringify({ name: 'fake-ui', version: v, main: 'index.js' }), 'index.js': code }));

let registry: http.Server;
let registryUrl = '';
const hits: string[] = [];
before(async () => {
  registry = http.createServer((q, r) => {
    hits.push(q.url ?? '');
    const url = new URL(q.url ?? '/', 'http://x');
    const tgz = /^\/fake-ui\/-\/fake-ui-(.+)\.tgz$/.exec(url.pathname);
    if (tgz && tars.has(tgz[1])) { r.writeHead(200, { 'content-type': 'application/octet-stream' }); r.end(tars.get(tgz[1])); return; }
    if (url.pathname === '/fake-ui') {
      const versions: Record<string, unknown> = Object.fromEntries(Object.keys(VERSIONS).map(v => {
        const t = tars.get(v)!;
        return [v, { name: 'fake-ui', version: v, main: 'index.js', dist: { tarball: `${registryUrl}/fake-ui/-/fake-ui-${v}.tgz`, shasum: crypto.createHash('sha1').update(t).digest('hex'), integrity: `sha512-${crypto.createHash('sha512').update(t).digest('base64')}` } }];
      }));
      // a version whose files are not there: listed, and its tarball answers 404
      versions['4.0.0'] = { name: 'fake-ui', version: '4.0.0', main: 'index.js', dist: { tarball: `${registryUrl}/fake-ui/-/fake-ui-4.0.0.tgz`, shasum: '0'.repeat(40) } };
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ name: 'fake-ui', 'dist-tags': TAGS, versions }));
      return;
    }
    r.writeHead(404, { 'content-type': 'application/json' }); r.end('{"error":"not found"}');
  });
  await new Promise<void>(res => registry.listen(0, '127.0.0.1', () => res()));
  registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
  process.env.npm_config_registry = registryUrl;
  process.env.npm_config_cache = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-try-npm-cache-'));
  process.env.npm_config_audit = 'false';
  process.env.npm_config_fund = 'false';
});
after(() => { registry.close(); });

const SERVER = `const http = require('http');
const ui = require('fake-ui');
http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html lang="en"><body><h1>' + ui.greet('world') + '</h1><p>The shop</p><button>Go</button></body></html>'); }).listen(Number(process.env.PORT), '127.0.0.1');
`;
const TEST = `const test = require('node:test');
const assert = require('node:assert/strict');
test('greets the way it always did', () => { assert.equal(require('fake-ui').greet('world'), 'hello world'); });
test('has a greeting', () => { assert.equal(typeof require('fake-ui').greet, 'function'); });
`;

/** A project that depends on fake-ui 1.0.0, with a real lockfile made by the real npm against the fake registry. */
const run = promisify(execFile);
async function project(name: string, o: { allow?: boolean; network?: boolean; serve?: boolean } = { allow: true, network: true, serve: true }): Promise<{ dir: string; head: string }> {
  const repo = makeRepo(name);
  const pkg = { name, version: '1.0.0', private: true, scripts: { test: 'node --test test.js', build: "node -e \"require('fake-ui')\"" }, dependencies: { 'fake-ui': '1.0.0' } };
  fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify(pkg, null, 2));
  // asynchronous: the registry is in this process, and a blocked process can't answer it
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: repo.dir, shell: process.platform === 'win32' });
  const head = repo.commit({ 'package.json': JSON.stringify(pkg, null, 2), 'package-lock.json': fs.readFileSync(path.join(repo.dir, 'package-lock.json'), 'utf8'), 'server.js': SERVER, 'test.js': TEST, '.gitignore': 'node_modules\n' }, 'A shop that greets');
  core.setRepoSettings(repo.dir, { ...(o.allow === false ? {} : { allow: true }), ...(o.network ? { network: true } : {}), ...(o.serve ? { serve: 'node server.js' } : {}) });
  return { dir: repo.dir, head };
}
const workFolders = (): string[] => { try { return fs.readdirSync(core.assayPath('work')).flatMap(r => fs.readdirSync(core.assayPath('work', r))).filter(n => /^try-/.test(n)); } catch { return []; } };

test('versions order, the package manager is found from the lockfile, and the commands are fixed words', () => {
  assert.deepEqual(['1.10.0', '1.9.0', '2.0.0-beta.1', '2.0.0', '1.0.0'].sort(core.compareVersions), ['1.0.0', '1.9.0', '1.10.0', '2.0.0-beta.1', '2.0.0']);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-pm-'));
  assert.equal(core.detectPm(d), 'npm');
  fs.writeFileSync(path.join(d, 'package.json'), '{"packageManager":"pnpm@9.0.0"}');
  assert.equal(core.detectPm(d), 'pnpm');
  fs.writeFileSync(path.join(d, 'yarn.lock'), '');
  assert.equal(core.detectPm(d), 'yarn', 'a lockfile wins over a field');
  assert.deepEqual(core.installArgs('npm', d, false), ['install', '--ignore-scripts'], 'no lockfile: install');
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
  assert.deepEqual(core.installArgs('npm', d, false), ['ci', '--ignore-scripts']);
  assert.deepEqual(core.installArgs('npm', d, true), ['ci'], '--scripts lets them run');
  assert.deepEqual(core.installArgs('pnpm', d, false), ['install', '--ignore-scripts']);
  assert.deepEqual(core.addArgs('npm', d, '@scope/ui', '2.0.0', true, false), ['install', '@scope/ui@2.0.0', '--save-dev', '--ignore-scripts']);
  assert.deepEqual(core.addArgs('yarn', d, 'react', '19.1.0', false, false), ['add', 'react@19.1.0', '--ignore-scripts']);
  assert.deepEqual(core.addArgs('bun', d, 'react', '19.1.0', true, false), ['add', 'react@19.1.0', '--dev', '--ignore-scripts']);
  for (const [name, to] of [['react; rm -rf /', '1.0.0'], ['react', '1.0.0 && echo hi'], ['../x', '1.0.0'], ['React', '1.0.0']]) assert.throws(() => core.addArgs('npm', d, name, to, false, false), /can’t be installed/, `${name} ${to}`);
});

test('it is refused until allowed and until the registry has its own yes; the package and the version are checked before anything is installed', async () => {
  const a = await project('shop-guard', { allow: false });
  await assert.rejects(core.runTry({ repo: a.dir, package: 'fake-ui' }), /assay allow-run/);
  core.setRepoSettings(a.dir, { allow: true });
  await assert.rejects(core.runTry({ repo: a.dir, package: 'fake-ui' }), /assay allow-run --network/, 'the package manager reaching its registry is a yes of its own');
  core.setRepoSettings(a.dir, { network: true });
  const before = hits.length;
  for (const [pkg, v, why] of [['react; ls', undefined, /isn’t a package name/], ['left-pad', undefined, /isn’t one of the project’s dependencies/], ['fake-ui', '^2', /number like 19/], ['fake-ui', '1.0 || 2', /number like 19/]] as const) await assert.rejects(core.runTry({ repo: a.dir, package: pkg, version: v }), why, `${pkg}@${v}`);
  assert.equal(hits.length, before, 'nothing reached the registry for a request that was refused');
  await assert.rejects(core.runTry({ repo: a.dir, package: 'fake-ui', version: '9' }), /no answer|could not be looked up|No fake-ui version matches/);
  await assert.rejects(core.runTry({ repo: a.dir, package: 'fake-ui', version: '1.0.0' }), /already what the lockfile installs/);
  assert.deepEqual(workFolders(), [], 'a copy that was made is removed, whatever happened');
  core.setRepoSettings(a.dir, { network: false });
  await assert.rejects(core.runTry({ repo: a.dir, package: 'fake-ui' }), /assay allow-run --network/, 'turned off again');
});

test('a version that changes nothing: the checks pass as before, and the install scripts were not run', { timeout: 240_000 }, async () => {
  const p = await project('shop-same');
  const r = await core.runTry({ repo: p.dir, package: 'fake-ui', version: '1.5', browser: false });
  assert.deepEqual([r.schema, r.pm, r.target.name, r.target.from, r.target.to, r.target.major, r.target.dev], ['assay.try/1', 'npm', 'fake-ui', '1.0.0', '1.5.0', false, false], 'a partial version is the highest one that matches');
  assert.equal(r.verdict, 'same', JSON.stringify(r.summary));
  assert.deepEqual(r.checks.map(c => [c.name, c.before?.ok, c.after?.ok]), [['build', true, true], ['tests', true, true]]);
  assert.match(r.summary[0], /Nothing changed that Assay can see/);
  assert.equal(r.scripts, false);
  assert.ok(r.notes.some(n => /Install scripts were not run/.test(n)));
  assert.ok(r.install.before.ok && r.install.after?.ok);
  assert.equal(core.tryFails(r, 'changes'), false);
  // the project was only read
  assert.equal(execFileSync('git', ['-C', p.dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'nothing in the project changed');
  assert.ok(!fs.existsSync(path.join(p.dir, 'node_modules')), 'and nothing was installed in it');
  assert.deepEqual(workFolders(), [], 'both copies are removed');
});

test('a version that breaks the tests: said first, with the failing test, and the page looks different', { skip, timeout: 300_000 }, async () => {
  const p = await project('shop-breaks');
  const r = await core.runTry({ repo: p.dir, package: 'fake-ui', version: 'latest' });
  assert.deepEqual([r.target.from, r.target.to, r.target.major], ['1.0.0', '2.0.0', true]);
  assert.equal(r.verdict, 'breaks', JSON.stringify(r.summary));
  assert.match(r.summary[0], /1 more test fails|more tests fail/);
  assert.ok(r.summary.some(s => /greets the way it always did/.test(s)), 'the failing test is named');
  assert.equal(r.checks.find(c => c.name === 'tests')!.after!.ok, false);
  assert.equal(r.checks.find(c => c.name === 'tests')!.before!.ok, true);
  const page = r.pages.find(x => x.path === '/')!;
  assert.ok(page.ok && page.looks && page.looks.ratio > 0, `the heading changed, so the picture did: ${JSON.stringify(page)}`);
  assert.ok(r.summary.some(s => /^\/ looks different/.test(s)));
  assert.equal(core.tryFails(r, 'breaks'), true);
  assert.deepEqual(workFolders(), []);
  // a tag is resolved by the registry through the package manager
  const next = await core.runTry({ repo: p.dir, package: 'fake-ui', version: 'next', browser: false, tests: false });
  assert.equal(next.target.to, '3.0.0-beta.1');
  assert.deepEqual(next.checks.map(c => c.name), ['build']);
});

test('a project that does not install before any change cannot be compared, and says so; an install that fails after is "breaks"', { timeout: 240_000 }, async () => {
  const bad = makeRepo('shop-unclear');
  const pkg = { name: 'shop-unclear', version: '1.0.0', private: true, scripts: { test: 'node --test' }, dependencies: { 'fake-ui': '1.0.0', 'package-that-is-not-there': '1.0.0' } };
  bad.commit({ 'package.json': JSON.stringify(pkg), 'package-lock.json': JSON.stringify({ name: 'shop-unclear', lockfileVersion: 3, requires: true, packages: { '': { name: 'shop-unclear', version: '1.0.0', dependencies: pkg.dependencies } } }) }, 'Does not install');
  core.setRepoSettings(bad.dir, { allow: true, network: true });
  const r = await core.runTry({ repo: bad.dir, package: 'fake-ui', version: '2', browser: false });
  assert.equal(r.verdict, 'unclear');
  assert.match(r.summary[0], /didn’t install before any change/);
  assert.equal(r.install.after, undefined, 'nothing was added to a project that did not install');
  assert.deepEqual(workFolders(), []);
  // a version that is listed but can't be installed
  const ok = await project('shop-failinstall');
  const f = await core.runTry({ repo: ok.dir, package: 'fake-ui', version: '4', browser: false });
  assert.equal(f.verdict, 'breaks');
  assert.match(f.summary[0], /fake-ui@4\.0\.0 didn’t install/);
  assert.equal(f.install.before.ok, true);
  assert.equal(f.install.after?.ok, false);
  assert.deepEqual(f.checks, [], 'nothing was checked in a copy that does not have the package');
  assert.deepEqual(workFolders(), []);
});

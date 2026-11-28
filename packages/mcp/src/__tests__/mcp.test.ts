import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SECRET = 'AKIAQWERTYUIOP123456';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-repo-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-home-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'octocat', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_NAME: 'octocat', GIT_COMMITTER_EMAIL: 'o@example.com' };
const git = (...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q', '-b', 'main');
git('config', 'commit.gpgsign', 'false');
const write = (f: string, c: string): void => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
write('README.md', '# x\n');
git('add', '-A'); git('commit', '-q', '-m', 'Base');
write('config/settings.py', `AWS_KEY = "${SECRET}"\n`);
write('src/view.tsx', `export function View({ html }: { html: string }) {
  const a = html.trim();
  const b = a.length;
  const c = b > 3;
  const d = c ? a : '';
  const e = d.toUpperCase();
  const f = e + '!';
  const g = f.length;
  const h = g + 1;
  const i = h * 2;
  const j = i - 1;
  return <div dangerouslySetInnerHTML={{ __html: f + j }} />;
}
`);
git('add', '-A'); git('commit', '-q', '-m', 'Add settings and a view');

const server = path.resolve(import.meta.dirname, '..', 'index.js');
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd: dir, env: { ...(process.env as Record<string, string>), ASSAY_HOME: home } }));
after(async () => { await client.close(); });

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; data: Record<string, any> }> => {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
  return { text: r.content[0].text, isError: !!r.isError, data: (r.structuredContent ?? {}) as Record<string, any> };
};

test('the server says what it is for, and lists its tools', async () => {
  assert.match(client.getInstructions() ?? '', /before you say you are done/);
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['attack', 'brief', 'case_findings', 'case_open', 'checkup', 'evidence_replay', 'finding_get', 'finding_resolve', 'finding_submit', 'gremlins', 'look', 'memory', 'prove', 'reviewer_brief', 'reviewers_plan', 'test', 'timeline', 'try']);
  assert.ok(!names.some(n => /allow/.test(n)), 'there is no tool that turns running on: only a person can');
  assert.ok(!names.some(n => /memory_/.test(n)), 'memory is one read only tool: an agent can’t add, switch off or forget');
});

test('prove is refused until a person allows it, and an agent has no way to allow it', async () => {
  const c = await call('case_open');
  assert.match(c.text, /Proof: none yet/);
  const r = await call('prove', { case: c.data.case });
  assert.equal(r.isError, true);
  assert.match(r.text, /assay allow-run/);
});

test('prove runs the project’s own tests once a person has allowed it, and proves a regression', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-proj-'));
  const pg = (...a: string[]): string => execFileSync('git', ['-C', proj, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  pg('init', '-q', '-b', 'main'); pg('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(proj, 'src')); fs.mkdirSync(path.join(proj, 'test'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"p","type":"module","scripts":{"test":"node --test"}}\n');
  fs.writeFileSync(path.join(proj, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(proj, 'test', 'add.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add adds two numbers', () => { assert.equal(add(2, 3), 5); });\n");
  pg('add', '-A'); pg('commit', '-q', '-m', 'Base');
  const base = pg('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(proj, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
  pg('add', '-A'); pg('commit', '-q', '-m', 'Refactor add');
  const opened = await call('case_open', { repo: proj, range: `${base}..HEAD` });
  assert.equal(opened.isError, false);
  // the person turns it on (the server reads this file; it can never write it)
  process.env.ASSAY_HOME = home;
  const core = await import('@assay/core');
  core.setRepoSettings(proj, { allow: true, timeout: 120 });
  const r = await call('prove', { case: opened.data.case, mutants: 0, reverts: 0, budget_seconds: 120 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Regression: add adds two numbers/);
  assert.match(r.text, /Behaviour: 1 function compared before and after, 1 answers differently \(a difference is for a person to judge: it never blocks\)/);
  assert.match(r.text, /Blocked: 1 proven problem/);
  assert.equal(r.data.tone, 'blocked');
  assert.ok(r.text.length < 3000, 'answers stay short');

  // test: the same project's tests once, at its head, each failure with its file and line
  const t = await call('test', { repo: proj });
  assert.equal(t.isError, false, t.text);
  assert.match(t.text, /^Failed: 0 passed, 1 failed/);
  assert.match(t.text, /✗ add adds two numbers {2}test\/add\.test\.js:4/);
  assert.deepEqual([t.data.ok, t.data.failed, t.data.where, t.data.failures[0].file], [false, 1, 'copy', 'test/add.test.js']);
  const here = await call('test', { repo: proj, here: true });
  assert.equal(here.isError, true);
  assert.match(here.text, /assay allow-run --here/, 'the folder needs its own yes, which an agent can’t give');
});

test('test is refused until a person allows running', async () => {
  const r = await call('test');
  assert.equal(r.isError, true);
  assert.match(r.text, /assay allow-run/);
});

test('attack is refused until a person allows running, takes no session from the agent, and says when nothing answers', async () => {
  const refused = await call('attack', { url: 'http://127.0.0.1:1' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /assay allow-run/);
  assert.ok(!Object.keys((await client.listTools()).tools.find(t => t.name === 'attack')!.inputSchema.properties ?? {}).some(k => /cookie|session|authorization|token/i.test(k)), 'an agent can’t hand it a session');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-attack-'));
  const pg = (...a: string[]): string => execFileSync('git', ['-C', proj, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  pg('init', '-q', '-b', 'main'); pg('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  pg('add', '-A'); pg('commit', '-q', '-m', 'Base');
  process.env.ASSAY_HOME = home;
  const core = await import('@assay/core');
  core.setRepoSettings(proj, { allow: true });
  const bad = await call('attack', { repo: proj, url: 'http://example.com' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /running on this computer/);
  const writes = await call('attack', { repo: proj, url: 'http://127.0.0.1:1', writes: true });
  assert.equal(writes.isError, true);
  assert.match(writes.text, /assay allow-run --writes/, 'an agent can’t turn the data-changing checks on');
  const r = await call('attack', { repo: proj, url: 'http://127.0.0.1:1', browser: false });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /0 proven/);
  assert.match(r.text, /Nothing answered/);
  assert.deepEqual([r.data.schema, r.data.writes], ['assay.attack/1', false]);
});

test('try is refused until a person allows running and the registry, takes nothing that runs install scripts, and checks the package before reaching for it', async () => {
  const refused = await call('try', { package: 'react' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /assay allow-run/);
  assert.deepEqual(Object.keys((await client.listTools()).tools.find(t => t.name === 'try')!.inputSchema.properties ?? {}).sort(), ['browser', 'package', 'pages', 'ref', 'repo', 'tests', 'version'], 'no argument lets install scripts run or turns the registry on');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-try-'));
  const pg = (...a: string[]): string => execFileSync('git', ['-C', proj, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  pg('init', '-q', '-b', 'main'); pg('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { left: '1.0.0' } }));
  pg('add', '-A'); pg('commit', '-q', '-m', 'Base');
  process.env.ASSAY_HOME = home;
  const core = await import('@assay/core');
  core.setRepoSettings(proj, { allow: true });
  const noNet = await call('try', { repo: proj, package: 'left' });
  assert.equal(noNet.isError, true);
  assert.match(noNet.text, /assay allow-run --network/, 'an agent can’t let the package manager reach its registry');
  core.setRepoSettings(proj, { network: true });
  const bad = await call('try', { repo: proj, package: 'react; ls' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /isn’t a package name/);
  const none = await call('try', { repo: proj, package: 'right' });
  assert.equal(none.isError, true);
  assert.match(none.text, /isn’t one of the project’s dependencies/);
});

test('gremlins are refused until a person allows running and gives their own yes for data-changing checks, and an agent can’t pass a session', async () => {
  const refused = await call('gremlins', { url: 'http://127.0.0.1:1' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /assay allow-run/);
  assert.ok(!Object.keys((await client.listTools()).tools.find(t => t.name === 'gremlins')!.inputSchema.properties ?? {}).some(k => /cookie|session|authorization|token|writes/i.test(k)), 'there is nothing to pass that turns it on');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-gremlins-'));
  const pg = (...a: string[]): string => execFileSync('git', ['-C', proj, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  pg('init', '-q', '-b', 'main'); pg('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  pg('add', '-A'); pg('commit', '-q', '-m', 'Base');
  process.env.ASSAY_HOME = home;
  const core = await import('@assay/core');
  core.setRepoSettings(proj, { allow: true });
  const noWrites = await call('gremlins', { repo: proj, url: 'http://127.0.0.1:1' });
  assert.equal(noWrites.isError, true);
  assert.match(noWrites.text, /assay allow-run --writes/, 'an agent can’t turn the data-changing checks on');
  core.setRepoSettings(proj, { writes: true });
  const bad = await call('gremlins', { repo: proj, url: 'http://example.com' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /running on this computer/);
  const both = await call('gremlins', { repo: proj, url: 'http://127.0.0.1:1', base: 'HEAD' });
  assert.equal(both.isError, true);
  assert.match(both.text, /one or the other/);
});

let caseId = '';
let secretId = '';
let htmlId = '';

test('case_open reviews the folder it was started in, with no arguments, and blocks on the secret', async () => {
  const r = await call('case_open');
  assert.equal(r.isError, false);
  assert.match(r.text, /Blocked: 1 proven problem/);
  assert.match(r.text, /AWS access key id/);
  assert.ok(!r.text.includes('QWERTYUIOP123456'), 'a secret is never in a tool answer');
  assert.equal(r.data.tone, 'blocked');
  caseId = r.data.case;
  secretId = r.data.findings.find((f: any) => f.tier === 'proven').id;
  htmlId = r.data.findings.find((f: any) => /HTML/.test(f.title)).id;
  assert.ok(caseId && secretId && htmlId);
  assert.ok(r.text.length < 2500, 'answers stay short');
});

test('memory says which remembered mistakes a case matches and what to ask, and changes nothing', async () => {
  const m = await call('memory', { case: caseId });
  assert.equal(m.isError, false);
  assert.match(m.text, /Findings that match a remembered mistake/);
  assert.match(m.text, /A key, token or password was committed/);
  assert.match(m.text, /Untrusted text inserted as HTML/);
  assert.match(m.text, /Questions to ask while you review/);
  assert.ok(!m.text.includes('QWERTYUIOP123456'), 'a secret is never in a tool answer');
  assert.ok(m.data.questions.length > 0 && m.data.questions.length <= 8);
  assert.ok(m.text.length < 3500, 'answers stay short');
  const few = await call('memory', { case: caseId, limit: 2, languages: ['Python'] });
  assert.equal(few.data.questions.length, 2);
  const none = await call('memory', { repo: dir });
  assert.match(none.text, /remembered mistakes on/);
  assert.ok(!/Findings that match/.test(none.text));
  const bad = await call('memory', { case: 'c-0000000-root' });
  assert.equal(bad.isError, true);
});

test('the reviewer panel: plan and cost first, a blind brief per reviewer, a done signal, and nothing an agent can do spends tokens', async () => {
  const plan = await call('reviewers_plan', { case: caseId, budget: 60000, request: 'Add settings and a view' });
  assert.equal(plan.isError, false);
  assert.match(plan.text, /Reviewer panel for case c-/);
  assert.match(plan.text, /budget 60k tokens/);
  assert.match(plan.text, /RUN\s+Security/);
  assert.match(plan.text, /skip\s+Performance/);
  assert.match(plan.text, /start one sub-agent per reviewer still to report/);
  assert.ok(plan.data.run.includes('Security') && plan.data.run.includes('Scope'), JSON.stringify(plan.data));
  assert.ok(plan.text.length < 2800, 'the plan is short');
  const again = await call('reviewers_plan', { case: caseId, budget: 60000, request: 'Add settings and a view' });
  assert.equal(again.data.panel, plan.data.panel, 'planning again with the same budget keeps the panel');

  const brief = await call('reviewer_brief', { case: caseId, lens: 'Security' });
  assert.equal(brief.isError, false);
  assert.match(brief.text, /REVIEWER BRIEF · Security/);
  assert.match(brief.text, /── src\/view\.tsx/);
  assert.ok(!brief.text.includes('QWERTYUIOP123456'), 'a secret is never in a brief');
  assert.equal(brief.data.round, 1);
  const early = await call('reviewer_brief', { case: caseId, lens: 'Security', round: 2 });
  assert.equal(early.isError, true);
  assert.match(early.text, /every reviewer has reported/);
  const out = await call('reviewer_brief', { case: caseId, lens: 'Performance' });
  assert.equal(out.isError, true);
  assert.match(out.text, /not part of this panel/);
  const nobody = await call('reviewer_brief', { case: caseId, lens: 'Astrology' });
  assert.equal(nobody.isError, true);

  assert.equal((await call('finding_submit', { case: caseId, reviewer: 'Security' })).isError, true, 'nothing to submit');
  const done = await call('finding_submit', { case: caseId, reviewer: 'Security', done: true, tokens: 2400 });
  assert.equal(done.isError, false);
  assert.match(done.text, /Marked done/);
  assert.match(done.text, /Panel: 1 of \d+ reviewers have reported/);
  const after = await call('reviewers_plan', { case: caseId, budget: 60000, request: 'Add settings and a view' });
  assert.match(after.text, /Security\s+~[\d.]+k?\s+.*reported: 0 claims/);
  assert.match(after.text, /still to report/);
  assert.ok(!/reviewers?_run|reviewers?_start|spend/i.test((await client.listTools()).tools.map(t => t.name).join(' ')), 'there is no tool that spends tokens: the agent does the reviewing');
});

test('the attack pass: on offer only on a big budget, briefed as "attack", reported as "Attack", and counted with the panel', async () => {
  const none = await call('reviewer_brief', { case: caseId, lens: 'attack' });
  assert.equal(none.isError, true, 'the kept 60k plan has no attack pass');
  assert.match(none.text, /not part of this panel: The attack pass is for budgets of 80k or more/);
  const plan = await call('reviewers_plan', { case: caseId, budget: 100000, request: 'Add settings and a view' });
  assert.match(plan.text, /RUN\s+Attack\s+~[\d.]+k\s+Tries to break/);
  assert.match(plan.text, /lens "attack"/, 'it says how to start it');
  const brief = await call('reviewer_brief', { case: caseId, lens: 'attack' });
  assert.equal(brief.isError, false, brief.text);
  assert.match(brief.text, /REVIEWER BRIEF · Attack/);
  assert.match(brief.text, /── src\/view\.tsx/);
  assert.ok(!brief.text.includes('QWERTYUIOP123456'), 'a secret is never in a brief');
  assert.equal((await call('reviewer_brief', { case: caseId, lens: 'attack', round: 2 })).isError, true, 'one round');
  const done = await call('finding_submit', { case: caseId, reviewer: 'Attack', done: true, tokens: 3100 });
  assert.equal(done.isError, false);
  assert.match(done.text, /Marked done/);
  const after = await call('reviewers_plan', { case: caseId, budget: 100000, request: 'Add settings and a view' });
  assert.match(after.text, /Attack\s+~[\d.]+k\s+.*reported: 0 claims/);
});

test('finding_get shows the lines and the evidence, and the evidence replays', async () => {
  const g = await call('finding_get', { case: caseId, id: secretId });
  assert.match(g.text, /AKIA…\(20 characters\)/);
  assert.match(g.text, /evidence_replay f-/);
  assert.ok(!g.text.includes('QWERTYUIOP123456'));
  const evId = g.text.match(/(f-[0-9a-f]{8}\.\d)/)![1];
  const r = await call('evidence_replay', { case: caseId, evidence_id: evId });
  assert.match(r.text, /^reproduced/);
});

test('brief is the short list', async () => {
  const b = await call('brief', { case: caseId });
  assert.match(b.text, /MUST FIX/);
  assert.match(b.text, /rotate it/);
  assert.ok(b.text.split('\n').length < 20);
});

test('finding_submit: a claim with a location is gated in, one without is dropped, proof can’t be claimed', async () => {
  const r = await call('finding_submit', {
    case: caseId, reviewer: 'Security',
    claims: [
      { title: 'The html prop is trusted', lens: 'Security', file: 'src/view.tsx', line: 12, what: 'The prop reaches innerHTML unescaped from the page.', evidence: [{ kind: 'probe', what: 'I injected a script and it ran' }] },
      { title: 'Somewhere in the project', lens: 'Security', file: 'src/elsewhere.ts', line: 3, what: 'Looks risky but is not in the diff at all.' }
    ]
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /1 added to an existing finding|1 new/);
  assert.match(r.text, /dropped \(no-location\)/);
  const g = await call('finding_get', { case: caseId, id: htmlId });
  assert.match(g.text, /\[unverified\] I injected a script/);
  assert.ok(!/proven/.test(g.text.split('\n')[1]), 'the claim did not make it proven');
});

test('an agent can dismiss a hint but not a proven finding', async () => {
  const refused = await call('finding_resolve', { case: caseId, id: secretId, how: 'dismissed' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Only a person can dismiss it/);
  const ok = await call('finding_resolve', { case: caseId, id: htmlId, how: 'intended' });
  assert.equal(ok.isError, false);
  const list = await call('case_findings', { case: caseId });
  assert.ok(!list.text.includes(htmlId), 'a resolved finding drops out of the open list');
  assert.ok((await call('case_findings', { case: caseId, all: true })).text.includes(htmlId));
});

test('timeline and errors', async () => {
  const t = await call('timeline');
  assert.match(t.text, /Add settings and a view/);
  const bad = await call('finding_get', { case: 'c-0000000-0000000', id: 'f-1' });
  assert.equal(bad.isError, true);
  const worse = await call('case_open', { range: '--output=/tmp/x' });
  assert.equal(worse.isError, true);
  assert.match(worse.text, /not a commit/);
});

test('look is refused until a person allows it, like prove', async () => {
  const c = await call('case_open');
  const r = await call('look', { case: c.data.case });
  assert.equal(r.isError, true);
  assert.match(r.text, /assay allow-run/);
});

const hasBrowser = !!(await import('@assay/core')).findBrowser();
(hasBrowser ? test : test.skip)('look opens the pages in a real browser and reports a mirrored-layout problem, with the changed line', async () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-mcp-web-'));
  const wg = (...a: string[]): string => execFileSync('git', ['-C', web, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  wg('init', '-q', '-b', 'main'); wg('config', 'commit.gpgsign', 'false');
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  fs.writeFileSync(path.join(web, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="s.css"></head><body><div class="i"><img class="t" alt="" src="${gif}"><span class="p">$24</span></div></body></html>`);
  fs.writeFileSync(path.join(web, 's.css'), '.i{position:relative;display:flex;padding:12px}.t{width:48px;height:48px}.p{position:absolute;top:12px;inset-inline-end:12px}\n');
  wg('add', '-A'); wg('commit', '-q', '-m', 'Base');
  const base = wg('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(web, 's.css'), '.i{position:relative;display:flex;padding:12px}.t{width:48px;height:48px}.p{position:absolute;top:12px;right:12px}\n');
  wg('add', '-A'); wg('commit', '-q', '-m', 'Restyle');
  const opened = await call('case_open', { repo: web, range: `${base}..HEAD` });
  process.env.ASSAY_HOME = home;
  const core = await import('@assay/core');
  core.setRepoSettings(web, { allow: true });
  const r = await call('look', { case: opened.data.case, probe: false, budget_seconds: 120 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Browser: /);
  assert.match(r.text, /New at the head: 1 measured problem/);
  assert.match(r.text, /Things overlap on \/ when mirrored/);
  const g = await call('finding_get', { case: opened.data.case, id: r.data.findings.find((f: any) => /overlap/.test(f.title))?.id ?? r.text.match(/(f-[0-9a-f]{8})/)![1] });
  assert.match(g.text, /measurement/);
  assert.match(g.text, /right:12px/);
});

test('checkup looks at the project as it is, says what is new, and refuses an address off this computer', async () => {
  const r = await call('checkup', { pages: ['/'] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /checkup ck-\d{14}-[0-9a-f]{6}/);
  assert.match(r.text, /AWS access key id in settings\.py/);
  assert.match(r.text, /First checkup/);
  assert.ok(!r.text.includes('QWERTYUIOP123456'));
  assert.equal(r.data.schema, 'assay.checkup/1');
  assert.equal(r.data.tone, 'act');
  assert.equal(r.data.pages, 1);
  const again = await call('checkup', { only: 'secrets' });
  assert.match(again.text, /already there/);
  assert.equal(again.data.pages, null, 'only the one check: no list of pages');
  const bad = await call('checkup', { url: 'http://example.com' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /running on this computer/);
});

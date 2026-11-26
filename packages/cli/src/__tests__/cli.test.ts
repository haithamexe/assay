import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SECRET = 'AKIAQWERTYUIOP123456';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-repo-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-home-'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-out-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'octocat', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_NAME: 'octocat', GIT_COMMITTER_EMAIL: 'o@example.com', ASSAY_HOME: home, NO_COLOR: '1' };
const git = (...a: string[]): void => { execFileSync('git', ['-C', dir, ...a], { env, stdio: 'ignore' }); };
git('init', '-q', '-b', 'main');
git('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
git('add', '-A'); git('commit', '-q', '-m', 'Base');
fs.mkdirSync(path.join(dir, 'config'));
fs.writeFileSync(path.join(dir, 'config', 'settings.py'), `AWS_KEY = "${SECRET}"\n`);
git('add', '-A'); git('commit', '-q', '-m', 'Add settings');

const bin = path.resolve(import.meta.dirname, '..', 'index.js');
const run = (...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [bin, ...args, '--repo', dir], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('case prints the verdict and the ranked findings, and never the secret', () => {
  const r = run('case');
  assert.equal(r.code, 0);
  assert.match(r.out, /Blocked: 1 proven problem/);
  assert.match(r.out, /AWS access key id added to settings.py/);
  assert.ok(!r.out.includes('QWERTYUIOP123456'));
});

test('--fail-on blocked exits 2 when the verdict is blocked', () => {
  assert.equal(run('case', '--fail-on', 'blocked').code, 2);
  assert.equal(run('case', '--fail-on=blocked').code, 2);
});

test('--json is machine readable', () => {
  const j = JSON.parse(run('case', '--json').out) as { verdict: { tone: string }; case: { findings: Array<{ id: string }> } };
  assert.equal(j.verdict.tone, 'blocked');
  assert.ok(j.case.findings.length >= 1);
});

test('show, replay, brief, timeline, cases and resolve work end to end', () => {
  const id = (JSON.parse(run('case', '--json').out) as { case: { findings: Array<{ id: string; evidence: Array<{ id: string }> }> } }).case.findings[0];
  const show = run('show', id.id);
  assert.equal(show.code, 0);
  assert.match(show.out, /observed/);
  assert.match(show.out, /assay replay f-/);
  assert.ok(!show.out.includes('QWERTYUIOP123456'));
  const replay = run('replay', id.evidence[0].id);
  assert.equal(replay.code, 0);
  assert.match(replay.out, /reproduced/);
  assert.match(run('brief').out, /MUST FIX/);
  assert.match(run('timeline').out, /Add settings/);
  assert.match(run('cases').out, /c-[0-9a-f]{7}-/);
  assert.equal(run('resolve', id.id, 'dismissed').code, 0);
  assert.equal(run('case', '--fail-on', 'blocked').code, 0, 'dismissed by a person, so it no longer blocks');
  assert.equal(run('resolve', id.id, 'reopen').code, 0);
});

test('report writes one HTML file with no secret in it', () => {
  const file = path.join(out, 'case.html');
  const r = run('report', '--out', file);
  assert.equal(r.code, 0);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<title>/);
  assert.match(html, /Blocked: 1 proven problem/);
  assert.ok(!html.includes('QWERTYUIOP123456'));
  assert.ok(html.includes('font/woff2'), 'the fonts are embedded');
});

test('errors are one clear line and exit 1', () => {
  const bad = run('case', 'nope');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /error: .*not a commit/);
  const opt = run('case', '-x..HEAD');
  assert.equal(opt.code, 1, 'something that looks like an option is refused before it reaches git');
  assert.match(opt.err, /not a commit/);
  assert.equal(run('wat').code, 1);
});

/* ---- proof: a real little project with a real test suite ---- */
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-proj-'));
const pg = (...a: string[]): string => execFileSync('git', ['-C', proj, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
pg('init', '-q', '-b', 'main');
pg('config', 'commit.gpgsign', 'false');
fs.mkdirSync(path.join(proj, 'src'));
fs.mkdirSync(path.join(proj, 'test'));
fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"p","type":"module","scripts":{"test":"node --test"}}\n');
fs.writeFileSync(path.join(proj, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
fs.writeFileSync(path.join(proj, 'test', 'add.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add adds two numbers', () => { assert.equal(add(2, 3), 5); });\n");
pg('add', '-A'); pg('commit', '-q', '-m', 'Base');
const baseSha = pg('rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(proj, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
pg('add', '-A'); pg('commit', '-q', '-m', 'Refactor add');
const runProj = (...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [bin, ...args, '--repo', proj], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('prove is refused until a person runs allow-run, which says exactly what it will do', () => {
  const refused = runProj('prove', `${baseSha}..HEAD`);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /assay allow-run/);
  const allowed = runProj('allow-run', '--timeout', '120');
  assert.equal(allowed.code, 0);
  assert.match(allowed.out, /Test command\s+npm test/);
  assert.match(allowed.out, /never changes your repository/);
});

test('prove runs the project’s tests at base and head and blocks on the regression it finds', () => {
  const r = runProj('prove', `${baseSha}..HEAD`, '--no-mutation', '--no-revert', '--fail-on', 'blocked');
  assert.equal(r.code, 2, r.err);
  assert.match(r.out, /Proof\s+npm test/);
  assert.match(r.out, /base passed/);
  assert.match(r.out, /head failed/);
  assert.match(r.out, /regression\s+add adds two numbers/);
  assert.match(r.out, /Blocked: 1 proven problem/);
  assert.match(r.out, /Tests that passed before this range now fail/);
  const again = runProj('prove', `${baseSha}..HEAD`, '--no-mutation', '--no-revert');
  assert.match(again.out, /from the cache/);
  assert.equal(execFileSync('git', ['-C', proj, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'the repository was only read');
});

test('allow-run --off turns it off again', () => {
  assert.equal(runProj('allow-run', '--off').code, 0);
  assert.equal(runProj('prove', `${baseSha}..HEAD`).code, 1);
});

/* ---- the browser: a static page whose head breaks the mirrored layout ---- */
const web = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-web-'));
const wg = (...a: string[]): string => execFileSync('git', ['-C', web, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
wg('init', '-q', '-b', 'main');
wg('config', 'commit.gpgsign', 'false');
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
fs.writeFileSync(path.join(web, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="s.css"></head><body><div class="i"><img class="t" alt="" src="${gif}"><span class="p">$24</span></div></body></html>`);
fs.writeFileSync(path.join(web, 's.css'), '.i{position:relative;display:flex;padding:12px}.t{width:48px;height:48px}.p{position:absolute;top:12px;inset-inline-end:12px}\n');
wg('add', '-A'); wg('commit', '-q', '-m', 'Base');
const webBase = wg('rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(web, 's.css'), '.i{position:relative;display:flex;padding:12px}.t{width:48px;height:48px}.p{position:absolute;top:12px;right:12px}\n');
wg('add', '-A'); wg('commit', '-q', '-m', 'Restyle');
const runWeb = (...args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [bin, ...args, '--repo', web], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const browserHere = !!(await import('@assay/core')).findBrowser();
const bt = browserHere ? test : test.skip;

bt('look is refused until allowed, then opens the pages in a real browser and finds the mirrored-layout problem', () => {
  assert.equal(runWeb('look', `${webBase}..HEAD`).code, 1);
  const allowed = runWeb('allow-run');
  assert.match(allowed.out, /Browser\s+\S/);
  assert.match(allowed.out, /Dev server/);
  const r = runWeb('look', `${webBase}..HEAD`, '--no-probe');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Browser\s+[^\n·]+ · the HTML files as they are/); // a browser's name can have spaces ("Google Chrome")
  assert.match(r.out, /new problems\s+1 measured at the head/);
  assert.match(r.out, /Things overlap on \/ when mirrored \(right to left\)/);
  assert.match(r.out, /look different/);
});

bt('the report carries a before and after you can slide', () => {
  const file = path.join(out, 'web.html');
  assert.equal(runWeb('report', `${webBase}..HEAD`, '--out', file).code, 0);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /Before and after/);
  assert.match(html, /data:image\/jpeg;base64,/);
  assert.match(html, /Browser|Things overlap/);
});

test('memory: packs, switching, a pattern added by hand showing up in a case, and learning from history', () => {
  const mem = (...a: string[]): { code: number | null; out: string; err: string } => run('memory', ...a);
  assert.match(mem().out, /standard entries on/);
  assert.match(mem('packs').out, /OWASP Top 10 \(2025\)/);
  assert.match(mem('show', 'owasp-top10/a05-html').out, /Untrusted text inserted as HTML/);
  assert.match(mem('list', '--kind', 'questions').out, /review-questions\/money-float/);
  assert.match(mem('pack', 'review-questions', 'off').out, /review-questions: off/);
  assert.ok(!/money-float/.test(mem('list', '--kind', 'questions').out), 'a pack that is off is not listed');
  assert.match(mem('pack', 'review-questions', 'on').out, /on/);
  assert.match(mem('questions', '--langs', 'Python').out, /floating point/);

  const unknown = mem('show', 'nope/nope');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /There is no entry/);
  assert.match(mem('add', '--name', 'Loops', '--pattern', '(a+)+').err, /repeat/, 'a pattern that could hang is refused');
  assert.match(mem('pack', 'owasp-top10', 'sideways').err, /on\|off/);

  // a pattern by hand, then a commit that matches it
  const hand = mem('add', '--name', 'The old api is going', '--pattern', 'old_api\\.fetch_all\\(', '--langs', 'Python', '--good', 'new_api.list(…)');
  assert.match(hand.out, /Added L-1/, hand.err);
  fs.writeFileSync(path.join(dir, 'src.py'), 'rows = old_api.fetch_all(1)\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Use the api');
  const c = run('case', '--last', '1');
  assert.match(c.out, /The old api is going/);
  assert.match(mem('show', 'L-1').out, /Seen       1 time/);
  assert.match(mem('remove', 'L-1').out, /L-1: removed/);
  assert.ok(!/The old api is going/.test(run('case', '--last', '1').out));

  // learning from the history of a project that has been bitten before
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-hist-'));
  const hg = (...a: string[]): void => { execFileSync('git', ['-C', h, ...a], { env, stdio: 'ignore' }); };
  hg('init', '-q', '-b', 'main'); hg('config', 'commit.gpgsign', 'false');
  const page = (n: string, fn: string): string => `export function ${n}(view, items) {\n  return view.${fn}(items);\n}\n`;
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(h, `${n}.js`), page(n, 'legacyTotals'));
  hg('add', '-A'); hg('commit', '-q', '-m', 'Totals');
  for (const n of ['a', 'b', 'c']) { fs.writeFileSync(path.join(h, `${n}.js`), page(n, 'totals')); hg('add', '-A'); hg('commit', '-q', '-m', `fix: ${n} was stale`); }
  const mined = spawnSync(process.execPath, [bin, 'memory', 'mine', '--repo', h], { env, encoding: 'utf8' });
  assert.equal(mined.status, 0, mined.stderr);
  assert.match(mined.stdout, /3 are fixes/);
  assert.match(mined.stdout, /worth it\s+\.legacyTotals\(/);
  assert.match(mined.stdout, /usually replaced by \.totals\(/);
  assert.match(mined.stdout, /nothing is added until you do/);
  const id = /(m-[0-9a-f]{8})/.exec(mined.stdout)![1];
  assert.equal(spawnSync(process.execPath, [bin, 'memory', 'list', '--kind', 'learned', '--repo', h], { env, encoding: 'utf8' }).stdout.trim().startsWith('Nothing here'), true, 'mining added nothing');
  const added = spawnSync(process.execPath, [bin, 'memory', 'add', id, '--repo', h], { env, encoding: 'utf8' });
  assert.match(added.stdout, /Added L-\d+/, 'ids are kept across projects, so this one is not L-1');
  assert.match(spawnSync(process.execPath, [bin, 'memory', 'list', '--kind', 'learned', '--repo', h], { env, encoding: 'utf8' }).stdout, /Fixed before: \.legacyTotals\( → \.totals\(/);
});

test('doctor says whether memory is available', () => {
  assert.match(spawnSync(process.execPath, [bin, 'doctor'], { env, encoding: 'utf8' }).stdout, /memory\s+.*memory\.db/);
});

test('reviewers: the plan and its cost first (nothing kept), then a kept plan, a brief to paste, and where it stands', () => {
  const p = run('reviewers', '--budget', '40k');
  assert.equal(p.code, 0, p.err);
  assert.match(p.out, /Reviewer panel for case c-/);
  assert.match(p.out, /budget 40k tokens/);
  assert.match(p.out, /RUN\s+Security/);
  assert.match(p.out, /Nothing is kept/);
  assert.match(run('status').out + run('reviewers', 'status').out, /No panel is planned/);
  assert.match(run('reviewers', '--budget', 'free').out, /free checks only/);
  assert.match(run('reviewers', 'budget').out, /budget for this project is 40000 tokens/);
  assert.match(run('reviewers', 'budget', '20k').out, /now 20000 tokens/);
  assert.match(run('reviewers').out, /budget 20k tokens/, 'the project setting is what a plan uses by default');
  assert.match(run('reviewers', 'budget', '40k').out, /now 40000 tokens/);
  assert.match(run('reviewers', '--budget', 'lots').err, /--budget is a number of tokens/);

  const kept = run('reviewers', 'plan', '--budget', '40000', '--request', 'Add the settings file');
  assert.match(kept.out, /Kept with the case/);
  assert.match(kept.out, /RUN\s+Triage/);
  assert.match(run('reviewers', 'status').out, /Where it stands: waiting/);

  const brief = run('reviewers', 'brief', 'security');
  assert.equal(brief.code, 0, brief.err);
  assert.match(brief.out, /REVIEWER BRIEF · Security/);
  assert.match(brief.out, /── config\/settings\.py/);
  assert.ok(!brief.out.includes('QWERTYUIOP123456'), 'a secret is never in a brief, even one you paste yourself');
  assert.match(run('reviewers', 'brief', 'astrology').err, /no reviewer called/);
  assert.match(run('reviewers', 'brief').err, /Which reviewer/);
  const asJson = JSON.parse(run('reviewers', 'status', '--json').out) as { panel: { reviewers: Array<{ lens: string; state: string }> }; status: { phase: string } };
  assert.equal(asJson.status.phase, 'waiting', 'nobody has said they are done');
  assert.equal(asJson.panel.reviewers.find(r => r.lens === 'Security')!.state, 'briefed', 'but the security reviewer has its brief');
  assert.ok(asJson.panel.reviewers.length === 7);
});

test('the stop hook reads the agent’s JSON, answers with JSON, and prints how to install it without touching your settings', () => {
  const inst = spawnSync(process.execPath, [bin, 'hook', 'install'], { env, encoding: 'utf8' });
  assert.equal(inst.status, 0);
  assert.match(inst.stdout, /"Stop"/);
  assert.match(inst.stdout, /hook stop/);
  assert.match(inst.stdout, /Assay does not edit your settings/);

  const hook = (cwd: string, ...more: string[]): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [bin, 'hook', 'stop', ...more], { env, encoding: 'utf8', input: JSON.stringify({ cwd, session_id: `cli-${cwd.length}` }) });
    return { code: r.status, out: r.stdout.trim() };
  };
  const quiet = hook(dir);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out, '', 'the default branch has no branch to review: it says nothing and lets the agent stop');

  const feat = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-cli-feat-'));
  const fg = (...a: string[]): void => { execFileSync('git', ['-C', feat, ...a], { env, stdio: 'ignore' }); };
  fg('init', '-q', '-b', 'main'); fg('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(feat, 'README.md'), '# feat\n');
  fg('add', '-A'); fg('commit', '-q', '-m', 'Base');
  fg('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(feat, 'prod.py'), `KEY = "${SECRET}"\n`);
  fg('add', '-A'); fg('commit', '-q', '-m', 'Add prod key');
  const blocked = hook(feat);
  assert.equal(blocked.code, 0, 'the hook answers with JSON, not with an exit code');
  const j = JSON.parse(blocked.out) as { decision: string; reason: string };
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /Assay: not done yet/);
  assert.match(j.reason, /Blocked: 1 proven problem/);
  assert.ok(!blocked.out.includes('QWERTYUIOP123456'));
});

test('calibrate: what would be planted, a run scored on the spot, the prompt for the agent, and the scoreboard again', () => {
  const pre = run('calibrate');
  assert.equal(pre.code, 0, pre.err);
  assert.match(pre.out, /would plant \d+ bugs in a throwaway repository shaped like this project/);
  assert.match(pre.out, /Security\s+Database query built from a user id/);
  assert.match(pre.out, /nothing is spent until your agent runs the reviewers/);

  const start = run('calibrate', 'start');
  assert.equal(start.code, 0, start.err);
  assert.match(start.out, /bugs planted/);
  assert.match(start.out, /Free checks alone: \d+ caught with proof, \d+ more flagged, \d+ missed, at 0 tokens/);
  assert.match(start.out, /No false alarms on the clean twins/);
  assert.match(start.out, /The reviewers have not been run yet/);
  assert.match(start.out, /Review two cases with Assay's reviewer panel/);
  assert.match(start.out, /don't read anything under ~\/\.assay\/calibration/);
  const id = /(cal-[0-9a-f]{8})/.exec(start.out)![1];
  assert.ok(!start.out.includes('QWERTYUIOP123456'));

  const score = run('calibrate', 'score');
  assert.match(score.out, new RegExp(id));
  assert.match(score.out, /Free checks \(no model\)/);
  assert.match(score.out, /Planted bug\s+Free\s+Sec\s+Cor/);
  const j = JSON.parse(run('calibrate', 'score', id, '--json').out) as { planted: number; rows: Array<{ id: string }>; complete: boolean };
  assert.ok(j.planted >= 4);
  assert.equal(j.rows[0].id, 'free');
  assert.equal(j.complete, false);
  assert.match(run('calibrate', 'score', 'cal-00000000').err, /no calibration run cal-00000000/);
  assert.match(run('calibrate', 'sideways').err, /Unknown calibrate command/);
  assert.match(run('calibrate', 'clean', '--all').out, /Removed \d+ throwaway/);
  assert.match(run('calibrate', 'score').err, /no calibration run yet/);
  assert.match(run('reviewers', '--include', 'ui,security').out, /Reviewer panel/);
});

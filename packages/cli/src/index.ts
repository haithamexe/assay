#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assayPath, briefOf, checkupFails, listCheckups, runCheckup, detectCommand, doctor, findBrowser, findingById, GitError, listCases, loadCase, lookCase, openCase, proveCase, replayEvidence, repoRoot, repoSettings, reportHTML, resolveFinding, runAttack, attackFails, runTry, tryFails, runGremlins, replayGremlins, listGremlinRuns, loadGremlinRun, gremlinsFail, sessionFromEnv, runTests, setRepoSettings, timeline, verdictOf, writeFileAtomic } from '@assay/core';
import { startDashboard } from '@assay/web';
import type { Case, CheckupCheck, Finding } from '@assay/core';
import { attackText, tryText, gremlinsText, gremlinsListText, replayText, bold, caseText, checkupText, dim, findingText, green, lookText, proofText, red, testText, timelineText, yellow } from './format.js';
import { runMemory } from './memory.js';
import { runCalibrate } from './calibrate.js';
import { runHook, runReviewers } from './reviewers.js';

const VALUE_FLAGS = new Set(['repo', 'last', 'max', 'limit', 'ref', 'case', 'out', 'fail-on', 'command', 'timeout', 'mutants', 'reverts', 'budget', 'serve', 'pages', 'browser', 'port', 'kind', 'name', 'pattern', 'langs', 'good', 'bad', 'ref', 'request', 'round', 'page', 'max-blocks', 'include', 'url', 'har', 'flow', 'openapi', 'match', 'files', 'seed', 'actions', 'base', 'finding']);

interface Args { pos: string[]; flags: Record<string, string | true> }
function parse(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[k] = inline;
    else if (VALUE_FLAGS.has(k) && argv[i + 1] !== undefined) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { pos, flags };
}
const str = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
const num = (a: Args, k: string): number | undefined => { const v = str(a, k); return v === undefined ? undefined : Number(v); };

const HELP = `${bold('assay')}  evidence-first code review

  assay case [range]          review a branch or a range; free checks only, 0 tokens
  assay timeline              what the free checks found on each recent commit
  assay checkup               the project as it is, not a change: what is wrong now, and what is new since the last checkup
  assay secrets               only the keys, key files and .env files committed in tracked files
  assay show <finding>        one finding: the lines, the evidence, how to replay it
  assay brief [range]         the short fix brief an agent should receive
  assay allow-run             let assay run THIS repository's own tests (off until you say so)
  assay attack --url <address>  a security pass on your running app: headers, cookies, CORS, script in the address, error answers (--writes for more)
  assay gremlins              a browser clicks and types nonsense through your app, seeded, with the steps that broke it (needs  assay allow-run --writes)
  assay gremlins list|show <run>|replay <run>  the runs kept, one of them, or its recorded steps done again exactly
  assay try <package>[@version]  install a new version of one package in a throwaway copy and see what breaks or changes (needs  assay allow-run --network)
  assay test                  run this project's own tests once: each failure with its file and line, and --coverage
  assay prove [range]         run the tests at base and head, try reverting and mutating the change
  assay look [range]          open the pages in a real browser at base and head: measure, probe, before and after
  assay replay <evidence>     run a check again from scratch and say if it reproduces
  assay report [range]        write a one-file HTML case file (--open to view it)
  assay dashboard             the timeline, case file and proof in your browser (--port <n> --open)
  assay resolve <finding> dismissed|intended|reopen
  assay calibrate             plant known bugs, score the free checks and each reviewer, leave out the ones that don't earn their tokens (assay calibrate help)
  assay reviewers             who is worth their tokens for this case: the panel plan, a reviewer's brief (assay reviewers help)
  assay hook stop|install     a Stop hook that blocks "done" while the verdict is Blocked
  assay memory                what Assay remembers: standards packs, mistakes, what history teaches (assay memory help)
  assay cases                 the cases kept so far
  assay doctor                what is installed and what isn't
  assay mcp                   how to add the MCP server to Claude Code

  range     nothing = this branch since it left main (or the last 5 commits)
            A..B = B since A    ·    A...B = B since they met    ·    one commit = just that commit
  options   --repo <dir>  --last <n>  --max <n>  --json  --all  --fresh  --fail-on blocked|mergeable
  prove     --mutants <n> (8)  --reverts <n> (3)  --budget <seconds> (600)  --no-mutation  --no-revert  --no-bisect  --no-behaviour
  look      --pages "/,/cart"  --no-probe  --no-screens  --no-speed  --budget <seconds> (300)
  checkup   --url http://localhost:3000  --pages "/,/cart"  --har <file>  --flow <file>  --openapi <file>  --ref <commit>
            --fail-on new|any  --no-save  ·  assay checkup list
  attack    --url http://localhost:3000 (required, this computer only)  --pages "/,/cart"  --har <file>  --openapi <file>  --ref <commit>
            --writes (saved script, CSRF, wrong passwords: needs  assay allow-run --writes)  --no-browser  --fail-on high|medium|low
            a session for signed-in checks goes in ASSAY_SESSION_COOKIE or ASSAY_SESSION_AUTHORIZATION (ASSAY_ATTACK_* work too), never on the command line
  gremlins  --url http://localhost:3000 (an app already running)  or  --ref <commit> [--base <commit>] (Assay starts the project's app in a clean copy;
            with --base the same seed runs there too and only what is new is reported)  --actions <n> (40)  --seed <n>  --page /cart  --phone  --bold  --fail-on high|medium|low  --no-save
            signed in: a session in ASSAY_SESSION_COOKIE or ASSAY_SESSION_AUTHORIZATION, with --url only  ·  replay <run> [--finding g-…] [--url <address>]
  try       <package>[@version]  --ref <commit>  --pages "/,/cart"  --no-pages (skip the browser)  --no-tests  --scripts (let install scripts run)  --fail-on breaks|changes
  test      --match "<test name>"  --files "a.test.js,b.test.js"  --coverage  --ref <commit>  --timeout <seconds>
            --here (your own folder, uncommitted work included; needs  assay allow-run --here)  --changed (with --here)
  allow-run --command "<your test command>"  --timeout <seconds> (300)  --off
            --serve "<dev server command>"  --pages "/,/cart"  --browser <path to Chrome, Edge, Brave or Chromium>
            --here (assay test may also run in this folder, uncommitted work included)
            --writes (assay attack and assay gremlins may send requests that change data)
            --network (assay try may let the package manager reach its registry)
`;

function load(a: Args): Case {
  return openCase({ repo: str(a, 'repo') ?? process.cwd(), range: a.pos[1], last: num(a, 'last'), max: num(a, 'max'), fresh: a.flags.fresh === true });
}

/** A finding or evidence id, as printed (with or without the f- prefix), in the named case or the newest case that has it. */
function find(a: Args, id: string): { c: Case; f: Finding } {
  const fid = id.replace(/\.\d+$/, '');
  const named = str(a, 'case');
  const ids = named ? [named] : listCases().map(x => x.id);
  for (const cid of ids) {
    const c = loadCase(cid);
    const f = c && findingById(c, fid);
    if (c && f) return { c, f };
  }
  throw new Error(`No finding ${id} in any kept case or checkup. Run assay case or assay checkup first.`);
}

/** A finding from a checkup of this repository (newest first), by its id or its key. */
function findInCheckup(a: Args, id: string): ReturnType<typeof listCheckups>[number]['findings'][number] | null {
  const fid = id.replace(/\.\d+$/, '');
  try {
    for (const c of listCheckups(str(a, 'repo') ?? process.cwd())) {
      const f = c.findings.find(x => x.id === fid || x.id === `f-${fid}` || x.key === fid);
      if (f) return f;
    }
  } catch { /* not in a repository: there are no checkups to look in */ }
  return null;
}

function open(file: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch { /* the path is printed anyway */ }
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const cmd = a.pos[0] ?? 'help';
  const json = a.flags.json === true;
  if (cmd === 'help' || a.flags.help) { console.log(HELP); return; }
  if (cmd === 'case') {
    const c = load(a);
    const v = verdictOf(c);
    if (json) console.log(JSON.stringify({ case: c, verdict: { tone: v.tone, headline: v.headline, must: v.must.length, should: v.should.length, decide: v.decide.length, hints: v.hints.length } }, null, 2));
    else console.log(caseText(c, v, a.flags.all === true));
    const gate = str(a, 'fail-on');
    if ((gate === 'blocked' && v.tone === 'blocked') || (gate === 'mergeable' && v.tone !== 'clear')) process.exitCode = 2;
    return;
  }
  if (cmd === 'checkup' || cmd === 'secrets') {
    const repo = str(a, 'repo') ?? process.cwd();
    if (cmd === 'checkup' && a.pos[1] === 'list') {
      const rows = listCheckups(repo);
      console.log(json ? JSON.stringify(rows.map(r => ({ id: r.id, head: r.head, createdAt: r.createdAt, summary: r.summary })), null, 2)
        : rows.length ? rows.map(r => `${r.id}  ${r.head.slice(0, 7)}  ${r.summary.proven} proven  ${r.summary.corroborated} to decide  ${r.summary.new} new  ${dim(r.createdAt.slice(0, 16))}`).join('\n') : dim('No checkups yet. Run assay checkup in a repository.'));
      return;
    }
    if (a.pos[1]) throw new Error(`assay ${cmd} takes no "${a.pos[1]}". Try: assay ${cmd} --help`);
    const c = runCheckup({
      repo, ref: str(a, 'ref'), url: str(a, 'url'), pages: str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean),
      har: str(a, 'har'), flow: str(a, 'flow'), openapi: str(a, 'openapi'), save: a.flags['no-save'] !== true,
      ...(cmd === 'secrets' ? { checks: ['secrets'] as CheckupCheck[], inventory: false } : {})
    });
    console.log(json ? JSON.stringify(c, null, 2) : checkupText(c, a.flags.all === true));
    const gate = str(a, 'fail-on');
    if (gate && gate !== 'new' && gate !== 'any') throw new Error('--fail-on for a checkup is new or any.');
    if (gate && checkupFails(c, gate as 'new' | 'any')) process.exitCode = 2;
    return;
  }
  if (cmd === 'timeline') {
    const rows = timeline({ repo: str(a, 'repo') ?? process.cwd(), ref: str(a, 'ref') ?? a.pos[1], limit: num(a, 'limit'), fresh: a.flags.fresh === true });
    console.log(json ? JSON.stringify(rows, null, 2) : timelineText(rows));
    return;
  }
  if (cmd === 'show') {
    if (!a.pos[1]) throw new Error('Which finding? assay show <id>');
    const fromCheckup = (() => { try { find(a, a.pos[1]); return null; } catch { return findInCheckup(a, a.pos[1]); } })();
    if (fromCheckup) { console.log(json ? JSON.stringify(fromCheckup, null, 2) : findingText({ resolved: {} }, fromCheckup, () => `assay checkup --ref ${fromCheckup.commit.slice(0, 7)}`)); return; }
    const { c, f } = find(a, a.pos[1]);
    console.log(json ? JSON.stringify(f, null, 2) : findingText(c, f));
    return;
  }
  if (cmd === 'brief') {
    console.log(briefOf(load(a), a.pos[1]));
    return;
  }
  if (cmd === 'replay') {
    if (!a.pos[1]) throw new Error('Which evidence? assay replay <evidence id>');
    const { c } = find(a, a.pos[1]);
    const r = await replayEvidence(c, a.pos[1].startsWith('f-') ? a.pos[1] : `f-${a.pos[1]}`);
    console.log(json ? JSON.stringify(r, null, 2) : `${r.reproduced ? green('reproduced') : red('not reproduced')}  ${r.detail}`);
    if (!r.reproduced) process.exitCode = 1;
    return;
  }
  if (cmd === 'allow-run') {
    const root = repoRoot(str(a, 'repo') ?? process.cwd());
    if (a.flags.off) { setRepoSettings(root, { allow: false, here: false, writes: false, network: false }); console.log(`${root}: assay will not run anything here.`); return; }
    const command = str(a, 'command');
    const timeout = num(a, 'timeout');
    const found = detectCommand(root, command);
    const pages = str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean);
    setRepoSettings(root, { allow: true, command, timeout, serve: str(a, 'serve'), pages, browser: str(a, 'browser'), here: a.flags.here === true ? true : undefined, writes: a.flags.writes === true ? true : undefined, network: a.flags.network === true ? true : undefined });
    const s = repoSettings(root);
    const exe = findBrowser(s.browser);
    console.log(`${bold('Allowed')} for ${root}\n`);
    console.log(found ? `  Test command   ${found.label}` : `  Test command   ${yellow('none found')}: give one with  assay allow-run --command "<your test command>"`);
    console.log(`  Time limit     ${s.timeout ?? 300} seconds per run`);
    console.log(`  Dev server     ${s.serve ?? dim('found from package.json (dev or start); plain HTML files are served as they are')}`);
    console.log(`  Pages          ${s.pages?.join(', ') ?? dim('the HTML files a range changes, or / for a dev server')}`);
    console.log(`  Your folder    ${s.here ? 'assay test --here may run the tests in this folder, uncommitted work included' : dim('assay test runs in a clean copy; add --here to let it run in this folder too')}`);
    console.log(`  Data-changing  ${s.writes ? 'assay attack --writes and assay gremlins may send requests that change data' : dim('assay attack only reads and assay gremlins won’t run; add --writes to let them save text, forge a request, try wrong passwords, click and type')}`);
    console.log(`  Registry       ${s.network ? 'assay try may let the package manager reach its registry' : dim('assay try won’t run; add --network to let the package manager install a version in a throwaway copy')}`);
    console.log(`  Browser        ${exe ?? yellow('none found')}${exe ? '' : ': install Chrome, Edge, Brave or Chromium, or point at one with --browser <path>'}\n`);
    console.log(dim('When you run assay test, prove or look (or an agent calls them), assay will run that command or dev server in clean copies of commits under'));
    console.log(dim(`${assayPath('work')} and delete them after. It never changes your repository. Turn it off again with  assay allow-run --off`));
    return;
  }
  if (cmd === 'attack') {
    if (a.pos[1]) throw new Error(`assay attack takes no "${a.pos[1]}". Give the app’s address with --url.`);
    const url = str(a, 'url');
    if (!url) throw new Error('Which app? assay attack --url http://localhost:3000  (an app running on this computer: Assay doesn’t start it)');
    const gate = str(a, 'fail-on');
    if (gate && !['high', 'medium', 'low'].includes(gate)) throw new Error('--fail-on for an attack is high, medium or low.');
    const session = sessionFromEnv();
    const r = await runAttack({
      repo: str(a, 'repo') ?? process.cwd(), url, ref: str(a, 'ref'), pages: str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean),
      har: str(a, 'har'), flow: str(a, 'flow'), openapi: str(a, 'openapi'), writes: a.flags.writes === true, browser: !a.flags['no-browser'],
      session,
      onProgress: m => { if (!json) console.error(dim(m)); }
    });
    console.log(json ? JSON.stringify(r, null, 2) : attackText(r, a.flags.all === true));
    if (gate && attackFails(r, gate as 'high' | 'medium' | 'low')) process.exitCode = 2;
    return;
  }
  if (cmd === 'try') {
    const given = a.pos[1];
    if (!given) throw new Error('Which package? assay try react  or  assay try react@19');
    const at = given.lastIndexOf('@');
    const pkgName = at > 0 ? given.slice(0, at) : given;
    const version = at > 0 ? given.slice(at + 1) : undefined;
    const gate = str(a, 'fail-on');
    if (gate && !['breaks', 'changes'].includes(gate)) throw new Error('--fail-on for try is breaks or changes.');
    const r = await runTry({
      repo: str(a, 'repo') ?? process.cwd(), package: pkgName, version, ref: str(a, 'ref'), pages: str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean),
      browser: !a.flags['no-pages'], tests: !a.flags['no-tests'], scripts: a.flags.scripts === true, onProgress: m => { if (!json) console.error(dim(m)); }
    });
    console.log(json ? JSON.stringify(r, null, 2) : tryText(r));
    if (gate && tryFails(r, gate as 'breaks' | 'changes')) process.exitCode = 2;
    return;
  }
  if (cmd === 'gremlins') {
    const sub = a.pos[1];
    if (sub === 'list') {
      const runs = listGremlinRuns(str(a, 'repo') ?? process.cwd());
      console.log(json ? JSON.stringify(runs.map(r => ({ id: r.id, createdAt: r.createdAt, mode: r.mode, url: r.url ?? null, commit: r.commit, seed: r.seed, findings: r.findings.length })), null, 2) : gremlinsListText(runs));
      return;
    }
    if (sub === 'show') {
      const r = a.pos[2] ? loadGremlinRun(str(a, 'repo') ?? process.cwd(), a.pos[2]) : listGremlinRuns(str(a, 'repo') ?? process.cwd())[0];
      if (!r) throw new Error(a.pos[2] ? `There is no kept run "${a.pos[2]}". assay gremlins list shows them.` : 'No gremlins runs kept yet.');
      console.log(json ? JSON.stringify(r, null, 2) : gremlinsText(r, a.flags.all === true));
      return;
    }
    if (sub === 'replay') {
      if (!a.pos[2]) throw new Error('Which run? assay gremlins replay <run>  (assay gremlins list shows them)');
      const r = await replayGremlins({ repo: str(a, 'repo') ?? process.cwd(), run: a.pos[2], finding: str(a, 'finding'), url: str(a, 'url'), session: sessionFromEnv(), onProgress: m => { if (!json) console.error(dim(m)); } });
      console.log(json ? JSON.stringify(r, null, 2) : replayText(r));
      if (r.reproduced) process.exitCode = 2;
      return;
    }
    if (sub) throw new Error(`assay gremlins takes list, show or replay, not "${sub}". Give an app that is running with --url, or a commit with --ref.`);
    const gate = str(a, 'fail-on');
    if (gate && !['high', 'medium', 'low'].includes(gate)) throw new Error('--fail-on for gremlins is high, medium or low.');
    const seed = num(a, 'seed');
    if (seed !== undefined && !Number.isFinite(seed)) throw new Error('--seed is a number.');
    const actions = num(a, 'actions');
    if (actions !== undefined && !Number.isFinite(actions)) throw new Error('--actions is a number.');
    const r = await runGremlins({
      repo: str(a, 'repo') ?? process.cwd(), url: str(a, 'url'), ref: str(a, 'ref'), base: str(a, 'base'), actions, seed, page: str(a, 'page'),
      phone: a.flags.phone === true, bold: a.flags.bold === true, session: sessionFromEnv(), save: a.flags['no-save'] !== true, onProgress: m => { if (!json) console.error(dim(m)); }
    });
    console.log(json ? JSON.stringify(r, null, 2) : gremlinsText(r, a.flags.all === true));
    if (gate && gremlinsFail(r, gate as 'high' | 'medium' | 'low')) process.exitCode = 2;
    return;
  }
  if (cmd === 'test') {
    if (a.pos[1]) throw new Error(`assay test takes no "${a.pos[1]}". Filter by name with --match "<test name>", or by file with --files.`);
    const r = await runTests({
      repo: str(a, 'repo') ?? process.cwd(), ref: str(a, 'ref'), here: a.flags.here === true, match: str(a, 'match'),
      files: str(a, 'files')?.split(',').map(s => s.trim()).filter(Boolean), changed: a.flags.changed === true, coverage: a.flags.coverage === true, timeoutSec: num(a, 'timeout'),
      onProgress: m => { if (!json) console.error(dim(m)); }
    });
    console.log(json ? JSON.stringify(r, null, 2) : testText(r, a.flags.all === true));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'prove') {
    const c = load(a);
    const report = await proveCase(c, {
      mutants: a.flags['no-mutation'] ? 0 : num(a, 'mutants'), reverts: a.flags['no-revert'] ? 0 : num(a, 'reverts'), budgetSeconds: num(a, 'budget'), fresh: a.flags.fresh === true, bisect: a.flags['no-bisect'] ? false : undefined, behaviour: a.flags['no-behaviour'] ? false : undefined,
      onProgress: m => { if (!json) console.error(dim(m)); }
    });
    const v = verdictOf(c);
    if (json) console.log(JSON.stringify({ proof: report, verdict: { tone: v.tone, headline: v.headline } }, null, 2));
    else { console.log(proofText(report)); console.log(); console.log(caseText(c, v, a.flags.all === true)); }
    const gate = str(a, 'fail-on');
    if ((gate === 'blocked' && v.tone === 'blocked') || (gate === 'mergeable' && v.tone !== 'clear')) process.exitCode = 2;
    return;
  }
  if (cmd === 'look') {
    const c = load(a);
    const report = await lookCase(c, {
      pages: str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean), probe: !a.flags['no-probe'], screens: !a.flags['no-screens'], speed: !a.flags['no-speed'], budgetSeconds: num(a, 'budget'),
      onProgress: m => { if (!json) console.error(dim(m)); }
    });
    const v = verdictOf(c);
    if (json) console.log(JSON.stringify({ look: report, verdict: { tone: v.tone, headline: v.headline } }, null, 2));
    else { console.log(lookText(report)); console.log(); console.log(caseText(c, v, a.flags.all === true)); }
    const gate = str(a, 'fail-on');
    if ((gate === 'blocked' && v.tone === 'blocked') || (gate === 'mergeable' && v.tone !== 'clear')) process.exitCode = 2;
    return;
  }
  if (cmd === 'dashboard') {
    const root = repoRoot(str(a, 'repo') ?? process.cwd());
    const d = await startDashboard({ repo: root, port: num(a, 'port') });
    console.log(`${bold('assay dashboard')}  ${dim(root)}\n`);
    console.log(`  ${d.url}\n`);
    console.log(dim('Open that address in your browser. It has a key in it that only this run knows, and the dashboard answers on this computer only.'));
    console.log(dim('Press Ctrl+C to stop.'));
    if (a.flags.open) open(d.url);
    await new Promise<void>(resolve => {
      const stop = (): void => { void d.close().then(resolve); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }
  if (cmd === 'report') {
    const c = load(a);
    const out = str(a, 'out') ?? assayPath('reports', `${c.id}.html`);
    writeFileAtomic(path.resolve(out), reportHTML(c));
    console.log(path.resolve(out));
    if (a.flags.open) open(path.resolve(out));
    return;
  }
  if (cmd === 'resolve') {
    const [, id, how] = a.pos;
    if (!id || !['dismissed', 'intended', 'reopen'].includes(how ?? '')) throw new Error('assay resolve <finding> dismissed|intended|reopen');
    const { c, f } = find(a, id);
    resolveFinding(c, f.id, how === 'reopen' ? null : (how as 'dismissed' | 'intended'));
    console.log(`${f.id}: ${how === 'reopen' ? 'open again' : how}`);
    return;
  }
  if (cmd === 'calibrate') {
    console.log(await runCalibrate(a.pos.slice(1), a.flags, str(a, 'repo') ?? process.cwd(), json));
    return;
  }
  if (cmd === 'reviewers') {
    console.log(runReviewers(a.pos.slice(1), a.flags, repoRoot(str(a, 'repo') ?? process.cwd()), json, num(a, 'last')));
    return;
  }
  if (cmd === 'hook') {
    const out = runHook(a.pos.slice(1), a.flags, json);
    if (out) console.log(out);
    return;
  }
  if (cmd === 'memory') {
    console.log(await runMemory(a.pos.slice(1), a.flags, str(a, 'repo') ?? process.cwd(), json));
    return;
  }
  if (cmd === 'cases') {
    const rows = listCases();
    console.log(json ? JSON.stringify(rows, null, 2) : rows.length ? rows.map(r => `${r.id}  ${r.name}  ${r.commits} commits  ${r.findings} findings  ${dim(r.createdAt.slice(0, 16))}`).join('\n') : dim('No cases yet. Run assay case in a repository.'));
    return;
  }
  if (cmd === 'doctor') {
    console.log(doctor().map(r => `${r.ok === true ? green('✓') : r.ok === false ? red('✗') : yellow('·')} ${r.name.padEnd(14)} ${dim(r.note)}`).join('\n'));
    return;
  }
  if (cmd === 'mcp') {
    const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp', 'dist', 'index.js');
    console.log(`Add the MCP server to Claude Code:\n\n  claude mcp add assay -- node "${server}"\n\nTools: case_open, case_findings, finding_get, finding_submit, finding_resolve, evidence_replay, brief, timeline, memory, reviewers_plan, reviewer_brief, prove, look, checkup, test, attack, gremlins, try.`);
    return;
  }
  throw new Error(`Unknown command "${cmd}". Try: assay help`);
}

try {
  await main();
} catch (err) {
  const msg = err instanceof GitError || err instanceof Error ? err.message : String(err);
  console.error(`${red('error')}: ${msg}`);
  if (process.env.ASSAY_DEBUG && err instanceof Error) console.error(err.stack);
  process.exitCode = process.exitCode || 1;
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assayPath, briefOf, detectCommand, doctor, findBrowser, findingById, GitError, listCases, loadCase, lookCase, openCase, proveCase, replayEvidence, repoRoot, repoSettings, reportHTML, resolveFinding, setRepoSettings, timeline, verdictOf, writeFileAtomic } from '@assay/core';
import { startDashboard } from '@assay/web';
import type { Case, Finding } from '@assay/core';
import { bold, caseText, dim, findingText, green, lookText, proofText, red, timelineText, yellow } from './format.js';
import { runMemory } from './memory.js';
import { runCalibrate } from './calibrate.js';
import { runHook, runReviewers } from './reviewers.js';

const VALUE_FLAGS = new Set(['repo', 'last', 'max', 'limit', 'ref', 'case', 'out', 'fail-on', 'command', 'timeout', 'mutants', 'reverts', 'budget', 'serve', 'pages', 'browser', 'port', 'kind', 'name', 'pattern', 'langs', 'good', 'bad', 'ref', 'request', 'round', 'page', 'max-blocks', 'include']);

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
  assay show <finding>        one finding: the lines, the evidence, how to replay it
  assay brief [range]         the short fix brief an agent should receive
  assay allow-run             let assay run THIS repository's own tests (off until you say so)
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
  prove     --mutants <n> (8)  --reverts <n> (3)  --budget <seconds> (600)  --no-mutation  --no-revert  --no-bisect
  look      --pages "/,/cart"  --no-probe  --no-screens  --budget <seconds> (300)
  allow-run --command "<your test command>"  --timeout <seconds> (300)  --off
            --serve "<dev server command>"  --pages "/,/cart"  --browser <path to Chrome, Edge, Brave or Chromium>
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
  throw new Error(`No finding ${id} in any kept case. Run assay case first.`);
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
  if (cmd === 'timeline') {
    const rows = timeline({ repo: str(a, 'repo') ?? process.cwd(), ref: str(a, 'ref') ?? a.pos[1], limit: num(a, 'limit'), fresh: a.flags.fresh === true });
    console.log(json ? JSON.stringify(rows, null, 2) : timelineText(rows));
    return;
  }
  if (cmd === 'show') {
    if (!a.pos[1]) throw new Error('Which finding? assay show <id>');
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
    if (a.flags.off) { setRepoSettings(root, { allow: false }); console.log(`${root}: assay will not run anything here.`); return; }
    const command = str(a, 'command');
    const timeout = num(a, 'timeout');
    const found = detectCommand(root, command);
    const pages = str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean);
    setRepoSettings(root, { allow: true, command, timeout, serve: str(a, 'serve'), pages, browser: str(a, 'browser') });
    const s = repoSettings(root);
    const exe = findBrowser(s.browser);
    console.log(`${bold('Allowed')} for ${root}\n`);
    console.log(found ? `  Test command   ${found.label}` : `  Test command   ${yellow('none found')}: give one with  assay allow-run --command "<your test command>"`);
    console.log(`  Time limit     ${s.timeout ?? 300} seconds per run`);
    console.log(`  Dev server     ${s.serve ?? dim('found from package.json (dev or start); plain HTML files are served as they are')}`);
    console.log(`  Pages          ${s.pages?.join(', ') ?? dim('the HTML files a range changes, or / for a dev server')}`);
    console.log(`  Browser        ${exe ?? yellow('none found')}${exe ? '' : ': install Chrome, Edge, Brave or Chromium, or point at one with --browser <path>'}\n`);
    console.log(dim('When you run assay prove or assay look (or an agent calls them), assay will run that command or dev server in clean copies of commits under'));
    console.log(dim(`${assayPath('work')} and delete them after. It never changes your repository. Turn it off again with  assay allow-run --off`));
    return;
  }
  if (cmd === 'prove') {
    const c = load(a);
    const report = await proveCase(c, {
      mutants: a.flags['no-mutation'] ? 0 : num(a, 'mutants'), reverts: a.flags['no-revert'] ? 0 : num(a, 'reverts'), budgetSeconds: num(a, 'budget'), fresh: a.flags.fresh === true, bisect: a.flags['no-bisect'] ? false : undefined,
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
      pages: str(a, 'pages')?.split(',').map(s => s.trim()).filter(Boolean), probe: !a.flags['no-probe'], screens: !a.flags['no-screens'], budgetSeconds: num(a, 'budget'),
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
    console.log(`Add the MCP server to Claude Code:\n\n  claude mcp add assay -- node "${server}"\n\nTools: case_open, case_findings, finding_get, finding_submit, finding_resolve, evidence_replay, brief, timeline, memory, reviewers_plan, reviewer_brief, prove, look.`);
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

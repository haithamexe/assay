import fs from 'node:fs';
import path from 'node:path';
import { buildFinding } from '../analysis.js';
import type { RawFinding } from '../checks/types.js';
import { redactSecrets } from '../checks/secrets.js';
import { sha } from '../config.js';
import { commitDiff, type FileDiff, type Hunk } from '../diff.js';
import { isSourcePath } from '../lang.js';
import { saveCase } from '../store.js';
import type { Case, Evidence, Finding, RunRecord, Severity } from '../types.js';
import { applyRuns } from './apply.js';
import { applyMutant, mutantsFor, pickMutants, revertHunk, type Mutant } from './mutate.js';
import { showedFailure } from './parse.js';
import { cacheRun, cachedRun, detectCommand, runCommand, type RunResult, type TestCommand } from './runner.js';
import { repoSettings } from './settings.js';
import { exportTree, linkDependencies, removeTree } from './tree.js';

export interface ProveOptions {
  /** How many hunks to try reverting (each costs a test run). Default 3. */
  reverts?: number;
  /** How many deliberate changes to try (each costs a test run). Default 8. */
  mutants?: number;
  /** Stop starting new runs after this long. What was cached is kept, so the next call picks up where this one stopped. Default 600. */
  budgetSeconds?: number;
  /** Run again even where a result is cached. */
  fresh?: boolean;
  /** Stop: the run in progress is killed and nothing from it is kept; what finished before it stays cached. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

interface RunSummary { exit: number | null; secs: number; failed: number; passed: number | null; timedOut: boolean; cached: boolean }
export interface ProofReport {
  ran: boolean;
  reason?: string;
  command: string | null;
  base: RunSummary | null;
  head: RunSummary | null;
  regressions: string[];
  reverts: Array<{ file: string; line: number; result: 'covered' | 'unnoticed' | 'skipped'; why?: string }>;
  mutants: Array<{ file: string; line: number; op: string; result: 'killed' | 'survived' | 'invalid' | 'skipped' }>;
  secs: number;
  stopped?: string;
}

const summary = (r: RunResult, cached: boolean): RunSummary => ({ exit: r.exit, secs: r.secs, failed: r.failedCount ?? r.failed.length, passed: r.passedCount, timedOut: r.timedOut, cached });
const green = (r: RunResult): boolean => r.exit === 0 && !r.timedOut && !r.error;
const rowAt = (f: FileDiff, line: number): boolean => f.hunks.some(h => h.lines.some(l => l.n === line && l.t !== '-'));
const hunkAt = (f: FileDiff, line: number): Hunk | undefined => f.hunks.find(h => h.lines.some(l => l.n === line && l.t === '+'));
const proofId = (head: string, ...parts: string[]): string => `r-${sha([head, ...parts].join('\0'), 8)}`;

/** Where to hang a finding that is about the whole range: a line the failure points at, else the biggest changed source file. */
function anchorFor(net: FileDiff[], refs: Array<{ file: string; line: number }>): { file: FileDiff; line: number } | null {
  for (const r of refs) {
    const f = net.find(x => x.path === r.file || r.file.endsWith(`/${x.path}`) || x.path.endsWith(`/${r.file}`));
    if (f && rowAt(f, r.line)) return { file: f, line: r.line };
  }
  const usable = net.filter(f => !f.binary && f.status !== 'deleted' && f.hunks.length);
  const src = usable.filter(f => isSourcePath(f.path)).sort((a, b) => b.additions - a.additions)[0] ?? usable[0];
  const row = src?.hunks.flatMap(h => h.lines).find(l => l.t === '+' && l.n !== null);
  return src && row && row.n !== null ? { file: src, line: row.n } : null;
}

const textAt = (f: FileDiff, line: number): string => f.hunks.flatMap(h => h.lines).find(l => l.n === line && l.t !== '-')?.text ?? '';

/**
 * Runs the project's own tests, and what follows from them, and turns the results into findings and evidence.
 * Everything runs in clean checkouts under ~/.assay/work: the repository itself is only read.
 * The person must have allowed it (`assay allow-run`); an agent can't.
 */
export async function proveCase(c: Case, opts: ProveOptions = {}): Promise<ProofReport> {
  const settings = repoSettings(c.repo);
  if (!settings.allow) throw new Error('Running this repository’s tests isn’t allowed yet. A person has to turn it on: assay allow-run');
  const started = Date.now();
  const budget = (opts.budgetSeconds ?? 600) * 1000;
  const left = (): number => (opts.signal?.aborted ? 0 : budget - (Date.now() - started));
  const outOfTime = (where: string): string => `${opts.signal?.aborted ? 'stopped by the person' : 'time budget used up'} ${where}`;
  const say = opts.onProgress ?? ((): void => {});
  const timeout = settings.timeout ?? 300;
  const report: ProofReport = { ran: false, command: null, base: null, head: null, regressions: [], reverts: [], mutants: [], secs: 0 };
  const cmd = detectCommand(c.repo, settings.command);
  if (!cmd) { report.reason = 'No test command found. Tell Assay which one: assay allow-run --command "<your test command>"'; return report; }
  report.command = cmd.text;

  const trees: string[] = [];
  let headDir: string | null = null;
  const head = (): string => {
    if (!headDir) { headDir = exportTree(c.repo, c.head, 'head'); trees.push(headDir); linkDependencies(c.repo, headDir); }
    return headDir;
  };
  /** One test run, from the cache if it was asked before. `prepare` changes the checkout first (a revert, a mutant) and returns the original text, or null if it can't. */
  const run = async (commit: string, variant: string, where: () => string, prepare?: () => string | null): Promise<{ r: RunResult; cached: boolean } | 'budget' | 'cannot'> => {
    const hit = opts.fresh ? null : cachedRun(c.repo, commit, variant, cmd.text);
    if (hit) return { r: hit, cached: true };
    if (left() <= 0) return 'budget';
    const dir = where();
    if (prepare && prepare() === null) return 'cannot';
    const r = await runCommand(cmd, dir, { timeoutSec: Math.max(5, Math.min(timeout, Math.ceil(left() / 1000))), signal: opts.signal });
    if (opts.signal?.aborted) return 'budget';
    cacheRun(c.repo, commit, variant, cmd.text, r);
    return { r, cached: false };
  };

  const net = commitDiff(c.repo, c.head, c.base);
  const records: RunRecord[] = [];
  const now = new Date().toISOString();
  const make = (raw: RawFinding): Finding => buildFinding(raw, { commit: c.head, files: net }, 'run');

  try {
    /* 1. the project's tests at the base and at the head */
    const baseDir = (): string => { const d = exportTree(c.repo, c.base!, 'base'); trees.push(d); linkDependencies(c.repo, d); return d; };
    let baseRes: { r: RunResult; cached: boolean } | null = null;
    if (c.base) {
      say(`Running ${cmd.text} at the base ${c.base.slice(0, 7)}…`);
      const got = await run(c.base, 'tests', baseDir);
      if (typeof got === 'object') baseRes = got;
      for (const d of trees.filter(x => x !== headDir)) { removeTree(d); trees.splice(trees.indexOf(d), 1); }
    }
    say(`Running ${cmd.text} at the head ${c.head.slice(0, 7)}…`);
    const headGot = await run(c.head, 'tests', head);
    if (typeof headGot !== 'object') { report.stopped = outOfTime('before the head run'); report.secs = Math.round((Date.now() - started) / 1000); return report; }
    report.ran = true;
    report.base = baseRes ? summary(baseRes.r, baseRes.cached) : null;
    report.head = summary(headGot.r, headGot.cached);
    const hr = headGot.r;
    const headRed = hr.exit !== 0 || (hr.failedCount ?? 0) > 0;
    if (hr.error) { report.reason = `The test command could not start: ${hr.error}`; report.ran = false; return report; }
    if (hr.timedOut) report.reason = `The tests took longer than ${timeout} s at the head, so nothing could be concluded.`;

    const testRec: RunRecord = { id: proofId(c.head, 'tests', cmd.text), kind: 'tests', at: now, secs: hr.secs + (baseRes?.r.secs ?? 0), command: cmd.text, summary: '', findings: [], signals: [] };
    if (baseRes && !hr.timedOut && !baseRes.r.timedOut) {
      const br = baseRes.r;
      const baseNames = new Set(br.failed);
      const names = hr.failed.filter(n => !baseNames.has(n));
      const regressed = green(br) ? headRed : names.length > 0 && showedFailure(hr);
      if (regressed) {
        report.regressions = names.length ? names : ['(the test command failed)'];
        const a = anchorFor(net, hr.refs);
        if (a) {
          const shown = report.regressions.slice(0, 5);
          testRec.findings.push(make({
            check: 'proof', key: 'tests-regression', title: `Tests that passed before this range now fail${names.length ? ` (${names.length})` : ''}`, lens: 'Correctness', severity: 'high',
            file: a.file.path, line: a.line, side: 'added', text: textAt(a.file, a.line),
            evidence: [
              { kind: 'test-fail', source: 'proof:tests', what: `${cmd.text} passed at ${c.base!.slice(0, 7)} and failed at ${c.head.slice(0, 7)}. Failing: ${shown.join('; ')}${report.regressions.length > 5 ? `; and ${report.regressions.length - 5} more` : ''}`, run: { kind: 'tests' } },
              { kind: 'test-fail', source: 'proof:tests-output', what: `The end of the output at ${c.head.slice(0, 7)}: ${hr.tail.split('\n').slice(-6).join(' | ').slice(0, 400)}`, run: { kind: 'tests' } }
            ],
            observed: [`${cmd.text} exited 0 at ${c.base!.slice(0, 7)} and ${hr.exit} at ${c.head.slice(0, 7)}.`, ...shown.map(n => `Failing: ${n}`)],
            inferred: ['One of the changes in this range probably broke it. The timeline shows which commit; Assay can check each one.'], ref: 'Regression'
          }));
        }
      }
    }
    testRec.summary = `${cmd.text}: base ${report.base ? (report.base.exit === 0 ? 'passed' : 'failed') : 'not run'}, head ${headRed ? 'failed' : 'passed'} (${hr.secs} s)`;
    records.push(testRec);

    /* 2 and 3 need a green head: otherwise "no test failed" can't be told from "tests were already failing" */
    const canMutate = green(hr);
    if (!canMutate && !report.reason) report.reason = 'The tests already fail at the head, so reverting and mutating can’t be judged. Fix those first.';

    /* 2. the revert test: put a risky hunk back and see whether any test notices */
    const wantReverts = opts.reverts ?? 3;
    const revRec: RunRecord = { id: proofId(c.head, 'revert', cmd.text), kind: 'revert', at: now, secs: 0, command: cmd.text, summary: '', findings: [], signals: [] };
    if (canMutate && wantReverts > 0) {
      const seen = new Set<string>();
      const targets = c.findings
        .filter(f => f.origin === 'check' && f.present !== false && f.anchor.side === 'added' && f.tier !== 'proven' && f.severity !== 'low' && isSourcePath(f.file))
        .sort((a, b) => b.risk - a.risk);
      for (const f of targets) {
        if (report.reverts.length >= wantReverts) break;
        const file = net.find(x => x.path === f.file);
        const hunk = file && hunkAt(file, f.line);
        if (!file || !hunk) continue;
        const key = `${file.path}:${hunk.newStart}`;
        if (seen.has(key)) continue;
        seen.add(key);
        say(`Reverting ${file.path} lines ${hunk.newStart}–${hunk.newStart + hunk.newLines - 1} and running the tests…`);
        const dir = head();
        const mod: { text: string | null } = { text: null };
        const got = await run(c.head, `revert:${key}`, () => dir, () => (mod.text = revertHunk(dir, file.path, hunk)));
        if (mod.text !== null) fs.writeFileSync(path.join(dir, file.path), mod.text);
        if (got === 'budget') { report.stopped = outOfTime('during the revert tests'); break; }
        if (got === 'cannot') { report.reverts.push({ file: file.path, line: f.line, result: 'skipped', why: 'the hunk no longer applies cleanly' }); continue; }
        revRec.secs += got.cached ? 0 : got.r.secs;
        if (got.r.timedOut) { report.reverts.push({ file: file.path, line: f.line, result: 'skipped', why: 'the tests timed out' }); continue; }
        if (showedFailure(got.r)) { report.reverts.push({ file: file.path, line: f.line, result: 'covered' }); continue; }
        if (got.r.exit !== 0) { report.reverts.push({ file: file.path, line: f.line, result: 'skipped', why: 'reverting it breaks the build, so it can’t be judged' }); continue; }
        report.reverts.push({ file: file.path, line: f.line, result: 'unnoticed' });
        const span = `${file.path}:${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}`;
        const sev: Severity = f.severity === 'high' ? 'medium' : 'low';
        revRec.findings.push(make({
          check: 'proof', key: `revert:${key}`, title: `No test notices if this change is reverted: ${path.basename(file.path)}:${f.line}`, lens: 'Tests', severity: sev,
          file: file.path, line: f.line, side: 'added', text: textAt(file, f.line),
          evidence: [{ kind: 'revert-test', source: 'proof:revert', what: `In a clean checkout of ${c.head.slice(0, 7)} with ${span} put back as it was, ${cmd.text} gave the same result.`, run: { kind: 'revert', file: file.path, line: f.line } }],
          observed: [`Reverting ${span} changed no test result.`, `This is the change that ${f.title.toLowerCase()}.`],
          inferred: ['Nothing in the test suite depends on this change, so a bug in it would ship unnoticed.'], ref: 'Coverage'
        }));
        revRec.signals.push({ findingId: f.id, evidence: { id: '', kind: 'coverage', source: 'coverage:revert', what: `Reverting ${span} changed no test result.`, file: file.path, line: f.line, replay: { commit: c.head, run: { kind: 'revert', file: file.path, line: f.line } } } });
      }
      revRec.summary = `${report.reverts.filter(x => x.result === 'unnoticed').length} of ${report.reverts.length} reverted hunks went unnoticed by the tests`;
      records.push(revRec);
    }

    /* 3. mutation: small deliberate changes on the changed lines */
    const wantMutants = opts.mutants ?? 8;
    const mutRec: RunRecord = { id: proofId(c.head, 'mutation', cmd.text), kind: 'mutation', at: now, secs: 0, command: cmd.text, summary: '', findings: [], signals: [] };
    if (canMutate && wantMutants > 0 && !report.stopped) {
      const prefer = c.findings.filter(f => f.origin === 'check' && f.present !== false).map(f => ({ file: f.file, line: f.line }));
      const survivors = new Map<string, Mutant[]>();
      for (const m of pickMutants(net, wantMutants, prefer)) {
        if (left() <= 0) { report.stopped = outOfTime('during mutation'); break; }
        const dir = head();
        say(`Changing ${m.file}:${m.line} (${m.op}) and running the tests…`);
        const mod: { text: string | null } = { text: null };
        const got = await run(c.head, `mutant:${m.id}`, () => dir, () => (mod.text = applyMutant(dir, m)));
        if (mod.text !== null) fs.writeFileSync(path.join(dir, m.file), mod.text);
        if (got === 'budget') { report.stopped = outOfTime('during mutation'); break; }
        if (got === 'cannot') { report.mutants.push({ file: m.file, line: m.line, op: m.op, result: 'skipped' }); continue; }
        mutRec.secs += got.cached ? 0 : got.r.secs;
        if (got.r.timedOut) { report.mutants.push({ file: m.file, line: m.line, op: m.op, result: 'skipped' }); continue; }
        if (showedFailure(got.r)) { report.mutants.push({ file: m.file, line: m.line, op: m.op, result: 'killed' }); continue; }
        if (got.r.exit !== 0) { report.mutants.push({ file: m.file, line: m.line, op: m.op, result: 'invalid' }); continue; }
        report.mutants.push({ file: m.file, line: m.line, op: m.op, result: 'survived' });
        (survivors.get(m.file) ?? survivors.set(m.file, []).get(m.file)!).push(m);
      }
      const judged = report.mutants.filter(x => x.result === 'killed' || x.result === 'survived');
      for (const [file, list] of survivors) {
        const f = net.find(x => x.path === file)!;
        const total = judged.filter(x => x.file === file).length;
        const sev: Severity = list.length >= 2 && list.length / total >= 0.5 ? 'medium' : 'low';
        mutRec.findings.push(make({
          check: 'proof', key: `mutation:${file}`, title: `Tests don’t notice ${list.length} of ${total} deliberate changes in ${path.basename(file)}`, lens: 'Tests', severity: sev,
          file, line: list[0].line, side: 'added', text: textAt(f, list[0].line),
          evidence: list.slice(0, 6).map(m => ({ kind: 'mutation-survivor' as const, source: 'proof:mutation', what: `Line ${m.line}: ${redactSecrets(m.original.trim().slice(0, 80))}  →  ${redactSecrets((m.original.slice(0, m.col) + m.to + m.original.slice(m.col + m.len)).trim().slice(0, 80))}  (${m.op}); ${cmd.text} still passed.`, line: m.line, run: { kind: 'mutant' as const, file, line: m.line, op: m.op } })),
          observed: [`${list.length} of ${total} small changes to the lines this range added went unnoticed: every test still passed.`, ...list.slice(0, 3).map(m => `Line ${m.line}: ${m.op} changed, tests still passed.`)],
          inferred: ['A real bug of the same kind in these lines would ship unnoticed.'], ref: 'Mutation'
        }));
        for (const m of list) for (const f2 of c.findings) {
          if (f2.origin === 'check' && f2.file === file && Math.abs(f2.line - m.line) <= 3 && !mutRec.signals.some(s => s.findingId === f2.id)) {
            mutRec.signals.push({ findingId: f2.id, evidence: { id: '', kind: 'coverage', source: 'coverage:mutation', what: `A deliberate change on line ${m.line} (${m.op}) went unnoticed by the tests.`, file, line: m.line, replay: { commit: c.head, run: { kind: 'mutant', file, line: m.line, op: m.op } } } });
          }
        }
      }
      const killed = judged.filter(x => x.result === 'killed').length;
      mutRec.summary = `${killed} of ${judged.length} deliberate changes were noticed by the tests${report.mutants.some(x => x.result === 'invalid') ? ` (${report.mutants.filter(x => x.result === 'invalid').length} didn’t compile and weren’t counted)` : ''}`;
      records.push(mutRec);
    }
  } finally {
    for (const d of trees) removeTree(d);
    report.secs = Math.round((Date.now() - started) / 1000);
  }

  c.runs = [...c.runs.filter(r => !records.some(n => n.kind === r.kind)), ...records];
  c.findings = c.findings.filter(f => f.origin !== 'run');
  applyRuns(c);
  saveCase(c);
  return report;
}

/** Runs one piece of proof again, ignoring the cache, and says whether it comes out the same. */
export async function replayRun(c: Case, ev: Evidence): Promise<{ reproduced: boolean; detail: string }> {
  const settings = repoSettings(c.repo);
  if (!settings.allow) return { reproduced: false, detail: 'Running this repository’s tests isn’t allowed. A person has to turn it on: assay allow-run' };
  const run = ev.replay?.run;
  if (!run) return { reproduced: false, detail: 'This evidence has no run to repeat.' };
  const cmd = detectCommand(c.repo, settings.command);
  if (!cmd) return { reproduced: false, detail: 'No test command found.' };
  const timeout = settings.timeout ?? 300;
  const net = commitDiff(c.repo, c.head, c.base);
  const dirs: string[] = [];
  const checkout = (commit: string, label: string): string => { const d = exportTree(c.repo, commit, label); dirs.push(d); linkDependencies(c.repo, d); return d; };
  try {
    if (run.kind === 'tests') {
      const b = c.base ? await runCommand(cmd, checkout(c.base, 'base'), { timeoutSec: timeout }) : null;
      const h = await runCommand(cmd, checkout(c.head, 'head'), { timeoutSec: timeout });
      const again = (b === null || green(b)) && (h.exit !== 0 || showedFailure(h));
      return { reproduced: again, detail: again ? `Ran ${cmd.text} again at both ends: passed at the base, failed at the head.` : `Ran ${cmd.text} again: the head ${green(h) ? 'passes now' : 'fails'} and the base ${b && !green(b) ? 'fails too' : 'passes'}.` };
    }
    const dir = checkout(c.head, 'head');
    const file = net.find(x => x.path === run.file);
    if (!file || run.line === undefined) return { reproduced: false, detail: 'The changed file is not in this range any more.' };
    let original: string | null = null;
    if (run.kind === 'revert') {
      const hunk = hunkAt(file, run.line);
      if (!hunk) return { reproduced: false, detail: 'The hunk is not in the range any more.' };
      original = revertHunk(dir, file.path, hunk);
    } else {
      const m = mutantsFor(file.path, run.line, textAt(file, run.line)).find(x => x.op === run.op);
      if (!m) return { reproduced: false, detail: 'The line no longer allows that change.' };
      original = applyMutant(dir, m);
    }
    if (original === null) return { reproduced: false, detail: 'The change no longer applies cleanly.' };
    const r = await runCommand(cmd, dir, { timeoutSec: timeout });
    const survived = green(r);
    return { reproduced: survived, detail: survived ? `Made the change again and ran ${cmd.text}: every test still passed.` : `Made the change again: ${showedFailure(r) ? 'a test fails now, so it is noticed' : 'the build breaks'}.` };
  } finally {
    for (const d of dirs) removeTree(d);
  }
}

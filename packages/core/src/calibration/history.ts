import fs from 'node:fs';
import path from 'node:path';
import { openCase } from '../case.js';
import { redactSecrets } from '../checks/secrets.js';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import { commitDiff } from '../diff.js';
import { git, repoKey, repoRoot } from '../git.js';
import { isSourcePath } from '../lang.js';
import { isFixSubject } from '../memory/mine.js';
import { planPanel } from '../reviewers/plan.js';
import { loadCase } from '../store.js';
import type { Case, Lens, PanelAttack } from '../types.js';
import { aboutDefect, best, byAttack, byPlain, LENSES, lensesOf, near, type Cell, type Row } from './score.js';

/**
 * Replaying the project's own history (D52). The planted bugs of a calibration run are invented; these are real. A fix commit removes lines;
 * the commit that last changed each removed line (`git blame` on the fix's parent) is where the bug came in, and that line, as that commit wrote it,
 * is the truth. Each such commit becomes a case of its own (a real case of the project), the free checks are scored on it at once, and the
 * reviewers, the attack pass and one plain review run on it like on any case. Reads git and runs nothing from the project.
 *
 * It is a proxy and says so: a line a fix removed is not always the defect (a refactor removes lines too), only fixes whose subject says so are
 * used, and nobody knows that the rest of a commit is clean, so there are no false alarms to count here, only "flagged elsewhere" for information.
 */
export interface PastBug {
  id: string;
  /** The fix commit, and what it said. */
  fix: string;
  fixSubject: string;
  /** The commit that last changed the line the fix removed: where the bug came in. */
  introduced: string;
  subject: string;
  /** The file and line as the introducing commit wrote them (that is where a reviewer reads it). */
  file: string;
  line: number;
  /** The line itself, secrets masked. */
  text: string;
  /** The case of the introducing commit alone. Empty until the run is started. */
  case: string;
}

export interface HistoryRun {
  id: string;
  repo: string;
  createdAt: string;
  budget: number;
  /** How many fix commits were looked at. */
  looked: number;
  bugs: PastBug[];
}

const SCAN = 400;
const MAX_FIXES = 80;
const MAX_PER_FIX = 2;
const BULK_FILES = 30;
const BULK_LINES = 800;
export const HISTORY_BUDGET = 100_000;

const runPath = (repo: string): string => assayPath('benchmark', repoKey(repo), 'history.json');

/** A removed line worth being the truth: something that does something, not a brace, a blank or a comment. */
const substantive = (t: string): boolean => {
  const s = t.trim();
  return s.length >= 6 && /[A-Za-z0-9]/.test(s) && !/^(?:\/\/|#|\*|\/\*|<!--|--)/.test(s) && !/^(?:import|from|export \*|using|package|use)\b/.test(s);
};

interface Origin { commit: string; file: string; line: number }

/** Who wrote that line: the commit that last changed it, and where it sits in that commit's version of the file. */
function blame(repo: string, parent: string, file: string, line: number): Origin | null {
  const out = git(repo, ['blame', '--line-porcelain', '-w', '-L', `${line},${line}`, parent, '--', file], { allowFail: true });
  if (!out) return null;
  const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(out);
  if (!head || /^0+$/.test(head[1]) || /^boundary$/m.test(out)) return null;
  const name = /^filename (.+)$/m.exec(out);
  return name ? { commit: head[1], file: name[1], line: Number(head[2]) } : null;
}

const counts = (repo: string, commit: string): { files: number; lines: number; parents: number } => {
  const stat = git(repo, ['show', '--no-color', '--format=%P', '--numstat', commit], { allowFail: true }).split('\n');
  const parents = (stat[0] ?? '').trim().split(' ').filter(Boolean).length;
  let files = 0, lines = 0;
  for (const l of stat.slice(1)) { const m = /^(\d+|-)\t(\d+|-)\t/.exec(l); if (m) { files++; lines += (Number(m[1]) || 0) + (Number(m[2]) || 0); } }
  return { files, lines, parents };
};

/** The bugs the project's own fixes point at, newest first. Reads git only. */
export function findPastBugs(repoIn: string, o: { limit?: number; scan?: number } = {}): { bugs: PastBug[]; looked: number } {
  const repo = repoRoot(repoIn);
  const limit = Math.max(1, Math.min(40, Math.round(o.limit ?? 12)));
  const log = git(repo, ['log', '--no-merges', `-n${Math.max(20, Math.min(2000, o.scan ?? SCAN))}`, '--format=%H%x1f%P%x1f%s%x1e'], { allowFail: true });
  const fixes = log.split('\x1e').map(r => r.replace(/^\n/, '')).filter(Boolean).map(r => { const [hash, parents, subject] = r.split('\x1f'); return { hash, parent: (parents || '').split(' ').filter(Boolean), subject: subject ?? '' }; })
    .filter(f => f.parent.length === 1 && isFixSubject(f.subject));
  const bugs: PastBug[] = [];
  const seen = new Set<string>();
  const small = new Map<string, boolean>();
  let looked = 0;
  for (const fix of fixes) {
    if (bugs.length >= limit || looked >= MAX_FIXES) break;
    const c = counts(repo, fix.hash);
    if (c.files === 0 || c.files > BULK_FILES || c.lines > BULK_LINES) continue;
    looked++;
    let taken = 0;
    for (const f of commitDiff(repo, fix.hash, fix.parent[0])) {
      if (f.binary || f.status === 'added' || !isSourcePath(f.oldPath ?? f.path)) continue;
      for (const h of f.hunks) {
        if (taken >= MAX_PER_FIX || bugs.length >= limit) break;
        const gone = h.lines.find(l => l.t === '-' && l.o !== null && substantive(l.text));
        if (!gone || gone.o === null) continue;
        const origin = blame(repo, fix.parent[0], f.oldPath ?? f.path, gone.o);
        if (!origin || origin.commit === fix.hash) continue;
        if (!small.has(origin.commit)) { const k = counts(repo, origin.commit); small.set(origin.commit, k.parents === 1 && k.files > 0 && k.files <= BULK_FILES * 2 && k.lines <= BULK_LINES * 2); }
        if (!small.get(origin.commit)) continue;
        const parent = git(repo, ['rev-parse', '--verify', '--quiet', `${origin.commit}^`], { allowFail: true }).trim();
        if (!parent) continue;
        // The truth must be a line that commit added, at that number: a line it only moved is not where the bug came in.
        const row = commitDiff(repo, origin.commit, parent).find(d => d.path === origin.file)?.hunks.flatMap(x => x.lines).find(l => l.t === '+' && l.n === origin.line);
        if (!row) continue;
        const key = `${origin.commit}:${origin.file}:${origin.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const subject = git(repo, ['log', '-1', '--format=%s', origin.commit], { allowFail: true }).trim();
        bugs.push({ id: `h-${sha([fix.hash, key].join('\0'), 8)}`, fix: fix.hash, fixSubject: fix.subject, introduced: origin.commit, subject, file: origin.file, line: origin.line, text: redactSecrets(row.text.trim().slice(0, 160)), case: '' });
        taken++;
      }
    }
  }
  return { bugs, looked };
}

/** Opens a case for each commit a bug came in at, plans the panel (with the attack pass and the plain review) on it, and keeps the run. */
export function startHistory(repoIn: string, o: { limit?: number; budget?: number } = {}): HistoryRun {
  const repo = repoRoot(repoIn);
  const { bugs, looked } = findPastBugs(repo, { limit: o.limit });
  if (!bugs.length) throw new Error(looked ? `${looked} fix commit${looked === 1 ? '' : 's'} looked at, and none removed a line that one commit of its own had added: there is nothing to replay.` : 'No fix commits were found (a subject that starts with fix:, bugfix: or hotfix: or says it fixes something), so there is nothing to replay.');
  const budget = Math.max(0, Math.min(400_000, Math.round(o.budget ?? HISTORY_BUDGET)));
  const cases = new Map<string, string>();
  for (const b of bugs) {
    if (!cases.has(b.introduced)) {
      const parent = git(repo, ['rev-parse', `${b.introduced}^`]).trim();
      const c = openCase({ repo, span: { base: parent, head: b.introduced } });
      planPanel(c, { budget, baseline: true });
      cases.set(b.introduced, c.id);
    }
    b.case = cases.get(b.introduced) as string;
  }
  const run: HistoryRun = { id: `hist-${sha([repo, Date.now(), bugs.map(b => b.id).join()].join('\0'), 8)}`, repo, createdAt: new Date().toISOString(), budget, looked, bugs };
  writeFileAtomic(runPath(repo), JSON.stringify(run));
  return run;
}

export function latestHistory(repoIn: string): HistoryRun | null {
  try { return JSON.parse(fs.readFileSync(runPath(repoRoot(repoIn)), 'utf8')) as HistoryRun; } catch { return null; }
}

export function clearHistory(repoIn: string): boolean {
  try { fs.rmSync(path.dirname(runPath(repoRoot(repoIn))), { recursive: true, force: true }); return true; } catch { return false; }
}

export interface PastResult { bug: PastBug; free: 'C' | 'h' | 'm'; cells: Record<string, Cell>; plain: Cell; attack: Cell }
export interface HistoryBoard {
  run: string;
  createdAt: string;
  /** Distinct commits the bugs came in at, and how many fix commits were looked at to find them. */
  commits: number;
  looked: number;
  complete: boolean;
  total: number;
  freeProven: number;
  freeSeen: number;
  seen: number;
  plainRan: boolean;
  plainSeen: number;
  /** Findings about a defect that landed on none of the past bugs: not false alarms (nobody knows those lines are clean), just for information. */
  elsewhere: number;
  rows: Row[];
  bugs: PastResult[];
  cases: string[];
}

const NAMES: Record<string, string> = { free: 'Free checks (no model)', plain: 'One plain review (no lenses)', attack: 'Attack pass', Security: 'Security', Correctness: 'Correctness', UI: 'UI & accessibility', Tests: 'Tests', 'Supply chain': 'Supply chain', Performance: 'Performance' };

/** Scored from the cases each time: what the free checks and each reviewer did with the line each fix later removed. */
export function scoreHistory(run: HistoryRun): HistoryBoard {
  const cases = new Map<string, Case>();
  for (const id of new Set(run.bugs.map(b => b.case))) { const c = loadCase(id); if (c) cases.set(id, c); }
  const bugs = run.bugs.filter(b => cases.has(b.case));
  if (!bugs.length) throw new Error('The cases of this replay are gone. Run assay calibrate history start again.');
  const reported = (c: Case, lens: Lens): boolean => { const r = c.panel?.reviewers.find(x => x.lens === lens); return r?.run === true && r.state === 'reported'; };
  const passDone = (p: PanelAttack | undefined): boolean => p?.run === true && p.state === 'reported';
  const results: PastResult[] = bugs.map(bug => {
    const c = cases.get(bug.case) as Case;
    const fs = near(c, bug);
    const cells: Record<string, Cell> = {};
    for (const lens of LENSES) cells[lens] = reported(c, lens) ? (best(fs.filter(f => lensesOf(f).has(lens))) ?? 'm') : 'n';
    return {
      bug, free: best(fs.filter(aboutDefect)) ?? 'm', cells,
      plain: passDone(c.panel?.baseline) ? (best(fs.filter(byPlain)) ?? 'm') : 'n',
      attack: passDone(c.panel?.attack) ? (best(fs.filter(byAttack)) ?? 'm') : 'n'
    };
  });
  const tally = (id: Row['id'], pick: (r: PastResult) => Cell, tokensOf: (c: Case) => { tokens: number; reported: boolean } | null): Row => {
    const cs = results.map(pick);
    const ran = cs.some(x => x !== 'n');
    const caught = cs.filter(x => x === 'C').length, flagged = cs.filter(x => x === 'h').length, missed = cs.filter(x => x === 'm').length;
    const per = [...cases.values()].map(tokensOf).filter((x): x is { tokens: number; reported: boolean } => !!x);
    const tokens = per.length ? per.reduce((n, x) => n + x.tokens, 0) : null;
    return { id, name: NAMES[id], ran, caught, flagged, missed, alarms: 0, tokens: id === 'free' ? 0 : tokens, tokensKind: per.length ? (per.every(x => x.reported) ? 'reported' : 'estimate') : null, perCatch: tokens !== null && caught + flagged ? Math.round(tokens / (caught + flagged)) : null, chances: results.length, hits: caught + flagged, advice: '' };
  };
  const passTokens = (pick: (c: Case) => PanelAttack | undefined) => (c: Case): { tokens: number; reported: boolean } | null => { const p = pick(c); return p?.run && p.state === 'reported' ? { tokens: p.reportedTokens ?? p.tokens, reported: !!p.reportedTokens } : null; };
  const rows: Row[] = [tally('free', r => r.free, () => null)];
  for (const lens of LENSES) {
    const row = tally(lens, r => r.cells[lens], c => { const r = c.panel?.reviewers.find(x => x.lens === lens); return r?.run && r.state === 'reported' ? { tokens: r.reportedTokens ?? r.tokens, reported: !!r.reportedTokens } : null; });
    if (row.ran) rows.push(row);
  }
  const attack = tally('attack', r => r.attack, passTokens(c => c.panel?.attack));
  if (attack.ran) rows.push(attack);
  const plain = tally('plain', r => r.plain, passTokens(c => c.panel?.baseline));
  if (plain.ran) rows.push(plain);
  const seen = results.filter(r => r.free !== 'm' || LENSES.some(l => r.cells[l] === 'C' || r.cells[l] === 'h') || r.attack === 'C' || r.attack === 'h').length;
  const plainSeen = results.filter(r => r.plain === 'C' || r.plain === 'h').length;
  const panelSeen = results.filter(r => LENSES.some(l => r.cells[l] === 'C' || r.cells[l] === 'h') || r.attack === 'C' || r.attack === 'h').length;
  for (const r of rows) {
    if (r.id === 'free') r.advice = `Flagged ${r.hits} of ${r.chances} real past bugs at the time they came in, at 0 tokens.`;
    else if (r.id === 'plain') r.advice = LENSES.some(l => rows.some(x => x.id === l)) ? `One plain review flagged ${plainSeen} of ${r.chances}; the panel flagged ${panelSeen}. ${panelSeen > plainSeen ? 'The lenses are adding something.' : panelSeen === plainSeen ? 'No gain from the lenses on this set.' : 'On this set the plain review did better than the lenses.'}` : `One plain review flagged ${plainSeen} of ${r.chances}. Run the reviewers to compare.`;
    else r.advice = `Flagged ${r.hits} of ${r.chances}.`;
  }
  const lines = new Map<string, number[]>();
  for (const r of results) lines.set(`${r.bug.case}:${r.bug.file}`, [...(lines.get(`${r.bug.case}:${r.bug.file}`) ?? []), r.bug.line]);
  let elsewhere = 0;
  for (const [id, c] of cases) elsewhere += c.findings.filter(f => aboutDefect(f) && !(lines.get(`${id}:${f.file}`) ?? []).some(n => Math.abs(n - f.line) <= 3)).length;
  const complete = [...cases.values()].every(c => (c.panel?.reviewers ?? []).filter(r => r.run).every(r => r.state === 'reported') && (!c.panel?.attack?.run || c.panel.attack.state === 'reported') && (!c.panel?.baseline?.run || c.panel.baseline.state === 'reported'));
  return {
    run: run.id, createdAt: run.createdAt, commits: cases.size, looked: run.looked, complete, total: results.length,
    freeProven: results.filter(r => r.free === 'C').length, freeSeen: results.filter(r => r.free !== 'm').length, seen, plainRan: plain.ran, plainSeen, elsewhere,
    rows, bugs: results, cases: [...cases.keys()]
  };
}

/** What to give an agent to run the reviewers on every replayed case. It says not to look at what came after: that is where the fix is. */
export const historyPrompt = (run: HistoryRun): string => {
  const ids = [...new Set(run.bugs.map(b => b.case))];
  return `Review ${ids.length} case${ids.length === 1 ? '' : 's'} with Assay's reviewer panel, one after the other, and tell me when all of them are done: ${ids.join(', ')}. For each, call the assay tool reviewers_plan with that case id and follow what it says: start one sub-agent per reviewer it lists (including the plain review, lens "plain", and the attack pass, lens "attack", if it lists them), in parallel, each told only to call reviewer_brief for its own lens and follow it. Don't show the reviewers each other's work. These are old commits of this project: don't look at any commit after a case's head (git log, git show, blame), because the fix is there, and don't read anything under ~/.assay/benchmark. It is a test, and it only means something if the reviewers read the change as it was.`;
};

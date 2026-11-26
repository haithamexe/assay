import crypto from 'node:crypto';
import { analyzeCommit } from './analysis.js';
import { applyClaims } from './gate.js';
import { applyRuns } from './proof/apply.js';
import { commitInfo, defaultBase, git, GitError, listRange, repoName, repoRoot, resolveRev, showFile } from './git.js';
import { feedback } from './memory/entries.js';
import { loadCase, saveCase } from './store.js';
import type { Case, CommitSummary, Finding, Lens, Tier, Verdict } from './types.js';

export interface RangeSpec { base: string | null; head: string }

/**
 * What to review. Nothing given: this branch since it left the default branch (or the last five commits on it).
 * "A..B": B since A. "A...B": B since the two met. One revision: just that commit.
 */
export function resolveRange(repo: string, spec?: string, last?: number): RangeSpec {
  const rev = (r: string): string => resolveRev(repo, r || 'HEAD');
  const parentOf = (h: string): string | null => git(repo, ['rev-parse', '--verify', '--quiet', `${h}~1^{commit}`], { allowFail: true }).trim() || null;
  if (!spec) {
    const head = rev('HEAD');
    if (last) return { base: git(repo, ['rev-parse', '--verify', '--quiet', `${head}~${Math.max(1, Math.floor(last))}^{commit}`], { allowFail: true }).trim() || null, head };
    const base = defaultBase(repo, head);
    return base ? { base, head } : resolveRange(repo, undefined, 5);
  }
  if (spec.includes('...')) {
    const [a, b] = spec.split('...');
    const ha = rev(a), hb = rev(b);
    return { base: git(repo, ['merge-base', ha, hb]).trim() || null, head: hb };
  }
  if (spec.includes('..')) {
    const [a, b] = spec.split('..');
    return { base: rev(a), head: rev(b) };
  }
  const head = rev(spec);
  return { base: parentOf(head), head };
}

export const caseId = (head: string, base: string | null): string => `c-${head.slice(0, 7)}-${base ? base.slice(0, 7) : 'root'}`;

function lineHashes(text: string): Set<string> {
  return new Set(text.split('\n').map(l => crypto.createHash('sha1').update(l.trim()).digest('hex').slice(0, 16)));
}

/** Is the finding still in the net diff at the head of the range? A mistake fixed by a later commit in the same range is not an open problem. */
function stillPresent(f: Finding, headText: string | null): boolean {
  if (f.anchor.text === f.file) return f.anchor.side === 'added' ? headText !== null : headText === null;
  if (f.anchor.side === 'removed') return headText !== null && !headText.includes(f.anchor.text);
  if (headText === null) return false;
  return f.anchor.text.startsWith('sha:') ? lineHashes(headText).has(f.anchor.text.slice(4)) : headText.includes(f.anchor.text);
}

/**
 * Where each file the range renamed ended up, following every commit's renames in order (a file renamed twice, or added and then renamed, ends at
 * its last name). A finding is looked for in the file it became, so a rename alone doesn't make it look fixed.
 */
function renamesIn(repo: string, base: string | null, head: string, count: number): Map<string, string> {
  const out = git(repo, ['log', '-M', '--name-status', '--format=%H', '--reverse', '--no-merges', ...(base ? [`${base}..${head}`] : [`--max-count=${count}`, head])], { allowFail: true });
  const to = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line);
    if (!m) continue;
    for (const [from, now] of to) if (now === m[1]) to.set(from, m[2]);
    to.set(m[1], m[2]);
  }
  return to;
}

function markPresence(repo: string, head: string, findings: Finding[], renamed: Map<string, string> = new Map()): void {
  const byFile = new Map<string, string | null>();
  for (const f of findings) {
    const at = renamed.get(f.file) ?? f.file;
    if (!byFile.has(at)) byFile.set(at, showFile(repo, head, at));
    f.present = stillPresent(f, byFile.get(at) ?? null);
  }
}

export interface OpenOptions {
  repo: string;
  range?: string;
  last?: number;
  max?: number;
  fresh?: boolean;
  /** Exactly this span (a base commit, or null for "from the first commit", and a head), for a caller that already picked commits from a list. */
  span?: { base: string | null; head: string };
}

/** Opens (and keeps) a case: every commit in the range analysed once, then merged, then checked against the net diff. */
export function openCase(opts: OpenOptions): Case {
  const repo = repoRoot(opts.repo);
  const { base, head } = opts.span
    ? { base: opts.span.base ? resolveRev(repo, opts.span.base) : null, head: resolveRev(repo, opts.span.head) }
    : resolveRange(repo, opts.range, opts.last);
  const max = Math.min(Math.max(opts.max ?? 200, 1), 1000);
  const { hashes, merges } = listRange(repo, base, head, max);
  if (!hashes.length) throw new GitError('There are no commits in that range.');
  if (hashes.length > max) throw new GitError(`That range has ${hashes.length} commits and the limit is ${max}. Pick a shorter range or pass a higher --max.`);
  const analyses = commitInfo(repo, hashes).map(i => analyzeCommit(repo, i, { fresh: opts.fresh }));
  const id = caseId(head, base);
  const prev = loadCase(id);
  const findings = analyses.flatMap(a => a.findings.map(f => structuredClone(f)));
  const commits: CommitSummary[] = analyses.map(a => a.summary).reverse();
  const files = new Set(analyses.flatMap(a => a.files.map(f => f.path)));
  const c: Case = {
    id, repo, name: repoName(repo), base, head, createdAt: prev?.createdAt ?? new Date().toISOString(), commits, findings,
    claims: prev?.claims ?? [], dropped: [], files: files.size, languages: [...new Set(commits.flatMap(x => x.languages))].sort(),
    resolved: prev?.resolved ?? {}, skippedMerges: merges, runs: prev?.runs ?? [],
    ...(prev?.panel ? { panel: prev.panel } : {})
  };
  applyRuns(c);
  if (c.claims.length) applyClaims(repo, c, []);
  findings.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
  markPresence(repo, head, c.findings, renamesIn(repo, base, head, hashes.length));
  saveCase(c);
  return c;
}

export const isOpen = (c: Case, f: Finding): boolean => !c.resolved[f.id] && f.present !== false;

/** Only proven findings can block (principle 1). A mistake a later commit already fixed doesn't count. */
export function verdictOf(c: Case): Verdict {
  const open = c.findings.filter(f => isOpen(c, f));
  const must = open.filter(f => f.tier === 'proven' && f.severity === 'high');
  const should = open.filter(f => f.tier === 'proven' && f.severity !== 'high');
  const decide = open.filter(f => f.tier === 'corroborated');
  const hints = open.filter(f => f.tier === 'hint');
  if (must.length) return { tone: 'blocked', headline: `Blocked: ${must.length} proven problem${must.length > 1 ? 's' : ''} to fix first`, must, should, decide, hints };
  if (should.length || decide.length) return { tone: 'mergeable', headline: 'Can merge, with fixes suggested', must, should, decide, hints };
  return { tone: 'clear', headline: c.findings.length ? 'Clear to merge' : 'Nothing significant in this range', must, should, decide, hints };
}

export function resolveFinding(c: Case, findingId: string, how: 'dismissed' | 'intended' | null): void {
  if (!c.findings.some(f => f.id === findingId)) throw new Error(`No finding ${findingId} in ${c.id}`);
  if (how) c.resolved[findingId] = how; else delete c.resolved[findingId];
  saveCase(c);
  // A dismissal is a false alarm for the entries the finding belongs to; taking it back undoes that.
  try { feedback(c, findingId, how); } catch { /* memory is a help only */ }
}

/** A timeline row: the commit's summary and the lenses its findings are about. */
export type TimelineRow = CommitSummary & { lenses: Lens[] };

/** One row per recent commit: what the free checks found on each. Instant for commits seen before. */
export function timeline(opts: { repo: string; ref?: string; limit?: number; fresh?: boolean }): TimelineRow[] {
  const repo = repoRoot(opts.repo);
  const head = resolveRev(repo, opts.ref ?? 'HEAD');
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), 200);
  const hashes = git(repo, ['rev-list', '--no-merges', `--max-count=${limit}`, head]).split('\n').filter(Boolean);
  return commitInfo(repo, hashes).map(i => {
    const a = analyzeCommit(repo, i, { fresh: opts.fresh });
    return { ...a.summary, lenses: [...new Set(a.findings.map(f => f.lens))] };
  });
}

/** What "the whole branch" means right now: where it started and which commits are on it, newest first. `fallback` is true when no default branch was found and the last five commits stand in. */
export function branchSpan(opts: { repo: string }): { base: string | null; head: string; hashes: string[]; fallback: boolean } {
  const repo = repoRoot(opts.repo);
  const head = resolveRev(repo, 'HEAD');
  const fallback = !defaultBase(repo, head);
  const r = resolveRange(repo);
  return { base: r.base, head: r.head, hashes: listRange(repo, r.base, r.head, 200).hashes.reverse(), fallback };
}

export type FindingState = Tier | 'fixed' | 'dismissed' | 'intended';

/** What to call a finding on screen: its tier, unless a person resolved it or a later commit in the range already fixed it. */
export function findingState(c: Case, f: Finding): FindingState {
  if (c.resolved[f.id] === 'dismissed') return 'dismissed';
  if (c.resolved[f.id] === 'intended') return 'intended';
  if (f.present === false) return 'fixed';
  return f.tier;
}

export const findingById = (c: Case, id: string): Finding | undefined => c.findings.find(f => f.id === id || f.id === `f-${id}`);
export const shortId = (id: string): string => id.replace(/^f-/, '');

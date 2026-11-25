import fs from 'node:fs';
import { dependencies } from './checks/deps.js';
import { redactSecrets, secrets } from './checks/secrets.js';
import { risky } from './checks/risky.js';
import { untested, untestedLogic } from './checks/tests.js';
import type { Check, CommitCtx, RawFinding } from './checks/types.js';
import { assayPath, sha, writeFileAtomic } from './config.js';
import { commitDiff, snippetAround, type FileDiff } from './diff.js';
import { churn, repoKey, showFile, type RawCommit } from './git.js';
import { isSourcePath, isTestPath, languageOf, SENSITIVE } from './lang.js';
import { memoryRuntime } from './memory/runtime.js';
import { commitRisk, riskOf } from './risk.js';
import { isProof, tierOf } from './evidence.js';
import type { CommitAnalysis, CommitSummary, DiffRow, Evidence, FileFact, Finding, Severity } from './types.js';

/** Bump when a check changes what it reports: cached analyses of the old kind are then ignored. */
export const ANALYSIS_VERSION = 4;
export const CHECKS: Check[] = [secrets, risky, dependencies, untested];
const MAX_FINDINGS = 60;
const SEV: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

const cachePath = (repo: string, hash: string): string => assayPath('cache', repoKey(repo), `${hash}.json`);

/** A cached analysis is good only for the same version of the checks and the same memory (what is switched off, what was learned). */
function readCache(repo: string, hash: string, digest: string): CommitAnalysis | null {
  try {
    const a = JSON.parse(fs.readFileSync(cachePath(repo, hash), 'utf8')) as CommitAnalysis;
    return a.v === ANALYSIS_VERSION && (a.m ?? '') === digest ? a : null;
  } catch {
    return null;
  }
}

function fallbackRows(raw: RawFinding): DiffRow[] {
  return [{ t: raw.side === 'added' ? '+' : '-', o: raw.side === 'removed' ? raw.line : null, n: raw.side === 'added' ? raw.line : null, text: raw.text, sig: true }];
}

export function buildFinding(raw: RawFinding, ctx: { commit: string; files: FileDiff[] }, origin: Finding['origin'] = 'check'): Finding {
  const id = `f-${sha([raw.check, raw.key, ctx.commit].join('\0'), 8)}`;
  const file = ctx.files.find(f => f.path === raw.file);
  const snip = file ? snippetAround(file, raw.line, raw.side) : null;
  const red = (s: string): string => redactSecrets(s);
  const evidence: Evidence[] = raw.evidence.map((e, i) => ({ id: `${id}.${i + 1}`, kind: e.kind, source: e.source, what: red(e.what), file: raw.file, line: e.line ?? raw.line, replay: { commit: ctx.commit, ...(e.run ? { run: e.run } : {}) } }));
  const redacted = red(raw.text) !== raw.text;
  const partial = { severity: raw.severity, file: raw.file, evidence, tier: tierOf(evidence) };
  const { risk, why } = riskOf(partial);
  return {
    id, check: raw.check, title: raw.title, lens: raw.lens, severity: raw.severity, commit: ctx.commit, file: raw.file, line: raw.line, lines: String(raw.line),
    evidence, observed: raw.observed.map(red), inferred: raw.inferred.map(red), why, risk, tier: partial.tier,
    snippet: { file: raw.file, header: snip?.header ?? '', rows: (snip?.rows ?? fallbackRows(raw)).map(r => ({ t: r.t, o: r.o, n: r.n, text: red(r.text), ...(r.sig ? { sig: true } : {}) })) },
    anchor: { side: raw.side, text: redacted ? `sha:${sha(raw.text.trim(), 16)}` : raw.text.trim() },
    ref: raw.ref, origin
  };
}

/** Two independent signals make a hint a corroborated finding. The commit's own facts are the second signal. */
function corroborate(findings: Finding[], ctx: CommitCtx): void {
  const u = untestedLogic(ctx);
  const noTest = u.adds >= 10 && !u.touchedTest && !/^revert\b/i.test(ctx.subject);
  const churned = new Map<string, number>();
  let calls = 0;
  for (const f of findings) {
    const eligible = (f.check === 'risky' || f.check === 'memory') && f.evidence.some(e => e.kind === 'rule') && isSourcePath(f.file) && !isTestPath(f.file);
    if (!eligible) continue;
    const add = (e: Omit<Evidence, 'id' | 'file' | 'line' | 'replay'>): void => {
      f.evidence.push({ id: `${f.id}.${f.evidence.length + 1}`, ...e, file: f.file, line: f.line, replay: { commit: ctx.commit } });
    };
    if (noTest && !f.evidence.some(e => e.source === 'diff:no-test')) add({ kind: 'diff', source: 'diff:no-test', what: 'No test file changed in this commit.' });
    if (f.severity !== 'low' && calls < 8) {
      if (!churned.has(f.file)) { churned.set(f.file, churn(ctx.repo, f.file, ctx.date)); calls++; }
      const n = churned.get(f.file) ?? 0;
      if (n >= 10) add({ kind: 'history', source: 'history:churn', what: `${f.file} changed ${n} times in the 90 days before this commit.` });
    }
    f.tier = tierOf(f.evidence);
    const r = riskOf(f);
    f.risk = r.risk;
    f.why = r.why;
  }
}

const fileFact = (f: FileDiff): FileFact => ({ path: f.path, oldPath: f.oldPath, status: f.status, language: languageOf(f.path), additions: f.additions, deletions: f.deletions, test: isTestPath(f.path) });

/** Everything the free checks say about one commit. Cached by hash: the result for a commit never changes. */
export function analyzeCommit(repo: string, raw: RawCommit, opts: { fresh?: boolean } = {}): CommitAnalysis {
  const mem = memoryRuntime(repo);
  if (!opts.fresh) {
    const hit = readCache(repo, raw.hash, mem.digest);
    if (hit) return hit;
  }
  const t0 = Date.now();
  const files = commitDiff(repo, raw.hash, raw.parent);
  const ctx: CommitCtx = {
    repo, commit: raw.hash, parent: raw.parent, date: raw.date, subject: raw.subject, files,
    read: (file, which) => (which === 'commit' ? showFile(repo, raw.hash, file) : raw.parent ? showFile(repo, raw.parent, file) : null)
  };
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const check of mem.learned ? [...CHECKS, mem.learned] : CHECKS) {
    let rawFindings: RawFinding[] = [];
    try { rawFindings = check(ctx); } catch { /* a check that throws on odd input must not take the others down */ }
    for (const r of rawFindings) {
      // A signal whose entries are all switched off in memory is left out. Proof never is (D32).
      if (r.evidence.length && !r.evidence.some(e => isProof(e.kind)) && r.evidence.every(e => mem.isMuted(e.source))) continue;
      const f = buildFinding(r, ctx);
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      findings.push(f);
    }
  }
  corroborate(findings, ctx);
  findings.sort((a, b) => b.risk - a.risk || SEV[b.severity] - SEV[a.severity] || a.id.localeCompare(b.id));
  const kept = findings.slice(0, MAX_FINDINGS);
  const additions = files.reduce((a, f) => a + f.additions, 0);
  const strong = kept.filter(f => f.tier !== 'hint');
  const top = (strong.length ? strong : kept).reduce<Severity | null>((m, f) => (!m || SEV[f.severity] > SEV[m] ? f.severity : m), null);
  const summary: CommitSummary = {
    hash: raw.hash, short: raw.hash.slice(0, 7), parent: raw.parent, subject: raw.subject, author: raw.author, date: raw.date,
    files: files.length, additions, deletions: files.reduce((a, f) => a + f.deletions, 0),
    languages: [...new Set(files.map(f => languageOf(f.path)).filter((x): x is string => !!x))],
    counts: { proven: kept.filter(f => f.tier === 'proven').length, corroborated: kept.filter(f => f.tier === 'corroborated').length, hint: kept.filter(f => f.tier === 'hint').length },
    maxSeverity: top, risk: commitRisk(kept, additions, files.some(f => SENSITIVE.test(f.path))), secs: Math.max(0, Math.round((Date.now() - t0) / 100) / 10)
  };
  const out: CommitAnalysis = { v: ANALYSIS_VERSION, ...(mem.digest ? { m: mem.digest } : {}), summary, files: files.map(fileFact), findings: kept };
  try { writeFileAtomic(cachePath(repo, raw.hash), JSON.stringify(out)); } catch { /* a cache that can't be written is only a slower next time */ }
  return out;
}

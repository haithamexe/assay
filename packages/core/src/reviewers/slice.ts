import { redactSecrets } from '../checks/secrets.js';
import { commitDiff, type FileDiff } from '../diff.js';
import { repoKey } from '../git.js';
import { isGenerated, isLockfile, isSourcePath, isTestPath, languageOf, SENSITIVE } from '../lang.js';
import type { Case, Lens } from '../types.js';

/**
 * What a case changed, in the terms a reviewer's routing needs, and each reviewer's slice of the diff: only the files its lens is about,
 * printed with the line numbers a claim must cite. Reading git only.
 */
export interface ChangedFile {
  path: string;
  commit: string;
  subject: string;
  diff: FileDiff;
  test: boolean;
  source: boolean;
  ui: boolean;
  supply: boolean;
  sensitive: boolean;
  /** Added lines that start a loop, a query, a request or a file read. */
  perf: number;
}

const UI_FILE = /\.(css|scss|sass|less|vue|svelte|html?|tsx|jsx)$/i;
const SUPPLY_FILE = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|Dockerfile(?:\.[^/]*)?|docker-compose[^/]*\.ya?ml|\.gitlab-ci\.yml|Makefile)$|(^|\/)\.github\/(workflows|actions)\//i;
const PERF_LINE = /\b(?:for|while)\b[^\n]*\b(?:await|query|fetch|find|get|select)\b|\.(?:forEach|map)\([^\n]*\b(?:await|fetch|query)\b|\bSELECT\b[^\n]*\bFROM\b|\.(?:query|execute|findAll|findMany)\(|\bfetch\(|\baxios\.|\brequests\.(?:get|post)\(|\breadFileSync\(|\bnew RegExp\(|\bsetInterval\(|\.addEventListener\(/;

const cache = new Map<string, FileDiff[]>();
function diffOf(repo: string, hash: string, parent: string | null): FileDiff[] {
  const key = `${repoKey(repo)}:${hash}`;
  let d = cache.get(key);
  if (!d) {
    d = commitDiff(repo, hash, parent);
    cache.set(key, d);
    if (cache.size > 80) cache.delete(cache.keys().next().value as string);
  }
  return d;
}

/** Every changed file of the case, commit by commit (oldest first: that is the order the code changed in). */
export function changedFiles(c: Case): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const cm of [...c.commits].reverse()) {
    for (const f of diffOf(c.repo, cm.hash, cm.parent)) {
      if (f.binary) continue;
      const test = isTestPath(f.path);
      const source = isSourcePath(f.path);
      let perf = 0;
      if (source && !test) for (const h of f.hunks) for (const l of h.lines) if (l.t === '+' && l.text.length < 400 && PERF_LINE.test(l.text)) perf++;
      out.push({ path: f.path, commit: cm.hash, subject: cm.subject, diff: f, test, source, ui: UI_FILE.test(f.path), supply: SUPPLY_FILE.test(f.path) || isLockfile(f.path), sensitive: SENSITIVE.test(f.path) && !isGenerated(f.path), perf });
    }
  }
  return out;
}

export interface Facts {
  files: ChangedFile[];
  paths: number;
  logicAdds: number;
  testFiles: number;
  uiFiles: number;
  supplyFiles: number;
  sensitive: string[];
  perfHits: number;
}

export function factsOf(files: ChangedFile[]): Facts {
  const unique = (xs: ChangedFile[]): string[] => [...new Set(xs.map(f => f.path))];
  return {
    files, paths: unique(files).length,
    logicAdds: files.filter(f => f.source && !f.test).reduce((n, f) => n + f.diff.additions, 0),
    testFiles: unique(files.filter(f => f.test)).length,
    uiFiles: unique(files.filter(f => f.ui && !f.test)).length,
    supplyFiles: unique(files.filter(f => f.supply)).length,
    sensitive: unique(files.filter(f => f.sensitive)),
    perfHits: files.reduce((n, f) => n + f.perf, 0)
  };
}

/** Which files a lens is shown, most useful first. Triage is shown names only. */
function wanted(lens: Lens, f: ChangedFile, flagged: Set<string>): number {
  const hit = flagged.has(f.path) ? 50 : 0;
  if (isLockfile(f.path)) return lens === 'Supply chain' ? 1 : 0;
  switch (lens) {
    case 'Security': return f.test ? 0 : f.source || f.sensitive || f.supply ? hit + (f.sensitive ? 30 : 10) : 0;
    case 'Correctness': return f.source && !f.test ? hit + 10 : 0;
    case 'UI': return f.ui && !f.test ? hit + 20 : f.source && !f.test && hit ? hit : 0;
    case 'Tests': return f.test ? hit + 20 : f.source ? hit + 5 : 0;
    case 'Supply chain': return f.supply ? hit + 20 : 0;
    case 'Performance': return f.perf > 0 ? hit + 10 + f.perf : 0;
    default: return 0;
  }
}

const CONTEXT = 2;
const MAX_FILE_ROWS = 160;

/** One file's changes as a reviewer reads them: the number printed is the one a claim cites. */
export function renderFile(f: ChangedFile): string {
  const head = `── ${f.path}   commit ${f.commit.slice(0, 7)}  +${f.diff.additions} −${f.diff.deletions}${f.diff.status === 'added' ? '  (new file)' : f.diff.status === 'renamed' ? `  (renamed from ${f.diff.oldPath})` : ''}`;
  const rows: string[] = [];
  for (const h of f.diff.hunks) {
    const keep = h.lines.map(() => false);
    h.lines.forEach((l, i) => { if (l.t !== ' ') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(h.lines.length - 1, i + CONTEXT); k++) keep[k] = true; });
    let gap = false;
    h.lines.forEach((l, i) => {
      if (!keep[i]) { gap = true; return; }
      if (gap && rows.length) rows.push('     ⋯');
      gap = false;
      const no = String(l.t === '-' ? l.o : l.n).padStart(5);
      // A brief goes into a model's context: a secret in the diff is masked here, exactly as everywhere else Assay writes code out.
      rows.push(`${l.t === ' ' ? ' ' : l.t === '+' ? '+' : '−'}${no}  ${redactSecrets(l.text.length > 220 ? `${l.text.slice(0, 220)}…` : l.text)}`);
    });
    rows.push('     ⋯');
  }
  if (rows.length && rows[rows.length - 1] === '     ⋯') rows.pop();
  const shown = rows.slice(0, MAX_FILE_ROWS);
  return [head, ...shown, ...(rows.length > shown.length ? [`     ⋯ ${rows.length - shown.length} more rows in this file not shown`] : [])].join('\n');
}

export interface Slice {
  /** The text, in pages of about `page` characters. */
  pages: string[];
  /** Files shown, and files this lens would have seen if there were room. */
  shown: number;
  omitted: string[];
  chars: number;
}

const PAGE = 9000;
const MAX_TOTAL = 45_000;

/** The slice of the case a lens is given. `flagged` are the files the free checks already found something in for this lens. */
export function sliceFor(lens: Lens, facts: Facts, flagged: Set<string>): Slice {
  if (lens === 'Scope') {
    const per = new Map<string, string[]>();
    for (const f of facts.files) { const a = per.get(f.commit) ?? []; a.push(`  ${f.path}  +${f.diff.additions} −${f.diff.deletions}${f.diff.status === 'added' ? '  new' : f.diff.status === 'deleted' ? '  deleted' : f.diff.status === 'renamed' ? '  renamed' : ''}`); per.set(f.commit, a); }
    const text = [...per.entries()].map(([commit, lines]) => `commit ${commit.slice(0, 7)} ${facts.files.find(x => x.commit === commit)?.subject ?? ''}\n${lines.join('\n')}`).join('\n\n');
    return { pages: [text || '(nothing changed)'], shown: facts.files.length, omitted: [], chars: text.length };
  }
  const ranked = facts.files.map(f => ({ f, w: wanted(lens, f, flagged) })).filter(x => x.w > 0).sort((a, b) => b.w - a.w || a.f.path.localeCompare(b.f.path));
  const pages: string[] = [];
  let cur = '';
  let total = 0;
  let shown = 0;
  const omitted: string[] = [];
  for (const { f } of ranked) {
    const lockfile = isLockfile(f.path);
    const text = lockfile ? `── ${f.path}   commit ${f.commit.slice(0, 7)}  +${f.diff.additions} −${f.diff.deletions}  (lockfile: not shown)` : renderFile(f);
    if (total + text.length > MAX_TOTAL) { omitted.push(`${f.path} (${f.commit.slice(0, 7)})`); continue; }
    if (cur && cur.length + text.length > PAGE) { pages.push(cur); cur = ''; }
    cur += `${cur ? '\n\n' : ''}${text}`;
    total += text.length;
    shown++;
  }
  if (cur) pages.push(cur);
  return { pages: pages.length ? pages : ['(nothing in this change is for your lens)'], shown, omitted, chars: total };
}

export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/*
 * Project mode (D59, D60): a checkup of the project as it is at a commit, not of a change. It reads git and the files a
 * person hands it, runs nothing, and says for each finding whether the previous checkup had it too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { secrets } from '../checks/secrets.js';
import type { CommitCtx, RawFinding } from '../checks/types.js';
import { buildFinding } from '../analysis.js';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import type { FileDiff } from '../diff.js';
import { isProof } from '../evidence.js';
import { git, repoKey, repoName, repoRoot, resolveRev } from '../git.js';
import { memoryRuntime } from '../memory/runtime.js';
import { repoSettings } from '../proof/settings.js';
import type { Finding, Severity } from '../types.js';
import { checkPagePath, checkUrl, readFlows, readHar, readOpenApi, type EndpointEntry, type Flow, type PageEntry, type Source } from './inputs.js';
import { routesFromFiles } from './routes.js';
import { eachText, listTree } from './tree.js';

/** The shape other tools read (`assay checkup --json`). A field is only ever added within a version; anything else is a new version. */
export const CHECKUP_SCHEMA = 'assay.checkup/1';
/** Checks project mode runs. Later checks (tests, pages, attack…) join this list as they move in. */
export const CHECKUP_CHECKS = ['secrets'] as const;
export type CheckupCheck = (typeof CHECKUP_CHECKS)[number];

/** first: there is no earlier checkup to compare with. new: the previous checkup didn't have it. before: it did. */
export type CheckupSince = 'first' | 'new' | 'before';
export interface CheckupFinding extends Finding {
  /** Stable across checkups: the check, the file and the line's text (a secret's text only as a hash). Not the line number, which moves. */
  key: string;
  since: CheckupSince;
}

export interface CheckRun { id: CheckupCheck; files: number; secs: number; notes: string[] }

export interface Inventory {
  /** The app's address on this computer, when one was given. */
  url: string | null;
  pages: PageEntry[];
  endpoints: EndpointEntry[];
  flows: Array<{ name: string; start: string; steps: number; skipped: number; file: string }>;
  frameworks: string[];
  /** What a reader left out or couldn't read, in words. */
  notes: string[];
}

/** act: something is proven. decide: independent signals agree, nothing proven. clear: hints at most. */
export type CheckupTone = 'act' | 'decide' | 'clear';

export interface Checkup {
  schema: typeof CHECKUP_SCHEMA;
  id: string;
  repo: string;
  name: string;
  /** The commit that was checked. Uncommitted changes are not part of it. */
  head: string;
  branch: string | null;
  createdAt: string;
  /** Tracked files changed since that commit and not committed (only counted when the checkup is of HEAD). */
  uncommitted: number;
  checks: CheckRun[];
  inventory: Inventory | null;
  findings: CheckupFinding[];
  /** The checkup this one is compared with. */
  previous: { id: string; head: string; createdAt: string } | null;
  /** Findings the previous checkup had that are gone now. */
  gone: Array<{ key: string; title: string; file: string; tier: Finding['tier']; severity: Severity }>;
  summary: { tone: CheckupTone; headline: string; proven: number; corroborated: number; hints: number; new: number; before: number; gone: number };
}

export interface CheckupOptions {
  repo: string;
  /** A commit or branch; HEAD when left out. */
  ref?: string;
  url?: string;
  pages?: string[];
  har?: string;
  flow?: string;
  openapi?: string;
  /** Which checks to run; all of them when left out. */
  checks?: CheckupCheck[];
  /** Read the pages, endpoints and flows. True unless only a check was asked for. */
  inventory?: boolean;
  /** Keep it, so the next checkup can say what is new. True by default. */
  save?: boolean;
  /** Keep each endpoint's request body shape in the inventory (the attack check needs it). Left out of the record by default. */
  bodies?: boolean;
}

const MAX_FINDINGS = 200;
const MAX_PAGES = 500;
const MAX_ENDPOINTS = 1000;
const KEEP = 30;
const ID = /^ck-\d{14}-[0-9a-f]{6}$/;
const SEV: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
/** Files whose text the route readers may want: config and code, not too big. Everything else is read once for the secrets check and let go. */
const ROUTE_TEXT = /(?:^|\/)package\.json$|\.(?:json|ya?ml|tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/;

const folder = (repo: string): string => assayPath('checkups', repoKey(repo));
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** The checkups kept for a repository, newest first. A file that isn't a checkup is skipped. */
export function listCheckups(repo: string): Checkup[] {
  const dir = folder(repoRoot(repo));
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => ID.test(n.replace(/\.json$/, ''))); } catch { return []; }
  const out: Checkup[] = [];
  for (const n of names) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Checkup;
      if (c.schema === CHECKUP_SCHEMA && ID.test(c.id)) out.push(c);
    } catch { /* a broken file is only a checkup fewer */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function loadCheckup(repo: string, id: string): Checkup | null {
  if (!ID.test(id)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(folder(repoRoot(repo)), `${id}.json`), 'utf8')) as Checkup;
    return c.schema === CHECKUP_SCHEMA ? c : null;
  } catch { return null; }
}

function mergePages(list: PageEntry[]): PageEntry[] {
  const by = new Map<string, PageEntry>();
  for (const p of list) {
    const had = by.get(p.path);
    if (!had) { by.set(p.path, { ...p, from: [...p.from] }); continue; }
    for (const s of p.from) if (!had.from.includes(s)) had.from.push(s);
    had.file ??= p.file;
  }
  return [...by.values()].sort((a, b) => Number(!!a.dynamic) - Number(!!b.dynamic) || a.path.localeCompare(b.path));
}

function mergeEndpoints(list: EndpointEntry[]): EndpointEntry[] {
  const by = new Map<string, EndpointEntry>();
  for (const e of list) {
    const k = `${e.method} ${e.path}`;
    const had = by.get(k);
    if (!had) { by.set(k, { ...e, from: [...e.from] }); continue; }
    for (const s of e.from) if (!had.from.includes(s)) had.from.push(s);
    had.file ??= e.file;
    had.body ??= e.body;
  }
  return [...by.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** One tracked file as a diff in which every line is added, so the commit checks read it unchanged. */
function wholeFile(file: string, text: string | null): FileDiff {
  const lines = text === null ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    path: file, oldPath: null, status: 'added',
    // A binary or very big file is still handed over, without its text, so a check that looks at names (a key file, a .env) sees it.
    binary: false, additions: lines.length, deletions: 0, truncated: false,
    hunks: lines.length ? [{ header: '', oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((t, i) => ({ t: '+' as const, o: null, n: i + 1, text: t })) }] : []
  };
}

/** A finding about a file as it is: its snippet shows plain lines, not added ones. */
function asProjectFinding(f: Finding, since: CheckupSince): CheckupFinding {
  const key = `k-${sha([f.check, f.file, f.anchor.text].join('\0'), 12)}`;
  return { ...f, snippet: { ...f.snippet, rows: f.snippet.rows.map(r => ({ ...r, t: r.t === '+' ? ' ' : r.t, o: r.t === '+' ? r.n : r.o })) }, key, since };
}

function summarize(findings: CheckupFinding[], gone: number, first: boolean, name: string): Checkup['summary'] {
  const proven = findings.filter(f => f.tier === 'proven').length;
  const corroborated = findings.filter(f => f.tier === 'corroborated').length;
  const hints = findings.length - proven - corroborated;
  const fresh = findings.filter(f => f.since === 'new').length;
  const before = findings.filter(f => f.since === 'before').length;
  const tone: CheckupTone = proven ? 'act' : corroborated ? 'decide' : 'clear';
  const what = proven ? `${plural(proven, 'proven problem')}${corroborated ? `, ${corroborated} to decide` : ''}` : corroborated ? `${corroborated} to decide, nothing proven` : 'Nothing proven or corroborated';
  const since = first ? 'First checkup, so nothing to compare with.' : `${fresh} new since the last checkup, ${before} already there, ${gone} gone.`;
  return { tone, headline: `${name}: ${what}. ${since}`, proven, corroborated, hints, new: fresh, before, gone };
}

/** True when a checkup should fail a build: `new` when a proven or corroborated finding wasn't in the previous checkup (or there was none), `any` when there is one at all. */
export function checkupFails(c: Checkup, on: 'new' | 'any'): boolean {
  return c.findings.some(f => f.tier !== 'hint' && (on === 'any' || f.since !== 'before'));
}

/**
 * A checkup of the project at a commit. Reads git (never the working folder) and the files it is given, runs nothing,
 * compares with the previous checkup of this repository, and keeps the result unless `save` is false.
 */
export function runCheckup(opts: CheckupOptions): Checkup {
  const repo = repoRoot(opts.repo);
  const head = resolveRev(repo, opts.ref ?? 'HEAD');
  // No `checks` means all of them; an empty list means none (only the inventory).
  const want = new Set<CheckupCheck>(opts.checks ?? CHECKUP_CHECKS);
  const withInventory = opts.inventory ?? !opts.checks?.length;
  // Inputs are checked before anything is read, so a wrong flag costs nothing.
  const url = opts.url ? checkUrl(opts.url) : null;
  const askedPages = (opts.pages ?? []).map(checkPagePath);
  const har = opts.har ? readHar(opts.har, { url }) : null;
  const flows: Flow[] = opts.flow ? readFlows(opts.flow) : [];
  const spec = opts.openapi ? readOpenApi(opts.openapi) : [];

  const tree = listTree(repo, head);
  const texts = new Map<string, string>();
  const mem = memoryRuntime(repo);
  const raw: Finding[] = [];
  const checks: CheckRun[] = [];
  const t0 = Date.now();
  let scanned = 0, unread = 0;
  eachText(repo, tree, (file, text) => {
    if (text !== null && withInventory && ROUTE_TEXT.test(file.path) && text.length <= 512 * 1024) texts.set(file.path, text);
    if (!want.has('secrets')) return;
    if (text === null) unread++; else scanned++;
    const fd = wholeFile(file.path, text);
    const ctx: CommitCtx = { repo, commit: head, parent: null, date: '', subject: '', files: [fd], read: () => null, whole: true };
    let found: RawFinding[] = [];
    try { found = secrets(ctx); } catch { /* one odd file must not stop the scan */ }
    for (const r of found) {
      if (r.evidence.length && !r.evidence.some(e => isProof(e.kind)) && r.evidence.every(e => mem.isMuted(e.source))) continue;
      raw.push(buildFinding(r, { commit: head, files: [fd] }));
    }
  });
  if (want.has('secrets')) {
    checks.push({
      id: 'secrets', files: scanned, secs: Math.round((Date.now() - t0) / 100) / 10,
      notes: [
        ...(unread ? [`${plural(unread, 'file')} binary or over 1 MB: checked by name only.`] : []),
        'Read from git at this commit: files that aren’t committed (a local .env) are not read.'
      ]
    });
  }

  let inventory: Inventory | null = null;
  if (withInventory) {
    const routes = routesFromFiles(tree.map(t => t.path), p => texts.get(p));
    const settingsPages = (repoSettings(repo).pages ?? []).flatMap(p => { try { return [checkPagePath(p)]; } catch { return []; } });
    const flowPages = flows.flatMap(f => [f.start, ...f.steps.flatMap(s => (s.goto ? [s.goto] : []))]).map(p => ({ path: p.replace(/\?.*$/, ''), from: ['flow' as Source] }));
    const pages = mergePages([
      ...askedPages.map(p => ({ path: p, from: ['pages' as Source] })),
      ...settingsPages.map(p => ({ path: p, from: ['settings' as Source] })),
      ...routes.pages, ...(har?.pages ?? []), ...flowPages
    ]);
    const endpoints = mergeEndpoints([...spec.map(e => ({ ...e, file: e.file ? path.basename(e.file) : undefined })), ...routes.endpoints, ...(har?.endpoints ?? [])]
      .map(e => (opts.bodies ? e : { ...e, body: undefined })));
    const notes = [...routes.notes, ...(har?.notes ?? [])];
    if (pages.length > MAX_PAGES) notes.push(`${pages.length - MAX_PAGES} more pages were found than are listed.`);
    if (endpoints.length > MAX_ENDPOINTS) notes.push(`${endpoints.length - MAX_ENDPOINTS} more endpoints were found than are listed.`);
    if (routes.endpoints.some(e => e.from.includes('code'))) notes.push('Routes read from code are as each file writes them: a prefix they are mounted under elsewhere is not known.');
    inventory = {
      url, pages: pages.slice(0, MAX_PAGES), endpoints: endpoints.slice(0, MAX_ENDPOINTS),
      flows: flows.map(f => ({ name: f.name, start: f.start.replace(/\?.*$/, ''), steps: f.steps.length, skipped: f.skipped, file: path.basename(opts.flow ?? '') })),
      frameworks: routes.frameworks, notes
    };
  }

  // The previous checkup that ran the same checks is the one to compare with.
  const ran = new Set(checks.map(c => c.id));
  const previous = listCheckups(repo).find(c => c.checks.some(k => ran.has(k.id))) ?? null;
  const before = new Map((previous?.findings ?? []).filter(f => ran.has(f.check as CheckupCheck)).map(f => [f.key, f]));
  const seen = new Set<string>();
  const findings: CheckupFinding[] = [];
  for (const f of raw) {
    const pf = asProjectFinding(f, 'first');
    if (seen.has(pf.key)) continue;
    seen.add(pf.key);
    pf.since = !previous ? 'first' : before.has(pf.key) ? 'before' : 'new';
    findings.push(pf);
  }
  findings.sort((a, b) => b.risk - a.risk || SEV[b.severity] - SEV[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  if (findings.length > MAX_FINDINGS) checks[0]?.notes.push(`${findings.length - MAX_FINDINGS} more findings than are kept: the riskiest ${MAX_FINDINGS} are listed.`);
  const kept = findings.slice(0, MAX_FINDINGS);
  const gone = [...before.values()].filter(f => !seen.has(f.key)).map(f => ({ key: f.key, title: f.title, file: f.file, tier: f.tier, severity: f.severity }));

  const now = new Date();
  const name = repoName(repo);
  const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).trim() || null;
  const atHead = !opts.ref || head === resolveRev(repo, 'HEAD');
  const uncommitted = atHead ? git(repo, ['diff', '--name-only', '-z', 'HEAD'], { allowFail: true }).split('\0').filter(Boolean).length : 0;
  const c: Checkup = {
    schema: CHECKUP_SCHEMA, id: `ck-${stamp(now)}-${sha(`${repo}\0${head}\0${now.toISOString()}\0${Math.random()}`, 6)}`,
    repo, name, head, branch: atHead ? branch : null, createdAt: now.toISOString(), uncommitted, checks, inventory, findings: kept,
    previous: previous ? { id: previous.id, head: previous.head, createdAt: previous.createdAt } : null,
    gone, summary: summarize(kept, gone.length, !previous, name)
  };
  if (opts.save !== false) {
    writeFileAtomic(path.join(folder(repo), `${c.id}.json`), JSON.stringify(c));
    for (const old of listCheckups(repo).slice(KEEP)) { try { fs.rmSync(path.join(folder(repo), `${old.id}.json`), { force: true }); } catch { /* pruned next time */ } }
  }
  return c;
}

import { redactSecrets } from '../checks/secrets.js';
import { repoKey } from '../git.js';
import type { Case, Lens, Severity } from '../types.js';
import { bumpMemory, inTransaction, openDb, type Db } from './db.js';
import { loadPacks, sourceMatches, type Pack } from './packs.js';

/**
 * What memory knows, as entries (D30). A standard entry comes from a pack file and a learned entry from this project's own
 * history; each is a mistake with a detector (Assay's own checks, or a pattern) or a question for a reviewer.
 * Stats are never counted up, they are read from the `hits` table (D31), so they can't drift.
 */
export interface Example { commit: string; subject: string; bad: string; good: string }
export type EntryStatus = 'new' | 'active' | 'expiring' | 'expired' | 'off' | 'question';
export interface EntryStats { hits: number; falseAlarms: number; lastHit: string | null; lastReal: string | null; weeks: number[] }

export interface Entry {
  id: string;
  kind: 'standard' | 'learned';
  pack: string | null;
  packName: string | null;
  name: string;
  ref: string | null;
  how: 'sources' | 'pattern' | 'question';
  /** In plain words: what finds it. */
  detector: string;
  sources: string[];
  pattern: { source: string; flags: string } | null;
  question: string | null;
  langs: string[];
  bad: string | null;
  good: string | null;
  /** Where it came from, in a sentence. */
  origin: string;
  on: boolean;
  off: null | 'pack' | 'person' | 'expired';
  /** Only a signal can expire: a proven kind of evidence never switches off. */
  expirable: boolean;
  status: EntryStatus;
  stats: EntryStats;
  fixes: number;
  examples: Example[];
  lens: Lens;
  severity: Severity;
}

export interface PackView {
  id: string; name: string; edition: string | null; source: string | null; note: string; origin: 'bundled' | 'yours'; file: string;
  on: boolean; rules: number; checked: number; questions: number;
}

/** Expiry (D32): at least this many hits, this share of them dismissed, and no real one for this long. */
export const EXPIRY = { minHits: 4, falseShare: 0.3, quietDays: 60, warnHits: 3 } as const;
const DAY = 86400_000;
const WEEKS = 12;
const MAX_LEARNED = 200;

type Base = Omit<Entry, 'status' | 'stats'>;
interface Switch { enabled: boolean; why: string; at: string }
export interface LearnedRow {
  id: string; name: string; ref: string | null; pattern: string; flags: string; langs: string[]; lens: Lens; severity: Severity;
  bad: string | null; good: string | null; origin: string; fixes: number; examples: Example[]; createdAt: string;
}

const json = <T>(s: unknown, fallback: T): T => { try { return JSON.parse(String(s)) as T; } catch { return fallback; } };
const iso = (s: string | undefined): string => { const t = s ? Date.parse(s) : NaN; return new Date(Number.isFinite(t) ? t : Date.now()).toISOString(); };

function readSwitches(d: Db, rk: string): Map<string, Switch> {
  const m = new Map<string, Switch>();
  for (const r of d.prepare('SELECT key, enabled, why, at FROM switches WHERE repo = ?').all(rk)) m.set(String(r.key), { enabled: Number(r.enabled) === 1, why: String(r.why), at: String(r.at) });
  return m;
}

function writeSwitch(d: Db, rk: string, key: string, enabled: boolean, why: string): void {
  d.prepare('INSERT INTO switches (repo, key, enabled, why, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo, key) DO UPDATE SET enabled = excluded.enabled, why = excluded.why, at = excluded.at')
    .run(rk, key, enabled ? 1 : 0, why, new Date().toISOString());
  bumpMemory();
}

export function learnedRows(d: Db, rk: string): LearnedRow[] {
  return d.prepare('SELECT * FROM learned WHERE repo = ? ORDER BY n').all(rk).map(r => ({
    id: `L-${r.n}`, name: String(r.name), ref: (r.ref as string | null) ?? null, pattern: String(r.pattern), flags: String(r.flags), langs: json<string[]>(r.langs, []),
    lens: String(r.lens) as Lens, severity: String(r.severity) as Severity, bad: (r.bad as string | null) ?? null, good: (r.good as string | null) ?? null,
    origin: String(r.origin), fixes: Number(r.fixes), examples: json<Example[]>(r.examples, []), createdAt: String(r.created_at)
  }));
}

const isSignal = (sources: string[]): boolean => sources.length > 0 && sources.every(s => /^(?:rule|diff|memory):/.test(s));

/** Every entry, with whether it is on and why not. No stats yet. */
function structure(repo: string, d: Db | null): { packs: Pack[]; problems: string[]; entries: Base[]; sw: Map<string, Switch> } {
  const rk = repoKey(repo);
  const { packs, problems } = loadPacks();
  const sw = d ? readSwitches(d, rk) : new Map<string, Switch>();
  const entries: Base[] = [];
  for (const p of packs) {
    const packOn = sw.get(`pack:${p.id}`)?.enabled ?? p.on;
    for (const r of p.rules) {
      const id = `${p.id}/${r.id}`;
      const s = sw.get(`entry:${id}`);
      const off: Base['off'] = !packOn ? 'pack' : s && !s.enabled ? (s.why === 'expired' ? 'expired' : 'person') : null;
      entries.push({
        id, kind: 'standard', pack: p.id, packName: p.name, name: r.name, ref: r.ref, how: r.sources.length ? 'sources' : 'question',
        detector: r.sources.length ? `Assay ${r.sources.length > 1 ? 'checks' : 'check'}: ${r.sources.join(', ')}` : 'A question for a reviewer',
        sources: r.sources, pattern: null, question: r.question, langs: r.langs, bad: r.bad, good: r.good,
        origin: `${p.name}${p.edition ? ` (${p.edition})` : ''}`, on: off === null, off, expirable: isSignal(r.sources), fixes: 0, examples: [],
        lens: r.lens, severity: 'low'
      });
    }
  }
  if (d) for (const l of learnedRows(d, rk)) {
    const s = sw.get(`entry:${l.id}`);
    const off: Base['off'] = s && !s.enabled ? (s.why === 'expired' ? 'expired' : 'person') : null;
    entries.push({
      id: l.id, kind: 'learned', pack: null, packName: null, name: l.name, ref: l.ref, how: 'pattern',
      detector: `A pattern in ${l.langs.length ? l.langs.join(', ') : 'any language'}`, sources: [`memory:${l.id}`], pattern: { source: l.pattern, flags: l.flags },
      question: null, langs: l.langs, bad: l.bad, good: l.good, origin: l.origin || 'Added by hand', on: off === null, off, expirable: true, fixes: l.fixes, examples: l.examples,
      lens: l.lens, severity: l.severity
    });
  }
  return { packs, problems, entries, sw };
}

function readStats(d: Db, rk: string): Map<string, EntryStats> {
  const out = new Map<string, EntryStats>();
  for (const r of d.prepare('SELECT entry, COUNT(*) AS hits, SUM(dismissed) AS fp, MAX(at) AS last, MAX(CASE WHEN dismissed = 0 THEN at END) AS real FROM hits WHERE repo = ? GROUP BY entry').all(rk)) {
    out.set(String(r.entry), { hits: Number(r.hits), falseAlarms: Number(r.fp ?? 0), lastHit: (r.last as string | null) ?? null, lastReal: (r.real as string | null) ?? null, weeks: new Array<number>(WEEKS).fill(0) });
  }
  const now = Date.now();
  const since = new Date(now - WEEKS * 7 * DAY).toISOString();
  for (const r of d.prepare('SELECT entry, at FROM hits WHERE repo = ? AND at >= ?').all(rk, since)) {
    const s = out.get(String(r.entry));
    if (!s) continue;
    const ago = Math.max(0, Math.floor((now - Date.parse(String(r.at))) / (7 * DAY)));
    s.weeks[Math.max(0, WEEKS - 1 - ago)]++;
  }
  return out;
}

const emptyStats = (): EntryStats => ({ hits: 0, falseAlarms: 0, lastHit: null, lastReal: null, weeks: new Array<number>(WEEKS).fill(0) });

function statusOf(e: Base, s: EntryStats): EntryStatus {
  if (e.how === 'question') return e.on ? 'question' : 'off';
  if (!e.on) return e.off === 'expired' ? 'expired' : 'off';
  if (!s.hits) return 'new';
  return s.hits >= EXPIRY.warnHits && s.falseAlarms / s.hits >= EXPIRY.falseShare ? 'expiring' : 'active';
}

/** An entry that cries wolf switches itself off (D32): enough hits, too many dismissed, nothing real lately. A person turning it back on gets a fresh period. */
function expireStale(d: Db, rk: string, entries: Base[], stats: Map<string, EntryStats>, sw: Map<string, Switch>): string[] {
  const now = Date.now();
  const flipped: string[] = [];
  for (const e of entries) {
    if (!e.on || !e.expirable) continue;
    const s = stats.get(e.id);
    if (!s || s.hits < EXPIRY.minHits || s.falseAlarms / s.hits < EXPIRY.falseShare) continue;
    if (s.lastReal && now - Date.parse(s.lastReal) < EXPIRY.quietDays * DAY) continue;
    const mine = sw.get(`entry:${e.id}`);
    if (mine && mine.enabled && mine.why === 'person' && now - Date.parse(mine.at) < EXPIRY.quietDays * DAY) continue;
    writeSwitch(d, rk, `entry:${e.id}`, false, 'expired');
    flipped.push(e.id);
  }
  return flipped;
}

/** Everything memory knows about a repository: entries with their stats and status. Looking also applies expiry, since time passing is an event. */
export function listEntries(repo: string): Entry[] {
  const d = openDb();
  const rk = repoKey(repo);
  let { entries, sw } = structure(repo, d);
  const stats = d ? readStats(d, rk) : new Map<string, EntryStats>();
  if (d && expireStale(d, rk, entries, stats, sw).length) ({ entries, sw } = structure(repo, d));
  return entries.map(e => { const s = stats.get(e.id) ?? emptyStats(); return { ...e, stats: s, status: statusOf(e, s) }; });
}

export function listPacks(repo: string): { packs: PackView[]; problems: string[] } {
  const d = openDb();
  const { packs, problems, sw } = structure(repo, d);
  return {
    packs: packs.map(p => ({
      id: p.id, name: p.name, edition: p.edition, source: p.source, note: p.note, origin: p.origin, file: p.file,
      on: sw.get(`pack:${p.id}`)?.enabled ?? p.on, rules: p.rules.length, checked: p.rules.filter(r => r.sources.length).length, questions: p.rules.filter(r => !r.sources.length).length
    })),
    problems
  };
}

function need(): Db {
  const d = openDb();
  if (!d) throw new Error('Memory is not available here.');
  return d;
}

export function setPack(repo: string, id: string, on: boolean): void {
  const d = need();
  if (!loadPacks().packs.some(p => p.id === id)) throw new Error(`There is no pack "${id}".`);
  writeSwitch(d, repoKey(repo), `pack:${id}`, on, 'person');
}

export function setEntry(repo: string, id: string, on: boolean): void {
  const d = need();
  if (!structure(repo, d).entries.some(e => e.id === id)) throw new Error(`There is no entry "${id}".`);
  writeSwitch(d, repoKey(repo), `entry:${id}`, on, 'person');
}

/** The reasons a pattern is refused. A pattern is the person's own and runs on added lines only, but a few shapes are never right. */
export function checkPattern(pattern: unknown, flags: unknown = ''): { source: string; flags: string } {
  if (typeof pattern !== 'string' || pattern.length < 2) throw new Error('A pattern needs at least two characters.');
  if (pattern.length > 200) throw new Error('A pattern can be at most 200 characters.');
  const f = typeof flags === 'string' ? flags : '';
  if (!/^i?$/.test(f)) throw new Error('The only flag allowed is i (ignore case).');
  let re: RegExp;
  try { re = new RegExp(pattern, f); } catch { throw new Error('That is not a valid pattern.'); }
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) throw new Error('A pattern may not repeat something that already repeats: it can run for ever.');
  const broad = ['', ' ', 'a', 'x', 'const x = 1;', 'return', '{}'].filter(s => re.test(s)).length;
  if (broad >= 3) throw new Error('That pattern matches almost every line. Make it say what is wrong.');
  return { source: pattern, flags: f };
}

export interface LearnedInput {
  name: string; pattern: string; flags?: string; langs?: string[]; ref?: string; bad?: string; good?: string; origin?: string;
  fixes?: number; examples?: Example[]; lens?: Lens; severity?: Severity;
}

const LENSES: Lens[] = ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Scope', 'Performance'];

/** Teaches memory a pattern of this project's own. A learned pattern is a signal: it can't be proof and can't be more than medium (D33). */
export function addLearned(repo: string, input: LearnedInput): Entry {
  const d = need();
  const rk = repoKey(repo);
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 140) throw new Error('Give it a name of up to 140 characters.');
  const p = checkPattern(input.pattern, input.flags ?? '');
  const langs = (input.langs ?? []).filter(l => typeof l === 'string' && l.length <= 40).slice(0, 20);
  const lens = LENSES.includes(input.lens as Lens) ? (input.lens as Lens) : 'Correctness';
  const severity: Severity = input.severity === 'medium' ? 'medium' : 'low';
  const clean = (s: string | undefined, n: number): string | null => (s ? redactSecrets(String(s)).slice(0, n) : null);
  const count = Number(d.prepare('SELECT COUNT(*) AS n FROM learned WHERE repo = ?').get(rk)?.n ?? 0);
  if (count >= MAX_LEARNED) throw new Error(`Memory holds up to ${MAX_LEARNED} learned patterns per project. Remove one first.`);
  if (d.prepare('SELECT 1 AS x FROM learned WHERE repo = ? AND pattern = ? AND flags = ?').get(rk, p.source, p.flags)) throw new Error('That pattern is already in memory.');
  const examples = (input.examples ?? []).slice(0, 3).map(e => ({ commit: String(e.commit).slice(0, 40), subject: redactSecrets(String(e.subject)).slice(0, 140), bad: redactSecrets(String(e.bad)).slice(0, 160), good: redactSecrets(String(e.good)).slice(0, 160) }));
  const r = d.prepare('INSERT INTO learned (repo, name, ref, pattern, flags, langs, lens, severity, bad, good, origin, fixes, examples, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(rk, name, clean(input.ref, 90), p.source, p.flags, JSON.stringify(langs), lens, severity, clean(input.bad, 200), clean(input.good, 200), String(input.origin ?? '').slice(0, 300),
      Math.max(0, Math.min(1000, Math.floor(Number(input.fixes) || 0))), JSON.stringify(examples), new Date().toISOString());
  bumpMemory();
  const id = `L-${r.lastInsertRowid}`;
  return listEntries(repo).find(e => e.id === id) as Entry;
}

export function removeLearned(repo: string, id: string): void {
  const d = need();
  const rk = repoKey(repo);
  const m = /^L-(\d+)$/.exec(id);
  if (!m) throw new Error('Only a learned entry can be removed. A standard one can be switched off.');
  const r = d.prepare('DELETE FROM learned WHERE repo = ? AND n = ?').run(rk, Number(m[1]));
  if (!r.changes) throw new Error(`There is no learned entry ${id}.`);
  d.prepare('DELETE FROM hits WHERE repo = ? AND entry = ?').run(rk, id);
  d.prepare('DELETE FROM switches WHERE repo = ? AND key = ?').run(rk, `entry:${id}`);
  bumpMemory();
}

/** Which entries each finding of a case belongs to: the ones whose detector produced one of its pieces of evidence. */
export function linksFor(c: Case): Record<string, string[]> {
  const { entries } = structure(c.repo, openDb());
  const det = entries.filter(e => e.sources.length);
  const out: Record<string, string[]> = {};
  for (const f of c.findings) {
    const ids = det.filter(e => e.sources.some(p => f.evidence.some(ev => sourceMatches(p, ev.source)))).map(e => e.id);
    if (ids.length) out[f.id] = ids;
  }
  return out;
}

/** Keeps a hit for every finding of the case that an entry is about. Safe to call again and again: a finding counts once. */
export function recordCase(c: Case): void {
  const d = openDb();
  if (!d || !c.findings.length) return;
  const rk = repoKey(c.repo);
  const links = linksFor(c);
  const ids = Object.keys(links);
  if (!ids.length) return;
  const when = new Map(c.commits.map(x => [x.hash, x.date]));
  const ins = d.prepare('INSERT OR IGNORE INTO hits (repo, entry, finding, commit_hash, at, dismissed) VALUES (?, ?, ?, ?, ?, ?)');
  let added = 0;
  inTransaction(d, () => {
    for (const f of c.findings) for (const entry of links[f.id] ?? []) added += Number(ins.run(rk, entry, f.id, f.commit, iso(when.get(f.commit)), c.resolved[f.id] === 'dismissed' ? 1 : 0).changes);
  });
  if (added) {
    const { entries, sw } = structure(c.repo, d);
    expireStale(d, rk, entries, readStats(d, rk), sw);
  }
}

/** A person dismissed a finding (a false alarm for whatever entries it belongs to) or took that back. */
export function feedback(c: Case, findingId: string, how: 'dismissed' | 'intended' | null): void {
  const d = openDb();
  if (!d) return;
  const rk = repoKey(c.repo);
  d.prepare('UPDATE hits SET dismissed = ? WHERE repo = ? AND finding = ?').run(how === 'dismissed' ? 1 : 0, rk, findingId);
  const { entries, sw } = structure(c.repo, d);
  expireStale(d, rk, entries, readStats(d, rk), sw);
}

/** The questions a reviewer should ask, for these languages (or all). Only the ones switched on. */
export function questions(repo: string, languages?: string[], lens?: Lens): Entry[] {
  return listEntries(repo).filter(e => e.how === 'question' && e.on && (!lens || e.lens === lens) && (!languages?.length || !e.langs.length || e.langs.some(l => languages.includes(l))));
}

/** Everything the page needs about the entries behind a case's findings, small enough to send with the case. */
export function summariesFor(c: Case): Record<string, Array<{ id: string; name: string; kind: Entry['kind']; status: EntryStatus; hits: number; falseAlarms: number; detector: string }>> {
  const links = linksFor(c);
  if (!Object.keys(links).length) return {};
  const byId = new Map(listEntries(c.repo).map(e => [e.id, e]));
  const out: ReturnType<typeof summariesFor> = {};
  for (const [fid, ids] of Object.entries(links)) {
    out[fid] = ids.flatMap(id => { const e = byId.get(id); return e ? [{ id, name: e.name, kind: e.kind, status: e.status, hits: e.stats.hits, falseAlarms: e.stats.falseAlarms, detector: e.detector }] : []; });
  }
  return out;
}

/** The structure of memory for a repository: packs, every entry (no stats), switches. For the runtime. */
export const entryStructure = (repo: string): ReturnType<typeof structure> => structure(repo, openDb());

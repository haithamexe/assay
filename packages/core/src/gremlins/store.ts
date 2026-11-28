import fs from 'node:fs';
import path from 'node:path';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import { repoKey, repoRoot } from '../git.js';
import { GREMLINS_SCHEMA, type GremlinsReport } from './gremlins.js';

/* Kept gremlins runs (D66): the last 30 per project under ~/.assay/gremlins, so a run can be compared with the one before and replayed. */

const ID = /^gr-\d{14}-[0-9a-f]{6}$/;
const KEEP = 30;
const folder = (repo: string): string => assayPath('gremlins', repoKey(repo));

export function newRunId(repo: string, commit: string, seed: number): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `gr-${stamp}-${sha(`${repo}\0${commit}\0${seed}\0${d.toISOString()}\0${Math.random()}`, 6)}`;
}

/** The runs kept for a project, newest first. A file that isn't a run is skipped. */
export function listGremlinRuns(repo: string): GremlinsReport[] {
  const dir = folder(repoRoot(repo));
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => ID.test(n.replace(/\.json$/, ''))); } catch { return []; }
  const out: GremlinsReport[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as GremlinsReport;
      if (r.schema === GREMLINS_SCHEMA && ID.test(r.id)) out.push(r);
    } catch { /* a broken file is only a run fewer */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** A kept run by its id, or by the start of it when only one matches. */
export function loadGremlinRun(repo: string, id: string): GremlinsReport | null {
  const all = listGremlinRuns(repo);
  const exact = all.find(r => r.id === id);
  if (exact) return exact;
  if (id.length < 6) return null;
  const some = all.filter(r => r.id.startsWith(id));
  return some.length === 1 ? some[0] : null;
}

/** Marks each problem first, new or already there against the newest kept run of the same app, and lists what that run had and this one didn't meet. */
export function compareRuns(r: GremlinsReport): void {
  const prev = listGremlinRuns(r.repo).find(p => p.mode === r.mode && (r.mode === 'copy' || p.url === r.url));
  if (!prev) { for (const f of r.findings) f.since = 'first'; r.previous = null; r.gone = []; return; }
  const had = new Set(prev.findings.map(f => f.id));
  const has = new Set(r.findings.map(f => f.id));
  for (const f of r.findings) f.since = had.has(f.id) ? 'before' : 'new';
  r.previous = { id: prev.id, createdAt: prev.createdAt, seed: prev.seed, commit: prev.commit };
  r.gone = prev.findings.filter(f => !has.has(f.id)).map(f => ({ id: f.id, kind: f.kind, title: f.title, text: f.text })).slice(0, 50);
}

export function keepRun(r: GremlinsReport): void {
  writeFileAtomic(path.join(folder(r.repo), `${r.id}.json`), JSON.stringify(r));
  for (const old of listGremlinRuns(r.repo).slice(KEEP)) { try { fs.rmSync(path.join(folder(r.repo), `${old.id}.json`), { force: true }); } catch { /* pruned next time */ } }
}

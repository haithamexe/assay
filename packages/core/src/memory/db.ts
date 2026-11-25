import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assayPath } from '../config.js';

/**
 * Memory lives in one SQLite file, ~/.assay/memory.db, through Node's own `node:sqlite` (D29). Nothing is installed.
 * Everything here fails soft: where `node:sqlite` isn't there (Node before 22.13) or the file can't be opened, memory is
 * simply off, says why, and the rest of Assay is unaffected.
 */
interface Stmt {
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Array<Record<string, unknown>>;
}
export interface Db { exec(sql: string): void; prepare(sql: string): Stmt; close(): void }
type Ctor = new (file: string) => Db;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE learned (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  ref TEXT,
  pattern TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  langs TEXT NOT NULL DEFAULT '[]',
  lens TEXT NOT NULL DEFAULT 'Correctness',
  severity TEXT NOT NULL DEFAULT 'low',
  bad TEXT,
  good TEXT,
  origin TEXT NOT NULL DEFAULT '',
  fixes INTEGER NOT NULL DEFAULT 0,
  examples TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX learned_repo ON learned(repo);
CREATE TABLE hits (
  repo TEXT NOT NULL,
  entry TEXT NOT NULL,
  finding TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, entry, finding)
);
CREATE INDEX hits_finding ON hits(repo, finding);
CREATE TABLE switches (
  repo TEXT NOT NULL,
  key TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  why TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, key)
);
`;

let ctor: Ctor | null | undefined;
let unavailable = '';

function sqlite(): Ctor | null {
  if (ctor !== undefined) return ctor;
  // Node says "SQLite is an experimental feature" the first time it is loaded; that is not news to anyone using memory.
  const emit = process.emitWarning;
  process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
    if (/sqlite/i.test(String((w as { message?: string })?.message ?? w))) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    ctor = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: Ctor }).DatabaseSync;
  } catch {
    ctor = null;
    unavailable = 'Memory needs Node 22.13 or newer, which has SQLite built in. Everything else works without it.';
  } finally {
    process.emitWarning = emit;
  }
  return ctor;
}

let db: Db | null = null;
let dbFile = '';

export const memoryFile = (): string => assayPath('memory.db');

/** The open database, or null (and `memoryProblem()` says why). One connection per process, reopened if ASSAY_HOME changes. */
export function openDb(): Db | null {
  const file = memoryFile();
  if (db && dbFile === file) return db;
  closeDb();
  const Database = sqlite();
  if (!Database) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const d = new Database(file);
    d.exec('PRAGMA busy_timeout = 4000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    const v = Number(d.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (v === 0) {
      d.exec('BEGIN');
      try { d.exec(SCHEMA); d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); d.exec('COMMIT'); } catch (err) { d.exec('ROLLBACK'); throw err; }
      try { fs.chmodSync(file, 0o600); } catch { /* no modes here */ }
    } else if (v > SCHEMA_VERSION) {
      d.close();
      unavailable = `${file} was made by a newer Assay. Update Assay, or move that file away.`;
      return null;
    }
    db = d;
    dbFile = file;
    unavailable = '';
    return d;
  } catch (err) {
    unavailable = `Memory could not open ${file}: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

export function closeDb(): void {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = null;
  dbFile = '';
}

/** Counts changes to what decides how a commit is analysed (switches, learned patterns), so a memo of it knows when it is stale. */
let version = 0;
export const bumpMemory = (): void => { version++; };
export const memoryVersion = (): number => version;

/** Is memory working, and if not, why. */
export function memoryStatus(): { available: boolean; why: string | null } {
  const d = openDb();
  return d ? { available: true, why: null } : { available: false, why: unavailable || 'Memory is not available.' };
}

/** Runs several statements as one: all of it or none of it. */
export function inTransaction<T>(d: Db, fn: () => T): T {
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

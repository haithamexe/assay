import fs from 'node:fs';
import path from 'node:path';
import { assayPath, writeFileAtomic } from '../config.js';
import { repoKey } from '../git.js';
import type { Lens } from '../types.js';

/** Calibration runs and what they taught, kept under ~/.assay/calibration (D45). Nothing here imports the planner: the planner reads this. */
export interface PlantedBug { id: string; name: string; lens: Lens; file: string; line: number; side: 'added' | 'removed' }

export interface CalibrationRun {
  id: string;
  /** The project it was run for. */
  repo: string;
  createdAt: string;
  /** The throwaway repository the bugs were planted in. */
  dir: string;
  base: string;
  planted: { case: string; head: string; bugs: PlantedBug[] };
  control: { case: string; head: string };
  /** Templates that didn't fit this project, and why. */
  skipped: Array<{ id: string; name: string; why: string }>;
  /** Where in the project each language lives, which the files were placed after. */
  shape: Record<string, string>;
  budget: number;
}

/** What one finished run says about one reviewer: enough to decide whether it earns its tokens. */
export interface LensRecord { ran: boolean; chances: number; hits: number; alarms: number }
export interface FinishedRun { run: string; at: string; lenses: Record<string, LensRecord> }
interface Index { runs: string[]; finished: FinishedRun[] }

export const RUN_ID = /^cal-[0-9a-f]{8}$/;
const MAX_FINISHED = 10;
const MAX_KEPT = 5;

export const calibrationDir = (): string => assayPath('calibration');
export const runDir = (id: string): string => {
  if (!RUN_ID.test(id)) throw new Error(`"${id}" is not a calibration run`);
  return assayPath('calibration', id);
};
const indexFile = (repo: string): string => assayPath('calibration', `${repoKey(repo)}.json`);

function readIndex(repo: string): Index {
  try {
    const i = JSON.parse(fs.readFileSync(indexFile(repo), 'utf8')) as Partial<Index>;
    return { runs: Array.isArray(i.runs) ? i.runs : [], finished: Array.isArray(i.finished) ? i.finished : [] };
  } catch { return { runs: [], finished: [] }; }
}

export function saveRun(run: CalibrationRun): void {
  writeFileAtomic(path.join(runDir(run.id), 'run.json'), JSON.stringify(run));
  const i = readIndex(run.repo);
  i.runs = [run.id, ...i.runs.filter(x => x !== run.id)];
  writeFileAtomic(indexFile(run.repo), JSON.stringify(i));
}

export function loadRun(id: string): CalibrationRun | null {
  try { return JSON.parse(fs.readFileSync(path.join(runDir(id), 'run.json'), 'utf8')) as CalibrationRun; } catch { return null; }
}

/** The newest run for a project that is still on disk. */
export function latestRun(repo: string): CalibrationRun | null {
  for (const id of readIndex(repo).runs) { const r = loadRun(id); if (r) return r; }
  return null;
}

export function listRuns(repo: string): CalibrationRun[] {
  return readIndex(repo).runs.map(loadRun).filter((r): r is CalibrationRun => !!r);
}

export const history = (repo: string): FinishedRun[] => readIndex(repo).finished;

/** Keeps what a finished run showed. A run counts once, however often it is read. */
export function keepResult(repo: string, f: FinishedRun): void {
  const i = readIndex(repo);
  if (i.finished.some(x => x.run === f.run)) return;
  i.finished = [f, ...i.finished].slice(0, MAX_FINISHED);
  writeFileAtomic(indexFile(repo), JSON.stringify(i));
}

/**
 * Reviewers that don't earn their tokens (D46). A reviewer is left out of the plan when its last two finished runs each planted at least one bug
 * in its lens and it caught none of them: one run is a hint, two in a row is a record. A person can still bring it back (`--include`).
 */
export function routedOut(repo: string): Map<Lens, string> {
  const out = new Map<Lens, string>();
  const finished = history(repo);
  for (const lens of ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Performance'] as Lens[]) {
    const last = finished.map(f => f.lenses[lens]).filter((x): x is LensRecord => !!x && x.ran && x.chances > 0).slice(0, 2);
    if (last.length === 2 && last.every(x => x.hits === 0)) out.set(lens, `It caught none of the ${last[0].chances + last[1].chances} bugs planted in its lens in the last 2 calibration runs.`);
  }
  return out;
}

/** Removes the throwaway repositories of old runs (and optionally all of them). The record of what they showed stays. */
export function cleanRuns(repo: string, all = false): number {
  const i = readIndex(repo);
  const drop = all ? i.runs : i.runs.slice(MAX_KEPT);
  let n = 0;
  for (const id of drop) { try { fs.rmSync(runDir(id), { recursive: true, force: true, maxRetries: 3 }); n++; } catch { /* left for next time */ } }
  i.runs = i.runs.filter(x => !drop.includes(x));
  writeFileAtomic(indexFile(repo), JSON.stringify(i));
  return n;
}

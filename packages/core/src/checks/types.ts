import type { FileDiff } from '../diff.js';
import type { Evidence, Lens, Severity } from '../types.js';

/** What a check sees: one commit, its diff, and a way to read files as they were. */
export interface CommitCtx {
  repo: string;
  commit: string;
  parent: string | null;
  date: string;
  subject: string;
  files: FileDiff[];
  read(file: string, rev: 'commit' | 'parent'): string | null;
}

/** What a check returns. It never sets a tier or an id: the engine does (D3). */
export interface RawFinding {
  check: string;
  /** Makes the finding's id stable across runs. */
  key: string;
  title: string;
  lens: Lens;
  severity: Severity;
  file: string;
  line: number;
  side: 'added' | 'removed';
  /** The text on that line, to look for again at the head of a range. */
  text: string;
  evidence: Array<Omit<Evidence, 'id' | 'file' | 'line' | 'replay'> & { line?: number; run?: NonNullable<Evidence['replay']>['run'] }>;
  observed: string[];
  inferred: string[];
  ref?: string;
}

export type Check = (ctx: CommitCtx) => RawFinding[];

export const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

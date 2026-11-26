/* The model (docs/PROJECT.md §4). Everything here is plain JSON so it can be stored, sent over MCP and rendered. */

export type Severity = 'high' | 'medium' | 'low';
export type Tier = 'proven' | 'corroborated' | 'hint';
export type Lens = 'Security' | 'Correctness' | 'UI' | 'Tests' | 'Supply chain' | 'Scope' | 'Performance';

/** Reproducible, shows real behaviour or a literal that is wrong by itself. One of these makes a finding proven. */
export type ProofKind = 'fact' | 'test-fail' | 'probe' | 'behaviour-diff' | 'measurement' | 'mutation-survivor' | 'revert-test';
/** A reading or a pattern: it can point at a problem but doesn't show one. Two from different sources corroborate. */
export type SignalKind = 'rule' | 'diff' | 'history' | 'coverage' | 'registry' | 'scope' | 'claim';
export type EvidenceKind = ProofKind | SignalKind;

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  /** Who produced it: "rule:html-injection", "diff:no-test", "reviewer:Security". Two signals count together only if their sources differ. */
  source: string;
  what: string;
  file?: string;
  line?: number;
  /** What `assay replay` re-runs: the commit to analyse again. */
  replay?: { commit: string; run?: { kind: 'tests' | 'revert' | 'mutant' | 'look' | 'bisect'; file?: string; line?: number; op?: string; /** A bisect: the commit the tests passed at and the next one, where they fail. */ between?: { good: string; bad: string } } };
}

export interface DiffRow { t: ' ' | '+' | '-'; o: number | null; n: number | null; text: string; sig?: boolean }
export interface Snippet { file: string; header: string; rows: DiffRow[] }

export interface Finding {
  /** Stable: the same mistake in the same commit has the same id on every run. */
  id: string;
  check: string;
  title: string;
  lens: Lens;
  severity: Severity;
  commit: string;
  file: string;
  /** The line the finding is about, in the new file for an added line, the old file for a removed one. */
  line: number;
  lines: string;
  evidence: Evidence[];
  /** Facts from the diff. Never a guess. */
  observed: string[];
  /** What it might mean. Never blocks. */
  inferred: string[];
  /** Why it ranks where it does, short. */
  why: string[];
  risk: number;
  tier: Tier;
  snippet: Snippet;
  /** What to look for at the head of the range to know if the finding is still there. */
  anchor: { side: 'added' | 'removed'; text: string };
  ref?: string;
  /** Set when a case is built: is it still in the net diff? */
  present?: boolean;
  origin: 'check' | 'claim' | 'run';
}

export interface FileFact { path: string; oldPath: string | null; status: string; language: string | null; additions: number; deletions: number; test: boolean }

export interface CommitSummary {
  hash: string;
  short: string;
  parent: string | null;
  subject: string;
  author: string;
  date: string;
  files: number;
  additions: number;
  deletions: number;
  languages: string[];
  counts: { proven: number; corroborated: number; hint: number };
  maxSeverity: Severity | null;
  risk: number;
  /** Seconds the free checks took on this commit (the first time; cached after). */
  secs: number;
}

/** `m` is the digest of what memory changed about the analysis (absent when it changed nothing): a cached analysis only counts for the same memory. */
export interface CommitAnalysis { v: number; m?: string; summary: CommitSummary; files: FileFact[]; findings: Finding[] }

export interface Claim {
  title: string;
  lens: Lens;
  severity?: Severity;
  file: string;
  line: number;
  commit?: string;
  /** What the reviewer says, in a sentence or two. */
  what: string;
  /** "reviewer:Security". */
  source: string;
  /** Anything that backs it up beyond the reading itself. */
  evidence?: Array<{ kind: EvidenceKind; source: string; what: string }>;
}

export interface Dropped { claim: Claim; reason: 'no-location' | 'empty' | 'outside-diff' }
export interface GateResult { kept: Finding[]; merged: Array<{ claim: Claim; findingId: string }>; dropped: Dropped[] }

export interface Verdict {
  tone: 'blocked' | 'mergeable' | 'clear';
  headline: string;
  must: Finding[];
  should: Finding[];
  decide: Finding[];
  hints: Finding[];
}

export interface Case {
  id: string;
  repo: string;
  name: string;
  base: string | null;
  head: string;
  createdAt: string;
  commits: CommitSummary[];
  findings: Finding[];
  /** Every claim a reviewer submitted. Kept so the gate can run again whenever the case is rebuilt. */
  claims: Claim[];
  /** Claims the gate threw away, kept so the person can see what was dropped. */
  dropped: Dropped[];
  files: number;
  languages: string[];
  /** Findings the person dismissed or marked intended: id -> how. */
  resolved: Record<string, 'dismissed' | 'intended'>;
  skippedMerges: number;
  /** What Assay ran for this case (the project's tests, reverts, mutants), so a reopened case keeps its proof without running anything. */
  runs: RunRecord[];
  /** The reviewer panel planned for this case: who is to review, what it costs, and who has reported (D36). Absent until someone plans one. */
  panel?: Panel;
}

/**
 * A reviewer is one lens, run by an agent the person already has (Assay never calls a model). Assay plans who is worth their tokens,
 * hands each one only its own slice, and counts what comes back through the evidence gate.
 */
export interface PanelReviewer {
  /** The lens, which is also the name a reviewer reports under: `reviewer:<lens>`. */
  lens: Lens;
  /** What the screen calls it ("UI & accessibility"). */
  name: string;
  run: boolean;
  /** Why it is worth running, or why it isn't. */
  why: string;
  skip?: 'not-needed' | 'budget' | 'off' | 'no-request' | 'calibration';
  /** Tokens it is estimated to cost: its brief, its slice and room for an answer. Counted by characters, so roughly. */
  tokens: number;
  state: 'planned' | 'briefed' | 'reported';
  briefedAt?: string;
  reportedAt?: string;
  /** What came back through the gate. */
  claims: number;
  kept: number;
  merged: number;
  dropped: number;
  /** What the agent said it spent, if it said. */
  reportedTokens?: number;
}

export interface PanelCross {
  run: boolean;
  tokens: number;
  /** planned: waiting for the specialists. open: they have all reported. done: every examiner has reported. */
  state: 'planned' | 'open' | 'done';
  /** Lens of an examiner -> ids of the findings it is asked to examine. Fixed when cross-examination opens. */
  assigned: Record<string, string[]>;
  briefed: string[];
  reported: string[];
  /** Claims made in cross-examination that landed on another reviewer's finding: the second signal that makes it corroborated. */
  confirmed: number;
  /** A reviewer who doubts another's claim says so here; it never changes a tier. */
  disputes: Array<{ finding: string; by: string; reason: string }>;
}

/**
 * The attack pass (D50): one more reviewer, outside the lenses, whose only job is to break the change with a concrete input or sequence.
 * It is independent (it never sees another reviewer's claims, only what the free checks found), it costs the most, so it only runs on a
 * big budget and only when something that runs changed, and what it reports meets the same evidence gate: at best corroborated.
 */
export interface PanelAttack {
  run: boolean;
  /** Why it runs, or why it doesn't. */
  why: string;
  skip?: 'not-needed' | 'budget' | 'off';
  /** Tokens it is estimated to cost: the brief, every changed file that runs, and room for an answer. Roughly. */
  tokens: number;
  state: 'planned' | 'briefed' | 'reported';
  briefedAt?: string;
  reportedAt?: string;
  claims: number;
  kept: number;
  merged: number;
  dropped: number;
  reportedTokens?: number;
}

export interface Panel {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Tokens the reviewers may cost in all. 0 = free checks only. */
  budget: number;
  /** What the person asked for, so the Scope reviewer can trace each change to it. */
  request: string | null;
  reviewers: PanelReviewer[];
  cross: PanelCross;
  /** Absent in a panel kept before the attack pass existed. */
  attack?: PanelAttack;
  /** Only in calibration runs (D51): one plain review of the whole change, the stick the panel is measured against. Same shape as the attack pass. */
  baseline?: PanelAttack;
  estimate: { total: number; specialists: number; cross: number; saved: number; attack?: number; baseline?: number };
}

export interface RunRecord {
  id: string;
  kind: 'tests' | 'revert' | 'mutation' | 'browser';
  at: string;
  secs: number;
  command: string;
  summary: string;
  /** Findings this run produced (proof findings). */
  findings: Finding[];
  /** Evidence this run adds to findings that other checks produced (a coverage signal on a risky hunk). */
  signals: Array<{ findingId: string; evidence: Evidence }>;
  /** Before and after screenshots of the pages that were looked at (files under ~/.assay/shots/<case>). */
  shots?: ShotRecord[];
}

/** A measured problem on a screenshot: a box in CSS pixels from the top left of the page, as the browser laid it out. */
export interface ShotMark { kind: string; x: number; y: number; w: number; h: number; label: string }

export interface ShotRecord {
  page: string;
  combo: string;
  /** What was measured at the head in this picture and was not there at the base. Missing in cases kept before this existed. */
  marks?: ShotMark[];
  /** Share of pixels that changed, 0 to 1. */
  changed: number;
  box: { x: number; y: number; w: number; h: number } | null;
  base: string;
  head: string;
  diff: string;
}

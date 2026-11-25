import { reviewerFor } from '../reviewers/lenses.js';
import { loadCase } from '../store.js';
import type { Case, Finding, Lens, PanelReviewer } from '../types.js';
import { keepResult, routedOut, type CalibrationRun, type LensRecord, type PlantedBug } from './record.js';

/**
 * Scoring (D45): what the free checks and each reviewer did with the planted bugs and with their clean twins, read from the two cases. Nothing is
 * stored to be scored: the cases hold every finding and every claim, so the scoreboard is worked out each time and moves as an agent reports.
 */
export type Cell = 'C' | 'h' | 'm' | '-' | 'n';
export const LENSES: Lens[] = ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Performance'];

export interface BugResult { bug: PlantedBug; free: 'C' | 'h' | 'm'; cells: Partial<Record<Lens, Cell>> }
export interface Row {
  id: 'free' | Lens;
  name: string;
  ran: boolean;
  /** Caught, with proof. */
  caught: number;
  /** Flagged, without proof. */
  flagged: number;
  /** Missed a bug in its own lens (the free checks: any bug). */
  missed: number;
  /** Flags on the clean twins. */
  alarms: number;
  tokens: number | null;
  tokensKind: 'reported' | 'estimate' | null;
  perCatch: number | null;
  /** Bugs planted in its lens, and how many of those it flagged or caught. */
  chances: number;
  hits: number;
  advice: string;
}

export interface Scoreboard {
  run: string;
  createdAt: string;
  complete: boolean;
  planted: number;
  /** Caught by the free checks alone, with proof, at no cost. */
  freeProven: number;
  /** Flagged by the free checks, with or without proof. */
  freeSeen: number;
  /** Flagged by anyone. */
  seen: number;
  reviewersRan: number;
  rows: Row[];
  bugs: BugResult[];
  skipped: CalibrationRun['skipped'];
  cases: { planted: string; control: string };
}

const NAMES: Record<string, string> = { free: 'Free checks (no model)', Security: 'Security', Correctness: 'Correctness', UI: 'UI & accessibility', Tests: 'Tests', 'Supply chain': 'Supply chain', Performance: 'Performance' };

/** A finding about the defect itself. A note that no test changed (`diff:`), the project's history or a coverage hint is about process, not about the bug. */
const aboutDefect = (f: Finding): boolean => f.evidence.some(e => !/^(?:reviewer|diff|history|coverage):/.test(e.source));
const lensesOf = (f: Finding): Set<Lens> => new Set(f.evidence.filter(e => e.source.startsWith('reviewer:')).map(e => reviewerFor(e.source.slice('reviewer:'.length))?.lens).filter((l): l is Lens => !!l));
const near = (c: Case, b: PlantedBug): Finding[] => c.findings.filter(f => f.file === b.file && Math.abs(f.line - b.line) <= 3);
const best = (fs: Finding[]): 'C' | 'h' | null => (fs.some(f => f.tier === 'proven') ? 'C' : fs.length ? 'h' : null);
const panelOf = (c: Case, lens: Lens): PanelReviewer | undefined => c.panel?.reviewers.find(r => r.lens === lens);

export function scoreRun(run: CalibrationRun, o: { persist?: boolean } = {}): Scoreboard {
  const a = loadCase(run.planted.case);
  const b = loadCase(run.control.case);
  if (!a || !b) throw new Error('The cases of this calibration run are gone. Run assay calibrate start again.');
  const ran = (lens: Lens): boolean => panelOf(a, lens)?.run === true && panelOf(a, lens)?.state === 'reported';
  const bugs: BugResult[] = run.planted.bugs.map(bug => {
    const fs = near(a, bug);
    const free = best(fs.filter(aboutDefect)) ?? 'm';
    const cells: Partial<Record<Lens, Cell>> = {};
    for (const lens of LENSES) {
      if (!ran(lens)) { cells[lens] = 'n'; continue; }
      const hit = best(fs.filter(f => lensesOf(f).has(lens)));
      cells[lens] = hit ?? (bug.lens === lens ? 'm' : '-');
    }
    return { bug, free, cells };
  });
  const freeAlarms = b.findings.filter(aboutDefect).length;
  const rows: Row[] = [{
    id: 'free', name: NAMES.free, ran: true, caught: bugs.filter(x => x.free === 'C').length, flagged: bugs.filter(x => x.free === 'h').length, missed: bugs.filter(x => x.free === 'm').length,
    alarms: freeAlarms, tokens: 0, tokensKind: null, perCatch: null, chances: bugs.length, hits: bugs.filter(x => x.free !== 'm').length,
    advice: freeAlarms ? `${freeAlarms} flag${freeAlarms === 1 ? '' : 's'} on the clean twins: those are false alarms of Assay's own checks.` : 'Keep. Free.'
  }];
  const out = routedOut(run.repo);
  const lensRecord: Record<string, LensRecord> = {};
  for (const lens of LENSES) {
    const did = ran(lens);
    const mine = bugs.filter(x => x.bug.lens === lens);
    const cells = bugs.map(x => x.cells[lens]);
    const caught = cells.filter(x => x === 'C').length;
    const flagged = cells.filter(x => x === 'h').length;
    const missed = cells.filter(x => x === 'm').length;
    const hits = mine.filter(x => x.cells[lens] === 'C' || x.cells[lens] === 'h').length;
    const alarms = b.findings.filter(f => lensesOf(f).has(lens)).length;
    const tok = [a, b].map(c => panelOf(c, lens)).filter((r): r is PanelReviewer => !!r && r.run && r.state === 'reported');
    const tokens = tok.length ? tok.reduce((n, r) => n + (r.reportedTokens ?? r.tokens), 0) : null;
    const kind = tok.length ? (tok.every(r => r.reportedTokens) ? 'reported' : 'estimate') : null;
    const total = caught + flagged;
    let advice: string;
    if (!did) advice = panelOf(a, lens)?.run ? 'Not reported yet.' : 'Not part of this run: the panel left it out.';
    else if (!mine.length) advice = 'No bug was planted in this lens for this project.';
    else if (out.has(lens)) advice = 'Left out of plans: it caught none in the last 2 runs. assay reviewers --include brings it back.';
    else if (hits === 0) advice = `Caught none of ${mine.length}. If it catches none in the next run too, plans leave it out.`;
    else if (alarms >= 3 && alarms > hits * 2) advice = `${alarms} false alarms for ${hits} catches. Cross-examination keeps them as hints.`;
    else if (hits / mine.length >= 0.5) advice = 'Keep.';
    else advice = `Keep, and watch it: ${hits} of ${mine.length} in its lens.`;
    rows.push({ id: lens, name: NAMES[lens], ran: did, caught, flagged, missed, alarms, tokens, tokensKind: kind, perCatch: tokens !== null && total ? Math.round(tokens / total) : null, chances: mine.length, hits, advice });
    lensRecord[lens] = { ran: did, chances: mine.length, hits, alarms };
  }
  const planned = LENSES.filter(l => panelOf(a, l)?.run);
  const complete = planned.length > 0 && planned.every(l => panelOf(a, l)?.state === 'reported' && (!panelOf(b, l)?.run || panelOf(b, l)?.state === 'reported'));
  if (complete && o.persist !== false) keepResult(run.repo, { run: run.id, at: new Date().toISOString(), lenses: lensRecord });
  return {
    run: run.id, createdAt: run.createdAt, complete, planted: bugs.length, freeProven: rows[0].caught, freeSeen: rows[0].hits,
    seen: bugs.filter(x => x.free !== 'm' || LENSES.some(l => x.cells[l] === 'C' || x.cells[l] === 'h')).length,
    reviewersRan: LENSES.filter(ran).length, rows, bugs, skipped: run.skipped, cases: { planted: run.planted.case, control: run.control.case }
  };
}

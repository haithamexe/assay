import { routedOut } from '../calibration/record.js';
import { isOpen } from '../case.js';
import { sha } from '../config.js';
import { questions } from '../memory/entries.js';
import { reviewBudget } from '../proof/settings.js';
import { saveCase } from '../store.js';
import type { Case, Finding, GateResult, Lens, Panel, PanelCross, PanelReviewer } from '../types.js';
import { lensPrompt, REVIEWERS, reviewerFor, type ReviewerDef } from './lenses.js';
import { changedFiles, estimateTokens, factsOf, sliceFor, type Facts } from './slice.js';

/**
 * Who is worth their tokens for this case, before any is spent (D37). Routing is plain facts about what changed; the budget is spent on the
 * reviewers the facts justify, most justified first; a reviewer the change doesn't touch costs nothing and says why it was left out.
 * Nothing here calls a model.
 */
export const ANSWER_ALLOWANCE = 700;
/** Cross-examination: each examiner reads up to five claims. */
const CROSS_PER_EXAMINER = 900;
const CROSS_CAP = 4500;
const PREAMBLE_CHARS = 1500;
const MAX_REQUEST = 2000;

export const crossCost = (examiners: number): number => (examiners >= 2 ? Math.min(CROSS_CAP, CROSS_PER_EXAMINER * examiners) : 0);
export const k = (n: number): string => (n >= 1000 ? `${(Math.round(n / 100) / 10).toString().replace(/\.0$/, '')}k` : String(n));

/** The free checks' open findings that belong to a lens: what the reviewer is told is already known, so it doesn't repeat it. */
export const knownFor = (c: Case, lens: Lens): Finding[] => c.findings.filter(f => f.lens === lens && f.origin !== 'claim' && isOpen(c, f));

interface Route { def: ReviewerDef; relevant: boolean; why: string; skipWhy: string; score: number; skip?: PanelReviewer['skip'] }

function route(c: Case, facts: Facts, request: string | null): Route[] {
  const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  return REVIEWERS.map(def => {
    const known = knownFor(c, def.lens);
    const score = def.base + known.length * 3;
    const r = (relevant: boolean, why: string, skipWhy: string, skip: PanelReviewer['skip'] = 'not-needed'): Route => ({ def, relevant, why, skipWhy, score, skip: relevant ? undefined : skip });
    switch (def.lens) {
      case 'Scope': return r(!!request, 'Traces every changed file back to what was asked for.', 'No request was given, so there is nothing to trace the changes to.', 'no-request');
      case 'Security': return r(known.length > 0 || facts.sensitive.length > 0 || facts.logicAdds >= 40,
        known.length ? `The free checks flagged ${plural(known.length, 'security pattern')}.` : facts.sensitive.length ? `Touches sensitive paths: ${facts.sensitive.slice(0, 2).join(', ')}${facts.sensitive.length > 2 ? '…' : ''}.` : `${facts.logicAdds} lines of new logic.`,
        'No sensitive path changed, nothing was flagged, and there is little new logic.');
      case 'Correctness': return r(facts.logicAdds >= 10 || known.length > 0, `${plural(facts.logicAdds, 'line')} of logic changed${known.length ? `, and the free checks flagged ${known.length}` : ''}.`, 'No logic changed.');
      case 'UI': return r(facts.uiFiles > 0 || known.length > 0, facts.uiFiles ? `${plural(facts.uiFiles, 'page, style or component file')} changed.` : `The free checks flagged ${known.length} on the pages.`, 'No page, style or component changed.');
      case 'Tests': return r(facts.testFiles > 0 || facts.logicAdds >= 10 || known.length > 0, facts.testFiles ? `${plural(facts.testFiles, 'test file')} changed.` : facts.logicAdds >= 10 ? 'Logic changed and no test did.' : `The free checks flagged ${known.length} about tests.`, 'No logic changed, and no test did.');
      case 'Supply chain': return r(facts.supplyFiles > 0 || known.length > 0, facts.supplyFiles ? `${plural(facts.supplyFiles, 'dependency or build file')} changed.` : `The free checks flagged ${known.length} about dependencies.`, 'No dependency or build file changed.');
      default: return r(facts.perfHits > 0 || known.length > 0, facts.perfHits ? `${plural(facts.perfHits, 'added line')} start a loop, a query, a request or a file read.` : `The free checks flagged ${known.length}.`, 'No loop, query, request or file read was added.');
    }
  });
}

const freeText = (c: Case, lens: Lens): string => knownFor(c, lens).map(f => `${f.id} ${f.title} ${f.file}:${f.lines}`).join('\n');

/** What a reviewer's brief will cost to read: the shared rules, its prompt, its slice and what is already known, plus room to answer. */
function estimate(c: Case, def: ReviewerDef, facts: Facts, request: string | null): number {
  const slice = sliceFor(def.lens, facts, new Set(knownFor(c, def.lens).map(f => f.file)));
  const chars = PREAMBLE_CHARS + lensPrompt(def).length + slice.chars + freeText(c, def.lens).length + (def.lens === 'Scope' ? (request ?? '').length : 0);
  return Math.round((estimateTokens(chars) + ANSWER_ALLOWANCE) / 100) * 100;
}

export const panelId = (c: Case, budget: number, request: string | null, include: Lens[] = []): string => `p-${sha([c.id, budget, request ?? '', [...include].sort().join(',')].join('\0'), 8)}`;

/** Works the plan out without keeping it. Reads git (the diffs) and the case. */
export function previewPanel(c: Case, opts: { budget?: number; request?: string | null; include?: Lens[] } = {}): Panel {
  const budget = Math.max(0, Math.min(400_000, Math.round(opts.budget ?? reviewBudget(c.repo))));
  const request = opts.request?.trim() ? opts.request.trim().slice(0, MAX_REQUEST) : null;
  const facts = factsOf(changedFiles(c));
  const routes = route(c, facts, request);
  // A reviewer that caught none of the bugs planted in its lens in its last two calibration runs is left out, unless the person brings it back.
  const out = budget > 0 ? routedOut(c.repo) : new Map<Lens, string>();
  const include = new Set(opts.include ?? []);
  const now = new Date().toISOString();
  const cost = new Map(routes.map(r => [r.def.lens, estimate(c, r.def, facts, request)]));
  const chosen = new Set<Lens>();
  const left = (used: number): number => budget - used;
  const reason = new Map<Lens, { skip?: PanelReviewer['skip']; why: string }>();
  let used = 0;
  if (budget === 0) for (const r of routes) reason.set(r.def.lens, { skip: 'off', why: 'Free only: the reviewers stay off.' });
  else {
    for (const r of routes) {
      if (!r.relevant) reason.set(r.def.lens, { skip: r.skip, why: r.skipWhy });
    }
    for (const r of routes) if (r.relevant && out.has(r.def.lens) && !include.has(r.def.lens)) reason.set(r.def.lens, { skip: 'calibration', why: `Left out: ${out.get(r.def.lens)} Bring it back with: assay reviewers plan --include ${r.def.lens.toLowerCase().replace(' ', '-')}` });
    for (const r of [...routes].filter(x => x.relevant && !(out.has(x.def.lens) && !include.has(x.def.lens))).sort((a, b) => b.score - a.score || a.def.base - b.def.base)) {
      const est = cost.get(r.def.lens) as number;
      const examiners = chosen.size + 1;
      if (used + est + crossCost(examiners) <= budget) { chosen.add(r.def.lens); used += est; reason.set(r.def.lens, { why: r.why }); }
      else reason.set(r.def.lens, { skip: 'budget', why: `Over budget: needs ${k(est)}, ${k(Math.max(0, left(used + crossCost(chosen.size))))} left.` });
    }
  }
  const crossTokens = crossCost(chosen.size);
  const reviewers: PanelReviewer[] = routes.map(r => {
    const why = reason.get(r.def.lens) as { skip?: PanelReviewer['skip']; why: string };
    const run = chosen.has(r.def.lens);
    return { lens: r.def.lens, name: r.def.name, run, why: why.why, ...(why.skip ? { skip: why.skip } : {}), tokens: run ? (cost.get(r.def.lens) as number) : 0, state: 'planned', claims: 0, kept: 0, merged: 0, dropped: 0 };
  });
  const specialists = reviewers.reduce((n, r) => n + r.tokens, 0);
  const saved = routes.filter(r => !r.relevant && budget > 0).reduce((n, r) => n + (cost.get(r.def.lens) as number), 0);
  return {
    id: panelId(c, budget, request, [...include]), createdAt: now, updatedAt: now, budget, request, reviewers,
    cross: { run: crossTokens > 0, tokens: crossTokens, state: 'planned', assigned: {}, briefed: [], reported: [], confirmed: 0, disputes: [] },
    estimate: { total: specialists + crossTokens, specialists, cross: crossTokens, saved }
  };
}

/** Plans the panel and keeps it with the case. Planning again with the same budget and request keeps what has been reported. */
export function planPanel(c: Case, opts: { budget?: number; request?: string | null; include?: Lens[] } = {}): Panel {
  const fresh = previewPanel(c, opts);
  if (c.panel && c.panel.id === fresh.id) return c.panel;
  c.panel = fresh;
  saveCase(c);
  return fresh;
}

const reviewerOf = (p: Panel, name: string): PanelReviewer | undefined => { const d = reviewerFor(name); return d ? p.reviewers.find(r => r.lens === d.lens) : undefined; };

/** A reviewer was handed its brief. */
export function markBriefed(c: Case, name: string, round: 1 | 2): void {
  const p = c.panel;
  const r = p && reviewerOf(p, name);
  if (!p || !r) return;
  const now = new Date().toISOString();
  if (round === 1 && r.state === 'planned') { r.state = 'briefed'; r.briefedAt = now; }
  if (round === 2 && !p.cross.briefed.includes(r.lens)) p.cross.briefed.push(r.lens);
  p.updatedAt = now;
  saveCase(c);
}

/** What came back from a reviewer, counted by what the gate did with it. A reviewer that says it is done is done even with nothing to report. */
export function recordSubmission(c: Case, name: string, result: GateResult, o: { round: 1 | 2; done: boolean; tokens?: number; claims: number; disputes: Array<{ finding: string; reason: string }> }): void {
  const p = c.panel;
  const r = p && reviewerOf(p, name);
  if (!p || !r) return;
  const now = new Date().toISOString();
  if (o.round === 1) {
    r.claims += o.claims; r.kept += result.kept.length; r.merged += result.merged.length; r.dropped += result.dropped.length;
    if (o.done) { r.state = 'reported'; r.reportedAt = now; if (o.tokens) r.reportedTokens = o.tokens; }
  } else {
    p.cross.confirmed += result.merged.length;
    for (const d of o.disputes) if (c.findings.some(f => f.id === d.finding) && !p.cross.disputes.some(x => x.finding === d.finding && x.by === r.lens)) p.cross.disputes.push({ finding: d.finding, by: r.lens, reason: d.reason.slice(0, 400) });
    if (o.done && !p.cross.reported.includes(r.lens)) p.cross.reported.push(r.lens);
    if (Object.keys(p.cross.assigned).every(l => p.cross.reported.includes(l))) p.cross.state = 'done';
  }
  p.updatedAt = now;
  saveCase(c);
}

/** Cross-examination opens when every planned reviewer has reported. Each reviewer-only claim goes to one other reviewer, never its author. */
export function openCross(c: Case): PanelCross | null {
  const p = c.panel;
  if (!p || !p.cross.run) return null;
  if (p.cross.state !== 'planned') return p.cross;
  const ran = p.reviewers.filter(r => r.run);
  if (!ran.length || ran.some(r => r.state !== 'reported')) return p.cross;
  const claimed = c.findings.filter(f => f.origin === 'claim' && f.tier === 'hint' && f.present !== false && !c.resolved[f.id] && f.evidence.filter(e => e.source.startsWith('reviewer:')).length === 1);
  const ring = ran.map(r => r.lens);
  const assigned: Record<string, string[]> = {};
  for (const f of [...claimed].sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id))) {
    const author = reviewerFor(f.evidence.find(e => e.source.startsWith('reviewer:'))!.source.slice('reviewer:'.length))?.lens;
    const at = author ? ring.indexOf(author) : -1;
    for (let step = 1; step <= ring.length; step++) {
      const examiner = ring[(at + step + ring.length) % ring.length];
      if (examiner === author) continue;
      const list = assigned[examiner] ?? [];
      if (list.length >= 5) continue;
      list.push(f.id);
      assigned[examiner] = list;
      break;
    }
  }
  p.cross.assigned = assigned;
  p.cross.state = Object.keys(assigned).length ? 'open' : 'done';
  p.updatedAt = new Date().toISOString();
  saveCase(c);
  return p.cross;
}

export interface PanelStatus {
  planned: boolean;
  running: number;
  reported: number;
  /** waiting: nothing yet; reviewing: some have; cross: cross-examination is open; done. */
  phase: 'off' | 'waiting' | 'reviewing' | 'cross' | 'done';
  next: string;
}

export function statusOf(p: Panel | undefined | null): PanelStatus {
  if (!p) return { planned: false, running: 0, reported: 0, phase: 'off', next: 'Plan the reviewers first: reviewers_plan.' };
  const ran = p.reviewers.filter(r => r.run);
  const reported = ran.filter(r => r.state === 'reported').length;
  if (!ran.length) return { planned: true, running: 0, reported: 0, phase: 'off', next: p.budget === 0 ? 'The budget is free-only, so no reviewer runs.' : 'No reviewer is worth its tokens for this change.' };
  if (reported < ran.length) return { planned: true, running: ran.length, reported, phase: reported ? 'reviewing' : 'waiting', next: `${ran.length - reported} reviewer${ran.length - reported === 1 ? '' : 's'} still to report: ${ran.filter(r => r.state !== 'reported').map(r => r.lens).join(', ')}.` };
  if (p.cross.run && p.cross.state !== 'done') return { planned: true, running: ran.length, reported, phase: 'cross', next: p.cross.state === 'planned' ? 'Every reviewer has reported. Cross-examination can open: reviewers_plan opens it.' : `Cross-examination is open: ${Object.keys(p.cross.assigned).filter(l => !p.cross.reported.includes(l)).join(', ')} still to examine.` };
  return { planned: true, running: ran.length, reported, phase: 'done', next: 'The panel is done. Read the verdict again with case_open, and fix what it says.' };
}

/** The questions from the project's memory that are for a lens, for its brief. */
export const questionsFor = (c: Case, lens: Lens): string[] => {
  try { return questions(c.repo, c.languages, lens).slice(0, 6).map(q => q.question as string); } catch { return []; }
};

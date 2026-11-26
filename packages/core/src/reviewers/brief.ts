import { isOpen } from '../case.js';
import { redactSecrets } from '../checks/secrets.js';
import type { Case, Finding } from '../types.js';
import { ATTACKER, isAttack, isPlain, lensPrompt, PLAIN, reviewerFor, type ReviewerDef } from './lenses.js';
import { knownAll, knownFor, markBriefed, openCross, questionsFor } from './plan.js';
import { attackSlice, changedFiles, factsOf, plainSlice, sliceFor } from './slice.js';

/**
 * What one reviewer is handed (D38). It is everything the reviewer needs and nothing it shouldn't have: its own lens, its own slice of the
 * change, what the free checks already found for it, and how to report. It is never shown another reviewer's work: that happens only in
 * cross-examination, after every reviewer has reported, and then anonymously.
 */
const RULES = (name: string, lens: string): string => `Several reviewers look at this change, each through one lens, and none can see the others' work. Review only through yours (${lens}).
- Every claim must cite a file and a line that appears in the change below: the number printed next to a + or an unchanged line, or next to a − line for something removed. A claim that doesn't is dropped by an evidence gate.
- Say what you observed (a fact you can see in those lines) separately from what it may lead to. What you infer never blocks a merge. Only proof does, and only Assay produces proof, so you can't claim it: a "this test fails" is kept as your reading.
- No style opinions. Silence is a good answer: if you find nothing for your lens, report no claims.
- Keep each claim to a sentence or two, at most 20 claims.`;

export interface BriefResult { text: string; pages: number; page: number; round: 1 | 2 }

function round1(c: Case, name: string, lens: ReviewerDef, page: number): BriefResult {
  const facts = factsOf(changedFiles(c));
  const known = knownFor(c, lens.lens);
  const slice = sliceFor(lens.lens, facts, new Set(known.map(f => f.file)));
  const p = Math.min(Math.max(1, page), slice.pages.length);
  const parts = [
    `REVIEWER BRIEF · ${lens.name} · case ${c.id}`,
    '',
    `You are the ${lens.name} reviewer for ${c.name} (${c.commits.length} commit${c.commits.length === 1 ? '' : 's'}, ${c.base ? c.base.slice(0, 7) : 'the start'}..${c.head.slice(0, 7)}).`,
    RULES(lens.name, lens.lens),
    '',
    'YOUR LENS',
    lensPrompt(lens)
  ];
  if (lens.lens === 'Scope') parts.push('', 'THE REQUEST', redactSecrets(c.panel?.request ?? '(no request was recorded)'));
  parts.push('', `THE CHANGE (page ${p} of ${slice.pages.length}; ${slice.shown} file${slice.shown === 1 ? '' : 's'} for your lens)`, slice.pages[p - 1]);
  if (p === slice.pages.length && slice.omitted.length) parts.push('', `Not shown, to keep this short: ${slice.omitted.slice(0, 12).join(', ')}${slice.omitted.length > 12 ? '…' : ''}.`);
  if (p < slice.pages.length) parts.push('', `More of the change: call reviewer_brief again with page ${p + 1}. Report once you have read all ${slice.pages.length} pages.`);
  if (p === 1) {
    if (known.length) parts.push('', 'ALREADY FOUND BY THE FREE CHECKS (do not repeat; add to one only if you can say what it missed)', ...known.slice(0, 12).map(f => `- ${f.title} · ${f.file}:${f.lines}`));
    const qs = questionsFor(c, lens.lens);
    if (qs.length) parts.push('', 'QUESTIONS THIS PROJECT ASKS OF EVERY CHANGE IN YOUR LENS (answer them by reading the change; report only what is wrong)', ...qs.map(q => `- ${q}`));
  }
  parts.push('', 'HOW TO ANSWER', `Call finding_submit with case "${c.id}", reviewer "${lens.lens}", your claims (title, lens "${lens.lens}", file, line, what, and severity if you can say) and done: true. With nothing to report, call it with no claims and done: true. You may say how many tokens you used with tokens.`);
  return { text: parts.join('\n'), pages: slice.pages.length, page: p, round: 1 };
}

const snippetOf = (f: Finding): string => f.snippet.rows.map(r => `${r.t === ' ' ? ' ' : r.t === '+' ? '+' : '−'}${String(r.t === '-' ? r.o : r.n).padStart(5)}  ${r.text.slice(0, 200)}`).join('\n');

function round2(c: Case, lens: ReviewerDef): BriefResult {
  const cross = openCross(c);
  if (!cross || cross.state === 'planned') throw new Error('Cross-examination opens when every reviewer has reported. Ask reviewers_plan where the panel is.');
  const ids = cross.assigned[lens.lens] ?? [];
  const mine = ids.map(id => c.findings.find(f => f.id === id)).filter((f): f is Finding => !!f && isOpen(c, f));
  const parts = [
    `CROSS-EXAMINATION · ${lens.name} · case ${c.id}`,
    '',
    `Other reviewers made the claims below about ${c.name}. You are not told who: judge the claim, not the author. For each one, either:`,
    '- confirm it: look at the lines yourself and, if it is right, submit a claim of your own at the same file and line, with the evidence you found. Two reviewers who each saw it independently make it corroborated. If you only agree because you were told, don\'t confirm it;',
    '- dispute it: say why it is wrong, with disputes: [{ finding, reason }];',
    '- or say nothing about it.',
    ''
  ];
  if (!mine.length) parts.push('Nothing was assigned to you.');
  mine.forEach((f, i) => parts.push(`${i + 1}. ${f.id} · ${f.title} · ${f.file}:${f.lines}`, `   the reviewer's reading: ${(f.inferred[0] ?? f.title).slice(0, 500)}`, snippetOf(f).split('\n').map(l => `   ${l}`).join('\n'), ''));
  parts.push('HOW TO ANSWER', `Call finding_submit with case "${c.id}", reviewer "${lens.lens}", round 2, your confirmations as claims, your disputes, and done: true.`);
  return { text: parts.join('\n'), pages: 1, page: 1, round: 2 };
}

const ATTACK_RULES = `You are the attacker. Other reviewers look at this change through one lens each, and none of them can see your work or you theirs. You have no lens: you try to break the change.
- Every claim must cite a file and a line that appears in the change below: the number printed next to a + or an unchanged line, or next to a − line for something removed. A claim that doesn't is dropped by an evidence gate.
- A claim is one break: the concrete input or sequence, what the changed code does with it, and what should have happened. Say what you observed (what those lines do) separately from what you infer. What you infer never blocks a merge. Only proof does, and only Assay produces proof, so you can't claim it: a "this fails" is kept as your reading.
- No style opinions. Silence is a good answer: if you can't break it, report no claims.
- At most 12 claims, the ones you would bet on first.`;

/** The attack pass's brief (D50): every changed file that runs, the tests that changed by name, and what the free checks found. Never another reviewer's claims. */
function attackRound(c: Case, page: number): BriefResult {
  const facts = factsOf(changedFiles(c));
  const known = knownAll(c);
  const slice = attackSlice(facts, new Set(known.map(f => f.file)));
  const p = Math.min(Math.max(1, page), slice.pages.length);
  const tests = [...new Set(facts.files.filter(f => f.test).map(f => f.path))];
  const parts = [
    `REVIEWER BRIEF · Attack · case ${c.id}`,
    '',
    `You are the attacker for ${c.name} (${c.commits.length} commit${c.commits.length === 1 ? '' : 's'}, ${c.base ? c.base.slice(0, 7) : 'the start'}..${c.head.slice(0, 7)}).`,
    ATTACK_RULES,
    '',
    'YOUR JOB',
    lensPrompt(ATTACKER),
    '',
    `THE CHANGE (page ${p} of ${slice.pages.length}; ${slice.shown} file${slice.shown === 1 ? '' : 's'} that run or are shown)`,
    slice.pages[p - 1]
  ];
  if (p === slice.pages.length && slice.omitted.length) parts.push('', `Not shown, to keep this short: ${slice.omitted.slice(0, 12).join(', ')}${slice.omitted.length > 12 ? '…' : ''}.`);
  if (p < slice.pages.length) parts.push('', `More of the change: call reviewer_brief again with page ${p + 1}. Report once you have read all ${slice.pages.length} pages.`);
  if (p === 1) {
    parts.push('', tests.length ? `TESTS THAT CHANGED (names only; what they cover is for you to work out): ${tests.slice(0, 12).join(', ')}${tests.length > 12 ? '…' : ''}` : 'NO TEST FILE CHANGED in this change.');
    if (known.length) parts.push('', 'ALREADY FOUND BY THE FREE CHECKS (do not repeat; add to one only if you can say what it missed)', ...known.slice(0, 12).map(f => `- ${f.title} · ${f.file}:${f.lines}`));
  }
  parts.push('', 'HOW TO ANSWER', `Call finding_submit with case "${c.id}", reviewer "Attack", your claims (title, lens: the area the break is in, one of Correctness, Security, UI, Performance, Tests or Supply chain; file; line; what: "Input: … The code: … Should: …"; and severity if you can say) and done: true. With nothing to report, call it with no claims and done: true. You may say how many tokens you used with tokens.`);
  return { text: parts.join('\n'), pages: slice.pages.length, page: p, round: 1 };
}

/** The plain review's brief (D51): the whole change and a generic prompt. No lens, no free findings, no questions: it is what a single plain review would have seen. */
function plainRound(c: Case, page: number): BriefResult {
  const slice = plainSlice(factsOf(changedFiles(c)));
  const p = Math.min(Math.max(1, page), slice.pages.length);
  const parts = [
    `REVIEWER BRIEF · Plain review · case ${c.id}`,
    '',
    `You are the only reviewer of this change to ${c.name} (${c.commits.length} commit${c.commits.length === 1 ? '' : 's'}, ${c.base ? c.base.slice(0, 7) : 'the start'}..${c.head.slice(0, 7)}).`,
    `- Every claim must cite a file and a line that appears in the change below: the number printed next to a + or an unchanged line, or next to a − line for something removed. A claim that doesn't is dropped.
- Keep each claim to a sentence or two, at most 20 claims. If you find nothing worth saying, report no claims.`,
    '',
    'YOUR JOB',
    lensPrompt(PLAIN),
    '',
    `THE CHANGE (page ${p} of ${slice.pages.length}; ${slice.shown} file${slice.shown === 1 ? '' : 's'})`,
    slice.pages[p - 1]
  ];
  if (p === slice.pages.length && slice.omitted.length) parts.push('', `Not shown, to keep this short: ${slice.omitted.slice(0, 12).join(', ')}${slice.omitted.length > 12 ? '…' : ''}.`);
  if (p < slice.pages.length) parts.push('', `More of the change: call reviewer_brief again with page ${p + 1}. Report once you have read all ${slice.pages.length} pages.`);
  parts.push('', 'HOW TO ANSWER', `Call finding_submit with case "${c.id}", reviewer "Plain", your claims (title, lens: one of Correctness, Security, UI, Performance, Tests or Supply chain; file; line; what; and severity if you can say) and done: true. With nothing to report, call it with no claims and done: true. You may say how many tokens you used with tokens.`);
  return { text: parts.join('\n'), pages: slice.pages.length, page: p, round: 1 };
}

/** The brief for one reviewer. Round 2 is refused until every reviewer has reported. Fetching page 1 marks the reviewer as briefed. */
export function reviewerBrief(c: Case, name: string, o: { round?: 1 | 2; page?: number } = {}): BriefResult {
  if (isPlain(name)) {
    if (o.round === 2) throw new Error('The plain review has one round.');
    if (!c.panel) throw new Error('No panel is planned for this case. Call reviewers_plan first.');
    if (!c.panel.baseline?.run) throw new Error('The plain review is only part of a calibration run (assay calibrate), where it is the baseline the panel is measured against. It is not part of this panel.');
    const out = plainRound(c, o.page ?? 1);
    if (out.page === 1) markBriefed(c, 'plain', 1);
    return out;
  }
  if (isAttack(name)) {
    if (o.round === 2) throw new Error('The attack pass has one round. What it claims is cross-examined with the other reviewers’ claims.');
    if (!c.panel) throw new Error('No panel is planned for this case. Call reviewers_plan first: it also shows what the panel will cost.');
    const a = c.panel.attack;
    if (!a?.run) throw new Error(`The attack pass is not part of this panel: ${a?.why ?? 'it was not planned (it is for bigger budgets)'}`);
    const out = attackRound(c, o.page ?? 1);
    if (out.page === 1) markBriefed(c, 'attack', 1);
    return out;
  }
  const lens = reviewerFor(name);
  if (!lens) throw new Error(`There is no reviewer called "${name}". They are: Triage (Scope), Security, Correctness, UI, Tests, Supply chain, Performance, and Attack (the attack pass, when the plan includes it); in a calibration run also Plain (the baseline).`);
  const round = o.round === 2 ? 2 : 1;
  if (!c.panel) throw new Error('No panel is planned for this case. Call reviewers_plan first: it also shows what the panel will cost.');
  const mine = c.panel.reviewers.find(r => r.lens === lens.lens);
  if (round === 1 && !mine?.run) throw new Error(`${lens.name} is not part of this panel: ${mine?.why ?? 'it was not planned'}`);
  const out = round === 1 ? round1(c, lens.name, lens, o.page ?? 1) : round2(c, lens);
  if (out.page === 1) markBriefed(c, lens.name, round);
  return out;
}

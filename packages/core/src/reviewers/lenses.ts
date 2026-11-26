import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assayPath } from '../config.js';
import type { Lens } from '../types.js';

/**
 * The reviewers (D36). A reviewer is one lens, played by an agent the person already has: Assay never calls a model. Its prompt is a plain
 * Markdown file, so it can be read and changed: one of yours in ~/.assay/lenses with the same file name replaces the one that ships.
 */
export interface ReviewerDef {
  lens: Lens;
  /** What the screen calls it. */
  name: string;
  /** The prompt file, without .md. */
  file: string;
  /** How much it counts when the budget can't pay for everyone. */
  base: number;
}

export const REVIEWERS: ReviewerDef[] = [
  { lens: 'Scope', name: 'Triage', file: 'scope', base: 10 },
  { lens: 'Security', name: 'Security', file: 'security', base: 6 },
  { lens: 'Correctness', name: 'Correctness', file: 'correctness', base: 5 },
  { lens: 'UI', name: 'UI & accessibility', file: 'ui', base: 4 },
  { lens: 'Tests', name: 'Tests', file: 'tests', base: 3 },
  { lens: 'Supply chain', name: 'Supply chain', file: 'supply-chain', base: 2 },
  { lens: 'Performance', name: 'Performance', file: 'performance', base: 1 }
];

/**
 * The attack pass (D50) is not a lens: its findings belong to whichever lens the break is in. It has a prompt file like a lens does
 * (yours in ~/.assay/lenses/attack.md replaces the one that ships), and it is reached by the name "attack".
 */
export const ATTACKER: ReviewerDef = { lens: 'Correctness', name: 'Attack', file: 'attack', base: 0 };
export const isAttack = (name: string): boolean => /^attack(er| pass)?$/i.test(name.trim().replace(/[-_]+/g, ' '));

/**
 * The plain review (D51) is the stick the panel is measured against: one reviewer with no lens, no free findings and no questions, handed the whole
 * change and told to review it, as one capable engineer (or one plain AI review) would. It is only planned in calibration runs, never in a real review.
 */
export const PLAIN: ReviewerDef = { lens: 'Correctness', name: 'Plain review', file: 'plain', base: 0 };
export const isPlain = (name: string): boolean => /^plain( review)?$/i.test(name.trim().replace(/[-_]+/g, ' '));

export const bundledLensesDir =(): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'lenses');
export const lensesDir = (): string => assayPath('lenses');

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

/** A reviewer by its lens or its name, however it is spelled ("ui", "Supply chain", "supply-chain", "UI & accessibility"). */
export function reviewerFor(name: string): ReviewerDef | undefined {
  const n = norm(name);
  return REVIEWERS.find(r => norm(r.lens) === n || norm(r.name) === n || norm(r.file) === n || (n === 'triage' && r.lens === 'Scope'));
}

const MAX_PROMPT = 4000;

/** The prompt of a reviewer: yours if there is one with the same file name, else the one that ships. Capped, so a big file can't flood a brief. */
export function lensPrompt(def: ReviewerDef): string {
  for (const dir of [lensesDir(), bundledLensesDir()]) {
    try {
      const t = fs.readFileSync(path.join(dir, `${def.file}.md`), 'utf8').trim();
      if (t) return t.length > MAX_PROMPT ? `${t.slice(0, MAX_PROMPT)}\n…` : t;
    } catch { /* try the next one */ }
  }
  if (def === PLAIN) return 'Review this change as one capable engineer would. Report what you think is wrong, and tie each claim to a changed line.';
  if (def === ATTACKER) return'Try to break this change: say the concrete input or sequence, what the changed code does with it (cite the line) and what should have happened. Report only what you can tie to a changed line.';
  return `You look only at ${def.lens.toLowerCase()}. Report what you can tie to a changed line.`;
}

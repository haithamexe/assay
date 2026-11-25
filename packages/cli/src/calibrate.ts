import { calibration, repoRoot } from '@assay/core';
import type { calibration as Cal } from '@assay/core';
import { bold, dim, green, red, yellow } from './format.js';

type Flags = Record<string, string | true>;
type Board = Cal.Scoreboard;
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k`.replace(/\.0k$/, 'k') : String(n));

export const CALIBRATE_HELP = `${bold('assay calibrate')}  does each reviewer earn its tokens? plant known bugs and find out

  assay calibrate                   what would be planted in this project, or the last run's scoreboard
  assay calibrate start             make the throwaway repository, score the free checks at once, and print what to give your agent
  assay calibrate score [run]       the scoreboard of a run (it moves as your agent's reviewers report)
  assay calibrate clean [--all]     remove old throwaway repositories (what each showed is kept)

  --budget <tokens>   what the reviewers may cost on the two cases (default 200k)

Known bugs go into a throwaway repository shaped like yours (your languages, your folders), each with a clean twin written correctly. The free checks are
scored on the spot. Your own agent runs the reviewers on both cases; each reviewer is scored on what it caught and on what it flagged in clean code.
A reviewer that caught none of the bugs planted in its lens in its last two runs is left out of plans. Assay never calls a model.
`;

const cell = (c: string | undefined): string => (c === 'C' ? green('✓') : c === 'h' ? yellow('~') : c === 'm' ? red('✗') : c === 'n' ? dim('?') : dim('·'));

export function boardText(b: Board): string {
  const l: string[] = [];
  l.push(`${bold('Calibration')} ${dim(b.run)}  ${b.planted} bugs planted${b.skipped.length ? dim(` (${b.skipped.length} kinds didn't fit this project)`) : ''}`, '');
  l.push(`Free checks alone: ${bold(String(b.freeProven))} caught with proof, ${b.freeSeen - b.freeProven} more flagged, ${b.planted - b.freeSeen} missed, at 0 tokens. ${b.rows[0].alarms ? red(`${b.rows[0].alarms} false alarm${b.rows[0].alarms === 1 ? '' : 's'} on the clean twins.`) : green('No false alarms on the clean twins.')}`);
  l.push(b.reviewersRan ? `With the reviewers: ${bold(String(b.seen))} of ${b.planted} flagged by someone.${b.complete ? '' : dim('  (not every reviewer has reported yet)')}` : dim('The reviewers have not been run yet: give your agent the prompt from assay calibrate start.'));
  l.push('', `${pad('', 22)} ${padL('Caught', 6)} ${padL('Flagged', 7)} ${padL('Missed', 6)} ${padL('Alarms', 6)} ${padL('Tok/catch', 9)}  What it suggests`);
  for (const r of b.rows) {
    const per = r.id === 'free' ? '0' : r.perCatch !== null ? `${k(r.perCatch)}${r.tokensKind === 'estimate' ? '~' : ''}` : r.ran ? '—' : '';
    l.push(`${pad(r.name, 22)} ${padL(r.ran ? String(r.caught) : '', 6)} ${padL(r.ran ? String(r.flagged) : '', 7)} ${padL(r.ran ? String(r.missed) : '', 6)} ${padL(r.ran ? String(r.alarms) : '', 6)} ${padL(per, 9)}  ${dim(r.advice)}`);
  }
  l.push('', `${pad('Planted bug', 44)} Free  Sec  Cor  UI   Test Sup  Perf`);
  const col = (x: Cal.BugResult, lens: string): string => cell(x.cells[lens as keyof typeof x.cells]);
  for (const x of b.bugs) l.push(`${pad(`${x.bug.name}`, 44)} ${cell(x.free)}     ${['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Performance'].map(le => `${col(x, le)}    `).join('').trimEnd()}`);
  l.push('', dim(`${green('✓')} caught with proof   ${yellow('~')} flagged, no proof   ${red('✗')} missed   · not its lens   ? not run`));
  return l.join('\n');
}

export const promptText = calibration.handoffPrompt;

export async function runCalibrate(args: string[], flags: Flags, repoArg: string, json: boolean): Promise<string> {
  const [sub] = args;
  if (sub === 'help') return CALIBRATE_HELP;
  const repo = repoRoot(repoArg);
  const budget = typeof flags.budget === 'string' ? Number(flags.budget.replace(/k$/i, '000')) : undefined;
  if (sub === 'clean') {
    const n = calibration.cleanRuns(repo, flags.all === true);
    return `Removed ${n} throwaway ${n === 1 ? 'repository' : 'repositories'}. What the runs showed is kept.`;
  }
  if (sub === 'start') {
    const run = calibration.startCalibration(repo, { budget });
    const board = calibration.scoreRun(run);
    if (json) return JSON.stringify({ run, board, prompt: promptText(run.planted.case, run.control.case) }, null, 2);
    return `${boardText(board)}\n\n${bold('Now the reviewers.')} Give your agent this (the dashboard's Scoreboard has it too):\n\n${promptText(run.planted.case, run.control.case)}\n\n${dim(`Then: assay calibrate score ${run.id}   The throwaway repository is under ${run.dir}`)}`;
  }
  if (sub === 'score') {
    const run = args[1] ? calibration.loadRun(args[1]) : calibration.latestRun(repo);
    if (!run) throw new Error(args[1] ? `There is no calibration run ${args[1]}.` : 'There is no calibration run yet. assay calibrate start makes one.');
    const board = calibration.scoreRun(run);
    return json ? JSON.stringify(board, null, 2) : boardText(board);
  }
  if (sub !== undefined) throw new Error(`Unknown calibrate command "${sub}". Try: assay calibrate help`);
  const latest = calibration.latestRun(repo);
  if (latest) { const board = calibration.scoreRun(latest); return json ? JSON.stringify(board, null, 2) : `${boardText(board)}\n\n${dim('assay calibrate start makes a new run.')}`; }
  const p = calibration.previewCalibration(repo);
  if (json) return JSON.stringify(p, null, 2);
  return [`${bold('Calibration')} would plant ${p.fit.length} bugs in a throwaway repository shaped like this project:`, '',
    ...p.fit.map(f => `  ${pad(f.lens, 13)} ${f.name}`),
    ...(p.skipped.length ? ['', dim(`Left out (${p.skipped.length}): ${[...new Set(p.skipped.map(s => s.why))].join(' ')}`)] : []), '',
    'Each bug has a clean twin, so false alarms are counted too. Nothing in your project is touched, and nothing is spent until your agent runs the reviewers.', '', dim('assay calibrate start')].join('\n');
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCase, reviewBudget, reviewers, setRepoSettings } from '@assay/core';
import { bold, dim, green, yellow } from './format.js';

type Flags = Record<string, string | true>;
const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

export const REVIEWERS_HELP = `${bold('assay reviewers')}  who is worth their tokens, before any is spent

  assay reviewers [range]              the plan: which reviewers, why, and what each costs (nothing is kept)
  assay reviewers plan [range]         the same, kept with the case so an agent can run it
  assay reviewers brief <lens> [range] what one reviewer is handed (paste it into any agent). --round 2, --page <n>
  assay reviewers status [range]       who has reported, and what is next
  assay reviewers budget <40k|free>    the budget for this project from now on

  --budget 40k|free|<tokens>   what the reviewers may cost in all (default: the project's setting, 40k)
  --request "what was asked"   lets the Triage reviewer trace each change back to it
  --include <lens,…>           bring back a reviewer that calibration left out of the plan
  lenses   triage, security, correctness, ui, tests, supply-chain, performance

  assay hook stop              a Stop hook: blocks "done" while Assay's own verdict is Blocked   (--always, --require-panel, --max-blocks <n>)
  assay hook install           the lines to add to your agent's settings, and what they do

Assay never calls a model. The reviewers are your own agent's sub-agents; Assay plans them, hands each one its slice, and counts what comes back.
`;

/** 40k, 40000, free, 0. */
export function parseBudget(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'free' || s === 'off' || s === 'none') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*k?$/.exec(s);
  if (!m) throw new Error('--budget is a number of tokens (40000 or 40k), or free.');
  return Math.round(Number(m[1]) * (s.endsWith('k') ? 1000 : 1));
}

export function runReviewers(args: string[], flags: Flags, repoArg: string, json: boolean, last?: number): string {
  const sub = ['plan', 'brief', 'status', 'budget', 'help'].includes(args[0] ?? '') ? args[0] : undefined;
  if (sub === 'help') return REVIEWERS_HELP;
  if (sub === 'budget') {
    const n = parseBudget(args[1]);
    if (n === undefined) return `The budget for this project is ${reviewBudget(repoArg) === 0 ? 'free only' : `${reviewBudget(repoArg)} tokens`}. Change it with: assay reviewers budget 40k  (or free)`;
    setRepoSettings(repoArg, { budget: n });
    return n === 0 ? 'Reviewers are off for this project: free checks only.' : `The budget for this project is now ${n} tokens.`;
  }
  const rest = sub ? args.slice(1) : args;
  const lens = sub === 'brief' ? rest.shift() : undefined;
  if (sub === 'brief' && !lens) throw new Error('Which reviewer? assay reviewers brief <lens>');
  const c = openCase({ repo: repoArg, range: rest[0], last });
  const budget = parseBudget(str(flags, 'budget'));
  const request = str(flags, 'request');
  const include = str(flags, 'include')?.split(',').map(x => reviewers.reviewerFor(x.trim())?.lens).filter((x): x is NonNullable<typeof x> => !!x);

  if (sub === 'brief') {
    if (!c.panel) reviewers.planPanel(c, { budget, request, include });
    const round = str(flags, 'round') === '2' ? 2 : 1;
    const b = reviewers.reviewerBrief(c, lens as string, { round, page: Number(str(flags, 'page')) || 1 });
    return json ? JSON.stringify(b, null, 2) : b.text;
  }
  if (sub === 'status') {
    if (!c.panel) return json ? JSON.stringify({ planned: false }) : dim('No panel is planned for this case. assay reviewers plan keeps one.');
    return json ? JSON.stringify({ panel: c.panel, status: reviewers.statusOf(c.panel) }, null, 2) : reviewers.panelText(c, c.panel);
  }
  if (sub === 'plan') {
    const p = reviewers.planPanel(c, { budget, request, include });
    return json ? JSON.stringify(p, null, 2) : `${reviewers.panelText(c, c.panel ?? p)}\n\n${green('Kept with the case.')} ${dim(`An agent can run it: ask it to call reviewers_plan for case ${c.id}. Or hand a reviewer its brief yourself: assay reviewers brief <lens>`)}`;
  }
  const p = c.panel && budget === undefined && request === undefined ? c.panel : reviewers.previewPanel(c, { budget, request, include });
  const text = reviewers.panelText(c, p, { open: false });
  return json ? JSON.stringify(p, null, 2) : `${text}\n\n${dim(`Nothing is kept: this only shows the cost. assay reviewers plan keeps it (${p.budget ? `budget ${reviewBudget(c.repo)} tokens by default` : 'free only'}).`)}`;
}

/** `assay hook stop` reads the agent's JSON from standard input and answers with JSON on standard output. */
export function runHook(args: string[], flags: Flags, json: boolean): string {
  const sub = args[0];
  if (sub === 'install') {
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
    const snippet = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(cli)} hook stop` }] }] } };
    return [
      `${bold('A Stop hook for your agent')}`, '',
      'Add this to your Claude Code settings (.claude/settings.json in the project, or ~/.claude/settings.json for every project):', '',
      JSON.stringify(snippet, null, 2), '',
      `When the agent is about to say it is done, Assay works out the verdict itself. If it is ${yellow('Blocked')} (a proven problem on this branch), the agent is told what to fix and carries on. Otherwise it stops as usual.`,
      dim('It only looks at a branch that has left the default branch, only blocks what Assay can show is wrong, and lets go after 2 tries in a row so it can never trap a session.'),
      dim('Options: --always (review the last commits even on the default branch), --require-panel (also wait for a planned reviewer panel), --max-blocks <n>. Put them after "hook stop" in the command.'),
      dim('Assay does not edit your settings. This is yours to add.')
    ].join('\n');
  }
  if (sub !== 'stop') throw new Error('assay hook stop | assay hook install');
  let input: { cwd?: string; session_id?: string; stop_hook_active?: boolean } = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') as typeof input; } catch { /* no input is fine: it uses the folder it was started in */ }
  const d = reviewers.stopDecision(input, { always: flags.always === true, requirePanel: flags['require-panel'] === true, maxBlocks: Number(str(flags, 'max-blocks')) || undefined });
  if (d.block) return JSON.stringify({ decision: 'block', reason: d.reason });
  return json || flags.verbose === true ? JSON.stringify({ decision: 'allow', note: d.note }) : '';
}

import fs from 'node:fs';
import { briefOf } from '../brief.js';
import { openCase, verdictOf } from '../case.js';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import { defaultBase, git, repoRoot, resolveRev } from '../git.js';
import { statusOf } from './plan.js';

/**
 * The Stop hook (D40): an agent that is about to say it is done is stopped if Assay's own verdict, worked out here and not taken from the
 * agent, is Blocked, or if the panel the person asked for is unfinished. It only ever blocks something Assay can show is wrong, and it lets go
 * after a few tries so it can never trap a session.
 */
export interface HookInput { cwd?: string; session_id?: string; stop_hook_active?: boolean }
export interface HookOptions {
  /** Also review the last five commits when the branch has not left the default branch. Without it, only a branch that has left it is reviewed. */
  always?: boolean;
  /** Block until a planned panel has finished. */
  requirePanel?: boolean;
  /** How many times in a row it may block the same state before it lets the session stop. */
  maxBlocks?: number;
}
export interface HookDecision { block: boolean; reason?: string; note?: string }

const stateFile = (session: string): string => assayPath('hooks', `${sha(session, 12)}.json`);
function readState(session: string): { head: string; blocks: number } {
  try { return JSON.parse(fs.readFileSync(stateFile(session), 'utf8')) as { head: string; blocks: number }; } catch { return { head: '', blocks: 0 }; }
}

export function stopDecision(input: HookInput, opts: HookOptions = {}): HookDecision {
  const max = Math.max(1, Math.min(10, opts.maxBlocks ?? 2));
  let repo: string;
  try { repo = repoRoot(input.cwd || process.cwd()); } catch { return { block: false, note: 'Not a git repository: nothing to review.' }; }
  let head: string;
  try { head = resolveRev(repo, 'HEAD'); } catch { return { block: false, note: 'No commits yet: nothing to review.' }; }
  if (!opts.always && !defaultBase(repo, head)) return { block: false, note: 'This branch has not left the default branch, so there is no branch to review. Use --always to review the last commits anyway.' };

  const c = openCase({ repo });
  const v = verdictOf(c);
  const problems: string[] = [];
  if (v.tone === 'blocked') problems.push(`${v.headline}.\n${briefOf(c)}`);
  if (opts.requirePanel && c.panel) {
    const s = statusOf(c.panel);
    if (s.phase === 'waiting' || s.phase === 'reviewing' || s.phase === 'cross') problems.push(`The reviewer panel you were asked to run is not finished. ${s.next}`);
  }
  const session = input.session_id || sha(repo, 12);
  const prev = readState(session);
  if (!problems.length) {
    try { writeFileAtomic(stateFile(session), JSON.stringify({ head, blocks: 0 })); } catch { /* the count is only a safety net */ }
    return { block: false, note: v.headline };
  }
  const blocks = prev.head === head ? prev.blocks + 1 : 1;
  if (blocks > max) {
    try { writeFileAtomic(stateFile(session), JSON.stringify({ head, blocks: 0 })); } catch { /* ignored */ }
    return { block: false, note: `Assay still says: ${v.headline}. It has asked ${max} times and lets go now: tell the person what is left.` };
  }
  try { writeFileAtomic(stateFile(session), JSON.stringify({ head, blocks })); } catch { /* ignored */ }
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true }).trim();
  return {
    block: true,
    reason: `Assay: not done yet.\n\n${problems.join('\n\n')}${dirty ? '\n\nYou also have uncommitted changes. Assay reviews commits, so commit what you want reviewed.' : ''}\n\nFix what it says, commit, and run case_open again before you say the work is done. (Asked ${blocks} of ${max} times.)`
  };
}

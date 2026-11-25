import { analyzeCommit } from './analysis.js';
import { commitInfo } from './git.js';
import { replayLook } from './browser/look.js';
import { replayRun } from './proof/prove.js';
import type { Case } from './types.js';

export interface ReplayResult { reproduced: boolean; evidenceId: string; findingId: string; detail: string }

/**
 * Runs the check again on a clean slate (the cache is ignored) and says whether the same finding comes back with the same kind of evidence.
 * Evidence from a test run, a revert or a mutant is re-run for real (and needs the repository to be allowed).
 * A reviewer's reading can't be replayed: only what Assay computed can.
 */
export async function replayEvidence(c: Case, evidenceId: string): Promise<ReplayResult> {
  const findingId = evidenceId.replace(/\.\d+$/, '');
  const f = c.findings.find(x => x.id === findingId);
  const ev = f?.evidence.find(e => e.id === evidenceId);
  if (!f || !ev) return { reproduced: false, evidenceId, findingId, detail: `No evidence ${evidenceId} in ${c.id}.` };
  if (ev.kind === 'claim') return { reproduced: false, evidenceId, findingId, detail: 'A reviewer’s reading can’t be replayed. Only checks Assay ran can.' };
  if (ev.replay?.run) {
    const r = ev.replay.run.kind === 'look' ? await replayLook(c, ev) : await replayRun(c, ev);
    return { reproduced: r.reproduced, evidenceId, findingId, detail: r.detail };
  }
  const commit = ev.replay?.commit ?? f.commit;
  const [info] = commitInfo(c.repo, [commit]);
  if (!info) return { reproduced: false, evidenceId, findingId, detail: `Commit ${commit.slice(0, 7)} is no longer in the repository.` };
  const fresh = analyzeCommit(c.repo, info, { fresh: true });
  const again = fresh.findings.find(x => x.id === f.id);
  if (!again) return { reproduced: false, evidenceId, findingId, detail: `Analysed ${commit.slice(0, 7)} again: the finding did not come back.` };
  const same = again.evidence.some(e => e.kind === ev.kind && e.source === ev.source);
  return { reproduced: same, evidenceId, findingId, detail: same ? `Analysed ${commit.slice(0, 7)} again from scratch: the same ${ev.kind} (${ev.source}) came back.` : `The finding came back without ${ev.source}.` };
}

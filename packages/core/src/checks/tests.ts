import { isSourcePath, isTestPath } from '../lang.js';
import type { Check, RawFinding } from './types.js';

/** Logic changed and no test did, in this commit. A fact about the diff, one signal; it corroborates risky findings in the same commit. */
export function untestedLogic(ctx: Parameters<Check>[0]): { adds: number; files: number; touchedTest: boolean } {
  const src = ctx.files.filter(f => !f.binary && f.status !== 'deleted' && isSourcePath(f.path) && f.additions > 0);
  return { adds: src.reduce((a, f) => a + f.additions, 0), files: src.length, touchedTest: ctx.files.some(f => isTestPath(f.path)) };
}

export const untested: Check = ctx => {
  const out: RawFinding[] = [];
  const u = untestedLogic(ctx);
  if (u.adds >= 10 && !u.touchedTest && !/^revert\b/i.test(ctx.subject)) {
    const big = ctx.files.filter(f => !f.binary && f.status !== 'deleted' && isSourcePath(f.path)).sort((a, b) => b.additions - a.additions)[0];
    const row = big?.hunks.flatMap(h => h.lines).find(l => l.t === '+' && l.n !== null);
    if (big && row && row.n !== null) {
      out.push({
        check: 'tests', key: 'no-test', title: 'Logic changed and no test changed', lens: 'Tests', severity: 'low', file: big.path, line: row.n, side: 'added', text: row.text,
        evidence: [{ kind: 'diff', source: 'diff:no-test', what: `${u.adds} lines of logic changed in ${u.files} source file${u.files > 1 ? 's' : ''}; no test file changed in this commit.` }],
        observed: [`${u.adds} lines of logic changed in ${u.files} source file${u.files > 1 ? 's' : ''}.`, 'No test file changed in this commit.'],
        inferred: ['Existing tests may cover it. Nothing in this commit shows that they do.']
      });
    }
  }
  for (const f of ctx.files) {
    if (f.status === 'deleted' && isTestPath(f.path) && !f.binary && f.deletions >= 5) {
      out.push({
        check: 'tests', key: `deleted:${f.path}`, title: `A test file was deleted: ${f.path.split('/').pop()}`, lens: 'Tests', severity: 'medium', file: f.path, line: 1, side: 'removed', text: f.path,
        evidence: [{ kind: 'diff', source: 'diff:test-deleted', what: `${f.path} (${f.deletions} lines) was deleted.` }],
        observed: [`${f.path} and its ${f.deletions} lines are gone.`], inferred: ['Whatever it checked is no longer checked, unless the tests moved.']
      });
    }
  }
  return out;
};

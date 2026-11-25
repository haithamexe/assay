import { SENSITIVE } from './lang.js';
import type { Evidence, EvidenceKind, Finding, Severity, Tier } from './types.js';

const BASE: Record<Severity, number> = { high: 55, medium: 38, low: 18 };
const BONUS: Record<Tier, number> = { proven: 30, corroborated: 14, hint: 0 };
const PROOF_WHY: Partial<Record<EvidenceKind, string>> = {
  fact: 'A literal in the diff is wrong by itself',
  'test-fail': 'A test fails',
  probe: 'A probe ran in a real page',
  'behaviour-diff': 'Behaviour changed on a real call',
  measurement: 'Measured in a real render',
  'mutation-survivor': 'Tests didn’t notice a change',
  'revert-test': 'No test fails if this is reverted'
};

/** Risk 0 to 99 and the short reasons for it. Severity first, then how well it is evidenced, then where it is. */
export function riskOf(f: Pick<Finding, 'severity' | 'tier' | 'file'> & { evidence: Pick<Evidence, 'kind' | 'source'>[] }): { risk: number; why: string[] } {
  const why: string[] = [];
  let risk = BASE[f.severity] + BONUS[f.tier];
  const proof = f.evidence.find(e => PROOF_WHY[e.kind]);
  if (proof) why.push(PROOF_WHY[proof.kind]!);
  else if (f.tier === 'corroborated') why.push('Independent signals agree');
  else why.push('One signal only');
  if (SENSITIVE.test(f.file)) { risk += 8; why.push('Sensitive path'); }
  const s = new Set(f.evidence.map(e => e.source));
  if (s.has('diff:no-test')) { risk += 3; why.push('No test changed in this commit'); }
  if (s.has('history:churn')) { risk += 3; why.push('The file changes often'); }
  if ([...s].some(x => x.startsWith('rule:')) && !proof) why.push('Matches a known risky pattern');
  if (s.has('rule:name-distance')) why.push('Name looks like another package');
  return { risk: Math.max(1, Math.min(99, risk)), why };
}

/** A commit with no finding still has a size and a place. Small and ordinary stays low. */
export function commitRisk(findings: Pick<Finding, 'risk'>[], additions: number, touchedSensitive: boolean): number {
  if (findings.length) return Math.max(...findings.map(f => f.risk));
  return Math.min(30, Math.round(2.5 * Math.log2(1 + additions / 5)) + (touchedSensitive ? 6 : 0));
}

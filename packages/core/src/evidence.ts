import type { Evidence, EvidenceKind, ProofKind, Tier } from './types.js';

export const PROOF_KINDS: ReadonlySet<EvidenceKind> = new Set<ProofKind>(['fact', 'test-fail', 'probe', 'behaviour-diff', 'measurement', 'mutation-survivor', 'revert-test']);
export const isProof = (k: EvidenceKind): boolean => PROOF_KINDS.has(k);

/**
 * The only place a tier is decided (D3).
 *  proven        any proof evidence
 *  corroborated  no proof, but two or more signals from different sources
 *  hint          anything else: one signal, or several from one source
 */
export function tierOf(evidence: Pick<Evidence, 'kind' | 'source'>[]): Tier {
  if (evidence.some(e => isProof(e.kind))) return 'proven';
  const sources = new Set(evidence.filter(e => !isProof(e.kind)).map(e => e.source));
  return sources.size >= 2 ? 'corroborated' : 'hint';
}

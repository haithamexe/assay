import { commitDiff, snippetAround } from './diff.js';
import { isProof, tierOf } from './evidence.js';
import { sha } from './config.js';
import { riskOf } from './risk.js';
import type { Case, Claim, DiffRow, Dropped, Evidence, Finding, GateResult, Lens } from './types.js';

const LENSES: Lens[] = ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Scope', 'Performance'];
const claimKey = (c: Claim): string => sha([c.source, c.title, c.file, c.line, c.what].join('\0'), 10);

type Located = { commit: string; side: 'added' | 'removed'; header: string; rows: DiffRow[]; text: string };

/** Where in this case's diff a claim points. null = the file isn't in the range at all; 'outside' = it is, but not on that line. */
function locate(repo: string, c: Case, claim: Claim, diffs: Map<string, ReturnType<typeof commitDiff>>): Located | 'outside' | null {
  const commits = [...c.commits].reverse().filter(x => !claim.commit || x.hash.startsWith(claim.commit));
  let fileSeen = false;
  for (const cm of commits) {
    let files = diffs.get(cm.hash);
    if (!files) { files = commitDiff(repo, cm.hash, cm.parent); diffs.set(cm.hash, files); }
    const f = files.find(x => x.path === claim.file);
    if (!f) continue;
    fileSeen = true;
    for (const side of ['added', 'removed'] as const) {
      const row = f.hunks.flatMap(h => h.lines).find(l => (side === 'added' ? l.n === claim.line && l.t !== '-' : l.o === claim.line && l.t === '-'));
      if (!row) continue;
      const s = snippetAround(f, claim.line, side === 'added' && row.t === ' ' ? 'added' : side);
      const rows = s?.rows ?? [{ t: row.t, o: row.o, n: row.n, text: row.text, sig: true }];
      return { commit: cm.hash, side, header: s?.header ?? '', rows: rows.map(r => ({ t: r.t, o: r.o, n: r.n, text: r.text, ...(r.sig ? { sig: true } : {}) })), text: row.text.trim() };
    }
  }
  return fileSeen ? 'outside' : null;
}

/**
 * The evidence gate. A claim is kept only if it points at a line inside this case's diff.
 * Proof can't be claimed: only Assay, or a provider it runs, produces proof evidence. A reviewer's "this test fails" is recorded as a reading.
 * A claim that lands near an existing finding adds to it (a second source corroborates); otherwise it is a new finding, a hint on its own.
 * Safe to run again over every claim of a case: it only adds what is missing.
 */
export function applyClaims(repo: string, c: Case, incoming: Claim[]): GateResult {
  const known = new Set(c.claims.map(claimKey));
  const fresh = new Set<string>();
  for (const cl of incoming) {
    const k = claimKey(cl);
    if (!known.has(k)) { c.claims.push(cl); known.add(k); }
    fresh.add(k);
  }
  c.dropped = [];
  const diffs = new Map<string, ReturnType<typeof commitDiff>>();
  const result: GateResult = { kept: [], merged: [], dropped: [] };
  for (const raw of c.claims) {
    const isNew = fresh.has(claimKey(raw));
    const claim: Claim = { ...raw, source: raw.source.startsWith('reviewer:') ? raw.source : `reviewer:${raw.source || 'unknown'}`, lens: LENSES.includes(raw.lens) ? raw.lens : 'Correctness' };
    const drop = (reason: Dropped['reason']): void => { const d = { claim: raw, reason }; c.dropped.push(d); if (isNew) result.dropped.push(d); };
    if (!claim.what || claim.what.trim().length < 8 || !claim.title.trim() || !claim.file || !Number.isInteger(claim.line) || claim.line < 1) { drop(claim.file ? 'empty' : 'no-location'); continue; }
    const where = locate(repo, c, claim, diffs);
    if (where === null) { drop('no-location'); continue; }
    if (where === 'outside') { drop('outside-diff'); continue; }
    const extra = (claim.evidence ?? []).map(e => ({ kind: isProof(e.kind) ? ('claim' as const) : e.kind, source: claim.source, what: (isProof(e.kind) ? '[unverified] ' : '') + e.what }));
    const items = [{ kind: 'claim' as const, source: claim.source, what: claim.what.trim() }, ...extra];
    const near = c.findings.find(f => f.file === claim.file && Math.abs(f.line - claim.line) <= 3 && f.commit === where.commit);
    if (near) {
      if (near.evidence.some(e => e.source === claim.source)) continue;
      for (const e of items) near.evidence.push({ id: `${near.id}.${near.evidence.length + 1}`, ...e, file: claim.file, line: claim.line, replay: { commit: where.commit } });
      near.tier = tierOf(near.evidence);
      const r = riskOf(near);
      near.risk = r.risk; near.why = r.why;
      if (isNew) result.merged.push({ claim: raw, findingId: near.id });
      continue;
    }
    const id = `f-${sha(['claim', claim.source, claim.title, claim.file, claim.line, where.commit].join('\0'), 8)}`;
    if (c.findings.some(f => f.id === id)) continue;
    const evidence: Evidence[] = items.map((e, i) => ({ id: `${id}.${i + 1}`, ...e, file: claim.file, line: claim.line, replay: { commit: where.commit } }));
    const f: Finding = {
      id, check: 'reviewer', title: claim.title.trim(), lens: claim.lens, severity: claim.severity ?? 'low', commit: where.commit, file: claim.file, line: claim.line, lines: String(claim.line),
      evidence, observed: [], inferred: [claim.what.trim()], why: [], risk: 0, tier: tierOf(evidence),
      snippet: { file: claim.file, header: where.header, rows: where.rows }, anchor: { side: where.side, text: where.text }, origin: 'claim'
    };
    const r = riskOf(f);
    f.risk = r.risk; f.why = [...r.why, 'A reviewer’s reading'];
    c.findings.push(f);
    if (isNew) result.kept.push(f);
  }
  c.findings.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
  return result;
}

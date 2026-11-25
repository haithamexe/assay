import { tierOf } from '../evidence.js';
import { riskOf } from '../risk.js';
import type { Case } from '../types.js';

/**
 * Puts what Assay ran back into a case that was rebuilt from the commits: proof findings, and the coverage signals
 * that landed on other findings. Runs nothing, so reopening a case is as free as it was.
 */
export function applyRuns(c: Case): void {
  for (const r of c.runs) {
    for (const f of r.findings) if (!c.findings.some(x => x.id === f.id)) c.findings.push(structuredClone(f));
    for (const s of r.signals) {
      const f = c.findings.find(x => x.id === s.findingId);
      if (!f || f.evidence.some(e => e.source === s.evidence.source)) continue;
      f.evidence.push({ ...s.evidence, id: `${f.id}.${f.evidence.length + 1}` });
      f.tier = tierOf(f.evidence);
      const x = riskOf(f);
      f.risk = x.risk;
      f.why = x.why;
    }
  }
  c.findings.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
}

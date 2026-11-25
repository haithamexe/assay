import fs from 'node:fs';
import { assayPath, writeFileAtomic } from './config.js';
import { recordCase } from './memory/entries.js';
import type { Case } from './types.js';

const ID = /^c-[0-9a-f]{7}-(?:[0-9a-f]{7}|root)$/;

/** An id from outside is only ever this shape, so it can't name a file anywhere else. */
export function casePath(id: string): string {
  if (!ID.test(id)) throw new Error(`"${id}" is not a case id`);
  return assayPath('cases', `${id}.json`);
}

export function saveCase(c: Case): void {
  writeFileAtomic(casePath(c.id), JSON.stringify(c));
  // Memory counts what a case found. It helps; it is never a reason a case can't be saved.
  try { recordCase(c); } catch { /* ignored */ }
}

export function loadCase(id: string): Case | null {
  try {
    return JSON.parse(fs.readFileSync(casePath(id), 'utf8')) as Case;
  } catch {
    return null;
  }
}

export function listCases(): Array<Pick<Case, 'id' | 'name' | 'createdAt' | 'head' | 'base'> & { commits: number; findings: number }> {
  let names: string[] = [];
  try { names = fs.readdirSync(assayPath('cases')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const id = n.replace(/\.json$/, '');
    if (!ID.test(id)) continue;
    const c = loadCase(id);
    if (c) out.push({ id: c.id, name: c.name, createdAt: c.createdAt, head: c.head, base: c.base, commits: c.commits.length, findings: c.findings.length });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

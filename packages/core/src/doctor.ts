import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { assayHome } from './config.js';
import { memoryFile, memoryStatus } from './memory/db.js';

export interface DoctorRow {
  id: string;
  /** true: fine, false: a problem, null: optional and not there. */
  ok: boolean | null;
  name: string;
  note: string;
}

function version(cmd: string): string | null {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

/** What Assay needs and what it can use if it finds it. Both the command line and the dashboard show this. */
export function doctor(): DoctorRow[] {
  const git = version('git');
  let writable = false;
  try {
    fs.mkdirSync(assayHome(), { recursive: true });
    fs.accessSync(assayHome(), fs.constants.W_OK);
    writable = true;
  } catch { /* reported in the row */ }
  const optional = (id: string): DoctorRow => {
    const v = version(id);
    return { id, ok: v ? true : null, name: id, note: v ?? 'not installed (optional: it adds evidence if it is found)' };
  };
  const mem = memoryStatus();
  return [
    { id: 'git', ok: !!git, name: 'git', note: git ?? 'not found: assay reads git, so it needs it' },
    { id: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, name: 'node', note: process.version },
    { id: 'state', ok: writable, name: 'state folder', note: assayHome() },
    { id: 'memory', ok: mem.available ? true : null, name: 'memory', note: mem.available ? memoryFile() : `${mem.why} (optional: without it Assay remembers nothing, and nothing else changes)` },
    optional('semgrep'),
    optional('gitleaks'),
    optional('osv-scanner')
  ];
}

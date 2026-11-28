import { git, gitBuffer } from '../git.js';

/** One file tracked at a commit, as `git ls-tree` lists it. */
export interface TreeFile { path: string; sha: string; size: number; mode: string }

/** A file larger than this is checked by its name only: its text isn't read. */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** How much text one `git cat-file --batch` call may return before the next call starts. */
const BATCH_BYTES = 48 * 1024 * 1024;

/** Every regular file tracked at a commit. Links and submodules are left out: they hold no text of this repository. */
export function listTree(repo: string, rev: string): TreeFile[] {
  const out = git(repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', rev]);
  const files: TreeFile[] = [];
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha, size] = entry.slice(0, tab).split(/\s+/);
    if (type !== 'blob' || mode === '120000') continue;
    files.push({ path: entry.slice(tab + 1), sha, size: Number(size) || 0, mode });
  }
  return files;
}

/**
 * The text of each file, read from git's object store (never the working folder), in a few `cat-file --batch` calls, handed
 * to `fn` one file at a time so a big repository is never held in memory whole. A file over MAX_TEXT_BYTES, or one with a NUL
 * byte in it (binary), is handed over as null.
 */
export function eachText(repo: string, files: TreeFile[], fn: (file: TreeFile, text: string | null) => void): void {
  const wanted: TreeFile[] = [];
  for (const f of files) { if (f.size > MAX_TEXT_BYTES) fn(f, null); else wanted.push(f); }
  for (let i = 0; i < wanted.length;) {
    const batch: TreeFile[] = [];
    let bytes = 0;
    while (i < wanted.length && (batch.length === 0 || bytes + wanted[i].size <= BATCH_BYTES)) { bytes += wanted[i].size; batch.push(wanted[i++]); }
    const buf = gitBuffer(repo, ['cat-file', '--batch'], { input: batch.map(f => f.sha).join('\n') + '\n', maxBuffer: bytes + batch.length * 128 + 1024 });
    let at = 0;
    for (const f of batch) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) { fn(f, null); continue; }
      const header = buf.subarray(at, nl).toString('utf8').split(' ');
      const size = Number(header[2]);
      if (header[1] === 'missing' || !Number.isFinite(size)) { at = nl + 1; fn(f, null); continue; }
      const body = buf.subarray(nl + 1, nl + 1 + size);
      at = nl + 1 + size + 1;
      fn(f, body.includes(0) ? null : body.toString('utf8'));
    }
  }
}

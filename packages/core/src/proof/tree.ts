import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assayPath } from '../config.js';
import { git, repoKey } from '../git.js';

/**
 * A clean checkout of one commit in a folder of its own. Made with a temporary index, so nothing in the repository
 * (its working tree, its index, its .git folder) is touched: the repository is only read.
 */
export function exportTree(repo: string, commit: string, label: string): string {
  const dest = assayPath('work', repoKey(repo), `${label}-${commit.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const idx = path.join(path.dirname(dest), `.index-${crypto.randomBytes(4).toString('hex')}`);
  try {
    git(repo, ['read-tree', commit], { env: { GIT_INDEX_FILE: idx } });
    git(repo, ['checkout-index', '--all', '--force', `--prefix=${dest.replace(/\\/g, '/')}/`], { env: { GIT_INDEX_FILE: idx } });
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch { /* a stray index file is harmless */ }
  }
  return dest;
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage']);

function folders(root: string, depth: number, rel = ''): string[] {
  const out = [rel];
  if (depth === 0) return out;
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of names) if (d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith('.')) out.push(...folders(root, depth - 1, rel ? `${rel}/${d.name}` : d.name));
  return out;
}

function link(target: string, at: string): void {
  try {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* a missing link shows up as a failing test at both ends, which proves nothing either way */ }
}

/**
 * The checkout has no node_modules. Each one the repository has is rebuilt as a real folder of links to the installed packages,
 * except a workspace package (a link back into the repository): that one is pointed at the checkout's own copy, so the code
 * under test is the commit's code and not whatever is in the working tree now.
 */
export function linkDependencies(main: string, dest: string): void {
  const mainReal = fs.realpathSync(main);
  for (const rel of folders(main, 3)) {
    const src = path.join(main, rel, 'node_modules');
    const dst = path.join(dest, rel, 'node_modules');
    if (!fs.existsSync(src) || !fs.existsSync(path.join(dest, rel)) || fs.existsSync(dst)) continue;
    fs.mkdirSync(dst, { recursive: true });
    const one = (from: string, to: string): void => {
      let st: fs.Stats;
      try { st = fs.lstatSync(from); } catch { return; }
      let real: string;
      try { real = fs.realpathSync(from); } catch { return; }
      if (st.isSymbolicLink() && real.startsWith(mainReal) && !real.includes(`${path.sep}node_modules${path.sep}`)) {
        const own = path.join(dest, path.relative(mainReal, real));
        link(fs.existsSync(own) ? own : real, to);
      } else if (st.isDirectory() || st.isSymbolicLink()) link(real, to);
    };
    for (const name of fs.readdirSync(src)) {
      if (name.startsWith('@')) {
        for (const sub of fs.readdirSync(path.join(src, name))) one(path.join(src, name, sub), path.join(dst, name, sub));
      } else one(path.join(src, name), path.join(dst, name));
    }
  }
}

/** Links first, then the folder: deleting a folder must never reach through a link into the real packages. */
export function removeTree(dest: string): void {
  const links: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) links.push(p);
      else if (d.isDirectory() && depth > 0) walk(p, d.name === 'node_modules' || d.name.startsWith('@') ? depth : depth - 1);
    }
  };
  walk(dest, 5);
  for (const l of links) {
    try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* checked below */ } }
  }
  if (links.some(l => { try { return fs.lstatSync(l).isSymbolicLink(); } catch { return false; } })) return;
  try { fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* left for the next clean-up */ }
  try { fs.rmdirSync(path.dirname(dest)); } catch { /* not empty: another checkout is in use */ }
}

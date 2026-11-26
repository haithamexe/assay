import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sha } from './config.js';

/** Git is only ever run with an argument array, never through a shell. Phase 1 reads; it never writes to a repository. */
export class GitError extends Error {}

export function git(repo: string, args: string[], opts: { allowFail?: boolean; input?: string; maxBuffer?: number; env?: Record<string, string> } = {}): string {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      input: opts.input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...opts.env }
    });
  } catch (err) {
    if (opts.allowFail) return '';
    const e = err as { stderr?: Buffer | string; message: string };
    throw new GitError(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

/** Like git(), for output that takes a while (a long history with patches): the event loop keeps serving while git works, and an abort signal stops it. */
export function gitAsync(repo: string, args: string[], opts: { maxBuffer?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], {
      encoding: 'utf8', maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024, windowsHide: true, signal: opts.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).name === 'AbortError') return reject(err);
      reject(new GitError(`git ${args[0]} failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
    });
  });
}

export function repoRoot(dir: string): string {
  const out = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true }).trim();
  if (!out) throw new GitError(`${dir} is not inside a git repository`);
  return path.resolve(out);
}

/** A ref or hash from outside: letters, digits and ./_~^@{}- only, never starting with a dash and never a range. */
const REV = /^[A-Za-z0-9._/~^@{}-]+$/;
export function resolveRev(repo: string, rev: string): string {
  if (!rev || rev.startsWith('-') || rev.includes('..') || !REV.test(rev)) throw new GitError(`"${rev}" is not a commit or branch name`);
  const out = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { allowFail: true }).trim();
  if (!out) throw new GitError(`"${rev}" is not a commit in this repository`);
  return out;
}

export function emptyTree(repo: string): string {
  return git(repo, ['hash-object', '-t', 'tree', '/dev/null'], { allowFail: true }).trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

export interface RawCommit { hash: string; parent: string | null; author: string; date: string; subject: string }

/** One `git log` call for any number of commits, in the order given. */
export function commitInfo(repo: string, hashes: string[]): RawCommit[] {
  if (!hashes.length) return [];
  const out = git(repo, ['log', '--no-walk=unsorted', '--stdin', '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e'], { input: hashes.join('\n') + '\n' });
  return out.split('\x1e').map(r => r.replace(/^\n/, '')).filter(Boolean).map(r => {
    const [hash, parents, author, date, subject] = r.split('\x1f');
    return { hash, parent: parents.split(' ')[0] || null, author, date, subject };
  });
}

/** Commits in base..head, oldest first, merges left out (their diff is a combined one). */
export function listRange(repo: string, base: string | null, head: string, max: number): { hashes: string[]; merges: number } {
  const range = base ? [`${base}..${head}`] : ['--max-count=' + max, head];
  const all = git(repo, ['rev-list', '--reverse', ...range]).split('\n').filter(Boolean);
  const nomerge = git(repo, ['rev-list', '--reverse', '--no-merges', ...range]).split('\n').filter(Boolean);
  return { hashes: nomerge, merges: all.length - nomerge.length };
}

/**
 * The commits after `base` up to and including `head`, along the first parent, oldest first. Null when that line doesn't start at the base
 * (the base is on a side branch), because then "the one before" a commit in it isn't a commit of the range. A merge is one step on this line:
 * the first parent is the branch that was merged into.
 */
export function firstParentChain(repo: string, base: string, head: string): string[] | null {
  const chain = git(repo, ['rev-list', '--first-parent', '--reverse', `${base}..${head}`], { allowFail: true }).split('\n').filter(Boolean);
  if (!chain.length || chain[chain.length - 1] !== head) return null;
  const before = git(repo, ['rev-parse', '--verify', '--quiet', `${chain[0]}^`], { allowFail: true }).trim();
  return before === base ? chain : null;
}

/** The file at a revision, or null if it isn't there (or is too big to read). */
export function showFile(repo: string, rev: string, file: string): string | null {
  if (file.startsWith('-')) return null;
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', '-C', repo, 'show', `${rev}:${file}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    });
  } catch {
    return null;
  }
}

/** Where a branch started: the merge-base with the repository's default branch, or null when HEAD is on it. */
export function defaultBase(repo: string, head: string): string | null {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master', 'develop', 'trunk']) {
    const target = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowFail: true }).trim();
    if (!target) continue;
    const mb = git(repo, ['merge-base', head, target], { allowFail: true }).trim();
    if (mb && mb !== head) return mb;
  }
  return null;
}

/** The folder as the file system itself names it: no symlinks (macOS keeps /var and /tmp behind one) and no Windows 8.3 short names (a temp folder often has them). Git reports the real name, so two spellings of one folder must not become two repositories. */
const realFolder = (p: string): string => {
  try { return fs.realpathSync.native(p); } catch { return p; }
};

/** A repository's key in Assay's own folders. Paths are case-insensitive on Windows and (by default) macOS, so there they are lower-cased; on Linux two folders that differ only by case are two repositories. */
export const repoKey = (repo: string): string => {
  const p = realFolder(path.resolve(repo));
  return sha(process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p, 10);
};
export const repoName = (repo: string): string => path.basename(repo);

/** How many times a file changed in the 90 days up to a date. One call, only asked for files that already have a finding. */
export function churn(repo: string, file: string, until: string): number {
  const since = new Date(new Date(until).getTime() - 90 * 86400_000).toISOString();
  const out = git(repo, ['log', `--since=${since}`, `--until=${until}`, '--format=%h', '--', file], { allowFail: true });
  return out.split('\n').filter(Boolean).length;
}

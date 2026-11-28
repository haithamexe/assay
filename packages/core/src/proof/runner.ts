import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from '@haithamexe/plainkit/process';
import { redactSecrets } from '../checks/secrets.js';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import { repoKey } from '../git.js';
import { parseTestOutput, type ParsedRun } from './parse.js';

/**
 * How the project runs its own tests. Found from its manifest, or the command the person chose with `assay allow-run --command`.
 * Never from a request: an agent can't make Assay run a command of its choosing (D14).
 */
export interface TestCommand {
  text: string;
  label: string;
  /** Run through the platform shell (npm and friends are scripts on Windows). Only ever fixed words or what the person typed. */
  shell: boolean;
  file?: string;
  args?: string[];
  env?: Record<string, string>;
}

const read = (root: string, f: string): string => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
const has = (root: string, f: string): boolean => fs.existsSync(path.join(root, f));

function pythonFor(root: string): string {
  for (const p of ['.venv/Scripts/python.exe', '.venv/bin/python', 'venv/Scripts/python.exe', 'venv/bin/python']) if (has(root, p)) return path.join(root, p);
  return process.platform === 'win32' ? 'python' : 'python3';
}
function hasPythonTests(root: string): boolean {
  for (const d of ['tests', 'test', '.']) {
    try { if (fs.readdirSync(path.join(root, d)).some(n => /^test_.*\.py$|.*_test\.py$/.test(n))) return true; } catch { /* no such folder */ }
  }
  return false;
}

export function detectCommand(root: string, custom?: string): TestCommand | null {
  if (custom && custom.trim()) return { text: custom.trim(), label: custom.trim(), shell: true };
  if (has(root, 'package.json')) {
    try {
      const t = (JSON.parse(read(root, 'package.json')) as { scripts?: { test?: unknown } }).scripts?.test;
      if (typeof t === 'string' && !/no test specified/i.test(t)) {
        const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm test' : has(root, 'yarn.lock') ? 'yarn test' : has(root, 'bun.lock') || has(root, 'bun.lockb') ? 'bun run test' : 'npm test';
        return { text: pm, label: `${pm}  (${t.length > 70 ? `${t.slice(0, 69)}…` : t})`, shell: true };
      }
    } catch { /* a package.json that isn't JSON has no test command we can trust */ }
  }
  if (has(root, 'pytest.ini') || /\[tool\.pytest/.test(read(root, 'pyproject.toml')) || /\[pytest\]/.test(read(root, 'tox.ini')) || /\[tool:pytest\]/.test(read(root, 'setup.cfg')) || hasPythonTests(root)) {
    return { text: 'python -m pytest -q', label: 'python -m pytest -q', shell: false, file: pythonFor(root), args: ['-m', 'pytest', '-q', '--no-header', '-p', 'no:cacheprovider'] };
  }
  if (has(root, 'go.mod')) return { text: 'go test ./...', label: 'go test ./...', shell: false, file: 'go', args: ['test', './...'] };
  if (has(root, 'Cargo.toml')) return { text: 'cargo test', label: 'cargo test', shell: false, file: 'cargo', args: ['test'], env: { CARGO_TARGET_DIR: assayPath('work', 'cargo-target') } };
  // Fixed words only, never anything from a request. Those that are scripts on Windows (mvn, gradle, bundle, make) go through the shell.
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { /* no root, no runner */ }
  if (names.some(n => /\.(?:sln|csproj|fsproj)$/i.test(n))) return { text: 'dotnet test', label: 'dotnet test', shell: false, file: 'dotnet', args: ['test', '--nologo', '--verbosity', 'minimal'] };
  if (has(root, 'pom.xml')) return { text: 'mvn -B -q test', label: 'mvn -B -q test', shell: true };
  if (names.some(n => /^(?:build|settings)\.gradle(?:\.kts)?$/.test(n))) {
    const wrapper = process.platform === 'win32' ? has(root, 'gradlew.bat') : has(root, 'gradlew');
    const text = wrapper ? (process.platform === 'win32' ? 'gradlew.bat test --console=plain' : './gradlew test --console=plain') : 'gradle test --console=plain';
    return { text, label: text, shell: true };
  }
  if (has(root, 'deno.json') || has(root, 'deno.jsonc')) return { text: 'deno test', label: 'deno test', shell: false, file: 'deno', args: ['test'] };
  if (has(root, 'Gemfile') && fs.existsSync(path.join(root, 'spec'))) return { text: 'bundle exec rspec', label: 'bundle exec rspec', shell: true };
  if (/^test\s*:/m.test(read(root, 'Makefile'))) return { text: 'make test', label: 'make test', shell: true };
  return null;
}

export interface RunResult extends ParsedRun {
  exit: number | null;
  timedOut: boolean;
  secs: number;
  /** The last lines of output, secrets masked, for showing why a run failed. */
  tail: string;
  error?: string;
  /** What the command wrote to stdout, only when asked for (`keepStdout`), capped like the rest. Not masked: the caller reads it as a report. */
  stdout?: string;
}

export { killTree };

const MAX_OUTPUT = 8 * 1024 * 1024;

export function runCommand(cmd: TestCommand, cwd: string, opts: { timeoutSec: number; signal?: AbortSignal; keepStdout?: boolean }): Promise<RunResult> {
  return new Promise(resolve => {
    const env: Record<string, string | undefined> = { ...process.env, ...cmd.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ASSAY_RUN: '1' };
    // A node --test run started from inside another node --test run would think it is a child of it and print the wrong format.
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const detached = process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = cmd.shell
        ? spawn(cmd.text, { cwd, shell: true, env, windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(cmd.file!, cmd.args ?? [], { cwd, env, windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ exit: null, timedOut: false, secs: 0, failed: [], failedCount: null, passedCount: null, refs: [], tail: '', error: (err as Error).message });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (b: Buffer): void => { if (size < MAX_OUTPUT) { chunks.push(b); size += b.length; } };
    const outChunks: Buffer[] = [];
    let outSize = 0;
    child.stdout?.on('data', take);
    if (opts.keepStdout) child.stdout?.on('data', (b: Buffer) => { if (outSize < MAX_OUTPUT) { outChunks.push(b); outSize += b.length; } });
    child.stderr?.on('data', take);
    let timedOut = false;
    let spawnError: string | undefined;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(1, opts.timeoutSec) * 1000);
    // A person pressed Stop: the whole process tree goes, and the caller sees the signal and keeps nothing from this run.
    const stop = (): void => killTree(child);
    if (opts.signal?.aborted) stop(); else opts.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', err => { spawnError = err.message; });
    child.on('close', code => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      const output = Buffer.concat(chunks).toString('utf8');
      const parsed = parseTestOutput(output, cwd);
      const tail = output.split(/\r?\n/).filter(l => l.trim()).slice(-30).map(l => redactSecrets(l.length > 300 ? `${l.slice(0, 299)}…` : l)).join('\n');
      resolve({ exit: code, timedOut, secs: Math.round((Date.now() - started) / 100) / 10, ...parsed, tail, error: spawnError, ...(opts.keepStdout ? { stdout: Buffer.concat(outChunks).toString('utf8') } : {}) });
    });
  });
}

/* A run is cached by commit, command and what was changed: the same question is never asked twice. */
const cachePath = (repo: string, commit: string, variant: string, cmd: string): string => assayPath('runs', repoKey(repo), `${commit.slice(0, 12)}-${sha(`${variant}\0${cmd}`, 10)}.json`);

export function cachedRun(repo: string, commit: string, variant: string, cmd: string): RunResult | null {
  try { return JSON.parse(fs.readFileSync(cachePath(repo, commit, variant, cmd), 'utf8')) as RunResult; } catch { return null; }
}
export function cacheRun(repo: string, commit: string, variant: string, cmd: string, r: RunResult): void {
  if (r.timedOut || r.error) return;
  try { writeFileAtomic(cachePath(repo, commit, variant, cmd), JSON.stringify(r)); } catch { /* only slower next time */ }
}

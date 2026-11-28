import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../checks/secrets.js';
import { assayPath } from '../config.js';
import { git, repoKey, repoName, repoRoot, resolveRev } from '../git.js';
import { parseCoverageSummary, parseGoCover, parsePytestCoverage, parseV8Coverage, type Coverage } from './coverage.js';
import { parseGoJson, parseJestJson, parseJunit, parseTap, type ReportCounts, type TestFailure } from './reports.js';
import { detectCommand, runCommand, type TestCommand } from './runner.js';
import { repoSettings } from './settings.js';
import { exportTree, linkDependencies, removeTree } from './tree.js';

/**
 * Project mode's test run (D61): the project's own tests at one commit, read the way a person wants them (how many passed,
 * each failure with its file, line, message, expected and actual) and, when asked, how much of the code they ran.
 * By default in a clean copy of the commit (D16: the repository is only read); with `here`, in the repository's own folder,
 * uncommitted work included, which a person must have allowed separately (`assay allow-run --here`).
 * The command is the project's own, found from its manifest, with fixed flags (D14). A name filter or file list is an argument,
 * never a command: runners with a report are started without a shell, and nothing typed can become a flag.
 */

export const TEST_SCHEMA = 'assay.test/1';

export type TestFramework = 'vitest' | 'jest' | 'node' | 'pytest' | 'go' | 'other';

export interface TestReport {
  /** The JSON contract: fields are only added within a version. */
  schema: typeof TEST_SCHEMA;
  repo: string;
  name: string;
  /** The commit the tests ran on (HEAD for `here`, plus whatever is uncommitted). */
  commit: string;
  /** `copy`: a clean copy of the commit under ~/.assay/work. `here`: the repository's own folder. */
  where: 'copy' | 'here';
  /** `here` only: files that differ from the commit, so the run is not the commit alone. */
  uncommitted?: number;
  framework: TestFramework;
  /** What ran, as a person would type it. */
  command: string;
  ok: boolean;
  /** null when the runner gave no report and its output didn't say. */
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  secs: number;
  /** At most 50, secrets masked. */
  failures: TestFailure[];
  /** The last lines the command printed, secrets masked: why a run with no report failed. */
  outputTail: string[];
  error?: string;
  timedOut?: boolean;
  /** How much of the code the tests ran, when asked for and the runner could say. */
  coverage?: Coverage;
  /** Why there is no coverage when it was asked for, and what to do about it. */
  coverageNote?: string;
  /** What was asked for and couldn't be done the way it was asked (a filter this runner has no way to apply, …). */
  notes: string[];
  createdAt: string;
}

export interface TestOptions {
  repo: string;
  /** A commit or branch; HEAD by default. Not with `here`. */
  ref?: string;
  /** Run in the repository's own folder, uncommitted work included. Needs `assay allow-run --here`. */
  here?: boolean;
  /** Only tests whose name matches (vitest and jest -t, pytest -k, go -run, node --test-name-pattern). */
  match?: string;
  /** Only these test files or packages, relative to the repository. */
  files?: string[];
  /** Only tests related to uncommitted changes (vitest --changed, jest --onlyChanged). Needs `here`. */
  changed?: boolean;
  /** Also measure how much of the code the tests run. */
  coverage?: boolean;
  /** Seconds the run may take; the repository's setting (300) by default, at most an hour. */
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}

export class TestInputError extends Error {}

type Deps = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const readJson = <T>(file: string): T | undefined => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; } };
const read = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/** The file a package's command runs, relative to the folder, when it is installed there: node_modules/vitest/vitest.mjs. */
function binOf(root: string, pkg: string): string | undefined {
  const json = readJson<{ bin?: string | Record<string, string> }>(path.join(root, 'node_modules', pkg, 'package.json'));
  const bin = typeof json?.bin === 'string' ? json.bin : json?.bin?.[pkg] ?? (json?.bin ? Object.values(json.bin)[0] : undefined);
  if (!bin) return undefined;
  const rel = path.join('node_modules', pkg, bin);
  return fs.existsSync(path.join(root, rel)) ? rel : undefined;
}

export interface FoundRunner { framework: TestFramework; cmd: TestCommand; bin?: string; note?: string }

/**
 * Which runner the project tests with: a person's own command first (`allow-run --command`), then vitest or jest from the
 * dependencies (when installed, so its report can be asked for), node:test from the test script, then whatever
 * `detectCommand` finds (pytest and go have reports of their own; the rest are read from their output).
 */
export function detectRunner(root: string, custom?: string): FoundRunner | null {
  const base = detectCommand(root, custom);
  if (!base) return null;
  if (custom?.trim()) return { framework: 'other', cmd: base };
  const pkg = readJson<Deps>(path.join(root, 'package.json'));
  if (pkg && base.shell && /^(npm|pnpm|yarn|bun run) test$/.test(base.text)) {
    const script = pkg.scripts?.test ?? '';
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (name: string): boolean => name in deps || new RegExp(`\\b${name}\\b`).test(script);
    for (const name of ['vitest', 'jest'] as const) {
      if (!has(name)) continue;
      const bin = binOf(root, name);
      if (bin) return { framework: name, cmd: base, bin };
      return { framework: 'other', cmd: base, note: `${name} isn't installed in this folder, so its report can't be asked for: the counts come from what ${base.text} prints. Install the dependencies (npm install) for the full report.` };
    }
    if (/\bnode\b[^&|;]*--test\b/.test(script)) return { framework: 'node', cmd: base };
    return { framework: 'other', cmd: base };
  }
  if (base.args?.[0] === '-m' && base.args[1] === 'pytest') return { framework: 'pytest', cmd: base };
  if (base.file === 'go') return { framework: 'go', cmd: base };
  return { framework: 'other', cmd: base };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A name filter: plain text that can't become a flag or leave its argument. */
export function checkMatch(match: string): string {
  const m = match.trim();
  if (!m || m.length > 200) throw new TestInputError('A test name filter is 1 to 200 characters.');
  if (CONTROL.test(m)) throw new TestInputError('A test name filter is one line of plain text.');
  if (m.startsWith('-')) throw new TestInputError('A test name filter can’t start with "-" (it would be read as an option).');
  return m;
}

/** A test file or package: relative, inside the repository, never an option. */
export function checkFile(file: string): string {
  const f = file.trim().replace(/\\/g, '/');
  if (!f || f.length > 300 || CONTROL.test(f)) throw new TestInputError(`Not a test file: ${JSON.stringify(file.slice(0, 60))}`);
  if (f.startsWith('-')) throw new TestInputError(`A test file can’t start with "-": ${f.slice(0, 60)}`);
  if (path.isAbsolute(f) || /^[A-Za-z]:/.test(f) || f.startsWith('/') || f.split('/').includes('..')) throw new TestInputError(`A test file is a path inside the repository, without "..": ${f.slice(0, 60)}`);
  return f;
}

const MAX_FAILURES = 50;

function mask(f: TestFailure): TestFailure {
  const m = (s?: string): string | undefined => (s === undefined ? undefined : redactSecrets(s.length > 2000 ? `${s.slice(0, 1999)}…` : s));
  return { ...f, name: m(f.name)!, message: m(f.message)!, expected: m(f.expected), actual: m(f.actual), stack: f.stack?.map(l => m(l)!) };
}

/** Runs the project's tests once and reads the result. Throws when running isn't allowed or an input is wrong; a failing run is a report, not an error. */
export async function runTests(opts: TestOptions): Promise<TestReport> {
  const root = repoRoot(opts.repo);
  const settings = repoSettings(root);
  if (!settings.allow) throw new Error('Running this repository’s tests isn’t allowed yet. A person has to turn it on: assay allow-run');
  if (opts.here && !settings.here) throw new Error('Running the tests in your own folder isn’t allowed yet. A person has to turn it on: assay allow-run --here  (without it, assay test runs them in a clean copy of the commit).');
  if (opts.here && opts.ref) throw new TestInputError('--here runs what is in the folder now, so it takes no --ref.');
  if (opts.changed && !opts.here) throw new TestInputError('--changed picks the tests for uncommitted changes, and a clean copy of a commit has none. Use it with --here (after assay allow-run --here).');
  const match = opts.match === undefined ? undefined : checkMatch(opts.match);
  const files = (opts.files ?? []).slice(0, 50).map(checkFile);
  const commit = resolveRev(root, opts.ref ?? 'HEAD');
  const timeoutSec = Math.max(5, Math.min(3600, opts.timeoutSec ?? settings.timeout ?? 300));
  const say = opts.onProgress ?? ((): void => {});
  const notes: string[] = [];

  const work = assayPath('work', repoKey(root), `test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  let dir = root;
  let copy: string | null = null;
  let uncommitted: number | undefined;
  const started = Date.now();
  try {
    if (opts.here) {
      const changed = git(root, ['diff', '--name-only', '-z', 'HEAD'], { allowFail: true }).split('\0').filter(Boolean);
      const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true }).split('\0').filter(Boolean);
      uncommitted = new Set([...changed, ...untracked]).size;
    } else {
      say(`Making a clean copy of ${commit.slice(0, 7)}…`);
      copy = exportTree(root, commit, 'test');
      linkDependencies(root, copy);
      dir = copy;
    }
    const found = detectRunner(dir, settings.command) ?? (copy ? detectRunner(root, settings.command) : null);
    const empty = (framework: TestFramework, command: string): TestReport => ({
      schema: TEST_SCHEMA, repo: root, name: repoName(root), commit, where: opts.here ? 'here' : 'copy', ...(uncommitted !== undefined ? { uncommitted } : {}),
      framework, command, ok: false, passed: null, failed: null, skipped: null, secs: 0, failures: [], outputTail: [], notes, createdAt: new Date().toISOString()
    });
    if (!found) return { ...empty('other', ''), error: 'No test command found. Tell Assay which one: assay allow-run --command "<your test command>"' };
    if (found.note) notes.push(found.note);

    const report = path.join(work, 'report');
    const covDir = path.join(work, 'coverage');
    let covFile: string | undefined;
    let covKind: 'summary' | 'pytest' | 'go' | 'v8' | undefined;
    let coverageNote: string | undefined;
    const want = opts.coverage === true;
    const installed = (name: string): boolean => fs.existsSync(path.join(dir, 'node_modules', ...name.split('/')));
    const unsupported = (what: string): void => { notes.push(`${what} can’t be applied to ${found.cmd.text}: every test ran.`); };
    let cmd: TestCommand = found.cmd;
    let keepStdout = false;
    let label = found.cmd.label;
    const fixed = (name: string, args: string[]): TestCommand => ({ text: `${name} ${args.join(' ')}`, label: `${name} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, shell: false, file: process.execPath, args: [path.join(dir, found.bin!), ...args] });

    switch (found.framework) {
      case 'vitest': {
        const args = ['run', ...files, '--reporter=json', `--outputFile=${report}`];
        if (match) args.push(`--testNamePattern=${match}`);
        if (opts.changed) args.push('--changed');
        if (want) {
          // vitest stops at once without a coverage provider, so it is only asked for when one is installed.
          if (installed('@vitest/coverage-v8') || installed('@vitest/coverage-istanbul')) {
            args.push('--coverage', '--coverage.reporter=json-summary', `--coverage.reportsDirectory=${covDir}`);
            covFile = path.join(covDir, 'coverage-summary.json');
            covKind = 'summary';
          } else coverageNote = 'vitest needs a coverage provider: npm install -D @vitest/coverage-v8, then run again.';
        }
        cmd = fixed('vitest', args);
        label = cmd.label.replace(report, '<report>').replace(covDir, '<coverage>');
        break;
      }
      case 'jest': {
        const args = [...files, '--json', `--outputFile=${report}`, '--testLocationInResults'];
        if (match) args.push(`--testNamePattern=${match}`);
        if (opts.changed) args.push('--onlyChanged');
        if (want) {
          args.push('--coverage', '--coverageReporters=json-summary', `--coverageDirectory=${covDir}`);
          covFile = path.join(covDir, 'coverage-summary.json');
          covKind = 'summary';
        }
        cmd = fixed('jest', args);
        label = cmd.label.replace(report, '<report>').replace(covDir, '<coverage>');
        break;
      }
      case 'node': {
        // The project's own script; the TAP copy for Assay goes to a file through NODE_OPTIONS, the usual output still to stdout.
        if (match && /["\\]/.test(match)) throw new TestInputError('For node:test a name filter can’t hold " or \\.');
        const nodeOptions = [
          process.env.NODE_OPTIONS ?? '',
          '--test-reporter=spec --test-reporter-destination=stdout',
          `--test-reporter=tap --test-reporter-destination="${report.replace(/\\/g, '/')}"`,
          match ? `--test-name-pattern="${match}"` : ''
        ].join(' ').trim();
        cmd = { ...found.cmd, env: { ...found.cmd.env, NODE_OPTIONS: nodeOptions } };
        if (files.length) unsupported('A list of test files');
        if (opts.changed) unsupported('--changed');
        // node's own coverage flag can't go through NODE_OPTIONS, but V8 writes its raw coverage to a folder on request.
        if (want) { cmd.env = { ...cmd.env, NODE_V8_COVERAGE: covDir }; covKind = 'v8'; }
        break;
      }
      case 'pytest': {
        const args = [...(found.cmd.args ?? []), ...files, `--junitxml=${report}`];
        if (match) args.push('-k', match);
        if (opts.changed) unsupported('--changed');
        if (want) {
          // pytest stops on --cov without pytest-cov, so it is only asked for when the project lists it.
          if (/pytest-cov|\bcoverage\b/.test(['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.cfg'].map(f => read(path.join(dir, f))).join('\n'))) {
            covFile = path.join(covDir, 'coverage.json');
            fs.mkdirSync(covDir, { recursive: true });
            args.push('--cov=.', `--cov-report=json:${covFile}`);
            covKind = 'pytest';
          } else coverageNote = 'pytest needs pytest-cov: pip install pytest-cov (and list it in the project), then run again.';
        }
        cmd = { ...found.cmd, args };
        label = `python ${args.filter(a => a !== `--junitxml=${report}` && !a.startsWith('--cov-report=')).join(' ')}`;
        break;
      }
      case 'go': {
        const args = ['test', '-json'];
        if (match) args.push(`-run=${match}`);
        if (want) { covFile = path.join(work, 'cover.out'); args.push(`-coverprofile=${covFile}`); covKind = 'go'; }
        args.push(...(files.length ? files : ['./...']));
        if (opts.changed) unsupported('--changed');
        cmd = { ...found.cmd, args };
        keepStdout = true;
        label = `go ${args.map(a => (a === `-coverprofile=${covFile}` ? '-coverprofile=<file>' : a)).join(' ')}`;
        break;
      }
      default:
        if (match) unsupported('A test name filter');
        if (files.length) unsupported('A list of test files');
        if (opts.changed) unsupported('--changed');
        if (want) coverageNote = `Assay can’t measure ${found.cmd.text}. Run its own coverage command (for example npx c8 ${found.cmd.text}) yourself.`;
    }

    say(`Running ${label}${opts.here ? ' in your folder' : ''}…`);
    const r = await runCommand(cmd, dir, { timeoutSec, signal: opts.signal, keepStdout });
    if (opts.signal?.aborted) throw new Error('Stopped.');
    const out: TestReport = { ...empty(found.framework, label), secs: Math.round((Date.now() - started) / 100) / 10, outputTail: r.tail ? r.tail.split('\n') : [] };
    if (r.timedOut) { out.timedOut = true; out.error = `Stopped after ${timeoutSec} s (the time limit; assay allow-run --timeout <seconds> changes it).`; }
    else if (r.error) out.error = r.error;

    let counts: ReportCounts | null = null;
    try {
      if (found.framework === 'vitest' || found.framework === 'jest') counts = parseJestJson(read(report), dir);
      else if (found.framework === 'node') counts = parseTap(read(report), dir);
      else if (found.framework === 'pytest') counts = parseJunit(read(report), dir);
      else if (found.framework === 'go') counts = parseGoJson(r.stdout ?? '');
    } catch { /* an unreadable report: the exit code and the output still say what happened */ }
    if (counts && (counts.passed || counts.failed || counts.skipped || counts.failures.length)) {
      Object.assign(out, { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, failures: counts.failures.slice(0, MAX_FAILURES).map(mask) });
    } else {
      // No report (another runner, or one that crashed before writing it): what the output says.
      out.passed = r.passedCount;
      out.failed = r.failedCount ?? (r.failed.length || (r.exit === 0 ? 0 : null));
      out.failures = r.failed.slice(0, MAX_FAILURES).map(name => mask({ name, message: 'failed' }));
      if (found.framework !== 'other' && r.exit !== 0 && !out.error) out.error = 'The tests didn’t write a report; the output below says why.';
    }
    out.ok = r.exit === 0 && !out.error && (out.failed ?? 0) === 0;
    if (counts && counts.failures.length > MAX_FAILURES) notes.push(`${counts.failures.length - MAX_FAILURES} more failures not listed.`);

    if (want) {
      try {
        if (covKind === 'summary' && covFile) out.coverage = parseCoverageSummary(read(covFile), dir);
        else if (covKind === 'pytest' && covFile) out.coverage = parsePytestCoverage(read(covFile), dir);
        else if (covKind === 'go' && covFile) out.coverage = parseGoCover(read(covFile));
        else if (covKind === 'v8') out.coverage = parseV8Coverage(covDir, dir);
      } catch { /* an unreadable coverage file: the note below says there is none */ }
      if (out.coverage) out.coverage = { ...out.coverage, files: out.coverage.files.map(f => ({ ...f, file: redactSecrets(f.file) })) };
      else out.coverageNote = coverageNote ?? 'The tests ran but wrote no coverage report.';
    }
    return out;
  } finally {
    if (copy) removeTree(copy);
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* left for the next clean-up */ }
  }
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Browser } from '../browser/cdp.js';
import { findBrowser } from '../browser/find.js';
import { compareCalls, heavierThan, medianPerf, slowerThan, type CallChange } from '../browser/health.js';
import { diffShot, scanPage, SHOT_DIFFERENT, withDir, type PageScan } from '../browser/look.js';
import { redactSecrets } from '../checks/secrets.js';
import { repoName, repoRoot, resolveRev } from '../git.js';
import { detectCommand, killTree, runCommand } from '../proof/runner.js';
import { repoSettings } from '../proof/settings.js';
import { exportTree, removeTree } from '../proof/tree.js';
import { checkPagePath } from '../project/inputs.js';

/**
 * Try an upgrade (D67): before upgrading a package, install the new version in a throwaway copy and see what changes. Two clean copies of a
 * commit get the project's own install (the lockfile's versions); the second one then gets the one package at the new version. The type check,
 * the build and the tests run in both; the project's dev server runs from both and the pages are compared: what they show, what they
 * call, errors, speed, accessibility. "The tests fail, /checkout now throws" before your own folder is touched.
 *
 * It is the one check that needs the package manager to reach its registry, and Assay makes no network call of its own, so it needs the
 * person's own `assay allow-run --network` besides `allow-run`: the package manager does every call (install, and `npm view` to
 * resolve a tag or a partial version), with the project's own registry settings. Install scripts are not run unless the person asks
 * for them (`--scripts`), because a new version's script would run with the person's permissions before anyone has looked at it.
 */

export const TRY_SCHEMA = 'assay.try/1';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type CheckName = 'types' | 'build' | 'tests';

export interface TryTarget {
  name: string;
  /** The version the lockfile gave the project. */
  from?: string;
  /** The version tried. */
  to: string;
  dev: boolean;
  /** The first number changed. */
  major: boolean;
}

export interface CheckOutcome {
  name: CheckName;
  label: string;
  command: string;
  ok: boolean;
  secs: number;
  /** Error lines from the output (paths relative to the copy), at most 20, secrets masked. */
  errors: string[];
  passed?: number;
  failed?: number;
  /** Failing test names, at most 20. */
  failing?: string[];
}

export interface TryPage {
  path: string;
  /** Opens at both ends. */
  ok: boolean;
  error?: string;
  /** Layout, accessibility and error problems the new version has and the old one didn't, by kind, with one example each. */
  problems: Array<{ kind: string; detail: string }>;
  calls: CallChange[];
  /** The share of pixels that changed in the biggest picture, when it is a visible change. */
  looks?: { ratio: number; view: string };
  slower?: string;
  heavier?: string;
}

export interface TryReport {
  schema: typeof TRY_SCHEMA;
  repo: string;
  name: string;
  /** The commit both copies were made from. */
  commit: string;
  pm: PackageManager;
  target: TryTarget;
  /** Install scripts were run (`--scripts`) or skipped. */
  scripts: boolean;
  install: { before: { ok: boolean; tail: string[] }; after?: { ok: boolean; tail: string[] } };
  checks: Array<{ name: CheckName; before?: CheckOutcome; after?: CheckOutcome }>;
  pages: TryPage[];
  /** breaks: something fails or throws that didn't. changes: it looks, calls or performs differently. same: nothing Assay can see. unclear: the project didn't install before any change, so nothing could be compared. */
  verdict: 'breaks' | 'changes' | 'same' | 'unclear';
  summary: string[];
  notes: string[];
  secs: number;
  createdAt: string;
}

export interface TryOptions {
  repo: string;
  /** A package the project depends on (package.json): `react`, `@scope/name`. */
  package: string;
  /** A version (`19`, `19.1.0`) or a tag (`latest`, `next`). Default latest. */
  version?: string;
  /** The commit the copies are made from. Default HEAD. */
  ref?: string;
  /** Paths to compare. Default: the ones set with allow-run, else `/`. */
  pages?: string[];
  /** Compare the pages in a browser. Default true. */
  browser?: boolean;
  /** Run the project's tests in both copies. Default true. */
  tests?: boolean;
  /** Let install scripts run. Terminal only: the MCP tool has no such argument. */
  scripts?: boolean;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}

export class TryError extends Error {}

const NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// A tag, or a version or its start ("19", "19.1"). No range characters: on Windows the command goes through a shell.
const WANTED = /^([a-z][a-z0-9-]{0,30}|\d+(\.\d+){0,2}(-[0-9a-z.-]{1,40})?)$/i;
const SCRIPT = /^[\w:.-]{1,60}$/;
/** Every argument handed to the package manager is one of these characters, so nothing in it can be read as shell. */
const SAFE = /^[\w@./:=~^+-]+$/;

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; packageManager?: string };

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T; } catch { return undefined; }
}
const has = (dir: string, f: string): boolean => fs.existsSync(path.join(dir, f));

export function detectPm(dir: string): PackageManager {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  if (has(dir, 'bun.lock') || has(dir, 'bun.lockb')) return 'bun';
  if (has(dir, 'package-lock.json') || has(dir, 'npm-shrinkwrap.json')) return 'npm';
  const field = readJson<Pkg>(path.join(dir, 'package.json'))?.packageManager ?? '';
  return /^(pnpm|yarn|bun)@/.test(field) ? (field.split('@')[0] as PackageManager) : 'npm';
}

const hasLock = (dir: string, pm: PackageManager): boolean => (pm === 'npm' ? has(dir, 'package-lock.json') || has(dir, 'npm-shrinkwrap.json') : pm === 'pnpm' ? has(dir, 'pnpm-lock.yaml') : pm === 'yarn' ? has(dir, 'yarn.lock') : has(dir, 'bun.lock') || has(dir, 'bun.lockb'));
const berry = (dir: string): boolean => has(dir, '.yarnrc.yml');

/** The package manager's own words to install what the lockfile says: fixed words only. */
export function installArgs(pm: PackageManager, dir: string, scripts: boolean): string[] {
  const no = scripts ? [] : ['--ignore-scripts'];
  const lock = hasLock(dir, pm);
  if (pm === 'npm') return [lock ? 'ci' : 'install', ...no];
  if (pm === 'pnpm') return ['install', ...(lock ? ['--frozen-lockfile'] : []), ...no];
  if (pm === 'yarn') return berry(dir) ? ['install', ...(lock ? ['--immutable'] : [])] : ['install', ...(lock ? ['--frozen-lockfile'] : []), ...no];
  return ['install', ...(lock ? ['--frozen-lockfile'] : []), ...no];
}

/** The package manager's own words to add one package at one version, after checking both. */
export function addArgs(pm: PackageManager, dir: string, name: string, to: string, dev: boolean, scripts: boolean): string[] {
  if (!NAME.test(name) || !/^[0-9a-z.+-]{1,60}$/i.test(to)) throw new TryError('That package or version can’t be installed.');
  const spec = `${name}@${to}`;
  const no = scripts ? [] : ['--ignore-scripts'];
  if (pm === 'npm') return ['install', spec, ...(dev ? ['--save-dev'] : []), ...no];
  if (pm === 'pnpm') return ['add', spec, ...(dev ? ['-D'] : []), ...no];
  if (pm === 'yarn') return berry(dir) ? ['add', spec, ...(dev ? ['--dev'] : [])] : ['add', spec, ...(dev ? ['--dev'] : []), ...no];
  return ['add', spec, ...(dev ? ['--dev'] : []), ...no];
}

function envFor(pm: PackageManager, dir: string, scripts: boolean): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ASSAY_RUN: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  if (pm === 'yarn' && berry(dir) && !scripts) env.YARN_ENABLE_SCRIPTS = 'false';
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function exec(command: string, args: string[], cwd: string, o: { timeoutSec: number; env: Record<string, string | undefined>; signal?: AbortSignal }): Promise<{ ok: boolean; out: string; secs: number }> {
  const started = Date.now();
  return new Promise(resolve => {
    for (const a of [command, ...args]) if (!SAFE.test(a)) { resolve({ ok: false, out: `Refused to run an argument that isn’t plain: ${a.slice(0, 40)}`, secs: 0 }); return; }
    // Fixed words and checked names, so the shell Windows needs for npm.cmd never sees anything but plain characters.
    const shell = process.platform === 'win32';
    const detached = !shell;
    const child = shell
      ? spawn([command, ...args].join(' '), { cwd, shell: true, env: o.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, env: o.env, windowsHide: true, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (b: Buffer): void => { out = (out + b.toString('utf8')).slice(-200_000); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => killTree(child), Math.max(1, o.timeoutSec) * 1000);
    const stop = (): void => killTree(child);
    if (o.signal?.aborted) stop(); else o.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out: e.message, secs: 0 }); });
    child.on('close', code => { clearTimeout(timer); o.signal?.removeEventListener('abort', stop); resolve({ ok: code === 0, out, secs: Math.round((Date.now() - started) / 100) / 10 }); });
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const tailOf = (out: string, n = 8): string[] => out.replace(ANSI, '').split(/\r?\n/).filter(l => l.trim()).slice(-n).map(l => redactSecrets(l.slice(0, 300)));

/** The lines of a check's output that say what is wrong, with the copy's folder taken off paths. */
export function errorLines(output: string, dir: string): string[] {
  const variants = [dir, dir.split(path.sep).join('/'), dir.replace(/\\/g, '\\\\')];
  const out: string[] = [];
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || !/\berror\b|✖|✗|Failed to compile|Cannot find|is not assignable|has no exported member|Module not found/i.test(line)) continue;
    if (/^npm (ERR!|error) (code|path|command|A complete log|errno)\b/.test(line) || /^(ELIFECYCLE|error Command failed)/.test(line)) continue;
    for (const v of variants) line = line.split(`${v}${path.sep}`).join('').split(`${v}/`).join('').split(v).join('.');
    line = redactSecrets(line.slice(0, 300));
    if (!out.includes(line)) out.push(line);
    if (out.length >= 20) break;
  }
  return out;
}

/** The type check and the build the project has: its own scripts, else tsc when it is a TypeScript project. */
function projectChecks(dir: string, pm: PackageManager): Array<{ name: CheckName; label: string; command: string; args: string[] }> {
  const pkg = readJson<Pkg>(path.join(dir, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  const run = (s: string): string[] => (pm === 'yarn' ? [s] : ['run', s]);
  const out: Array<{ name: CheckName; label: string; command: string; args: string[] }> = [];
  const typeScript = ['typecheck', 'type-check', 'check-types', 'types', 'tsc', 'check', 'lint:types'].find(s => scripts[s] && SCRIPT.test(s));
  if (typeScript) out.push({ name: 'types', label: `Type check (${typeScript})`, command: pm, args: run(typeScript) });
  else if (has(dir, 'tsconfig.json') && 'typescript' in { ...pkg?.dependencies, ...pkg?.devDependencies }) out.push({ name: 'types', label: 'Type check (tsc)', command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] });
  if (scripts.build && SCRIPT.test('build')) out.push({ name: 'build', label: 'Build', command: pm, args: run('build') });
  return out;
}

async function runChecks(dir: string, pm: PackageManager, o: { tests: boolean; testCommand?: string; timeoutSec: number; scripts: boolean; say: (m: string) => void; signal?: AbortSignal; side: string }): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  const env = envFor(pm, dir, o.scripts);
  for (const c of projectChecks(dir, pm)) {
    if (o.signal?.aborted) break;
    o.say(`${c.label} ${o.side}…`);
    const r = await exec(c.command, c.args, dir, { timeoutSec: o.timeoutSec, env, signal: o.signal });
    out.push({ name: c.name, label: c.label, command: [c.command, ...c.args].join(' '), ok: r.ok, secs: r.secs, errors: r.ok ? [] : errorLines(r.out, dir) });
  }
  const cmd = o.tests && !o.signal?.aborted ? detectCommand(dir, o.testCommand) : null;
  if (cmd) {
    o.say(`Tests ${o.side}…`);
    const r = await runCommand(cmd, dir, { timeoutSec: o.timeoutSec, signal: o.signal });
    const ok = r.exit === 0 && !r.timedOut && !r.error;
    out.push({
      name: 'tests', label: `Tests (${cmd.text})`, command: cmd.text, ok, secs: r.secs, errors: ok ? [] : r.failed.length ? [] : errorLines(r.tail, dir),
      ...(r.passedCount !== null ? { passed: r.passedCount } : {}), ...(r.failedCount !== null ? { failed: r.failedCount } : r.failed.length ? { failed: r.failed.length } : {}), failing: r.failed.slice(0, 20)
    });
  }
  return out;
}

/** Newest first: the highest of a list of versions, a pre-release below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { n: number[]; pre: string } => { const [core, ...rest] = v.split('-'); return { n: core.split('.').map(x => Number(x) || 0), pre: rest.join('-') }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** What the package manager says `name@wanted` is: one exact version, from the project's own registry settings. */
async function resolveVersion(dir: string, pm: PackageManager, name: string, wanted: string, o: { env: Record<string, string | undefined>; signal?: AbortSignal }): Promise<string> {
  // `npm view` is how every package manager's registry is asked; npm comes with Node.
  const r = await exec('npm', ['view', `${name}@${wanted}`, 'version', '--json'], dir, { timeoutSec: 60, env: o.env, signal: o.signal });
  if (!r.ok) {
    const why = tailOf(r.out, 4).find(l => /E404|404|not found|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|EAI_AGAIN/i.test(l)) ?? tailOf(r.out, 1)[0] ?? 'no answer';
    throw new TryError(`${name}@${wanted} could not be looked up in the registry (${why}).`);
  }
  if (!r.out.trim()) throw new TryError(`No ${name} version matches "${wanted}".`);
  let v: unknown;
  try { v = JSON.parse(r.out.trim().split(/\r?\n/).filter(l => !/^npm (warn|notice)/i.test(l)).join('\n')); } catch { throw new TryError(`The registry’s answer for ${name}@${wanted} wasn’t a version.`); }
  const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && /^\d+\.\d+\.\d+/.test(x));
  const to = list.sort(compareVersions).at(-1);
  if (!to) throw new TryError(`No ${name} version matches "${wanted}".`);
  return to;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The project's dev server from a folder, each page scanned with the checks `look` makes, and the pictures kept in memory. */
async function scanFolder(browser: Browser, dir: string, where: string, pages: string[], settings: ReturnType<typeof repoSettings>, say: (m: string) => void, signal?: AbortSignal): Promise<{ pages: PageScan[]; shots: Map<string, Buffer> } | { error: string }> {
  return withDir(dir, where, settings, say, async origin => {
    const out: PageScan[] = [];
    const shots = new Map<string, Buffer>();
    for (const p of pages) {
      if (signal?.aborted) break;
      say(`Looking at ${p} ${where}…`);
      const r = await scanPage(browser, origin, p, { probe: false, screens: true, speed: true });
      out.push(r.scan);
      for (const [k, v] of r.shots) shots.set(`${p}|${k}`, v);
    }
    return { pages: out, shots };
  });
}

const KIND_TEXT: Record<string, string> = {
  exception: 'throws an uncaught error', console: 'logs an error', network: 'has a failing request', blank: 'shows nothing', overlap: 'has things that overlap', clip: 'has text that is cut off', contrast: 'has text that is hard to read', hscroll: 'scrolls sideways',
  noalt: 'has an image with no alt text', noname: 'has a control with no accessible name', nolabel: 'has a field with no label', nolang: 'has no language', heading: 'skips heading levels', tabindex: 'has a positive tabindex', dupid: 'has an id used twice'
};
const BREAKS = new Set(['exception', 'network', 'blank']);

/** The verdict and the sentences that say it: what breaks first, then what changes. */
export function summarizeTry(r: Pick<TryReport, 'target' | 'checks' | 'pages' | 'install'>): Pick<TryReport, 'verdict' | 'summary'> {
  const s: string[] = [];
  let breaks = false;
  let changes = false;
  if (!r.install.before.ok) return { verdict: 'unclear', summary: [`The project didn’t install before any change (${r.install.before.tail.at(-1) ?? 'see the output'}), so nothing could be compared.`] };
  if (r.install.after && !r.install.after.ok) return { verdict: 'breaks', summary: [`${r.target.name}@${r.target.to} didn’t install: ${r.install.after.tail.at(-1) ?? 'see the output'}`] };
  for (const c of r.checks) {
    const { before, after } = c;
    if (!after) continue;
    if (c.name === 'tests') {
      const was = before?.failed ?? 0;
      const now = after.failed ?? 0;
      if (now > was) { breaks = true; s.push(`${plural(now - was, 'more test fails', 'more tests fail')} (${after.passed ?? 0} passed, ${now} failed; was ${was} failed)${after.failing?.length ? `: ${after.failing.filter(n => !(before?.failing ?? []).includes(n)).slice(0, 3).join(', ')}` : ''}`); }
      else if (now < was) s.push(`${plural(was - now, 'test')} fewer failing`);
      else if (!after.ok && before?.ok) { breaks = true; s.push('The tests don’t run any more'); }
      continue;
    }
    const word = c.name === 'types' ? 'type check' : 'build';
    if (!after.ok && (before?.ok ?? true)) { breaks = true; s.push(`The ${word} fails: ${after.errors[0] ?? 'see the output'}${after.errors.length > 1 ? ` (and ${plural(after.errors.length - 1, 'more line')})` : ''}`); }
    else if (!after.ok && before && !before.ok) {
      const fresh = after.errors.filter(e => !before.errors.includes(e));
      if (fresh.length) { breaks = true; s.push(`${plural(fresh.length, 'new error')} in the ${word}: ${fresh[0]}`); }
    } else if (after.ok && before && !before.ok) s.push(`The ${word} passes now`);
  }
  for (const p of r.pages) {
    if (!p.ok) { if (p.error) { breaks = true; s.push(`${p.path} no longer opens: ${p.error}`); } continue; }
    const hard = p.problems.filter(x => BREAKS.has(x.kind));
    for (const x of hard) { breaks = true; s.push(`${p.path} ${KIND_TEXT[x.kind] ?? x.kind}: ${x.detail}`); }
    const soft = p.problems.filter(x => !BREAKS.has(x.kind));
    for (const x of soft) { changes = true; s.push(`${p.path} ${KIND_TEXT[x.kind] ?? x.kind}: ${x.detail}`); }
    const worse = p.calls.filter(c => c.tone === 'worse');
    if (worse.length) { breaks = true; s.push(`${p.path}: ${worse.slice(0, 2).map(c => c.text).join('; ')}`); }
    else if (p.calls.some(c => c.tone === 'change')) { changes = true; s.push(`${p.path} behaves differently: ${p.calls.find(c => c.tone === 'change')!.text}`); }
    if (p.looks) { changes = true; s.push(`${p.path} looks different (${(p.looks.ratio * 100).toFixed(1)}% of the ${p.looks.view} picture changed)`); }
    if (p.slower) { changes = true; s.push(`${p.path} is slower: ${p.slower}`); }
    if (p.heavier) { changes = true; s.push(`${p.path} loads more script: ${p.heavier}`); }
  }
  if (!s.length) s.push(`Nothing changed that Assay can see: the checks pass as before${r.pages.length ? `, and ${plural(r.pages.length, 'page')} look and behave the same` : ''}.`);
  return { verdict: breaks ? 'breaks' : changes ? 'changes' : 'same', summary: s };
}

export async function runTry(opts: TryOptions): Promise<TryReport> {
  const t0 = Date.now();
  const repo = repoRoot(opts.repo);
  const settings = repoSettings(repo);
  if (!settings.allow) throw new TryError('Running this repository’s code isn’t allowed yet. A person has to turn it on: assay allow-run');
  if (!settings.network) throw new TryError('Trying an upgrade makes the package manager reach its registry (to look up and install a version), and Assay makes no network call of its own. A person has to turn that on: assay allow-run --network');
  if (!NAME.test(opts.package)) throw new TryError(`"${opts.package.slice(0, 60)}" isn’t a package name.`);
  const wanted = opts.version?.trim() || 'latest';
  if (!WANTED.test(wanted)) throw new TryError('The version is a number like 19 or 19.1.0, or a tag like latest or next.');
  const say = opts.onProgress ?? ((): void => {});
  const scripts = opts.scripts === true;
  const commit = resolveRev(repo, opts.ref ?? 'HEAD');
  const pageList = (opts.pages?.length ? opts.pages : settings.pages?.length ? settings.pages : ['/']).map(checkPagePath).slice(0, 6);
  const notes: string[] = [];
  const timeoutSec = 600;
  const before = exportTree(repo, commit, 'try-before');
  let after: string | undefined;
  try {
    const pkg = readJson<Pkg>(path.join(before, 'package.json'));
    if (!pkg) throw new TryError('This project has no package.json at its top, so there is no package to upgrade. (Only npm, pnpm, yarn and bun projects are supported.)');
    const dev = !!pkg.devDependencies?.[opts.package];
    if (!dev && !pkg.dependencies?.[opts.package]) throw new TryError(`${opts.package} isn’t one of the project’s dependencies (the top package.json lists ${Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length} ).`);
    const pm = detectPm(before);
    const env = envFor(pm, before, scripts);
    // 1. the project as it is: what the lockfile says
    say(`Installing the project as it is (${pm} ${installArgs(pm, before, scripts)[0]})…`);
    const base = await exec(pm, installArgs(pm, before, scripts), before, { timeoutSec: 900, env, signal: opts.signal });
    const report: TryReport = {
      schema: TRY_SCHEMA, repo, name: repoName(repo), commit, pm, target: { name: opts.package, to: wanted, dev, major: false }, scripts, install: { before: { ok: base.ok, tail: tailOf(base.out) } },
      checks: [], pages: [], verdict: 'unclear', summary: [], notes, secs: 0, createdAt: new Date().toISOString()
    };
    const finish = (): TryReport => { Object.assign(report, summarizeTry(report)); report.secs = Math.round((Date.now() - t0) / 1000); return report; };
    if (!base.ok) return finish();
    const from = readJson<{ version?: string }>(path.join(before, 'node_modules', ...opts.package.split('/'), 'package.json'))?.version;
    // 2. the version asked for, from the registry through the package manager
    say(`Looking up ${opts.package}@${wanted}…`);
    const to = await resolveVersion(before, pm, opts.package, wanted, { env, signal: opts.signal });
    if (from && from === to) throw new TryError(`${opts.package} ${to} is already what the lockfile installs.`);
    report.target = { name: opts.package, from, to, dev, major: !!from && Number(from.split('.')[0]) !== Number(to.split('.')[0]) };
    // 3. the second copy: the same install, then the one package at the new version
    say(`Copying the install, then adding ${opts.package}@${to}…`);
    after = exportTree(repo, commit, 'try-after');
    fs.cpSync(before, after, { recursive: true, force: true, verbatimSymlinks: true });
    const add = await exec(pm, addArgs(pm, after, opts.package, to, dev, scripts), after, { timeoutSec: 900, env, signal: opts.signal });
    report.install.after = { ok: add.ok, tail: tailOf(add.out) };
    if (!add.ok) return finish();
    if (!scripts) notes.push('Install scripts were not run (a package that needs its script to build, such as one that downloads a binary, may fail the same way in both copies). --scripts runs them.');
    // 4. the project's own checks, in both
    const runOpts = { tests: opts.tests !== false, testCommand: settings.command, timeoutSec, scripts, say, signal: opts.signal };
    const b = await runChecks(before, pm, { ...runOpts, side: 'before' });
    const a = await runChecks(after, pm, { ...runOpts, side: 'after' });
    for (const name of ['types', 'build', 'tests'] as CheckName[]) {
      const x = b.find(c => c.name === name), y = a.find(c => c.name === name);
      if (x || y) report.checks.push({ name, before: x, after: y });
    }
    if (!report.checks.length) notes.push('No type check, build or test command was found, so only the pages (if any) were compared.');
    for (const c of report.checks) if (c.before && !c.before.ok && c.name === 'tests') notes.push('The tests already fail before the change, so only tests that fail now and didn’t then count.');
    // 5. the pages, on both dev servers
    if (opts.browser !== false && !opts.signal?.aborted) {
      const exe = findBrowser(settings.browser);
      if (!exe) notes.push('No Chromium-based browser was found, so the pages were not compared. Install one, or point at it: assay allow-run --browser <path>');
      else {
        const browser = await Browser.launch(exe);
        try {
          const one = await scanFolder(browser, before, 'before the upgrade', pageList, settings, say, opts.signal);
          const two = 'error' in one ? one : await scanFolder(browser, after, `with ${opts.package}@${to}`, pageList, settings, say, opts.signal);
          if ('error' in one) notes.push(`The pages were not compared: ${one.error.split('\n')[0].slice(0, 200)}`);
          else if ('error' in two) report.pages = pageList.map(p => ({ path: p, ok: false, error: `the dev server didn’t start with the new version (${two.error.split('\n')[0].slice(0, 160)})`, problems: [], calls: [] }));
          else {
            for (const hp of two.pages) {
              const bp = one.pages.find(x => x.path === hp.path);
              const page: TryPage = { path: hp.path, ok: hp.ok, problems: [], calls: [] };
              report.pages.push(page);
              if (!bp || !bp.ok) continue;
              if (!hp.ok) { page.error = hp.error ?? 'error'; continue; }
              const keys = new Set(bp.problems.map(p => `${p.combo}|${p.key}`));
              const seen = new Set<string>();
              for (const p of hp.problems) if (!keys.has(`${p.combo}|${p.key}`) && !seen.has(p.kind)) { seen.add(p.kind); page.problems.push({ kind: p.kind, detail: p.detail }); }
              for (const [kind, now, was] of [['exception', hp.exceptions, bp.exceptions], ['console', hp.consoleErrors, bp.consoleErrors], ['network', hp.failed, bp.failed]] as const) {
                const fresh = now.filter(m => !was.includes(m));
                if (fresh.length && !seen.has(kind)) { seen.add(kind); page.problems.push({ kind, detail: fresh[0].slice(0, 200) }); }
              }
              page.calls = compareCalls(bp, hp);
              const hm = medianPerf(hp.perf), bm = medianPerf(bp.perf);
              if (hm && bm) {
                page.slower = slowerThan(hp.perf, bp.perf);
                page.heavier = heavierThan(hm, bm);
              }
              let best: { ratio: number; view: string } | undefined;
              for (const [k, shot] of two.shots) {
                if (!k.startsWith(`${hp.path}|`)) continue;
                const was = one.shots.get(k);
                if (!was) continue;
                const d = await diffShot(browser, was, shot);
                if (d && d.ratio >= SHOT_DIFFERENT && (!best || d.ratio > best.ratio)) best = { ratio: d.ratio, view: k.slice(hp.path.length + 1).split('|').slice(0, 2).join(', ') };
              }
              if (best) page.looks = best;
            }
          }
        } finally { await browser.close(); }
      }
    }
    return finish();
  } finally {
    removeTree(before);
    if (after) removeTree(after);
  }
}

/** True when the upgrade breaks something (for --fail-on). */
export function tryFails(r: TryReport, on: 'breaks' | 'changes'): boolean {
  return r.verdict === 'breaks' || (on === 'changes' && r.verdict === 'changes');
}

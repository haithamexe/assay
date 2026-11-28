import { git } from '../git.js';
import type { Check, CommitCtx, RawFinding } from './types.js';

interface Dep { name: string; spec: string }
type Eco = 'npm' | 'pypi' | 'crates' | 'go';

const POPULAR: Record<Eco, string[]> = {
  npm: ['react', 'react-dom', 'lodash', 'express', 'axios', 'moment', 'chalk', 'commander', 'debug', 'dotenv', 'typescript', 'webpack', 'vite', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'next', 'vue', 'uuid', 'zod', 'request', 'async', 'bluebird', 'underscore', 'jquery', 'tailwindcss', 'postcss', 'rxjs', 'redux', 'socket.io', 'mongoose', 'sequelize', 'passport', 'jsonwebtoken', 'bcrypt', 'cors', 'body-parser', 'cross-env', 'rimraf', 'glob', 'yargs', 'inquirer', 'node-fetch', 'dayjs', 'classnames', 'prop-types', 'styled-components', 'angular', 'svelte', 'nodemon', 'ts-node', 'babel-core', 'colors'],
  pypi: ['requests', 'numpy', 'pandas', 'django', 'flask', 'fastapi', 'pydantic', 'sqlalchemy', 'pytest', 'urllib3', 'boto3', 'scipy', 'matplotlib', 'pillow', 'cryptography', 'jinja2', 'click', 'beautifulsoup4', 'lxml', 'pyyaml', 'setuptools', 'wheel', 'certifi', 'idna', 'six', 'attrs', 'aiohttp', 'uvicorn', 'gunicorn', 'celery', 'redis', 'psycopg2', 'scikit-learn', 'tensorflow', 'torch', 'httpx', 'python-dateutil', 'colorama'],
  crates: ['serde', 'serde_json', 'tokio', 'rand', 'clap', 'regex', 'reqwest', 'anyhow', 'thiserror', 'log', 'chrono', 'hyper', 'futures', 'itertools', 'lazy_static', 'once_cell', 'syn', 'quote', 'tracing', 'bytes'],
  go: []
};

function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** A name one or two letters from another package you use, or from a very popular one: the shape of a look-alike. */
export function nearestName(name: string, others: string[], popular: string[]): { other: string; d: number } | null {
  if (name.length < 4) return null;
  const max = name.length >= 8 ? 2 : 1;
  let best: { other: string; d: number } | null = null;
  for (const o of [...others, ...popular]) {
    if (o === name) return null;
    const d = lev(name, o, max);
    if (d >= 1 && d <= max && (!best || d < best.d)) best = { other: o, d };
  }
  return popular.includes(name) ? null : best;
}

function parsePackageJson(text: string | null): { deps: Map<string, Dep>; scripts: Record<string, string> } {
  const deps = new Map<string, Dep>();
  let scripts: Record<string, string> = {};
  if (!text) return { deps, scripts };
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const s of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const o = j[s];
      if (o && typeof o === 'object') for (const [name, spec] of Object.entries(o as Record<string, unknown>)) if (typeof spec === 'string') deps.set(name, { name, spec });
    }
    if (j.scripts && typeof j.scripts === 'object') scripts = j.scripts as Record<string, string>;
  } catch { /* a manifest that isn't JSON yet isn't ours to judge */ }
  return { deps, scripts };
}
function parseRequirements(text: string | null): Map<string, Dep> {
  const deps = new Map<string, Dep>();
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('-')) {
      continue;
    }
    const url = /^(?:git\+|https?:)/.test(line);
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (m) deps.set(m[1].toLowerCase().replace(/_/g, '-'), { name: m[1].toLowerCase().replace(/_/g, '-'), spec: url ? line : m[2] });
  }
  return deps;
}
function parseGoMod(text: string | null): Map<string, Dep> {
  const deps = new Map<string, Dep>();
  let block = false;
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.split('//')[0].trim();
    if (/^require\s*\($/.test(line)) { block = true; continue; }
    if (block && line === ')') { block = false; continue; }
    const m = block ? /^(\S+)\s+(v\S+)/.exec(line) : /^require\s+(\S+)\s+(v\S+)/.exec(line);
    if (m) deps.set(m[1], { name: m[1], spec: m[2] });
  }
  return deps;
}
function parseCargo(text: string | null): Map<string, Dep> {
  const deps = new Map<string, Dep>();
  let on = false;
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { on = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(sec[1]); continue; }
    const m = on ? /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line) : null;
    if (m) deps.set(m[1], { name: m[1], spec: m[2] });
  }
  return deps;
}

function ecoOf(file: string): Eco | null {
  const base = file.split('/').pop() || '';
  if (base === 'package.json') return 'npm';
  if (/^requirements.*\.txt$/.test(base)) return 'pypi';
  if (base === 'Cargo.toml') return 'crates';
  if (base === 'go.mod') return 'go';
  return null;
}

const UNPINNED = /^(?:\*|latest|x|git\+|git:|github:|gitlab:|bitbucket:|https?:)/;
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

function lineOf(text: string | null, re: RegExp): { n: number; text: string } {
  const lines = (text ?? '').split('\n');
  const i = lines.findIndex(l => re.test(l));
  return { n: i === -1 ? 1 : i + 1, text: i === -1 ? '' : lines[i] };
}
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The packages this repository holds itself, by name: next to one of them a "*" is the workspace link, not an open version range. Read only when a "*" turns up. */
const workspaceCache = new Map<string, Set<string>>();
function workspaceNames(ctx: CommitCtx): Set<string> {
  const key = `${ctx.repo}\0${ctx.commit}`;
  const known = workspaceCache.get(key);
  if (known) return known;
  const names = new Set<string>();
  const manifests = git(ctx.repo, ['ls-tree', '-r', '--name-only', ctx.commit], { allowFail: true, maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(p => /(?:^|\/)package\.json$/.test(p) && !/(?:^|\/)node_modules\//.test(p)).slice(0, 300);
  for (const p of manifests) {
    try {
      const n = (JSON.parse(git(ctx.repo, ['show', `${ctx.commit}:${p}`], { allowFail: true }) || '{}') as { name?: unknown }).name;
      if (typeof n === 'string') names.add(n);
    } catch { /* not JSON: not a package we can name */ }
  }
  if (workspaceCache.size > 50) workspaceCache.clear();
  workspaceCache.set(key, names);
  return names;
}

function analyseManifest(ctx: CommitCtx, file: string, eco: Eco): RawFinding[] {
  const now = ctx.read(file, 'commit');
  const before = ctx.read(file, 'parent');
  const out: RawFinding[] = [];
  let a: Map<string, Dep>, b: Map<string, Dep>;
  let sNow: Record<string, string> = {}, sBefore: Record<string, string> = {};
  if (eco === 'npm') { const x = parsePackageJson(now), y = parsePackageJson(before); a = x.deps; b = y.deps; sNow = x.scripts; sBefore = y.scripts; }
  else { const f = eco === 'pypi' ? parseRequirements : eco === 'crates' ? parseCargo : parseGoMod; a = f(now); b = f(before); }
  const names = [...a.keys()];
  for (const [name, dep] of a) {
    const old = b.get(name);
    const isNew = !old;
    const unpinned = UNPINNED.test(dep.spec) && (isNew || old.spec !== dep.spec) && !(eco === 'npm' && dep.spec === '*' && workspaceNames(ctx).has(name));
    if (!isNew && !unpinned) continue;
    const loc = lineOf(now, eco === 'npm' ? new RegExp(`"${esc(name)}"\\s*:`) : eco === 'pypi' ? new RegExp(`^\\s*${esc(name)}\\b`, 'i') : new RegExp(`^\\s*(?:require\\s+)?${esc(name)}\\b`));
    const ev: RawFinding['evidence'] = [{ kind: 'diff', source: isNew ? 'diff:new-dependency' : 'diff:changed-dependency', what: isNew ? `${name} ${dep.spec} is new in ${file}.` : `${name} changed from ${old!.spec} to ${dep.spec} in ${file}.` }];
    const inferred: string[] = [];
    let severity: RawFinding['severity'] = 'low';
    if (isNew) {
      const near = nearestName(name, names.filter(n => n !== name), POPULAR[eco]);
      if (near) { ev.push({ kind: 'rule', source: 'rule:name-distance', what: `The name is ${near.d} letter${near.d > 1 ? 's' : ''} from "${near.other}".` }); severity = 'medium'; inferred.push(`It may be a look-alike of ${near.other}. Look-alike packages are a known way to ship malware.`); }
    }
    if (unpinned) { ev.push({ kind: 'rule', source: 'rule:unpinned-spec', what: `Version "${dep.spec}" isn't a fixed registry version.` }); severity = 'medium'; inferred.push('Whatever is behind that address can change without a commit here.'); }
    // In the first commit, or in a manifest that is itself new (a new package in the repository), every dependency is "new": that is the baseline, not a change.
    // Only a look-alike or an unpinned one is worth saying.
    if ((ctx.parent === null || before === null) && isNew && ev.length === 1) continue;
    if (!inferred.length) inferred.push('A new dependency is code you don’t control that now runs in your build or app.');
    out.push({
      check: 'dependencies', key: `${isNew ? 'new' : 'chg'}:${file}:${name}`, title: isNew ? `New dependency: ${name}` : `Dependency no longer pinned: ${name}`, lens: 'Supply chain', severity,
      file, line: loc.n, side: 'added', text: loc.text || `${name} ${dep.spec}`, evidence: ev,
      observed: [ev[0].what, ...ev.slice(1).map(e => e.what)], inferred, ref: 'Supply chain'
    });
  }
  if (eco === 'npm') {
    for (const hook of INSTALL_HOOKS) {
      if (sNow[hook] && sNow[hook] !== sBefore[hook]) {
        const loc = lineOf(now, new RegExp(`"${hook}"\\s*:`));
        out.push({
          check: 'dependencies', key: `hook:${file}:${hook}`, title: `An install script was added: ${hook}`, lens: 'Supply chain', severity: 'medium', file, line: loc.n, side: 'added', text: loc.text || `${hook}: ${sNow[hook]}`,
          evidence: [{ kind: 'rule', source: 'rule:install-script', what: `${hook} now runs "${sNow[hook].slice(0, 80)}" on every install.` }, { kind: 'diff', source: 'diff:manifest-change', what: `${file} changed in this commit.` }],
          observed: [`${file} gained a ${hook} script: ${sNow[hook].slice(0, 80)}.`], inferred: ['Install scripts run on every machine that installs the project, before anyone reads the code.'], ref: 'Supply chain'
        });
      }
    }
  }
  return out;
}

export const dependencies: Check = ctx => {
  const out: RawFinding[] = [];
  for (const f of ctx.files) {
    if (f.binary || f.status === 'deleted') continue;
    const eco = ecoOf(f.path);
    if (eco) out.push(...analyseManifest(ctx, f.path, eco));
  }
  return out;
};

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assayPath, sha } from '../config.js';
import type { FileDiff } from '../diff.js';
import { killTree } from './runner.js';

/**
 * Function-level before and after (D53): behaviour of code, not pages. For a function a range changed, the same inputs are given to it at the
 * base and at the head, in clean checkouts, and where the answers differ that is shown as it happened: `discount(200, 10)` returned 180 and now
 * returns 2000. Not a verdict (the change may be what was meant), so it is medium at most and never blocks.
 *
 * JavaScript and Python only (what runs with nothing installed). A function is only compared if it is exported, existed at the base, takes at most
 * six simple parameters, and doesn't look like it reads a clock, a file, the network or a random number: a difference there is noise.
 */
export type Lang = 'js' | 'py';
export interface Fn { file: string; name: string; params: string[]; lang: Lang; line: number; /** The first line of the function this range added or changed: where a finding hangs. */ anchor: number; async: boolean }
export interface Skipped { file: string; name: string; why: string }

const JS_FILE = /\.(?:js|mjs|cjs)$/i;
const PY_FILE = /\.py$/i;
export const langOf = (p: string): Lang | null => (JS_FILE.test(p) ? 'js' : PY_FILE.test(p) ? 'py' : null);

const JS_IMPURE = /\b(?:fs|readFile\w*|writeFile\w*|fetch|axios|XMLHttpRequest|child_process|spawn\w*|exec\w*|process\.(?:exit|env|argv|stdin|stdout|stderr|cwd|hrtime)|require|import|setTimeout|setInterval|Math\.random|Date\.now|new Date\(\)|performance\.now|crypto\.random\w*|randomUUID|WebSocket|console\.\w+|localStorage|document|window)\b/;
const PY_IMPURE = /\b(?:open|os\.\w+|subprocess|requests|urllib|socket|input|print|random\.\w+|time\.\w+|datetime\.(?:now|today|utcnow)|sys\.\w+|shutil|pathlib|uuid\.uuid\d|secrets)\b/;

const rangeOf = (lines: string[], start: number, lang: Lang): number => {
  if (lang === 'py') {
    let end = start;
    for (let i = start + 1; i < lines.length; i++) { if (lines[i].trim() === '' || /^\s/.test(lines[i])) { if (lines[i].trim() !== '') end = i; continue; } break; }
    return end;
  }
  let depth = 0, seen = false;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    for (const ch of code) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
    if (seen && depth <= 0) return i;
    if (!seen && /=>\s*[^{\s]/.test(code) && /[;,]\s*$/.test(code)) return i;
    if (!seen && /=>\s*[^{\s]/.test(code)) return i;
  }
  return Math.min(lines.length - 1, start + 40);
};

const paramNames = (raw: string, lang: Lang): string[] | null => {
  const out: string[] = [];
  let depth = 0, cur = '';
  const parts: string[] = [];
  for (const ch of raw) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (t.startsWith('...') || t.startsWith('*') || /^[{\[]/.test(t)) return null;
    const m = lang === 'py' ? /^([A-Za-z_]\w*)/.exec(t) : /^([A-Za-z_$][\w$]*)/.exec(t);
    if (!m) return null;
    if (lang === 'py' && m[1] === 'self') return null;
    out.push(m[1]);
  }
  return out;
};

interface Found { name: string; params: string[] | null; line: number; end: number; exported: boolean; async: boolean; body: string }

/** The named functions of one file's text. A parser would be better; these are the few shapes people write, and a shape that isn't here is skipped, not guessed at. */
export function functionsIn(text: string, lang: Lang): Found[] {
  const lines = text.split('\n');
  const out: Found[] = [];
  lines.forEach((ln, i) => {
    let m: RegExpExecArray | null;
    if (lang === 'py') {
      if ((m = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(ln))) {
        const end = rangeOf(lines, i, 'py');
        out.push({ name: m[2], params: paramNames(m[3], 'py'), line: i + 1, end: end + 1, exported: !m[2].startsWith('_'), async: !!m[1], body: lines.slice(i + 1, end + 1).join('\n') });
      }
      return;
    }
    const make = (name: string, raw: string, exported: boolean, isAsync: boolean): void => {
      const end = rangeOf(lines, i, 'js');
      out.push({ name, params: paramNames(raw, 'js'), line: i + 1, end: end + 1, exported, async: isAsync, body: lines.slice(i, end + 1).join('\n').replace(/^[^{=]*[{=>]+/, '') });
    };
    if ((m = /^(export\s+(?:default\s+)?)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(ln))) make(m[3], m[4], !!m[1], !!m[2]);
    else if ((m = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/.exec(ln))) make(m[2], m[4], !!m[1], !!m[3]);
    else if ((m = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(ln))) make(m[2], m[4], !!m[1], !!m[3]);
    else if ((m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/.exec(ln))) make(m[1], m[3], true, !!m[2]);
  });
  // `module.exports = { a, b }` / `export { a, b }` make named functions exported too
  const named = new Set<string>();
  for (const m of text.matchAll(/(?:module\.exports\s*=\s*|export\s*)\{([^}]*)\}/g)) for (const n of m[1].split(',')) named.add(n.split(/\s+as\s+/)[0].trim());
  for (const f of out) if (named.has(f.name)) f.exported = true;
  return out;
}

/** Which functions of a changed file are worth comparing, and why the others are not. `base` is the file as it was (null if it didn't exist). */
export function candidates(file: FileDiff, head: string, base: string | null): { fns: Fn[]; skipped: Skipped[] } {
  const lang = langOf(file.path);
  if (!lang || file.binary || file.status === 'deleted') return { fns: [], skipped: [] };
  const added = new Set(file.hunks.flatMap(h => h.lines).filter(l => l.t === '+' && l.n !== null).map(l => l.n as number));
  const before = base === null ? new Set<string>() : new Set(functionsIn(base, lang).map(f => f.name));
  const fns: Fn[] = [];
  const skipped: Skipped[] = [];
  for (const f of functionsIn(head, lang)) {
    let anchor = 0;
    for (let n = f.line; n <= f.end; n++) if (added.has(n)) { anchor = n; break; }
    if (!anchor) continue;
    const skip = (why: string): void => { skipped.push({ file: file.path, name: f.name, why }); };
    if (!f.exported) skip('it is not exported');
    else if (!before.has(f.name)) skip('it is new: there is nothing to compare it with');
    else if (f.params === null) skip('its parameters are not plain names (destructured or variadic)');
    else if (f.params.length > 6) skip('it takes more than six parameters');
    else if (f.async && lang === 'py') skip('it is async');
    else if ((lang === 'js' ? JS_IMPURE : PY_IMPURE).test(f.body)) skip(`it ${(lang === 'js' ? JS_IMPURE : PY_IMPURE).exec(f.body)?.[0] ? `uses ${(lang === 'js' ? JS_IMPURE : PY_IMPURE).exec(f.body)![0]}` : 'looks impure'}, so a difference could be a clock, a file or a random number`);
    else fns.push({ file: file.path, name: f.name, params: f.params, lang, line: f.line, anchor, async: f.async });
  }
  return { fns, skipped };
}

const HINTS: Array<[RegExp, unknown[]]> = [
  [/^(?:is\w*|has\w*|can\w*|should\w*|flag|enabled|on|ok|verbose|force|strict)$/i, [true, false]],
  [/^(?:items|list|arr|array|xs|values|rows|lines|words|parts|names|ids|nums|numbers|stack|queue|tags)$/i, [[], [1], [3, 1, 2], ['a', 'b']]],
  [/^(?:obj|o|opts|options|config|cfg|data|payload|user|item|order|cart|params|props|ctx|settings|row|record)$/i, [{}, { a: 1 }, { id: 1, name: 'x', price: 10, qty: 2 }]],
  [/^(?:s|str|string|text|name|label|title|word|msg|message|path|url|slug|id|key|code|email|query|prefix|suffix|sep|char|ch)$/i, ['', 'a', 'Hello World', '  padded  ', 'ÄÖ ا']],
  [/^(?:n|i|j|k|x|y|a|b|c|num|number|count|total|qty|quantity|amount|price|age|index|idx|len|length|size|limit|offset|pct|percent|rate|score|points|days|min|max|step|width|height|\w*(?:count|total|price|amount|rate|pct|size|index)\w*)$/i, [0, 1, -1, 2, 10, 18, 100, 2.5]]
];
const ANY: unknown[] = [0, 1, -1, 'a', '', true, false, null, [], {}];

/** Inputs for a function, by the names of its parameters: the same for the base and the head. At most 40, the same every time. */
export function inputsFor(fn: Pick<Fn, 'name' | 'params'>, max = 40): unknown[][] {
  const lists = fn.params.map(p => HINTS.find(([re]) => re.test(p))?.[1] ?? ANY);
  let grid: unknown[][] = lists.length ? [[]] : [[]];
  for (const l of lists) grid = grid.flatMap(g => l.map(v => [...g, v]));
  if (grid.length <= max) return grid;
  let seed = parseInt(sha(fn.name, 8), 16) || 7;
  const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const rest = grid.slice(1);
  for (let i = rest.length - 1; i > 0; i--) { const j = next() % (i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return [grid[0], ...rest.slice(0, max - 1)];
}

const JS_DRIVER = `import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [file, name, inputsFile] = process.argv.slice(2);
const out = o => process.stdout.write('\\nASSAY-BEHAVE:' + JSON.stringify(o) + '\\n');
const show = v => { try { const s = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x === undefined ? '__undefined__' : typeof x === 'function' ? '__function__' : x)); return s === undefined ? '__undefined__' : s.length > 300 ? s.slice(0, 300) + '…' : s; } catch { return '__unserialisable__'; } };
let mod;
try { mod = await import(pathToFileURL(file).href); } catch (e) { out({ loadError: String((e && e.message) || e).slice(0, 200) }); process.exit(0); }
const fn = mod[name] ?? (mod.default && mod.default[name]);
if (typeof fn !== 'function') { out({ loadError: 'not an exported function' }); process.exit(0); }
const inputs = JSON.parse(fs.readFileSync(inputsFile, 'utf8'));
const results = [];
for (const args of inputs) {
  try { let r = fn(...structuredClone(args)); if (r && typeof r.then === 'function') r = await r; results.push({ ok: show(r) }); }
  catch (e) { results.push({ err: String((e && e.name) || 'Error') }); }
}
out({ results });
process.exit(0);
`;
const PY_DRIVER = `import importlib.util, json, sys, copy
file, name, inputs_file = sys.argv[1:4]
def out(o):
    sys.stdout.write("\\nASSAY-BEHAVE:" + json.dumps(o) + "\\n")
    sys.stdout.flush()
def show(v):
    try:
        s = json.dumps(v, default=repr, sort_keys=True)
        return s if len(s) <= 300 else s[:300] + "…"
    except Exception:
        return "__unserialisable__"
try:
    spec = importlib.util.spec_from_file_location("assay_target", file)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, __import__("os").path.dirname(file))
    spec.loader.exec_module(mod)
except BaseException as e:
    out({"loadError": str(e)[:200]})
    sys.exit(0)
fn = getattr(mod, name, None)
if not callable(fn):
    out({"loadError": "not an exported function"})
    sys.exit(0)
results = []
for args in json.load(open(inputs_file)):
    try:
        results.append({"ok": show(fn(*copy.deepcopy(args)))})
    except BaseException as e:
        results.append({"err": type(e).__name__})
out({"results": results})
`;

const driversDir = (): string => assayPath('work', 'drivers');
function driverFile(lang: Lang): string {
  const f = path.join(driversDir(), lang === 'js' ? 'behave.mjs' : 'behave.py');
  const text = lang === 'js' ? JS_DRIVER : PY_DRIVER;
  try { if (fs.readFileSync(f, 'utf8') === text) return f; } catch { /* write it */ }
  fs.mkdirSync(driversDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, text, { mode: 0o600 });
  return f;
}

export type Answer = { ok: string } | { err: string };
export interface Ran { answers: Answer[] | null; why?: string }

/** Runs the function on the inputs inside a checkout. The driver is Assay's own, kept outside the checkout; it prints one tagged line. */
export function runFunction(fn: Pick<Fn, 'file' | 'name' | 'lang'>, dir: string, inputs: unknown[][], o: { timeoutSec: number; signal?: AbortSignal; python?: string }): Promise<Ran> {
  return new Promise(resolve => {
    const inputsFile = path.join(driversDir(), `in-${sha(JSON.stringify(inputs) + fn.name + dir, 10)}.json`);
    try { fs.mkdirSync(driversDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(inputsFile, JSON.stringify(inputs), { mode: 0o600 }); } catch (e) { resolve({ answers: null, why: (e as Error).message }); return; }
    const driver = driverFile(fn.lang);
    const target = path.join(dir, ...fn.file.split('/'));
    const cmd = fn.lang === 'js' ? process.execPath : (o.python ?? (process.platform === 'win32' ? 'python' : 'python3'));
    const env: Record<string, string | undefined> = { ...process.env, CI: '1', NO_COLOR: '1', ASSAY_RUN: '1', PYTHONDONTWRITEBYTECODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    let child;
    try { child = spawn(cmd, [driver, target, fn.name, inputsFile], { cwd: dir, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ answers: null, why: (e as Error).message }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (b: Buffer): void => { if (size < 2_000_000) { chunks.push(b); size += b.length; } };
    child.stdout?.on('data', take);
    child.stderr?.on('data', () => { /* the project's own noise */ });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(1, o.timeoutSec) * 1000);
    const stop = (): void => killTree(child);
    if (o.signal?.aborted) stop(); else o.signal?.addEventListener('abort', stop, { once: true });
    let spawnError: string | undefined;
    child.on('error', e => { spawnError = e.message; });
    child.on('close', () => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', stop);
      try { fs.rmSync(inputsFile, { force: true }); } catch { /* left */ }
      if (spawnError) return resolve({ answers: null, why: spawnError });
      if (timedOut) return resolve({ answers: null, why: 'it did not finish in time' });
      const line = Buffer.concat(chunks).toString('utf8').split('\n').find(l => l.startsWith('ASSAY-BEHAVE:'));
      if (!line) return resolve({ answers: null, why: 'the module printed nothing back (it may end the process when it loads)' });
      try {
        const r = JSON.parse(line.slice('ASSAY-BEHAVE:'.length)) as { loadError?: string; results?: Answer[] };
        resolve(r.results ? { answers: r.results } : { answers: null, why: `it could not be loaded: ${r.loadError ?? 'unknown'}` });
      } catch { resolve({ answers: null, why: 'its answer could not be read' }); }
    });
  });
}

export interface Difference { input: unknown[]; before: string; after: string }
const show = (a: Answer): string => ('ok' in a ? a.ok : `throws ${a.err}`);

/** Where the two versions answered differently for the same input. */
export function differences(inputs: unknown[][], before: Answer[], after: Answer[]): Difference[] {
  const out: Difference[] = [];
  inputs.forEach((input, i) => { const a = before[i], b = after[i]; if (a && b && show(a) !== show(b)) out.push({ input, before: show(a), after: show(b) }); });
  return out;
}

const lit = (v: unknown): string => { try { return JSON.stringify(v); } catch { return String(v); } };
export const callText = (name: string, input: unknown[]): string => `${name}(${input.map(lit).join(', ')})`;

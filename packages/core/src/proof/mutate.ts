import fs from 'node:fs';
import path from 'node:path';
import { sha } from '../config.js';
import type { FileDiff, Hunk } from '../diff.js';
import { isSourcePath, languageOf } from '../lang.js';

/** One small deliberate change to one line. If the tests still pass, they didn't notice it. */
export interface Mutant {
  id: string;
  file: string;
  line: number;
  op: string;
  /** The whole line as it was, and where in it the change goes (kept in memory only, never stored: a line may hold a secret). */
  original: string;
  col: number;
  len: number;
  to: string;
}

/**
 * Language-aware mutation (D56). Which operators exist, and which words are code, depends on the language: `===` is only JavaScript, `and` and
 * `not` are Python's, `if !ok {` has no parentheses in Go and Rust, a `'` opens a string in Python and Ruby but is a lifetime in Rust, a `#` starts
 * a comment in Python and an attribute in Rust. Mutating the wrong thing wastes a whole test run on a change that doesn't compile ("invalid") or
 * lands in a comment, so each file is read with its own language's comments, strings and operators before a mutant is chosen.
 */
type Family = 'js' | 'cstyle' | 'php' | 'py' | 'rb' | 'lua' | 'ex' | 'sh' | 'none';

const FAMILY: Record<string, Family> = {
  JavaScript: 'js', TypeScript: 'js', Vue: 'js', Svelte: 'js',
  Java: 'cstyle', Kotlin: 'cstyle', 'C#': 'cstyle', Go: 'cstyle', Rust: 'cstyle', Swift: 'cstyle', C: 'cstyle', 'C++': 'cstyle', Scala: 'cstyle', Dart: 'cstyle',
  PHP: 'php', Python: 'py', Ruby: 'rb', Lua: 'lua', Elixir: 'ex', Shell: 'sh', SQL: 'none'
};
export const familyOf = (file: string): Family => FAMILY[languageOf(file) ?? ''] ?? 'js';

const LINE_COMMENT: Record<Family, string[]> = { js: ['//'], cstyle: ['//'], php: ['//', '#'], py: ['#'], rb: ['#'], lua: ['--'], ex: ['#'], sh: ['#'], none: [] };
const HAS_BLOCK = new Set<Family>(['js', 'cstyle', 'php']);

/** State carried from one line to the next: inside /* … *\/, inside a Python triple-quoted string, inside a backtick string. */
interface Lex { block: boolean; triple: string | null; tick: boolean }
const fresh = (): Lex => ({ block: false, triple: null, tick: false });

/** The line with comments and the inside of strings blanked out, same length, so a match can't land in text. Also returns the state for the next line. */
function lexLine(text: string, fam: Family, from: Lex): { code: string; st: Lex } {
  const st: Lex = { ...from };
  const out: string[] = [];
  const blank = (n: number): void => { for (let k = 0; k < n; k++) out.push(' '); };
  let i = 0;
  while (i < text.length) {
    if (st.block) { const end = text.indexOf('*/', i); if (end < 0) { blank(text.length - i); i = text.length; } else { blank(end + 2 - i); i = end + 2; st.block = false; } continue; }
    if (st.triple) { const end = text.indexOf(st.triple, i); if (end < 0) { blank(text.length - i); i = text.length; } else { blank(end + 3 - i); i = end + 3; st.triple = null; } continue; }
    if (st.tick) {
      let j = i;
      while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) { blank(text.length - i); i = text.length; } else { blank(j - i); out.push('`'); i = j + 1; st.tick = false; }
      continue;
    }
    const c = text[i];
    const rest = text.slice(i);
    if (LINE_COMMENT[fam].some(m => rest.startsWith(m)) && !(fam === 'cstyle' && rest.startsWith('#'))) { blank(text.length - i); break; }
    if (HAS_BLOCK.has(fam) && rest.startsWith('/*')) { out.push(' ', ' '); i += 2; st.block = true; continue; }
    if (fam === 'py' && (rest.startsWith('"""') || rest.startsWith("'''"))) { out.push(c, c, c); i += 3; st.triple = rest.slice(0, 3); continue; }
    if ((fam === 'js' || fam === 'cstyle') && c === '`') { out.push(c); i++; st.tick = true; continue; }
    if (c === '"' || c === "'") {
      // In Rust (and Swift) a ' is also a lifetime or a label: it is a string only if it closes as a character literal.
      if (c === "'" && fam === 'cstyle' && !/^'(?:\\.[^']*|[^'\\])'/.test(rest)) { out.push(c); i++; continue; }
      out.push(c); i++;
      while (i < text.length && text[i] !== c) { if (text[i] === '\\') { out.push(' '); i++; if (i < text.length) { out.push(' '); i++; } continue; } out.push(' '); i++; }
      if (i < text.length) { out.push(c); i++; }
      continue;
    }
    out.push(c); i++;
  }
  return { code: out.join(''), st };
}

/** The code of every added line of a file, comments and strings blanked, with the state carried through each hunk (so the inside of a docstring or a block comment is not code). */
export function codeLines(f: FileDiff): Map<number, string> {
  const fam = familyOf(f.path);
  const out = new Map<number, string>();
  for (const h of f.hunks) {
    let st = fresh();
    for (const l of h.lines) {
      if (l.t === '-') continue;
      const r = lexLine(l.text, fam, st);
      st = r.st;
      if (l.t === '+' && l.n !== null) out.set(l.n, r.code);
    }
  }
  return out;
}

/** Lines that are not logic in any language: a comment, an import, a package line, an attribute or annotation. */
const NOT_CODE = (fam: Family): RegExp => new RegExp(`^\\s*(?:${[...LINE_COMMENT[fam].map(m => m.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')), ...(HAS_BLOCK.has(fam) ? ['\\*', '/\\*'] : []), 'import\\b', 'from\\s+\\S+\\s+import\\b', 'package\\b', 'using\\b', 'use\\s', 'require\\b', 'extern\\b', '#include', '#!', '#\\[', '@\\w+\\s*(?:\\(.*\\))?\\s*$'].join('|')})`);

interface Op { id: string; re: RegExp; to: (m: RegExpExecArray) => string }
const FLIP: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '~=': '==', ' < ': ' <= ', ' <= ': ' < ', ' > ': ' >= ', ' >= ': ' > ', '&&': '||', '||': '&&', and: 'or', or: 'and', true: 'false', false: 'true', True: 'False', False: 'True', ' + ': ' - ', ' - ': ' + ', ' * ': ' / ' };

/** In priority order, for one language family. Each one only ever looks at code (see lexLine). */
function opsFor(fam: Family): Op[] {
  const ops: Op[] = [];
  if (fam === 'js') ops.push({ id: 'equality', re: /(?<![=!<>])(===|!==|==|!=)(?!=)/, to: m => FLIP[m[1]] });
  else if (fam === 'lua') ops.push({ id: 'equality', re: /(?<![=~<>])(==|~=)(?!=)/, to: m => (m[1] === '==' ? '~=' : '==') });
  else ops.push({ id: 'equality', re: /(?<![=!<>])(==|!=)(?!=)/, to: m => FLIP[m[1]] });
  ops.push({ id: 'comparison', re: /( <= | >= | < | > )/, to: m => FLIP[m[1]] });
  if (fam === 'py' || fam === 'lua' || fam === 'ex') ops.push({ id: 'and-or', re: /\b(and|or)\b/, to: m => FLIP[m[1]] });
  else if (fam === 'rb') ops.push({ id: 'and-or', re: /(&&|\|\||\band\b|\bor\b)/, to: m => FLIP[m[1]] });
  else ops.push({ id: 'and-or', re: /(&&|\|\|)/, to: m => FLIP[m[1]] });
  // removing a negation: the head is what stays, the rest (the "!" or the "not ") goes
  if (fam === 'py' || fam === 'lua' || fam === 'ex') ops.push({ id: 'negation', re: /(\b(?:if|while|elif|elseif)\s+)not\s+/, to: () => '' });
  else if (fam === 'rb') ops.push({ id: 'negation', re: /(\b(?:if|while|unless|until)\s+)(?:!(?!=)|not\s+)/, to: () => '' });
  else ops.push({ id: 'negation', re: /(\b(?:if|while)\s*\(?\s*)!(?!=)/, to: () => '' });
  if (fam === 'py') ops.push({ id: 'none-check', re: /\bis (not )?None\b/, to: m => (m[1] ? 'is None' : 'is not None') });
  ops.push({ id: 'boolean', re: fam === 'py' ? /\b(True|False)\b/ : /\b(true|false)\b/, to: m => FLIP[m[1]] });
  ops.push({ id: 'arithmetic', re: /( \+ | - | \* )/, to: m => FLIP[m[1]] });
  ops.push({ id: 'number', re: /(?<![\w.$])([1-9]\d{0,2}|0)(?![\w.])/, to: m => String(Number(m[1]) + 1) });
  return ops;
}

export function mutantsFor(file: string, line: number, text: string, masked?: string): Mutant[] {
  const fam = familyOf(file);
  if (fam === 'none' || text.length > 300 || NOT_CODE(fam).test(text)) return [];
  const m = masked ?? lexLine(text, fam, fresh()).code;
  const out: Mutant[] = [];
  for (const op of opsFor(fam)) {
    const hit = op.re.exec(m);
    if (!hit || hit.index === undefined) continue;
    // a "+" next to a string is joining text, which a typed language won't take as a subtraction: a mutant that can't compile is a wasted run
    if (op.id === 'arithmetic' && /["'`]\s*[+*-]|[+*-]\s*["'`]/.test(m)) continue;
    // the length of an array type ([u8; 32]) is not a value to nudge
    if (op.id === 'number' && fam === 'cstyle' && /\[[^\]]*;\s*\d+\s*\]/.test(m)) continue;
    let col = hit.index, len = hit[0].length;
    let to: string;
    if (op.id === 'negation') {
      const head = hit[1];
      col += head.length;
      len = hit[0].length - head.length;
      to = '';
    } else {
      to = op.to(hit);
    }
    if (to === undefined) continue;
    const mutated = text.slice(0, col) + to + text.slice(col + len);
    if (mutated === text) continue;
    out.push({ id: `m-${sha(`${file}:${line}:${op.id}`, 8)}`, file, line, op: op.id, original: text, col, len, to });
  }
  return out;
}

/**
 * Which mutants to try, when each costs a full test run. Lines in files the findings already point at go first, then the rest
 * spread across files so one big file can't use the whole budget.
 */
export function pickMutants(net: FileDiff[], limit: number, prefer: Array<{ file: string; line: number }> = []): Mutant[] {
  const byFile = new Map<string, Mutant[]>();
  const second: Mutant[] = [];
  for (const f of net) {
    if (f.binary || f.status === 'deleted' || !isSourcePath(f.path)) continue;
    const code = codeLines(f);
    const list: Mutant[] = [];
    for (const h of f.hunks) for (const l of h.lines) if (l.t === '+' && l.n !== null) {
      const ms = mutantsFor(f.path, l.n, l.text, code.get(l.n));
      if (ms.length) { list.push(ms[0]); second.push(...ms.slice(1, 2)); }
    }
    if (list.length) byFile.set(f.path, list);
  }
  const chosen: Mutant[] = [];
  const near = (m: Mutant): boolean => prefer.some(p => p.file === m.file && Math.abs(p.line - m.line) <= 3);
  for (const list of byFile.values()) for (const m of list) if (near(m) && chosen.length < limit) chosen.push(m);
  const rest = [...byFile.values()].map(l => l.filter(m => !chosen.includes(m)));
  for (let i = 0; chosen.length < limit && rest.some(l => i < l.length); i++) for (const l of rest) if (i < l.length && chosen.length < limit) chosen.push(l[i]);
  // a line with a second kind of change (a comparison and a boolean) is worth a second try once every line has had its first
  for (const m of second) if (chosen.length < limit && !chosen.includes(m)) chosen.push(m);
  return chosen;
}

const eol = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** Applies a mutant in a checkout. Returns the file's original text so it can be put back, or null if the line isn't what we expected. */
export function applyMutant(root: string, m: Mutant): string | null {
  const p = path.join(root, m.file);
  let text: string;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const cur = lines[m.line - 1]?.replace(/\r$/, '');
  if (cur !== m.original) return null;
  const cr = lines[m.line - 1].endsWith('\r') ? '\r' : '';
  lines[m.line - 1] = m.original.slice(0, m.col) + m.to + m.original.slice(m.col + m.len) + cr;
  fs.writeFileSync(p, lines.join('\n'));
  return text;
}

/** Puts one hunk back the way it was before the range, in a checkout of the head. Returns the original text, or null if the file doesn't match the hunk exactly. */
export function revertHunk(root: string, file: string, hunk: Hunk): string | null {
  const p = path.join(root, file);
  let text: string;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  const now = hunk.lines.filter(l => l.t !== '-').map(l => l.text);
  const before = hunk.lines.filter(l => l.t !== '+').map(l => l.text);
  const at = hunk.newStart - 1;
  if (now.length !== hunk.newLines || before.length !== hunk.oldLines) return null;
  if (!now.every((t, i) => lines[at + i] === t)) return null;
  lines.splice(at, now.length, ...before);
  fs.writeFileSync(p, lines.join(nl));
  return text;
}

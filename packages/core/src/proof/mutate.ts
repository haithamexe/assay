import fs from 'node:fs';
import path from 'node:path';
import { sha } from '../config.js';
import type { FileDiff, Hunk } from '../diff.js';
import { isSourcePath } from '../lang.js';

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

interface Op { id: string; re: RegExp; to: (m: RegExpExecArray) => string }

const FLIP: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', ' < ': ' <= ', ' <= ': ' < ', ' > ': ' >= ', ' >= ': ' > ', '&&': '||', '||': '&&', ' and ': ' or ', ' or ': ' and ', true: 'false', false: 'true', True: 'False', False: 'True', ' + ': ' - ', ' - ': ' + ', ' * ': ' / ' };

/** In priority order. Each one only ever looks at code, never at the inside of a string (see mask). */
const OPS: Op[] = [
  { id: 'equality', re: /(?<![=!<>])(===|!==|==|!=)(?!=)/, to: m => FLIP[m[1]] },
  { id: 'comparison', re: /( <= | >= | < | > )/, to: m => FLIP[m[1]] },
  { id: 'and-or', re: /(&&|\|\||\band\b|\bor\b)/, to: m => (m[1] === 'and' || m[1] === 'or' ? FLIP[` ${m[1]} `].trim() : FLIP[m[1]]) },
  { id: 'negation', re: /(\b(?:if|while)\s*\(\s*)!(?!=)|(\b(?:if|while)\s+)not\s+/, to: m => (m[1] ?? m[2]) },
  { id: 'boolean', re: /\b(true|false|True|False)\b/, to: m => FLIP[m[1]] },
  { id: 'arithmetic', re: /( \+ | - | \* )/, to: m => FLIP[m[1]] },
  { id: 'number', re: /(?<![\w.$])([1-9]\d{0,2}|0)(?![\w.])/, to: m => String(Number(m[1]) + 1) }
];

const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|<!--)/;

/** The line with the inside of every string literal blanked out, same length, so a match can't land in text. */
function mask(line: string): string {
  let out = '';
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === q) { q = null; out += c; } else out += ' ';
    } else if (c === '"' || c === "'" || c === '`') { q = c; out += c; } else out += c;
  }
  return out;
}

export function mutantsFor(file: string, line: number, text: string): Mutant[] {
  if (COMMENT.test(text) || text.length > 300) return [];
  const m = mask(text);
  const out: Mutant[] = [];
  for (const op of OPS) {
    const hit = op.re.exec(m);
    if (!hit || hit.index === undefined) continue;
    let col = hit.index, len = hit[0].length, to: string;
    if (op.id === 'negation') {
      // remove the "!" or the "not ": keep the text before it
      const head = hit[1] ?? hit[2];
      col += head.length;
      len = hit[1] ? 1 : hit[0].length - head.length;
      to = '';
    } else if (op.id === 'and-or' && /^[a-z]/.test(hit[1])) {
      to = op.to(hit);
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
    const list: Mutant[] = [];
    for (const h of f.hunks) for (const l of h.lines) if (l.t === '+' && l.n !== null) {
      const ms = mutantsFor(f.path, l.n, l.text);
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

import fs from 'node:fs';
import { redactSecrets } from '../checks/secrets.js';
import { assayPath, sha, writeFileAtomic } from '../config.js';
import { parseDiff } from '../diff.js';
import { gitAsync, repoKey, repoRoot } from '../git.js';
import { isDemoPath, isDocPath, isGenerated, isTestPath, languageOf } from '../lang.js';
import { addLearned, checkPattern, listEntries, type Entry, type Example } from './entries.js';

/**
 * Learning from a project's own history (D34). A fix commit is a mistake somebody already paid for. This reads git only:
 * it finds the fix commits, collects what each one took away (a call, a property, a CSS declaration), and keeps what fixes
 * remove far more often than other commits do. What it suggests is a literal pattern, with examples, and nothing is added
 * until a person says so. It finds recurring things to avoid, not logic slips: `<` where `<=` was meant has no shape to find.
 */
export interface Candidate {
  id: string;
  token: string;
  name: string;
  pattern: string;
  flags: string;
  langs: string[];
  /** Fix commits that took it away. */
  fixes: number;
  /** Other commits that took it away too (a refactor, a rename). */
  others: number;
  /** Other commits that wrote it. */
  written: number;
  /** What the fixes usually put in its place, when it is the same thing each time. Null: they just took it out, or did different things. */
  replacedBy: string | null;
  /** The share of fixes that did the same thing with it (swapped it for the same token, or took it out). */
  consistent: number;
  worth: boolean;
  examples: Example[];
  origin: string;
}

export interface MineReport { at: string; commits: number; fixes: number; skipped: number; truncated: boolean; candidates: Candidate[] }
export interface MineOptions { limit?: number; signal?: AbortSignal; onProgress?: (m: string) => void }

const CODEISH = new Set(['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'C#', 'PHP', 'Ruby', 'Swift', 'C', 'C++', 'Scala', 'Dart', 'Lua', 'Elixir', 'Vue', 'Svelte', 'CSS', 'HTML', 'SQL', 'Shell', 'PowerShell']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'async', 'def', 'elif', 'except', 'with', 'lambda', 'super', 'this', 'self', 'not', 'and', 'or', 'in', 'is', 'sizeof', 'else', 'do', 'try', 'finally', 'new', 'throw', 'delete', 'void', 'yield', 'import', 'export', 'from', 'class', 'extends', 'assert', 'raise', 'case', 'print']);
const COMMENT = /^(?:\/\/|#|\*|\/\*|--|<!--)/;
const STRINGS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const FIX = /^(?:fix|bugfix|hotfix)(?:\([^)]*\))?!?:|\b(?:fix(?:e[sd])?|bug ?fix|hotfix)\b/i;
const NOT_FIX = /^(?:revert|docs?|chore|style|test|ci|build|refactor|merge)\b/i;

export const isFixSubject = (subject: string): boolean => FIX.test(subject.slice(0, 120)) && !NOT_FIX.test(subject);

/** The things a changed line is made of that could be a mistake: calls, members, `new X(`, and (in CSS) a declaration with its numbers made generic. */
export function tokensOf(line: string, css: boolean): string[] {
  const t = line.trim();
  if (!t || t.length > 400 || COMMENT.test(t)) return [];
  if (css) {
    const m = /^([a-z-]+)\s*:\s*([^;{}]+?)\s*;?$/i.exec(t);
    if (!m) return [];
    const val = m[2].trim().toLowerCase().replace(/#[0-9a-f]{3,8}\b/g, '#HEX').replace(/-?\d+(?:\.\d+)?/g, 'N');
    return val.length <= 40 && !/^[$@]/.test(val) ? [`${m[1].toLowerCase()}: ${val}`] : [];
  }
  const out = new Set<string>();
  const s = t.replace(STRINGS, '""');
  for (const m of s.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) out.add(`new ${m[1]}(`);
  for (const m of s.matchAll(/(?<!\.)\.\s*([A-Za-z_$][\w$]*)(\s*\()?/g)) out.add(m[2] ? `.${m[1]}(` : `.${m[1]}`);
  for (const m of s.matchAll(/(?<![\w$.])(?<!\bnew\s+)([A-Za-z_$][\w$]*)\s*\(/g)) if (!KEYWORDS.has(m[1])) out.add(`${m[1]}(`);
  return [...out].filter(x => x.length >= 4 && x.length <= 60);
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A token as a pattern: the token's own characters (escaped), with a number standing for any number. Never anything a person typed. */
export function patternOf(token: string, css: boolean): { source: string; flags: string } {
  if (css) {
    const at = token.indexOf(': ');
    const prop = token.slice(0, at);
    const body = token.slice(at + 2).split(/(N|#HEX|\s+)/).filter(Boolean).map(p => (p === 'N' ? '-?\\d+(?:\\.\\d+)?' : p === '#HEX' ? '#[0-9a-fA-F]{3,8}' : /^\s+$/.test(p) ? '\\s+' : esc(p))).join('');
    return { source: `\\b${esc(prop)}\\s*:\\s*${body}\\s*(?:[;}]|$)`, flags: 'i' };
  }
  if (token.startsWith('new ')) return { source: `\\bnew\\s+${esc(token.slice(4, -1))}\\s*\\(`, flags: '' };
  if (token.startsWith('.')) return token.endsWith('(') ? { source: `\\.\\s*${esc(token.slice(1, -1))}\\s*\\(`, flags: '' } : { source: `\\.\\s*${esc(token.slice(1))}(?![\\w$])`, flags: '' };
  return { source: `(?<![\\w$.])${esc(token.slice(0, -1))}\\s*\\(`, flags: '' };
}

interface Acc {
  css: boolean; fix: Set<string>; other: Set<string>; written: Set<string>; langs: Map<string, number>; examples: Example[];
  /** What fixes put in its place: a token -> the fix commits that did. `none` holds the fix commits that took it out and wrote nothing new. */
  repl: Map<string, Set<string>>; none: Set<string>;
}
const tick = (): Promise<void> => new Promise(r => setImmediate(r));
const trim = (s: string): string => redactSecrets(s.trim()).slice(0, 160);

export async function mineHistory(repoIn: string, opts: MineOptions = {}): Promise<MineReport> {
  const repo = repoRoot(repoIn);
  const say = opts.onProgress ?? (() => undefined);
  const limit = Math.min(2000, Math.max(20, Math.floor(opts.limit ?? 600)));
  say(`Reading up to ${limit} commits…`);
  let raw: string;
  try {
    raw = await gitAsync(repo, ['log', '--no-merges', `--max-count=${limit}`, '--diff-filter=M', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--format=%x1e%H%x1f%s'], { signal: opts.signal });
  } catch (err) {
    if (err instanceof Error && /maxBuffer/i.test(err.message)) throw new Error('The history is too large to read in one go. Try a smaller --limit.');
    throw err;
  }
  const records = raw.split('\x1e').slice(1);
  const acc = new Map<string, Acc>();
  let fixes = 0;
  let skipped = 0;
  const note = (token: string, css: boolean): Acc => {
    let a = acc.get(token);
    if (!a) { a = { css, fix: new Set(), other: new Set(), written: new Set(), langs: new Map(), examples: [], repl: new Map(), none: new Set() }; acc.set(token, a); }
    return a;
  };
  for (let i = 0; i < records.length; i++) {
    if (opts.signal?.aborted) throw new Error('Stopped.');
    if (i % 25 === 24) { await tick(); say(`Read ${i + 1} of ${records.length} commits, ${fixes} of them fixes…`); }
    const rec = records[i];
    const nl = rec.indexOf('\n');
    const [hash, subject = ''] = (nl === -1 ? rec : rec.slice(0, nl)).split('\x1f');
    const files = nl === -1 ? [] : parseDiff(rec.slice(nl + 1));
    const fix = isFixSubject(subject);
    if (fix) fixes++;
    if (!files.length) continue;
    if (files.length > 60 || files.reduce((a, f) => a + f.additions + f.deletions, 0) > 2000) { skipped++; continue; }
    for (const f of files) {
      const lang = languageOf(f.path);
      if (!lang || !CODEISH.has(lang) || f.binary || isGenerated(f.path) || isTestPath(f.path) || isDemoPath(f.path) || isDocPath(f.path) || f.additions + f.deletions > 400) continue;
      const css = lang === 'CSS';
      for (const h of f.hunks) {
        const removed = h.lines.filter(l => l.t === '-');
        if (!removed.length || removed.length > 60) continue;
        const added = h.lines.filter(l => l.t === '+');
        const gone = new Map<string, string>();
        for (const l of removed) for (const t of tokensOf(l.text, css)) if (!gone.has(t)) gone.set(t, l.text);
        const came = new Set<string>();
        for (const l of added) for (const t of tokensOf(l.text, css)) came.add(t);
        // A fix that swaps a token for the same new thing each time, or takes it out, is a pattern. One that rewrites a block differently each time is just an edit.
        const fresh = [...came].filter(t => !gone.has(t));
        const small = added.length <= 6 && fresh.length <= 4;
        for (const [t, line] of gone) {
          if (came.has(t)) continue;
          const a = note(t, css);
          if (fix) {
            if (!added.length) a.none.add(hash);
            else if (small) for (const g of fresh) { const s = a.repl.get(g) ?? new Set<string>(); s.add(hash); a.repl.set(g, s); }
            a.fix.add(hash);
            a.langs.set(lang, (a.langs.get(lang) ?? 0) + 1);
            if (a.examples.length < 3 && !a.examples.some(e => e.commit === hash)) a.examples.push({ commit: hash, subject: redactSecrets(subject).slice(0, 140), bad: trim(line), good: trim(added[0]?.text ?? '') });
          } else a.other.add(hash);
        }
        if (!fix) for (const t of came) if (!gone.has(t)) note(t, css).written.add(hash);
      }
    }
  }
  say('Choosing what is worth a detector…');
  const found: Candidate[] = [];
  const fixSets = new Map<string, Set<string>>();
  for (const [token, a] of acc) {
    const n = a.fix.size;
    if (n < 2) continue;
    const ratio = n / (n + a.other.size);
    if (ratio < 0.34) continue;
    const top = [...a.repl.entries()].sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0]))[0];
    const same = Math.max(a.none.size, top?.[1].size ?? 0) / n;
    if (same < 0.6) continue;
    const replacedBy = top && top[1].size >= a.none.size && top[1].size >= 2 ? top[0] : null;
    let p: { source: string; flags: string };
    try { p = checkPattern(patternOf(token, a.css).source, patternOf(token, a.css).flags); } catch { continue; }
    const re = new RegExp(p.source, p.flags);
    if (!a.examples.some(e => re.test(e.bad))) continue;
    const total = [...a.langs.values()].reduce((x, y) => x + y, 0);
    const langs = [...a.langs.entries()].filter(([, c]) => c / total >= 0.25).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([l]) => l);
    const first = a.examples[0];
    fixSets.set(`m-${sha(token, 8)}`, a.fix);
    found.push({
      id: `m-${sha(token, 8)}`, token, name: replacedBy ? `Fixed before: ${token} → ${replacedBy}` : `Fixed before: ${token} removed`, pattern: p.source, flags: p.flags, langs, fixes: n, others: a.other.size, written: a.written.size,
      replacedBy, consistent: Math.round(same * 100) / 100, worth: n >= 3 && ratio >= 0.5 && same >= 0.6, examples: a.examples,
      origin: `Mined from history: ${n} fix commits removed it${first ? ` (for example ${first.commit.slice(0, 7)} “${first.subject}”)` : ''}.`
    });
  }
  found.sort((x, y) => Number(y.worth) - Number(x.worth) || y.fixes - x.fixes || x.others - y.others || x.token.localeCompare(y.token));
  // Two suggestions that are mostly the same fixes and the same words are one idea: keep the first.
  const kept: Candidate[] = [];
  for (const c of found) {
    const mine = fixSets.get(c.id) as Set<string>;
    const dup = kept.some(k => {
      if (!(k.token.includes(c.token) || c.token.includes(k.token))) return false;
      const theirs = fixSets.get(k.id) as Set<string>;
      return [...mine].filter(h => theirs.has(h)).length >= 0.75 * mine.size;
    });
    if (!dup) kept.push(c);
    if (kept.length >= 25) break;
  }
  const report: MineReport = { at: new Date().toISOString(), commits: records.length, fixes, skipped, truncated: records.length >= limit, candidates: kept };
  try { writeFileAtomic(minedFile(repo), JSON.stringify(report)); } catch { /* the suggestions are only not kept */ }
  return report;
}

const minedFile = (repo: string): string => assayPath('mined', `${repoKey(repo)}.json`);

/** The suggestions from the last time history was read, with which of them are already in memory. */
export function lastMined(repoIn: string): { report: MineReport | null; added: Record<string, string> } {
  const repo = repoRoot(repoIn);
  let report: MineReport | null = null;
  try { report = JSON.parse(fs.readFileSync(minedFile(repo), 'utf8')) as MineReport; } catch { /* never read yet */ }
  const added: Record<string, string> = {};
  if (report) {
    const have = listEntries(repo).filter((e): e is Entry & { pattern: { source: string; flags: string } } => e.kind === 'learned' && !!e.pattern);
    for (const c of report.candidates) {
      const e = have.find(x => x.pattern.source === c.pattern && x.pattern.flags === c.flags);
      if (e) added[c.id] = e.id;
    }
  }
  return { report, added };
}

/** Adds one of the last suggestions to memory. Only a suggestion Assay made from history: the page and the agent can't send a pattern of their own through this. */
export function addMined(repoIn: string, candidateId: string, name?: string): Entry {
  const repo = repoRoot(repoIn);
  const { report } = lastMined(repo);
  const c = report?.candidates.find(x => x.id === candidateId);
  if (!c) throw new Error('That suggestion is not in the last reading of the history. Read it again.');
  const first = c.examples[0];
  return addLearned(repo, { name: name?.trim() || c.name, pattern: c.pattern, flags: c.flags, langs: c.langs, bad: first?.bad, good: first?.good || undefined, origin: c.origin, fixes: c.fixes, examples: c.examples });
}

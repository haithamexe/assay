import { emptyTree, git } from './git.js';

export interface DiffLine { t: ' ' | '+' | '-'; o: number | null; n: number | null; text: string }
export interface Hunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** More changed lines than we keep: counts are exact, the hunks stop early. */
  truncated: boolean;
}

const MAX_KEPT_LINES = 3000;

function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  return p.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
}

function namesFromHeader(line: string): [string, string] {
  const rest = line.slice('diff --git '.length);
  const m = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(rest);
  if (!m) return ['', ''];
  // A name with " b/" inside makes the split ambiguous; when both halves are equal that is the one.
  let i = rest.indexOf(' b/');
  while (i !== -1) {
    const a = rest.slice(0, i).replace(/^"?a\//, '').replace(/"$/, '');
    const b = rest.slice(i + 3).replace(/"$/, '');
    if (a === b) return [unquote(a), unquote(b)];
    i = rest.indexOf(' b/', i + 1);
  }
  return [unquote(m[1]), unquote(m[2])];
}

/** Parses `git diff` output. Only what Assay needs: files, hunks with real line numbers, adds and deletes. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0, kept = 0;
  let renameTo: string | null = null;
  const lines = text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '\\') continue;
      const body = line.slice(1);
      if (c === '+' || c === '-' || c === ' ' || line === '') {
        const t = (c === '+' || c === '-' ? c : ' ') as DiffLine['t'];
        if (t === '+') { cur!.additions++; newLeft--; }
        else if (t === '-') { cur!.deletions++; oldLeft--; }
        else { oldLeft--; newLeft--; }
        if (kept < MAX_KEPT_LINES) {
          kept++;
          hunk.lines.push({ t, o: t === '+' ? null : oldNo, n: t === '-' ? null : newNo, text: line === '' ? '' : body });
        } else cur!.truncated = true;
        if (t !== '+') oldNo++;
        if (t !== '-') newNo++;
        continue;
      }
    }
    if (line.startsWith('diff --git ')) {
      const [a, b] = namesFromHeader(line);
      cur = { path: b || a, oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [], truncated: false };
      files.push(cur);
      hunk = null; kept = 0; renameTo = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = unquote(line.slice(12)); }
    else if (line.startsWith('rename to ')) renameTo = unquote(line.slice(10));
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) cur.binary = true;
    else if (line.startsWith('--- ') && !hunk) { /* the old name is in the header; nothing to keep */ }
    else if (line.startsWith('+++ ') && !hunk) {
      const p = unquote(line.slice(4));
      if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) continue;
      oldNo = +m[1]; newNo = +m[3];
      oldLeft = m[2] === undefined ? 1 : +m[2];
      newLeft = m[4] === undefined ? 1 : +m[4];
      hunk = { header: line, oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, lines: [] };
      cur.hunks.push(hunk);
    }
    if (renameTo) cur.path = renameTo;
  }
  return files;
}

/** What one commit changed against its first parent (the empty tree for a root commit). */
export function commitDiff(repo: string, hash: string, parent: string | null): FileDiff[] {
  const from = parent ?? emptyTree(repo);
  const out = git(repo, ['diff', '--unified=3', '--no-color', '--no-ext-diff', '-M', '--no-textconv', from, hash, '--']);
  return parseDiff(out);
}

/** The rows around a line, for showing a finding in context. `sig` marks the line itself. */
export function snippetAround(file: FileDiff, line: number, side: 'added' | 'removed', radius = 4): { header: string; rows: Array<DiffLine & { sig?: boolean }> } | null {
  for (const h of file.hunks) {
    const idx = h.lines.findIndex(l => (side === 'added' ? l.t === '+' && l.n === line : l.t === '-' && l.o === line));
    if (idx === -1) continue;
    const from = Math.max(0, idx - radius), to = Math.min(h.lines.length, idx + radius + 1);
    return { header: h.header, rows: h.lines.slice(from, to).map((l, i) => (from + i === idx ? { ...l, sig: true } : { ...l })) };
  }
  return null;
}

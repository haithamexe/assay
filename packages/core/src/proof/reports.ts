import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Each runner's machine-readable report, read into one shape: how many passed, and for each failure its name, file and line,
 * the message, and expected against actual. vitest and jest JSON, node:test TAP, JUnit XML (pytest), go test JSON.
 * Nothing is guessed from coloured console output; runners without a report are read by `parse.ts` instead.
 */

export interface TestFailure {
  name: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  expected?: string;
  actual?: string;
  /** The first few stack lines in the project's own code. */
  stack?: string[];
}

export interface ReportCounts { passed: number; failed: number; skipped: number; failures: TestFailure[] }

/** vitest --reporter=json and jest --json share this shape. */
export function parseJestJson(text: string, dir: string): ReportCounts {
  const json = JSON.parse(text) as {
    numPassedTests?: number; numFailedTests?: number; numPendingTests?: number; numTodoTests?: number;
    testResults?: { name: string; message?: string; status?: string; assertionResults?: { fullName?: string; title: string; status: string; failureMessages?: string[]; location?: { line: number; column: number } }[] }[];
  };
  const failures: TestFailure[] = [];
  for (const file of json.testResults ?? []) {
    const rel = relative(dir, file.name);
    const failed = (file.assertionResults ?? []).filter(a => a.status === 'failed');
    for (const a of failed) {
      const msg = clean((a.failureMessages ?? []).join('\n'));
      failures.push({ name: a.fullName || a.title, file: rel, line: a.location?.line ?? lineIn(msg, file.name), column: a.location?.column, ...splitMessage(msg, dir) });
    }
    // A file that failed before any test ran (a syntax error, a bad import).
    if (!failed.length && file.status === 'failed' && file.message) failures.push({ name: `${rel} (didn't run)`, file: rel, ...splitMessage(clean(file.message), dir) });
  }
  return {
    passed: json.numPassedTests ?? 0,
    failed: Math.max(json.numFailedTests ?? 0, failures.length),
    skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
    failures
  };
}

/** node --test with the TAP reporter: "not ok N - name" followed by a YAML block. */
export function parseTap(text: string, dir: string): ReportCounts {
  const lines = text.split(/\r?\n/);
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO).*)?$/.exec(lines[i]);
    if (!m) {
      const total = /^# (pass|fail|skipped|todo) (\d+)$/.exec(lines[i]);
      if (total) {
        if (total[1] === 'pass') passed = Number(total[2]);
        if (total[1] === 'fail') failed = Number(total[2]);
        if (total[1] === 'skipped' || total[1] === 'todo') skipped += Number(total[2]);
      }
      continue;
    }
    if (m[2] !== 'not ok' || m[4]) continue;
    const indent = m[1].length;
    const block: string[] = [];
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      for (; j < lines.length && lines[j].trim() !== '...'; j++) block.push(lines[j].slice(indent + 2));
      i = j;
    }
    const yaml = readTapYaml(block);
    if (yaml.type === 'suite' || yaml.failureType === 'subtestsFailed') continue;
    const loc = /^(.*):(\d+):(\d+)$/.exec(yaml.location ?? '');
    const stack = (yaml.stack ?? '').split('\n').filter(l => l && !/node:internal|node:async_hooks/.test(l));
    failures.push({
      name: m[3],
      file: loc ? relative(dir, loc[1]) : undefined,
      line: loc ? Number(loc[2]) : undefined,
      column: loc ? Number(loc[3]) : undefined,
      message: clean(yaml.error ?? yaml.name ?? 'failed'),
      expected: yaml.expected,
      actual: yaml.actual,
      stack: stack.slice(0, 4).map(l => shorten(l, dir))
    });
  }
  return { passed, failed: Math.max(failed, failures.length), skipped, failures };
}

/** A tiny reader for the YAML node:test writes: key: value, and key: |- blocks. */
function readTapYaml(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\w+): ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] === '|-' || m[2] === '|') {
      const body: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith('  ') || lines[i + 1] === '')) body.push(lines[++i].slice(2));
      out[m[1]] = body.join('\n').trim();
    } else {
      out[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/''/g, "'").replace(/\\\\/g, '\\');
    }
  }
  return out;
}

/** pytest --junitxml (and any JUnit XML). */
export function parseJunit(xml: string, dir: string): ReportCounts {
  const failures: TestFailure[] = [];
  let passed = 0;
  let skipped = 0;
  const cases = xml.match(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g) ?? [];
  for (const c of cases) {
    const attr = (name: string): string => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(c)?.[1] ?? '');
    const fail = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(c);
    if (/<skipped\b/.test(c)) { skipped++; continue; }
    if (!fail) { passed++; continue; }
    const body = decode(fail[3] ?? '');
    const message = decode(/message="([^"]*)"/.exec(fail[2] ?? fail[5] ?? '')?.[1] ?? '') || body.split('\n').find(l => /^E\s/.test(l))?.replace(/^E\s+/, '') || 'failed';
    const where = [...body.matchAll(/^([^\s:][^:\n]*\.py):(\d+):/gm)].pop();
    failures.push({
      name: [attr('classname'), attr('name')].filter(Boolean).join('::'),
      file: where ? relative(dir, where[1]) : attr('file') || undefined,
      line: where ? Number(where[2]) : attr('line') ? Number(attr('line')) : undefined,
      message: clean(message),
      stack: body.split('\n').filter(l => /^E\s/.test(l)).slice(0, 6)
    });
  }
  return { passed, failed: failures.length, skipped, failures };
}

/** go test -json: one JSON event per line. */
export function parseGoJson(text: string): ReportCounts {
  const output = new Map<string, string[]>();
  const failures: TestFailure[] = [];
  let passed = 0;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let e: { Action: string; Package?: string; Test?: string; Output?: string };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    if (!e.Test) continue;
    const key = `${e.Package}/${e.Test}`;
    if (e.Action === 'output' && e.Output) output.set(key, [...(output.get(key) ?? []), e.Output.replace(/\n$/, '')]);
    if (e.Action === 'pass') passed++;
    if (e.Action === 'skip') skipped++;
    if (e.Action === 'fail') {
      const out = output.get(key) ?? [];
      const at = out.map(l => /^\s+([\w./-]+_test\.go):(\d+): (.*)$/.exec(l)).find(Boolean);
      const rest = out.filter(l => !/^(=== RUN|--- FAIL)/.test(l.trim()));
      failures.push({ name: e.Test, file: at?.[1], line: at ? Number(at[2]) : undefined, message: at ? at[3] : rest.join('\n').trim() || 'failed', stack: rest.slice(0, 6) });
    }
  }
  // A parent test fails when a subtest does; keep the most specific ones.
  const names = failures.map(f => f.name);
  const leaf = failures.filter(f => !names.some(n => n.startsWith(`${f.name}/`)));
  return { passed, failed: leaf.length, skipped, failures: leaf };
}

/** "expected X, received Y" pulled out of a message, with the rest as the message. */
function splitMessage(msg: string, dir: string): Pick<TestFailure, 'message' | 'expected' | 'actual' | 'stack'> {
  const lines = msg.split('\n');
  const stackStart = lines.findIndex(l => /^\s+at /.test(l));
  const body = (stackStart >= 0 ? lines.slice(0, stackStart) : lines).join('\n').trim();
  const stack = stackStart >= 0 ? lines.slice(stackStart).filter(l => !/node_modules|node:internal|<anonymous>/.test(l)).slice(0, 4).map(l => shorten(l.trim(), dir)) : undefined;
  // jest prints "Expected: 6 / Received: 5"; vitest's chai says "expected 5 to be 6".
  const chai = /expected (.+?) to (?:be|equal|deeply equal|strictly equal|have length|include) (.+?)(?: \/\/.*)?$/m.exec(body);
  const expected = /^\s*(?:Expected|expected)(?: value)?:\s+(.+)$/m.exec(body)?.[1] ?? chai?.[2];
  const actual = /^\s*(?:Received|received|Actual|actual)(?: value)?:\s+(.+)$/m.exec(body)?.[1] ?? chai?.[1];
  return { message: body.split('\n').slice(0, 12).join('\n'), expected, actual, stack };
}

function lineIn(msg: string, file: string): number | undefined {
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${base}:(\\d+):\\d+`).exec(msg);
  return m ? Number(m[1]) : undefined;
}

function shorten(line: string, dir: string): string {
  return line.split(dir + path.sep).join('').split(`${dir.replace(/\\/g, '/')}/`).join('').replace(/file:\/\/\/?/g, '');
}

const realpath = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return p; } };

function relative(dir: string, file: string): string {
  let f = file;
  if (f.startsWith('file:')) {
    try { f = fileURLToPath(f); } catch { /* not a valid file URL: keep it as written */ }
  }
  const abs = path.isAbsolute(f) ? f : path.join(dir, f);
  // A runner reports the real path; the project's folder can be reached through a link (macOS /var is /private/var).
  for (const [from, to] of [[dir, abs], [realpath(dir), realpath(abs)]]) {
    const rel = path.relative(from, to);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return f;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const clean = (s: string): string => s.replace(ANSI, '').trim();

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
}

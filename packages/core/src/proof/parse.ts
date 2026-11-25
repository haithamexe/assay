/** What a test run said, read from its text output. Every common runner is covered by a few patterns, so no framework has to be installed to be understood. */
export interface ParsedRun {
  /** Names of the tests that failed. */
  failed: string[];
  /** How many failed, when the output says so; null if it doesn't. */
  failedCount: number | null;
  passedCount: number | null;
  /** file:line pairs from stack traces and failure messages. */
  refs: Array<{ file: string; line: number }>;
}

const NAME_PATTERNS: RegExp[] = [
  /^\s*[✖✗×✘]\s+(.+?)(?:\s+\(\d[\d.]*\s?m?s\))?\s*$/, // node:test spec, vitest, mocha spec
  /^not ok \d+ - (.+)$/, // TAP
  /^\s*● (.+?)\s*$/, // jest
  /^\s*FAIL\s+\S+\s+[>›]\s+(.+?)\s*$/, // vitest
  /^FAILED (\S+)/, // pytest
  /^(\S+::\S+) FAILED/, // pytest -v
  /^--- FAIL: (\S+)/, // go
  /^test (\S+) \.\.\. FAILED/, // cargo
  /^\s+\d+\) (.+?)\s*$/ // mocha
];
const SKIP_NAMES = /^(?:failing tests?:?|Console|Test Suites?|Tests?:?|Summary|Failures?:?)$/i;

const COUNT_FAILED: RegExp[] = [
  /^ℹ fail (\d+)/m, // node:test
  /^# fail (\d+)/m, // TAP
  /Tests?:\s+(?:\d+ skipped,\s*)?(\d+) failed/i, // jest, vitest
  /^\s*Tests\s+(\d+) failed/im, // vitest
  /(\d+) failed(?:,| in|\s*$)/im, // pytest
  /(\d+) failing/i, // mocha
  /test result: FAILED\. \d+ passed; (\d+) failed/ // cargo
];
const COUNT_PASSED: RegExp[] = [/^ℹ pass (\d+)/m, /^# pass (\d+)/m, /Tests?:.*?(\d+) passed/i, /(\d+) passed/i, /(\d+) passing/i, /test result: \w+\. (\d+) passed/];

const REF = /((?:[A-Za-z]:)?[A-Za-z0-9_./\\@~-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|vue|svelte)):(\d+)(?::\d+)?/g;
const PY_REF = /File "([^"]+)", line (\d+)/g;

/** A path as it appears in output, made relative to the checkout it ran in. */
export function relativePath(p: string, root: string): string {
  let s = decodeURIComponent(p.replace(/^file:\/\/\/?/, '')).replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (r && s.toLowerCase().startsWith(r.toLowerCase() + '/')) s = s.slice(r.length + 1);
  return s.replace(/^\.\//, '').replace(/^\/+/, '');
}

export function parseTestOutput(output: string, root = ''): ParsedRun {
  const failed = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    for (const re of NAME_PATTERNS) {
      const m = re.exec(raw);
      if (m && m[1] && !SKIP_NAMES.test(m[1].trim()) && m[1].length < 300) { failed.add(m[1].trim()); break; }
    }
  }
  const num = (res: RegExp[]): number | null => {
    let best: number | null = null;
    for (const re of res) { const m = re.exec(output); if (m) best = Math.max(best ?? 0, Number(m[1])); }
    return best;
  };
  const refs: ParsedRun['refs'] = [];
  const seen = new Set<string>();
  const add = (f: string, l: string): void => {
    const rel = relativePath(f, root);
    const key = `${rel}:${l}`;
    if (!seen.has(key) && !/(^|\/)node_modules\//.test(rel) && !rel.startsWith('node:') && refs.length < 40) { seen.add(key); refs.push({ file: rel, line: Number(l) }); }
  };
  for (const m of output.matchAll(REF)) add(m[1], m[2]);
  for (const m of output.matchAll(PY_REF)) add(m[1], m[2]);
  const failedCount = num(COUNT_FAILED);
  return { failed: [...failed], failedCount: failedCount ?? (failed.size || null), passedCount: num(COUNT_PASSED), refs };
}

/** Did the run show a test failing? A non-zero exit with no failing test is something else: the code didn't compile, a script broke. */
export const showedFailure = (p: ParsedRun): boolean => (p.failedCount ?? 0) > 0 || p.failed.length > 0;

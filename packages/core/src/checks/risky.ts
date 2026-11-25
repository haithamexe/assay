import { isDemoPath, isTestPath, languageOf } from '../lang.js';
import type { Lens, Severity } from '../types.js';
import { clip, type Check, type RawFinding } from './types.js';

type L = string;
const JS: L[] = ['JavaScript', 'TypeScript', 'Vue', 'Svelte'];
const CODE: L[] = [...JS, 'Python', 'Go', 'Java', 'Kotlin', 'C#', 'PHP', 'Ruby', 'Rust', 'Swift', 'Scala'];

interface Rule {
  id: string;
  title: string;
  lens: Lens;
  severity: Severity;
  langs: L[];
  re: RegExp;
  say: string;
  maybe: string;
  ref?: string;
  /** The pattern lives in a comment (@ts-ignore): don't skip comment lines. */
  comment?: boolean;
  /** Only in test files. */
  tests?: boolean;
  /** At most this many per file per commit. */
  cap?: number;
  /** Not in test files. */
  prod?: boolean;
}

const SQL_VERB = /\b(?:SELECT\b.*\bFROM|INSERT\s+INTO|UPDATE\b.*\bSET|DELETE\s+FROM)\b/;
const TAGGED_SQL = /[\w$>]`\s*(?:SELECT|INSERT|UPDATE|DELETE)/;
const TAGGED_OPEN = /[\w$>]`\s*$/;
const SQL_INTERP = /\$\{[^}]+\}|\{[A-Za-z_][\w.]*\}|["']\s*\+\s*[A-Za-z_]|["']\s*%\s*[\w(]|\.format\(/;

const RULES: Rule[] = [
  { id: 'html-injection', title: 'Text may be inserted as HTML', lens: 'Security', severity: 'high', langs: JS, re: /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*\+?=|document\.write(?:ln)?\(|\bv-html\b|\{@html\b|insertAdjacentHTML\(/, say: 'now inserts markup as HTML', maybe: 'If any part of that value comes from a person or the network, script can run in a shopper’s session.', ref: 'CWE-79', prod: true },
  { id: 'html-injection-py', title: 'Text may be inserted as HTML', lens: 'Security', severity: 'medium', langs: ['Python'], re: /\bmark_safe\(|\bMarkup\(|\|\s*safe\b/, say: 'marks text as safe HTML', maybe: 'If the text can contain user input it is rendered unescaped.', ref: 'CWE-79', prod: true },
  { id: 'eval', title: 'Code is built and run from a string', lens: 'Security', severity: 'high', langs: ['JavaScript', 'TypeScript', 'PHP', 'Ruby'], re: /(?<![\w.$])eval\s*\(|new\s+Function\s*\(/, say: 'runs a string as code', maybe: 'If the string includes outside input this is remote code execution.', ref: 'CWE-95', prod: true },
  { id: 'eval-py', title: 'Code is built and run from a string', lens: 'Security', severity: 'high', langs: ['Python'], re: /(?<![\w.])(?:eval|exec)\s*\(/, say: 'runs a string as code', maybe: 'If the string includes outside input this is remote code execution.', ref: 'CWE-95', prod: true },
  { id: 'os-command', title: 'A shell command is run', lens: 'Security', severity: 'high', langs: ['JavaScript', 'TypeScript'], re: /(?<![\w.$])(?:exec|execSync)\s*\(|\bshell\s*:\s*true\b/, say: 'runs a command through a shell', maybe: 'If any argument comes from outside, it can inject commands.', ref: 'CWE-78', prod: true },
  { id: 'os-command-py', title: 'A shell command is run', lens: 'Security', severity: 'high', langs: ['Python'], re: /\bos\.(?:system|popen)\s*\(|\bshell\s*=\s*True\b/, say: 'runs a command through a shell', maybe: 'If any argument comes from outside, it can inject commands.', ref: 'CWE-78', prod: true },
  { id: 'os-command-other', title: 'A shell command is run', lens: 'Security', severity: 'high', langs: ['PHP', 'Go', 'Ruby'], re: /\b(?:shell_exec|passthru|system)\s*\(|exec\.Command\(\s*"(?:sh|bash|cmd)"/, say: 'runs a command through a shell', maybe: 'If any argument comes from outside, it can inject commands.', ref: 'CWE-78', prod: true },
  { id: 'tls-off', title: 'Certificate checking is turned off', lens: 'Security', severity: 'high', langs: CODE, re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true/, say: 'turns off TLS certificate checks', maybe: 'Anyone on the network path can impersonate the server.', ref: 'CWE-295', prod: true },
  { id: 'unsafe-deserialize', title: 'Data is turned back into objects unsafely', lens: 'Security', severity: 'high', langs: ['Python', 'PHP', 'Java'], re: /\bpickle\.loads?\(|\bmarshal\.loads\(|\bunserialize\(|\bObjectInputStream\b|\byaml\.load\((?![^)]*(?:Safe|CSafe)Loader)/, say: 'deserialises data that can run code', maybe: 'If the data comes from outside, loading it can execute code.', ref: 'CWE-502', prod: true },
  { id: 'sql-concat', title: 'A database query is built from text', lens: 'Security', severity: 'high', langs: [...CODE].filter(x => x !== 'Rust'), re: /(?!)/ /* never matches on its own: SQL_VERB and SQL_INTERP decide, in lineRules */, say: 'builds a query by joining text', maybe: 'If any part comes from outside, it can change what the query does.', ref: 'CWE-89', prod: true },
  { id: 'cors-any', title: 'Any website may call this API', lens: 'Security', severity: 'medium', langs: CODE, re: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']|\borigin\s*:\s*["']\*["']|allow_origins\s*=\s*\[\s*["']\*["']|AllowAnyOrigin/, say: 'allows every origin', maybe: 'With credentials or private data this lets any site read it.', ref: 'CWE-942', prod: true },
  { id: 'perm-777', title: 'A file is made writable by everyone', lens: 'Security', severity: 'medium', langs: [...CODE, 'Shell'], re: /chmod[^\n]*\b0?777\b|\b0o777\b/, say: 'sets mode 777', maybe: 'Any user on the machine can change that file.', ref: 'CWE-732', prod: true },
  { id: 'weak-hash', title: 'A weak hash is used', lens: 'Security', severity: 'medium', langs: CODE, re: /createHash\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"/i, say: 'uses MD5 or SHA-1', maybe: 'Fine for checksums, not for passwords or signatures.', ref: 'CWE-328', prod: true },
  { id: 'weak-random', title: 'A guessable random number may be used as a secret', lens: 'Security', severity: 'medium', langs: [...JS, 'Python'], re: /^(?=.*(?:Math\.random\(\)|\brandom\.(?:random|randint|choice)\())(?=.*(?:token|password|secret|nonce|session|\bkey\b))/i, say: 'builds a secret from a non-secure random source', maybe: 'Values from Math.random or random can be predicted.', ref: 'CWE-338', prod: true },
  { id: 'jwt-unchecked', title: 'A signed token may be accepted without checking the signature', lens: 'Security', severity: 'high', langs: CODE, re: /jwt\.decode\([^)]*verify\s*=\s*False|algorithms\s*[:=]\s*\[\s*["']none["']|ignoreExpiration\s*:\s*true/i, say: 'accepts a token without full verification', maybe: 'Anyone can forge a token that passes.', ref: 'CWE-347', prod: true },
  { id: 'debug-on', title: 'Debug mode is switched on', lens: 'Security', severity: 'low', langs: ['Python'], re: /^\s*DEBUG\s*=\s*True\b/, say: 'sets DEBUG = True', maybe: 'In production this leaks stack traces and settings.', ref: 'CWE-489', prod: true },
  { id: 'ts-suppress', title: 'Type checking is switched off here', lens: 'Correctness', severity: 'low', langs: ['TypeScript', 'JavaScript'], re: /@ts-nocheck|@ts-ignore/, say: 'switches off type checks', maybe: 'A real type error may be hidden.', comment: true, cap: 3 },
  { id: 'test-focus', title: 'A focused test hides the rest', lens: 'Tests', severity: 'medium', langs: CODE, re: /\b(?:it|test|describe|context)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(|@pytest\.mark\.only/, say: 'focuses a single test', maybe: 'Every other test in the file silently stops running.', tests: true },
  { id: 'test-skip', title: 'A test is switched off', lens: 'Tests', severity: 'low', langs: CODE, re: /\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|@Disabled\b|@Ignore\b/, say: 'disables a test', maybe: 'Whatever it checked is no longer checked.', tests: true, cap: 3 },
  { id: 'physical-css-side', title: 'A physical side is used where the layout may need to mirror', lens: 'UI', severity: 'low', langs: ['CSS', 'Vue', 'Svelte', 'HTML'], re: /(?:^|[;{\s])(?:left|right)\s*:\s*-?\d|\b(?:margin|padding|border)-(?:left|right)\s*:|\btext-align\s*:\s*(?:left|right)\b|\bfloat\s*:\s*(?:left|right)\b/, say: 'uses left or right', maybe: 'In a right-to-left language this can land on the wrong side. Logical properties (inset-inline-end) mirror by themselves.', cap: 3 }
];

const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|<!--)/;

/** A file that already uses logical properties (or says rtl) cares about mirroring, so a physical side in it is likely a slip. In a file that never mirrors, it's just CSS. */
const MIRROR_AWARE = /inline-(?:start|end)|(?:margin|padding|border|inset)-inline|:dir\(rtl\)|\[dir=["']?rtl|direction\s*:\s*rtl/i;

function lineRules(f: { path: string; hunks: Array<{ lines: Array<{ t: string; n: number | null; text: string }> }> }, read: () => string | null): RawFinding[] {
  const lang = languageOf(f.path);
  if (!lang) return [];
  const test = isTestPath(f.path);
  const demo = test || isDemoPath(f.path);
  const out: RawFinding[] = [];
  let aware: boolean | null = null;
  const count = new Map<string, { n: number; last: number }>();
  for (const r of RULES) {
    if (!r.langs.includes(lang)) continue;
    if (r.tests && !test) continue;
    if (r.prod && demo) continue;
    for (const h of f.hunks) for (let li = 0; li < h.lines.length; li++) {
      const l = h.lines[li];
      if (l.t !== '+' || l.n === null || l.text.length > 1500) continue;
      if (!r.comment && COMMENT.test(l.text)) continue;
      let hit = r.id === 'sql-concat' ? SQL_VERB.test(l.text) && SQL_INTERP.test(l.text) : r.re.test(l.text);
      // A tagged template (sql`…`, tx.$queryRaw`…`) turns each ${} into a bound parameter: it is the safe form, not the unsafe one.
      if (hit && r.id === 'sql-concat' && (TAGGED_SQL.test(l.text) || h.lines.slice(Math.max(0, li - 8), li).some(x => TAGGED_OPEN.test(x.text)))) hit = false;
      if (hit && r.id === 'physical-css-side') {
        aware ??= MIRROR_AWARE.test(read() ?? '');
        if (!aware) hit = false;
      }
      if (!hit) continue;
      const c = count.get(r.id) ?? { n: 0, last: -1 };
      c.n++;
      count.set(r.id, c);
      if (c.n > (r.cap ?? 3)) continue;
      out.push({
        check: 'risky', key: `${r.id}:${f.path}:${l.n}`, title: r.title, lens: r.lens, severity: r.severity, file: f.path, line: l.n, side: 'added', text: l.text,
        evidence: [{ kind: 'rule', source: `rule:${r.id}`, what: `Line ${l.n} ${r.say}: ${clip(l.text.trim(), 90)}` }],
        observed: [`Line ${l.n} ${r.say}.`], inferred: [r.maybe], ref: r.ref
      });
      c.last = out.length - 1;
    }
  }
  for (const r of RULES) {
    const c = count.get(r.id);
    const cap = r.cap ?? 3;
    if (c && c.n > cap && c.last >= 0) out[c.last].observed.push(`${c.n - cap} more line${c.n - cap > 1 ? 's' : ''} in this file match the same rule.`);
  }
  return out;
}

const GUARD = /^\s*(?:if|elif|else if|unless|guard)\b/;
const EXIT = /\b(?:raise|throw|return|abort|panic|exit|continue|break)\b/;
const ASSERT = /\b(?:expect|assert\w*|should|verify|XCTAssert\w*)\b\s*[.(]|\bt\.(?:Error|Fatal)f?\(|\brequire\.\w+\(/;
const ADDED_CHECK = /\b(?:if|raise|throw|guard|assert\w*|unless|panic)\b/;

/** Rules that need the whole hunk: a guard that disappeared, an assertion that disappeared. */
function hunkRules(f: { path: string; status: string; hunks: Array<{ lines: Array<{ t: string; o: number | null; n: number | null; text: string }> }> }): RawFinding[] {
  const lang = languageOf(f.path);
  if (!lang || f.status === 'deleted') return [];
  const test = isTestPath(f.path);
  const out: RawFinding[] = [];
  for (const h of f.hunks) {
    const removed = h.lines.filter(l => l.t === '-');
    const added = h.lines.filter(l => l.t === '+');
    if (!removed.length) continue;
    if (!test && CODE.includes(lang)) {
      const i = removed.findIndex((l, k) => GUARD.test(l.text) && removed.slice(k, k + 4).some(x => EXIT.test(x.text)));
      if (i !== -1 && !added.some(l => ADDED_CHECK.test(l.text))) {
        const g = removed[i];
        out.push({
          check: 'risky', key: `guard-removed:${f.path}:${g.o}`, title: 'A guard was removed', lens: 'Correctness', severity: 'medium', file: f.path, line: g.o ?? 1, side: 'removed', text: g.text,
          evidence: [{ kind: 'rule', source: 'rule:guard-removed', what: `Line ${g.o} was a check with an early exit (${clip(g.text.trim(), 70)}); nothing in this hunk replaces it.` }],
          observed: [`The check on old line ${g.o} was removed and the hunk adds no check of its own.`],
          inferred: ['An input that used to be turned away now reaches the code below it.'], ref: 'CWE-754'
        });
      }
    }
    if (test) {
      const i = removed.findIndex(l => ASSERT.test(l.text));
      if (i !== -1 && !added.some(l => ASSERT.test(l.text))) {
        const g = removed[i];
        out.push({
          check: 'risky', key: `assertion-removed:${f.path}:${g.o}`, title: 'An assertion was removed from a test', lens: 'Tests', severity: 'medium', file: f.path, line: g.o ?? 1, side: 'removed', text: g.text,
          evidence: [{ kind: 'rule', source: 'rule:assertion-removed', what: `Old line ${g.o} asserted something (${clip(g.text.trim(), 70)}); no assertion is added in its place.` }],
          observed: [`Old line ${g.o} checked a result and is gone; the hunk adds no assertion.`],
          inferred: ['The test may now pass whatever the code does.']
        });
      }
    }
  }
  return out;
}

export const risky: Check = ctx => {
  const out: RawFinding[] = [];
  for (const f of ctx.files) {
    if (f.binary) continue;
    out.push(...lineRules(f, () => ctx.read(f.path, 'commit')), ...hunkRules(f));
  }
  return out;
};

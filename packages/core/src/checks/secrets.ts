import { isDemoPath, isLockfile, isTestPath } from '../lang.js';
import { clip, type Check, type RawFinding } from './types.js';

/** The only way a matched secret reaches output, a log, a report or a case file (CLAUDE.md). */
export function maskSecret(s: string, keep = 4): string {
  const t = s.trim();
  return `${keep > 0 ? t.slice(0, keep) : ''}${keep > 0 ? '…' : '•••'}(${t.length} characters)`;
}

interface Pattern { id: string; name: string; re: RegExp; keep: number; group?: number }
const PATTERNS: Pattern[] = [
  { id: 'aws-key', name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, keep: 4 },
  { id: 'github-token', name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/, keep: 4 },
  { id: 'slack-token', name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, keep: 4 },
  { id: 'private-key', name: 'Private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, keep: 0 },
  { id: 'google-key', name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, keep: 4 },
  { id: 'stripe-live', name: 'Stripe live key', re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/, keep: 8 },
  { id: 'npm-token', name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/, keep: 4 },
  { id: 'url-credentials', name: 'Credentials inside a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:([^\s/@'"]{3,})@[^\s'"]+/i, keep: 0, group: 1 }
];
/** Group 1 is the name being assigned, group 2 the string literal. A name preceded by a dash is an HTML attribute (new-password), not a variable. */
const GENERIC = /(?<![-\w.])([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i;
/** A value that is only words joined by dashes or underscores is an attribute or a name ("current-password"), not a credential. */
const WORDY = /^[a-z]+(?:[-_.][a-z]+)+$/i;
const PLACEHOLDER = /^(?:pass(?:word)?|changeme|secret|example|x{3,}|\*+|<.*>|\$\{.*\}|\{\{.*\}\}|%s|\$\w+|\.\.\.)$/i;
const FAKE = /(?:example|changeme|your[_-]|xxxx|placeholder|dummy|sample|\*\*\*|<[a-z_ -]+>|\$[({A-Za-z_]|\{\{|process\.env|os\.environ|getenv|env\()/i;
const SECRET_FILE = /(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa|dsa)|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/;
const ENV_OK = /\.(?:example|sample|template|dist|defaults?)$/i;

function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** A line with every recognised secret replaced by its masked form. Applied to every snippet, so a secret next to some other finding never leaks either. */
export function redactSecrets(text: string): string {
  // A line that is nothing but a long run of base64 is the body of a key or a certificate: never kept, whatever is next to it.
  if (/^\s*[A-Za-z0-9+/=]{40,}\s*$/.test(text)) return maskSecret(text.trim(), 0);
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags.replace('g', '') + 'g'), m => {
      if (/example/i.test(m)) return m;
      if (p.group) { const v = new RegExp(p.re.source, p.re.flags).exec(m)?.[p.group]; return v ? m.replace(v, maskSecret(v, p.keep)) : m; }
      return maskSecret(m, p.keep);
    });
  }
  return out.replace(new RegExp(GENERIC.source, 'gi'), (m, _name: string, v: string) => (valueOk(v) ? m.replace(v, maskSecret(v, 0)) : m));
}

/** Random-looking, not a placeholder, not an attribute name. */
const valueOk = (v: string): boolean => !FAKE.test(v) && !WORDY.test(v) && entropy(v) >= 3;

/**
 * A password in a URL that points at this computer, a compose or cluster service name (one label, no dots) or a documentation address is a development default,
 * not a leak: nobody outside can reach that machine. Every URL with a password on the line must be like that. Found on real repositories, where each proven
 * hit of this kind was a local database in .env.example, a CI file or a test setup.
 */
function harmlessUrl(line: string): boolean {
  const hosts = [...line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{3,}@(\[[^\]]+\]|[^\s:/'"?#]+)/gi)].map(m => m[1].toLowerCase().replace(/^\[|\]$/g, ''));
  if (!hosts.length) return false;
  return hosts.every(h =>
    h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(h) ||
    /(?:^|\.)example(?:\.(?:com|org|net))?$/.test(h) || /\.(?:test|invalid)$/.test(h) ||
    /^[<{$%]/.test(h) || /^(?:host|hostname|server)$/.test(h) ||
    (/^[a-z0-9_-]+$/.test(h) && !/^\d+$/.test(h)));
}

export const secrets: Check = ctx => {
  const out: RawFinding[] = [];
  const whole = ctx.whole === true;
  for (const f of ctx.files) {
    if (f.binary || isLockfile(f.path) || /\.(?:map|snap)$/.test(f.path)) continue;
    if (f.status !== 'deleted') {
      const keyFile = SECRET_FILE.test(f.path);
      const envFile = ENV_FILE.test(f.path) && !ENV_OK.test(f.path);
      if (keyFile || envFile) {
        out.push({
          check: 'secrets', key: `file:${f.path}`, title: `${keyFile ? 'A key file' : 'A .env file'} ${whole ? 'is tracked' : 'was added'}: ${f.path.split('/').pop()}`,
          lens: 'Security', severity: 'high', file: f.path, line: 1, side: 'added', text: f.path,
          evidence: [{ kind: 'fact', source: 'fact:secret-file', what: keyFile ? 'A private key or certificate file is now in the repository.' : 'A .env file (usually holding real values) is now in the repository.' }],
          observed: [whole ? `${f.path} is tracked in git at this commit.` : `${f.path} is new in this commit.`, 'It stays in git history even if a later commit deletes it.'],
          inferred: ['If it holds real values they are readable by everyone with access to the repository. Rotate them, then remove the file.'], ref: 'CWE-798'
        });
      }
    }
    const test = isTestPath(f.path) || isDemoPath(f.path);
    for (const h of f.hunks) for (let li = 0; li < h.lines.length; li++) {
      const l = h.lines[li];
      if (l.t !== '+' || l.n === null || l.text.length > 2000) continue;
      let hit = false;
      for (const p of PATTERNS) {
        const m = p.re.exec(l.text);
        if (!m || /example/i.test(m[0])) continue;
        const value = p.group ? m[p.group] : m[0];
        if (p.group && (PLACEHOLDER.test(value) || FAKE.test(value))) continue;
        hit = true;
        // A key header with no key under it, or a token-shaped string in a test or example path, is very often a fixture:
        // it's a pattern, not a fact, so it's a hint until something else agrees.
        const headerOnly = p.id === 'private-key' && !h.lines.slice(li + 1, li + 4).some(x => x.t === '+' && /^[A-Za-z0-9+/=]{40,}$/.test(x.text.trim()));
        const localUrl = p.id === 'url-credentials' && harmlessUrl(l.text);
        const soft = test || headerOnly || localUrl;
        out.push({
          check: 'secrets', key: `${p.id}:${f.path}:${l.n}`, title: `${p.name} ${soft ? 'pattern in' : whole ? 'in' : 'added to'} ${f.path.split('/').pop()}`, lens: 'Security', severity: 'high',
          file: f.path, line: l.n, side: 'added', text: l.text,
          evidence: [soft
            ? { kind: 'rule', source: `rule:${p.id}`, what: `${p.name} pattern on line ${l.n}: ${maskSecret(value, p.keep)} (${headerOnly ? 'a header with no key under it' : localUrl && !test ? 'a local or example address' : 'in a test or example path'}: may be a fixture)` }
            : { kind: 'fact', source: `fact:${p.id}`, what: `${p.name} on line ${l.n}: ${maskSecret(value, p.keep)}` }],
          observed: [`Line ${l.n} ${whole ? 'has' : 'adds'} a ${p.name.toLowerCase()}: ${maskSecret(value, p.keep)}.`, ...(soft ? ['It sits in a test or example path, points at a local or example address, or has no key under it, so it may be a fixture.'] : [whole ? 'It is in git history: removing the line doesn’t take it out of earlier commits.' : 'It stays in git history even if a later commit removes it.'])],
          inferred: [soft ? 'Probably a fixture. If it is a real secret, rotate it and remove it.' : 'If it is live, anyone with read access to the repository has it. Rotate it, then remove it.'], ref: 'CWE-798'
        });
        break;
      }
      if (hit) continue;
      const g = GENERIC.exec(l.text);
      if (g && valueOk(g[2])) {
        const ev: RawFinding['evidence'] = [{ kind: 'rule', source: 'rule:generic-secret', what: `${clip(g[1], 24)} is assigned a string literal on line ${l.n}: ${maskSecret(g[2], 0)}` }];
        if (!test) ev.push({ kind: 'diff', source: 'diff:production-path', what: 'The file is not a test, fixture, example or doc.' });
        out.push({
          check: 'secrets', key: `generic:${f.path}:${l.n}`, title: `A secret-looking value is assigned in ${f.path.split('/').pop()}`, lens: 'Security', severity: 'high',
          file: f.path, line: l.n, side: 'added', text: l.text, evidence: ev,
          observed: [`Line ${l.n} assigns a string literal that looks like a credential: ${maskSecret(g[2], 0)}.`],
          inferred: ['It may be a real credential or a placeholder. The pattern alone can’t tell.'], ref: 'CWE-798'
        });
      }
    }
  }
  return out;
};

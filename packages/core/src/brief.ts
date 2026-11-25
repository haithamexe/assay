import { verdictOf } from './case.js';
import type { Case, Finding } from './types.js';

const FIX: Array<[RegExp, string]> = [
  [/^fact:secret-file/, 'Remove the file, rotate whatever it held (it is in history), and load it from the environment.'],
  [/^fact:/, 'Remove it, rotate it (it is in history), and load it from the environment.'],
  [/^rule:generic-secret/, 'If it is real, remove it and rotate it; if it is a placeholder, make that obvious.'],
  [/^rule:html-injection/, 'Render the value as text, not HTML.'],
  [/^rule:eval/, 'Don’t build code from strings; use a lookup table or a parser.'],
  [/^rule:os-command/, 'Pass an argument list, not a shell string.'],
  [/^rule:sql-concat/, 'Use a parameterised query.'],
  [/^rule:tls-off/, 'Turn certificate checking back on.'],
  [/^rule:unsafe-deserialize/, 'Use a data-only format (JSON) or a safe loader.'],
  [/^rule:guard-removed/, 'Put the check back, or show where it moved.'],
  [/^rule:assertion-removed/, 'Restore an assertion that checks the result.'],
  [/^rule:test-focus/, 'Remove the .only.'],
  [/^rule:test-skip/, 'Re-enable it, or say why it is off.'],
  [/^rule:name-distance/, 'Check this is the package you meant, then pin it.'],
  [/^rule:install-script/, 'Avoid install scripts, or review exactly what runs.'],
  [/^rule:unpinned-spec/, 'Pin it to a registry version.'],
  [/^rule:physical-css-side/, 'Use logical properties (inset-inline-end, margin-inline-start).'],
  [/^diff:no-test/, 'Add a test that fails without this change.'],
  [/^diff:test-deleted/, 'Restore the tests or show where they moved.'],
  [/^diff:new-dependency/, 'Confirm you need it and trust it.'],
  [/^memory:/, 'This project has fixed the same pattern before: do it the way those fixes did.']
];
const fixOf = (f: Finding): string => FIX.find(([re]) => f.evidence.some(e => re.test(e.source)))?.[1] ?? 'Fix it, or explain why it is fine.';
const line = (f: Finding, n: number): string => `${n}. ${f.title}. ${f.file}:${f.lines} (${f.commit.slice(0, 7)}). ${fixOf(f)} Replay: assay replay ${f.evidence[0]?.id ?? f.id}`;

/** What an agent receives: short on purpose. Evidence is named by id and replayed, never pasted. */
export function briefOf(c: Case, range?: string): string {
  const v = verdictOf(c);
  const parts = [`Fix brief: ${c.name}, ${c.commits.length} commit${c.commits.length > 1 ? 's' : ''} (${range ?? `${c.base?.slice(0, 7) ?? 'root'}..${c.head.slice(0, 7)}`})`, ''];
  if (v.must.length) parts.push('MUST FIX (proven, blocks the merge):', ...v.must.map((f, i) => line(f, i + 1)), '');
  if (v.should.length) parts.push('SHOULD FIX (proven, does not block):', ...v.should.map((f, i) => line(f, i + 1)), '');
  if (v.decide.length) parts.push('ASK THE PERSON (independent signals, not proof):', ...v.decide.map(f => `- ${f.title}. ${f.file}:${f.lines}. ${fixOf(f)}`), '');
  if (!v.must.length && !v.should.length && !v.decide.length) return `${parts[0]}\n\nNothing to fix. ${v.hints.length ? `${v.hints.length} hint${v.hints.length > 1 ? 's' : ''} left out: they are one signal each and can't block.` : ''}`.trim();
  parts.push('Do not touch anything else. After the fix, run: assay case (the same range) and check the verdict.');
  return parts.join('\n');
}

import type { Case, CommitSummary, Finding, LookReport, ProofReport, Verdict } from '@assay/core';

const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = (s: string): string => wrap('1', s);
export const dim = (s: string): string => wrap('2', s);
export const red = (s: string): string => wrap('31', s);
export const green = (s: string): string => wrap('32', s);
export const yellow = (s: string): string => wrap('33', s);
export const magenta = (s: string): string => wrap('35', s);

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const tierWord = (f: Finding, resolved?: string, present?: boolean): string => {
  if (resolved === 'dismissed') return dim(pad('dismissed', 12));
  if (resolved === 'intended') return dim(pad('intended', 12));
  if (present === false) return green(pad('fixed later', 12));
  return f.tier === 'proven' ? bold(magenta(pad('proven', 12))) : f.tier === 'corroborated' ? yellow(pad('corroborated', 12)) : dim(pad('hint', 12));
};
const sevWord = (s: string): string => (s === 'high' ? red(pad('high', 7)) : s === 'medium' ? yellow(pad('medium', 7)) : dim(pad('low', 7)));

export function verdictLine(v: Verdict): string {
  const head = v.tone === 'blocked' ? red(bold(v.headline)) : v.tone === 'mergeable' ? yellow(bold(v.headline)) : green(bold(v.headline));
  return `${head}\n  ${v.must.length} must fix · ${v.should.length} should fix · ${v.decide.length} to decide · ${v.hints.length} hint${v.hints.length === 1 ? '' : 's'}`;
}

export function caseText(c: Case, v: Verdict, all: boolean): string {
  const lines: string[] = [];
  lines.push(`${bold(c.name)}  ${dim(`${c.base ? c.base.slice(0, 7) : 'root'}..${c.head.slice(0, 7)} · ${c.commits.length} commit${c.commits.length > 1 ? 's' : ''} · ${c.files} files · ${c.languages.join(', ') || 'no code'}`)}`);
  lines.push('');
  lines.push(verdictLine(v));
  lines.push('');
  const shown = all ? c.findings : c.findings.slice(0, 10);
  if (!shown.length) lines.push(dim('  Nothing significant: no risky pattern, secret, dependency change or untested logic.'));
  shown.forEach((f, i) => {
    lines.push(`${pad(String(i + 1), 3)} ${tierWord(f, c.resolved[f.id], f.present)} ${sevWord(f.severity)} ${pad(clip(f.title, 54), 54)} ${dim(`${clip(f.file, 34)}:${f.lines}`)}`);
    lines.push(`    ${dim(`${f.id}  in ${f.commit.slice(0, 7)}  risk ${f.risk}`)}`);
  });
  if (c.findings.length > shown.length) lines.push(dim(`    … ${c.findings.length - shown.length} more (use --all)`));
  lines.push('');
  lines.push(dim(`Free checks, 0 tokens. Case ${c.id}.  assay show <id> · assay brief · assay report --open`));
  return lines.join('\n');
}

export function proofText(r: ProofReport): string {
  if (!r.ran) return `${bold('Proof')}  ${r.reason ?? 'nothing ran'}${r.stopped ? `\n  ${yellow(`Stopped: ${r.stopped}`)}` : ''}`;
  const l: string[] = [`${bold('Proof')}  ${r.command}  ${dim(`${r.secs} s`)}`];
  const run = (name: string, s: ProofReport['head']): string => (s ? `${name} ${s.timedOut ? yellow('timed out') : s.exit === 0 ? green('passed') : red('failed')} ${dim(`(${s.secs} s${s.cached ? ', from the cache' : ''})`)}` : `${name} ${dim('not run')}`);
  l.push(`  ${run('base', r.base)}   ${run('head', r.head)}`);
  if (r.regressions.length) l.push(`  ${red('regression')}  ${r.regressions.slice(0, 4).join('; ')}${r.regressions.length > 4 ? `; and ${r.regressions.length - 4} more` : ''}`);
  const cu = r.culprit;
  if (cu?.commit) l.push(`  first fail  ${red(cu.commit.slice(0, 7))}${cu.subject ? ` “${cu.subject}”` : ''}  ${dim(`(passed at ${cu.lastGood.slice(0, 7)}; found with ${cu.runs} run${cu.runs === 1 ? '' : 's'} of ${cu.commits} commits${cu.cached ? `, ${cu.cached} from the cache` : ''})`)}`);
  else if (cu) l.push(`  first fail  ${dim(`${cu.why ?? 'not found'}${cu.span > 1 && cu.span < cu.commits ? ` It is in one of the ${cu.span} commits after ${cu.lastGood.slice(0, 7)}.` : ''}`)}`);
  if (r.reverts.length) l.push(`  revert test  ${r.reverts.filter(x => x.result === 'unnoticed').length} of ${r.reverts.length} reverted hunks went unnoticed by the tests${r.reverts.some(x => x.result === 'skipped') ? dim(` (${r.reverts.filter(x => x.result === 'skipped').length} couldn’t be judged)`) : ''}`);
  const judged = r.mutants.filter(m => m.result === 'killed' || m.result === 'survived');
  if (r.mutants.length) l.push(`  mutation     ${judged.filter(m => m.result === 'killed').length} of ${judged.length} deliberate changes were noticed${r.mutants.some(m => m.result === 'invalid') ? dim(` (${r.mutants.filter(m => m.result === 'invalid').length} didn’t compile, not counted)`) : ''}`);
  if (r.behaviour) l.push(`  behaviour    ${r.behaviour.compared} function${r.behaviour.compared === 1 ? '' : 's'} compared before and after, ${r.behaviour.differ ? yellow(`${r.behaviour.differ} answer${r.behaviour.differ === 1 ? 's' : ''} differently`) : 'none answers differently'}${r.behaviour.functions.some(f => f.status === 'skipped') ? dim(` (${r.behaviour.functions.filter(f => f.status === 'skipped').length} skipped)`) : ''}`);
  if (r.reason) l.push(`  ${yellow(r.reason)}`);
  if (r.stopped) l.push(`  ${yellow(`Stopped: ${r.stopped}.`)} ${dim('Run it again: what was done is kept, so it picks up where it stopped.')}`);
  return l.join('\n');
}

export function lookText(r: LookReport): string {
  if (!r.ran) return `${bold('Browser')}  ${r.reason ?? 'nothing ran'}`;
  const l: string[] = [`${bold('Browser')}  ${r.browser} · ${r.mode === 'dev' ? 'the project’s dev server' : 'the HTML files as they are'}  ${dim(`${r.secs} s`)}`];
  l.push(`  looked at   ${r.pages.join(', ')}  ${dim(`(${r.combos} combinations of size, colour scheme, direction and Arabic text, at the head and at the base)`)}`);
  l.push(`  ${r.newProblems ? red('new problems') : green('new problems')}  ${r.newProblems} measured at the head that weren't there at the base`);
  if (r.probeHits) l.push(`  ${red('probe')}        ${r.probeHits} place${r.probeHits > 1 ? 's' : ''} where typed text became markup`);
  if (r.looksDifferent) l.push(`  looks       ${r.looksDifferent} page${r.looksDifferent > 1 ? 's' : ''} look different (before and after screenshots are in the report: assay report --open)`);
  if (r.reason) l.push(`  ${yellow(r.reason)}`);
  if (r.stopped) l.push(`  ${yellow(`Stopped: ${r.stopped}.`)}`);
  return l.join('\n');
}

export function timelineText(rows: CommitSummary[]): string {
  const out = [dim(`${pad('commit', 8)} ${pad('date', 10)} ${pad('files', 5)} ${pad('+/-', 11)} ${pad('findings', 30)} ${pad('risk', 4)} subject`)];
  for (const r of rows) {
    const f = [r.counts.proven ? red(`${r.counts.proven} proven`) : '', r.counts.corroborated ? yellow(`${r.counts.corroborated} corr`) : '', r.counts.hint ? dim(`${r.counts.hint} hint`) : ''].filter(Boolean).join(' ') || dim('—');
    out.push(`${pad(r.short, 8)} ${pad(r.date.slice(0, 10), 10)} ${pad(String(r.files), 5)} ${pad(`+${r.additions}/-${r.deletions}`, 11)} ${f}${' '.repeat(Math.max(1, 30 - f.replace(/\x1b\[[0-9;]*m/g, '').length))} ${pad(String(r.risk), 4)} ${clip(r.subject, 60)}`);
  }
  return out.join('\n');
}

export function findingText(c: Case, f: Finding): string {
  const l: string[] = [];
  l.push(`${bold(f.title)}`);
  l.push(`${tierWord(f, c.resolved[f.id], f.present).trim()} · ${f.severity} · ${f.lens} · ${f.file}:${f.lines} · ${f.commit.slice(0, 7)}${f.ref ? ` · ${f.ref}` : ''}`);
  l.push('');
  for (const t of f.observed) l.push(`  ${bold('observed')}  ${t}`);
  for (const t of f.inferred) l.push(`  ${bold('inferred')}  ${t}`);
  l.push(`  ${bold('ranks #')}   ${f.why.join(' · ')} (risk ${f.risk})`);
  l.push('');
  if (f.snippet.header) l.push(dim(f.snippet.header));
  for (const r of f.snippet.rows) {
    const mark = r.t === ' ' ? ' ' : r.t;
    const text = `${pad(String(r.o ?? ''), 4)} ${pad(String(r.n ?? ''), 4)} ${mark} ${r.text}`;
    l.push(r.sig ? bold(text) : r.t === '+' ? green(text) : r.t === '-' ? red(text) : dim(text));
  }
  l.push('');
  l.push(bold('evidence'));
  for (const e of f.evidence) l.push(`  ${dim(e.id)}  ${e.kind} · ${e.source}\n      ${e.what}${e.kind === 'claim' ? '' : `\n      ${dim(`assay replay ${e.id}`)}`}`);
  return l.join('\n');
}

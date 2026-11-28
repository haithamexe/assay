import type { Case, Checkup, CommitSummary, Finding, LookReport, ProofReport, TestReport, Verdict } from '@assay/core';
import type { AttackReport, GremlinsReplay, GremlinsReport, TryReport } from '@assay/core';
import { describeStep } from '@assay/core';

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
  for (const s of r.speed ?? []) {
    const ms = (n?: number): string => (n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
    const moved = [s.slower, s.heavier].filter(Boolean).join(', ');
    l.push(`  speed       ${s.page}  ${moved ? yellow(moved) : `largest paint ${ms(s.base.lcpMs)} → ${ms(s.head.lcpMs)}, ${dim('no clear change')}`}`);
  }
  if (r.translation) {
    const t = r.translation;
    l.push(`  languages   ${t.note ? dim(t.note) : `${t.files} translation file${t.files === 1 ? '' : 's'}${t.library ? ` (${t.library})` : ''}: ${t.texts} texts on the pages, ${t.untranslated ? yellow(`${t.untranslated} in no file`) : 'all of them in a file'} ${dim('(only new ones a changed line wrote are findings)')}`}`);
  }
  for (const p of r.calls ?? []) {
    l.push(`  underneath  ${p.page}  ${p.changes.slice(0, 3).map(ch => (ch.tone === 'worse' ? yellow(ch.text) : ch.text)).join('; ')}${p.changes.length > 3 ? dim(`; and ${p.changes.length - 3} more`) : ''}`);
  }
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

export function findingText(c: Pick<Case, 'resolved'>, f: Finding, replay: (id: string) => string = id => `assay replay ${id}`): string {
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
  for (const e of f.evidence) l.push(`  ${dim(e.id)}  ${e.kind} · ${e.source}\n      ${e.what}${e.kind === 'claim' ? '' : `\n      ${dim(replay(e.id))}`}`);
  return l.join('\n');
}

const sinceWord = (s: string): string => (s === 'new' ? red('new') : s === 'before' ? dim('already there') : '');
const list = (items: string[], max: number): string => (items.length > max ? `${items.slice(0, max).join(', ')} … ${items.length - max} more` : items.join(', '));

/** A checkup of the project as it is (project mode, D60). */
export function checkupText(c: Checkup, all: boolean): string {
  const l: string[] = [];
  l.push(`${bold(c.name)}  ${dim(`${c.branch ? `${c.branch} · ` : ''}${c.head.slice(0, 7)} · checkup ${c.id}`)}`);
  l.push('');
  const s = c.summary;
  l.push(s.tone === 'act' ? red(bold(s.headline)) : s.tone === 'decide' ? yellow(bold(s.headline)) : green(bold(s.headline)));
  l.push(`  ${s.proven} proven · ${s.corroborated} to decide · ${s.hints} hint${s.hints === 1 ? '' : 's'}`);
  l.push('');
  const shown = all ? c.findings : c.findings.slice(0, 10);
  if (!c.findings.length) l.push(dim('  No committed key, key file or .env file found.'));
  shown.forEach((f, i) => {
    l.push(`${pad(String(i + 1), 3)} ${tierWord(f)} ${sevWord(f.severity)} ${pad(clip(f.title, 50), 50)} ${dim(`${clip(f.file, 34)}:${f.line}`)}  ${sinceWord(f.since)}`);
    l.push(`    ${dim(f.id)}`);
  });
  if (c.findings.length > shown.length) l.push(dim(`    … ${c.findings.length - shown.length} more (use --all)`));
  if (c.gone.length) {
    l.push('');
    l.push(`${green('Gone')} since the last checkup`);
    for (const g of c.gone.slice(0, 8)) l.push(`  ${dim('✓')} ${clip(g.title, 60)}  ${dim(g.file)}`);
    if (c.gone.length > 8) l.push(dim(`  … ${c.gone.length - 8} more`));
  }
  l.push('');
  l.push(bold('Checked'));
  for (const k of c.checks) {
    l.push(`  ${pad(k.id, 10)} ${k.files} files in ${k.secs} s`);
    for (const n of k.notes) l.push(`  ${' '.repeat(10)} ${dim(n)}`);
  }
  const inv = c.inventory;
  if (inv) {
    l.push('');
    l.push(`${bold('What later checks will use')}  ${dim('(read from files only: nothing was loaded or called)')}`);
    l.push(`  ${pad('App', 10)} ${inv.url ?? dim('not given (--url http://localhost:3000)')}`);
    const loadable = inv.pages.filter(p => !p.dynamic);
    const dyn = inv.pages.length - loadable.length;
    l.push(`  ${pad('Pages', 10)} ${inv.pages.length ? `${inv.pages.length}${dyn ? dim(` (${dyn} need a value)`) : ''}: ${list(loadable.map(p => p.path), 8)}` : dim('none found (--pages "/,/cart", --har, --flow)')}`);
    l.push(`  ${pad('Endpoints', 10)} ${inv.endpoints.length ? `${inv.endpoints.length}: ${list(inv.endpoints.map(e => `${e.method} ${e.path}`), 6)}` : dim('none found (--openapi, --har)')}`);
    if (inv.flows.length) l.push(`  ${pad('Flows', 10)} ${inv.flows.map(f => `${f.name} (${f.steps} step${f.steps === 1 ? '' : 's'}${f.skipped ? `, ${f.skipped} left out` : ''})`).join(', ')}`);
    const from = [...new Set([...inv.pages.flatMap(p => p.from), ...inv.endpoints.flatMap(e => e.from)])];
    if (from.length) l.push(`  ${pad('Found by', 10)} ${from.join(', ')}${inv.frameworks.length ? dim(` · ${inv.frameworks.join(', ')}`) : ''}`);
    for (const n of inv.notes) l.push(`  ${' '.repeat(10)} ${dim(n)}`);
  }
  if (c.uncommitted) {
    l.push('');
    l.push(yellow(`${c.uncommitted} tracked file${c.uncommitted === 1 ? '' : 's'} changed and not committed: not part of this checkup.`) + dim(' assay case reviews a change.'));
  }
  l.push('');
  l.push(dim(`Read git only, ran nothing, 0 tokens.${c.previous ? ` Compared with ${c.previous.id} (${c.previous.head.slice(0, 7)}).` : ''}  assay show <id> · assay checkup --json`));
  return l.join('\n');
}

export function gremlinsText(r: GremlinsReport, all: boolean): string {
  const sev = (s: string): string => (s === 'high' ? red('high  ') : s === 'medium' ? yellow('medium') : dim('low   '));
  const where = r.mode === 'running' ? r.url : `${r.commit.slice(0, 7)}${r.base ? ` against ${r.base.slice(0, 7)}` : ''}`;
  const fresh = r.findings.filter(f => f.since === 'new').length;
  const l: string[] = [`${bold('Gremlins')}  ${where}  ${r.findings.length ? red(`${r.findings.length} found`) : green('nothing broke')}${r.previous && r.findings.length ? ` · ${fresh} new` : ''}  ${dim(`${r.actions}/${r.planned} actions · seed ${r.seed} · ${r.phone ? 'phone' : 'desktop'}${r.signedIn ? ' · signed in' : ''} · ${r.secs} s · ${r.id}`)}`];
  const max = all ? 100 : 8;
  for (const f of r.findings.slice(0, max)) {
    l.push('', `  ${sev(f.severity)} ${f.title}${f.count > 1 ? dim(` ×${f.count}`) : ''}${f.since === 'new' ? `  ${yellow('new')}` : f.since === 'before' ? `  ${dim('there before')}` : ''}${f.where ? `  ${dim(f.where)}` : ''}  ${dim(f.id)}`, `    ${dim('saw')} ${f.text}`);
    const last = f.steps.slice(-5);
    l.push(`    ${dim('after')} ${last.map(describeStep).join(dim('  →  '))}${f.steps.length > last.length ? dim(`  (the last 5 of ${f.step})`) : ''}`);
    if (all) l.push(`    ${f.fix}`);
  }
  if (r.findings.length > max) l.push('', dim(`  … ${r.findings.length - max} more (--all)`));
  if (r.previous) {
    l.push('', `  ${dim(`compared with ${r.previous.id} (seed ${r.previous.seed}${r.previous.seed === r.seed ? ', the same' : ', another: a problem that isn’t here now may only not have been reached'})`)}`);
    if (r.gone.length) l.push(`  ${green(`${r.gone.length} gone`)}  ${r.gone.slice(0, 4).map(g => g.text.slice(0, 50)).join(' · ')}`);
  }
  if (r.before) l.push('', `  ${dim(`${r.before} problem${r.before === 1 ? '' : 's'} the same seed met at ${r.base!.slice(0, 7)} too, not counted`)}`);
  if (r.skipped.length) l.push('', `  ${dim('left alone (look destructive)')}  ${r.skipped.slice(0, 8).join(' · ')}`);
  if (r.blocked.length) l.push(`  ${dim('refused to talk to')}  ${r.blocked.slice(0, 6).join(' · ')}`);
  for (const n of r.notes.filter(x => !/^The same seed was run|^The browser refused/.test(x))) l.push(`  ${dim(n)}`);
  if (r.stopped) l.push(`  ${dim(`stopped: ${r.stopped}`)}`);
  l.push('', `  ${dim('again with the same seed:')} ${r.replay}`);
  return l.join('\n');
}

export function gremlinsListText(runs: GremlinsReport[]): string {
  if (!runs.length) return 'No gremlins runs kept yet. assay gremlins --url http://localhost:3000';
  return runs.map(r => {
    const fresh = r.findings.filter(f => f.since === 'new').length;
    return `${r.id}  ${r.createdAt.slice(0, 16).replace('T', ' ')}  ${(r.mode === 'running' ? r.url : r.commit.slice(0, 7)) ?? ''}  seed ${r.seed}  ${r.findings.length ? red(`${r.findings.length} found`) : green('clear')}${fresh ? ` ${yellow(`${fresh} new`)}` : ''}`;
  }).join('\n');
}

export function replayText(r: GremlinsReplay): string {
  const l = [`${bold('Replay')}  ${r.run} on ${r.where}  ${r.reproduced ? red('the problem came back') : green('the problem did not come back')}`, `  ${dim('problem')} ${r.finding.title}: ${r.finding.text}`, `  ${dim(`${r.done} steps done${r.missing ? `, ${r.missing} could not be` : ''}`)}`];
  const other = r.seen.filter(s => s.id !== r.finding.id);
  if (other.length) l.push(`  ${dim('also seen')} ${other.slice(0, 4).map(s => `${s.kind}: ${s.text.slice(0, 60)}`).join(' · ')}`);
  for (const n of r.notes) l.push(`  ${dim(n)}`);
  return l.join('\n');
}

export function tryText(r: TryReport): string {
  const t = r.target;
  const verdict = r.verdict === 'breaks' ? red('breaks something') : r.verdict === 'changes' ? yellow('changes how the app looks or behaves') : r.verdict === 'same' ? green('nothing changed that Assay can see') : yellow('could not be compared');
  const l: string[] = [`${bold('Try')}  ${t.name} ${t.from ?? '?'} → ${t.to}${t.major ? yellow('  (a major version)') : ''}  ${verdict}  ${dim(`${r.pm} · ${r.commit.slice(0, 7)} · ${r.secs} s`)}`, ''];
  for (const s of r.summary) l.push(`  ${r.verdict === 'breaks' && !/^Nothing/.test(s) ? red('●') : /^Nothing/.test(s) ? green('●') : yellow('●')} ${s}`);
  const rows = r.checks.map(c => `${c.name.padEnd(6)} ${c.before ? (c.before.ok ? 'passes' : 'fails ') : '  -   '} → ${c.after ? (c.after.ok ? 'passes' : 'fails ') : '  -   '}${c.after?.failed ? `  ${c.after.failed} failing` : ''}`);
  if (rows.length) l.push('', ...rows.map(x => `  ${dim(x)}`));
  if (r.pages.length) l.push('', `  ${dim(`pages compared: ${r.pages.map(p => p.path).join(', ')}`)}`);
  for (const c of r.checks) for (const e of (c.after?.errors ?? []).filter(x => !(c.before?.errors ?? []).includes(x)).slice(0, 5)) l.push(`  ${dim(`${c.name}:`)} ${e}`);
  for (const n of r.notes) l.push(`  ${dim(n)}`);
  return l.join('\n');
}

export function attackText(r: AttackReport, all: boolean): string {
  const proven = r.findings.filter(f => f.tier === 'proven');
  const hints = r.findings.filter(f => f.tier !== 'proven');
  const sev = (s: string): string => (s === 'high' ? red('high  ') : s === 'medium' ? yellow('medium') : dim('low   '));
  const l: string[] = [`${bold('Attack')}  ${r.url}  ${proven.length ? red(`${proven.length} proven`) : green('nothing proven')}${hints.length ? ` · ${hints.length} to look at` : ''}  ${dim(`${r.requests} requests · ${r.secs} s · ${r.writes ? 'reads and writes' : 'reads only'}`)}`, `  ${dim(`endpoints read from ${r.commit.slice(0, 7)}; the app is whatever is running at that address now`)}`];
  const show = (list: AttackReport['findings'], max: number): void => {
    for (const f of list.slice(0, max)) {
      l.push('', `  ${sev(f.severity)} ${f.title}${f.where ? `  ${dim(f.where)}` : ''}`, `    ${dim('shown by')} ${f.proof}`, `    ${f.fix}`);
    }
    if (list.length > max) l.push('', dim(`  … ${list.length - max} more (--all)`));
  };
  show(proven, all ? 100 : 8);
  if (hints.length) { l.push('', `  ${bold('To look at')} ${dim('(it depends on what was meant)')}`); show(hints, all ? 100 : 4); }
  if (r.tried.length) l.push('', `  ${dim('tried')}  ${r.tried.join(' · ')}`);
  for (const s of r.skipped) l.push(`  ${dim('not tried')}  ${s}`);
  return l.join('\n');
}

export function testText(r: TestReport, all: boolean): string {
  const where = r.where === 'here' ? `your folder${r.uncommitted ? `, ${r.uncommitted} uncommitted file${r.uncommitted === 1 ? '' : 's'} included` : ''}` : `a clean copy of ${r.commit.slice(0, 7)}`;
  const n = (v: number | null, word: string): string => (v === null ? '' : `${v} ${word}`);
  const counts = [n(r.passed, 'passed'), r.failed ? red(`${r.failed} failed`) : n(r.failed, 'failed'), r.skipped ? n(r.skipped, 'skipped') : ''].filter(Boolean).join(' · ');
  const l: string[] = [`${bold('Tests')}  ${r.ok ? green('passed') : red('failed')}  ${counts || dim('no counts in the output')}  ${dim(`${r.secs} s`)}`, `  ${dim(`${r.command || 'no command'} · ${where}`)}`];
  if (r.error) l.push(`  ${yellow(r.error)}`);
  const shown = all ? r.failures : r.failures.slice(0, 8);
  for (const f of shown) {
    l.push('', `  ${red('✗')} ${f.name}${f.file ? `  ${dim(`${f.file}${f.line ? `:${f.line}` : ''}`)}` : ''}`);
    const msg = f.message.split('\n').slice(0, all ? 12 : 3).join('\n    ');
    if (msg && msg !== 'failed') l.push(`    ${msg}`);
    if (f.expected !== undefined || f.actual !== undefined) l.push(`    ${dim('expected')} ${f.expected ?? '?'}   ${dim('actual')} ${f.actual ?? '?'}`);
  }
  if (r.failures.length > shown.length) l.push('', dim(`  … ${r.failures.length - shown.length} more failures (--all)`));
  if (!r.ok && !r.failures.length && r.outputTail.length) l.push('', dim('  The last lines it printed:'), ...r.outputTail.slice(-12).map(x => `    ${x}`));
  if (r.coverage) {
    const c = r.coverage;
    const extra = [c.branches !== undefined ? `branches ${c.branches}%` : '', c.functions !== undefined ? `functions ${c.functions}%` : ''].filter(Boolean).join(' · ');
    l.push('', `  ${bold('Coverage')}  ${c.lines}% of lines${extra ? ` · ${extra}` : ''}  ${dim(`(${c.fileCount} file${c.fileCount === 1 ? '' : 's'})`)}`);
    if (c.note) l.push(`    ${dim(c.note)}`);
    const low = c.files.filter(f => f.lines < 100).slice(0, all ? 15 : 5);
    if (low.length) l.push(`    ${dim('least covered')}  ${low.map(f => `${f.file} ${f.lines}%`).join(' · ')}`);
  } else if (r.coverageNote) l.push('', `  ${bold('Coverage')}  ${yellow(r.coverageNote)}`);
  for (const note of r.notes) l.push(`  ${dim(note)}`);
  return l.join('\n');
}

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyClaims, briefOf, cap, runCheckup, findingById, isAllowed, isOpen, loadCase, lookCase, memory, openCase, proveCase, replayEvidence, resolveFinding, repoRoot, reviewers, runAttack, runTry, runGremlins, describeStep, sessionFromEnv, runTests, saveCase, timeline, verdictOf } from '@assay/core';
import type { AttackReport, GremlinsReport, TryReport, Case, Checkup, Claim, Finding, LookReport, ProofReport, TestReport } from '@assay/core';

export const INSTRUCTIONS = `assay reviews code changes with evidence, not opinion. Use it after you change code and before you say you are done.
1. case_open (no arguments reviews this branch since it left main). Read the verdict.
2. If it says Blocked, fix the MUST FIX items (brief is the short list; finding_get shows the lines and the evidence), then call case_open again. Do not say the work is done while it says Blocked.
3. A tier is computed from evidence. Only proven findings block. A hint is one signal: look at it, don't obey it.
4. If you are reviewing as a reviewer, report with finding_submit. Every claim must cite a file and a line inside the diff, or it is dropped. You can't claim proof: Assay runs the checks that produce proof.
5. You can dismiss a hint or a corroborated finding with finding_resolve. You can't dismiss a proven one: a person can (assay resolve).
6. case_open only reads the diff, so almost nothing in it is proven. prove runs the project's own tests at the base and the head and tries reverting and mutating the change: that is what proves a regression or an untested change. It works only if a person turned it on with assay allow-run (you can't). Use it before you say done on a risky change. It stops at a time budget and picks up where it stopped when you call it again.
7. For anything a person sees in a browser, call look: it opens the pages in a real browser at the base and at the head, in 12 combinations of size, colour scheme, direction and Arabic text, and reports only what is new at the head: overlapping or cut-off content, unreadable text, a page that scrolls sideways, uncaught errors, failed requests, and text typed into the page that becomes markup (an XSS probe). Each is measured, so it is proven, and it points at the changed line that caused it. Same permission as prove (assay allow-run).
8. memory tells you what this project has got wrong before and what a reviewer should ask that no check can decide. Call it with the case id before you review by reading: it lists the remembered mistakes the findings match, and the questions worth asking for the case's languages. It is read only: you can't add, switch off or forget anything, a person does that.
9. Reviewers cost tokens, so use them only when a person asks for them or has set a budget. reviewers_plan shows who is worth running and what it costs, and spends nothing. If a person says go, start one sub-agent per reviewer it lists, in parallel, each told only to call reviewer_brief for its lens and follow it; never show reviewers each other's output. Each reports with finding_submit (done: true). When reviewers_plan says cross-examination is open, start the examiners it names the same way (round 2). Then read the verdict again. What reviewers find is at best corroborated: it asks for a look, it never blocks.
10. checkup looks at the project as it is, not at a change: what is wrong in the committed files now (keys, key files, .env files), each marked new or already there since the last checkup, and the pages, endpoints and flows the project's files describe (plus a HAR, flow or OpenAPI file and the app's local address, when given). It reads git and runs nothing. Use case_open for a change; use checkup for "is this project OK".
11. test runs the project's own tests once, at a commit (HEAD by default) in a clean copy, and says what failed with the file, line, expected and actual; coverage: true adds how much of the code they ran. Same permission as prove (assay allow-run). here: true runs them in the person's folder, uncommitted work included, only if a person also ran assay allow-run --here. Use it to check your work; use prove to judge a change.
12. attack tries the usual security weaknesses against the app running on this computer at an address you are given (headers, cookies, CORS, script in the address, error answers; with writes, also saved script, CSRF and wrong passwords). It reads by default; writes needs the person’s own assay allow-run --writes. What it finds is observed in a response, so a proven finding is real; a hint depends on what was meant.
13. gremlins sends a headless browser through the app clicking and typing nonsense, seeded so a run can be done again; each problem comes with the steps that led to it. It changes data, so it needs the person’s own assay allow-run --writes. Give url for a running app, or let it start the project’s app from a clean copy of ref (with base, only what is new is reported).
14. try installs a new version of one dependency in a throwaway copy and reports what breaks (type check, build, tests, pages) before anyone upgrades. It needs the person’s own assay allow-run --network, and never runs install scripts.
Answers are short on purpose. Ask for one finding to see its lines and evidence.`;

const KINDS = ['fact', 'test-fail', 'probe', 'behaviour-diff', 'measurement', 'mutation-survivor', 'revert-test', 'rule', 'diff', 'history', 'registry', 'scope', 'claim'] as const;
const LENSES = ['Security', 'Correctness', 'UI', 'Tests', 'Supply chain', 'Scope', 'Performance'] as const;

const text = (t: string, structured?: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: cap(t, 6000) }], ...(structured ? { structuredContent: structured } : {}) });
const fail = (msg: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: msg }] });

function must<T>(v: T | null | undefined, msg: string): T {
  if (v === null || v === undefined) throw new Error(msg);
  return v;
}
const getCase = (id: string): Case => must(loadCase(id), `No case ${id}. Call case_open first.`);

const line = (f: Finding, c: Case): string => `${f.id}  ${f.severity.padEnd(6)} ${f.tier.padEnd(12)} ${f.title}  ${f.file}:${f.lines}${f.present === false ? '  (fixed later in the range)' : ''}${c.resolved[f.id] ? `  (${c.resolved[f.id]})` : ''}`;

function summary(c: Case, hints: boolean): { text: string; data: Record<string, unknown> } {
  const v = verdictOf(c);
  const parts = [
    `${c.name} · ${c.commits.length} commit${c.commits.length > 1 ? 's' : ''} · ${c.files} files · ${c.languages.join(', ') || 'no code'}`,
    v.headline,
    `${v.must.length} must fix · ${v.should.length} should fix · ${v.decide.length} to decide · ${v.hints.length} hint${v.hints.length === 1 ? '' : 's'}`,
    `Case ${c.id}. Free checks, 0 tokens.`,
    c.runs.length ? `Proof: ${c.runs.map(r => r.summary).join(' · ')}` : 'Proof: none yet. These checks only read the diff; prove runs the project’s tests (if a person allowed it).'
  ];
  const block = (title: string, list: Finding[], max: number): void => {
    if (!list.length) return;
    parts.push('', title, ...list.slice(0, max).map(f => `  ${line(f, c)}`));
    if (list.length > max) parts.push(`  … ${list.length - max} more (case_findings)`);
  };
  block('MUST FIX (proven, blocks the merge)', v.must, 8);
  block('SHOULD FIX (proven)', v.should, 6);
  block('TO DECIDE (independent signals, not proof)', v.decide, 8);
  if (hints) block('HINTS (one signal each, can’t block)', v.hints, 8);
  parts.push('', v.tone === 'blocked' ? 'Next: fix the MUST FIX items (brief), then case_open again.' : v.tone === 'mergeable' ? 'Next: look at TO DECIDE; finding_get shows lines and evidence.' : 'Nothing blocks.');
  return { text: parts.join('\n'), data: { case: c.id, tone: v.tone, headline: v.headline, must: v.must.length, should: v.should.length, decide: v.decide.length, hints: v.hints.length, findings: [...v.must, ...v.should, ...v.decide].slice(0, 20).map(f => ({ id: f.id, tier: f.tier, severity: f.severity, title: f.title, file: f.file, line: f.line })) } };
}

function tryLines(r: TryReport): { text: string; data: Record<string, unknown> } {
  const t = r.target;
  const parts = [`${t.name} ${t.from ?? '?'} → ${t.to}${t.major ? ' (major)' : ''}: ${r.verdict === 'breaks' ? 'breaks something' : r.verdict === 'changes' ? 'changes how the app looks or behaves' : r.verdict === 'same' ? 'nothing changed that Assay can see' : 'could not be compared'} · ${r.pm} · ${r.secs} s`];
  for (const s of r.summary.slice(0, 10)) parts.push(`- ${s.slice(0, 260)}`);
  if (r.summary.length > 10) parts.push(`… ${r.summary.length - 10} more (the JSON from assay try --json has them all)`);
  for (const n of r.notes.slice(0, 3)) parts.push(`Note: ${n.slice(0, 220)}`);
  return { text: parts.join('\n'), data: { schema: r.schema, package: t.name, from: t.from ?? null, to: t.to, major: t.major, verdict: r.verdict, summary: r.summary.slice(0, 20), checks: r.checks.map(c => ({ name: c.name, before: c.before?.ok ?? null, after: c.after?.ok ?? null })), pages: r.pages.map(p => p.path) } };
}

function gremlinsLines(r: GremlinsReport): { text: string; data: Record<string, unknown> } {
  const where = r.mode === 'running' ? r.url : `${r.commit.slice(0, 7)}${r.base ? ` against ${r.base.slice(0, 7)}` : ''}`;
  const fresh = r.findings.filter(f => f.since === 'new').length;
  const parts = [`${where}: ${r.findings.length} found${r.previous ? ` (${fresh} new since ${r.previous.id})` : ''}${r.signedIn ? ' · signed in' : ''} · run ${r.id}${r.before ? ` (${r.before} met at the base too, not counted)` : ''} · ${r.actions}/${r.planned} actions · seed ${r.seed}`];
  for (const f of r.findings.slice(0, 8)) {
    parts.push('', `${f.severity.toUpperCase()} ${f.title}${f.count > 1 ? ` ×${f.count}` : ''}${f.where ? `  (${f.where})` : ''}`, `  saw: ${f.text.slice(0, 220)}`, `  after: ${f.steps.slice(-5).map(describeStep).join(' → ').slice(0, 300)}`);
  }
  if (r.findings.length > 8) parts.push('', `… ${r.findings.length - 8} more findings (the JSON from assay gremlins --json has them all)`);
  if (r.blocked.length) parts.push('', `Refused to talk to: ${r.blocked.slice(0, 6).join(', ')}`);
  parts.push('', `Again with the same seed: ${r.replay}`);
  return { text: parts.join('\n'), data: { schema: r.schema, mode: r.mode, seed: r.seed, actions: r.actions, run: r.id, signedIn: r.signedIn, findings: r.findings.slice(0, 20).map(f => ({ id: f.id, kind: f.kind, severity: f.severity, tier: f.tier, title: f.title, step: f.step, since: f.since ?? null, where: f.where ?? null })), gone: r.gone.length, before: r.before, replay: r.replay } };
}

function attackLines(r: AttackReport): { text: string; data: Record<string, unknown> } {
  const proven = r.findings.filter(f => f.tier === 'proven');
  const parts = [`${r.url}: ${proven.length} proven, ${r.findings.length - proven.length} to look at · ${r.requests} requests · ${r.writes ? 'reads and writes' : 'reads only'}`];
  for (const f of r.findings.slice(0, 8)) parts.push('', `${f.severity.toUpperCase()} ${f.tier} ${f.title}${f.where ? `  (${f.where})` : ''}`, `  shown by: ${f.proof}`, `  fix: ${f.fix.slice(0, 220)}`);
  if (r.findings.length > 8) parts.push('', `… ${r.findings.length - 8} more findings (the JSON from assay attack --json has them all)`);
  if (r.skipped.length) parts.push('', `Not tried: ${r.skipped.join(' · ').slice(0, 600)}`);
  return { text: parts.join('\n'), data: { schema: r.schema, url: r.url, writes: r.writes, proven: proven.length, findings: r.findings.slice(0, 20).map(f => ({ id: f.id, check: f.check, severity: f.severity, tier: f.tier, title: f.title, where: f.where ?? null })), requests: r.requests } };
}

function testLines(r: TestReport): { text: string; data: Record<string, unknown> } {
  const where = r.where === 'here' ? `the folder${r.uncommitted ? ` (${r.uncommitted} uncommitted files included)` : ''}` : `a clean copy of ${r.commit.slice(0, 7)}`;
  const parts = [`${r.ok ? 'Passed' : 'Failed'}: ${[r.passed !== null ? `${r.passed} passed` : '', r.failed !== null ? `${r.failed} failed` : '', r.skipped ? `${r.skipped} skipped` : ''].filter(Boolean).join(', ') || 'no counts in the output'} · ${r.secs} s`, `${r.command} in ${where}`];
  if (r.error) parts.push(r.error);
  for (const f of r.failures.slice(0, 8)) {
    parts.push('', `✗ ${f.name}${f.file ? `  ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`, `  ${f.message.split('\n').slice(0, 3).join(' / ')}`);
    if (f.expected !== undefined || f.actual !== undefined) parts.push(`  expected ${f.expected ?? '?'}  actual ${f.actual ?? '?'}`);
  }
  if (r.failures.length > 8) parts.push(`… ${r.failures.length - 8} more failures (match: one test name to see it)`);
  if (!r.ok && !r.failures.length && r.outputTail.length) parts.push('', 'Last lines printed:', ...r.outputTail.slice(-8));
  if (r.coverage) parts.push('', `Coverage: ${r.coverage.lines}% of lines over ${r.coverage.fileCount} files. Least covered: ${r.coverage.files.filter(f => f.lines < 100).slice(0, 5).map(f => `${f.file} ${f.lines}%`).join(', ') || 'none under 100%'}`);
  else if (r.coverageNote) parts.push('', `Coverage: ${r.coverageNote}`);
  parts.push(...r.notes);
  return { text: parts.join('\n'), data: { ok: r.ok, passed: r.passed, failed: r.failed, skipped: r.skipped, where: r.where, commit: r.commit, framework: r.framework, failures: r.failures.slice(0, 20).map(f => ({ name: f.name, file: f.file ?? null, line: f.line ?? null })), coverage: r.coverage ? { lines: r.coverage.lines, files: r.coverage.files.slice(0, 10) } : null } };
}

function checkupLines(c: Checkup): { text: string; data: Record<string, unknown> } {
  const s = c.summary;
  const parts = [`${c.name} · ${c.head.slice(0, 7)}${c.branch ? ` (${c.branch})` : ''} · checkup ${c.id}`, s.headline, `${s.proven} proven · ${s.corroborated} to decide · ${s.hints} hint${s.hints === 1 ? '' : 's'}`];
  const top = c.findings.filter(f => f.tier !== 'hint').slice(0, 10);
  if (top.length) parts.push('', ...top.map(f => `  ${f.id}  ${f.severity.padEnd(6)} ${f.tier.padEnd(12)} ${f.title}  ${f.file}:${f.line}  ${f.since === 'new' ? 'NEW' : f.since === 'before' ? 'already there' : ''}`.trimEnd()));
  if (c.findings.length > top.length) parts.push(`  … ${c.findings.length - top.length} more (assay checkup --all)`);
  if (c.gone.length) parts.push('', `Gone since the last checkup: ${c.gone.slice(0, 5).map(g => g.title).join('; ')}${c.gone.length > 5 ? ` and ${c.gone.length - 5} more` : ''}`);
  const inv = c.inventory;
  if (inv) {
    const loadable = inv.pages.filter(p => !p.dynamic);
    parts.push('', `App: ${inv.url ?? 'no address given'}`,
      `Pages: ${inv.pages.length} (${loadable.slice(0, 10).map(p => p.path).join(', ')}${loadable.length > 10 ? ' …' : ''})${inv.pages.length > loadable.length ? `, ${inv.pages.length - loadable.length} need a value` : ''}`,
      `Endpoints: ${inv.endpoints.length}${inv.endpoints.length ? ` (${inv.endpoints.slice(0, 8).map(e => `${e.method} ${e.path}`).join(', ')}${inv.endpoints.length > 8 ? ' …' : ''})` : ''}`);
    if (inv.flows.length) parts.push(`Flows: ${inv.flows.map(f => `${f.name} (${f.steps} steps)`).join(', ')}`);
    for (const n of inv.notes.slice(0, 4)) parts.push(`Note: ${n}`);
  }
  if (c.uncommitted) parts.push('', `${c.uncommitted} tracked file${c.uncommitted === 1 ? '' : 's'} changed and not committed: not part of this checkup (case_open reviews a change).`);
  parts.push('', 'Read git only, ran nothing, 0 tokens. The lines and evidence of one finding: a person runs  assay show <id>.');
  return {
    text: parts.join('\n'),
    data: { checkup: c.id, schema: c.schema, tone: s.tone, headline: s.headline, proven: s.proven, corroborated: s.corroborated, hints: s.hints, new: s.new, before: s.before, gone: s.gone,
      findings: top.map(f => ({ id: f.id, key: f.key, tier: f.tier, severity: f.severity, title: f.title, file: f.file, line: f.line, since: f.since })),
      pages: inv?.pages.length ?? null, endpoints: inv?.endpoints.length ?? null, flows: inv?.flows.length ?? null }
  };
}

function proofLines(r: ProofReport): string {
  if (!r.ran) return `Proof did not run: ${r.reason ?? 'nothing ran'}${r.stopped ? ` (${r.stopped})` : ''}`;
  const run = (name: string, s: ProofReport['head']): string => (s ? `${name} ${s.timedOut ? 'timed out' : s.exit === 0 ? 'passed' : 'failed'} (${s.secs} s${s.cached ? ', cached' : ''})` : `${name} not run`);
  const l = [`Proof: ${r.command} · ${run('base', r.base)} · ${run('head', r.head)}`];
  if (r.regressions.length) l.push(`Regression: ${r.regressions.slice(0, 4).join('; ')}`);
  const cu = r.culprit;
  if (cu?.commit) l.push(`First failing commit: ${cu.commit.slice(0, 7)}${cu.subject ? ` “${cu.subject}”` : ''}; the tests passed at ${cu.lastGood.slice(0, 7)} (found with ${cu.runs} run${cu.runs === 1 ? '' : 's'} of ${cu.commits} commits)`);
  else if (cu) l.push(`First failing commit: not found. ${cu.why ?? ''}${cu.span > 1 && cu.span < cu.commits ? ` It is in one of the ${cu.span} commits after ${cu.lastGood.slice(0, 7)}.` : ''}`.trim());
  if (r.reverts.length) l.push(`Revert test: ${r.reverts.filter(x => x.result === 'unnoticed').length} of ${r.reverts.length} reverted hunks went unnoticed by the tests`);
  const judged = r.mutants.filter(m => m.result === 'killed' || m.result === 'survived');
  if (r.mutants.length) l.push(`Mutation: ${judged.filter(m => m.result === 'killed').length} of ${judged.length} deliberate changes were noticed`);
  if (r.behaviour) l.push(`Behaviour: ${r.behaviour.compared} function${r.behaviour.compared === 1 ? '' : 's'} compared before and after, ${r.behaviour.differ} answer${r.behaviour.differ === 1 ? 's' : ''} differently${r.behaviour.differ ? ' (a difference is for a person to judge: it never blocks)' : ''}`);
  if (r.reason) l.push(r.reason);
  if (r.stopped) l.push(`Stopped: ${r.stopped}. Call prove again to continue.`);
  return l.join('\n');
}

function lookLines(r: LookReport): string {
  if (!r.ran) return `Browser did not run: ${r.reason ?? 'nothing ran'}`;
  const l = [`Browser: ${r.browser}, ${r.mode === 'dev' ? 'the project’s dev server' : 'the HTML files as they are'} · ${r.pages.join(', ')} · ${r.combos} combinations each at the head and the base`];
  l.push(`New at the head: ${r.newProblems} measured problem${r.newProblems === 1 ? '' : 's'}${r.probeHits ? `, ${r.probeHits} probe hit${r.probeHits === 1 ? '' : 's'}` : ''}${r.looksDifferent ? `, ${r.looksDifferent} page${r.looksDifferent > 1 ? 's' : ''} look different` : ''}`);
  for (const s of (r.speed ?? []).filter(x => x.slower || x.heavier)) l.push(`Speed ${s.page}: ${[s.slower, s.heavier].filter(Boolean).join(', ')}`);
  const calls = (r.calls ?? []).flatMap(p => p.changes.slice(0, 4).map(ch => `${p.page}: ${ch.text}`));
  if (r.translation) l.push(r.translation.note ?? `Translations: ${r.translation.files} files, ${r.translation.texts} texts on the pages, ${r.translation.untranslated} in no file (only new ones a changed line wrote are findings)`);
  if (calls.length) l.push(`Underneath (calls, warnings, title): ${calls.slice(0, 6).join('; ')}${calls.length > 6 ? `; and ${calls.length - 6} more` : ''}`);
  if (r.reason) l.push(r.reason);
  if (r.stopped) l.push(`Stopped: ${r.stopped}.`);
  return l.join('\n');
}

function detail(f: Finding, c: Case): string {
  const l = [`${f.title}`, `${f.tier} · ${f.severity} · ${f.lens} · ${f.file}:${f.lines} · ${f.commit.slice(0, 7)}${f.ref ? ` · ${f.ref}` : ''}${f.present === false ? ' · fixed later in the range' : ''}`, ''];
  for (const t of f.observed) l.push(`observed: ${t}`);
  for (const t of f.inferred) l.push(`inferred: ${t}`);
  l.push(`ranks here because: ${f.why.join('; ')} (risk ${f.risk})`, '');
  if (f.snippet.header) l.push(f.snippet.header);
  for (const r of f.snippet.rows) l.push(`${r.sig ? '>' : ' '} ${String(r.o ?? '').padStart(4)} ${String(r.n ?? '').padStart(4)} ${r.t} ${r.text}`);
  l.push('', 'evidence:');
  for (const e of f.evidence) l.push(`  ${e.id}  ${e.kind} (${e.source}): ${e.what}${e.kind === 'claim' ? '' : `  → evidence_replay ${e.id}`}`);
  if (c.resolved[f.id]) l.push('', `A person marked this ${c.resolved[f.id]}.`);
  return l.join('\n');
}

export function createServer(version = '0.2.0'): McpServer {
  const server = new McpServer({ name: 'assay', version }, { instructions: INSTRUCTIONS });
  const repoArg = z.string().optional().describe('The repository folder. Default: the folder this server was started in.');

  server.registerTool('case_open', {
    title: 'Review a branch or a range',
    description: 'Run the free checks (secrets, risky patterns, dependency changes, untested logic) over a branch or commit range and return the verdict with the ranked findings. Costs no model tokens. With no range: this branch since it left main, or the last 5 commits.',
    inputSchema: {
      repo: repoArg,
      range: z.string().max(200).optional().describe('"A..B" = B since A, "A...B" = B since they met, one revision = just that commit'),
      last: z.number().int().min(1).max(500).optional().describe('Review the last N commits instead'),
      hints: z.boolean().optional().describe('Also list hints (one signal each)'),
      fresh: z.boolean().optional().describe('Ignore saved results and analyse again')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ repo, range, last, hints, fresh }) => {
    try {
      const c = openCase({ repo: repo ?? process.cwd(), range, last, fresh });
      const s = summary(c, !!hints);
      return text(s.text, s.data);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('case_findings', {
    title: 'List findings in a case',
    description: 'The findings of a case, most important first. Filter by tier or lens.',
    inputSchema: {
      case: z.string().describe('A case id from case_open'),
      tier: z.enum(['proven', 'corroborated', 'hint']).optional(),
      lens: z.enum(LENSES).optional(),
      all: z.boolean().optional().describe('Include findings already fixed later in the range or marked by a person'),
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async (a) => {
    try {
      const c = getCase(a.case);
      const list = c.findings.filter(f => (!a.tier || f.tier === a.tier) && (!a.lens || f.lens === a.lens) && (a.all || isOpen(c, f)));
      return text(list.length ? list.slice(0, a.limit ?? 25).map(f => line(f, c)).join('\n') + (list.length > (a.limit ?? 25) ? `\n… ${list.length - (a.limit ?? 25)} more` : '') : 'No findings match.');
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('finding_get', {
    title: 'One finding: the lines and the evidence',
    description: 'The changed lines around a finding, what was observed against what is only inferred, why it ranks where it does, and each piece of evidence with how to replay it.',
    inputSchema: { case: z.string(), id: z.string().describe('A finding id, e.g. f-1a2b3c4d') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ case: id, id: fid }) => {
    try {
      const c = getCase(id);
      return text(detail(must(findingById(c, fid), `No finding ${fid} in ${id}.`), c));
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('evidence_replay', {
    title: 'Run a check again',
    description: 'Runs the check that produced a piece of evidence again from scratch and says whether it reproduces. A reviewer’s reading can’t be replayed.',
    inputSchema: { case: z.string(), evidence_id: z.string().describe('An evidence id, e.g. f-1a2b3c4d.1') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ case: id, evidence_id }) => {
    try {
      const r = await replayEvidence(getCase(id), evidence_id);
      return text(`${r.reproduced ? 'reproduced' : 'not reproduced'}: ${r.detail}`, { ...r });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('brief', {
    title: 'The short fix brief',
    description: 'What to fix, in priority order, as a few lines: each item with its file and line, the fix in a sentence, and the evidence id to replay. Hints are left out.',
    inputSchema: { case: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ case: id }) => {
    try { return text(briefOf(getCase(id))); } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('finding_submit', {
    title: 'Report claims as a reviewer',
    description: 'Submit what you found as a reviewer. Every claim must cite a file and a line inside the diff or it is dropped. A claim next to an existing finding adds a second source to it; a claim elsewhere becomes a hint. You can’t claim proof: evidence kinds like test-fail are recorded as your reading until Assay runs them.',
    inputSchema: {
      case: z.string(),
      reviewer: z.string().min(2).max(40).describe('Your lens, e.g. "Security"; or "Attack" if you are the attack pass'),
      claims: z.array(z.object({
        title: z.string().min(3).max(140),
        lens: z.enum(LENSES),
        severity: z.enum(['high', 'medium', 'low']).optional(),
        file: z.string().min(1).max(300),
        line: z.number().int().min(1),
        commit: z.string().regex(/^[0-9a-f]{4,40}$/).optional().describe('A commit in the range, if the line is in several'),
        what: z.string().min(8).max(1200).describe('What is wrong and why, in a sentence or two'),
        evidence: z.array(z.object({ kind: z.enum(KINDS), what: z.string().min(3).max(600) })).max(5).optional()
      })).max(20).optional().describe('What you found. Leave it out, with done, to say you found nothing.'),
      done: z.boolean().optional().describe('True when you have finished: with no claims it means "found nothing". A reviewer in a panel must say it is done.'),
      round: z.union([z.literal(1), z.literal(2)]).optional().describe('2 only when you were handed claims to cross-examine'),
      disputes: z.array(z.object({ finding: z.string().min(3).max(40), reason: z.string().min(5).max(400) })).max(10).optional().describe('Cross-examination: a claim you were asked to examine and think is wrong, and why'),
      tokens: z.number().int().min(0).max(2_000_000).optional().describe('How many tokens you used, if you know')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, reviewer, claims, done, round, disputes, tokens }) => {
    try {
      const c = getCase(id);
      if (!claims?.length && !done && !disputes?.length) return fail('Nothing to submit: give claims, or done: true to say you found nothing.');
      const incoming: Claim[] = (claims ?? []).map(x => ({ ...x, source: `reviewer:${reviewer}`, evidence: x.evidence?.map(e => ({ kind: e.kind, source: `reviewer:${reviewer}`, what: e.what })) }));
      const r = applyClaims(c.repo, c, incoming);
      saveCase(c);
      reviewers.recordSubmission(c, reviewer, r, { round: round ?? 1, done: !!done, tokens, claims: incoming.length, disputes: disputes ?? [] });
      const out = [`${r.kept.length} new, ${r.merged.length} added to an existing finding, ${r.dropped.length} dropped.${done ? ' Marked done.' : ''}${disputes?.length ? ` ${disputes.length} dispute${disputes.length === 1 ? '' : 's'} noted.` : ''}`];
      for (const f of r.kept) out.push(`  new ${f.id}  ${f.tier}  ${f.title}  ${f.file}:${f.lines}`);
      for (const m of r.merged) out.push(`  merged into ${m.findingId}: ${m.claim.title}`);
      for (const d of r.dropped) out.push(`  dropped (${d.reason}): ${d.claim.title}  ${d.claim.file}:${d.claim.line}`);
      if (r.dropped.length) out.push('A dropped claim cited no line inside this case’s diff. Cite the file and line of a changed line.');
      const st = c.panel ? reviewers.statusOf(c.panel) : null;
      if (st?.planned) out.push(`Panel: ${st.reported} of ${st.running} reviewers have reported.`);
      return text(out.join('\n'), { kept: r.kept.length, merged: r.merged.length, dropped: r.dropped.map(d => ({ title: d.claim.title, reason: d.reason })) });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('reviewers_plan', {
    title: 'Plan the reviewer panel, and see where it stands',
    description: 'Shows which reviewers are worth their tokens for a case, what each will cost and why the others are left out, BEFORE anything is spent; and, once reviewers are running, where the panel stands and what to do next. Use it only when a person asked for reviewers or set a budget. It spends nothing and calls no model: it tells you which sub-agents to start. Calling it again with the same budget and request keeps what has been reported.',
    inputSchema: {
      case: z.string().describe('A case id from case_open'),
      budget: z.number().int().min(0).max(400000).optional().describe('Tokens the reviewers may cost in all. 0 = free checks only. Default: the project’s setting (40000).'),
      request: z.string().max(2000).optional().describe('What the person asked for, in their words. Lets the Triage reviewer trace each change back to it. Leave it out if you don’t have it.'),
      include: z.array(z.string().max(30)).max(7).optional().describe('Reviewers to run even though calibration left them out of the plan. Only when a person asked for them.')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, budget, request, include }) => {
    try {
      const c = getCase(id);
      const p = reviewers.planPanel(c, { budget, request, include: include?.map(x => reviewers.reviewerFor(x)?.lens).filter((x): x is NonNullable<typeof x> => !!x) });
      return text(reviewers.panelText(c, c.panel ?? p), { panel: p.id, phase: reviewers.statusOf(c.panel).phase, budget: p.budget, estimate: p.estimate.total, run: p.reviewers.filter(r => r.run).map(r => r.lens) });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('reviewer_brief', {
    title: 'The brief for one reviewer',
    description: 'Everything one reviewer needs and nothing it shouldn’t have: its lens, its slice of the change with the line numbers a claim must cite, what the free checks already found for it, and how to report. Call it as the reviewer, once per reviewer; it is never shown another reviewer’s work. Round 2 (cross-examination) hands over other reviewers’ claims anonymously, and only after every reviewer has reported. The attack pass (lens "attack", only when the plan lists it) has no lens: it tries to break the change, sees every changed file that runs, and is as blind as the rest.',
    inputSchema: {
      case: z.string(),
      lens: z.string().min(2).max(40).describe('Your lens: Triage, Security, Correctness, UI, Tests, Supply chain or Performance; or "attack" if the plan lists the attack pass'),
      round: z.union([z.literal(1), z.literal(2)]).optional(),
      page: z.number().int().min(1).max(50).optional().describe('A long change comes in pages')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, lens, round, page }) => {
    try {
      const c = getCase(id);
      const b = reviewers.reviewerBrief(c, lens, { round, page });
      return { content: [{ type: 'text' as const, text: cap(b.text, 16000, 'Ask for the next page.') }], structuredContent: { pages: b.pages, page: b.page, round: b.round } };
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('prove', {
    title: 'Run the project’s own tests as proof',
    description: 'Runs the project’s test command in clean copies of the base and the head: a test that passed before and fails now is a proven regression. Then it puts risky hunks back to see whether any test notices, and makes small deliberate changes to the changed lines to see which ones the tests miss. Costs no model tokens, only time. A person must have allowed it (assay allow-run); you can’t. Results are kept, so calling it again continues where a time budget stopped it.',
    inputSchema: {
      case: z.string(),
      mutants: z.number().int().min(0).max(12).optional().describe('Deliberate changes to try, each one test run (default 8, 0 = skip)'),
      reverts: z.number().int().min(0).max(5).optional().describe('Hunks to try putting back, each one test run (default 3, 0 = skip)'),
      budget_seconds: z.number().int().min(10).max(600).optional().describe('Stop starting new runs after this long (default 90)'),
      behaviour: z.boolean().optional().describe('Call the functions the change touched with the same inputs before and after, and report where the answers differ (JavaScript and Python; default true, false = skip)'),
      bisect: z.boolean().optional().describe('When tests that passed now fail, find the first commit where they fail, by running them at about log2 of the commits (default true, false = skip)')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, mutants, reverts, budget_seconds, bisect, behaviour }) => {
    try {
      const c = getCase(id);
      if (!isAllowed(c.repo)) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await proveCase(c, { mutants, reverts, bisect, behaviour, budgetSeconds: budget_seconds ?? 90 });
      const s = summary(c, false);
      return text(`${proofLines(r)}\n\n${s.text}`, { ...s.data, proof: { ran: r.ran, regressions: r.regressions, firstFailingCommit: r.culprit?.commit ?? null, stopped: r.stopped ?? null } });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('look', {
    title: 'Open the pages in a real browser, before and after',
    description: 'Opens the project’s pages in a Chromium-based browser already on the machine, at the base and at the head, in 12 combinations (desktop and phone, light and dark, as loaded, mirrored right to left, and with the text swapped for longer Arabic). Reports what is new at the head, measured: overlapping or cut-off content, unreadable text, sideways scrolling, missing names, labels, alt text and page language, skipped heading levels, a changed keyboard order, ids used twice, uncaught errors, failed requests, new console warnings, text a changed line wrote that no translation file has, a call made more often, a page that loads clearly slower or fetches clearly more script, and (probe) text typed into the page that becomes markup. It also lists what changed underneath: the page’s data calls, warnings and title. Each finding points at the changed line that made it. Keeps before and after screenshots for the report. Costs no model tokens. A person must have allowed it (assay allow-run); you can’t.',
    inputSchema: {
      case: z.string(),
      pages: z.array(z.string().max(200)).max(6).optional().describe('Paths on the local server to open, e.g. ["/", "/cart"]. Default: the person’s setting, else the HTML files the range changed, or "/".'),
      probe: z.boolean().optional().describe('Also type a harmless marker into the pages’ fields and query strings (default true)'),
      speed: z.boolean().optional().describe('Load each page three more times at each end to compare how fast it is (default true)'),
      budget_seconds: z.number().int().min(10).max(600).optional().describe('Stop opening new pages after this long (default 120)')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, pages, probe, speed, budget_seconds }) => {
    try {
      const c = getCase(id);
      if (!isAllowed(c.repo)) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await lookCase(c, { pages, probe, speed, screens: true, budgetSeconds: budget_seconds ?? 120 });
      const s = summary(c, false);
      return text(`${lookLines(r)}\n\n${s.text}`, { ...s.data, look: { ran: r.ran, newProblems: r.newProblems, probeHits: r.probeHits, pages: r.pages, slower: (r.speed ?? []).filter(x => x.slower || x.heavier).map(x => x.page), callChanges: (r.calls ?? []).reduce((n, p) => n + p.changes.length, 0), stopped: r.stopped ?? null } });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('finding_resolve', {
    title: 'Dismiss or mark a finding intended',
    description: 'Mark a hint or corroborated finding as dismissed (a false alarm) or intended, or open it again. A proven finding can only be dismissed by a person, with the assay command: it is what stops the verdict from being talked away.',
    inputSchema: { case: z.string(), id: z.string(), how: z.enum(['dismissed', 'intended', 'reopen']) },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, id: fid, how }) => {
    try {
      const c = getCase(id);
      const f = must(findingById(c, fid), `No finding ${fid} in ${id}.`);
      if (f.tier === 'proven' && how !== 'reopen') return fail(`${f.id} is proven. Only a person can dismiss it: they run  assay resolve ${f.id} ${how}`);
      resolveFinding(c, f.id, how === 'reopen' ? null : how);
      return text(`${f.id}: ${how === 'reopen' ? 'open again' : how}`);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('memory', {
    title: 'What this project remembers',
    description: 'Mistakes this project has made before (from standards packs and from its own fix commits) and the questions a reviewer should ask that no check can decide. Give a case to see which remembered mistakes its findings match, and the questions for its languages. Read only.',
    inputSchema: {
      repo: repoArg,
      case: z.string().optional().describe('A case id from case_open'),
      languages: z.array(z.string().max(40)).max(10).optional().describe('Languages to ask questions for. Default: the case’s languages.'),
      limit: z.number().int().min(1).max(40).optional().describe('How many questions at most (default 8)')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ repo, case: id, languages, limit }) => {
    try {
      const st = memory.memoryStatus();
      const c = id ? getCase(id) : null;
      const dir = c?.repo ?? repo ?? process.cwd();
      const entries = memory.listEntries(dir);
      const out: string[] = [];
      if (!st.available) out.push(`Memory is off (${st.why}). The standards packs can still be read.`);
      const on = entries.filter(e => e.on && e.how !== 'question');
      out.push(`${on.length} remembered mistakes on (${entries.filter(e => e.kind === 'learned').length} learned from this project's history), ${entries.filter(e => e.status === 'expired').length} switched off for crying wolf.`);
      let matched: Array<{ finding: string; entries: string[] }> = [];
      if (c) {
        const links = memory.linksFor(c);
        const byId = new Map(entries.map(e => [e.id, e]));
        matched = c.findings.filter(f => links[f.id] && isOpen(c, f)).map(f => ({ finding: f.id, entries: links[f.id] }));
        if (matched.length) {
          out.push('', 'Findings that match a remembered mistake:');
          for (const m of matched.slice(0, 10)) {
            const f = c.findings.find(x => x.id === m.finding) as Finding;
            const e = byId.get(m.entries[0]);
            out.push(`  ${f.id}  ${f.title}  ->  ${e?.name ?? m.entries[0]}${e && e.stats.hits ? ` (seen ${e.stats.hits} times here, ${e.stats.falseAlarms} dismissed)` : ''}${e?.examples.length ? `; fixed before in ${e.examples[0].commit.slice(0, 7)}` : ''}`);
          }
          if (matched.length > 10) out.push(`  … ${matched.length - 10} more`);
        } else out.push('', 'No finding in this case matches a remembered mistake.');
      }
      const qs = memory.questions(dir, languages ?? c?.languages).slice(0, limit ?? 8);
      if (qs.length) {
        out.push('', 'Questions to ask while you review (nothing can check these for you):');
        for (const q of qs) out.push(`  - ${q.question} [${q.origin}${q.ref ? `, ${q.ref}` : ''}]`);
      }
      return text(out.join('\n'), { available: st.available, remembered: on.length, matched: matched.length, questions: qs.map(q => ({ id: q.id, question: q.question })) });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('checkup', {
    title: 'Check the project as it is, not a change',
    description: 'A checkup of the project at a commit (HEAD by default): keys, key files and .env files committed in tracked files, each marked new or already there since the previous checkup, and what was fixed since. Also lists the pages, endpoints and flows the project describes: router folders (Next.js, Nuxt, Astro, SvelteKit, Remix), plain HTML, Express and NestJS routes, the repository’s OpenAPI file, plus a HAR, flow or OpenAPI file and the app’s address on this computer when given. Reads git and the files given; runs nothing, loads no page, costs no model tokens.',
    inputSchema: {
      repo: repoArg,
      ref: z.string().max(200).optional().describe('A commit or branch to check. Default: HEAD (uncommitted changes are not part of it).'),
      url: z.string().max(300).optional().describe('The app running on this computer, e.g. http://localhost:3000. Only localhost, 127.0.0.1, [::1] or a .localhost name.'),
      pages: z.array(z.string().max(300)).max(50).optional().describe('Paths on the app, e.g. ["/", "/cart"].'),
      har: z.string().max(1000).optional().describe('A HAR file (DevTools "Save all as HAR"). Only methods and paths are kept.'),
      flow: z.string().max(1000).optional().describe('A flow file ("assay": "flow/1") or a Chrome DevTools Recorder export.'),
      openapi: z.string().max(1000).optional().describe('An OpenAPI 3 or Swagger 2 file, JSON or YAML. The repository’s own one is found without this.'),
      only: z.enum(['secrets']).optional().describe('Run only this check and skip the list of pages and endpoints.')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ repo, ref, url, pages, har, flow, openapi, only }) => {
    try {
      const c = runCheckup({ repo: repo ?? process.cwd(), ref, url, pages, har, flow, openapi, ...(only ? { checks: [only], inventory: false } : {}) });
      const out = checkupLines(c);
      return text(out.text, out.data);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('try', {
    title: 'Try upgrading one package in a throwaway copy',
    description: 'Before upgrading a package: installs a new version of one dependency in a throwaway copy of the project (the lockfile’s versions first, then that one package), runs the type check, the build and the tests in both, then compares the pages from the project’s dev server in a browser: what they show, what they call, errors, speed, accessibility. Reports what breaks and what only changes. Takes minutes. Install scripts are not run. The project’s own folder is never touched. The package manager reaches its registry, so a person must have allowed running (assay allow-run) and the registry (assay allow-run --network); you can’t turn either on. Costs no model tokens.',
    inputSchema: {
      repo: repoArg,
      package: z.string().min(1).max(120).describe('A package the project depends on (package.json), e.g. react.'),
      version: z.string().max(60).optional().describe('A version (19, 19.1.0) or a tag (latest, next). Default latest.'),
      ref: z.string().max(200).optional().describe('The commit the copies are made from. Default HEAD.'),
      pages: z.array(z.string().max(300)).max(6).optional().describe('Paths to compare, e.g. ["/", "/cart"]. Default: the pages set with allow-run, else /.'),
      browser: z.boolean().optional().describe('Compare the pages in a browser. Default true.'),
      tests: z.boolean().optional().describe('Run the project’s tests in both copies. Default true.')
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ repo, package: pkg, version, ref, pages, browser, tests }) => {
    try {
      const root = repo ?? process.cwd();
      if (!isAllowed(repoRoot(root))) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await runTry({ repo: root, package: pkg, version, ref, pages, browser, tests });
      const out = tryLines(r);
      return text(out.text, out.data);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('gremlins', {
    title: 'A browser clicks and types through the app',
    description: 'A headless browser goes through the project’s app by itself the way an impatient, careless person would: clicking whatever it finds, typing nonsense into fields, double-clicking submit, pressing Enter, going back halfway. Seeded, so the same seed does the same things; every problem (an uncaught error, a blank page, the framework’s error screen, a server error, a failing request, a logged error) comes with the steps that led to it. Give url for an app already running on this computer, or leave it out and the project’s own app is started from a clean copy of ref; with base the same seed runs there too and only what is new is reported. It talks to this computer only and leaves controls that look destructive alone. The run is kept and compared with the last one of the same app (each problem is first, new or already there). A session for a signed-in app comes only from the server’s own environment (ASSAY_SESSION_COOKIE, ASSAY_SESSION_AUTHORIZATION), never from you, and is in no answer. It clicks and types, so it changes data: it needs the person’s own assay allow-run and assay allow-run --writes, which you can’t turn on. Costs no model tokens.',
    inputSchema: {
      repo: repoArg,
      url: z.string().max(300).optional().describe('An app running on this computer, e.g. http://localhost:3000. Without it the app is started from a clean copy of ref.'),
      ref: z.string().max(200).optional().describe('The commit to start the app from. Default: HEAD.'),
      base: z.string().max(200).optional().describe('Run the same seed here too and report only what is new at ref. Not with url.'),
      actions: z.number().int().min(1).max(300).optional().describe('How many things to do. Default 40.'),
      seed: z.number().int().min(0).max(999999999).optional().describe('The seed: the same one does the same things. Default: a random one, reported.'),
      page: z.string().max(300).optional().describe('The page to start on, a path like /cart. Default /.'),
      phone: z.boolean().optional().describe('As a cheap phone: a narrow touch screen.'),
      bold: z.boolean().optional().describe('Also click controls that look destructive (delete, sign out, reset).')
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ repo, url, ref, base, actions, seed, page, phone, bold }) => {
    try {
      const root = repo ?? process.cwd();
      if (!isAllowed(repoRoot(root))) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await runGremlins({ repo: root, url, ref, base, actions, seed, page, phone, bold, session: sessionFromEnv() });
      const out = gremlinsLines(r);
      return text(out.text, out.data);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('attack', {
    title: 'A security pass on the running app',
    description: 'Tries the usual weaknesses against the project’s own app, running on this computer at a given address (Assay never starts it): missing security headers, cookie flags, CORS that lets any site read answers, script in the address that comes back unescaped (and, in a real browser, becomes an element), stack traces and SQL errors after a quote, and with a session: calls that answer without it and other ids. The endpoints are read from the repository’s routers and OpenAPI file, a HAR or a list of pages. Reads only (GET) unless writes is true, which also saves test text through forms, sends a write as another site would, tries 20 wrong passwords and sends malformed bodies: it needs the person’s own assay allow-run --writes, which you can’t turn on. Costs no model tokens. A person must have allowed running (assay allow-run). A session, if any, comes only from the server’s own environment (ASSAY_SESSION_COOKIE, ASSAY_SESSION_AUTHORIZATION), never from you, and is in no answer.',
    inputSchema: {
      repo: repoArg,
      url: z.string().max(300).describe('The app on this computer, e.g. http://localhost:3000. Only localhost, 127.0.0.1, [::1] or a .localhost name.'),
      ref: z.string().max(200).optional().describe('The commit the endpoints are read from. Default: HEAD.'),
      pages: z.array(z.string().max(300)).max(50).optional().describe('Paths on the app, e.g. ["/", "/cart"].'),
      har: z.string().max(1000).optional().describe('A HAR file (only methods and paths are kept).'),
      openapi: z.string().max(1000).optional().describe('An OpenAPI 3 or Swagger 2 file. The repository’s own one is found without this.'),
      writes: z.boolean().optional().describe('Also run the checks that change data. Refused unless a person ran assay allow-run --writes.'),
      browser: z.boolean().optional().describe('Confirm script in a real browser (default true, when one is found).')
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ repo, url, ref, pages, har, openapi, writes, browser }) => {
    try {
      const root = repo ?? process.cwd();
      if (!isAllowed(repoRoot(root))) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await runAttack({ repo: root, url, ref, pages, har, openapi, writes, browser, session: sessionFromEnv() });
      const out = attackLines(r);
      return text(out.text, out.data);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('test', {
    title: 'Run the project’s own tests once',
    description: 'Runs the project’s own test command once (found from its manifest, never one you pass) in a clean copy of a commit, HEAD by default, and reads the runner’s own report: how many passed, and each failure with its file, line, message, expected and actual (vitest, jest, node:test, pytest and go in full; other runners from their output). coverage: true adds the share of lines the tests ran and the least covered files. Costs no model tokens, only time. A person must have allowed it (assay allow-run); here: true also needs assay allow-run --here. You can’t turn either on.',
    inputSchema: {
      repo: repoArg,
      ref: z.string().max(200).optional().describe('A commit or branch to test. Default: HEAD. Not with here.'),
      here: z.boolean().optional().describe('Run in the person’s own folder, uncommitted work included. Only if they ran assay allow-run --here.'),
      match: z.string().max(200).optional().describe('Only tests whose name matches (vitest and jest -t, pytest -k, go -run, node --test-name-pattern).'),
      files: z.array(z.string().max(300)).max(50).optional().describe('Only these test files or packages, relative to the repository (vitest, jest, pytest, go).'),
      changed: z.boolean().optional().describe('Only the tests for uncommitted changes (vitest, jest). Needs here.'),
      coverage: z.boolean().optional().describe('Also measure how much of the code the tests run.'),
      timeout_seconds: z.number().int().min(5).max(600).optional().describe('Stop the run after this long (default: the person’s setting, 300).')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ repo, ref, here, match, files, changed, coverage, timeout_seconds }) => {
    try {
      const root = repo ?? process.cwd();
      if (!isAllowed(repoRoot(root))) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await runTests({ repo: root, ref, here, match, files, changed, coverage, timeoutSec: timeout_seconds });
      const out = testLines(r);
      return text(out.text, out.data);
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('timeline', {
    title: 'What the free checks found on each recent commit',
    description: 'One row per recent commit: files, lines, findings by tier, risk. Instant for commits seen before.',
    inputSchema: { repo: repoArg, ref: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ repo, ref, limit }) => {
    try {
      const rows = timeline({ repo: repo ?? process.cwd(), ref, limit: limit ?? 15 });
      return text(rows.map(r => `${r.short}  ${r.date.slice(0, 10)}  risk ${String(r.risk).padStart(2)}  ${r.counts.proven} proven ${r.counts.corroborated} corroborated ${r.counts.hint} hint  ${r.subject}`).join('\n'));
    } catch (e) { return fail((e as Error).message); }
  });

  return server;
}

export function readVersion(): string {
  try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version; } catch { return '0.1.0'; }
}

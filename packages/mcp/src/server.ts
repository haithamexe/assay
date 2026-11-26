import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyClaims, briefOf, cap, findingById, isAllowed, isOpen, loadCase, lookCase, memory, openCase, proveCase, replayEvidence, resolveFinding, reviewers, saveCase, timeline, verdictOf } from '@assay/core';
import type { Case, Claim, Finding, LookReport, ProofReport } from '@assay/core';

export const INSTRUCTIONS = `assay reviews code changes with evidence, not opinion. Use it after you change code and before you say you are done.
1. case_open (no arguments reviews this branch since it left main). Read the verdict.
2. If it says Blocked, fix the MUST FIX items (brief is the short list; finding_get shows the lines and the evidence), then call case_open again. Do not say the work is done while it says Blocked.
3. A tier is computed from evidence. Only proven findings block. A hint is one signal: look at it, don't obey it.
4. If you are reviewing as a reviewer, report with finding_submit. Every claim must cite a file and a line inside the diff, or it is dropped. You can't claim proof: Assay runs the checks that produce proof.
5. You can dismiss a hint or a corroborated finding with finding_resolve. You can't dismiss a proven one: a person can (assay resolve).
6. case_open only reads the diff, so almost nothing in it is proven. prove runs the project's own tests at the base and the head and tries reverting and mutating the change: that is what proves a regression or an untested change. It works only if a person turned it on with assay allow-run (you can't). Use it before you say done on a risky change. It stops at a time budget and picks up where it stopped when you call it again.
7. For anything a person sees in a browser, call look: it opens the pages in a real browser at the base and at the head, in 8 combinations of size, colour scheme and direction, and reports only what is new at the head: overlapping or cut-off content, unreadable text, a page that scrolls sideways, uncaught errors, failed requests, and text typed into the page that becomes markup (an XSS probe). Each is measured, so it is proven, and it points at the changed line that caused it. Same permission as prove (assay allow-run).
8. memory tells you what this project has got wrong before and what a reviewer should ask that no check can decide. Call it with the case id before you review by reading: it lists the remembered mistakes the findings match, and the questions worth asking for the case's languages. It is read only: you can't add, switch off or forget anything, a person does that.
9. Reviewers cost tokens, so use them only when a person asks for them or has set a budget. reviewers_plan shows who is worth running and what it costs, and spends nothing. If a person says go, start one sub-agent per reviewer it lists, in parallel, each told only to call reviewer_brief for its lens and follow it; never show reviewers each other's output. Each reports with finding_submit (done: true). When reviewers_plan says cross-examination is open, start the examiners it names the same way (round 2). Then read the verdict again. What reviewers find is at best corroborated: it asks for a look, it never blocks.
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

export function createServer(version = '0.1.0'): McpServer {
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
    description: 'Opens the project’s pages in a Chromium-based browser already on the machine, at the base and at the head, in 8 combinations (desktop and phone, light and dark, as loaded and mirrored right to left). Reports what is new at the head, measured: overlapping or cut-off content, unreadable text, sideways scrolling, uncaught errors, failed requests, and (probe) text typed into the page that becomes markup. Each finding points at the changed line that made it. Keeps before and after screenshots for the report. Costs no model tokens. A person must have allowed it (assay allow-run); you can’t.',
    inputSchema: {
      case: z.string(),
      pages: z.array(z.string().max(200)).max(6).optional().describe('Paths on the local server to open, e.g. ["/", "/cart"]. Default: the person’s setting, else the HTML files the range changed, or "/".'),
      probe: z.boolean().optional().describe('Also type a harmless marker into the pages’ fields and query strings (default true)'),
      budget_seconds: z.number().int().min(10).max(600).optional().describe('Stop opening new pages after this long (default 120)')
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ case: id, pages, probe, budget_seconds }) => {
    try {
      const c = getCase(id);
      if (!isAllowed(c.repo)) return fail('A person has to allow this first: they run  assay allow-run  in the repository. You can’t turn it on.');
      const r = await lookCase(c, { pages, probe, screens: true, budgetSeconds: budget_seconds ?? 120 });
      const s = summary(c, false);
      return text(`${lookLines(r)}\n\n${s.text}`, { ...s.data, look: { ran: r.ran, newProblems: r.newProblems, probeHits: r.probeHits, pages: r.pages, stopped: r.stopped ?? null } });
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

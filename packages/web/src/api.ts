import fs from 'node:fs';
import path from 'node:path';
import {
  assayHome, assayPath, branchSpan, briefOf, commitInfo, detectCommand, doctor, findBrowser, findingState, git, GitError, isOpen, languageOf, listCases,
  calibration, loadCase, lookCase, memory, openCase, proveCase, replayEvidence, repoSettings, resolveFinding, resolveRev, reviewBudget, reviewers, setRepoSettings, timeline, verdictOf
} from '@assay/core';
import type { Case, FindingState } from '@assay/core';
import type { Jobs } from './jobs.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/** A handler that answers with a file instead of JSON. */
export class Binary { constructor(readonly data: Buffer, readonly type: string) {} }

export interface Ctx {
  repo: string;
  name: string;
  version: string;
  jobs: Jobs;
}

export interface ApiReq { query: URLSearchParams; body: Record<string, unknown> }

const same = (a: string, b: string): boolean => (process.platform === 'linux' ? path.resolve(a) === path.resolve(b) : path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());

/** A case that belongs to this project. A case id from outside is only ever the fixed shape, and a case from another repository is not shown here. */
function own(ctx: Ctx, id: unknown): Case {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'Which case?');
  const c = loadCase(id);
  if (!c || !same(c.repo, ctx.repo)) throw new HttpError(404, 'There is no such case for this project. Open it again from the timeline.');
  return c;
}

const text = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== 'string' || !v || v.length > max) throw new HttpError(400, `${what} is missing or not valid.`);
  return v;
};
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined);

const allowCommand = (repo: string): string => `assay allow-run --repo "${repo}"`;

function notAllowed(ctx: Ctx, what: string): HttpError {
  return new HttpError(403, `${what} needs your OK first. A person has to switch it on, in a terminal: ${allowCommand(ctx.repo)}`, { code: 'not-allowed', command: allowCommand(ctx.repo) });
}

/** The case as the page needs it: what is stored, the verdict computed by the core (the page never works it out again), and a state for every finding. */
export function caseView(c: Case): Record<string, unknown> {
  const v = verdictOf(c);
  const ids = (xs: Array<{ id: string }>): string[] => xs.map(f => f.id);
  const states: Record<string, FindingState> = {};
  for (const f of c.findings) states[f.id] = findingState(c, f);
  const open = c.findings.filter(f => isOpen(c, f));
  const closed = c.findings.filter(f => !isOpen(c, f));
  let remembered: ReturnType<typeof memory.summariesFor> = {};
  try { remembered = memory.summariesFor(c); } catch { /* memory is a help: a case shows without it */ }
  return {
    memory: remembered,
    case: {
      ...c,
      findings: c.findings.map(f => ({ ...f, lang: languageOf(f.file) })),
      runs: c.runs.map(({ findings, signals, ...r }) => ({ ...r, findingIds: findings.map(f => f.id), signalIds: signals.map(s => s.findingId) }))
    },
    verdict: { tone: v.tone, headline: v.headline, must: ids(v.must), should: ids(v.should), decide: ids(v.decide), hints: ids(v.hints) },
    states,
    order: ids([...open, ...closed])
  };
}

/** A refusal from memory (an unknown pack, a pattern that could hang) is the person's mistake to fix, not a server fault. */
function asked<T>(fn: () => T): T {
  try { return fn(); } catch (err) { throw err instanceof HttpError ? err : new HttpError(400, err instanceof Error ? err.message : String(err)); }
}

/** Everything the Memory screen shows: the packs, every entry with its stats, and what the last reading of the history suggested. */
function memoryView(ctx: Ctx): Record<string, unknown> {
  const st = memory.memoryStatus();
  const { packs, problems } = memory.listPacks(ctx.repo);
  const mined = st.available ? memory.lastMined(ctx.repo) : { report: null, added: {} };
  return {
    available: st.available, why: st.why, packs, problems, packsDir: memory.packsDir(), entries: memory.listEntries(ctx.repo),
    expiry: memory.EXPIRY, mined: mined.report, minedAdded: mined.added
  };
}

const DROP_WHY: Record<string, string> = { 'no-location': 'It cited no file and line in the change.', 'outside-diff': 'It cited a line that is not in the change.', empty: 'It said too little to judge.' };

/** What the Reviewers screen shows: the plan (kept, or only worked out), where it stands, and what the gate did with what came back. */
function panelView(ctx: Ctx, c: Case, request?: string): Record<string, unknown> {
  // The kept plan is the case's panel, whatever budget an agent planned it with: its progress must never be hidden by a setting.
  const repoBudget = reviewBudget(ctx.repo);
  const kept = c.panel ?? null;
  const plan = kept ?? reviewers.previewPanel(c, { budget: repoBudget, request: request ?? null });
  const budget = plan.budget;
  const cross = kept ? reviewers.openCross(c) : null;
  const first = c.findings.filter(f => f.origin !== 'claim' && f.tier === 'proven').length;
  const claimed = c.findings.filter(f => f.origin === 'claim').length;
  const ask = plan.request ? ` and request "${plan.request.slice(0, 200).replace(/"/g, "'")}"` : '';
  const prompt = `Review case ${c.id} with Assay's reviewer panel. Call the assay tool reviewers_plan with case "${c.id}", budget ${plan.budget}${ask}, and follow what it says: start one sub-agent per reviewer it lists, in parallel, each told only to call reviewer_brief for its own lens and follow it. Don't show the reviewers each other's work. When reviewers_plan says the panel is done, call case_open again and tell me the verdict.`;
  return {
    caseId: c.id, budget, repoBudget, kept: !!kept, panel: plan, status: reviewers.statusOf(kept), cross: cross ?? plan.cross,
    disputes: (kept?.cross.disputes ?? []).map(d => ({ ...d, title: c.findings.find(f => f.id === d.finding)?.title ?? d.finding })),
    freeProven: first, freeTotal: c.findings.filter(f => f.origin !== 'claim').length, reviewerFindings: claimed,
    claims: c.claims.length, dropped: c.dropped.map(d => ({ title: d.claim.title, file: d.claim.file, line: d.claim.line, by: d.claim.source.replace(/^reviewer:/, ''), why: DROP_WHY[d.reason] ?? d.reason })),
    prompt: budget > 0 ? prompt : '', tokensReported: plan.reviewers.reduce((n, r) => n + (r.reportedTokens ?? 0), 0)
  };
}

/** The scoreboard of the newest calibration run, or what a run would plant. Scored from the two cases each time, so it moves as an agent's reviewers report. */
function calibrationView(ctx: Ctx): Record<string, unknown> {
  const run = calibration.latestRun(ctx.repo);
  let board: ReturnType<typeof calibration.scoreRun> | null = null;
  let problem: string | null = null;
  if (run) { try { board = calibration.scoreRun(run); } catch (err) { problem = err instanceof Error ? err.message : String(err); } }
  const left = [...calibration.routedOut(ctx.repo)].map(([lens, why]) => ({ lens, why }));
  return {
    board, problem, run: run ? { id: run.id, createdAt: run.createdAt, budget: run.budget } : null, prompt: run && board ? calibration.handoffPrompt(run.planted.case, run.control.case) : '', routedOut: left,
    history: calibration.history(ctx.repo).length, preview: board ? null : calibration.previewCalibration(ctx.repo)
  };
}

function branchName(repo: string): string {
  return git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }).trim() || 'detached HEAD';
}

const ROUTES: Record<string, (ctx: Ctx, req: ApiReq) => unknown | Promise<unknown>> = {
  'GET /api/state': ctx => {
    const head = git(ctx.repo, ['rev-parse', 'HEAD'], { allowFail: true }).trim();
    const s = repoSettings(ctx.repo);
    return {
      name: ctx.name, path: ctx.repo, branch: branchName(ctx.repo), head, headShort: head.slice(0, 7), version: ctx.version,
      allowed: s.allow === true, test: detectCommand(ctx.repo, s.command)?.label ?? null, browser: findBrowser(s.browser) ? true : false,
      job: ctx.jobs.active()
    };
  },

  'GET /api/timeline': (ctx, { query }) => {
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 30));
    const rows = timeline({ repo: ctx.repo, limit });
    return { rows, branch: branchSpan({ repo: ctx.repo }), limit };
  },

  'POST /api/open': (ctx, { body }) => {
    if (body.mode === 'branch') {
      const b = branchSpan({ repo: ctx.repo });
      return caseView(openCase({ repo: ctx.repo, span: { base: b.base, head: b.head } }));
    }
    if (body.mode === 'span') {
      // "from" is the oldest commit picked and "to" the newest: the case is everything after the parent of "from", up to "to".
      const from = resolveRev(ctx.repo, text(body.from, 'The first commit', 80));
      const to = resolveRev(ctx.repo, text(body.to, 'The last commit', 80));
      const [info] = commitInfo(ctx.repo, [from]);
      return caseView(openCase({ repo: ctx.repo, span: { base: info?.parent ?? null, head: to } }));
    }
    throw new HttpError(400, 'Open the branch, or give the first and last commit.');
  },

  'GET /api/case': (ctx, { query }) => caseView(own(ctx, query.get('id'))),

  'GET /api/cases': ctx => listCases()
    .map(k => loadCase(k.id))
    .filter((c): c is Case => !!c && same(c.repo, ctx.repo))
    .slice(0, 20)
    .map(c => {
      const v = verdictOf(c);
      return { id: c.id, createdAt: c.createdAt, base: c.base, head: c.head, commits: c.commits.length, findings: c.findings.length, verdict: { tone: v.tone, headline: v.headline }, subject: c.commits[0]?.subject ?? '' };
    }),

  'POST /api/resolve': (ctx, { body }) => {
    const c = own(ctx, body.case);
    if (ctx.jobs.busyCase(c.id)) throw new HttpError(409, 'A run is using this case. Resolve findings when it has finished, or stop it.');
    const how = body.how;
    if (how !== 'dismissed' && how !== 'intended' && how !== 'reopen') throw new HttpError(400, 'Dismiss it, mark it intended, or reopen it.');
    const id = text(body.finding, 'The finding', 60);
    if (!c.findings.some(f => f.id === id)) throw new HttpError(404, 'That finding is not in this case.');
    resolveFinding(c, id, how === 'reopen' ? null : how);
    return caseView(c);
  },

  'GET /api/brief': (ctx, { query }) => {
    const c = own(ctx, query.get('case'));
    const t = briefOf(c);
    const words = t.split(/\s+/).filter(Boolean).length;
    return { text: t, words, tokens: Math.round(words * 1.4) };
  },

  'POST /api/replay': (ctx, { body }) => {
    const c = own(ctx, body.case);
    const evidence = text(body.evidence, 'The evidence', 80);
    const f = c.findings.find(x => x.evidence.some(e => e.id === evidence));
    const ev = f?.evidence.find(e => e.id === evidence);
    if (!f || !ev) throw new HttpError(404, 'That evidence is not in this case.');
    if (ev.replay?.run && !repoSettings(ctx.repo).allow) throw notAllowed(ctx, 'Running it again');
    return ctx.jobs.start({ kind: 'replay', caseId: c.id, label: `Replaying ${evidence}` }, async () => {
      const fresh = own(ctx, c.id);
      return replayEvidence(fresh, evidence);
    });
  },

  'POST /api/prove': (ctx, { body }) => {
    const c = own(ctx, body.case);
    if (!repoSettings(ctx.repo).allow) throw notAllowed(ctx, 'Running this project’s tests');
    const opts = { mutants: int(body.mutants, 0, 30), reverts: int(body.reverts, 0, 10), budgetSeconds: int(body.budget, 30, 1800), bisect: body.bisect !== false, fresh: body.fresh === true };
    return ctx.jobs.start({ kind: 'prove', caseId: c.id, label: 'Running the project’s tests' }, async ({ say, signal }) => {
      const fresh = own(ctx, c.id);
      const report = await proveCase(fresh, { ...opts, signal, onProgress: say });
      return { report, ...caseView(fresh) };
    });
  },

  'POST /api/look': (ctx, { body }) => {
    const c = own(ctx, body.case);
    if (!repoSettings(ctx.repo).allow) throw notAllowed(ctx, 'Opening the pages in a browser');
    const pages = Array.isArray(body.pages) ? body.pages.filter((p): p is string => typeof p === 'string' && p.length < 200).slice(0, 6) : undefined;
    const opts = { pages, probe: body.probe !== false, screens: body.screens !== false, budgetSeconds: int(body.budget, 30, 900) };
    return ctx.jobs.start({ kind: 'look', caseId: c.id, label: 'Looking at the pages' }, async ({ say, signal }) => {
      const fresh = own(ctx, c.id);
      const report = await lookCase(fresh, { ...opts, signal, onProgress: say });
      return { report, ...caseView(fresh) };
    });
  },

  'GET /api/job': (ctx, { query }) => {
    const j = ctx.jobs.get(query.get('id') ?? '');
    if (!j) throw new HttpError(404, 'No such job.');
    return j;
  },

  'POST /api/stop': (ctx, { body }) => {
    const j = ctx.jobs.stop(text(body.id, 'The job', 40));
    if (!j) throw new HttpError(404, 'No such job.');
    return j;
  },

  'GET /api/shot': (ctx, { query }) => {
    const c = own(ctx, query.get('case'));
    const name = query.get('name') ?? '';
    // Only a picture this case recorded, under a plain file name: a name taken from a case file is never joined to a path unchecked.
    const known = c.runs.flatMap(r => r.shots ?? []).some(s => name === s.base || name === s.head || name === s.diff);
    if (!known || !/^[A-Za-z0-9._-]{1,120}\.jpg$/.test(name) || name.includes('..')) throw new HttpError(404, 'No such picture.');
    try { return new Binary(fs.readFileSync(assayPath('shots', c.id, name)), 'image/jpeg'); } catch { throw new HttpError(404, 'That picture is no longer on disk. Look at the pages again to take it.'); }
  },

  'GET /api/memory': ctx => memoryView(ctx),

  'POST /api/memory/pack': (ctx, { body }) => {
    asked(() => memory.setPack(ctx.repo, text(body.id, 'The pack', 60), body.on === true));
    return memoryView(ctx);
  },

  'POST /api/memory/entry': (ctx, { body }) => {
    asked(() => memory.setEntry(ctx.repo, text(body.id, 'The entry', 100), body.on === true));
    return memoryView(ctx);
  },

  // Only a suggestion Assay made from this project's history can be added from here: the page never sends a pattern of its own.
  'POST /api/memory/add': (ctx, { body }) => {
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 140) : undefined;
    asked(() => memory.addMined(ctx.repo, text(body.id, 'The suggestion', 40), name));
    return memoryView(ctx);
  },

  'POST /api/memory/remove': (ctx, { body }) => {
    asked(() => memory.removeLearned(ctx.repo, text(body.id, 'The entry', 40)));
    return memoryView(ctx);
  },

  'POST /api/memory/mine': (ctx, { body }) => {
    if (!memory.memoryStatus().available) throw new HttpError(409, 'Memory is off here, so there is nowhere to keep what the history teaches.');
    const limit = int(body.limit, 20, 2000);
    return ctx.jobs.start({ kind: 'mine', caseId: null, label: 'Reading the git history' }, async ({ say, signal }) => {
      const report = await memory.mineHistory(ctx.repo, { limit, signal, onProgress: say });
      return { report };
    });
  },

  'GET /api/panel': (ctx, { query }) => panelView(ctx, own(ctx, query.get('case'))),

  'GET /api/calibration': ctx => calibrationView(ctx),

  // Makes the throwaway repository and scores the free checks at once. It reads git and writes only under Assay's own folder; the reviewers are run by the person's agent.
  'POST /api/calibration/start': ctx => ctx.jobs.start({ kind: 'calibrate', caseId: null, label: 'Planting known bugs in a throwaway repository' }, async ({ say }) => {
    say('Building the throwaway repository and its clean twin…');
    calibration.startCalibration(ctx.repo);
    say('Scoring the free checks…');
    return calibrationView(ctx);
  }),

  'POST /api/calibration/clean': ctx => { calibration.cleanRuns(ctx.repo, true); return calibrationView(ctx); },

  // Plans the panel and keeps it with the case, so an agent that is told to run it finds the same plan. Nothing is spent and no model is called.
  'POST /api/panel/plan': (ctx, { body }) => {
    const c = own(ctx, body.case);
    if (ctx.jobs.busyCase(c.id)) throw new HttpError(409, 'A run is using this case. Plan the reviewers when it has finished, or stop it.');
    const request = typeof body.request === 'string' ? body.request.trim().slice(0, 2000) : undefined;
    reviewers.planPanel(c, { budget: reviewBudget(ctx.repo), request: request ?? c.panel?.request ?? null });
    return panelView(ctx, loadCase(c.id) ?? c);
  },

  // The budget is only a number: it runs nothing, so the page may set it. It never touches what may be run.
  'POST /api/panel/budget': (ctx, { body }) => {
    const n = int(body.budget, 0, 400000);
    if (n === undefined) throw new HttpError(400, 'Give the budget as a number of tokens.');
    setRepoSettings(ctx.repo, { budget: n });
    return { budget: reviewBudget(ctx.repo) };
  },

  'GET /api/settings': ctx => {
    const s = repoSettings(ctx.repo);
    const exe = findBrowser(s.browser);
    return {
      name: ctx.name, path: ctx.repo, branch: branchName(ctx.repo), version: ctx.version, home: assayHome(),
      settings: { allow: s.allow === true, command: s.command ?? null, timeout: s.timeout ?? 300, serve: s.serve ?? null, pages: s.pages ?? null, browser: s.browser ?? null },
      test: detectCommand(ctx.repo, s.command)?.label ?? null,
      browserFound: exe ? path.basename(exe) : null,
      doctor: doctor(),
      budget: reviewBudget(ctx.repo),
      hookCommand: 'assay hook install',
      allowCommand: allowCommand(ctx.repo),
      allowOff: `assay allow-run --repo "${ctx.repo}" --off`
    };
  }
};

export async function handleApi(ctx: Ctx, method: string, pathname: string, req: ApiReq): Promise<unknown> {
  const route = ROUTES[`${method} ${pathname}`];
  if (!route) throw new HttpError(404, 'No such request.');
  try {
    return await route(ctx, req);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof GitError) throw new HttpError(400, err.message);
    throw new HttpError(500, err instanceof Error ? err.message : String(err));
  }
}

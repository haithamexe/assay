# Architecture

How the code is arranged, the data it keeps, and the flows. Back to the [README](../README.md). The reasons behind the shape are the decisions in the [charter](PROJECT.md#6-decisions).

## Packages

```
packages/core    the engine. Only Node: no runtime dependencies.
packages/cli     the `assay` command          ──▶ core
packages/mcp     the MCP server (`assay-mcp`) ──▶ core, @modelcontextprotocol/sdk, zod
packages/web     the dashboard                ──▶ core. node:http, no other dependency
demo/            the clickable demo the dashboard was built from, and two sample reports
scripts/         regenerates the samples and the pictures; the sample project for the dashboard
docs/            this documentation (and the charter, PROJECT.md)
```

Every capability is written once in `core` and reached through the CLI, the MCP server, the HTML report and the dashboard. The CLI starts the dashboard (`assay dashboard`), so `cli` depends on `web`.

Built on Node 22+, ESM with `module: NodeNext` (relative imports end in `.js`), `tsc -b` project references, tests with `node:test`.

## The core, by folder

```
packages/core/src/
  types.ts        the model: Evidence, Finding, Case, Claim, Verdict, RunRecord, ShotRecord
  config.ts       the state folder, atomic writes, sha, output caps
  git.ts          git, only ever through execFile with argument arrays; ranges; reading a file at a commit
  diff.ts         parses `git diff` into files, hunks and real line numbers
  lang.ts         languages by extension; test, doc, demo, generated and sensitive paths
  evidence.ts     tierOf: the only place a tier is decided
  risk.ts         the risk score and its reasons
  analysis.ts     one commit through the free checks, cached by hash; corroboration
  case.ts         ranges, opening a case (or exactly a picked span), "still there at the head?", the verdict, a finding's state, the timeline and the branch's span
  gate.ts         the evidence gate for reviewers' claims
  store.ts        cases on disk
  brief.ts        the short fix brief
  replay.ts       run a piece of evidence again
  doctor.ts       what is installed (the CLI and the dashboard show the same list)
  report.ts       the one-file HTML report; exports where the stylesheet and fonts live
  checks/         secrets · risky (line and hunk rules) · deps · tests
  proof/          settings (allow-run) · runner · parse · tree · mutate · prove · apply
  browser/        find · cdp · serve · inspect · look
  calibration/    bugs (the templates) · build (the throwaway repository) · score (the scoreboard) · record (runs, history, who is left out)
  reviewers/      lenses · slice (what changed, each lens's slice) · plan (routing, budget, panel state, cross-exam) · brief · hook (the Stop hook) · format
  memory/         db (node:sqlite, fail-soft) · packs (files) · entries (stats, expiry, learned) · runtime (what changes an analysis) · mine (fix commits)
packages/core/assets/   the report's stylesheet and the three fonts, packs/ (the standards packs that ship) and lenses/ (the reviewers' prompts)
```

A **check** is a function from a commit (its diff, a way to read files as they were) to a list of findings with evidence. It never sets a tier or an id. The engine builds the finding, computes the tier, ranks it and caches the result. Adding one is [a small change](../CONTRIBUTING.md#adding-a-check).

## The model

Everything is plain JSON, so it can be stored, sent over MCP and rendered.

```ts
Evidence  { id, kind, source, what, file?, line?, replay?: { commit, run?: { kind, file?, line?, op? } } }
Finding   { id, check, title, lens, severity, commit, file, line, evidence[], observed[], inferred[],
            why[], risk, tier, snippet, anchor, ref?, present?, origin: 'check' | 'claim' | 'run' }
Case      { id, repo, base, head, commits[], findings[], claims[], dropped[], resolved{}, runs[], panel?, … }
Panel     { id, budget, request, reviewers[{ lens, run, why, skip?, tokens, state, claims, kept, merged, dropped }], cross{ state, assigned, disputes[] }, estimate }
RunRecord { id, kind: 'tests' | 'revert' | 'mutation' | 'browser', summary, findings[], signals[], shots? }
```

- **Ids are stable.** A finding id is a hash of the check, its key and the commit, so the same mistake in the same commit has the same id on every run. An evidence id is the finding id plus a number (`f-1a2b3c4d.2`). A case id is `c-<head>-<base>` (seven characters each, `root` for no base).
- **`origin`** says where a finding came from: a free check, a reviewer's claim, or a proof/browser run.
- **`anchor`** is what to look for again at the head of the range (or, for a secret, a hash of the line, never the line) to know whether the finding is still there.
- **`snippet`** is the changed lines around it, already masked.
- **`RunRecord.signals`** are the `coverage` signals a run adds to *other* findings. They are kept so a reopened case gets its proof back without running anything.

## State on disk

Under `~/.assay` (or `ASSAY_HOME`). Files are written whole (a temp file, then a rename) with mode 0600 where the system has modes.

```
~/.assay/
  repos.json                              allow-run settings, per repository (keyed by a hash of its path)
  memory.db                               SQLite: learned patterns, hits, switches (every row keyed by repository)
  packs/*.json                            your standards packs (over the ones that ship)
  mined/<repo>.json                       the suggestions from the last reading of a project's history
  lenses/*.md                             your reviewer prompts (over the ones that ship)
  calibration/<run>/repo                  a throwaway repository with planted bugs (the newest five are kept)
  calibration/<run>/run.json              what was planted and where; calibration/<repo>.json: the runs and what each finished run showed
  hooks/<session>.json                    how many times the Stop hook has blocked a session
  cases/<case id>.json                    a case: commits, findings, claims, resolutions, runs
  cache/<repo>/<commit>.json              one commit's analysis; versioned (ANALYSIS_VERSION) and keyed by the memory digest
  runs/<repo>/<commit>-<hash>.json        one test run: the tests, a revert, or a deliberate change
  shots/<case id>/*.base|head|diff.jpg    before and after pictures
  reports/<case id>.html                  assay report
  work/                                   clean checkouts and browser profiles; deleted after use
```

Nothing is written into your repository.

## The flows

### Review (reads git only)

```
resolveRange ─▶ list the commits (no merges) ─▶ for each: analyzeCommit (cache hit, or:
    diff against its first parent ─▶ run the checks ─▶ build findings (tier, risk, snippet, masked)
    ─▶ corroborate with the commit's facts ─▶ write the cache)
 ─▶ merge findings ─▶ re-apply the case's claims and runs ─▶ "still there at the head?" ─▶ save ─▶ verdict
```

### Proof (`prove`)

```
allowed? ─▶ detect the test command ─▶ for base and head: cached run? else
    exportTree (temporary git index, nothing in your repo changes) ─▶ linkDependencies
    ─▶ run (shell or direct, timeout, output capped, env cleaned, the whole process tree killed on timeout)
    ─▶ parse (names of failing tests, counts, file:line references) ─▶ cache
 ─▶ regression? ─▶ finding anchored on the changed line the failure points at
 ─▶ head green? ─▶ revert test on the top risky hunks ─▶ mutation on changed lines (each: apply, run, restore, cache)
 ─▶ RunRecords ─▶ re-apply to the case ─▶ save
```

### Browser (`look`)

```
allowed? ─▶ find a browser ─▶ launch it on a pipe (no port) ─▶ for head, then base:
    exportTree + links ─▶ start the dev server (or the static server) ─▶ for each page:
    4 loads (desktop/phone × light/dark) × 2 directions: inspect (measure) · screenshots · errors
    ─▶ the probe (head only if it hit)  ─▶ stop the server ─▶ remove the checkout
 ─▶ new at the head? ─▶ anchor on the changed line ─▶ findings (measurement or probe evidence)
 ─▶ diff the screenshots inside the browser ─▶ RunRecord ─▶ save
```

## Memory

```
analyzeCommit(repo, commit)
   memoryRuntime(repo) ─▶ { digest, isMuted(source), learned: Check | null }
        entries off (pack off, a person, or expiry) ─▶ the signals they alone ask for are muted
        learned patterns that are on                 ─▶ one more check, run with the others
   cache hit only if the cached analysis has the same digest ('' when memory changes nothing)
   each raw finding: no proof evidence and every source muted ─▶ dropped; else built, tiered, ranked as always
saveCase(case) ─▶ recordCase: for each finding, the entries whose sources it carries ─▶ INSERT OR IGNORE into hits
resolveFinding(case, id, dismissed|intended|reopen) ─▶ feedback: hits.dismissed for that finding ─▶ expiry check
```

- **Entries** are built on demand from the pack files and the `learned` table; nothing about a standard entry is copied into the database, so editing a pack file changes behaviour. An entry's stats are **read from `hits`** (one row per repository, entry and finding), never counted up.
- **The digest** (`memory/runtime.ts`) is a hash of the muted sources and the learned patterns, and is empty when both are empty, so a project that uses no memory keeps every cache it had. A change to either (`bumpMemory`) makes the next analysis of each commit run once more. The runtime is memoised for 1.5 s and checked for expiry every ten minutes.
- **Fail-soft.** `node:sqlite` is loaded with `createRequire` inside a `try`, with its experimental warning swallowed; if it isn't there (Node before 22.13) or the file can't be opened, `openDb()` is `null`, `memoryRuntime` is a no-op and every public function degrades to "nothing known", with the reason in `memoryStatus()`. `saveCase` and `resolveFinding` call memory inside `try`, so it can never be why a case isn't saved.
- **Mining** (`memory/mine.ts`) is one `git log -p -U0 --diff-filter=M` through `gitAsync` (so the dashboard keeps answering while git works), tokenised per hunk, scored per token, and written to `mined/<repo>.json`. `addMined` can only add what is in that file.
- **Learned patterns** run as `check: 'memory'` findings: `rule` evidence (`memory:<id>`) plus `history:fixes` evidence when fixes are behind them. `corroborate()` treats them like `risky` findings.

## Reviewers

```
reviewers_plan / assay reviewers plan ─▶ planPanel(case, budget, request) ─▶ kept on the case (c.panel)
   changedFiles(case): every commit's diff, once (cached)     facts: logic added, test, UI, dependency and sensitive files, perf lines
   route(): a reviewer is relevant when the facts say so, with its reason (or why not)
   estimate(): (rules + prompt + slice + known findings) / 4 characters per token + 700 to answer
   spend the budget most-justified first, keeping room for cross-examination; the rest say "Over budget: needs 4.8k, 1.2k left"
reviewer_brief(case, lens) ─▶ the brief: rules, lens prompt, its slice (secrets masked), what the free checks know, memory's questions for it
   marks the reviewer "briefed"; round 2 is refused until every planned reviewer has "reported"
finding_submit(…, done) ─▶ applyClaims (the gate) ─▶ recordSubmission: counts of kept, merged, dropped; "reported" when it says done
all reported ─▶ openCross: each reviewer-only claim goes to the next reviewer in the ring, never its author (at most 5 each)
```

- **Nothing here calls a model.** The panel is a record on the case plus text. The agent does the reviewing and reports through the same gate as any claim, so a reviewer's finding is at best corroborated.
- **The Stop hook** (`reviewers/hook.ts`) opens the case itself, takes the verdict from `verdictOf`, and answers `{"decision":"block","reason":…}` only when it is Blocked (or a required panel is unfinished). A per-session count in `~/.assay/hooks` makes it let go after `maxBlocks`.
- **Lens prompts** are Markdown files read at brief time: yours in `~/.assay/lenses` over `assets/lenses`.
- Memory's question entries carry a `lens`, so each reviewer's brief gets the project's questions for its lens.

## Calibration

```
startCalibration(project) ─▶ shapeOf: which languages, which folders (from git ls-files)
   ─▶ a throwaway repo: base commit (baseline files) ─▶ branch "planted" (bad) ─▶ branch "control" (the clean twins), neutral file names
   ─▶ openCase on each ─▶ planPanel on each (a big budget, so every relevant reviewer is in)    the free checks have already run
scoreRun(run) ─▶ per bug: findings within 3 lines in the right file; "about the defect" = evidence that is not reviewer:, diff:, history: or coverage:
   free cell: proven C, else flagged h, else missed m        reviewer cell: its lens' evidence on those findings, C if the finding is proven, else h; m in its lens; - elsewhere; n if not run
   alarms: findings on the control case, per reviewer (by the lens on their evidence); tokens: reported, else the plan's estimate
   complete (every planned reviewer reported on both) ─▶ keepResult: one summary per run per project
routedOut(project): a lens whose last two finished runs both had chances and zero own-lens hits ─▶ previewPanel skips it ("calibration") unless include names it
```

- The throwaway cases are ordinary cases in a repository that is not the project, so the whole panel (briefs, the gate, cross-examination) works on them unchanged, and the dashboard (which opens only the project's own cases) doesn't show them.
- Scoring is derived, never stored: the two cases hold every finding and every claim.

## The dashboard

```
packages/web/src/
  server.ts       the http server: sign-in, host and origin checks, static files by exact name, JSON in and out
  security.ts     the key, the cookie, the Host and Origin checks, the content security policy
  api.ts          every request the page can make, and the case as the page needs it (verdict, a state per finding, the order)
  jobs.ts         a queue that runs one job at a time, keeps what it said, and can stop it
packages/web/public/
  index.html      the shell: sidebar, main, two dialogs. No inline script or style
  dashboard.css   what the dashboard adds to the shared stylesheet (served from core/assets)
  js/             main (shell, routing, Jump to) · state (the address) · lib (the html tag, api, jobs, morph)
                  timeline · case · compare (before and after) · reviewers · memory · settings
```

Nothing is computed twice. The verdict, the order of findings and each finding's state come from the core (`verdictOf`, `findingState`) and are sent with the case; the page only draws them.

**Requests.** `GET` state, timeline, cases, case, brief, panel, calibration, memory, settings, job, shot. `POST` open, resolve, replay, prove, look, stop, panel/plan, panel/budget, calibration/start (a job), calibration/clean, memory/pack, memory/entry, memory/add, memory/remove, memory/mine (a job). Every `POST` needs the page's own `Origin` and a JSON body. These are the page's own, not a public API, and can change.

**Jobs.** Replay, prove and look return a job at once. The page polls it (`queued`, `running`, then `done`, `failed` or `stopped`), shows the lines it said, and *Stop* aborts an `AbortSignal` that the core passes down: a test run's whole process tree is killed, a page check stops before its next page, and a stopped run keeps nothing. A case can't be resolved while a job is using it (`409`), because both would write the same file.

```
page ─▶ POST /api/prove ─▶ allowed? (else 403 with the command) ─▶ Jobs.start ─▶ returns {id}
page ─▶ GET /api/job?id ─▶ {state, messages[], result?}   (every 600 ms while it runs)
job:    own(case) ─▶ proveCase(case, {signal, onProgress}) ─▶ {report, case view}
```

**The page.** Plain modules, no build step and no library. Text reaches the screen only through the `html` template tag in `lib.js`, which escapes every value unless it is html another `html` tag made. A size or position goes into `data-css` and is applied with the style object after rendering (the content policy blocks the `style` attribute). Pages draw from one state object; the address (`#/page?…`) holds the slice being looked at.

## The pieces worth knowing

- **`exportTree`** (`proof/tree.ts`): `git read-tree` into a temporary index file, then `git checkout-index --prefix=<dir>/`. The repository's working tree, index and `.git` are never touched. `linkDependencies` rebuilds each `node_modules` as a real folder of links (junctions on Windows), pointing a workspace package at the checkout's own copy. `removeTree` unlinks the links first and keeps the folder if any link can't be removed, so deleting a checkout can never reach into your real packages.
- **The DevTools client** (`browser/cdp.ts`): about 150 lines. The browser is launched with `--remote-debugging-pipe` and two extra inherited pipes; messages are JSON ended by a NUL byte. No library, no port.
- **The in-page inspector** (`browser/inspect.ts`) is plain JavaScript in a `String.raw` string, because the core has no DOM types. It measures overlap, cut-off text, contrast, sideways scroll, accessibility basics and blank pages, and returns the class and id names of the elements involved so a finding can be anchored on the rule that styled them.
- **Screenshot comparison** runs inside the browser (a canvas), because the browser can already decode a PNG and the core has no image code.
- **Measured boxes.** The inspector also returns where each problem is (for an overlap, the area the two elements share). `lookCase` keeps, on each picture, the boxes of what was measured in that combination and was not there at the base, so the dashboard can draw them over the picture as a share of the window's size.
- **The report** (`report.ts`) is a single HTML file with the fonts embedded as base64 and a few lines of script. Everything that came from git or a page (subjects, paths, code, evidence text) is untrusted and escaped.

## Tests

191 tests across the four packages, run with `npm test` (it builds first):

- the diff parser, the tier function, risk, masking, and the checks, on fixture repositories built with the real `git` in the OS temp folder
- `calibration.test.ts`: one test per false positive found by running Assay on real repositories
- the evidence gate and claims
- proof against fixtures with a **real test suite** (`node --test`): a real regression, a real untested hunk, a real surviving mutant
- the browser against **real pages in a real browser** (skipped, loudly, where none is installed)
- the CLI as a user runs it, and the MCP server through a **real MCP client over stdio**
- planting and calibration (`planting.test.ts` in core, `calibration.test.ts` in the dashboard): what fits a project and what is left out, exact lines for every planted bug, neutral names, the project untouched, the free checks scored (and no false alarm on the clean twins), reviewers scored against the truth (caught with and without proof, missed, false alarms, tokens per catch), a reviewer left out after two runs and brought back by an include, old runs cleaned; also through the CLI, HTTP and a real browser (`calibration-ui.test.ts`)
- reviewers (`reviewers.test.ts`): routing and its reasons, budget arithmetic (a small budget, a tiny one, free only), a plan kept and reopened, briefs per lens (own slice only, secrets masked, memory's questions), a reviewer never shown another's claims, a lens prompt replaced by a file, counts by what the gate did, cross-examination (never the author, anonymous, a confirmation corroborates, a dispute changes no tier), and the Stop hook (blocks, lets go, counts per session, requires a panel); also through MCP, the CLI, HTTP and in a real browser (`reviewers-ui.test.ts`)
- memory (`memory.test.ts`): the bundled packs and the pack validator, hits counted once, dismissal and its undo, a pack switched off and on, proof never muted, an entry that cries wolf and switches itself off, a pattern refused when it could hang, the tokeniser, mining on a planted history, a learned pattern flagging the next commit as corroborated and never blocking, and a broken memory file leaving everything else working; also over HTTP (`memory.test.ts` in `web`), through the CLI, as an MCP tool, and in a real browser (`memory-ui.test.ts`)
- the dashboard: its key, host and origin checks, its content policy and the files it serves (over real HTTP), a **real `npm test` run** started, stopped and replayed from the page, and the **real page in a real browser**, with an inline handler typed into it to check that the policy blocks it

Tests set `ASSAY_HOME` to a temp folder and never touch a real repository or a real `~/.assay`.

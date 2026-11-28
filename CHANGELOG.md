# Changelog

All notable changes. Back to the [README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com); versions follow [Semantic Versioning](https://semver.org) and each release is a git tag (`v0.1.0`). Before 1.0 anything may still change between minor versions.

## Unreleased

## 0.2.0 — 2026-11-28

Project mode and the checks that sister tools handed over: a checkup of the project as it is, `assay test`, the page checks that moved into `look`, untranslated text, `assay attack`, `assay gremlins` and `assay try`, each with a CLI command, an MCP tool and a versioned JSON answer. The shared kit is now `@haithamexe/plainkit` from npm, so a clone installs. Tools that used to carry these checks now hand them to Assay.

### Fixed

**Found by running the free checks over the recent history of eight real projects** (565 commits, read only), then on a copy of Assay itself
- **A password in a URL to this computer is no longer a proven secret.** A development database in `.env.example`, a CI file or a test setup (`localhost`, `127.0.0.1`, `[::1]`, a service name with no dot such as `postgres`, or `example.com`) is shown as a hint; a real host, or one real host among local ones on the same line, is still proven. Before, each of these blocked the commit.
- **"A guard was removed" is quieter.** Not reported when the function or handler that held the guard was deleted or moved whole (a signature that was only rewritten still counts), when the line is a branch on a value (`if (kind === "a")`; a refusal with `throw` still counts), or when the change adds a call to a check helper (`checkKey(`, `validateInput(`). On eight real projects the corroborated reports fell from 124 to 27.
- **A `"*"` next to a package the repository holds itself is the workspace link,** not an open version range (29 corroborated reports to none), and the plain dependencies of a manifest that is itself new are the baseline, as in a first commit (all "New dependency" reports together: 190 to 86). Look-alikes and open ranges in it are still reported.
- **The function before-and-after comparison no longer misses an escaping helper.** The text inputs now include markup and URL characters; a real change that stopped escaping quotes in a page helper was reported as "none answers differently" before.
- Together, on those 565 commits: commits that needed a decision 75 to 32, proven findings 28 to 8 (the four commits still blocked add real `.env` files). Each fix is pinned by `realworld.test.ts` or `behave.test.ts` with made-up names and the shape that was found.


### Added

**Try an upgrade: `assay try <package>[@version]`** ([guide](docs/PROJECT-MODE.md#try-an-upgrade-assay-try), D67)
- Before upgrading a package: two clean copies of a commit get your project's own install (the lockfile's versions), then the second gets that one package at the new version. A tag (`next`) or a partial version (`19`) is resolved by the package manager. The type check, the build and the tests run in both, and your dev server runs from both and the pages are compared in a browser (what they show, what they call, errors, speed, accessibility, a before and after picture).
- The report says what breaks first (the install, the type check, the build, more tests failing and which, a page that no longer opens or throws), then what changes (it looks different, new problems, slower, heavier), or that nothing changed that Assay can see. `--fail-on breaks|changes`, `--json` (`assay.try/1`), `--pages`, `--no-pages`, `--no-tests`, `--ref`. npm, pnpm, yarn and bun. MCP: a `try` tool.
- **The one check that reaches the internet, behind its own yes:** `assay allow-run --network` (Assay makes no call of its own: the package manager does, with your own registry settings). Install scripts are not run unless you add `--scripts` in your terminal; the MCP tool has no such argument. Both copies are removed after, and your own folder and `node_modules` are never touched.

**Gremlins: `assay gremlins`** ([guide](docs/PROJECT-MODE.md#gremlins-assay-gremlins), D65)
- A headless browser goes through your app by itself like an impatient, careless person: clicking whatever it finds, typing odd text into fields, double-clicking submit, pressing Enter, going back halfway. Seeded, so the same seed does the same things; each problem (uncaught error, blank page, the framework's error screen, server error, failing request, logged error) comes with the steps that led to it.
- Behind `assay allow-run` **and** your own `assay allow-run --writes` (a click can save and a typed text can be sent). The browser talks to this computer only: a request to anything else is refused before it leaves and the hosts are listed. Controls named like delete, sign out or reset are left alone unless `--bold`.
- `--url` goes through an app that is already running. With a commit instead, Assay starts your dev server (or serves your HTML) in a clean copy, and with `--base` runs the same seed at both ends and reports only what is new, anchored on a changed line when one wrote what the problem names. `--phone`, `--actions`, `--seed`, `--page`, `--fail-on high|medium|low`, `--json` (`assay.gremlins/1`). MCP: a `gremlins` tool.
- **Signed in** (D66): a session for an app behind a login goes in `ASSAY_SESSION_COOKIE` / `ASSAY_SESSION_AUTHORIZATION` (the older `ASSAY_ATTACK_*` names still work, for attack too), with `--url`. The cookie is set on the app's origin, the Authorization header goes to that origin only, and the session is replaced with `[session]` wherever the page echoes it.
- **Kept and compared** (D66): each run is kept (the last 30) and compared with the last one of the same app: each problem is first, new or there before, and what is gone is listed. `assay gremlins list`, `show`, `--no-save`.
- **Replayed exactly** (D66): `assay gremlins replay <run> [--finding g-…]` does again the very steps a run recorded, in order, and says whether the problem came back (exit 2 when it did).
- **A Gremlins screen** in the dashboard: the kept runs, each problem with its steps, the comparison, and the command to run or replay (the page runs nothing).

**Attack my app: `assay attack`** ([guide](docs/PROJECT-MODE.md#attack-my-app-assay-attack), D64)
- A security pass on your own app, running on this computer. Give its address (`--url`; Assay never starts it, and only `localhost`, `127.0.0.1`, `[::1]` or a `.localhost` name is accepted). The endpoints come from the repository's routers and OpenAPI file, a HAR and `--pages`, read without running anything.
- Reads (GET only): security headers, cookie flags, CORS from another origin, script in the address that comes back unescaped (and, in a real browser, becomes an element), stack traces and SQL errors after a quote. With a session in `ASSAY_SESSION_COOKIE` or `ASSAY_SESSION_AUTHORIZATION`: calls that answer without it, and other ids. A GET named like an action (`logout`, `delete`, `reset`) is never sent.
- Writes, behind `--writes` **and** your own `assay allow-run --writes` (no agent, tool or page can set it; `--off` takes it away): script saved through a form, a write sent as another site would send it, 20 wrong passwords, a broken body. A body is built from the OpenAPI file's property names and types, never from a recorded body.
- Each finding has the request that shows it, the declaring file when known, a fix, and a tier computed from its evidence: **proven** when the response shows it whatever was meant, **hint** when it depends on what was meant (no-auth, other ids). `--fail-on high|medium|low` exits 2 on a proven finding that serious; `--json` is `assay.attack/1`. MCP: an `attack` tool (no session argument, `writes` refused until a person allows it).
- The OpenAPI reader keeps each operation's JSON body as property names and types (never an example or a default); a checkup's list leaves them out unless asked for.

**Text that isn't in the translation files** (`look`, [checks](docs/CHECKS.md#browser-checks), D63)
- In a project with translation files (JSON, YAML or `.po` in a `locales`, `i18n`, `messages` or `translations` folder), `look` reads what each page shows at the head and compares it with them. Placeholders and ICU plurals are understood, so a translation with its values filled in counts. Numbers, codes, emails, addresses and what the page's JSON script tags hold are data, not words.
- A text is a finding only if it is new at the head **and** a changed line of a source file wrote it (not a translation file, a test or a fixture), so text from an API or text that was already there never shows. It is anchored on that line, low, and replays as a comparison of both ends.
- `look` says how many texts the pages showed and how many no file has (`translation` in the JSON), and tells a project that names a translation library but has no files where it looked.

**Tests leave nothing behind.** `npm test` runs the suite through plainkit's `temp-run`: the fixtures, the throwaway repositories, the checkouts and the browser profiles all go into one temp folder for the run, which is removed at the end (a killed run's folder goes with the next run after 12 hours). Before, every run left a few hundred folders in the system's temp folder.

**More in `look`: accessibility, speed, and what changed underneath** ([checks](docs/CHECKS.md#browser-checks), D62)
- Four more accessibility rules, measured on each page in every combination and counted only when new at the head: the page has no language (WCAG 3.1.1), heading levels skip (1.3.1), a positive `tabindex` changes the keyboard order (2.4.3), an id is used more than once. They are in the WCAG 2.2 and pages packs.
- Speed: each page is loaded three more times at each end (desktop, light) and its largest paint, load time, blocked main thread, layout shift and script size are compared. A page counts as **clearly slower** only when the middle moved by a clear margin *and* every load at the head was slower than every load at the base, so a noisy dev server can't prove anything. **Clearly more script** is 20 KB and 10% more. Both are measured, never block, and are anchored on the script that changed. `--no-speed` (MCP `speed: false`) skips them.
- What changed underneath: each page's data calls (by method and path, ids folded; never a query value, a header or a body), its console warnings and its title, base against head. Every change is listed (`calls` in the JSON, a line in the CLI and MCP answers); a call made more often is a finding (`behaviour-diff`, low) and so is a new warning (low). Both replay as a comparison: the two ends are opened again.
- plainkit's page now records every request (method, address, kind, answer, redirects followed) and `console.warn`, and a failed request carries its address instead of the browser's request id.

**Running the tests once: `assay test`** ([usage](docs/USAGE.md#assay-test), D61)
- Runs the project's own test command once, at a commit (HEAD by default), in a clean copy, and reads the runner's own report rather than its coloured output: how many passed, failed and were skipped, and each failure with its name, file, line, message, expected and actual. vitest and jest (their JSON), node:test (TAP), pytest (JUnit XML) and go (`-json`) are read in full; any other runner Assay finds, or a command you chose, is read from what it prints.
- `--coverage` adds the share of lines the tests ran and the least covered files: istanbul's summary for vitest and jest, pytest-cov's JSON, go's cover profile, and V8's own coverage for node:test (nothing to install). Where a provider is missing it says what to install, and the tests still run.
- `--match` and `--files` narrow it. A filter or file is an argument, never a command: the runners with a report start without a shell, and anything that could be read as an option, or a path outside the repository, is refused.
- `--here` runs in your own folder, uncommitted work included, and needs its own yes: `assay allow-run --here` (`--off` takes it away). `--changed` (with `--here`) runs only the tests for uncommitted changes, for vitest and jest.
- Failure messages, the output and file names go through the secrets masking like everything else. `--json` follows `"schema": "assay.test/1"`. Exit code 1 when a test fails.
- MCP: a `test` tool, refused until a person ran `assay allow-run`, and `here` refused until they ran `assay allow-run --here`.
- `runCommand` can keep what a command printed to stdout (`keepStdout`), for go's report.

**Project mode: `assay checkup`** ([guide](docs/PROJECT-MODE.md), D60)
- A checkup of the project as it is, not of a change: every tracked file at a commit (HEAD by default) goes through the secrets check, so a key, a key file or a `.env` file committed long ago is found and proven, masked as always. Only what is committed is read; uncommitted changes are counted, not checked.
- From the second checkup on, each finding says whether it is **new** or **already there**, and what is **gone**. A finding is matched by its check, its file and its line's text, so a key that moved down a few lines is still the same one. The last 30 checkups per repository are kept (`--no-save` keeps none; `assay checkup list` shows them).
- `--fail-on new` exits 2 when something proven or corroborated is new since the last checkup, `--fail-on any` when there is anything at all: an old problem doesn't have to fail every build.
- `assay secrets` runs only that check. `assay show <id or key>` shows one checkup finding.
- It also lists what the project describes, for the checks that will load pages or call the app: pages and endpoints from Next.js, Nuxt, Astro, SvelteKit and Remix router folders, plain HTML files, Express-style and NestJS routes, and the repository's own OpenAPI file; plus what you hand it: `--url` (an app on this computer only), `--pages`, `--har` (only methods and paths are kept: never a header, cookie, query value or body), `--flow` (Assay's `flow/1` steps, or a Chrome DevTools Recorder export) and `--openapi` (JSON or YAML).
- `assay checkup --json` follows a versioned contract (`"schema": "assay.checkup/1"`), so CI and other tools can read it.
- MCP: a `checkup` tool with the same inputs and a short answer.

### Changed
- The DevTools pipe client, the browser search, atomic writes, the home folder and stopping a process tree now come from **plainkit**, a small library with no dependencies that sister tools share (D58). npm installs it with Assay; nothing else changes for you. `CHROME_PATH` now points Assay at a browser too, after `ASSAY_BROWSER`. The YAML reader for OpenAPI files comes from plainkit as well.
- **`assay look --json` names its contract and lists the findings.** The answer now starts with `schema: "assay.look/1"` and carries the browser findings (title, severity, tier, file, line, what was observed) next to the report's counts, so another tool can show what the pages did without reading the case. Only fields were added.

## 0.1.0 — 2026-11-27

The first release: the engine and its free checks, built-in proof, browser checks, the dashboard, memory, reviewers and their scoreboard. Everything below was built after the first version of 2026-11-25, which is kept at the end of this entry.

### Added

**The demo and the pictures follow the product**
- The demo's Scoreboard shows the attack pass (a row and an *Atk* column, with what it adds) next to the plain review, and a *From your own history* card with sample data. `npm run screenshots` retakes the dashboard's scoreboard with the attack pass and the plain review in it.

**Arabic text in the browser checks** (`assay look`, MCP `look`)
- A twelfth combination (on both sizes and both colour schemes): the page is mirrored, set to `lang="ar"`, and its own text is swapped for real Arabic letters about 30% longer, so the browser shapes them and falls back to an Arabic font as it would for a translation. Mirroring alone never met a box sized for English words. The same swap is made at the base and at the head, so only what the change added counts, and a problem seen only here says so ("… with Arabic text").
- It is pseudo-localisation, not a translation. A desktop picture is kept for it on the before-and-after screen.

**Mutation reads each file in its own language**
- The deliberate changes `assay prove` makes to see whether the tests notice used one set of operators and one idea of a string for every language. Now each file is read as its own language: `===` only in JavaScript, `and`, `or`, `not`, `is None` and `True` in Python, `if !ok {` with no parentheses in Go and Rust, a Rust lifetime is not a string, a `#` is a comment in Python and an attribute in Rust, and SQL is not mutated.
- A comment, the inside of a string, a block comment or a docstring, an import, an annotation, a `+` that joins text and an array length are never mutated, so fewer runs are wasted on changes that don't compile.

**The attack pass is scored** (`assay calibrate`, the Scoreboard, [guide](docs/CALIBRATION.md#the-attack-pass-scored))
- A calibration run now plans the attack pass and scores it: a row (*Attack pass (no lens)*) and an *Atk* column in the matrix. It has no lens, so every planted bug is a chance, and its false alarms are its flags on the clean twin.
- The advice says what it adds: how many of the bugs it flagged nothing else flagged (not the free checks, not any lens), so you can judge whether the 80k budget it needs is earned on your project.

**Three known limits, closed**
- **More test runners are found by themselves**: `dotnet test`, Maven, Gradle (the wrapper when there is one), `deno test`, `bundle exec rspec` and `make test`, after the ones that were already there. Fixed words only, never from a request.
- **A renamed file is still looked for.** A finding in a file the range only renamed is no longer marked fixed, and a fix made after the rename is found.
- **The shell, deserialisation and certificate rules know Java, Kotlin, Scala, C# and Rust** (`Runtime.getRuntime().exec`, `ProcessBuilder`, `Process.Start`, `Command::new("sh")`, `BinaryFormatter`, `danger_accept_invalid_certs(true)`, a certificate callback that always says yes), each pinned with a look-alike that must not fire.

**Function before and after** (`assay prove`, MCP `prove`, the run panel)
- For each function the range changed, Assay gives the **same inputs to it at the base and at the head**, in clean checkouts, and shows where the answers differ: `discount(200, 10)` returned 180 and now returns 2000. JavaScript and Python. This is the `behaviour-diff` proof that was reserved from the start.
- Only exported functions that existed at the base, take at most six plain parameters and don't look impure (a clock, a file, the network, a random number) are compared; every other changed function is listed as skipped, with the reason. It is not a verdict (the change may be what was meant), so a difference is medium (low if a test changed in the range) and never blocks. It replays. `--no-behaviour` and MCP `behaviour: false` skip it.

**Real bugs from your own history** (`assay calibrate history`, the Scoreboard, [guide](docs/CALIBRATION.md#replaying-your-own-history))
- The planted bugs are invented; your fix commits are real. A fix removes lines, `git blame` says which commit last wrote each, and that line, in that commit, is the truth. Each such commit becomes a case of its own; the **free checks are scored on it at once** (caught with proof, flagged, missed), and your agent runs the reviewers, the attack pass and one plain review on it, scored on whether they flagged the line the fix later removed.
- It says what it is: a removed line is a proxy for the defect, only commits that call themselves fixes are used, and there are no false alarms to count (nobody knows the rest of a commit is clean). It reads git and runs nothing. `assay calibrate history`, `start`, `score` and `clean`; the Scoreboard shows the result (read only: starting one is a command).

**A plain review as the baseline** (calibration runs, [guide](docs/CALIBRATION.md#the-baseline-one-plain-review))
- A calibration run now also plans **one plain review** on both cases: one reviewer with no lens, no free findings and no questions, handed the whole change. It gets a row (*One plain review (no lenses)*) and a matrix column on the Scoreboard, and its advice says what the lenses add over it: whether the panel earns its extra tokens on your project, or one plain review would have done.
- It is blind like the rest, what only it claimed is left out of cross-examination (it is a measuring stick), and it is never planned in a real review. Its prompt is `plain.md`: yours in `~/.assay/lenses` replaces it.

**The attack pass** (`reviewer_brief` with lens `attack`, `finding_submit` as `Attack`, [guide](docs/REVIEWERS.md#the-attack-pass))
- One more reviewer, outside the lenses, whose only job is to **break the change**: for each break it says the concrete input or sequence, what the changed code does with it (citing the line) and what should have happened. It is planned only on a budget of 80k tokens or more, when a reviewer is worth running and something that runs or is shown changed; below that it isn't listed.
- It is as blind as the other reviewers (the changed files that run, the tests that changed by name, what the free checks found, never another reviewer's claims), meets the same evidence gate (a second source at a flagged line corroborates, elsewhere a hint, never proof, never blocking), and cross-examination waits for it and then examines what only it claimed. Its prompt is `attack.md`: yours in `~/.assay/lenses` replaces it.
- The Reviewers screen says "Cross-exam + attack" and adds an Attack segment to the token meter. Assay still never calls a model.

**Which commit broke it** (`assay prove`, MCP `prove`, the run panel)
- When tests that passed at the base fail at the head, Assay now finds the **first commit in the range where they fail**: it runs the tests in the middle of the range and keeps halving, so 5 commits take 2 runs and 200 take 8. Every run is cached by commit, so asking again is free and a search that was stopped carries on.
- The finding says "starting at `abc1234`", and the case gets `proof:bisect` evidence, proof like the rest, that replays by running the two commits again. It follows the first-parent line from the base (a merge is one step) and needs the tests to have passed at the base. It says so when it can't search (a red base, a base on a side branch) or stops short (a run in the middle that timed out or could not start), and then narrows to "one of N commits after `abc1234`".
- `--no-bisect` (CLI) and `bisect: false` (MCP) skip it. The dashboard's run panel has a *First failing commit* row.

**License**
- Assay is under the MIT license ([LICENSE](LICENSE)); the repository is public, with GitHub's private vulnerability reporting switched on.

**Calibration** (`assay calibrate`, the *Scoreboard* tab, [guide](docs/CALIBRATION.md))
- Known bugs are planted in a **throwaway repository shaped like your project** (your languages, your folders; none of your code is copied and nothing in the project is touched), each with a clean twin written correctly. 18 kinds across JavaScript and TypeScript, Python, CSS, HTML and a manifest, whichever fit; the rest are listed as left out, with the reason.
- **The free checks are scored on the spot, at no cost:** each bug is caught with proof, flagged, or missed, and every flag on a clean twin is one of Assay's own false alarms (there are none). Then your agent runs the reviewers on both cases, and each is scored on what it caught, missed and flagged in clean code, with tokens per catch (an estimate, unless the agent reports its use).
- **A reviewer that caught none of the bugs planted in its lens in its last two finished runs is left out of plans** (it says so, saves its tokens, and `--include` / `include` brings it back). One run only advises.
- The dashboard's Scoreboard: the table, the matrix of every bug against every reviewer, the words to give your agent, live as they report.
- `reviewers_plan` takes `include`; `assay reviewers` takes `--include`.

**Windows, macOS and Linux**
- Tested on Windows, on Linux (Node 22 in a container, with Chromium, as root) and on macOS (by the CI workflow below, on Node 22 and 24): browsers are found where each system puts them (more places on Linux and macOS), a browser started as root or in a container gets the flags it needs, and a repository's key is case-sensitive only where the file system is.
- A CI workflow (`.github/workflows/ci.yml`) runs the suite on Ubuntu, macOS and Windows with Node 22 and 24. It runs on every push to main and every pull request, and can be started by hand. Its first run, on all six combinations, found the two bugs listed under "In the core" below; the next run passed on all six.
- `docs/TROUBLESHOOTING.md#platforms` says what differs on each system.

**Reviewers** (`assay reviewers`, the *Reviewers* screen, the MCP tools `reviewers_plan` and `reviewer_brief`, [guide](docs/REVIEWERS.md))
- A panel of reviewers, each through one lens (security, correctness, UI and accessibility, tests, supply chain, performance, and a triage that traces each change to the request). **Assay never calls a model**: the reviewers are sub-agents of the agent you already use. Assay works out who is worth running, shows **what it costs before anything is spent**, and counts what comes back.
- Routing is plain facts about the change, with a reason in a sentence for each reviewer that runs or doesn't. The budget is spent on the most justified first, keeping room for cross-examination; one that doesn't fit says why. `assay reviewers budget` sets it per project.
- **Blind briefs**: each reviewer is handed only its own lens and its slice of the change (with the line numbers a claim must cite), what the free checks already found, and the project's memory questions for that lens. Never another reviewer's work, and secrets in the diff are masked. Prompts are Markdown files you can replace.
- **Cross-examination**: when every reviewer has reported, each claim only one reviewer made goes, anonymously, to a different reviewer, who confirms it (a second independent signal: corroborated) or disputes it (shown, no tier changes).
- `finding_submit` gains `done`, `round`, `disputes` and `tokens`; the panel is kept on the case and counted by what the evidence gate did.
- The dashboard's *Reviewers* screen: the plan and cost (a preview until planned), six steps, a card per reviewer, a token meter, what the gate kept and dropped, disputes, and the words to give your agent. It follows an agent that reports.
- **A Stop hook** (`assay hook install`, `assay hook stop`): an agent that is about to say "done" is told what to fix if Assay's own verdict is Blocked. It only looks at a branch that left the default branch, lets go after 2 tries, and never edits your settings.
- Standards-pack questions can name the reviewer they are for (`lens`).
- `npm run check:public` looks for emails and home-folder paths before a commit (this is a public repository).

**Memory** (`assay memory`, the *Memory* screen, the MCP tool `memory`, [guide](docs/MEMORY.md))
- Every finding is counted against the mistake it is an instance of: a **hit**, or a **false alarm** when a person dismisses it (taking that back undoes it). Stats are read from a table of hits, never counted up, and shown next to the finding.
- An entry that keeps crying wolf (at least 4 hits, 30% dismissed, nothing real for 60 days) **switches itself off**, and what it found is no longer reported. A person can turn it back on. Only a signal can: proof is never muted.
- **Standards packs** are plain JSON files: OWASP Top 10 (2025), WCAG 2.2 AA, tests, pages, basics and a starter set of review questions ship with Assay; yours go in `~/.assay/packs` and win over a bundled one. A pack can be switched on or off per project, and a file that doesn't pass is skipped and reported. `assay memory import` checks and copies one.
- **Learning from history**: `assay memory mine` (and the dashboard) reads the fix commits, keeps what fixes keep removing and replacing in the same way, and suggests patterns with examples. Nothing is added until a person says so. An added pattern flags the next commit that writes it again as **corroborated** (the pattern plus the project's own record of fixing it), never proven, never blocking.
- **Questions for a reviewer**: the rules no check can decide are kept as questions (`assay memory questions`, and the MCP tool).
- The dashboard's *Memory* screen (mistakes, standards, learn from history) and a memory callout under each finding in the case file. The MCP server gains one read-only tool, `memory`, and tells an agent when to use it.
- Memory is SQLite through Node's own `node:sqlite` (Node 22.13 or newer). Without it, or if the file is broken, memory is off with a reason, and nothing else changes. `assay doctor` says which.
- Memory is part of the key of each commit's cached analysis, so switching something off or learning a pattern makes the commits you look at next be analysed again, once; a project that uses no memory keeps every cache it had.

**The dashboard** (`assay dashboard`, [guide](docs/DASHBOARD.md))
- The demo's screens on real cases: a timeline of what the free checks found on each commit (pick one commit, a range or the whole branch), the case file (verdict, findings most important first, code, evidence, before and after), and settings. `Ctrl K` jumps to a page, a commit or an action.
- **Run the tests** and **Look at the pages** from the page: a panel shows what is running, line by line, and has a **Stop**. Evidence can be reproduced, findings dismissed or marked intended with **Undo**, and the brief copied for an agent.
- Before and after from the real pictures: slider, side by side or difference, with boxes measured on the page for the kind of problem a finding is about.
- It listens on `127.0.0.1` only, behind a key that only that run knows (an `HttpOnly`, `SameSite=Strict` cookie), checks `Host` and `Origin`, and serves a page with a strict content policy and no inline script. It can show whether running your code is allowed and **cannot** switch it on: it shows the terminal command.
- It watches the repository and offers a refresh when a commit arrives.
- `npm run dashboard:demo` opens it on a sample project.

**In the core**
- A run can be stopped (`signal` on `proveCase` and `lookCase`): a test run's process tree is killed and a stopped run keeps nothing.
- The browser checks keep, on each picture, the boxes of what was measured there and was not there at the base.
- The timeline rows say which lenses their findings are about; `branchSpan`, `findingState`, `openCase({ span })` and a shared `doctor`.
- Fixed: a failed dev server left its headless browser running until the process ended.
- Fixed (found by the first CI run): **a folder is one repository however it is spelled.** The key behind allow-run, memory, caches and calibration comes from the real folder, so a folder reached through a link (macOS keeps `/var` and `/tmp` behind one) or by a Windows 8.3 short name is no longer taken for a second repository, one that was never allowed to run anything and had no memory.
- Fixed (found by the same run): two calibration runs started in the same second got the same commits and so the same cases, with the first run's reports in the second. Each run now has its own.

25 more tests for the dashboard (86 in all), 29 for memory (115), 24 for reviewers (139) and 14 for calibration (153), plus 2 for the fixes above (155), 10 for finding which commit broke the tests (165), 20 for the attack pass, the plain review and the replay of your own history (185), 6 for function before and after (191), 4 for the known limits (195) and 10 for scoring the attack pass, language-aware mutation and Arabic text (205), including the dashboard over real HTTP, a real test run stopped from the page, and the real page in a real browser.

### Not built yet

Nothing is queued: what is left is the known limits in the [charter](docs/PROJECT.md#7-where-it-stands). Not yet checked on macOS or Node 24 since GitHub Actions ran out of quota for this account; the suite passes on Windows and on Linux (Node 22).

### The first version, 2026-11-25

The engine, proof and browser checks.

#### Added

**The engine and the free checks**
- Reviews a branch or a range of commits by reading git only: committed secrets, risky patterns (HTML injection, `eval`, shell commands, SQL built from text, certificate checks off, deserialisation, CORS `*`, weak hashes and randomness, unchecked tokens, focused or skipped tests), a removed guard or assertion, dependency changes (look-alike names, unpinned versions, install scripts) and logic that changed with no test. [All checks](docs/CHECKS.md)
- Evidence, with tiers computed from it: proven, corroborated, hint. Only proven findings can block.
- A verdict (blocked, can merge with fixes, clear), findings ranked by risk with the reasons, a check that a finding is still there at the head of the range, and a short fix brief.
- Per-commit analyses cached by hash, so picking a range again is instant; cases that keep your resolutions and everything that was run.
- A one-file HTML report with the fonts embedded.
- The evidence gate for reviewers' claims: a claim must cite a line inside the diff, can't claim proof, and can't block.

**Proof** (`assay allow-run`, `assay prove`)
- Runs the project's own tests in clean copies of the base and the head (made without touching the repository). A test that passed before and fails now is a proven regression, anchored on the changed line the failure points at.
- A revert test and a mutation pass on the changed lines, with caching, a time budget and replay.
- Opt-in per repository; only you can turn it on.

**Browser checks** (`assay look`)
- Opens the pages at the base and the head in a Chromium-based browser already on the machine, through Assay's own DevTools client over a pipe, in 8 combinations (desktop and phone, light and dark, as loaded and mirrored right to left).
- Reports what is new at the head: overlapping or cut-off content, unreadable text, sideways scroll, accessibility basics, a blank page, uncaught errors, failed requests, and an XSS probe. Each is measured and points at the changed line that caused it.
- Before and after screenshots, compared inside the browser, with a slider in the report.
- Plain HTML files are served by Assay itself; anything else uses the project's dev server.

**The command line and the MCP server**
- `assay case`, `timeline`, `show`, `brief`, `replay`, `report`, `resolve`, `cases`, `doctor`, `allow-run`, `prove`, `look`, with `--fail-on` for hooks and CI.
- An MCP server with ten tools and instructions that tell an agent when to use them. An agent can't turn running on, and can't dismiss a proven finding.

**Docs and samples**
- The [charter](docs/PROJECT.md), the [design system](DESIGN.md), the [security model](SECURITY.md), and guides for [getting started](docs/GETTING-STARTED.md), [usage](docs/USAGE.md), [how it works](docs/HOW-IT-WORKS.md), [the checks](docs/CHECKS.md), [the MCP server](docs/MCP.md), the [architecture](docs/ARCHITECTURE.md) and [troubleshooting](docs/TROUBLESHOOTING.md).
- A clickable demo of the planned dashboard (sample data) and two real sample reports in `demo/`.

#### Tested

61 tests, including a real MCP client over stdio, real `npm test` runs for the proof, and real pages in a real browser (skipped where none is installed). Also run read-only on five real repositories, which found the false positives now pinned by `calibration.test.ts`, and on a throwaway copy of Assay itself (a TypeScript monorepo with workspaces).

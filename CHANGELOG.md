# Changelog

All notable changes. Back to the [README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com); the project is not versioned for release yet.

## Unreleased

### Added

**Calibration** (`assay calibrate`, the *Scoreboard* tab, [guide](docs/CALIBRATION.md))
- Known bugs are planted in a **throwaway repository shaped like your project** (your languages, your folders; none of your code is copied and nothing in the project is touched), each with a clean twin written correctly. 18 kinds across JavaScript and TypeScript, Python, CSS, HTML and a manifest, whichever fit; the rest are listed as left out, with the reason.
- **The free checks are scored on the spot, at no cost:** each bug is caught with proof, flagged, or missed, and every flag on a clean twin is one of Assay's own false alarms (there are none). Then your agent runs the reviewers on both cases, and each is scored on what it caught, missed and flagged in clean code, with tokens per catch (an estimate, unless the agent reports its use).
- **A reviewer that caught none of the bugs planted in its lens in its last two finished runs is left out of plans** (it says so, saves its tokens, and `--include` / `include` brings it back). One run only advises.
- The dashboard's Scoreboard: the table, the matrix of every bug against every reviewer, the words to give your agent, live as they report.
- `reviewers_plan` takes `include`; `assay reviewers` takes `--include`.

**Windows, macOS and Linux**
- Tested on Windows and on Linux (Node 22 in a container, with Chromium, as root), and written for macOS: browsers are found where each system puts them (more places on Linux and macOS), a browser started as root or in a container gets the flags it needs, and a repository's key is case-sensitive only where the file system is.
- A CI workflow (`.github/workflows/ci.yml`) runs the suite on Ubuntu, macOS and Windows with Node 22 and 24. For now it runs only when started by hand; once the repository is public the push and pull request triggers can be switched on.
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

25 more tests for the dashboard (86 in all), 29 for memory (115), 24 for reviewers (139) and 14 for calibration (153), including the dashboard over real HTTP, a real test run stopped from the page, and the real page in a real browser.

### Not built yet

Replaying the project's own fix commits as a benchmark, the plain-review baseline, the attack pass, function-level before/after, tracing a regression to one commit. See the [charter](docs/PROJECT.md#5-phases).

## 0.1.0 — 2026-11-25

The first version: the engine, proof and browser checks.

### Added

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

### Tested

61 tests, including a real MCP client over stdio, real `npm test` runs for the proof, and real pages in a real browser (skipped where none is installed). Also run read-only on five real repositories, which found the false positives now pinned by `calibration.test.ts`, and on a throwaway copy of Assay itself (a TypeScript monorepo with workspaces).

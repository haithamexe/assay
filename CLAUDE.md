# CLAUDE.md

Guidance for Claude Code in this repository. The charter (principles, model, phases, decisions) is [docs/PROJECT.md](docs/PROJECT.md), imported so it loads with every session:

@docs/PROJECT.md

## What this is

`assay` is evidence-first code review. Every capability is written once in `packages/core` and reached through `packages/cli`, `packages/mcp`, the HTML report and `packages/web` (the dashboard). It remembers (`memory`): standards packs, mistakes with stats, learning from fix commits.

## Commands

```bash
npm install
npm run build     # tsc -b over core, cli, mcp, web
npm test          # builds, then node --test over each package's dist tests
npm run demo      # rebuild demo/index.html from demo/src
npm run dashboard:demo   # the dashboard on a sample project (needs a Chromium-based browser for the page checks)
```

One test file: `node --test packages/core/dist/__tests__/tier.test.js` (after a build).

## Conventions

- **Node 22+, ESM, `module: NodeNext`.** Relative imports end in `.js` even in `.ts` files.
- **`core` has no runtime dependencies.** Only `node:` modules. `mcp` uses `@modelcontextprotocol/sdk` and `zod`; nothing else is added without a reason.
- **Git is read through `execFile` with argument arrays**, never a shell. Refs and paths from outside are validated before they reach git (`resolveRev`: hex 4 to 40 or a ref that `rev-parse --verify` accepts, never starting with `-`).
- **Only `packages/core/src/proof/` runs the project's code, and only after a person ran `assay allow-run`** (D14). Everything else reads git and nothing more: no tests, no build, no network. The test command comes from the project's manifest or from what the person typed, never from a request; runs happen in clean checkouts under `~/.assay/work` (made with a temporary index, so the repository is only read) and those are deleted after, links first.
- **The browser is `packages/core/src/browser/`.** Assay's own DevTools client over `--remote-debugging-pipe`; the in-page scripts are plain JavaScript in strings (`String.raw`, no backticks and no dollar-brace in them) because the core has no DOM types. Browser results are differential: only what is new at the head. Pages are loopback paths only. The probe types and loads GET addresses, and never submits a form.
- **Proof findings never come from a pattern.** A regression is `test-fail`, an untested hunk is `revert-test`, an unnoticed change is `mutation-survivor`. A revert or mutation finding is about the tests, so it never blocks; on the risky hunk it only adds a `coverage` signal (corroborates, never proves).
- **A tier is computed by `tierOf`, never set by hand.** A new check returns evidence; it never returns a tier.
- **Never print a secret.** `maskSecret` is the only way a matched secret reaches output, a log, a report or a case file.
- **State lives under `~/.assay`** (or `ASSAY_HOME`): use `assayHome()` / `assayPath(...)`, never a hard-coded path. Files that Assay keeps are written whole with `writeFileAtomic`, mode 0600.
- **Tests** use `node:test` and `node:assert/strict`, live in `packages/<pkg>/src/__tests__/*.test.ts`, build fixture git repos in `os.tmpdir()`, and set `ASSAY_HOME` to a temp folder before importing anything that reads it. They never touch a real repo's history or the real `~/.assay`.
- **The dashboard (`packages/web`)**: its page loads only from its own server and nothing runs inline; text reaches the screen only through the `html` tag in `public/js/lib.js`; the verdict, the order and each finding's state are computed in the core and sent with the case; nothing in it may set `allow-run` (D24 to D28, CONTRIBUTING.md "The dashboard").
- **Tool answers are short.** An MCP answer says the verdict, the count and the top items; the full hunk or evidence is one more call. Cap every answer (`cap()`), and end a capped answer with how to ask for the rest.
- **Cross-platform.** Windows, macOS and Linux all work (CI runs the suite on the three). Build paths with `path`; start processes with argument lists; anything that differs by system is a `process.platform` branch in one place (browser finding, killing a process tree, node_modules links, opening a file). Don't add a command that only one system has.
- **Calibration (`packages/core/src/calibration`, D44 to D47)** plants known bugs, each with a clean twin, in a throwaway repository under ~/.assay/calibration shaped like the project (never a copy of its code), scores the free checks from the two cases and each reviewer against the planted lines, and leaves a reviewer out of plans after two finished runs with no catch in its lens. File names in the throwaway are ordinary ones. A clean twin must raise no flag. A run id is only its fixed shape. Nothing is stored to be scored: the cases hold the truth. A run also plans one plain review (D51: no lens, no free findings, the whole change; `reviewer_brief` lens `plain`) as the baseline the panel is compared with: it never appears in a real review and is not cross-examined. `assay calibrate history` (D52) does the same with the project's own fix commits: `git blame` on a fix's parent finds the commit that wrote each removed line, that commit alone is a real case, the free checks are scored on it, and the truth is that line. It reads git and runs nothing, counts no false alarms (nobody knows the rest is clean), and doesn't feed routing.
- **Reviewers (`packages/core/src/reviewers`, D36 to D42)** never call a model: Assay plans (routing by facts, a budget spent most-justified first, the cost shown before it is spent), briefs (one lens and its slice, secrets masked, never another reviewer's work before cross-examination, then anonymously) and counts what comes back through the evidence gate; the agent does the reviewing. A reviewer's finding is at best corroborated and never blocks; a dispute changes no tier. The Stop hook uses Assay's own verdict, only blocks a Blocked one, and lets go after a few tries. The dashboard plans, prices and watches and never runs or spends anything. The attack pass (D50) is one more blind brief outside the lenses (`reviewer_brief` lens `attack`, from 80k tokens): its findings carry the lens the break is in, never one called attack, and it is not calibrated.
- **Memory (`packages/core/src/memory`, D29 to D35)** is SQLite through `node:sqlite` (`~/.assay/memory.db`) and plain JSON packs (`assets/packs`, `~/.assay/packs`). It must fail soft: with no `node:sqlite` or a broken file it is off with a reason and nothing else changes (`saveCase` and `resolveFinding` call it inside `try`). Only a signal (`rule:`, `diff:`, `memory:`) can be switched off or expire; a finding with any proof evidence is never dropped. A learned pattern is a signal, at most medium, never proof. Stats are read from `hits`, never counted up. The memory digest is part of each commit's cache key. The MCP `memory` tool is read only, and the dashboard can only add a suggestion that came from this project's own history, never a pattern the page sends.

## Public or private

**This is a public, open-source repository.** Nothing personal goes into it, ever: no real names, emails, usernames, machine paths, or the names of anyone's private projects, in code, docs, tests, examples, screenshots or commit messages (use `octocat`, `shop-website`, `/path/to/repo`). Calibrate on real repositories if you like, but write only neutral numbers about what you found. Before a commit, scan what is staged (`git diff --cached`) for names, emails and paths. Commits should carry a GitHub no-reply address, not a personal one.

## Before you finish

- `npm test` passes.
- `docs/PROJECT.md` §6 updated if a decision was made, §7 if a phase moved.
- The demo is the spec for screens: a change to what a person sees follows `demo/` and the rules in DESIGN.md (tokens only, flat overlays, outcomes on the button).
- **Commits are the maintainer's alone.** Don't commit unless asked.

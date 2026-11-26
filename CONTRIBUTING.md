# Contributing

Build it, test it, change a check, and the rules that keep it honest. Back to the [README](README.md). The principles and decisions are in the [charter](docs/PROJECT.md); read §2 and §3 before a big change.

Assay is under the [MIT license](LICENSE); by contributing you agree your change is licensed the same way.

## Set up

```bash
git clone https://github.com/haithamexe/assay.git
cd assay
npm install
npm run build     # tsc -b over core, cli, mcp
npm test          # builds, then node --test over each package
```

You need Node 22+ and git. A Chromium-based browser is needed for the browser tests, which skip, loudly, without one.

| Script | |
|---|---|
| `npm run build` / `npm run watch` | Compile (project references) |
| `npm test` | Build and run all tests |
| `npm run demo` | Rebuild `demo/index.html` from `demo/src` |
| `npm run samples` | Rebuild the two sample reports in `demo/` from fixture repositories |
| `npm run screenshots` | Retake the README pictures with Assay's own browser client (run `samples` first), including the dashboard's |
| `npm run dashboard:demo` | Start the dashboard on a sample project (`-- --port 4747` for a fixed port) |

One test file: `node --test packages/core/dist/__tests__/tier.test.js` (after a build).

## The layout

See [Architecture](docs/ARCHITECTURE.md). In short: `packages/core` is the engine (no runtime dependencies), `packages/cli` and `packages/mcp` are thin front ends over it.

## Conventions

- **Node 22+, ESM, `module: NodeNext`.** Relative imports end in `.js`, even in `.ts` files.
- **`core` has no runtime dependencies.** Only `node:` modules. `mcp` uses `@modelcontextprotocol/sdk` and `zod`. Nothing else is added without a reason.
- **git is read through `execFile` with argument arrays**, never a shell. A ref or a path from outside is validated before it reaches git (`resolveRev`).
- **Only `packages/core/src/proof/` and `browser/` run the project's code**, and only after `assay allow-run`. Everything else reads git and nothing more: no tests, no build, no network.
- **A tier is computed by `tierOf`, never set by hand.** A check returns evidence; it never returns a tier or an id.
- **Never print a secret.** `maskSecret` and `redactSecrets` are the only ways a matched secret reaches output, a log, a report or a case file.
- **State lives under `assayHome()`**; never hard-code a path. Files Assay keeps are written whole with `writeFileAtomic`.
- **Tool answers are short.** An MCP answer says the verdict, the count and the top items; the full hunk or evidence is one more call.
- **Reviewers never call a model, never see each other early, and never leak a secret.** Assay plans, briefs and counts; the agent reviews. A brief holds one lens and its slice, with secrets masked. A reviewer's finding is at best corroborated. The Stop hook only blocks a verdict Assay computed itself and lets go after a few tries.
- **Memory fails soft and never mutes proof.** Everything in `packages/core/src/memory` must work (as "nothing known") when `node:sqlite` is missing or the file is broken; `saveCase` and `resolveFinding` call it inside `try`. Only a signal (`rule:`, `diff:`, `memory:`) can be switched off or expire; a finding with any proof evidence is never dropped. Stats are read from `hits`, never counted up. The MCP `memory` tool stays read-only.
- **It must work on Windows, macOS and Linux.** Build paths with `path`, never by joining with a slash or backslash (git paths are the exception: they always use `/`). Start processes with `execFile` or `spawn` and an argument list; anything that differs by system (finding a browser, killing a process tree, links, `xdg-open` or `open` or `explorer`) is a `process.platform` branch in one place with a comment, and the other branches are read, not just assumed. The CI workflow (`.github/workflows/ci.yml`) runs the suite on all three, on every push to main and every pull request.
- **No personal data in the repository.** It is public. Use `octocat`, `shop-website`, `/path/to/repo`. No real names, emails, usernames, machine paths or other people's private project names in code, docs, tests, examples, screenshots or commit messages. `npm run check:public` looks for emails and home-folder paths in what you are about to commit (and `-- --history` in the author addresses of past commits; `ASSAY_DENY="a name,another"` adds words you never want to see, without writing them into the repository). Commit with a GitHub no-reply address.

## Adding a check

A check is a function from a commit to a list of findings (`packages/core/src/checks/`).

1. **Write it** in `checks/<name>.ts`. It receives a `CommitCtx` (the commit's parsed diff and `read(file, 'commit' | 'parent')`) and returns `RawFinding[]`: a `check` name, a stable `key`, a title, a lens, a severity, the file and line, the line's text, **evidence** (a `kind`, a `source`, a sentence), `observed` facts and `inferred` guesses. It never sets a tier.
   - A pattern is a `rule` signal. Don't give a pattern a proof kind. If something is wrong by itself (a committed key), it is a `fact`.
   - `observed` is what the diff shows; `inferred` is what it might mean. Keep them apart: an inferred line never blocks.
2. **Register it** in `CHECKS` in `analysis.ts`.
3. **Bump `ANALYSIS_VERSION`** in `analysis.ts`. Cached analyses of the old kind are then ignored.
4. **Test it** against a fixture repository (see `packages/core/src/__tests__/fixtures.ts`).
5. **Document it** in [docs/CHECKS.md](docs/CHECKS.md).

To add a pattern rule, add an entry to `RULES` in `checks/risky.ts` (an id, a title, a lens, a severity, the languages, the regex, what it says and why it may matter, a CWE if there is one) and do steps 3 to 5.

## Adding a bug to calibration

A planted bug is an entry in `TEMPLATES` (`packages/core/src/calibration/bugs.ts`): its lens and language family, an ordinary file name (never one that says "bug"), the buggy file (`bad`) and the same code written correctly (`good`), a `mark` on the buggy line (the truth is that line), and a `base` when the bug is an edit such as a removed guard. The clean twin must raise no flag from any check: `planting.test.ts` asserts the free checks have no false alarm on them, which also pins Assay's own false positives. Update the counts in that test and in [CALIBRATION.md](docs/CALIBRATION.md).

## Adding or changing a reviewer

A reviewer is an entry in `REVIEWERS` (`packages/core/src/reviewers/lenses.ts`: its lens, name, prompt file and base priority), a prompt in `packages/core/assets/lenses/<file>.md`, a routing rule in `plan.ts` (`route()`: when it is relevant, and why or why not, in a sentence a person can read), and a slice rule in `slice.ts` (`wanted()`: which files it is shown). Keep a prompt short and about **one** lens, say what not to report, and never ask for style opinions. Anything printed from the diff must go through `redactSecrets`. `reviewers.test.ts` pins routing, budget and blindness; add a case for the new lens.

## Adding a pack or a standard

A pack is a JSON file in `packages/core/assets/packs` ([the format](docs/MEMORY.md#writing-or-importing-a-pack)). Only put in what you can vouch for: an edition you checked against its source (and say which in `edition` and `source`), rules whose `sources` are evidence Assay really produces, and questions that are yours to ask. `memory.test.ts` loads every bundled pack and fails on a rule with neither sources nor a question, so a typo in a file is caught. Add the pack's id to the list in that test, and a row to [MEMORY.md](docs/MEMORY.md). If a new check produces a new source, add it to the pack that should own it, or its findings are counted against no entry.

## The calibration rule

> A new rule ships with a test built from a real false positive, when one exists.

The first run of Assay on five real repositories found false alarms: a Prisma tagged template read as string-built SQL, `new-password` read as a credential, a deleted file read as a removed guard, demo HTML flooding the list, a shell `$(…)` read as a secret, the first commit's dependencies read as new. Each is fixed and pinned by a test in `calibration.test.ts`. Before you add or widen a rule, run it on a few real repositories (`assay case --last 25`), look at what it reports, and pin every false alarm you fix.

## Tests

- `node:test` and `node:assert/strict`, in `packages/<pkg>/src/__tests__/*.test.ts`.
- Tests build fixture git repositories in the OS temp folder and set `ASSAY_HOME` to a temp folder **before** importing anything that reads it. They never touch a real repository or a real `~/.assay`.
- Prefer a real thing to a stand-in: the proof tests run a real `node --test` suite, the browser tests open real pages in a real browser, the MCP test uses a real MCP client over stdio.
- Don't put backslash-heavy patches through a shell heredoc: they get mangled. Use your editor, or write the script to a file first.

## The screens

The demo in `demo/` is the spec for any screen, and [DESIGN.md](DESIGN.md) is the rule book: tokens only, flat overlays with a hairline and no shadow, outcomes on the button, friction in proportion to risk. A change to what a person sees follows it.

## The dashboard

`packages/web` is a server (`src`, TypeScript, `node:http`, no dependency but the core) and a page (`public`, plain JavaScript modules, no build step, no library). [How it is arranged →](docs/ARCHITECTURE.md#the-dashboard)

- **The page may only load from its own server and nothing may run inline.** No inline `<script>`, `style=` or `on…=` anywhere; the content policy blocks them and `server.test.ts` checks the shell for them.
- **Text goes on screen through the `html` tag** (`public/js/lib.js`), which escapes. To show html you made yourself, nest an `html` tag; never concatenate untrusted text into a string. Sizes and positions go through `data-css`.
- **Compute nothing twice.** The verdict, the order and each finding's state come from the core; add what the page needs to `caseView` in `api.ts` rather than working it out again in the browser.
- **A new request** is a line in `ROUTES` (`api.ts`). Anything that runs the project's code or takes a while is a job (`Jobs.start`), checks `allow-run` first, and answers `403` with the command if it is off. Nothing may set `allow-run`.
- **A new file under `public/js`** must be named with lowercase letters, digits and dashes, and ends in `.js`: that is the only shape the server serves.
- **The Reviewers screen** (`public/js/reviewers.js`) plans, prices and watches: it must never start, spend or run anything, and it never sets `allow-run`. The budget is a number, and the only setting the page may change there.
- **The Memory screen** (`public/js/memory.js`) changes things only through its own routes (`/api/memory/…`), each a plain refusal with a sentence when it can't. Don't add a route that takes a pattern from the page: the only way a pattern gets in is a suggestion from this project's history.
- **Try it** with `npm run dashboard:demo`. The tests (`packages/web/src/__tests__`) cover the security rules over real HTTP, a real test run started, stopped and replayed from the page, and the real page in a real browser (skipped, loudly, without one).

## Before you finish

- `npm test` passes, and `npm run check:public` finds nothing.
- The docs match: [CHECKS.md](docs/CHECKS.md) for a check, [USAGE.md](docs/USAGE.md) for a command or flag, [MCP.md](docs/MCP.md) for a tool, [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- [docs/PROJECT.md](docs/PROJECT.md) §6 if you made a decision, §7 if a phase moved.
- If a screenshot changed, `npm run samples && npm run screenshots`.

## Reporting a problem

A bug that crosses a safety boundary (a secret that leaked, a command that ran that shouldn't have): see [SECURITY.md](SECURITY.md) and don't open a public issue. Anything else: an issue with the command, what you expected and what happened.

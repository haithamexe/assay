# Usage

Every command and flag. Back to the [README](../README.md). New here? Start with [Getting started](GETTING-STARTED.md).

```
assay <command> [range] [options]
```

All commands act on the repository in the current folder, or on `--repo <dir>`.

## Ranges

A range says which commits to review.

| You write | Meaning |
|---|---|
| nothing | This branch since it left the default branch (`origin/HEAD`, `main`, `master`, `develop`, `trunk`: the first one found). On the default branch itself: the last 5 commits. |
| `A..B` | The commits in `B` that are not in `A` |
| `A...B` | `B` since `A` and `B` last met |
| one revision (`3c9f118`, `HEAD~2`, a branch) | Just that commit |
| `--last N` | The last `N` commits (instead of a range) |

Merge commits are left out, because their diff is a combined one (the report says how many). A range may hold at most 200 commits (`--max` raises it, up to 1000). Anything that looks like an option, or isn't a commit or branch name, is refused before it reaches git.

## Reviewing

| Command | What it does |
|---|---|
| `assay case [range]` | Runs the free checks over the range and prints the verdict and the ranked findings. Reads git only, uses no tokens. Saves the case. |
| `assay timeline` | One row per recent commit: files, lines, findings by tier, risk. Instant for commits seen before. |
| `assay show <finding>` | One finding in full: the changed lines (the marked line is the one it is about), what was observed against what is only inferred, why it ranks where it does, each piece of evidence and how to replay it. |
| `assay brief [range]` | The short list an agent should work from: must fix, should fix, ask the person. Hints are left out. About 200 tokens. |
| `assay report [range]` | Writes a one-file HTML case file (fonts embedded, nothing to host). |
| `assay replay <evidence>` | Runs the check that produced a piece of evidence again from scratch and says whether it reproduces. Exit code 1 if it does not. |
| `assay resolve <finding> dismissed\|intended\|reopen` | Your call on a finding. `dismissed` is a false alarm, `intended` means it is meant. Either stops it counting against the verdict. A proven finding can only be dismissed here, by you; an agent can't. |
| `assay cases` | The cases kept so far. |

Options for these:

| Option | |
|---|---|
| `--repo <dir>` | The repository (default: the current folder) |
| `--last <n>`, `--max <n>` | See ranges |
| `--json` | Machine-readable output |
| `--all` | List every finding (default: the top 10) |
| `--fresh` | Ignore the saved analysis of each commit and run the checks again |
| `--fail-on blocked\|mergeable` | Exit with code 2 if the verdict is blocked, or is anything but clear |
| `--case <id>` | For `show`, `replay`, `resolve`: use this case instead of the newest one that has the finding |
| `--ref <rev>`, `--limit <n>` | For `timeline`: where to start and how many commits (default 20) |
| `--out <file>`, `--open` | For `report`: where to write it, and open it when done (default `~/.assay/reports/<case>.html`) |

A finding can be written with or without its `f-` prefix (`f-1a2b3c4d` or `1a2b3c4d`). Evidence ids add a number: `f-1a2b3c4d.2`.

## Proof

| Command | What it does |
|---|---|
| `assay allow-run` | Your opt-in for this repository. Prints what Assay found (test command, dev server, pages, browser) and what it will do. Settings are kept in `~/.assay/repos.json`. |
| `assay prove [range]` | Runs the project's own tests at the base and at the head. A regression is proven, and traced to the first commit where the tests fail. If the head is green, it also reverts risky hunks and mutates the changed lines. |
| `assay look [range]` | Opens the pages in a real browser at the base and at the head and reports what is new at the head. |

`allow-run` options:

| Option | |
|---|---|
| `--command "<cmd>"` | The test command to run, typed by you and run exactly as typed through the shell. Without it, Assay finds one: `npm`/`pnpm`/`yarn`/`bun test` when `package.json` has a `test` script, `python -m pytest` when it looks like a pytest project, `go test ./...`, `cargo test`. |
| `--timeout <seconds>` | How long one run may take (default 300) |
| `--serve "<cmd>"` | The command that starts the dev server for `look`. `{port}` is replaced and `PORT` is set. Without it: `dev` or `start` from `package.json`, else the HTML files are served as they are. |
| `--pages "/,/cart"` | Paths to open (default: the HTML files the range changed, or `/` for a dev server) |
| `--browser <path>` | A Chromium-based browser, if Assay can't find one (also `ASSAY_BROWSER`) |
| `--off` | Turn it off again |

Running `allow-run` again changes only what you pass; the rest stays.

`prove` options:

| Option | |
|---|---|
| `--mutants <n>` | Deliberate changes to try, one test run each (default 8) |
| `--reverts <n>` | Hunks to put back, one test run each (default 3) |
| `--no-mutation`, `--no-revert` | Skip them |
| `--no-bisect` | Don't search for the first commit where the tests fail (a regression is still proven; the search costs about log2 of the commits in test runs) |
| `--budget <seconds>` | Stop starting new runs after this long (default 600). What was done is kept; run it again to continue. |
| `--fresh` | Run again even where a result is cached |
| `--fail-on …` | As above |

`look` options:

| Option | |
|---|---|
| `--pages "/,/cart"` | Open these paths for this run |
| `--no-probe` | Don't type the probe marker into fields and query strings |
| `--no-screens` | Don't keep before/after pictures |
| `--budget <seconds>` | Stop opening new pages after this long (default 300) |
| `--fail-on …` | As above |

## The dashboard

| Command | |
|---|---|
| `assay dashboard` | Starts the [dashboard](DASHBOARD.md) for this repository and prints its address. It answers on `127.0.0.1` only, behind a key that only this run knows. `Ctrl+C` stops it |
| `--port <n>` | A fixed port. Without one, a free port is picked |
| `--open` | Open the address in your browser |
| `--repo <dir>` | A repository other than the current folder |

## Reviewers

Who is worth their tokens for this case, and what each is handed. The [reviewers guide](REVIEWERS.md) explains the panel. Assay never calls a model: the reviewers are your own agent's sub-agents.

| Command | |
|---|---|
| `assay reviewers [range]` | The plan: which reviewers would run, why, and what each costs. Nothing is kept or spent. `--budget 40k\|free\|<tokens>`, `--request "what was asked"` |
| `assay reviewers plan [range]` | The same, kept with the case so an agent can run it |
| `assay reviewers brief <lens> [range]` | What one reviewer is handed, to paste into any agent. `--round 2` for cross-examination, `--page <n>` for a long change. Lenses: triage, security, correctness, ui, tests, supply-chain, performance |
| `assay reviewers status [range]` | Who has reported and what is next |
| `assay reviewers budget [40k\|free]` | Show, or set, the budget for this project from now on |
| `--include <lens,…>` | Bring back a reviewer that [calibration](CALIBRATION.md) left out of the plan |
| `assay hook install` | Prints what to add to your agent's settings for the Stop hook. Assay doesn't edit them |
| `assay hook stop` | The Stop hook itself: reads the agent's JSON on standard input, answers with JSON. `--always`, `--require-panel`, `--max-blocks <n>` |

## Calibration

Plant known bugs in a throwaway repository and score the free checks and each reviewer. The [calibration guide](CALIBRATION.md) explains it. Assay never calls a model: your agent runs the reviewers.

| Command | |
|---|---|
| `assay calibrate` | What would be planted in this project, or the newest run's scoreboard |
| `assay calibrate start` | Makes the throwaway repository, scores the free checks at once, and prints what to give your agent. `--budget <tokens>` (200k) |
| `assay calibrate score [run]` | The scoreboard of a run; it moves as your agent's reviewers report. `--json` |
| `assay calibrate clean [--all]` | Removes old throwaway repositories (what each showed is kept) |

## Memory

What Assay remembers about this project. The [memory guide](MEMORY.md) explains each part.

| Command | |
|---|---|
| `assay memory` | What is in memory, and which entries are crying wolf |
| `assay memory list` | Every entry on, with its status and hits. `--kind standard\|learned\|questions`, `--all` includes the ones that are off |
| `assay memory show <entry>` | One entry: what finds it, its stats, the last twelve weeks, an example |
| `assay memory packs` | The standards packs and whether each is on |
| `assay memory pack <id> on\|off` | Switch a whole pack for this repository |
| `assay memory on <entry>` / `off <entry>` | Switch one entry. An entry that cries wolf switches itself off; this turns it back on |
| `assay memory mine` | Reads the git history for what fix commits keep removing, and suggests patterns. Adds nothing. `--limit <n>` (600, up to 2000) |
| `assay memory add <suggestion>` | Adds one of those suggestions. `--name "…"` renames it |
| `assay memory add --name "…" --pattern "…"` | A pattern of your own. `--langs "TypeScript,JavaScript"`, `--good "…"`, `--bad "…"`, `--ref "…"` |
| `assay memory remove <L-n>` | Forgets a learned entry and its stats |
| `assay memory questions` | What a reviewer should ask that no check can decide. `--langs "Python,CSS"` |
| `assay memory import <file>` | Checks a pack file and copies it into `~/.assay/packs` |
| `--json` | On `list`, `show`, `packs`, `mine` and `questions`: machine readable |

## Other

| Command | |
|---|---|
| `assay doctor` | Checks git, Node, the state folder, whether memory is available, and which optional tools are found (the dashboard shows the same list in Settings) |
| `assay mcp` | Prints the command that adds the MCP server to Claude Code |
| `assay help` | The short version of this page |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | An error (a bad range, not a git repository, proof not allowed, no browser, …), or `replay` did not reproduce |
| 2 | `--fail-on` tripped |

Errors are one line: `error: …`. Set `ASSAY_DEBUG=1` for the stack.

## Environment

| Variable | |
|---|---|
| `ASSAY_HOME` | Where Assay keeps its state (default `~/.assay`) |
| `ASSAY_BROWSER` | Path to a Chromium-based browser, if Assay doesn't find yours (it looks for Chrome, Edge, Brave and Chromium where each system puts them) |
| `NO_COLOR` | No colour in the output |
| `ASSAY_DEBUG` | Print stack traces |

Assay sets `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0` and `ASSAY_RUN=1` for the commands and servers it starts, and removes `NODE_TEST_CONTEXT` (a `node --test` run started from inside another would otherwise print the wrong format).

## Examples

```bash
assay case --fail-on blocked                  # a pre-push hook: a second or two
assay case main..HEAD --json | jq .verdict    # for scripts
assay prove --mutants 4 --reverts 1           # a quicker proof on a big suite
assay look --pages "/,/checkout"              # two pages, this run only
assay report main..HEAD --out review.html     # a page to attach to a pull request
assay show f-1a2b3c4d                         # why it ranks where it does
assay replay f-1a2b3c4d.1                     # run that check again
assay resolve f-1a2b3c4d dismissed            # your call, recorded
```

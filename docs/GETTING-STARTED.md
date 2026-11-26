# Getting started

From nothing to a reviewed branch in a few minutes. Back to the [README](../README.md).

## What you need

| | |
|---|---|
| **Windows, macOS or Linux** | Assay is tested on all three (see [Platforms](TROUBLESHOOTING.md#platforms)) |
| **Node.js 22 or newer** | `node -v` (memory needs 22.13) |
| **git** | Assay reads your repository through git |
| A Chromium-based browser | Only for `assay look`. Chrome, Edge, Brave or Chromium, already installed. Edge is on every Windows 10 and 11; Chrome on most Macs and Linux desktops. |
| Your project's test command | Only for `assay prove`. `npm test`, `pytest`, `go test` and `cargo test` are found by themselves; anything else you tell it. |

No account, no API key, no network.

## Install

```bash
git clone https://github.com/haithamexe/assay.git
cd assay
npm install
npm run build
```

`npm test` builds and runs all 61 tests. It also needs a browser for the browser tests, and skips those, loudly, if there is none.

### Make it a command

Assay is not published to npm. The command is a file, `packages/cli/dist/index.js`. The easiest way to type `assay` is a function in your shell profile.

PowerShell (`notepad $PROFILE`):

```powershell
function assay { node C:\path\to\assay\packages\cli\dist\index.js @args }
```

bash or zsh (`~/.bashrc`):

```bash
assay() { node /path/to/assay/packages/cli/dist/index.js "$@"; }
```

The rest of the docs write `assay` for that command. Check it with `assay doctor`.

## 1. Review a branch (free)

Go to any git repository, on a branch you have been working on:

```bash
assay case
```

With no range it reviews this branch since it left `main` (or `master`, `develop`, `trunk`), or the last 5 commits if you are on the default branch. You get a verdict, the findings ranked by importance, and a case id. For a specific range:

```bash
assay case main..HEAD          # HEAD since main
assay case 3c9f118             # just that commit
assay case --last 10           # the last ten commits
```

This only reads git. It runs nothing from your project and takes a second or two.

Look at one finding in detail (the changed lines, what was observed against what is only inferred, the evidence):

```bash
assay show f-1a2b3c4d
```

Get the short list an agent should work from:

```bash
assay brief
```

Open a page you can read, search and share:

```bash
assay report --open
```

## 2. Turn on proof (once per repository)

Everything above reads. The next two commands *run* things from your project, so Assay asks you to opt in, per repository:

```bash
assay allow-run
```

It prints the test command it found, the dev server it will use for the browser, the pages, and the browser. If it guessed wrong, say so:

```bash
assay allow-run --command "npm run test:unit" --timeout 600
assay allow-run --serve "npm run dev" --pages "/,/cart"
assay allow-run --browser "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Turn it off again any time with `assay allow-run --off`. [What this permits, exactly →](../SECURITY.md)

### Run the tests as proof

```bash
assay prove
```

Assay exports clean copies of the base and the head of the range, runs your test command in each, and compares:

- **A test that passed at the base and fails at the head** is a proven regression. It blocks the merge. Assay then runs the tests at the commits in between, halving the range, to name the **first commit where they fail** (`--no-bisect` skips that).
- If the head is green, it **puts a risky change back** and runs the tests again. If nothing fails, that change is untested. It also **makes small deliberate changes** to the new lines (flip a comparison, swap `&&` for `||`, change a number) and reports the ones no test notices.

Results are cached by commit, command and change, so running it again is instant, and a time budget (`--budget 600`) stops new runs and keeps what was done: run it again and it carries on. A long suite costs its length twice (base and head), plus once per revert and per deliberate change, and about log2 of the commits (five commits take two runs) when a regression is traced to the commit that broke it. Limit that with `--mutants 4 --reverts 1` or skip them with `--no-mutation --no-revert` (and `--no-bisect` for the search for the commit).

### Open the pages in a browser

```bash
assay look
```

For a plain HTML project, Assay serves the files itself (the HTML files your range changed, or `index.html`). For anything with a dev server, it starts it from `package.json` (`dev` or `start`) or from `--serve`. Then it opens each page at the base and at the head, in 8 combinations, and reports only what is new at the head.

It also types a harmless marker into the page's fields and query string to see whether text can become markup. It never submits a form. Skip that with `--no-probe`, and skip the pictures with `--no-screens`.

`assay report --open` now has a before/after slider for the pages that look different.

## 3. Give it to your agent

```bash
claude mcp add assay -- node /path/to/assay/packages/mcp/dist/index.js
```

Add a line to your project's `CLAUDE.md` (or the agent's equivalent) so it uses Assay without being asked:

```markdown
Before you say a change is done, run the assay case_open tool. If it says Blocked, fix the
MUST FIX items (brief lists them), then run it again. For anything that renders in a browser,
also run look; for logic, prove. Don't say done while it says Blocked.
```

`prove` and `look` only work in repositories where you ran `assay allow-run`. The agent can't do that for you. [The MCP guide →](MCP.md)

## 4. Use it in a hook or CI

`case`, `prove` and `look` exit with code 2 when you ask them to fail on a verdict:

```bash
assay case --fail-on blocked
assay prove --fail-on blocked
```

`--fail-on mergeable` also fails on "can merge, with fixes suggested". A pre-push hook that runs `assay case --fail-on blocked` costs a second or two. Remember that `prove` and `look` need `allow-run` on the machine they run on.

## 5. Or use the dashboard

Everything above is also a set of screens in your browser:

```bash
assay dashboard --open
```

Pick commits on the timeline, open the case file, and press **Run the tests** or **Look at the pages** (they stay locked until you ran `assay allow-run` in a terminal; the dashboard shows you the command). Findings can be reproduced, dismissed (with Undo) and handed to your agent as a brief, all from the page. To look around first, `npm run dashboard:demo` opens a sample project. [The dashboard guide →](DASHBOARD.md)

## 6. Let it remember

Assay counts what it finds against a set of standards (OWASP Top 10, WCAG 2.2 and a few others ship as plain files) and can learn from your own fix commits:

```bash
assay memory                  # what is in memory, and what is crying wolf
assay memory mine             # what do your fix commits keep taking away?
assay memory add <suggestion> # only if one is worth it; nothing is added until you say so
```

Dismiss a false alarm and the check that raised it learns: one that keeps crying wolf switches itself off. It needs Node 22.13 or newer; without it, nothing else changes. [The memory guide →](MEMORY.md)

## 7. Reviewers and the Stop hook

For judgment the free checks can't make, a panel of reviewers (your own agent's sub-agents) can look at a change, each through one lens. Assay shows the cost first and spends nothing:

```bash
assay reviewers --budget 40k --request "what you asked for"
assay reviewers plan            # keep the plan, then ask your agent to run it (the dashboard gives you the words)
assay hook install              # optional: stop your agent saying "done" while the verdict is Blocked
```

[The reviewers guide →](REVIEWERS.md)

## 8. Find out which reviewers earn their tokens

Plant known bugs in a throwaway repository shaped like your project. The free checks are scored at once, for nothing; then your agent runs the reviewers on the same two cases and each one is scored:

```bash
assay calibrate start    # plants, scores the free checks, prints what to give your agent
assay calibrate score    # the scoreboard, as the reviewers report
```

[The calibration guide →](CALIBRATION.md)

## Where things are kept

Everything Assay keeps is under `~/.assay` (or the folder in `ASSAY_HOME`): cases, a cache per commit, test runs, screenshots, reports, what it remembers (`memory.db`, your packs), and your `allow-run` settings. Nothing is written into your repository. [The layout →](ARCHITECTURE.md#state-on-disk)

## Next

- [Usage](USAGE.md) for every flag.
- [How it works](HOW-IT-WORKS.md) for why a finding is proven, corroborated or a hint.
- [Troubleshooting](TROUBLESHOOTING.md) if something says it can't.

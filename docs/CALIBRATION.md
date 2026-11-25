# Calibration

Does each reviewer earn its tokens? Plant known bugs, and find out. Back to the [README](../README.md).

A reviewer's opinion of itself is worth nothing, and a model's confidence is worth little more. Calibration replaces both with a measurement: Assay plants bugs it knows about in a throwaway repository, **scores the free checks on the spot**, has your own agent run the reviewers on it, and scores each reviewer on what it caught, what it missed, and what it flagged in code that was fine. A reviewer that doesn't earn its tokens is left out of future plans.

![The Scoreboard: 18 planted bugs, the free checks scored at no cost, and six reviewers scored on catches, misses, false alarms and tokens per catch](images/dashboard-scoreboard.png)

**Assay never calls a model**, here as everywhere. The free checks are scored without one. The reviewers are run by your agent (the same panel as [Reviewers](REVIEWERS.md)), and Assay does the planting and the scoring.

## How a run works

```bash
assay calibrate               # what would be planted in this project
assay calibrate start         # plant it, score the free checks now, print what to give your agent
assay calibrate score         # the scoreboard again (it moves as the reviewers report)
assay calibrate clean --all   # remove the throwaway repositories (what each showed is kept)
```

1. **A throwaway repository, shaped like your project.** Assay looks at which languages your project uses and which folders hold them, and makes a small repository under `~/.assay/calibration` with a base commit and two branches from it. It holds only the files being planted: **your own code is never copied, and nothing in your project is touched.**
2. **The bugs, and their clean twins.** On one branch, the bugs. On the other, the same code written correctly. A bug is a line Assay knows the position of, so there is no judging whether a reviewer "found" it: it either flagged that line (within three lines of it) or didn't.
3. **The free checks are scored at once.** Each bug is **caught with proof**, **flagged without proof**, or **missed**, and every flag on the clean branch is one of Assay's own **false alarms**.
4. **Your agent runs the reviewers on both cases**, with the words the screen (or `assay calibrate start`) gives you. The planted case and its clean twin look like any two cases, with ordinary file names and the same commit message, so a reviewer can't tell which holds the bugs. The prompt tells the agent not to read Assay's calibration folder, and that is an honor system: it only means something if the reviewers don't cheat.
5. **The scoreboard fills in as they report**, and is worked out from the two cases each time, so there is nothing to refresh by hand.

## What it plants

17 to 18 kinds of bug, whichever fit the project (a kind that doesn't fit is listed as left out, with the reason):

| Lens | Bugs |
|---|---|
| Security | comment text inserted as HTML · an API key written into the code · a query built from a user id (JS and Python) · a file name passed to a shell command |
| Correctness | a loop one step past the end (JS and Python) · arguments swapped in a call · a check on the user removed (JS and Python) |
| Tests | an assertion changed to always pass (JS and Python) |
| Performance | a query for every id in a loop |
| Supply chain | a dependency named like a popular one |
| UI | `right` where the layout must mirror · a fixed width on a button · faint hint text · an image with no alt text |

Some of these the free checks can catch (a committed key is proven; an HTML sink is flagged); others only a reviewer can (a loop that runs one step too far has no pattern), or only a browser (a fixed width). **That is the point of the table:** it shows what the reviewers add that the free checks can't, and what they cost for it. The templates are in `packages/core/src/calibration/bugs.ts`.

## Reading the scoreboard

| Column | Meaning |
|---|---|
| **Caught** | planted bugs the reviewer flagged, where the finding at that line is **proven** by something (the free checks, usually): "with proof" |
| **Flagged only** | flagged, with nothing but a reading behind it |
| **Missed** | a bug **in its own lens** that it didn't flag |
| **False alarms** | flags on the clean twin |
| **Tokens per catch** | what it cost, over its catches. Estimated (about four characters to a token, marked `~`) unless the agent reported its use |
| **What it suggests** | *Keep*, *Keep and watch it*, *caught none of N*, *N false alarms for M catches*, or *left out of plans* |

The matrix below it shows each bug against each reviewer: **✓** caught with proof, **~** flagged without proof, **✗** missed, **·** not its lens, **?** not run. A reviewer that flags a bug outside its own lens gets credit for it.

The headline is the useful number: *"1 of 18 planted bugs were caught by the free checks alone, with proof, at 0 tokens. With the reviewers: 14 of 18 flagged by someone."*

## Routing a reviewer out

A reviewer is **left out of plans** when, in each of its **last two finished runs**, bugs were planted in its lens and it caught **none** of them. One run is a hint, shown in "what it suggests"; two in a row is a record. A run is finished when every planned reviewer has reported on both cases, and counts once.

A reviewer that is left out says so in the plan (`Left out: it caught none of the 6 bugs planted in its lens in the last 2 calibration runs. Bring it back with: assay reviewers plan --include ui`), saves its tokens, and can be brought back for a plan with `--include` (the CLI) or `include` (the MCP planning tool). Calibrate again and it earns its place back. A free-only budget says "off", not "left out".

## What it can't tell you

- **A model varies from run to run.** A reviewer that catches 3 of 5 today may catch 4 tomorrow. That is why one run only advises and two in a row decide, and why you can run it again.
- **The bugs are Assay's, not your project's.** They are realistic and shaped like your languages, but a reviewer's record on them is a proxy for its record on your real code. Replaying your own fix commits as a benchmark (finding the commit that introduced each fixed bug) is a better measure, and is not built.
- **No plain-review baseline.** The demo's last row, one undifferentiated AI review with no evidence gate, isn't built: it would need a second run with a different agent prompt.
- **Planted bugs are fixed in number.** A reviewer that is good at a kind of bug that isn't planted (a race, a rounding error) gets no credit for it.

## Safety

Calibration reads git and writes only under `~/.assay/calibration`. It runs none of your code (the free checks only read the diff), makes no network call and spends no tokens. The throwaway repositories are removed by `assay calibrate clean` and, past the newest five, when a new run starts. What a finished run showed (a few numbers per reviewer) is kept in `~/.assay/calibration/<project>.json`. The throwaway cases belong to no project, so the dashboard won't open them as yours.

# How it works

The idea, the vocabulary, the pipeline, and what it costs. Back to the [README](../README.md). The decisions behind it are in the [charter](PROJECT.md).

## The idea: evidence over opinion

A review that says "this looks risky" is an opinion, and opinions from a language model are wrong often enough that nobody can tell which to trust. Assay never asks you to trust a statement. Every finding carries **evidence**, and the strength of the finding is computed from the kind of evidence it has.

Three rules follow from that:

1. **A tier is computed, never assigned.** One function decides it (`tierOf`), from the evidence, and nothing else can.
2. **Only proven findings can block a merge.** A hint, however confident its wording, can't.
3. **Free first.** Everything that can be decided by code is decided by code, before any model is asked anything.

## Evidence and tiers

Evidence has a **kind** and a **source** (who produced it, e.g. `rule:html-injection`, `proof:tests`, `browser:overlap`).

**Proof kinds** show something real:

| Kind | What it shows | Produced by |
|---|---|---|
| `fact` | A literal that is wrong by itself: a committed secret key | free checks |
| `test-fail` | A test that passed at the base fails at the head | `prove` |
| `revert-test` | Putting this change back changes no test result | `prove` |
| `mutation-survivor` | A deliberate change to this line went unnoticed by every test | `prove` |
| `measurement` | A real browser measured it: overlap, cut-off text, contrast, an uncaught error | `look` |
| `probe` | Text typed into the page, or put in its address, became markup | `look` |
| `behaviour-diff` | Reserved for function-level before/after (not built) | |

**Signal kinds** point at something without showing it:

| Kind | What it is |
|---|---|
| `rule` | A pattern that may be harmless (`innerHTML =`, `eval(`) |
| `diff` | A fact about the diff that isn't a defect: no test changed in this commit, a dependency is new |
| `history` | The file changes often |
| `coverage` | Nothing tested the changed lines (from a revert or a mutation) |
| `registry`, `scope` | Reserved |
| `claim` | A reviewer's reading, from outside Assay (see below) |

**Tiers**, from the evidence:

| Tier | When |
|---|---|
| **Proven** | Any proof evidence |
| **Corroborated** | No proof, but two or more signals from *different* sources |
| **Hint** | Anything else: one signal, or several from one source |

Two examples. `dangerouslySetInnerHTML` is a *rule* signal: on its own a hint. If the same commit also changed no test, that is a second, independent signal (`diff:no-test`): corroborated. If a probe then turns typed text into an element on the page, that is proof: proven.

And the reverse: "no test notices if this is reverted" is proof that the *tests* are weak, so it becomes its own finding (proven, never high, never blocks) and adds only a `coverage` *signal* to the risky hunk. Untested is not the same as broken.

## Severity and the verdict

Each finding also has a severity: high, medium or low. The verdict is:

| Verdict | When |
|---|---|
| **Blocked** | At least one open finding that is proven **and** high |
| **Can merge, with fixes suggested** | No blocker, but open proven (medium or low) or corroborated findings remain |
| **Clear to merge** | Nothing open that counts |

A finding is *open* unless you resolved it, or a later commit in the same range already fixed it. Assay checks that: each finding remembers the line it is about, and at the head of the range it looks for that line again (a removed guard is "open" only while it is still removed).

## The pipeline

```
range ──▶ per-commit analysis ──▶ merge ──▶ still there at the head? ──▶ rank ──▶ verdict
          (cached by commit hash)
```

1. **Per-commit analysis.** For each commit (merges excluded) Assay diffs it against its first parent and runs the [free checks](CHECKS.md). The result is cached under the commit's hash, so a range you pick again, or a bigger one that includes it, costs nothing for the commits already seen. The cache is versioned: when a check changes what it reports, old entries are ignored.
2. **Corroboration.** Within a commit, a risky finding in a source file gets the commit's own facts as extra signals (no test changed; the file changed 10+ times in 90 days). That is how a hint becomes corroborated.
3. **Merge and presence.** Findings from all commits are merged; each is checked against the net diff at the head.
4. **Rank.** Risk is 1–99: a base by severity (high 55, medium 38, low 18), plus 30 if proven or 14 if corroborated, plus 8 for a sensitive path (auth, payment, secrets, migrations, deploy, …), plus 3 each for "no test changed" and "the file changes often". Findings are listed by risk, and each says why it ranks where it does.
5. **Verdict.** As above.

Cases are kept (`assay cases`), and reopening one keeps your resolutions and everything Assay ran for it, without running anything again.

## Proof, in detail

`assay prove` needs `allow-run`. It exports a clean copy of a commit with a temporary git index (`read-tree`, then `checkout-index`), so nothing in your repository changes. `node_modules` is rebuilt in the copy as real folders of links to your installed packages, except workspace packages, which point at the *copy's* own code, so the code under test is the commit's code and not whatever is in your working folder.

- **The tests.** Your test command runs in the base copy and in the head copy. A regression is proven when the base passes and the head fails (or, if the base was already red, when new tests fail). The failing test names are read from the output of the common runners (node:test, jest, vitest, mocha, pytest, go, cargo), and the finding is anchored on the changed line the failure points at, else on the biggest changed source file. When a regression is proven and the range has more than one commit, Assay also finds the **first commit where the tests fail** (D49): it runs them in the middle of the range and keeps halving, so five commits take two runs and 200 take eight, all cached by commit. The finding then says "starting at `abc1234`", the two commits are evidence that replays, and when the failure points at no line the anchor prefers the files that commit changed. It needs a green base, follows the first-parent line from the base, and stops with what is known ("one of 4 commits after `abc1234`") if a run in between can't be judged. `--no-bisect` skips it.
- **The revert test.** For up to a few risky, unproven source findings, the hunk is put back as it was before the range (in the head copy) and the tests run again. If no test result changes, that change is untested.
- **Mutation.** Up to a handful of changed lines get one small change each: `===`↔`!==`, `<`↔`<=`, `&&`↔`||`, `true`↔`false`, `+`↔`-`, a number, a removed `!`. Strings and comments are skipped. A mutant that makes a test fail is *killed*; one that leaves every test green *survived*; one that breaks the build with no failing test is *invalid* and not counted.
- **A red head can't be judged.** If the tests already fail at the head, reverts and mutants are skipped and it says so: "no test failed" can't be told from "tests were already failing".
- **Cost and cache.** Results are cached by commit, command and change. A time budget stops starting new runs and keeps what was done.

## Browser checks, in detail

`assay look` serves the checkout (a small static server for HTML files, or the project's own dev server), launches a Chromium-based browser through its own pipe, and opens each page at the head and at the base. For each page it loads four times (desktop and phone, light and dark) and measures each load as loaded and again with the page's `dir` forced to `rtl`: 8 combinations.

**Everything is differential**: a problem counts only if the same page, in the same combination, did not have it at the base. That is what makes "two things overlap" safe to report. A page that is new at the head skips the noisy kinds (overlap, accessibility basics) and keeps the rest.

What is measured is listed in [Checks](CHECKS.md#browser-checks). Each finding is anchored on the changed line most likely to have caused it: a changed line that names one of the element's classes or ids (a stylesheet first), else the nearest changed line to an unchanged one that does.

**The probe** puts `<assay-probe>` in the page's query parameters (names found from its forms, links and address) and types it into its text fields without submitting. If an element by that name appears, text became markup. It talks only to the loopback server Assay started and never submits a form.

**Before and after** pictures are taken as loaded on desktop and phone and mirrored on desktop, compared inside the browser (so Assay has no image code), and kept as JPEGs. The report shows the ones that changed with a slider. A mirrored picture is kept because a mirrored-layout bug looks identical as loaded.

**Calibration.** Whether a reviewer earns its tokens is measured, not believed. Assay plants known bugs (each with a clean twin) in a throwaway repository, scores the free checks on the spot, has your agent run the reviewers, and scores each by what it caught, missed and falsely flagged. A reviewer that catches none in its lens two runs in a row is left out of plans. [The calibration guide →](CALIBRATION.md)

## Memory

Assay keeps score. Every finding that belongs to a remembered mistake (from a standards pack, or learned from the project's own fix commits) is a **hit** for it; every finding a person dismisses is a **false alarm**. The numbers appear next to the finding, so "this check cries wolf here" is something you can see, and an entry that does cry wolf (at least 4 hits, 30% dismissed, nothing real for 60 days) **switches itself off**. Only a signal can: a committed key, a measurement or a failing test is never muted.

It can also learn. A fix commit is a mistake someone already paid for, so Assay reads the history, keeps what fixes keep taking away in the same way, and suggests a pattern for a person to accept. A pattern that fires later is **corroborated** (the pattern, plus the project's own record of fixing it), never proven, and can never block.

It changes nothing else about how a finding gets its tier. [The memory guide →](MEMORY.md)

## What it costs

**Tokens: none, today.** Every check, the proof and the browser run as ordinary code. The MCP server's answers are short on purpose (a verdict, counts, the top findings, with the lines one call away), and `brief` is about 200 tokens. Assay itself never calls a model.

**Time:** the free checks take a second or two for tens of commits. `prove` costs the length of your test suite twice (base and head), plus once per revert and per deliberate change. `look` takes a few seconds per page. Everything is cached, so repeating costs nothing.

**Reviewers.** Assay itself never calls a model, so reviewers cost your agent's tokens, not Assay's, and only when you ask. It plans who is worth running (reviewers read only where the free checks say something changed, one lens each), **shows the cost before anything is spent**, hands each reviewer only its own slice, and counts what comes back through the **evidence gate**: a claim must cite a file and a line inside the diff or it is dropped, a reviewer can't claim proof, and two reviewers who each saw the same thing make it corroborated. [The reviewers guide →](REVIEWERS.md)

## What it can't do

Be clear about the limits before you rely on it:

- It finds what it has a rule, a test or a measurement for. A clean verdict means *nothing Assay can check is wrong*, not that the code is correct.
- Pattern rules cover a few languages well (JavaScript, TypeScript, Python, CSS) and others thinly. Proof works for any language with a test command Assay can run.
- Files that are not in git (a `.env`, generated files) are missing from the clean copies. Tests that need them fail at both ends and prove nothing.
- Pages that need a login, data or a build step Assay can't perform show an error or an empty page.
- The commit that broke the tests is found only along the first-parent line from the base, and only when the tests passed at the base. With a red base, or a base on a side branch, it says so and the regression stays tied to the whole range.

[More: Troubleshooting](TROUBLESHOOTING.md)

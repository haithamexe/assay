# Troubleshooting

When Assay says it can't, or the answer looks wrong. Back to the [README](../README.md). `assay doctor` is the first thing to run.

## "error: … is not a commit or branch name" / "not inside a git repository"

The range or `--repo` isn't what git knows. Check `git rev-parse <the thing>`. Ranges are `A..B`, `A...B`, one revision, or nothing at all; see [Usage](USAGE.md#ranges). Anything starting with `-` is refused on purpose.

## "There are no commits in that range" / the range is empty

You are on the default branch with nothing ahead of it. Assay then looks at the last 5 commits. If `main..HEAD` really is empty there is nothing to review. Use `--last 10` or name a range.

## "That range has N commits and the limit is 200"

Pick a shorter range, or `--max 500` (up to 1000). Each new commit costs a second or less the first time and nothing after.

## "Running this repository's tests isn't allowed yet"

`prove` and `look` run your code, so a person has to allow it, once per repository, from a terminal:

```bash
assay allow-run
```

An agent can't do this on purpose. `assay allow-run --off` undoes it.

## "No test command found"

Assay finds `npm`/`pnpm`/`yarn`/`bun test` (a `test` script in `package.json`), `python -m pytest`, `go test ./...` and `cargo test`. For anything else:

```bash
assay allow-run --command "make test"
```

The command runs exactly as typed, through your shell, in a clean copy of the commit.

## `prove` says "the tests already fail at the head"

Then "no test failed" can't be told from "the tests were already failing", so Assay skips the revert and mutation steps and says so. The regression check still ran. Fix the red tests (or check whether they need a file that isn't in git, below) and run `prove` again.

## Tests fail in Assay but pass for me

A clean copy contains **only what is in git**. If your tests need something untracked (a `.env`, a generated folder, a local database, a build step you ran by hand), they fail at the base and at the head alike, and that proves nothing either way: no regression is reported from it. Give Assay a command that does the setup (`--command "npm run build && npm test"`), or commit what the tests need.

Also check `node_modules`: Assay links the ones your repository already has. If you never ran `npm install`, there is nothing to link.

## `prove` is slow, or "time budget used up"

It costs your test suite's length twice (base and head), plus once per revert and per deliberate change. Cut it down:

```bash
assay prove --mutants 4 --reverts 1
assay prove --no-mutation --no-revert
assay allow-run --command "npm run test:unit"     # a faster command
```

When the budget (default 600 s, `--budget`) runs out, Assay keeps what it did. Run `prove` again and it carries on from the cache. A run longer than `--timeout` (default 300 s, set with `allow-run --timeout`) is stopped and not cached.

## "No Chromium-based browser … was found"

`look` needs Chrome, Edge, Brave or Chromium. Edge is on every Windows 10 and 11. If yours is somewhere unusual:

```bash
assay allow-run --browser "/path/to/browser"
```

or set `ASSAY_BROWSER`. Firefox and Safari can't be used: Assay speaks the Chromium DevTools protocol.

## `look`: "There is no dev server command and no HTML file at the top of the project"

For a plain HTML project, Assay serves the files itself and needs an HTML file at the top of the project (or `--pages`). For anything built, tell it how to start your dev server:

```bash
assay allow-run --serve "npm run dev" --pages "/,/cart"
```

`{port}` in the command is replaced, and `PORT` is set. Assay waits up to 90 seconds for the server to answer on a loopback address.

## `look`: the dev server "stopped before it was ready", or the pages are blank

The server's last lines are in the message. Common causes: a needed `.env` isn't in git, the command needs a build step, or the server ignores `PORT` and `{port}` (give it the port yourself). A page that needs a login or data Assay can't create will show an error or an empty page.

## `look` reports a problem that was there before, or one that doesn't matter

Browser results are differential: only what is new at the head counts, per page and per combination. If something shows up that you don't care about:

- *Overlaps and cut-off text in the mirrored combinations* come from forcing `dir="rtl"` on a page that was never meant to mirror. If the base had the same, it is cancelled; if the change made it newly worse, it is reported, and it says "when mirrored". Dismiss it if you don't mirror this page: `assay resolve <finding> dismissed`.
- *Contrast* is measured against the real background behind the text; text over an image or gradient is skipped.

## A finding is a false alarm

Dismiss it, and say so: `assay resolve f-1a2b3c4d dismissed`. It stops counting against the verdict and the case remembers. If it is a pattern that is wrong in general (not just here), that is a bug in the check; see [Contributing](../CONTRIBUTING.md#the-calibration-rule).

## It found nothing and I expected something

A clean verdict means nothing Assay can check is wrong. Its pattern rules cover a few languages well (JS, TS, Python, CSS) and others thinly, and the free checks only read the diff. Run `prove` and `look` for the checks that run code. [What it can't do →](HOW-IT-WORKS.md#what-it-cant-do)

## Old results after an update

Each commit's analysis is cached and versioned. When a check changes what it reports, the version is bumped and old entries are ignored. To force it anyway: `assay case --fresh`.

## The dashboard

**"This page needs the address that `assay dashboard` printed"**: the page needs the key that run made. Open the address from the terminal, with `?token=…` in it. A new run makes a new key, so an old address stops working.

**"Port … is already in use"**: you passed `--port` for a port something else has. Pick another, or leave `--port` out and the system picks a free one.

**"Disconnected: run assay dashboard again"** (bottom of the sidebar): the server stopped, or the computer slept long enough to lose it. Start it again; cases, results and pictures are kept, so nothing is lost.

**A run button shows a lock, and pressing it shows a command**: running this project's code is off. Run that command in a terminal, then press the button again. The dashboard can't do it for you, on purpose. [Why →](../SECURITY.md)

**"A run is using this case"** when you dismiss a finding: a test or page run is still working on it. Wait for it, or press *Stop*.

**"That picture is no longer on disk"**: the pictures live in `~/.assay/shots/<case>`. Press *Look at the pages* again to take them.

**The list doesn't show a commit I just made**: it watches every few seconds and offers *Refresh* in a note; or press `Ctrl K` and choose *Refresh the timeline*.

## Memory

**"Memory is off"**: memory uses the SQLite built into Node, which needs **Node 22.13 or newer**; or `~/.assay/memory.db` could not be opened (the message says which). `assay doctor` shows it. Everything else works without memory. If the file is the problem, move it away and a new one is made (you lose the stats and the patterns learned, not the cases).

**"A pack file was skipped"**: the message names the file and the field. `assay memory packs` and the Standards tab list them. A pack needs an `id` in lower case letters, digits and dashes, a `name`, and rules that each have a `name` and either `sources` or a `question`. [Writing a pack →](MEMORY.md#writing-or-importing-a-pack)

**A finding I used to see has gone**: an entry that was crying wolf (at least 4 hits, 30% dismissed, nothing real for 60 days) switches itself off, and what it found is no longer reported. `assay memory list --all` shows it as *cried wolf*; `assay memory on <entry>` brings it back. A pack that is off does the same for the rules only it asks for.

**The timeline took a few seconds after I changed memory**: switching an entry or learning a pattern changes what the free checks report, so the commits you look at next are analysed again, once. Everything else stays cached.

**`memory mine` found nothing**: that is a fair answer. It finds calls, properties and CSS declarations that fix commits keep taking away, the same way each time. It can't find a logic slip. A history with few `fix:` commits, or fixes that each did something different, gives nothing to suggest. [How it decides →](MEMORY.md#learning-from-history)

**"That pattern matches almost every line" / "may not repeat something that already repeats"**: a pattern you gave is refused so a mistake in it can't flood a review or run for ever. Make it say what is wrong: `old_api\.fetch_all\(` rather than `.*api.*`.

## Reviewers

**"No reviewer is worth its tokens for this change"** (or *none worth running*): the plan routes by what changed, and a small change touches few lenses. That is the point: it costs nothing. Give a `--request` to bring in Triage, or look at the reasons: `assay reviewers`.

**A reviewer says "Over budget"**: the budget can't pay for it and the cross-examination reserve. Raise it (`assay reviewers budget 80k`, or the box on the Reviewers screen) and plan again.

**The Reviewers screen doesn't move while my agent works**: it follows what the agent *reports*, through `finding_submit` with `done: true`. A reviewer that never says it is done stays "Working". The screen asks every few seconds.

**"The budget is now …, but this plan was made with …"**: you changed the budget after a panel was planned. The panel keeps the budget it was planned with so its progress is never hidden; plan again to use the new one (that starts the panel over).

**The Stop hook doesn't block**: it only looks at a branch that has left the default branch (`--always` also reviews the last commits), only blocks a Blocked verdict, and lets go after 2 tries in a row for the same state. Uncommitted changes aren't reviewed: Assay reads commits. `assay hook stop --verbose` (with the agent's JSON on standard input) says what it decided.

**I can't make Assay start the reviewers**: by design. Assay never calls a model, so it can't start sub-agents. Give your agent the words on the Reviewers screen.

## Calibration

**"There is nothing to plant"**: the project has no JavaScript, TypeScript, Python, CSS, HTML or `package.json` for the bugs to be shaped after.

**A reviewer is "left out of plans"**: it caught none of the bugs planted in its lens in its last two finished calibration runs. That saves its tokens; bring it back for a plan with `assay reviewers plan --include <lens>`, and calibrate again to see whether it earns its place. A model varies from run to run: run it more than once before you decide.

**The scoreboard doesn't fill in**: it fills in as the reviewers *report* (`finding_submit` with `done: true`) on both cases. A reviewer that wasn't part of the panel shows "Not part of this run"; one that hasn't reported shows "Not reported yet".

**"The cases of this calibration run are gone"**: `assay calibrate clean` (or a newer run) removed them. Start another.

**Every reviewer looks great (or terrible)**: ten to twenty planted bugs are a small sample. Treat one run as a hint.

## Platforms

Assay runs on **Windows, macOS and Linux** with Node 22 or newer and git. Everything that differs by system is in one place each, and the test suite runs on all three (see the [CI workflow](../.github/workflows/ci.yml)).

**Linux**

- The browser is looked for as `google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge` and `brave-browser` on your `PATH`, and in the usual vendor and snap folders. Debian and Ubuntu: `sudo apt install chromium`. Otherwise `assay allow-run --browser <path>` or `ASSAY_BROWSER`.
- In a **container, or as root**, a browser refuses to start with its sandbox on. Assay starts it with `--no-sandbox` when it runs as root, and keeps the browser's shared memory in `/tmp` (a container's is tiny). It only opens pages of the project you are reviewing, on a loopback address it started itself.
- `--open` uses `xdg-open`; without a desktop it just prints the address.
- Folders that differ only by case are two different repositories, as they are on that file system.

**macOS**

- The browser is looked for in `/Applications` and `~/Applications` (Chrome, Edge, Brave, Chromium). `--open` uses `open`.
- Test commands run through `/bin/sh`. Python projects use `python3`.

**Windows**

- Assay uses folder junctions for `node_modules` links, which need no special privilege.
- `npm` is run through the shell (`cmd.exe`) because it is a script on Windows.
- If a run is killed, a stray browser or server process can survive. Assay stops the whole process tree it started, including on timeout (`taskkill` on Windows, a process group elsewhere).

**Everywhere**: Assay keeps its state in `~/.assay` (or `ASSAY_HOME`), writes files whole with mode 0600 where the system has modes, and reads git through `execFile` with argument lists, never a shell. A folder is one repository however it is reached: through a link, or by a Windows short name, it has the same settings, memory and caches. Files in the repository use one line ending (LF) on every system (`.gitattributes`).


## Where is everything?

`~/.assay` (or `ASSAY_HOME`): cases, caches, test runs, screenshots, reports and your `allow-run` settings. It is safe to delete; you will only lose the caches and your settings. [The layout →](ARCHITECTURE.md#state-on-disk)

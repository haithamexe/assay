# Security

What Assay runs, what it can't be made to run, and how to report a problem. Back to the [README](README.md).

## The short version

- **Reading a diff runs nothing.** `case`, `timeline`, `show`, `brief`, `report` and `replay` of a free check only read git.
- **Running your code is opt-in, per repository, and only you can switch it on.** `prove` and `look` run your tests, your dev server and a browser. They refuse until you have run `assay allow-run` in that repository, from a terminal. There is no MCP tool, flag or request that can do it for an agent.
- **Assay can't sandbox your code.** Your tests and your dev server run with your own permissions, exactly as if you had typed `npm test` yourself. **Allow it only for repositories you trust**, and not for code you have just cloned from a stranger.
- **Nothing leaves your computer.** Assay makes no network calls of its own and has no account, key or telemetry. (Your tests and your pages may do whatever they do.)
- **The dashboard can show the permission and can't give it.** It listens on `127.0.0.1` only, behind a key that only that run knows, and when running is off its buttons show the terminal command instead of changing anything.

## What runs, and when

| Command | Runs |
|---|---|
| `case`, `timeline`, `show`, `brief`, `report`, `cases`, `resolve`, `mcp`, `allow-run`, `memory` (including `memory mine`) | `git` (read-only commands) and nothing from your project |
| `doctor` | `git --version`, and `--version` of a few optional tools (Semgrep, gitleaks, osv-scanner) if they are on your PATH, to say whether they are there |
| `replay` of a free check | `git` |
| `dashboard` | `git` (read-only) and a web server on `127.0.0.1`. It runs your tests or a browser only when you press a button, and only if `allow-run` is on |
| `prove`, `replay` of proof | Your test command, in clean copies of commits |
| `look`, `replay` of a browser finding | Your dev server (or Assay's static file server), and a Chromium-based browser |

## The boundaries

**Which command runs.** Only the project's own test command, found from its manifest (`npm`/`pnpm`/`yarn`/`bun test` with the project's own `test` script, `python -m pytest`, `go test ./...`, `cargo test`), or the command **you** typed with `allow-run --command`, kept in `~/.assay/repos.json`. The dev server is `dev` or `start` from `package.json`, or what you typed with `--serve`. A command is never taken from a request, a file in the diff, or an agent's argument.

**Your repository is only read.** A run happens in a clean copy under `~/.assay/work`, made with a temporary git index (`read-tree`, `checkout-index`), so your working tree, your index and your `.git` are never changed. The copy gets links to your installed `node_modules`, with workspace packages pointed at the copy's own code. When a run ends the copy is deleted, **links first**, and if a link can't be removed the folder is left rather than deleted, so removal can't reach into your real packages.

**git** is run only through `execFile` with an argument array, never a shell. A revision from outside is checked (letters, digits and `./_~^@{}-`, never starting with `-`, never containing `..`) and resolved with `rev-parse --verify --end-of-options`. A case id from outside has one fixed shape and can't name another file.

**The environment of a run** gets `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0` and `ASSAY_RUN=1`, and loses `NODE_TEST_CONTEXT`. Runs have a time limit (300 s by default) and the whole process tree is killed when it passes; output is capped at 8 MB.

**The browser** is launched on a pipe, not a port, with a throwaway profile that is deleted afterwards and its cache turned off. Assay opens only paths on a loopback address it started itself: a page given from outside is refused if it has a scheme, starts with `//`, or contains a backslash. The static file server answers only `GET` and `HEAD`, only inside the checkout, and only on `127.0.0.1`. The probe types a harmless `<assay-probe>` marker into fields and query strings and **never submits a form**. Note that the pages themselves run in the browser with normal network access, as they would for you.

**The dashboard** is a small web server for one person on one computer.
- It binds `127.0.0.1` and checks the `Host` header, so a web page whose name was pointed at your computer (DNS rebinding) is refused.
- Every request needs this run's key: 24 random bytes, sent once in the address, exchanged for an `HttpOnly`, `SameSite=Strict` cookie and removed from the address bar. A new run, a new key.
- A `POST` needs the page's own `Origin`, a JSON body of at most 64 KB and the JSON content type, so no other site can make your browser press a button.
- The page may load only from the server itself: `default-src 'none'`, scripts and styles from `'self'`, no inline script or style, no framing, no forms. Everything that came from git, a page or a test run is escaped by default; a test puts an inline handler into the live page and checks that it doesn't run.
- It serves a fixed list of files by exact name, a picture only if the case recorded it, and only cases of its own repository.
- It has **no way to switch on `allow-run`**: no request, no button. It shows the command and you run it in a terminal.
- A person who can read your terminal can use the key while the dashboard runs, as they could run the CLI. It is as strong as your user account, no stronger.

**Memory** ([guide](docs/MEMORY.md)) keeps what Assay learns in `~/.assay/memory.db` and reads plain JSON packs. It can't weaken a check by itself, and it can't be used by an agent to do it.
- **Memory never mutes proof.** Only a signal can be switched off, by a person or by expiry (`rule:`, `diff:` and learned patterns). A committed secret, a measurement, a failing test is never skipped, whatever its entry says. A test switches off the secrets entry and checks the key still shows.
- **An agent can only read it.** The one MCP tool, `memory`, reads. Adding a pattern, switching an entry or a pack, importing a pack and forgetting an entry are commands or buttons: a person's.
- **A learned pattern can't be more than a signal.** It is `rule` evidence (plus `history` evidence when fixes are behind it), at most medium, so it can ask for a look and can never prove or block anything.
- **Patterns are data, not code.** They run as regular expressions on added lines (at most 1,500 characters each) and nothing else. A pattern is refused if it is over 200 characters, has a flag other than `i`, repeats a repeat (which can run for ever), or matches almost every line. Patterns made from history are the token's own characters, escaped. The dashboard can only add a suggestion that came from this project's own history, never a pattern the page sends.
- **Pack files are checked field by field** (size under 256 KB, fixed id shapes, `http(s)` sources only, lengths) and are never executed. A pack that fails is skipped and reported, not half loaded.
- **Mining reads git and nothing else.** It runs no project code. Lines it keeps as examples go through the same secret masking as everything else.

**Reviewers** ([guide](docs/REVIEWERS.md)) spend an agent's tokens, never Assay's, and Assay never calls a model.
- **Nothing to spend through Assay.** It has no key and makes no network call. `reviewers_plan` and `reviewer_brief` return text; the agent decides to start sub-agents. The cost is shown before it is incurred.
- **A brief never contains a secret.** The slice of the diff a reviewer is handed goes through the same masking as everything else Assay writes out (a brief goes into a model's context), and a test plants a key and checks that no brief has it.
- **Blind by construction.** A brief holds only that reviewer's lens and slice. Another reviewer's claims reach a reviewer only in cross-examination, after every planned reviewer has reported, and anonymously.
- **A reviewer can't raise itself above a hint.** Its claims go through the evidence gate (a changed line or it is dropped; no proof), so at best a finding is corroborated, never proven, and it never blocks. A dispute changes no tier.
- **The Stop hook blocks only what Assay can show is wrong,** from Assay's own verdict, and lets go after a few tries in a row so it can't trap a session. `assay hook install` only prints; it never edits your agent's settings.
- **The dashboard's budget is just a number.** It can't start, spend or run anything, and never touches `allow-run`.

**Calibration** ([guide](docs/CALIBRATION.md)) reads git and writes only under `~/.assay/calibration`.
- **It runs none of your code and copies none of it.** The throwaway repository holds only the files being planted, in folders named like yours; the free checks only read its diff. It makes no network call and spends no tokens.
- **Nothing in your project changes.** A test checks that the project's working tree and HEAD are the same after a run.
- **A run id is only its fixed shape** (`cal-` and eight hex digits), so it can name no other folder. The dashboard won't open the throwaway cases as the project's own.
- **The truth is on disk.** An agent that reads `~/.assay/calibration` could cheat; the prompt says not to, and it is an honor system. Calibration measures your own agents on your own machine: there is no one to fool but you.
- **A reviewer is only ever left out of plans, never made more trusted:** the record can switch a reviewer off (and `--include` brings it back); it can never turn a hint into proof.

**Secrets Assay finds are never printed.** A matched secret is masked at the source (`AKIA…(20 characters)`) in findings, snippets, case files, caches, reports, tool answers and logs; a finding's "is it still there?" check keeps a hash of the line, not the line; a line that is only a long run of base64 (the body of a key) is always masked. A test scans every file Assay writes for a planted secret.

**Reviewers and agents can't override evidence.**
- A claim must cite a line inside the diff or it is dropped.
- Proof can't be claimed: anything a claim calls a failing test is stored as its reading and marked `[unverified]`.
- A reviewer's finding is at best corroborated and **can't block**.
- `finding_resolve` refuses to dismiss a proven finding. You do that with `assay resolve`.

**Local files.** State lives under `~/.assay` (or `ASSAY_HOME`) and is written whole with mode 0600 (0700 for folders) where the system has modes. On Windows the folder's normal permissions apply.

## What Assay does not protect against

- A repository whose tests or dev server are malicious. `allow-run` is trust in the repository.
- A page that does harm in the browser by itself (it runs in the browser's sandbox, with network access).
- Anything it has no rule, test or measurement for. A clean verdict means *nothing Assay can check is wrong*.

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private vulnerability reporting (the repository's **Security** tab, then **Report a vulnerability**), or contact the maintainer directly.

What helps: the command you ran, what you expected, what happened, and (if a secret leaked or a command ran that shouldn't have) the smallest repository that shows it. The first thing to say is whether it crosses one of the boundaries above.

Only the latest version on `main` is supported.

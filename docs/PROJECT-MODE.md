# Project mode

`assay case` reviews a **change**. `assay checkup` looks at the **project as it is**: what is wrong in the committed files right now, and, from the second checkup on, what is new since the last one, what was already there and what is gone. Back to the [README](../README.md) · [Usage](USAGE.md).

```bash
assay checkup                                  # HEAD, compared with the last checkup
assay checkup --url http://localhost:3000      # also note the app running on this computer
assay checkup --har visit.har --flow checkout.json --openapi api.yaml
assay checkup --json                           # the contract below, for CI and other tools
assay checkup --fail-on new                    # exit 2 when something proven or corroborated is new
assay secrets                                  # only the keys, key files and .env files
assay checkup list                             # the checkups kept for this repository
assay show k-1a2b3c4d5e6f                      # one finding, by its id or its key
```

A checkup reads git and the files you hand it. It runs nothing, loads no page, calls no address and uses no tokens. The checks that do run things (tests, pages, the attack checks) join project mode one at a time, each behind `assay allow-run` like `prove` and `look`.

## What it checks today

| Check | What it finds | Tier |
|---|---|---|
| `secrets` | An AWS, GitHub, Slack, Google, Stripe or npm key, a private key, credentials inside a URL, or a secret-looking value, in any tracked file; a tracked key file (`id_rsa`, `*.pem`, `*.p12`…) or `.env` file | proven for a real key or file; a hint or corroborated for a pattern in a test or example path, or a generic assignment |

It is the same secrets check `assay case` runs on a diff ([Checks](CHECKS.md)), handed every tracked file whole. Every match is masked: the key itself never reaches the screen, the JSON or the file Assay keeps.

**Only what is committed is read.** The files come from git at the commit (HEAD, or `--ref`), not from your folder: a local `.env` that isn't committed is not read, and changes you haven't committed are not part of the checkup (it says how many there are). A file over 1 MB or a binary file is checked by its name only.

**New, already there, gone.** Each finding has a key made of the check, the file and the line's text (a secret's text only as a hash), not the line number: a key that moved down ten lines is the same finding. The first checkup of a repository has nothing to compare with, so its findings are `first`. The comparison is with the newest checkup that ran the same checks. Assay keeps the last 30 per repository; `--no-save` checks without keeping.

## Running the tests once: `assay test`

`assay test` is project mode's first check that runs something: the project's own tests, once, at a commit (HEAD by default). It needs `assay allow-run`, like `prove`. By default the run happens in a clean copy of the commit under `~/.assay/work`, so your folder is only read; `--here` runs in your own folder instead, uncommitted work included, and needs a second yes, `assay allow-run --here`, that only a person can give.

It reads the runner's own report, not its coloured output: vitest and jest JSON, node:test TAP, pytest JUnit XML and `go test -json`. So each failure comes with its name, file, line, message, expected and actual. Another runner, or a command you typed with `allow-run --command`, is read from what it prints (counts and names when it says them). `--coverage` adds the share of lines run and the least covered files. `--json` follows `"schema": "assay.test/1"`. All the flags are in [Usage](USAGE.md#assay-test).

A failing test here is a report, not a finding: with no base to compare with, "it fails" can't be told from "it always failed", so it isn't ranked or kept. To judge a change, `assay prove` runs the tests at both ends.

## Attack my app: `assay attack`

`assay attack --url http://localhost:3000` is a friendly security pass on your own app, running on this computer. Assay doesn't start it: you give the address of one that is running, and the endpoints it tries come from what Assay can read without running anything: the repository's routers and OpenAPI file (a `--openapi` file, a `--har` and `--pages` add to them). It needs `assay allow-run`.

**Reads, always (GET only):** security headers on the first page, the flags of every cookie the app sets, CORS from another origin (an echoed origin, with credentials or without), script in the address that comes back unescaped (and, in a real browser, becomes an element), stack traces and SQL errors after a quote. With a session (`ASSAY_SESSION_COOKIE` or `ASSAY_SESSION_AUTHORIZATION` in the environment, never an argument): calls that answer the same without it, and other ids. An endpoint whose name says it does something (`logout`, `delete`, `reset`) is never sent.

**Writes, only with `--writes` and your own `assay allow-run --writes`:** script saved through a form (then the pages are loaded in a browser), a write sent as another site would send it with your cookie (CSRF: only for a write that refuses you without the cookie), 20 wrong passwords in a row, and a broken body. The body of a write is built from the OpenAPI file: a property's name and type, with test values and the marker in up to three free-text fields; nothing is taken from a recorded body. It is meant for a development database.

Each finding has the request that shows it, the file that declares the route when Assay read one, and a fix. A **proven** finding is observed in a response whatever was meant: a header missing, an origin echoed with credentials, the marker back unescaped, a SQL error. A **hint** depends on what was meant (is that endpoint meant to be public? does that record belong to this user?) and never counts as proof. `--fail-on high|medium|low` exits 2 when a proven finding is that serious. `--json` is `"schema": "assay.attack/1"`; the MCP tool `attack` takes the same inputs except a session (an agent can't hand it one) and `writes`, which is refused unless you turned it on. A run isn't kept or compared yet.

## Try an upgrade: `assay try`

`assay try react@19` answers "what would break if I upgraded this?" before you do it. It makes two clean copies of a commit (`--ref`, HEAD by default), runs your package manager's own install in the first (your lockfile's versions: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` or `--immutable`, `bun install --frozen-lockfile`), copies that install to the second and adds the one package at the new version there. A tag (`latest`, `next`) or a partial version (`19`, `19.1`) is resolved by the package manager (`npm view`), to the highest exact version that matches. Then in both copies it runs:

- **The type check and the build**, your own scripts (`typecheck`, `type-check`, `check-types`, `tsc`… and `build`), else `tsc --noEmit` for a TypeScript project;
- **The tests**, the command Assay finds for the project (or the one you gave with `allow-run --command`);
- **The pages** (`--pages`, the ones set with `allow-run --pages`, else `/`): your dev server is started from each copy and the pages are scanned in a browser with the checks `look` makes (layout, accessibility, errors, failing requests), their data calls, how fast they load, and a before and after picture. `--no-pages` skips the browser, `--no-tests` the tests.

**The report says what breaks first, then what only changes.** *Breaks*: the new version doesn't install, the type check or build fails where it passed, more tests fail (the new ones are named), a page no longer opens, throws, shows nothing, or has a request that fails or a call answering worse. *Changes*: a page looks different, has new layout or accessibility problems, calls something else, or is clearly slower or heavier. *Same*: nothing Assay can see. *Unclear*: your project doesn't install even before the change (so nothing can be compared; the tail of the install is shown). Tests that already fail before the change are noted, and only tests that fail now and didn't count. `--fail-on breaks|changes` exits 2; `--json` is `"schema": "assay.try/1"`.

**What it needs, and what it never does.** `assay allow-run` and your own `assay allow-run --network` (the package manager reaches its registry: Assay makes no call of its own, so this is a yes of its own). Install scripts are **not** run (`--scripts` runs them, in your terminal only), so a package that needs its script to work (one that downloads a binary) may fail the same way in both copies, which the comparison cancels. Both copies are under Assay's folder and removed after, whatever happened. Your folder and your `node_modules` are untouched, and nothing is committed or written to `package.json` or the lockfile of your project.

**Its limits:** the package must be one of your top `package.json`'s dependencies (not a workspace package's own), the project must be an npm, pnpm, yarn or bun project, the dev server comes from your `allow-run --serve` or `package.json` and needs nothing that isn't in a clean copy (a `.env`, a database), and a run takes minutes (two installs, two sets of checks, two dev servers). A run isn't kept or compared with the last one, and it tries one package at a time.

## Gremlins: `assay gremlins`

A headless browser goes through your app by itself, the way an impatient and careless person would: clicking whatever it finds, typing nonsense into fields (a long text, markup, SQL, other scripts, odd numbers and dates), double-clicking submit, pressing Enter, going back halfway. It is seeded, so the same seed does the same things, and each problem comes with the last steps that led to it: `click “Save” → type "<script>…" into #note → double-click “Pay”`.

It clicks and types, so it needs `assay allow-run` and your own `assay allow-run --writes` (the same second yes as `assay attack --writes`: a click can save, a typed text can be sent). Two ways to point it:

- **An app that is running:** `assay gremlins --url http://localhost:3000`. Assay never starts it, and everything the browser sees is reported. `--page /cart` starts somewhere else. For an app behind a login, put your session in `ASSAY_SESSION_COOKIE` and/or `ASSAY_SESSION_AUTHORIZATION` (a value from your browser; never an argument): the cookie is set on the app's origin, the Authorization header goes to that origin only, and the session is taken out of every text the page echoes back (`[session]`) and is in no report. A clean copy of a commit has nobody's session in it, so a session is only used with `--url`.
- **A commit:** `assay gremlins --ref <commit> --base <commit>`. Assay starts your dev server (or serves your HTML) from a clean copy of each commit, runs **the same seed** at both, and reports only what is new at `--ref`. Without `--base` it reports everything it saw. Your repository is only read.

**What it looks for:** an uncaught error (high), a blank page (high), the framework's own error screen (high), a server answering 5xx (medium), a failing data request (medium), a logged error (low). Each has the steps, the page and how often it came up. `--phone` is a narrow touch screen. `--actions 40` (at most 300), `--seed`, `--fail-on high|medium|low` (exit 2 on one that serious), `--json` is `"schema": "assay.gremlins/1"`, `--all` shows every finding and its advice. With a base, a finding is anchored on a changed line that wrote what it names, when there is one.

**Its limits:** the browser talks to this computer only, so a request to a payment service or a mail server is refused (listed as "refused to talk to") and is never counted as the app's fault. It leaves the origin it started on, leaves controls named like delete, sign out or reset alone (listed) unless `--bold`, and answers an alert or confirm with no. Without a session it starts signed out: a page behind a login shows its login. A finding is proven in that the browser saw it, and what it means is your call. A run is a sample: the same seed does the same things as long as the app answers the same, and a run that finds nothing is not proof that nothing is wrong.

**Kept runs, compared and replayed (D66).** Every run is kept (the last 30 per project, `--no-save` skips one) and compared with the newest kept run of the same app (the same address, or another copy of a commit): each problem is *first*, *new* or *there before*, and the problems that run had and this one didn't meet are listed as *gone* (with another seed that may only mean it didn't go there, and the report says which seeds). `assay gremlins list` shows the runs, `assay gremlins show [<run>]` one of them. **`assay gremlins replay <run> [--finding g-…] [--url <address>]` does again, exactly and in order, the steps that run recorded up to that problem, and says whether the problem came back** (exit 2 when it did): not a new random run, the very same clicks and typed texts, so a fix can be checked and a report can be handed to someone. For a run from a clean copy it starts the app from that commit's copy again. A replay is not a run: nothing is kept. If a click or a field is no longer on the page, the replay says how many steps could not be done. The dashboard's **Gremlins** screen lists the kept runs and shows each problem with its steps, but has no button that runs anything: it shows the command, with Copy.

## What later checks will use

Project mode also lists what the project describes, so the checks that load pages or call the app know where to go. Today this list is read from files only.

| Source | Pages | Endpoints |
|---|---|---|
| `--pages "/,/cart"` and the `allow-run --pages` setting | ✓ | |
| Next.js (`app/**/page.tsx`, `app/**/route.ts`, `pages/**`, `pages/api/**`) | ✓ | ✓ |
| Nuxt and Astro (`pages/**`; Astro's `.ts` pages are endpoints) | ✓ | ✓ |
| SvelteKit (`src/routes/**/+page.svelte`, `+server.ts`) | ✓ | ✓ |
| Remix and React Router (`app/routes/*`, flat names) | ✓ | |
| Plain HTML files (not under `docs/`, `templates/`, build folders) | ✓ | |
| Express-style calls (`app.get('/x')`, `router.post(…)`) and NestJS (`@Controller` + `@Get`) | | ✓ |
| The repository's own `openapi.*` or `swagger.*` file, or `--openapi <file>` | | ✓ |
| `--har <file>` | ✓ | ✓ |
| `--flow <file>` (its start and `goto` paths) | ✓ | |

A router folder counts only when the framework is there (its config file, or the package in a `package.json`): a `src/pages` folder in a plain React app holds components, not routes. Parameters are shown one way whatever the router wrote (`:id`, `[id]`, `[...slug]`, `$id` become `{id}`), and a page with one is marked as needing a value. Routes read from code are as each file writes them: a prefix a router is mounted under elsewhere isn't known.

### `--url`

The address of the app running on this computer: `http` or `https`, and `localhost`, `127.0.0.1`, `[::1]` or a name ending in `.localhost`. Anything else is refused, and so is an address with a user name or password. Nothing is sent to it in a checkup today; the checks that load pages will use it instead of starting a dev server.

### `--har <file>`

A HAR file is a browser's recording of its network traffic: in Chrome, Edge or Brave, DevTools → Network → *Save all as HAR*; other tools export one too. Assay keeps only the recording's own site (the address of its first page, or the app's address when `--url` is given; requests to other sites are counted and left out) and, from each request, only the **method and the path**. Ids in a path are folded (`/items/42` and `/items/43` are `/items/{id}`). A header, a cookie, a query value or a body is never kept. At most 64 MB.

### `--flow <file>`

A flow is a list of steps a person takes on a page. A file holds one flow or a list of up to 50:

```json
{
  "assay": "flow/1",
  "name": "Checkout",
  "start": "/cart",
  "steps": [
    { "click": "text=Checkout" },
    { "type": "octocat@example.com", "into": "#email" },
    { "press": "Enter" },
    { "waitFor": "url=/thanks", "timeoutMs": 5000 }
  ]
}
```

| Step | Means |
|---|---|
| `{ "goto": "/path" }` | Open a path on the same app |
| `{ "click": "<selector>" }` | Click an element; add `"double": true` to click twice, quickly |
| `{ "back": true }` | The browser's back button |
| `{ "type": "text", "into": "<selector>" }` | Type text, into a field or (without `into`) the focused one |
| `{ "press": "Enter" }` | Press one of Enter, Tab, Escape, Backspace, Delete, Space, the arrows, Home, End, PageUp, PageDown |
| `{ "waitFor": "<selector>" }` | Wait for an element, `text=…` on the page, or `url=…` in the address |

A selector is CSS, or `text=Sign in` for an element by its text. Each step does exactly one thing and may add `timeoutMs` (1 to 60000). A field Assay doesn't know, a second action in one step or a path with a host refuses the whole file, with the step that is wrong. At most 500 steps.

**A recording from Chrome DevTools' Recorder panel** (*Export as JSON*) is read as a flow: its first `navigate` is the start (the path only), clicks, double clicks, typed values, keys and waits become steps, and steps with no equivalent (the viewport, a scroll, a hover) are counted and left out, never guessed.

### `--openapi <file>`

An OpenAPI 3 or Swagger 2 document, JSON or YAML, at most 5 MB. The first server's path (or Swagger's `basePath`) is put in front of each path. YAML anchors and aliases are refused: give such a file as JSON. Without this flag, the repository's own `openapi.*` or `swagger.*` file is found and read from git.

## The JSON contract

`assay checkup --json` prints one object. Its `schema` is `"assay.checkup/1"`: within that version fields are only ever added, never renamed or removed; anything else is a new version. Other tools should read it rather than the text.

```jsonc
{
  "schema": "assay.checkup/1",
  "id": "ck-20261127101610-14efc3",       // ck-<UTC yyyymmddhhmmss>-<6 hex>
  "repo": "/path/to/shop-website",
  "name": "shop-website",
  "head": "<40-hex commit>",
  "branch": "main",                        // null when a commit other than HEAD was checked
  "createdAt": "2026-11-27T10:16:10.000Z",
  "uncommitted": 1,                        // tracked files changed and not committed (not part of the checkup)
  "checks": [{ "id": "secrets", "files": 412, "secs": 0.4, "notes": ["…"] }],
  "inventory": {                           // null with `assay secrets`
    "url": "http://localhost:3000",
    "pages": [{ "path": "/cart", "from": ["router", "har"], "file": "app/cart/page.tsx" },
              { "path": "/items/{id}", "from": ["router"], "dynamic": true }],
    "endpoints": [{ "method": "GET", "path": "/api/items", "from": ["openapi"], "file": "openapi.yaml" }],
    "flows": [{ "name": "Checkout", "start": "/cart", "steps": 4, "skipped": 0, "file": "checkout.json" }],
    "frameworks": ["next"],
    "notes": ["2 requests in the HAR went to other sites and were left out."]
  },
  "findings": [{
    "id": "f-6b2b59fb", "key": "k-1a2b3c4d5e6f", "since": "new",   // "first" | "new" | "before"
    "check": "secrets", "title": "AWS access key id in config.js", "lens": "Security",
    "severity": "high", "tier": "proven", "file": "src/config.js", "line": 1,
    "evidence": [{ "kind": "fact", "source": "fact:aws-key", "what": "AWS access key id on line 1: AKIA…(20 characters)" }],
    "observed": ["…"], "inferred": ["…"], "snippet": { "rows": ["…"] }, "risk": 9
  }],
  "previous": { "id": "ck-…", "head": "<commit>", "createdAt": "…" },   // null on the first checkup
  "gone": [{ "key": "k-…", "title": "…", "file": "…", "tier": "proven", "severity": "high" }],
  "summary": { "tone": "act", "headline": "…", "proven": 1, "corroborated": 0, "hints": 0, "new": 1, "before": 0, "gone": 0 }
}
```

`summary.tone` is `act` when something is proven, `decide` when independent signals agree and nothing is proven, `clear` otherwise. Pages, endpoints and findings are capped (500, 1000, 200, the riskiest first) and a note says when something was left out.

**Exit codes**: 0 when done; 1 for an error (not a repository, a wrong flag, an unreadable file); 2 when `--fail-on` trips: `new` if a proven or corroborated finding wasn't in the previous checkup (or there is no previous one), `any` if there is one at all.

## Through MCP

The tool `checkup` takes `repo`, `ref`, `url`, `pages`, `har`, `flow`, `openapi` and `only: "secrets"`, and answers with the headline, the counts, the top findings marked new or already there, and the size of the inventory, plus the same numbers as `structuredContent` ([MCP guide](MCP.md)). It is read only in the sense that matters: it runs nothing; it does keep the checkup, so the next one can compare.

## Not yet

- The dashboard and the HTML report don't show checkups yet (the demo is the spec for screens, and it has no checkup screen).
- A finding from a checkup can't be dismissed yet, and `assay replay` doesn't replay one: running the checkup again is its replay (`assay checkup --ref <commit>`).
- Gremlins only read what the browser reports, so a bug that shows nowhere in the page, the console or the network isn't found; a replay does the recorded steps at the speed the page answers, so a problem that depended on timing may not come back; and a session can't be used for a clean copy of a commit.
- An attack run isn't kept, compared with the last one or shown in the dashboard, and Assay doesn't start the app for it (an attack on a clean copy of a commit, so a range could report what is new, is not built).
- The only check inside a checkup is `secrets`; `assay test` runs on its own and its result isn't kept or compared yet. The browser checks, untranslated text, the attack checks, random clicking and trying an upgrade arrive one by one, each using the list above.

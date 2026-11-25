# Checks

Every check Assay runs, what each can and can't tell you, and how a finding gets its tier. Back to the [README](../README.md). The model is in [How it works](HOW-IT-WORKS.md).

A check returns evidence. It never sets a tier: that is computed. Rules that match a pattern are *signals*, so on their own they produce hints. Only a fact, a failing test, a measurement or a probe is proof.

## Free checks (read the diff, run nothing)

### Secrets

Added lines are scanned. A secret is **never printed**: it is masked in findings, snippets, case files, caches, reports and tool answers (`AKIA…(20 characters)`). A line that is nothing but a long run of base64 (the body of a key) is always masked, even next to some other finding.

| Pattern | Tier it gives |
|---|---|
| AWS access key id, GitHub token, Slack token, Google API key, Stripe live key, npm token, private key block, credentials inside a URL | **Proven** (a `fact`), high |
| A key file or a `.env` file added (`.pem`, `.key`, `id_rsa`, `.env`, …; not `.env.example`) | **Proven**, high |
| A string assigned to a name like `password`, `secret`, `api_key`, `token` | Corroborated if the file is production code (the pattern plus the path), else a hint |

Deliberately *not* proven, because they are very often fixtures: any of the patterns above inside a test, demo, example, fixture or docs path, a private-key header with no key body under it, documented example keys (anything containing `EXAMPLE`), placeholders (`changeme`, `${…}`, `process.env…`, `$(…)`), and values that are only words joined by dashes (`current-password`).

### Risky patterns

Added lines in the right language, outside test, demo, preview, docs, fixture, mock and story folders (except the test rules). At most 3 hits of one rule per file per commit; the last says how many were left out. Comment lines are skipped (except `ts-suppress`).

| Rule | Lens · severity | Languages | Looks for | Ref |
|---|---|---|---|---|
| `html-injection` | Security · high | JS, TS, Vue, Svelte | `dangerouslySetInnerHTML`, `.innerHTML =`, `.outerHTML =`, `document.write`, `v-html`, `{@html}`, `insertAdjacentHTML` | CWE-79 |
| `html-injection-py` | Security · medium | Python | `mark_safe(`, `Markup(`, `\|safe` | CWE-79 |
| `eval` | Security · high | JS, TS, PHP, Ruby | `eval(`, `new Function(` | CWE-95 |
| `eval-py` | Security · high | Python | `eval(`, `exec(` | CWE-95 |
| `os-command` | Security · high | JS, TS | `exec(`, `execSync(`, `shell: true` | CWE-78 |
| `os-command-py` | Security · high | Python | `os.system`, `os.popen`, `shell=True` | CWE-78 |
| `os-command-other` | Security · high | PHP, Go, Ruby | `shell_exec`, `passthru`, `system`, `exec.Command("sh"…)` | CWE-78 |
| `tls-off` | Security · high | most | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `InsecureSkipVerify: true` | CWE-295 |
| `unsafe-deserialize` | Security · high | Python, PHP, Java | `pickle.load(s)`, `marshal.loads`, `unserialize`, `ObjectInputStream`, `yaml.load` without a safe loader | CWE-502 |
| `sql-concat` | Security · high | most | A SQL statement built with `${}`, `+`, `%`, `.format` or an f-string. **A tagged template** (``sql`…` ``, ``tx.$queryRaw`…` ``, with or without type arguments) is exempt: it binds each value. | CWE-89 |
| `cors-any` | Security · medium | most | `Access-Control-Allow-Origin: *`, `origin: "*"`, `AllowAnyOrigin` | CWE-942 |
| `perm-777` | Security · medium | code, shell | `chmod 777` | CWE-732 |
| `weak-hash` | Security · medium | most | MD5 or SHA-1 | CWE-328 |
| `weak-random` | Security · medium | JS, TS, Python | `Math.random` / `random.*` on a line about a token, password, secret, nonce or session | CWE-338 |
| `jwt-unchecked` | Security · high | most | `verify=False`, `algorithms: ["none"]`, `ignoreExpiration: true` | CWE-347 |
| `debug-on` | Security · low | Python | `DEBUG = True` | CWE-489 |
| `ts-suppress` | Correctness · low | TS, JS | `@ts-ignore`, `@ts-nocheck` | |
| `test-focus` | Tests · medium | tests | `.only(`, `fit(`, `fdescribe(` | |
| `test-skip` | Tests · low | tests | `.skip(`, `xit(`, `@pytest.mark.skip`, `@Disabled`, … | |
| `physical-css-side` | UI · low | CSS, Vue, Svelte, HTML | `left:`/`right:`, `margin-left`, `float: right`, … **only in a file that already uses logical properties or mirrors** (`inset-inline-end`, `[dir=rtl]`), where a physical side is likely a slip | |

### Whole-hunk rules

| Rule | Severity | Looks for |
|---|---|---|
| `guard-removed` | Correctness · medium · CWE-754 | A removed `if …` with an early exit (`return`/`raise`/`throw`/…) in the same hunk, where the hunk adds no check of its own. Not reported when a whole file was deleted. |
| `assertion-removed` | Tests · medium | In a test file, a removed assertion with no assertion added in its place |

### Dependencies

For `package.json`, `requirements*.txt`, `go.mod` and `Cargo.toml`, the manifest is read at the commit and at its parent and compared.

| Finding | Tier | Why |
|---|---|---|
| New dependency | Hint, low | A `diff` signal only |
| …whose name is 1–2 letters from a dependency you already have, or from a very popular package | Corroborated, medium | The `diff` signal plus a `rule` signal (name distance) |
| …or whose version is `*`, `latest`, a git URL or an http URL | Corroborated, medium | Same, with `rule:unpinned-spec` |
| An install script added (`preinstall`, `install`, `postinstall`) | Corroborated, medium | The rule plus the manifest change |

In the first commit of a repository every dependency is "new": plain ones are skipped, look-alikes and unpinned ones are still reported.

### Tests

| Finding | Tier | Why |
|---|---|---|
| Logic changed and no test changed | Hint, low | 10+ added lines of logic across source files in one commit, no test file touched, not a revert. This is also the second signal that corroborates a risky finding in the same commit. |
| A test file was deleted | Hint, medium | 5+ lines gone |

## Proof (needs `allow-run`)

| Finding | Evidence | Severity | Blocks? |
|---|---|---|---|
| Tests that passed before this range now fail | `test-fail` | high | **Yes** |
| No test notices if this change is reverted | `revert-test` | medium or low | No |
| Tests don't notice *k* of *n* deliberate changes | `mutation-survivor` | medium if at least 2 and at least half survived, else low | No |

The revert and mutation results also add a `coverage` signal to a nearby risky finding. Details: [How it works](HOW-IT-WORKS.md#proof-in-detail).

## Browser checks

Needs `allow-run` and a Chromium-based browser. Each is measured in a real render and counts only if it is new at the head, in that page and combination. Each finding names the combinations it appears in, and says "when mirrored" if it appears only in the mirrored ones.

| Kind | Lens · severity | What is measured | Blocks? |
|---|---|---|---|
| Things overlap | UI · medium | Two content boxes (image, button, input, or an element with its own text) overlap by 150 px² and by a quarter of the smaller one. Fixed and sticky elements are ignored. | No |
| Text is cut off | UI · medium | An element with its own text whose box hides part of it (`overflow: hidden` or `clip`, content wider or taller than the box), without an ellipsis or a line clamp | No |
| Text is hard to read | UI · medium · WCAG 1.4.3 | Text colour against the real background behind it (alpha blended, images skipped) under 4.5:1, or 3:1 for large text | No |
| The page scrolls sideways | UI · medium | The page is wider than its window | No |
| An image has no alt text · a control has no accessible name · a form field has no label | UI · low | WCAG 1.1.1, 4.1.2, 1.3.1 | No |
| The page shows nothing | Correctness · high | No text and no image or canvas, or the page no longer opens | **Yes** |
| The page throws an uncaught error | Correctness · high | A DevTools exception while loading | **Yes** |
| The page logs an error · a request fails | Correctness · medium | `console.error`, a 4xx or 5xx or a network failure (favicon ignored) | No |
| Text typed into the page becomes markup | Security · high · CWE-79 | The `<assay-probe>` marker, typed into a field or put in a query parameter, appears in the page | **Yes** |

## Adding or changing a check

See [Contributing](../CONTRIBUTING.md#adding-a-check). The rule that matters: a new rule ships with a test built from a real false positive when one exists, and every change to what a check reports bumps `ANALYSIS_VERSION`.

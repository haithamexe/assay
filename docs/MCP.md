# The MCP server

Assay is a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so a coding agent (Claude Code, or any MCP client) can review its own work before it says it is done. Back to the [README](../README.md).

## Add it

Claude Code:

```bash
claude mcp add assay -- node /path/to/assay/packages/mcp/dist/index.js
```

`assay mcp` prints that command with the right path for your install. Any other client: run `node packages/mcp/dist/index.js` as a stdio server.

The server reviews the folder it is started in (Claude Code starts it in your project), unless a tool is given a `repo`.

## What the agent is told

The server sends these instructions when it connects, so the agent knows when to use it without you saying so:

> assay reviews code changes with evidence, not opinion. Use it after you change code and before you say you are done.
> 1. `case_open` (no arguments reviews this branch since it left main). Read the verdict.
> 2. If it says Blocked, fix the MUST FIX items (`brief` is the short list; `finding_get` shows the lines and the evidence), then call `case_open` again. Do not say the work is done while it says Blocked.
> 3. A tier is computed from evidence. Only proven findings block. A hint is one signal: look at it, don't obey it.
> 4. If you are reviewing as a reviewer, report with `finding_submit`. Every claim must cite a file and a line inside the diff, or it is dropped. You can't claim proof: Assay runs the checks that produce proof.
> 5. You can dismiss a hint or a corroborated finding with `finding_resolve`. You can't dismiss a proven one: a person can (`assay resolve`).
> 6. `case_open` only reads the diff, so almost nothing in it is proven. `prove` runs the project's own tests at the base and the head and tries reverting and mutating the change: that is what proves a regression or an untested change. It works only if a person turned it on with `assay allow-run` (you can't). Use it before you say done on a risky change. It stops at a time budget and picks up where it stopped when you call it again.
> 7. For anything a person sees in a browser, call `look`: it opens the pages in a real browser at the base and at the head, in 12 combinations of size, colour scheme, direction and Arabic text, and reports only what is new at the head […]. Each is measured, so it is proven, and it points at the changed line that caused it. Same permission as `prove` (`assay allow-run`).
>
> 8. `memory` tells you what this project has got wrong before and what a reviewer should ask that no check can decide. Call it with the case id before you review by reading: it lists the remembered mistakes the findings match, and the questions worth asking for the case's languages. It is read only: you can't add, switch off or forget anything, a person does that.
>
> 9. Reviewers cost tokens, so use them only when a person asks for them or has set a budget. `reviewers_plan` shows who is worth running and what it costs, and spends nothing. If a person says go, start one sub-agent per reviewer it lists, in parallel, each told only to call `reviewer_brief` for its lens and follow it; never show reviewers each other's output. Each reports with `finding_submit` (`done: true`). When `reviewers_plan` says cross-examination is open, start the examiners it names the same way (round 2). Then read the verdict again. What reviewers find is at best corroborated: it asks for a look, it never blocks.
>
> Answers are short on purpose. Ask for one finding to see its lines and evidence.

It also helps to say it once in your project's `CLAUDE.md`:

```markdown
Before you say a change is done, run the assay case_open tool. If it says Blocked, fix the
MUST FIX items (brief lists them), then run it again. For anything that renders in a browser,
also run look; for logic, prove. Don't say done while it says Blocked.
```

## The tools

| Tool | Does | Needs `allow-run`? |
|---|---|---|
| `case_open` | Runs the free checks over a branch or range and returns the verdict and the ranked findings. Reads git only. Arguments: `repo`, `range`, `last`, `hints`, `fresh`. | No |
| `case_findings` | Lists the findings of a case, by `tier` or `lens`; `all` includes fixed or resolved ones | No |
| `finding_get` | One finding: the changed lines, observed against inferred, why it ranks where it does, each piece of evidence with how to replay it | No |
| `evidence_replay` | Runs the check behind a piece of evidence again and says whether it reproduces | For proof and browser evidence |
| `brief` | The short fix list: must fix, should fix, ask the person. Hints left out. | No |
| `timeline` | One row per recent commit: findings by tier, risk | No |
| `reviewers_plan` | Shows which reviewers are worth running for a case, what each costs and why the others are left out, before anything is spent; keeps the plan; and, once reviewers are running, says where the panel stands and exactly what to do next. Use it only when a person asked for reviewers. Arguments: `case`, `budget`, `request`, `include` (reviewers that [calibration](CALIBRATION.md) left out, when a person asked for them). | No |
| `reviewer_brief` | Everything one reviewer needs and nothing it shouldn't have: its lens, its slice of the change, what the free checks already found for it, how to report. Never shows another reviewer's work; round 2 (cross-examination) hands over other reviewers' claims anonymously, after every reviewer has reported. The attack pass (no lens; only when the plan lists it, from 80k tokens) is lens `attack`, and the plain review of a calibration run is lens `plain`. Arguments: `case`, `lens`, `round`, `page`. | No |
| `memory` | What this project has got wrong before. With a `case`: which remembered mistakes its findings match (and how often they were false alarms here), and the questions worth asking for its languages. Read only. Arguments: `repo`, `case`, `languages`, `limit`. | No |
| `finding_submit` | Reports claims as a reviewer, through the evidence gate (below). A reviewer in a panel also says `done: true` (with no claims if it found nothing), may say `tokens` it used, and in cross-examination (`round: 2`) may `disputes` a claim. | No |
| `finding_resolve` | Dismiss or mark intended a hint or corroborated finding, or reopen it | No |
| `prove` | The project's tests at base and head, the revert test, mutation. Arguments: `case`, `mutants`, `reverts`, `bisect` (false skips the search for the first failing commit), `behaviour` (false skips comparing the changed functions before and after), `budget_seconds` (default 90, up to 600). | **Yes** |
| `look` | The pages in a real browser at base and head. Arguments: `case`, `pages`, `probe`, `budget_seconds` (default 120). | **Yes** |

Every answer is short: a verdict, counts and the top findings, with the lines one call away (`finding_get`). Answers are capped at a few thousand characters and say how to ask for the rest. They also carry a structured form (`structuredContent`) for clients that want one.

A typical session:

```
case_open                    → Blocked: 1 proven problem · 2 to decide · 4 hints
finding_get f-1a2b3c4d       → the lines, the evidence, replay ids
(the agent fixes it)
case_open                    → Can merge, with fixes suggested
prove                        → head passed, 1 of 3 reverted hunks went unnoticed
look                         → 0 new problems at the head
```

## What an agent can and can't do

Assay is built so an agent can't talk its way past it.

| An agent **can** | An agent **can't** |
|---|---|
| Ask for any review and read every finding | Turn running code on. There is no tool for it. `allow-run` is a terminal command, and the server only reads its result. |
| Ask for `prove` or `look`, once you allowed them | Choose a command to run. The test command comes from the project's manifest or what you typed, never from a request. |
| Dismiss a **hint** or a **corroborated** finding | Dismiss a **proven** one. `finding_resolve` refuses; you run `assay resolve`. |
| Report claims as a reviewer | Claim proof. Anything a claim calls a failing test is kept as its reading and marked `[unverified]`. |
| Pass `pages` to `look` | Point it anywhere but a path on the local server. Anything with a scheme, starting with `//`, or containing a backslash is refused. |
| Read what the project remembers (`memory`) | Add, switch off, forget or import anything. There is one tool and it only reads: a person does the rest, so an agent can't mute a check it dislikes or teach Assay a pattern. |

## The evidence gate (`finding_submit`)

For agents that review as one reviewer among several (or for a model you point at a diff), `finding_submit` takes claims and decides what they are worth:

```json
{
  "case": "c-9d03b7f-5c1e0aa",
  "reviewer": "Security",
  "claims": [
    { "title": "The prop reaches innerHTML unescaped", "lens": "Security",
      "file": "src/view.tsx", "line": 12, "what": "html comes from the page and is inserted as markup." }
  ]
}
```

- A claim must cite a **file and a line inside the diff** of that case. Otherwise it is **dropped** (`no-location`, `outside-diff` or `empty`), and the case remembers what was dropped.
- A claim that lands within 3 lines of an existing finding **adds a second source** to it. Two independent sources corroborate: a hint can become corroborated.
- A claim elsewhere becomes a **new hint**. Two different reviewers agreeing on a line corroborate each other.
- Whatever severity a claim asks for, it is a hint (or corroborated) and **can't block**. Only proof blocks, and only Assay produces proof.

The [reviewer panel](REVIEWERS.md) calls this through each reviewer's `done` signal and keeps count of what the gate did with each reviewer's claims.

## Permissions and what runs

Reading (`case_open`, `finding_get`, …) runs nothing from your project. `prove` and `look` run your tests, dev server and a browser, in clean copies under `~/.assay/work`, only in repositories you allowed. [The full threat model →](../SECURITY.md)

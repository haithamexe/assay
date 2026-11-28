# Documentation

Back to the [README](../README.md).

## Using Assay

| | |
|---|---|
| [Getting started](GETTING-STARTED.md) | Install, your first review, proof, browser checks, the MCP server, CI |
| [Usage](USAGE.md) | Every command and flag, ranges, exit codes, environment |
| [Project mode](PROJECT-MODE.md) | `assay checkup`: the project as it is rather than a change, what is new since the last checkup, the HAR, flow and OpenAPI inputs, and the JSON contract for other tools |
| [Dashboard](DASHBOARD.md) | The screens, what each button does, how it is kept safe |
| [Calibration](CALIBRATION.md) | Planting known bugs to score the free checks and each reviewer; leaving out a reviewer that earns nothing |
| [Reviewers](REVIEWERS.md) | The reviewer panel: who is worth running, the cost first, blind briefs, cross-examination, the Stop hook |
| [Memory](MEMORY.md) | Mistakes it has seen before, standards packs, learning from your own fix commits, what expires |
| [Troubleshooting](TROUBLESHOOTING.md) | When it says it can't, or the answer looks wrong |
| [MCP guide](MCP.md) | The tools, what an agent can and can't do, the evidence gate |

## Understanding it

| | |
|---|---|
| [How it works](HOW-IT-WORKS.md) | Evidence, tiers, the verdict, the pipeline, proof, the browser, what it costs, what it can't do |
| [Checks](CHECKS.md) | Every check and rule, with its tier, severity and the tests behind it |
| [Security](../SECURITY.md) | What runs, what can't be made to run, how to report a problem |

## Working on it

| | |
|---|---|
| [Architecture](ARCHITECTURE.md) | Packages, data model, state on disk, the flows |
| [Contributing](../CONTRIBUTING.md) | Build, test, add a check, the calibration rule |
| [Design](../DESIGN.md) | The design system and the rules every screen follows |
| [Charter](PROJECT.md) | Principles, phases, decisions and where it stands: the living plan |
| [Changelog](../CHANGELOG.md) | |

## The demo

[`demo/index.html`](../demo/index.html) is the clickable demo the dashboard was built from (sample data: nothing in it was measured). `npm run dashboard:demo` opens the real dashboard on a sample project. [`demo/sample-report.html`](../demo/sample-report.html) and [`demo/sample-look-report.html`](../demo/sample-look-report.html) are real reports produced by Assay on fixture repositories. `npm run samples` rebuilds them.

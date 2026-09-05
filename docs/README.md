---
title: "Documentation Index"
keywords: [docs, index, workflows, architecture, testing, publishing, runtime]
---

# Documentation

Reference docs for the pi-subagentura project. The `docs/` directory is
maintained in this repository and is the documentation source of truth;
[`pi-docs`](https://github.com/lmn451/pi-docs) indexes these files for its
published injector.

| Doc                                                                                | Purpose                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [README.md](../README.md)                                                          | Installation, configuration, tools, and user-facing behavior           |
| [architecture.md](../architecture.md)                                              | Runtime boundaries, ownership, completion, and persistence contracts   |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                                              | Development checks, CI, and release procedure                          |
| [bun.md](./bun.md)                                                                 | JavaScript runtime and package manager conventions                     |
| [publish.md](./publish.md)                                                         | OIDC publishing and the authoritative release procedure                |
| [terminal-e2e.md](./terminal-e2e.md)                                               | Terminal E2E harness, determinism rules, and recording tools           |
| [workflows.md](./workflows.md)                                                     | Workflow execution and bundled script usage                            |
| [interactive-subagent-test-isolation.md](./interactive-subagent-test-isolation.md) | Isolating test sessions, artifacts, environment, and terminal adapters |

## Known limitations

Interactive lineage bootstrap credentials expire 60 seconds after the parent creates them. If child startup takes longer, the child pane remains usable, but recursive `subagent_interactive` spawning is unavailable for that session. Start a fresh child session or respawn the child to recover; no automatic retry occurs.

## Workflow scripts in `examples/workflows/`

These are `.mjs` workflow files under `examples/workflows/` invoked via the `workflow` tool:

```
skill-to-workflow.mjs               Generic: Pi skill → workflow script
package-to-skill.mjs                Generic: Pi package source → pure skill
ralplan-consensus.mjs               pi-ralplan consensus pipeline
ralplan-occ.mjs                     oh-my-claudecode RALPLAN with gate + deliberate mode
ralplan-from-skill.mjs               Demo output of skill-to-workflow
```

The `skills/ralplan/` directory is the demo output of `package-to-skill.mjs` — a complete installable skill.

See [workflows.md](./workflows.md) for current workflow behavior and script guidance.

## Doc injection

The separately published `pi-docs` injector indexes this directory. Keep each document’s YAML frontmatter `title` and `keywords` aligned with its current content so the relevant guidance can be found.

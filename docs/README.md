---
title: "Documentation Index"
keywords: [docs, index, workflows, code-review, publishing, runtime]
---

# Documentation

Reference docs for the pi-subagentura project.

| Doc                                                        | Purpose                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| [bun.md](./bun.md)                                         | JavaScript runtime and package manager conventions                      |
| [publish.md](./publish.md)                                 | npm release process via OIDC trusted publisher                          |
| [terminal-e2e.md](./terminal-e2e.md)                       | Terminal E2E harness: how to run it, determinism rules, recording tools |
| [workflows.md](./workflows.md)                             | Workflow scripts shipped in the repo (consensus pipelines + converters) |
| [interactive-tmux-review.md](./interactive-tmux-review.md) | Code review of `src/interactive-tmux.ts` via GLM-5.2                    |

## Known limitations

Interactive lineage bootstrap credentials expire 60 seconds after the parent creates them. If child startup takes longer, the child pane remains usable, but recursive `subagent_interactive` spawning is unavailable for that session. Start a fresh child session or respawn the child to recover; no automatic retry occurs.

## Workflow scripts in `examples/workflows/`

These are `.mjs` workflow files under `examples/workflows/` invoked via the `workflow` tool:

```
skill-to-workflow.mjs       (12 KB)  Generic: Pi skill → workflow script
package-to-skill.mjs       (12 KB)  Generic: Pi package source → pure skill
ralplan-consensus.mjs       (23 KB)  pi-ralplan consensus pipeline
ralplan-occ.mjs             (56 KB)  oh-my-claudecode RALPLAN with gate + deliberate mode
ralplan-from-skill.mjs      (28 KB)  Demo output of skill-to-workflow
```

The `skills/ralplan/` directory is the demo output of `package-to-skill.mjs` — a complete installable skill.

See [workflows.md](./workflows.md) for usage and the workflow-tool pitfalls we hit while building them.

## Code review artifacts

The interactive subagent code review on 2026-06-18 surfaced 3 High-priority bugs in `src/interactive-tmux.ts`, 5 Medium, and 6 Low. All findings are unfixed.

See [interactive-tmux-review.md](./interactive-tmux-review.md) for the full report with file:line citations, bash reproductions for H2/H3, and recommended test cases.

## Doc injection

The `pi-doc-injector` extension (separate package) reads this `docs/` folder and injects relevant docs into the LLM context based on streaming keyword matches. Each doc needs YAML frontmatter with `title` + `keywords`. Use `keywords: [...]` to bias which LLM queries surface which doc.

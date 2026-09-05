# Workflow Tool — Design Doc (Phase 2)

> Historical Phase 2 design note. The current implementation tracks both
> background and synchronous workflow executions through `startWorkflowJob`; the
> synchronous path awaits that job and streams progress through `onUpdate`.

## Overview

The workflow tool orchestrates sub-agents at scale via a JavaScript script that runs
in a Worker thread. It ports Claude Code's dynamic workflow model into
pi-subagentura: workflows are reusable, async by default, and each `agent()`
call defaults to an attachable tmux/zellij-backed sub-agent when a multiplexer
is available.

**Phase 2 scope:** async-by-default execution, process isolation as the default
for workflow sub-agents, and slash commands for creating/running workflows.

## Command UX

| Command            | Purpose                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/workflow <task>` | Ask the parent agent to create a reusable workflow script for the task, save it with `save_workflow`, and immediately run it with the `workflow` tool. |
| `/workflows`       | List saved workflows, let the user select one, optionally collect JSON args, and run the selected workflow.                                            |
| `/list-workflows`  | Alias for `/workflows`.                                                                                                                                |
| `/workflow-status` | Show running/completed workflow jobs from `workflowJobRegistry`: id, name, status, agents, errors, tokens, phase, elapsed time.                        |
| `/workflow-tree`   | Open an interactive overlay to drill into workflow jobs, expand/collapse details, and cancel a selected running workflow.                              |

`/workflow <task>` is intentionally a prompt bridge. The extension does not
hard-code a generator model or a fixed template; it asks the active parent agent
to synthesize the right workflow, save it, and run it. This keeps workflow
creation flexible while the actual execution still goes through the deterministic
`workflow` tool runtime.

## Key Decisions

| Decision                | Choice                                 | Rationale                                                                                       |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Sync vs Async           | Async by default; sync explicit opt-in | Workflows are long-running; blocking the agent makes no sense. Claude Code is always async.     |
| Default agent isolation | Process (tmux/zellij)                  | Attachable, debuggable, same UX as Claude Code. In-process fallback when no mux exists.         |
| Saved workflow UX       | `/workflows` + `/list-workflows`       | These names should mean saved reusable workflows, not job status.                               |
| Job status UX           | `/workflow-status`                     | Avoids overloading `/workflows`; status remains available without breaking tools.               |
| TUI scope               | Footer/widget plus interactive overlay | Full clickable mouse UI is deferred, but keyboard drill-down and cancel controls are available. |

## Architecture

```mermaid
graph TD
    A[User runs /workflow task] --> B[Parent agent drafts workflow script]
    B --> C[save_workflow]
    C --> D[workflow by saved name]
    E[User runs /workflows] --> F[Select saved workflow]
    F --> D
    D --> G{async param?}
    G -- default true --> H[startWorkflowJob (async)]
    G -- explicit false --> I[startWorkflowJob (sync; await promise)]
    H --> J[WorkflowJobState in registry]
    I --> J
    K[User runs /workflow-status] --> J
    D --> L[agent() inside workflow]
    L --> M{isolation param?}
    M -- unset/default process --> N[launchInteractiveSubagent]
    N -- tmux/zellij ok --> O[awaitInteractiveResult]
    N -- NoMultiplexerAvailable --> P[in-process startSubagentJob]
    M -- in-process opt-out --> P
    P --> Q[SubagentResult]
    O --> Q
```

## Runtime behavior

1. **`async` defaults to `true`**

   - `workflow({ script })` spawns a background job and returns a `workflowId`.
   - `workflow({ script, async: false })` still blocks and streams progress.

2. **`agent()` defaults to process isolation**

   - If `isolation` is omitted, the workflow runtime passes `"process"`.
   - `makeRunAgent` tries tmux/zellij via `launchInteractiveSubagent()`.
   - If no multiplexer is available, it logs a warning and falls back to the
     in-process sub-agent path.
   - `isolation: "in-process"` remains the explicit opt-out.

3. **Saved workflows remain tool-compatible**
   - `save_workflow`, `list_workflows`, and `workflow({ name })` remain the
     machine-callable API.
   - `/workflows` and `/list-workflows` are user-facing command wrappers around
     the same saved workflow store.

## File Changes

| File                      | Change                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow-tool.ts`    | Add `/workflow`, `/workflows`, `/list-workflows`, `/workflow-status`, `/workflow-tree`; keep async default; run selected saved workflows. |
| `src/workflow-worker.ts`  | Normalize omitted `agent()` isolation to `"process"`.                                                                                     |
| `src/workflow-jobs.ts`    | Preserve latest phase/log/agent-start/agent-done message in each workflow snapshot for status UI.                                         |
| `src/artifact-poller.ts`  | Paint workflow footer/status widget and cap workflow rows.                                                                                |
| `src/workflow-tree-ui.ts` | Interactive workflow tree overlay with expand/collapse and cancel controls.                                                               |
| `src/subagent.ts`         | No changes; it already calls `registerWorkflowTool`.                                                                                      |
| `src/multiplexer.ts`      | No changes; tmux/zellij detection and fallback already exist.                                                                             |

## UI Polish Status

Done:

- Footer badge: `⚡ N workflow(s) running`.
- Below-editor workflow summary widget with workflow id, agent counts, tokens, elapsed time, phase, and latest event.
- Widget row caps for both interactive sub-agent activity and workflow activity.
- `/workflow-status` textual status command for full running/completed job details.
- `/workflow-tree` overlay with keyboard drill-down and cancel controls.

Deferred:

- Pause/resume or restart individual workflow agents.
- Mouse-clickable controls directly on workflow widget rows.
- Stronger progress-event coalescing/rate limiting for very large sync fan-outs.
- Full per-agent tool-call history tree beyond the current phase/latest-event summary.

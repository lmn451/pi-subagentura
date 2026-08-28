# pi-subagentura

[![npm](https://img.shields.io/npm/v/pi-subagentura?label=npm)](https://npmjs.com/package/pi-subagentura) [![GitHub](https://img.shields.io/github/v/tag/lmn451/pi-subagentura?label=github)](https://github.com/lmn451/pi-subagentura)

> **Docs ownership:** this repository is the source of truth for `docs/`.
> [`pi-docs`](https://github.com/lmn451/pi-docs) is the separately published doc
> injector that can index these files; it does not manage or sync them.

Give the parent Pi agent one task and let it build the team. pi-subagentura adds
reusable multi-agent workflows, lightweight background delegation, and real
child Pi sessions you can watch, attach to, and continue in tmux or Zellij.

For routing-first delegation, start Pi with `--orchestratorv2`. The prompt
guides the parent to route clear work to attachable interactive subagents, ask
for clarification when a request is ambiguous or a narrow request has no matching
child, and leave specialist repository work to those children. Compatibility
workflow and in-process tools remain registered.

For reusable workflows, start Pi with the bundled orchestration guidance and
describe the outcome you want. The parent can turn that request into a saved
workflow, run its agents in the background, and keep their intermediate results
out of the parent context.

## Installation

See [CHANGELOG.md](./CHANGELOG.md) for breaking changes between major versions.

Install globally:

```bash
pi install npm:pi-subagentura
```

Install for just the current project:

```bash
pi install -l npm:pi-subagentura
```

Try it for a single run without installing:

```bash
pi -e npm:pi-subagentura
```

You can also install directly from GitHub:

```bash
pi install git:github.com/lmn451/pi-subagentura
```

## Quick start

For routing-first interactive delegation:

```text
pi --orchestratorv2
Review the authentication layer across the API and database boundaries.
```

The parent routes work to attachable interactive subagents and asks for
clarification when a request is ambiguous or a narrow request has no matching
child. For reusable workflows, use the workflow-oriented `--orchestrator` mode:

```text
pi --orchestrator
/workflow review the authentication layer
/workflows
/workflow-tree
```

`/workflow` asks the parent to create, save, and immediately run a reusable
workflow. `/workflows` runs saved workflows, and `/workflow-tree` shows live
phases, agents, and cancellation controls.

## Reusable workflows

Workflow files are ordinary `.mjs` scripts with static metadata and a small set
of injected orchestration primitives:

- `agent()` runs an isolated role with optional schema validation, persona,
  model, thinking level, phase label, and process/in-process isolation.
- `parallel()` starts independent agent thunks concurrently and waits at a
  barrier before continuing.
- `pipeline()` streams each item through a sequence of stages without waiting
  for every item to finish a stage first.
- `phase()` names progress in the TUI. Saved workflows may call another saved
  workflow with `workflow(name, args)`, with one level of nesting.

Execution is async by default: the tool returns a workflow id while Pi remains
usable, with status and results available through the UI, slash commands, and
agent tools. Workflow agents default to separate Pi processes in tmux or
Zellij, so they are observable and attachable; when no multiplexer is
available, the runtime falls back to in-process execution. Intermediate agent
results stay in workflow variables outside the parent model context. Only the
workflow completion enters coordinated parent delivery; the retained final
result is available through `get_workflow_result`.

Workflow scripts are trusted agent-authored JavaScript. The VM improves
determinism but is not a security boundary, so never run untrusted JavaScript.
Background workflow jobs are scoped to the current parent session and are
cancelled by reload, resume, quit, or a new session. Attachable interactive
sub-agents use durable artifacts and can survive those boundaries.

See the [workflow guide](./docs/workflows.md) and
[bundled examples](./examples/workflows/README.md).

## Why use it?

- Route work to attachable interactive specialists with `--orchestratorv2`
- Resume interactive artifacts, routing state, pending deliveries, and receipts
  within the matching parent session; delivery is bounded and at-least-once,
  while in-process jobs and background workflows remain session-scoped
- Watch a real child Pi session and its tool activity live in tmux or zellij
- Supervise a bounded recursive tree of interactive children and grandchildren
- Focus or capture a descendant pane locally, or attach from another terminal
- Inspect bounded lifecycle, recent-event, and output previews without leaving Pi
- Continue true follow-up turns without losing the child's model context
- Inspect durable per-turn outputs and lifecycle events after detach or restart
- Run lightweight sub-agents in-process or in the background
- Compare context-aware and isolated reasoning
- Poll, collect, or cancel background jobs on demand
- Build reusable review, research, migration, and conversion workflows
- Use bundled orchestration defaults for scout/plan, oracle checks, parallel review, and review loops

## User commands

These commands are intended for people at the Pi prompt.

| Command             | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `/workflow`         | Create, save, and run a reusable workflow from a task             |
| `/workflows`        | Select and run a saved workflow                                   |
| `/list-workflows`   | Alias for `/workflows`                                            |
| `/workflow-status`  | List workflow jobs and their live or terminal status              |
| `/workflow-tree`    | Open the specialized workflow progress tree                       |
| `/subagents`        | Supervise all async work (`Ctrl+Alt+A`)                           |
| `/delete-workflow`  | Delete a saved workflow by name or picker                         |
| `/cancel-all-flows` | Cancel active jobs, workflows, and running interactive sub-agents |

## Agent-facing tools

The extension registers these public tools for parent agents.

| Tool                                    | Purpose                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| `workflow`                              | Run a trusted workflow script or saved workflow                   |
| `save_workflow`                         | Validate and save a reusable workflow                             |
| `list_workflows`                        | List saved workflows                                              |
| `delete_workflow`                       | Delete a saved workflow                                           |
| `get_workflow_status`                   | Inspect a background workflow                                     |
| `get_workflow_result`                   | Wait for and return a workflow result                             |
| `cancel_workflow`                       | Cancel a background workflow                                      |
| `subagent_with_context`                 | Delegate with the parent conversation                             |
| `subagent_isolated`                     | Delegate with a fresh context                                     |
| `get_subagent_status`                   | Inspect an async in-process job                                   |
| `get_subagent_result`                   | Retrieve current or final async job output                        |
| `cancel_subagent`                       | Cancel an async job                                               |
| `prune_subagent_jobs`                   | Remove completed and failed jobs                                  |
| `list_available_models`                 | List configured model identifiers                                 |
| `list_orchestrator_agents`              | List bounded Orchestratorv2 routing metadata and runtime pointers |
| `update_orchestrator_agent_description` | Update a child's confirmed routing description and aliases        |
| `subagent_interactive`                  | Launch an attachable Pi session in tmux/Zellij                    |
| `get_interactive_subagent_status`       | Inspect attachable child sessions                                 |
| `recover_interactive_subagent`          | Confirm and rebind a persisted direct child whose pane is dead    |
| `cancel_interactive_subagent`           | Kill an attachable child pane                                     |
| `send_interactive_subagent_message`     | Send a follow-up while preserving child context                   |
| `list_subagent_artifacts`               | List durable interactive-agent artifacts                          |
| `read_subagent_artifact`                | Read lifecycle events and output snapshots                        |
| `cleanup_subagent_artifacts`            | Remove expired artifact directories and stale registry entries    |

## How it compares with other Pi sub-agent extensions

There is no single best extension; the useful distinction is what kind of
control you want after delegation. This table compares the most widely used Pi
sub-agent extensions as of July 2026, based on their published documentation.

| Extension                                                                                | Strongest fit                                                        | Pros                                                                                                                                                                                                                                                                             | Cons / tradeoffs                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pi-subagentura**                                                                       | Work you may want to watch, attach to, or continue interactively     | Combines lightweight in-process jobs with real child Pi sessions; recursive supervisor with focus, bounded capture, and subtree cancellation; tmux/Zellij attach; mid-session follow-ups; durable per-turn artifacts; parent restart/reload rehydration; bounded workflow runner | Interactive mode requires tmux or Zellij and starts another process; in-process jobs and workflows do not survive parent-session replacement; workflow JavaScript is trusted code, not a security sandbox; smaller community than the alternatives below |
| [`@adamjen/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents) | Fully asynchronous, multiplexer-native agent workflows               | Dedicated panes in cmux, tmux, Zellij, or WezTerm; live status widget; interruption and session resume; custom agents; child-to-parent help requests; bundled `/plan` and `/iterate` workflows                                                                                   | Child-process/multiplexer-only design with no lightweight in-process path; its help-request flow exits and later resumes the child; no documented immutable per-turn output and durable delivery-receipt protocol comparable to pi-subagentura's         |
| [`pi-subagents`](https://github.com/nicobailon/pi-subagents)                             | Feature-rich orchestration and automated multi-step coding workflows | Large built-in agent/workflow set; foreground and background runs; chains, parallel groups, worktrees, lifecycle artifacts, fleet UI, watchdog review, supervisor messaging, and nested delegation                                                                               | Much larger configuration and tool surface; more concepts to learn; does not provide an attachable terminal session—the fleet view is an inspector inside Pi                                                                                             |
| [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)                   | Claude Code-style sub-agents inside Pi                               | Polished live widget and FleetView; foreground/background execution; steering and resume; custom agent definitions; worktree isolation; scheduling; model/tool/extension controls                                                                                                | Broad feature/configuration surface; UI and control stay inside the parent Pi experience rather than exposing a normal attachable child terminal; persistent sessions/artifacts are optional rather than the default source of truth                     |
| [`@mjakl/pi-subagent`](https://github.com/mjakl/pi-subagent)                             | A small, predictable delegation primitive                            | Simple tool shape; fresh or parent-seeded context; parallel calls; named persistent sessions; depth/cycle guards; rich streaming TUI                                                                                                                                             | Fewer orchestration features; no background job manager or durable event protocol; no live attachable pane; a stale persistent-session lock can require manual cleanup after a killed process                                                            |

If you want multiplexer-native async agents with broader terminal support, try
`@adamjen/pi-interactive-subagents`. If you want the broadest orchestration
toolbox, start with `pi-subagents`. If you want a Claude Code-like UI, try
`@tintinweb/pi-subagents`. If you want the smallest conventional child-process
implementation, try `@mjakl/pi-subagent`. pi-subagentura is for the narrower
case where a delegated agent should remain a real session you can observe and
re-enter, while still offering cheap in-process delegation for short tasks.

### Adjacent coding-agent implementations

These are not Pi extensions, so the comparison is secondary. They are useful
reference points for the interaction model.

| Tool                                                                | Pros                                                                                                                                                                     | Cons / difference from pi-subagentura                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | Mature built-in delegation; foreground/background execution; custom prompts, models, tools, permissions, and skills; context forking; automatic or explicit routing      | Subagents are normally task workers that return results to the parent; they cannot spawn subagents; direct multi-session collaboration is a separate agent-teams feature; no tmux/Zellij attach-and-rehydrate protocol |
| [Codex subagents](https://developers.openai.com/codex/)             | First-class agent threads in the app, CLI, and IDE; inspect, steer, interrupt, and switch threads; custom agent configurations; bounded nesting and concurrency controls | Part of the Codex product rather than a portable Pi extension; delegation can consume substantially more tokens; no artifact contract designed for attaching to a normal child terminal process                        |
| [OpenCode agents](https://opencode.ai/docs/agents/)                 | Simple primary/subagent model; automatic or explicit `@` invocation; custom prompts, models, tools, and permissions; built-in parent/child session navigation            | Navigation stays inside OpenCode's session UI; no separate attachable mux pane or pi-subagentura-compatible durable artifact/delivery protocol                                                                         |

![Sub-agent demo](working.png)

## Bundled orchestration defaults

The package also ships parent-only orchestration guidance for common multi-agent workflows in `ORCHESTRATOR_SYSTEM_PROMPT.md`. Enable it with the extension's `--orchestrator` flag:

```bash
pi --orchestrator
```

The guidance gives the parent agent reasonable default behavior when the user asks for things like:

- “review this codebase” — inspect first, then run fresh-context reviewers with focused angles
- “review my changes” — use read-only reviewers, synthesize findings, and only edit when authorized
- “plan this work” — scout relevant files, then produce a concrete implementation plan
- “check my approach” — run a context-aware oracle to challenge assumptions and drift
- “implement and review” — use one writer, parallel reviewers, and capped fix/review rounds

The defaults prefer async `subagent_isolated` for fresh scouts/reviewers,
`subagent_with_context` for oracle checks, coordinated reference manifests
instead of polling or full-output injection, and one writer at a time for
implementation. Asynchronous completion defaults to `completionPolicy: "each"`:
each terminal record becomes immediately eligible, while records that finish
while the parent is busy coalesce into a safe-idle continuation. Related work
uses an explicit `completionPolicy: "group"` and caller-declared
`completionGroupId`; relatedness is never inferred from being launched in the
same turn or from task text. For cheap fan-out, the guidance suggests
validating model availability before using optional model overrides.

### Orchestratorv2 thin-router mode

Enable the separate prompt-directed thin router with:

```bash
pi --orchestratorv2
```

This flag appends `ORCHESTRATOR_V2_SYSTEM_PROMPT.md`; it does not select or
verify the parent model and does not enforce a host-level tool allowlist. Select
the intended lightweight model separately, and do not enable
`--orchestrator` and `--orchestratorv2` together. Normal workflow and in-process
tools remain registered for compatibility, while the Orchestratorv2 prompt
directs the parent to delegate only through attachable interactive children and
use the parent session's authoritative routing ledger together with the
project-local routing cache.

The v2 prompt gives the parent a lightweight routing role: it routes clear work
to attachable interactive subagents, can split broad requests across specialists,
and asks for clarification when a request is ambiguous or a narrow request has no
matching child. The parent is instructed to leave specialist repository work to
those children; this is prompt guidance, not an enforced routing boundary.

For interactive children in the matching parent session, artifacts, routing state,
pending deliveries, and receipts persist and rehydrate across same-session
restart, reload, and resume paths. Delivery is bounded and at-least-once; in-process
jobs and background workflows remain session-scoped.

Orchestratorv2 adds exactly two routing-metadata tools:
`list_orchestrator_agents` and `update_orchestrator_agent_description`.
Confirmed records include explicit `provenance`: `user` or `orchestratorv2`.
Responsibility updates use a server-issued, single-use confirmation token bound
to the exact payload, current session generation, and a later user message; a
model-supplied `confirmed: true` is not sufficient by itself.

The parent session's current branch is the authority ledger. Every approved
top-level spawn and confirmed update persists the bounded project-local record
first, then appends an exact versioned parent custom entry. On reload/resume,
the latest valid authority entry for each child is selected by physical branch
order. Those parent entries are the sole trusted/actionable source; the project
file is only untrusted cache/proposal data and may be missing, stale, malformed,
or over capacity. Cache-only or mismatched rows may be shown as non-actionable
diagnostics, but they never gate actionability, capacity, confirmation CAS, or
repair writes. Missing cache rows do not erase valid parent authority.

When no valid parent authority exists, cache metadata remains visible only as
non-actionable metadata with a closed-enum untrusted reason. Approved writes
rebuild the cache from the latest parent authority plus the incoming record, so
forged cache rows cannot consume the 128-record capacity or become
authoritative.

The parent-entry ledger is an application-level boundary, not an OS security
boundary: a same-UID process that can tamper with the parent session file can
forge parent entries. This limitation is intentional and documented; the
ledger does not claim to defend against arbitrary same-UID session-file
tampering. Routing metadata is never a lifecycle registry or semantic resolver.

The interactive runtime launches before its initial routing metadata is
persisted. If persistence fails, the child intentionally remains live and the
spawn result includes an explicit warning; the extension does not cancel, roll
back, replace, or respawn that child. Capacity exhaustion fails closed without
evicting or deleting metadata.

Interactive children retain `subagent_interactive` and may autonomously create
nested children without top-level approval. Nested children belong to the
immediate child session and are not automatically actionable in the top-level
Orchestratorv2 routing registry; their important outcomes return through that
child or the existing artifact and notification paths.

## Workflow child lifecycle and recovery

Workflow `agent()` calls dispose their process-backed child after consuming its
result by default. Opt in only when the preserved model context is useful:

```js
const report = await agent("Review the lifecycle code", {
  label: "lifecycle-reviewer",
  reusable: true,
});
```

`reusable: true` requires process isolation, a live parent session, and no
`schema` option. It retains a successful child for at most 30 minutes after
result consumption, with at most 32 opted-in workflow children per parent
session. A reusable launch fails rather than silently falling back to an
in-process agent, because in-process context cannot be promoted safely. Schema
retries are rejected because retaining discarded attempts would leak panes and
ambiguous context.

The state flow is: **spawn → running → workflow complete → idle/reusable →
standalone follow-up or dispose**. The workflow result and an idle pane are both
required before reuse. `send_interactive_subagent_message` must name the exact
child ID; only a successful send promotes it to standalone. Until then the child
remains workflow-owned. Expiry, explicit cancellation, or a parent-session
transition disposes it. The async supervisor shows this state plus workflow name,
task, owner/lineage, same-workflow siblings, retention deadline, and recovery
caveats.

Liveness never grants routing authority. A workflow child may be attachable for
inspection while remaining non-actionable to Orchestratorv2. Even when it is
idle/reusable, automatic routing stays disabled. The explicit child-ID follow-up
promotes it; normal authorized routing metadata rules then apply.

### Rehydration matrix

| Runtime kind                         | startup / reload / resume                                                            | quit then matching-session restart                                           | new/fork                                 | crash/orphan boundary                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct interactive sub-agent         | Persisted state, lifecycle cursors, delivery state, and matching ownership rehydrate | Pane/state are preserved and rehydrate when `parentSessionId` matches        | Killed and intentionally not restored    | A surviving pane can be recovered from its persisted direct-interactive state; unknown liveness remains non-actionable                             |
| Reusable workflow process child      | Killed on session replacement; runtime-only workflow ownership is not rehydrated     | Not restored, even if the mux pane physically outlives an abrupt parent exit | Killed and intentionally not restored    | A surviving pane/lineage record is a crash/orphan diagnostic only; it does not regain workflow reuse, delivery, cancellation, or routing authority |
| In-process job / background workflow | Cancelled and removed with the owning session generation                             | Not restored                                                                 | Cancelled and intentionally not restored | Process-memory state is lost; no job/workflow ownership is reconstructed                                                                           |

`startup`, `reload`, and `resume` rehydrate only persisted direct interactive
state for the matching parent session. `quit` preserves direct panes/state for a
later matching-session startup. `new/fork` is always a clean boundary. Workflow
children deliberately omit `parentSessionId` persistence, so cross-session
workflow reuse remains disabled until durable ownership, delivery, promotion,
and cancellation state can be recovered together.

## Cancellation context snapshots (opt-in)

Cancellation snapshots are **disabled by default**. To enable bounded snapshots before parent-initiated cancellation, set:

```bash
SUBAGENT_CANCEL_SNAPSHOT=full pi
```

In-process sub-agents write a private atomic JSON snapshot of the canonical active branch plus bounded partial streaming state. Interactive/process sub-agents write a private manifest that points to their already-persisted Pi session JSONL and artifact files; the transcript is not duplicated. Cancellation results expose receipt paths and errors, never snapshot contents.

Optional configuration:

- `SUBAGENT_CANCEL_SNAPSHOT_DIR` — override the private snapshot root. The directory and files are created with `0700`/`0600` permissions.
- `SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES` — maximum raw in-process snapshot size. The default is `1048576` bytes (1 MiB); accepted values range from `4096` bytes to `16777216` bytes (16 MiB). Invalid values use the default. Oversized snapshots preserve as much context as fits and record explicit truncation/error metadata.

Snapshots use schema version 1, temp-file + rename writes, deterministic per-session/job paths, and idempotent receipts so overlapping cancellation and shutdown paths do not duplicate files. They may contain sensitive prompts, tool arguments, and model output; keep the snapshot directory private and do not commit it.

## Tools

### `subagent_with_context`

Starts a sub-agent with the current conversation history included in its prompt.

Parameters:

- `task` — required task for the sub-agent
- `persona` — optional system-style persona
- `model` — optional model override like `anthropic/claude-sonnet-4-5`
- `cwd` — optional working directory override
- `async` — run in background; returns a jobId immediately instead of blocking
- `completionPolicy` — async completion coordination: `"each"` (default) or `"group"`; `"each"` makes records independently eligible, while `"group"` waits for an explicit barrier
- `completionGroupId` — caller-declared named group ID required with `completionPolicy: "group"`; safe 1–128 character ID shared by related jobs (max 32 members per group, 512 groups per parent session)
- `notifyOnComplete` — deprecated compatibility input; any value maps to coordinated `"each"` delivery with no full-output injection
- `triggerTurnOnComplete` — deprecated compatibility input; coordinated `"each"` timing and human priority remain authoritative
- `maxAge` — optional TTL in ms for completed job retention (async only)

Deprecated compatibility fields cannot be combined with `completionPolicy` or
`completionGroupId`; `completionGroupId` is valid only with `completionPolicy: "group"`.

Best for:

- review tasks that depend on prior discussion
- continuing a line of reasoning in parallel
- focused implementation or research using the current context
- background side-quests that report results later

### `subagent_isolated`

Starts a sub-agent with no inherited conversation history.

Parameters:

- `task` — required task for the sub-agent
- `persona` — optional system-style persona
- `model` — optional model override like `anthropic/claude-sonnet-4-5`
- `cwd` — optional working directory override
- `async` — run in background; returns a jobId immediately instead of blocking
- `completionPolicy` — async completion coordination: `"each"` (default) or `"group"`; `"each"` makes records independently eligible, while `"group"` waits for an explicit barrier
- `completionGroupId` — caller-declared named group ID required with `completionPolicy: "group"`; safe 1–128 character ID shared by related jobs (max 32 members per group, 512 groups per parent session)
- `notifyOnComplete` — deprecated compatibility input; any value maps to coordinated `"each"` delivery with no full-output injection
- `triggerTurnOnComplete` — deprecated compatibility input; coordinated `"each"` timing and human priority remain authoritative
- `maxAge` — optional TTL in ms for completed job retention (async only)

Deprecated compatibility fields cannot be combined with `completionPolicy` or
`completionGroupId`; `completionGroupId` is valid only with `completionPolicy: "group"`.
Async spawn results describe the selected coordinated behavior.

Best for:

- second opinions
- clean-room summaries
- avoiding context contamination from the parent session
- background analysis without polluting the main conversation

### Async Workflow Tools

When you spawn a sub-agent with `async: true`, it returns a **jobId**
immediately and runs in the background. The coordinated default is
`completionPolicy: "each"`: terminal records become independently eligible
immediately, and records that finish while the parent is busy coalesce into one
safe-idle continuation rather than a burst of turns. A related group is formed
only when the caller explicitly selects `completionPolicy: "group"` and supplies
a shared `completionGroupId`; same-turn launch or task text never infers a
group. The default reports compact result references rather than injecting full
output, so you usually do not need to poll. Use these tools only when the user
asks for status or explicit collection, when a job appears stuck, or when manual
follow-up is needed:

Background jobs are scoped to the current parent session. This includes both
`async: true` sub-agent jobs and jobs started by the `workflow` tool. They are
cancelled on `/reload`, `/resume`, quit, and `/new`; their in-memory registries
are not rehydrated into the next parent context. Direct interactive sub-agents
are different: their mux panes and artifact-backed registry can survive reloads
and restarts. Workflow-owned process children remain session-scoped as described
in [Workflow child lifecycle and recovery](#workflow-child-lifecycle-and-recovery).

#### `get_subagent_status`

Poll an async subagent job by jobId. Returns a live preview of the subagent's current turn, active tool, and partial output.

Parameters:

- `jobId` — required job ID returned by the async spawn

#### `get_subagent_result`

Retrieve an async subagent job's current or final result and usage summary. A
running job returns immediately unless explicit bounded waiting is requested.
Successfully retrieving a terminal result consumes its pending coordinated
delivery, so it is not sent again automatically.

Parameters:

- `jobId` — required job ID returned by the async spawn
- `wait` — optional; set to `true` to wait for a running job
- `timeoutMs` — optional wait timeout from 1 to 300,000 ms; defaults to 30,000 ms

#### `cancel_subagent`

Abort a running async subagent job by jobId.

Parameters:

- `jobId` — required job ID returned by the async spawn

#### `prune_subagent_jobs`

Remove all completed and failed subagent jobs from the registry. Running and cancelled jobs are preserved.

### Interactive Sub-agent Tools

Observability and attachability are the primary design goals of interactive
sub-agents—not debugging afterthoughts. Each child is a separate Pi process in a
tmux or zellij pane: watch it live, focus it from the current mux, attach from
another terminal, or send follow-ups through the parent while preserving child
context. If the parent is outside a mux, the child starts in a detached session
and returns an attach command. The pane is the live view; durable artifacts are
the source of truth.

#### `subagent_interactive`

Starts a separate interactive `pi` process in a tmux/zellij pane and returns immediately with:

- sub-agent id
- pane id and mux backend (tmux or zellij)
- `attach` command (works from outside the mux session)
- `focus` command (works from inside the same mux session)
- child Pi session file path
- artifact directory (events.ndjson + output.md)
- the window/tab name (in background mode) so you can find it in your mux UI

Parameters:

- `task` — required initial task
- `name` — optional display name for the pane/session
- `persona` — optional system prompt appended to the child session
- `model` — optional model override
- `cwd` — optional working directory
- `includeContext` — context mode selector: `true` serializes the full parent branch; `false` permits an explicit `context`; omitting both fields keeps the legacy independent mode
- `context` — optional explicit handoff when `includeContext: false`; capped at 64 KiB and never concatenated with the parent branch
- `routingDescription` — bounded responsibility persisted for top-level Orchestratorv2 routing; required by Orchestratorv2 policy and rejected outside that top-level mode
- `routingAliases` — optional bounded exact aliases for the responsibility; requires `routingDescription`
- `mux` — optional backend: `"auto"` (default), `"tmux"`, or `"zellij"`. Auto picks the currently attached mux (via ZELLIJ_SESSION_NAME / TMUX env vars) then falls back to whichever backend binary is available. Explicit choice forces that backend.
- `background` — spawn in a detached named window/tab (invisible) instead of a visible horizontal split. Default `true` — your mux layout is undisturbed and you can attach later with the returned `focus` command. Pass `background: false` for a side-by-side split you can watch in real time.
- `completionPolicy` — `"each"` (default) or `"group"`; `"each"` makes records independently eligible, while `"group"` waits for a caller-declared named barrier
- `completionGroupId` — caller-declared named group ID required with `completionPolicy: "group"`; safe 1–128 character ID shared by related agents (max 32 members per group, 512 groups per parent session)
- `notifyOnComplete` — deprecated compatibility input; any value maps to coordinated `"each"` delivery with no full-output injection
- `triggerTurnOnComplete` — deprecated compatibility input; coordinated `"each"` timing and human priority remain authoritative

Deprecated compatibility fields cannot be combined with `completionPolicy` or
`completionGroupId`. The spawn result describes the selected coordinated behavior.

The sub-agent's artifact contains `events.ndjson` lifecycle records, mutable
`output.md` staging, and immutable protocol-v2 `outputs/<eventId>.md` terminal
snapshots. Terminal retrieval uses the immutable snapshot by `turnId`; mutable
output is legacy/staging fallback only. The pane is for live monitoring, and the
artifact survives parent restarts.

A direct interactive sub-agent's **registry state** survives parent reloads and
restarts. When spawned, a per-(cwd) state file is written to
`<cwd>/.pi/subagentura-state.json`. Workflow-owned process children deliberately
do not write this state.

The state file and subagent panes are preserved across these actions:

| Action                                            | State file  | Panes      | Rehydrated next start?                   |
| ------------------------------------------------- | ----------- | ---------- | ---------------------------------------- |
| **Ctrl+D (quit) → restart with `--session`/`-r`** | Kept        | Preserved  | ✅ Same session, parentSessionId matches |
| **Ctrl+D → fresh `pi` (no session)**              | Kept        | Preserved  | ❌ Different session, no match           |
| **`/reload`**                                     | Kept        | Preserved  | ✅ Same session                          |
| **`/resume`** (switch to another session)         | Kept        | Preserved  | ✅ If parentSessionId matches            |
| **`/new`**                                        | **Deleted** | **Killed** | ❌ Clean slate                           |
| **`/fork`**                                       | **Deleted** | **Killed** | ❌ Clean slate                           |

> **Note:** `/new` deletes the state file. If you do `/new` and then `/resume`
> back to the session where subagents were spawned, they **will not reappear**
> — the state file was already deleted. Only `/reload` or a restart with the
> same session (`--session`/`-r`) preserves the registry.

On `/reload` and `/resume`, the `session_start` handler rehydrates
the in-memory registry, filtering by `parentSessionId` so only subagents
created in the current session are restored. Protocol-v2 byte cursors, pending
delivery intents, receipts, coordinated policy, and group membership are
restored. Recovered groups are sealed before polling begins. Parent-session
completion and consumption entries reconcile notices and manifests so reload
does not unconditionally replay already-delivered work.

Implementation details for crash-safe ordering and delivery recovery are in the
[state-file invariants in the source repository](https://github.com/lmn451/pi-subagentura/blob/master/AGENTS.md#rehydrate-state-file-cwdpisubagentura-state-json).

#### Unified async supervisor and recursive children

Run `/subagents` or press `Ctrl+Alt+A` to open the portable async supervisor.
It combines standalone async in-process jobs, workflow jobs and their agent
records, and the persisted lineage of interactive children and grandchildren.
`/workflow-tree` remains available as a specialized workflow-only view.
The supervisor uses a subtle theme-colored dither texture to simulate a dimmed
backdrop behind its modal controls; terminal cells do not support true blur.

Standalone jobs are owner-scoped to the current parent session. Expanding a
workflow shows its recent agent attempts, phases, usage, and bounded omission
counts. Agent records are observational; cancelling the workflow signals its
in-flight agents. Interactive lineage can include descendants created from
different working directories. Interactive
children receive a minimal child runtime that can launch more interactive
children, but does not register in-process or workflow orchestration tools.
Recursion is bounded by default to depth 8 and 256 **live** lineage nodes; the
manifests of exited agents are pruned so a long-lived session's all-time spawn
total never exhausts the budget. The supervisor shows active, actionable work
only. Cancelled, completed, malformed, orphaned, cyclic, and stale entries remain
available through retained artifacts but are hidden from the overlay. A footer
line reports how many nodes were hidden and why, whether the view is truncated,
and whether lineage refresh is failing, so hiding is never silent. Subtree
cancellation walks the raw lineage manifests rather than the displayed tree, so a
descendant past the depth or node cap is still cancelled and reported.

The overlay supports these controls:

| Key                    | Action                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `↑`/`↓`, `j`/`k`       | Select an async job, workflow, or interactive lineage node                                        |
| `Enter`/`→`            | Expand type-specific activity, usage, agent records, or bounded artifact details                  |
| `x`                    | Cancel the selected running item; workflow and in-process cancellation propagates to owned agents |
| `v`                    | For interactive agents, capture a bounded terminal snapshot through tmux/Zellij                   |
| `n`                    | For interactive agents, open the optional native tmux popup or Zellij floating viewer             |
| `f`                    | For interactive agents, focus the persisted pane/window; warns when no client is attached         |
| `a`                    | For interactive agents, show the attach command                                                   |
| `X`                    | For interactive agents, confirm and cancel an actionable subtree deepest-first                    |
| `r`                    | Refresh registries, lineage, and pane liveness                                                    |
| `q`/`Esc`/`Ctrl+Alt+A` | Close the overlay without stopping agents                                                         |

Interactive row prefixes identify whether the item came from the live `[registry]`
or persisted `[lineage]`. Expanding a row shows its owner, root and parent IDs, cwd,
artifact directory, and Pi session file. A cancelled row disappears immediately.

Before pressing `f`, expand the selected interactive row to see its native return
hint. With default keymaps, tmux uses prefix + `;` for a split pane or prefix +
`l` for a detached window. Zellij uses `Ctrl+p`, then `p` for a split pane or
`Ctrl+t`, then `Tab` for a named tab. Customized multiplexer keymaps may differ.

Terminal capture is bounded by both bytes and lines. Expanded interactive
artifact details read only regular files and bound lifecycle-event reads to 8
KiB, output reads to 4 KiB, and displayed previews to 512 characters. Direct
interactive children remain in the root registry, while descendant completion
delivery remains owned by the Pi session that spawned that descendant.
Cancelling a descendant therefore does not inject its completion into the root
session, and cancellation preserves its artifact directory for later inspection.

#### Sub-agent completion protocol

Every interactive child runs protocol-only Pi lifecycle hooks and therefore
requires Pi SDK `>=0.80.6`. `before_agent_start` creates a provisional
turn, the first `turn_start` binds it to the persisted Pi user-entry id, tool
hooks record activity, and `agent_settled` records the authoritative completion
after retries, compaction, and queued continuations. When Pi accepts Enter while
streaming, it treats the message as steering inside the current agent run and
does not emit another `before_agent_start`. The child protocol therefore detects
the newly persisted steering user entry before its provider request and starts a
distinct artifact turn for it. The explicit CLI remains supported:

```bash
$ARTIFACT_DIR/cli.mjs done 0       # success — parent reads the literal output.md path baked into the child prompt
$ARTIFACT_DIR/cli.mjs error "msg"  # unrecoverable failure
# 'cancelled' is only set by the parent via cancel_interactive_subagent
```

The explicit completion command is mandatory for every initial and follow-up
turn. The child must complete these steps in order: write the final result to
`output.md`, run `cli.mjs done 0`, wait until exactly one completion event is
recorded successfully, then send its final assistant response. The command must
be the final tool call of the turn. If it fails to execute, the child must not
finalize; it fixes the failure and retries until completion is recorded. The
child lifecycle hook at `agent_settled` is a crash-safety fallback, not a
substitute for the explicit command. The system prompt, initial task footer,
and every injected follow-up prompt repeat this requirement so the command
remains the model's most recent instruction.

At each child turn start, mutable `output.md` is atomically reset without
touching earlier snapshots. Before each completion event, the current staging
file (including an empty file when the turn wrote nothing) is copied atomically to
`outputs/<eventId>.md` with byte count and SHA-256 metadata. Events are consumed
in physical NDJSON byte order; timestamps are display-only. Mixed v1/v2 logs and
legacy `output-N.md` snapshots remain readable. New legacy completions are
pointer-only because mutable `output.md` cannot be safely attributed to a turn.

Immutable snapshots are limited to 1 MiB. The parent and generated child CLI
check the staging file size before reading it. If `output.md` exceeds the limit,
the completion is still recorded with `outputError.code = "output_too_large"`
and its observed byte count, but no immutable snapshot is created. The
coordinated manifest therefore has no snapshot reference, and legacy injection
cannot load the oversized output. The staging file remains available for manual
inspection in the artifact directory.

#### Coordinated completion delivery

Coordinated delivery is the default for asynchronous in-process jobs,
interactive agents, and background workflows. It separates the human channel
from the parent-model channel:

1. Every parent-visible standalone `done`, `error`, or `cancelled` completion,
   plus every background workflow aggregate completion, appends one deterministic
   `subagentura-completion` entry rendered in the TUI. This entry is excluded
   from LLM context, and event replay does not append it again. Workflow-owned
   child turns remain visible through workflow progress but do not publish
   directly.
2. The parent model receives one bounded, hidden `subagent-manifest` containing
   statuses and references—not child output. Interactive records point to the
   immutable `outputs/<eventId>.md` snapshot when available plus
   `events.ndjson`; legacy artifacts may fall back to mutable `output.md`.
   In-process and workflow records point to `get_subagent_result` and
   `get_workflow_result`.
3. A ready manifest attaches to a pending human-initiated turn when possible.
   Otherwise Pi receives one triggered follow-up after the parent is safely
   idle. Human prompts and steering always take priority.

`completionPolicy` controls readiness:

- `"each"` (default) makes every independent result eligible immediately. Results that finish while the parent is busy are coalesced into one manifest at the next safe-idle dispatch; this is the default independent-delivery behavior.
- `"group"` requires the caller to provide one shared, explicit `completionGroupId`. Same-turn launch and task text do not infer relatedness. Register all members in the intended group before the spawning parent turn settles; settlement seals the group, rejects late members, and blocks model delivery until every registered member is `done`, `error`, or `cancelled`. Per-member TUI notices still appear immediately, and an entirely consumed group does not trigger an empty turn.

A named group is advanced cross-call control. A group supports at most 32 distinct `source:sourceId` members, with at most 512 groups per parent session. `completionGroupId` is 1–128 characters and must match `[A-Za-z0-9][A-Za-z0-9._:-]*`. A source can satisfy a group only once; later turns from the same source/group are delivered independently as `each`.

The completion coordinator owns readiness, group barriers, TUI notice persistence, and compact manifest construction. When an idle manifest is ready, it passes through `sendCompletionTurn` with the actual parent streaming state. Non-v2 modes fall through to Pi's native `sendMessage`; idle Orchestratorv2 uses the lower-level transport to persist a wake request, publish the manifest with its wake identity, and send a synthetic user follow-up so `before_agent_start` installs the thin-router prompt. A streaming parent keeps Pi's native follow-up behavior.

Wake state is process-global because Pi can load delivery and lifecycle extension graphs as separate module instances. The exact synthetic prompt is marked in `before_agent_start`, and only that marked run's `agent_settled` acknowledges the wake; unrelated turns cannot consume it. A missing run start receives at most three wake attempts separated by a 30-second watchdog, while durable acknowledgement writes retry at most three times with a one-second delay. Session replacement and shutdown clear both timers; reload/resume recover only delivered, unacknowledged wakes from the active parent branch.

Successful terminal retrieval through `get_subagent_result`,
`get_workflow_result`, or `read_subagent_artifact` with output consumes the
matching pending record before returning it. Automatic and manual delivery share
the same receipts, so a consumed record is suppressed from normal subsequent
dispatch. This is not an exactly-once delivery guarantee: a crash around parent
dispatch can still replay a manifest as described below.
Workflow-owned process or in-process children never publish directly; only the
background workflow aggregate completion participates in coordinated delivery.

The deprecated `notifyOnComplete` and `triggerTurnOnComplete` fields remain
accepted for compatibility. Either legacy value maps deterministically to
coordinated `"each"`: the notice is TUI-only, the parent receives only compact
references, and policy plus human-priority rules control timing. Combining
either field with `completionPolicy` or `completionGroupId` is rejected.
Persisted pre-coordinator intents may still drain through the bounded legacy
broker during upgrade recovery, but new API calls cannot select full-output
injection.

Direct interactive coordinated policy, group membership, and intents survive
same-session startup/reload/resume through `.pi/subagentura-state.json` and
parent session entries. Consumption receipts prefer those entries and use the
private fallback ledger when needed. Workflow-owned process children, in-process
jobs, and background workflows remain parent-session scoped and are retired on
session replacement. `new` and `fork` do not import prior completion work.

Parent delivery fails closed behind durable notice storage. If `appendEntry`
fails, the notice remains pending and the manifest is withheld; later coordinator
activity retries without a tight loop. If the entry was written before an
exception, session-entry reconciliation prevents a duplicate. Deterministic
identities prevent routine replay, but Pi's synchronous `sendMessage` proves
dispatch rather than durable commit, so a crash in that separate window can still
replay a manifest.

#### Consumption-receipt fallback

Parent session entries are the preferred durable location for consumption
receipts. If the parent cannot append an entry because `appendEntry` is
unavailable or fails, the coordinator appends the receipt beneath the parent
Pi session directory, outside the project working tree. The path is keyed by the
parent session identity and is not shared across sessions. A partial manager
without a session directory uses a random process-private temporary root and
does not claim restart durability.

Readers take a fixed snapshot and enforce total byte, record-count, line,
identifier, and selector bounds. An over-budget or truncated snapshot is ignored
and advances to its end; this deliberately risks a duplicate manifest instead of
letting unchecked file data consume or retire trusted completions. Turn-scoped
receipts require the exact `turnId`, so source-only receipts cannot suppress
later interactive turns. Reconciliation resumes from the bounded high-water
mark for receipts appended afterward.

Session shutdown clears live coordinator state and records lifecycle
retirements: workflow-owned and non-interactive work is retired, while direct
interactive state and receipts remain eligible for same-session reload, resume,
or restart. `/new` and `/fork` also retire direct interactive work and do not
import prior completion work. Cleanup does not truncate or delete protected
fallback ledgers, so old private files can remain after a replacement session
starts.

#### `recover_interactive_subagent`

Recovers a persisted **direct interactive** child after its recorded tmux pane
or Zellij tab is conclusively dead. The tool validates the current parent owner,
runtime and Pi session IDs, JSONL and artifact paths, persisted delivery state,
lineage parent/root, and duplicate runtime pointers before showing a native
Yes/No confirmation. It then creates a replacement pane, reopens the exact Pi
JSONL without submitting a new prompt, renews the same lineage bootstrap, and
rebinds only pane/runtime pointers. The child ID, delivery cursors/receipts,
artifacts, and routing authority are preserved.

This is explicit incident recovery, never automatic startup behavior. Live or
unknown panes, path/owner/lineage mismatches, cancelled children, workflow-origin
children, and in-process/background jobs fail closed. A cross-system crash during
mux/state/lineage rebinding can still leave an empty orphan pane; the packaged
`pi-session-recovery` skill documents non-destructive inspection and manual
conversation-only fallback.

Parameters:

- `id` — persisted direct interactive child ID whose recorded pane is dead

#### `get_interactive_subagent_status`

Lists tracked interactive sub-agents, attach/select commands, and session paths. It intentionally does **not** capture pane output to avoid consuming model context.

Parameters:

- `jobId` — optional interactive sub-agent id; omit it to list all tracked sessions

#### `cancel_interactive_subagent`

Kills the mux pane for an interactive sub-agent by id. Writes a `cancelled`
event and immutable output snapshot before killing the pane, so artifacts remain
self-describing. The tool result acknowledges the cancellation to the parent.
Under coordinated delivery, cancellation also creates one TUI-only terminal
entry and satisfies an `all-terminal` group barrier; any later manifest contains
only the bounded cancellation reference. Upgrade-recovered legacy intents retain
their existing delivery receipt suppression.

Parameters:

- `jobId` — required interactive sub-agent id returned by `subagent_interactive`

#### `send_interactive_subagent_message`

Sends a follow-up prompt to a running or idle interactive sub-agent by id. The
message is delivered into the child's existing REPL via the sub-agent's mux
backend (tmux send-keys or zellij write-chars + write 13), so the child's model
context is preserved — this is a true follow-up turn, not a fresh spawn.

Every persisted user entry produces a distinct artifact turn and immutable
completion snapshot. An idle follow-up resets future delivery to independent
`each`. A source can satisfy a completion group only once, so later turns from
that source/group are also delivered independently as `each`, even when steering
retained the active turn's persisted group metadata.

Only children spawned with `reusable: true` are eligible for workflow reuse.
They reject follow-ups until the workflow has consumed the current result and
the pane is idle. The first successful follow-up then promotes the pane to
standalone. Expired children are disposed, and failed disposal is retried by the
bounded artifact poll. The child calls `cli.mjs done 0` again when finished.

The tool refuses to send if the sub-agent is not registered, is neither `running`
nor `idle`, remains workflow-owned, or the mux rejects the send call. Each failure
returns a structured `isError: true` result.

Parameters:

- `id` — required sub-agent id
- `message` — required follow-up prompt text

#### `list_subagent_artifacts`

Lists all known interactive sub-agents: id, name, status, artifact directory, and
last-update timestamp. Use this to discover sub-agents that finished while the
parent was away.

#### `read_subagent_artifact`

Reads a sub-agent's artifact by id. Returns the lifecycle event log (pass
`since` to fetch only new events) and, by default, the latest terminal immutable
protocol-v2 snapshot. Mutable `output.md` is used only when no protocol-v2 terminal
snapshot applies, including legacy or still-running artifacts. This avoids
misattributing active follow-up staging bytes to an earlier terminal turn. A
successful read that returns a terminal snapshot consumes that turn's pending
coordinated delivery; an events-only read does not.

Protocol-v2 completions map each Pi-derived `turnId` to an immutable
`outputs/<eventId>.md` snapshot. Pass `turnId` to read that output; the response's
`details.outputHistory` lists the available `turnId`/`eventId` mappings. Legacy
`output-N.md` history remains available through numeric `turn` and
`details.availableTurns`.

Parameters:

- `id` — required sub-agent id
- `since` — optional unix-ms timestamp; only return events with `ts >= since`
- `includeOutput` — include the output (default `true`); historical selectors imply output
- `turn` — optional turn number; read `output-N.md` for that specific turn instead of the latest `output.md`
- `turnId` — optional protocol-v2 Pi turn id, up to 256 characters; read its immutable `outputs/<eventId>.md` snapshot

### `list_available_models`

List all available AI models with auth status. Use this to validate model identifiers before passing them to subagent tools — prevents silent fallback to the parent session model.

Parameters:

- `filter` — optional substring filter for provider or model name
- `authOnly` — if true (default), only return models with configured auth

## Example prompts

- “Use a sub-agent to review this change and list risks.”
- “Use an isolated sub-agent to propose a README outline for this repo.”
- “Spawn a context-aware sub-agent to continue debugging while we keep planning here.”
- “Run a sub-agent in the background to run the test suite, then notify me when done.”
- “Spawn two isolated async sub-agents to review this code from different angles, then collect both results.”
- “Start an interactive sub-agent in tmux for investigating the auth bug; give me the attach command.”
- “Open an interactive sub-agent in a visible zellij pane so I can watch its tool calls live.”
- “Attach to the existing interactive sub-agent and send it a follow-up without losing context.”

## Development

This repo uses npm for local development.

```bash
npm install
npm test
npm run pack:check
```

### Branch preview releases

Maintainers can create a non-npm preview release from any branch through the **Branch Preview Release** GitHub Action. It verifies the branch, moves a `branch-<sanitized-branch>` tag to that commit, creates/updates a prerelease, and uploads the `npm pack` tarball plus checksums for inspection.

Pi consumes the preview through the git tag:

```bash
pi install git:github.com/lmn451/pi-subagentura@branch-feat-example
pi -e git:github.com/lmn451/pi-subagentura@branch-feat-example
```

The attached release tarball is for manual download/auditing; Pi installs the package from the git ref.

### Debug logging

Set `SUBAGENT_DEBUG_LOG_DIR=/some/path` to write a JSONL trace of sub-agent lifecycle events to `debug-YYYY-MM-DD.jsonl` in that directory. Each line is a self-describing JSON object with `timestamp`, `level`, `event`, and event-specific fields.

The `tool_start` event records the `toolName` and full `args` of every tool the sub-agent invokes — useful for replaying or auditing what a sub-agent did. Other events cover session creation, turns, message updates, prompts, and job completion.

The feature is a no-op when the env var is unset.

```bash
SUBAGENT_DEBUG_LOG_DIR=./.pi-debug pi   # writes ./pi-debug/debug-2026-06-10.jsonl
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

A pre-commit hook formats staged files (via `simple-git-hooks` + `lint-staged`). A pre-push hook runs `npm run format:check` across the repository.

Install or refresh the hooks with `npm run hooks:install`. To skip a hook once, set `SKIP_SIMPLE_GIT_HOOKS=1`. To reformat the repository:

`npm run format`.

## License

[MIT](./LICENSE)

---
title: "Workflows"
keywords: [workflow, subagent, ralplan, planner, architect, critic, consensus]
---

# Workflows

This project ships several `.mjs` workflow scripts under
`examples/workflows/`. They orchestrate isolated sub-agents via the `workflow`
tool. Two are **generic converters**; the rest are **concrete instantiations**
of consensus planning pipelines.

Workflow scripts are trusted agent-authored JavaScript. The worker VM hides
accidental Node globals and disables string code generation, but it is not a
security boundary; do not feed arbitrary user-supplied JavaScript to the
workflow tool.

An in-process sub-agent orchestration context cannot invoke the `workflow` tool.
This topology is unsupported until cross-registry cancellation is implemented; see
GitHub issue [#62](https://github.com/lmn451/pi-subagentura/issues/62).

## Authoring contract

Submit raw JavaScript without markdown fences. Include a top-level pure-literal
`export const meta = { name, description, phases? }`; helper declarations may
appear before or after it. Do not use TypeScript, imports, `require`, filesystem
APIs, `Date.now()`, `Math.random()`, or argless `new Date()`. For editor support,
reference the published ambient declarations at `pi-subagentura/workflow`.

Use workflows only when work decomposes into independent agents or streaming
stages. The VM globals are `agent`, `parallel`, `pipeline`, `workflow`, `phase`,
`log`, `args`, immutable `cwd` (the parent execution directory), `budget`,
`console`, and guarded `Date`/`Math`. `parallel()` takes thunks; `pipeline()`
moves each item through all stages independently without a between-stage
barrier. Use unique short labels, include enough context and relevant paths in
every agent prompt, handle `null` failures, and add a final synthesis agent when
one coherent result is required.

Call `phase()` at real work-group transitions. Calls to `agent()` inherit the
current phase unless `phase` is set explicitly. With `schema`, use the plain
supported JSON Schema subset. In-process agents use native structured output;
process agents use textual JSON extraction and validation as a fallback.

## Inventory

| File                     | Size    | Purpose                                                  |
| ------------------------ | ------- | -------------------------------------------------------- |
| `skill-to-workflow.mjs`  | 12.8 KB | Generic: convert any Pi skill → workflow script          |
| `package-to-skill.mjs`   | 11.5 KB | Generic: convert any Pi package source → pure skill      |
| `ralplan-consensus.mjs`  | 24.4 KB | Workflow re-implementation of `pi-ralplan`               |
| `ralplan-occ.mjs`        | 59.6 KB | Workflow re-implementation of oh-my-claudecode's RALPLAN |
| `ralplan-from-skill.mjs` | 28.8 KB | Demo: `skill-to-workflow` output for pi-ralplan          |

The demo output of `package-to-skill` is in `skills/ralplan/` — a complete installable skill.

## Generic converters

Both converters are reusable building blocks. Pass them through the `workflow` tool with appropriate args.

### `skill-to-workflow.mjs`

**Input:** Path to a Pi skill directory (must contain `SKILL.md`).
**Output:** Path to write the generated `.mjs` workflow file.
**Pipeline:** Discover → Analyze → Design → Generate → Validate.

```js
workflow({
  script: readFileSync("examples/workflows/skill-to-workflow.mjs", "utf8"),
  args: {
    skillPath: "/path/to/skill-dir",
    outputPath: "/path/to/output.mjs",
  },
});
```

### `package-to-skill.mjs`

**Input:** Path to a Pi package source (with `package.json` + `pi.skills`/`pi.extensions`) and a target skill directory.
**Output:** A complete pure skill (`SKILL.md` + `prompts/<role>.md` + `README.md` + `package.json`).
**Pipeline:** Survey → Distill → Generate-and-persist (combined).

```js
workflow({
  script: readFileSync("examples/workflows/package-to-skill.mjs", "utf8"),
  args: {
    sourcePath: "/path/to/pi-package",
    skillDir: "/path/to/output-skill",
    packageName: "my-skill",
    packageVersion: "0.1.0",
  },
});
```

The combined generate-and-persist phase is intentional — see [Workflow tool pitfalls](#workflow-tool-pitfalls) below.

## Concrete workflows

### `ralplan-consensus.mjs`

Re-implements the pi-ralplan consensus pipeline as a workflow. Three isolated roles (Planner → Architect → Critic) iterate up to 5 rounds until all approve or the cap is hit.

```js
workflow({
  script: readFileSync("examples/workflows/ralplan-consensus.mjs", "utf8"),
  args: { idea: "build a CLI that diffs two directories", maxIterations: 5 },
});
```

Args:

- `idea` (required, string) — task description
- `maxIterations` (optional, default `5`) — consensus rounds
- `artifactsDir` (optional, default `"plans"`) — output directory

### `ralplan-occ.mjs`

Faithful port of oh-my-claudecode's RALPLAN skill with gate detection, deliberate mode, and planning/execution boundary. Captures the OCC UX contract as closely as the workflow runtime allows.

```js
workflow({
  script: readFileSync("examples/workflows/ralplan-occ.mjs", "utf8"),
  args: {
    idea: "migrate auth module to JWT",
    deliberate: "auto", // auto-detect high-risk substrings
    gate: true, // enable gate detection
    interactive: true, // emit [pending approval] markers
  },
});
```

**Fidelity limitations** (also documented in the script header):

- Interactive AskUserQuestion checkpoints are not supported by the workflow runtime. Substituted with `[pending approval]` log markers.
- Architect and Critic model overrides are routed through their respective `agent()` calls, but each model id must be configured in Pi.
- The workflow never executes; it always returns `pending_approval: true` and `execution_halted: true`, per OCC's planning/execution boundary.

## Workflow tool pitfalls

These are the failure modes we hit while building the converters above. Document them before designing new workflows.

### 1. Defensive args parsing

Tool callers may pass `args` as an object or as a JSON-encoded string. The TypeBox `Type.Unknown` schema does not normalize the value, so reusable scripts should accept both forms:

```js
function _parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}
const _a = _parseArgs(args);
```

All bundled examples normalize both forms, and the behavior tests exercise each script with object and JSON-string arguments.

### 2. JSON-stringified payloads for large content

Schema validation breaks on multi-KB string fields. The workflow runtime's `validateSchema` (in `src/workflow-core.ts`) handles a small subset: `type`, `enum`, `properties`, `required`, `additionalProperties: false`, `items`, `minItems`, and `maxItems`. Anything >10KB inline is risky. Wrap large structured data in a single string field:

```js
// BAD — critic.md at 22KB breaks validation
{
  schema: {
    type: "object",
    properties: {
      rolePrompts: {
        type: "array",
        items: { type: "object", properties: { content: { type: "string" } } },
      },
    },
  },
}

// GOOD — wrap as JSON-stringified
{
  schema: {
    type: "object",
    properties: { distilledJson: { type: "string" } },
    required: ["distilledJson"],
  },
}
// agent returns: { "distilledJson": "{\"rolePrompts\":[{\"content\":\"...22KB...\"}]}" }
// script: const data = JSON.parse(agent.distilledJson);
```

### 3. Metadata-only distillation > content passthrough

When chaining agents, don't pass large content forward. Have the upstream agent return **paths** and have the downstream agent use `read` tool to fetch fresh:

```js
// Phase 2 (distill): returns metadata
{ role: "critic", filename: "prompts/critic.md", sourcePath: "/abs/path/critic.md" }

// Phase 3 (generate): reads sourcePath, inlines content into output file
const content = await readFile(sourcePath);  // via sub-agent's read tool
```

### 4. Combine generate + write phases

When the next phase would just write the previous phase's content to disk, **merge them**. The agent reads inputs, generates output, writes files via `write` tool, and returns only a small success report:

```js
// Agent prompt:
// 1. read role prompt files from distilled.rolePrompts[i].sourcePath
// 2. write each verbatim to SKILL_DIR/prompts/<role>.md
// 3. write SKILL.md, README.md, package.json
// 4. return { valid, issues, filesWritten, totalBytes }
```

This avoided the "JSON-encoding of large file map fails" failure mode in `package-to-skill.mjs` (3rd attempt).

### 5. The runtime does not inject Node APIs

The sandbox exposes only the documented workflow helpers plus immutable `cwd`,
`console`, and guarded `Date`/`Math`. No `fs`, no `path`, no `process`. Calling
`mkdirSync` or `readFileSync` in the script body throws `ReferenceError`. String
code generation is disabled, but this VM is still a determinism aid rather than
a security boundary. All file I/O must happen in sub-agents via tools.

### 6. `additionalProperties: false` rejects unknown keys

The `validateSchema` function in `src/workflow-core.ts` enforces `additionalProperties: false` for object schemas. Any output key not listed in `properties` produces a validation error. Use it when an agent result must not contain undeclared keys; otherwise, extra keys are allowed.

## Round-trip: package ↔ skill ↔ workflow

The two converters form a partial round-trip:

```
Pi package source
  │
  ├──[package-to-skill]──>  Pure skill (installable)
  │                              │
  │                              ├──[skill-to-workflow]──>  Workflow script
  │                              │
  │                              └── (manual) ───────────>  Other tooling
  │
  └──[skill-to-workflow]──>  Workflow script (one-way, partial)
```

`skill-to-workflow` is one-way when the source is a full Pi package (it can only see the skill files, not the TS extension). Use `package-to-skill` first if you want a pure-skill intermediate.

## Adding a new workflow

1. Copy `examples/workflows/skill-to-workflow.mjs` or `examples/workflows/package-to-skill.mjs` as a starting template.
2. Apply pitfalls 1-6 above — they are not optional.
3. Run via `workflow({ script: readFileSync("your-script.mjs", "utf8"), args: {...}, budget: 100000 })`.
4. Budget: 50k-100k for 4-agent flows, 200k+ for 5+ agent flows or flows with large content.

## Future work

- Expand converter tests to cover malformed agent output and partial writes.
- Consider whether the examples should also be installable as named presets.

## Workflow visibility and scaling

The `workflow` tool runs scripts inside a [`Worker` thread](../src/workflow-worker-thread.mjs) that communicates progress events back to the parent via an RPC protocol. This section documents what the user sees during execution and where the gaps are.

### What the TUI shows (sync mode)

Every `agent()`, `phase()`, and `log()` call emits a progress event. The parent pipes these through `renderProgress()` and streams them as `onUpdate` calls:

```
● workflow — 4 agent(s), ⚡ 3 running, 0 tokens
  → started verify:status-token-wrong-company
  → done verify:status-token-wrong-company
  → started verify:cached-status-token
◆ phase: Sweep
● workflow — 4 agent(s), 0 running, 0 tokens
  → started sweep:ui-agents
  → started sweep:backend
  → done sweep:backend
```

**Two update modes:**

| Mode                      | How progress flows                                                           | TUI effect                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Sync** (`async: false`) | `onProgress` → `onUpdate` per event                                          | Live stream in the reply; each `agent()`, `phase()`, and `log()` call fires an inline update.                                       |
| **Async** (default)       | Written to `WorkflowJobState.snapshot`; artifact poller paints footer/widget | Footer shows `⚡ N workflow(s) running`; below-editor widget shows running workflow rows with phase/agent/token/last-event summary. |

### Current visibility

#### 1. Workflow footer and widget

Async workflows are discoverable without polling tools:

```
⚡ 2 workflows running
◇ pr-review (wf_ab12): 3 agents · 2 running · 120 tokens · 5s · phase: Review — → started tests
◇ ralplan (wf_cd34): 1 agent · 1 running · 80 tokens · 1m 12s · phase: Planner — ◆ phase: Planner
```

The footer uses `subagentura-workflows`; the workflow widget uses
`subagentura-workflow-activity` and is capped to 5 rows with an overflow row.
Use `/workflow-status` for the full textual status dump, or `/workflow-tree` for an interactive drill-down overlay.

#### 2. Per-agent visibility

Workflow `agent()` calls default to process isolation. Each process-backed agent
runs in tmux/zellij and is also shown by the interactive sub-agent widget below
the editor. In-process agents still forward live `activeTool` / output-preview
updates as workflow log events when the underlying runner exposes them.

#### 3. Interactive drill-down overlay

Run `/workflow-tree` to open an overlay over the current session. It supports:

- `↑↓` / `j` / `k` to select a workflow
- `enter` / `→` to expand or collapse phase, latest-event, and per-agent rows
- `←` to collapse
- `c` to cancel the selected running workflow
- `q` / `esc` to close

Each workflow snapshot retains the latest 50 agent-attempt records; the overlay
displays the latest 20 and reports how many older records were omitted. These
records show phase, label, model, and status, not full tool-call history.

The overlay is keyboard-driven. Mouse-clickable controls directly on widget rows
are still deferred because widgets are intentionally passive status surfaces.

#### 4. Remaining gaps

- Workflow widget rows are summaries, not mouse-clickable controls.
- Progress event coalescing/rate limiting is still basic.
- Per-agent rows do not include full tool-call history.

### Process isolation

By default, each `agent()` call spawns a separate `pi` process inside tmux or
zellij:

```js
await agent(prompt, { label: "verify:claim-x" });
```

Use `isolation: "in-process"` only when the workflow explicitly wants the older
in-process behavior:

```js
await agent(prompt, { isolation: "in-process", label: "quick-check" });
```

#### How it works

1. `launchInteractiveSubagent()` creates a pane via the multiplexer backend
2. By default (`background: true`) the pane is a detached named window — invisible in the tmux bar
3. A launch script boots `pi` in that pane with a child-specific system prompt + protocol
4. The parent polls the artifact directory (`events.ndjson` + `output.md`) awaiting completion
5. The artifact poller tails the child session log and shows tool activity in a TUI widget

#### TUI widget rows

Running process-backed agents appear below the editor:

```
▶ verify:claim-x: read src/api/agents.js (12s ago)
▶ sweep:backend: grep webapp/rest/themis_token.py (5s ago)
```

The interactive sub-agent widget is capped to 10 rows and then shows
`… and N more`, preventing large fan-outs from pushing other TUI content away.

#### Attaching to a process agent

Use `get_interactive_subagent_status` to get attach/focus commands:

```bash
get_interactive_subagent_status(id="a1b2c3d4")
→ Pane: %42, Session: pi-subagent-a1b2c3d4
→ Attach: tmux attach -t pi-subagent-a1b2c3d4
→ Focus:  tmux select-window -t verify-claim-x-a1b2c3d4
```

The `list_subagent_artifacts` tool lists all known sub-agents (including past ones whose artifacts are still on disk). `read_subagent_artifact` reads output or events.

#### Backend support

| Backend    | `createPane` behavior                                                                  | Available outside mux?                                           |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **tmux**   | Detached named window (`background: true`) or side-by-side split (`background: false`) | ✅ Creates a new detached session if `process.env.TMUX` is unset |
| **zellij** | Detached named tab                                                                     | ❌ Requires existing zellij session                              |
| **none**   | Throws `NoMultiplexerAvailableError` with setup hint                                   | N/A — falls back to in-process                                   |

### Scaling

#### Concurrency

| Agent type                                                | Default max concurrent          | Cap                                  |
| --------------------------------------------------------- | ------------------------------- | ------------------------------------ |
| Process-backed default (`isolation` unset or `"process"`) | `max(1, min(4, cpuCores - 2))`  | `MAX_TOTAL_AGENTS = 1000` (lifetime) |
| Explicit in-process (`isolation: "in-process"`)           | `max(1, min(16, cpuCores - 2))` | Same                                 |

For a typical machine (8–16 cores): ~2–4 process-backed agents run in parallel by default. The rest queue on the process semaphore. Explicit in-process fan-outs can run wider when a workflow opts into them.

#### Progress event flood

`parallel()` with many thunks (`Promise.all`) fires `agent_start` for many agents nearly simultaneously. The workflow snapshot keeps only the latest summary message for the TUI widget/status path, which limits async UI churn. Sync `onUpdate` still emits each event and may need stricter rate limiting in a future drill-down UI.

### Recommendations summary

| What                                          | Status                         |
| --------------------------------------------- | ------------------------------ |
| Workflow footer (`⚡ N workflows running`)    | Done                           |
| Workflow summary widget                       | Done                           |
| Interactive sub-agent widget row cap          | Done                           |
| Default process isolation for workflow agents | Done                           |
| Drill-down workflow UI                        | Done (`/workflow-tree`)        |
| Keyboard cancel control                       | Done (`c` in `/workflow-tree`) |
| Mouse-clickable controls for widget rows      | Deferred                       |
| Full per-agent tool-call history tree         | Deferred                       |
| Strong progress-event rate limiting           | Deferred                       |

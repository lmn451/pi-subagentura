# Bundled workflow examples

The trusted `.mjs` scripts are included in the `pi-subagentura` npm package and
demonstrate the legacy injected-global API. The repository also includes a
TypeScript V4 definition example; it uses the `pi-subagentura/workflow` SDK.

## Running an example

From a repository checkout, start Pi with the extension and ask the parent to
read an example and pass its complete source to the `workflow` tool:

```text
pi -e . --orchestrator
Run examples/workflows/ralplan-consensus.mjs with idea="review src/auth.ts" and maxIterations=2.
```

The equivalent agent-tool payload is:

```js
workflow({
  script: "<contents of examples/workflows/ralplan-consensus.mjs>",
  args: {
    idea: "Review src/auth.ts and produce an implementation plan",
    maxIterations: 2,
    artifactsDir: "plans",
  },
});
```

To reuse a script by name, pass the same source to `save_workflow` once, then
run it with `workflow({ name, args })` or select it with `/workflows`.

## Typed V4 definition

[`review-source.ts`](./review-source.ts) is a TypeScript V4 definition that
reviews the same supplied files independently across four aspects: intent/design
alignment, compatibility, unintended behavior changes, and correctness/quality.
Each reviewer returns a schema-validated verdict and up to 15 findings with
severity, location, direct evidence, and explanation; the workflow combines
these results without deduplicating independent evidence.

Pass the full source to the `workflow` tool with both `files` and
`intendedChange`, for example:

```js
workflow({
  script: "<contents of examples/workflows/review-source.ts>",
  args: {
    files: ["src/auth.ts", "src/session.ts"],
    intendedChange:
      "Replace the token cache while preserving existing callers.",
  },
});
```

Each reviewer in the definition sets `readOnly: true` on its `ctx.agent()` call;
this is an agent option, not a `workflow()` invocation option, and the example
leaves the normal isolation default unchanged. The effective capability is
snapshotted per call; omitted or false preserves the existing default
model-facing tool set. The allowlist is exactly Pi `read`, `grep`, `find`, and
`ls`; it excludes `edit`, `write`, `bash`, `powershell`, recursive
subagent/workflow tools, and arbitrary extension tools, including `mcp__*`,
`list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`.
In-process schema capture additionally permits the internal `structured_output`
return tool. Process-backed reviewers return final assistant text directly;
the trusted host captures it into the existing result artifact before the
attempt settles, and the process-selected schema fallback remains text JSON for
parent extraction and validation. This is a tool-dispatch restriction, not an
OS sandbox or path confinement: the host and extensions still execute as the
same OS user. The shared `# Goal` / `# Contract` context and per-aspect
`# Target` / `# Change` / `# Acceptance` sections organize the work but do not
enforce semantic scope.

The existing workflow step records remain the source of progress; the agents
do not maintain a second todo ledger or scheduler. Read-only capability is
retained through schema-repair attempts and durable recovery/compatibility
checks. If a multiplexer is unavailable, non-durable execution falls back to
in-process execution with the same restriction; durable process launch
continues to fail closed rather than falling back to an unrestricted child.

`files` accepts 1–40 non-empty paths, each at most 512 characters and 8,192
characters combined. `intendedChange` must be non-empty and at most 12,000
characters. The deterministic aggregate reports `pass`, `concern`, `blocking`,
or `uncertain`. Any `blocking` verdict or critical/high finding yields blocking;
otherwise failed/uncertain reviews yield uncertain; otherwise a concern verdict
or any finding yields concern; pass requires four completed pass reviews and no
findings. Findings sort by severity (critical to low), fixed aspect order,
location, evidence, and explanation; severity counts include every finding.
Failed/unknown aspects never pass. After review, the workflow optionally asks
whether to save the report as a run artifact; it never asks for permission to run
the read-only review.

V4 definitions use the in-memory engine by default; pass `durable: true` to
opt into project-scoped run storage. They support Node's erasable
TypeScript syntax, but the workflow runner does not type-check it. Runtime
imports must be named `defineWorkflow` / `schema` imports from
`pi-subagentura/workflow`; other runtime imports are rejected. Node.js 24.12 or
newer is required. The exact `effect@4.0.0-rc.117` runtime dependency remains
internal.

To inspect a paused run, use `list_workflow_runs` or `get_workflow_status`, then
call `respond_workflow_input({workflowId, path})`; Pi asks the person at the UI
and persists the answer before resuming. With `async: false`, input is collected
directly by the workflow tool. After interruption, use
`resume_workflow({workflowId})` while Pi is running. V4 status summaries omit
step outputs and answers. See the [runtime contract](../../WORKFLOW_RUNTIME.md#v4-definitions).

Legacy `.mjs` examples accept either an args object or its JSON-string form.
V4 definitions receive schema-validated argument objects. JSON strings are
useful when another tool boundary serializes a legacy payload:

```js
workflow({
  name: "ralplan-consensus",
  args: '{"idea":"Review src/auth.ts","maxIterations":2}',
});
```

## Background completion

Background workflows default to `completionPolicy: "each"`. The workflow
aggregate emits one TUI-only terminal notice and, when the parent is safely
ready, one compact `get_workflow_result` selector. Internal workflow-owned
agents report through workflow progress and never publish direct completion
notices or manifests. Independent terminal results that arrive while the
parent is busy coalesce into a safe-idle continuation.

Use `completionPolicy: "group"` only with a caller-declared shared
`completionGroupId` for related top-level background work. Same-turn launch and
task text never infer membership. Named groups are advanced cross-call control
and seal when the spawning parent turn settles. See [coordinated completion](../../README.md#coordinated-completion-delivery)
for delivery behavior.
Human input takes priority, successful terminal retrieval consumes pending
automatic delivery, and an entirely consumed group creates no turn. Jobs and
results remain scoped to the current parent session.

Parent-session consumption receipts are preferred; when unavailable, a private
session-scoped append-only fallback ledger is read from fixed snapshots in
bounded chunks and line buffers. It has no fixed disk-size bound during a
prolonged outage; truncating it could resurrect results already collected when
parent entries become available again. The parent-model channel is not exactly
once: a crash after synchronous `sendMessage` dispatch can replay a manifest,
so delivery is at-least-once.

## Authoring guidance

For the legacy `.mjs` examples, write raw JavaScript without fences. Include a top-level pure-literal
`export const meta = { name, description, phases? }` statement; helper
declarations may appear before or after it. Do not use TypeScript, imports,
`require`, filesystem APIs, `Date.now()`, `Math.random()`, or argless `new Date()`.
Ambient authoring types are published at `pi-subagentura/workflow`. The runtime
exposes `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`,
immutable parent `cwd`, `budget`, `console`, and guarded `Date`/`Math`.

Use a workflow only for decomposable multi-agent work. Pass thunks to
`parallel()`; `pipeline()` streams each item through every stage independently.
Call `phase()` at real group transitions: later agents inherit that phase unless
their options explicitly override it. Give agents unique short labels and enough
context and paths to work independently, handle `null` failures, and use a final
synthesis agent when the result must be coherent.

Schemas must use the runtime's plain JSON Schema subset. In-process agents use
native structured output; process-isolated agents fall back to textual JSON
extraction and validation. Workflow snapshots retain the latest 50 per-agent
records, while `/workflow-tree` displays the latest 20 and reports omissions.

## Planning workflows

### `ralplan-consensus.mjs`

A Planner → Architect → Critic loop that asks agents to write review artifacts
and a final plan.

| Argument        | Required | Meaning                               |
| --------------- | -------- | ------------------------------------- |
| `idea`          | yes      | Planning problem                      |
| `maxIterations` | no       | Positive iteration cap; defaults to 3 |
| `artifactsDir`  | no       | Output directory; defaults to `plans` |

### `ralplan-occ.mjs`

An OCC-style RALPLAN flow with a short-prompt gate, deliberate-mode checks,
per-reviewer model routing, and explicit approval markers. It never executes
the resulting plan.

| Argument             | Required | Meaning                                                   |
| -------------------- | -------- | --------------------------------------------------------- |
| `idea`               | yes      | Planning problem                                          |
| `deliberate`         | no       | `true`, `false`, or `"auto"` risk-triggered mode          |
| `maxIterations`      | no       | Iteration cap from 1 to 5; defaults to 5                  |
| `artifactsDir`       | no       | Final-plan directory; defaults to `.omc/plans`            |
| `draftsDir`          | no       | Draft directory; defaults to `.omc/drafts`                |
| `planName`           | no       | Final plan basename; defaults to `ralplan`                |
| `architectModel`     | no       | Model id passed to the Architect `agent()` call           |
| `criticModel`        | no       | Model id passed to the Critic `agent()` call              |
| `executeOnConsensus` | no       | Changes the reported approval status; never executes code |

### `ralplan-from-skill.mjs`

A self-contained RALPLAN workflow example with role prompts inlined from the upstream skill.

| Argument        | Required | Meaning                                        |
| --------------- | -------- | ---------------------------------------------- |
| `idea`          | yes      | Planning problem                               |
| `workingDir`    | yes      | Absolute project directory                     |
| `specPath`      | no       | Optional spec file                             |
| `planName`      | no       | Plan filename without extension                |
| `deliberate`    | no       | Boolean override; otherwise inferred from idea |
| `maxIterations` | no       | Positive iteration cap; defaults to 5          |

## Converter workflows

### `skill-to-workflow.mjs`

Converts a small Pi skill into a self-contained workflow:

```js
workflow({
  script: "<contents of examples/workflows/skill-to-workflow.mjs>",
  args: {
    skillPath: "/absolute/path/to/my-skill",
    outputPath: "/absolute/path/to/generated-flow.mjs",
  },
});
```

### `package-to-skill.mjs`

Distills a Pi extension package into an installable skill:

```js
workflow({
  script: "<contents of examples/workflows/package-to-skill.mjs>",
  args: {
    sourcePath: "/absolute/path/to/package",
    skillDir: "/absolute/path/to/generated-skill",
    packageName: "my-generated-skill",
    packageVersion: "1.0.0",
  },
});
```

Both converters delegate filesystem inspection and writes to agents because
the workflow VM does not expose Node filesystem APIs. Their generated workflow
source is parsed in the test suite before it is accepted.

## Limitations

- Scripts are trusted JavaScript, not untrusted-input sandboxes.
- By default, workflow jobs are async and live only for the current parent
  session. Reload, resume, quit, and new-session transitions cancel them.
- Process-isolated agents require tmux or Zellij; non-durable runs otherwise
  fall back to in-process execution. Durable runs fail closed when the
  process backend is unavailable.
- Legacy `.mjs` workflows cannot suspend for interactive user input. V4
  definitions can pause through `ctx.ask()` / `ctx.gate()` and
  `respond_workflow_input`.
- File-writing examples depend on the delegated agents having appropriate read
  and write tools and permissions.
- Model overrides must name models configured in the active Pi installation.

## Explicit durable execution and retries

`durable-review.mjs` demonstrates stable per-item/per-attempt ids, explicit
bounded retries, fan-out, and final synthesis. Save it with `save_workflow`, then
run with `workflow({name: "durable-review", args: {path: "src"}, budget: 20000,
durable: true})`. Use `async: false` for an immediate result. After an
interruption, use `resume_workflow({workflowId})` in the same project. This
legacy `.mjs` example opts into durability; V4 definitions use the in-memory
engine by default and persist only when `durable: true` is supplied.

`retry(n => agent(..., {id: "review/" + n}), {attempts: 3})` retries exceptions
and `null`, but never cancellation. Every attempt may repeat agent side effects;
use read-only work or application-specific idempotency. See
[the runtime contract](../../WORKFLOW_RUNTIME.md).

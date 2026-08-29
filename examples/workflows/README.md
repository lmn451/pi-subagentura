# Bundled workflow examples

These trusted `.mjs` scripts are included in the `pi-subagentura` npm package.
They demonstrate reusable workflow structure and provide practical planning and
conversion flows.

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

All bundled examples accept either an args object or its JSON-string form. JSON
strings are useful when another tool boundary serializes the payload:

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
task text never infer membership. Named groups are advanced cross-call control:
they seal when the spawning parent turn settles and release after every
registered member is terminal, including `done`, `error`, and `cancelled`.
Human input takes priority, successful terminal retrieval consumes pending
automatic delivery, and an entirely consumed group creates no turn. Jobs and
results remain scoped to the current parent session.

Deprecated `notifyOnComplete` and `triggerTurnOnComplete` fields map to
coordinated `each`.

Parent-session consumption receipts are preferred; when unavailable, a private
session-scoped append-only fallback ledger is read from fixed snapshots in
bounded chunks and line buffers. It has no fixed disk-size bound during a
prolonged outage; truncating it could resurrect results already collected when
parent entries become available again. The parent-model channel is not exactly
once: a crash after synchronous `sendMessage` dispatch can replay a manifest,
so delivery is at-least-once.

## Authoring guidance

Write raw JavaScript without fences. Include a top-level pure-literal
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

A compact SHORT-only Planner → Architect → Critic loop. Architect and Critic
are isolated sequential reviewers of the same immutable Planner snapshot. Critic
never receives Architect output and still runs after Architect rejection. Every
terminal result is pending approval and execution-halted; consensus is not an
execution recommendation. A final consolidation agent may write Markdown after
both explicit approvals, but Phase 1 does not verify that artifact.

| Argument             | Required | Meaning                                 |
| -------------------- | -------- | --------------------------------------- |
| `idea`               | yes      | Planning problem                        |
| `maxIterations`      | no       | Round cap, clamped to 1–5 (default 5)   |
| `artifactsDir`       | no       | Output directory; defaults to `plans`   |
| `executeOnConsensus` | no       | Deprecated compatibility input; ignored |

### `ralplan-occ.mjs`

The canonical OCC-facing RALPLAN flow with a short-prompt gate, deliberate-mode
hard gates, and optional per-reviewer model routing. Both reviewers inspect one
fixed Planner snapshot independently. It never executes the resulting plan.

| Argument             | Required | Meaning                                                  |
| -------------------- | -------- | -------------------------------------------------------- |
| `idea`               | yes      | Planning problem                                         |
| `gate`               | no       | `false` bypasses the local heuristic; default is enabled |
| `interactive`        | no       | Controls non-blocking approval marker text; never pauses |
| `deliberate`         | no       | `true`, `false`, or `"auto"` risk-triggered mode         |
| `maxIterations`      | no       | Iteration cap clamped to 1–5; defaults to 5              |
| `artifactsDir`       | no       | Final-plan path prefix; defaults to `.omc/plans`         |
| `planName`           | no       | Final-plan basename; defaults to `ralplan`               |
| `architectModel`     | no       | Model id passed to the Architect `agent()` call          |
| `criticModel`        | no       | Model id passed to the Critic `agent()` call             |
| `executeOnConsensus` | no       | Deprecated compatibility input; ignored                  |

Actual approval and execution routing belong to the host. The workflow VM cannot
suspend for user input or convert marker text into approval.

### `ralplan-from-skill.mjs`

A generated, self-contained RALPLAN example derived from the bundled skill.

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
- Workflow jobs are async by default and live only for the current parent
  session. Reload, resume, quit, and new-session transitions cancel them.
- Process-isolated agents require tmux or Zellij; otherwise the runtime falls
  back to in-process execution.
- Interactive user-question pauses are represented by pending-approval output;
  a workflow cannot suspend and later resume at an `AskUserQuestion` checkpoint.
- File-writing examples depend on the delegated agents having appropriate read
  and write tools and permissions.
- Model overrides must name models configured in the active Pi installation.

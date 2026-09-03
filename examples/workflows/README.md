# Bundled workflow examples

This package includes trusted `.mjs` workflow scripts under
`examples/workflows/`. They show how the generic `workflow` tool turns
orchestration techniques into reusable executable code. The bundled RALPLAN
workflow translates a prose skill into code-enforced roles, ordering,
validation, and stopping conditions.

## Running an example

From a repository checkout, start Pi with the extension and ask the parent to
read an example and pass its complete source to the `workflow` tool:

```text
pi -e . --orchestrator
Run examples/workflows/ralplan.mjs with idea="review src/auth.ts" and maxIterations=2.
```

The equivalent agent-tool payload is:

```js
workflow({
  script: "<contents of examples/workflows/ralplan.mjs>",
  args: {
    idea: "Review src/auth.ts and produce an implementation plan",
    maxIterations: 2,
    artifactsDir: "plans",
  },
});
```

To reuse the RALPLAN script by name, pass its source to `save_workflow` once.
Saving `ralplan.mjs` immediately exposes `/workflow:ralplan`. Type
`/workflow:` to discover every saved workflow, then write the task naturally:

```text
/workflow:ralplan rework auth
```

The command sends `rework auth` through the normal parent LLM turn. The model
reads the workflow's `meta.inputSchema`, infers the structured arguments, and
invokes the existing `workflow({ name, args })` tool. Users do not write JSON.

Programmatic callers can still invoke the tool directly:

```js
workflow({
  name: "ralplan",
  args: { idea: "Review src/auth.ts and produce an implementation plan" },
});
```

`save_workflow` stores workflows as `<project>/.pi/workflows/<name>.mjs` by
default. Specify `scope: "global"` to use
`~/.pi-subagentura/workflows/<name>.mjs`; a project workflow overrides a
same-named global workflow. Legacy `.js` workflow files remain readable.

### Named command argument contract

`/workflow:<name>` deliberately routes through the parent LLM. It does **not**
run the saved script directly and does **not** pass the command's trailing text
through as raw workflow `args`.

For reliable inference, workflow metadata declares the human-facing hint and
machine-readable input shape:

```js
export const meta = {
  name: "review",
  description: "Review a target with an optional focus.",
  argumentHint: "<target and review focus>",
  inputSchema: {
    type: "object",
    required: ["target"],
    properties: {
      target: {
        type: "string",
        description: "File, directory, or subsystem to review.",
      },
      focus: {
        type: "string",
        description: "Optional review emphasis.",
      },
    },
  },
};
```

Given:

```text
/workflow:review auth with a security focus
```

the parent model receives the request and metadata, then invokes the existing
tool with inferred structured arguments:

```js
workflow({
  name: "review",
  args: { target: "auth", focus: "security" },
});
```

If a required field cannot be inferred safely, the routing prompt requires one
concise clarification. Existing workflows without `inputSchema` remain
loadable, but named-command inference has only their name and description;
adding `argumentHint` and `inputSchema` is strongly recommended. Workflows
created through `/workflow` are instructed to declare both fields.

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

## Bundled RALPLAN workflow

### `ralplan.mjs`

The single RALPLAN example translates the latest
[oh-my-claudecode RALPLAN skill](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/skills/ralplan/SKILL.md)
and its Plan consensus contract into an ordinary workflow script. It enforces
isolated role calls, immutable artifacts, Architect-before-Critic ordering,
reviewer input separation, explicit verdicts, and bounded revision. It never
executes the resulting plan and adds no RALPLAN-specific extension tool or mode.

| Argument                   | Required | Meaning                                            |
| -------------------------- | -------- | -------------------------------------------------- |
| `idea`                     | yes      | Planning problem                                   |
| `gate`                     | no       | `true` enables the optional short-prompt heuristic |
| `interactive`              | no       | `true` emits non-blocking checkpoint markers       |
| `deliberate`               | no       | `true`, `false`, or `"auto"` risk-triggered mode   |
| `maxIterations`            | no       | Iteration cap clamped to 1–5; defaults to 5        |
| `artifactsDir`             | no       | Final-plan path prefix; defaults to `.omc/plans`   |
| `planName`                 | no       | Safe final-plan basename; defaults to `plan`       |
| `requirementsTraceability` | no       | Runs advisory Analyst + requires coverage map      |
| `architectModel`           | no       | Model id passed to the Architect `agent()` call    |
| `criticModel`              | no       | Model id passed to the Critic `agent()` call       |
| `executeOnConsensus`       | no       | Deprecated compatibility input; ignored            |

Artifacts are bounded to 1 MB and validated by dedicated read-only verifier
agents because the workflow VM exposes no filesystem API. A workflow cannot
suspend at an interactive checkpoint, so optional marker text remains
non-blocking. A marker, digest, valid artifact, or workflow result is never
execution consent; every terminal result is pending and execution-halted.

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

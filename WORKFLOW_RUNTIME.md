# Code workflow runtime

Legacy `.mjs` workflows are trusted agent-authored JavaScript with ESM-style
literal `meta` exports. Their executable bodies own control flow and
intermediate values. The runtime is neither Orchestratorv2's interactive router
nor a declarative todo engine. Imports, `require`, filesystem APIs, current
time, and randomness are not legacy script globals. The VM is a determinism
aid, **not a security boundary**.

There are two source formats. Existing `.mjs` programs use injected globals and
remain available for compatibility. V4 definitions use the typed SDK and a
`ctx` object as described below. Node.js 24.12 or newer is required. V4 strips
erasable TypeScript syntax with Node's native TypeScript support; it does not
type-check workflow source or compile TypeScript features that require code
generation. Runtime imports are limited to named `defineWorkflow` and `schema`
imports from `pi-subagentura/workflow`. Type-only imports are erased. Other
runtime imports, dynamic imports, `import.meta`, and additional module exports
are rejected. The worker uses `effect@4.0.0-rc.117` internally; Effect types and
values are not exposed to workflow authors.

## V4 definitions

A V4 module default-exports a `defineWorkflow({...})` definition with a
lowercase slug `name`, positive integer `version`, optional `description`,
optional input/output schemas, and a `run(ctx, args)` function. `schema` builds
typed JSON schemas for strings, numbers, integers, booleans, null, enums,
arrays, optional fields, and objects. The host validates workflow arguments,
agent outputs, and the final return value against those schemas.

The available context is `ctx.step`, `ctx.agent`, `ctx.group`, `ctx.parallel`,
`ctx.map`, `ctx.pipeline`, `ctx.repeat`, `ctx.workflow`, `ctx.ask`, `ctx.gate`,
`ctx.checkpoint`, `ctx.artifact`, `ctx.log`, `ctx.budget`, and `ctx.signal`.
These operations create observable step records; ordinary JavaScript and
TypeScript control flow remains ordinary function code. `ctx.parallel` takes
named branch thunks. `ctx.map` and `ctx.pipeline` preserve input order while
running bounded work. `ctx.repeat` is the bounded feedback-loop helper; normal
`for`, `while`, conditionals, and `try/catch` remain available.

Step and agent options accept the shared policy fields `timeout`, `retry`,
`failure`, `persist`, `resume`, `cache`, and `budget`. Timeouts are positive
milliseconds or strings such as `"10 minutes"`; retry attempts are bounded from
1 through 10, with fixed or exponential backoff. `failure: "continue"` or
`"collect"` returns structured task results for failed branches. Step budgets
are output-token limits checked after the step settles.

`ctx.budget` reports the completed output-token total and remaining soft
budget. `ctx.budget.assertAvailable(amount)` checks a non-negative finite token
amount against the current remaining budget and throws if it is insufficient.
It does not reserve tokens or stop already-running work; parallel calls can
overshoot this output-token target. It is not a monetary limit.

```ts
import { defineWorkflow, schema } from "pi-subagentura/workflow";

const Input = schema.object({ path: schema.string() });
const Review = schema.object({ findings: schema.array(schema.string()) });

export default defineWorkflow({
  name: "review-source",
  version: 1,
  input: Input,
  output: Review,
  async run(ctx, args) {
    const result = await ctx.agent("review", {
      prompt: `Review ${args.path}. Return a JSON findings array.`,
      output: Review,
    });
    await ctx.checkpoint("reviewed", result);
    return result;
  },
});
```

Pass this module source to `workflow({script, args})` or save it with
`save_workflow`. V4 definitions use project-scoped durable storage by default;
pass `durable: false` to run one without durable recovery. Use the durable run
tools to list, inspect, cancel, retrieve, or resume a persisted run. Resume is
manual: a live Pi process must call `resume_workflow`; there is no daemon.
Recovery re-executes the same source from the beginning and reuses a completed
step only when its stable path, input, policy, and definition hash still match.
Changing the source invalidates that compatibility and may run the step again.

`persist: false` omits a step's output from the durable workflow journal,
including agent attempt results and failure messages. Usage and terminal status
remain available for accounting. Recovery reruns an agent whose private result
was discarded, including a crash between the attempt receipt and step completion.
This does not erase separately retained Pi child session files or process-agent
artifacts, or values the workflow explicitly returns or writes elsewhere.
`cache: false` or
`resume: false` prevents a compatible completed output from being reused.
Checkpoints persist their value. Artifacts persist content separately from the
journal and return a reference; each artifact is limited to 2 MiB and the run's
artifact total to 64 MiB. Step values are limited to 512 KiB. Step snapshots
omit inputs, policies, outputs, and human answers; the private run journal
contains source, arguments, prompts, answers, and step outputs and must not be
shared as telemetry.

`ctx.ask()` and `ctx.gate()` can pause a V4 run for human input. With
`async:false`, the workflow tool collects the answer directly in Pi's UI. For
background runs, inspect the waiting step with workflow status/list tools, then
use `respond_workflow_input({workflowId, path})`. Pi presents the question or
approval in its UI and writes the answer to the project-scoped run before
execution continues. With `durable: false`, the same sync and background input
flows work while the run is live, and answers remain in memory.
The answer is private run data; it is not included in the
step summary. Legacy `.mjs` workflows still cannot pause for interactive input.

## Definitions and runs are different

`save_workflow` stores a reusable definition. `inspect_workflow` reads/parses it
without running agents. `workflow({name, args})` executes that definition;
legacy `.mjs` definitions use the existing session-scoped behavior by default,
while V4 typed definitions use project-scoped durability unless
`durable:false` is passed. Async remains the default; `async:false` waits for
the result. Saving a definition alone does not start a run.

`save_workflow({name, script, requireDurable:true})` checks V4 definition
syntax before writing. For legacy `.mjs`, it also checks statically visible
operation IDs and current saved child definitions. An incompatible script is
rejected without replacing the existing file. `list_workflows` exposes
`durableReady` and a SHA-256 `definitionDigest` of the root source. Legacy
readiness is a conservative static check: direct calls, explicit option
objects, and literal nested workflow names are required; computed IDs are
checked for validity and uniqueness at runtime. V4 IDs are validated and
scoped by the runtime at each step.

`/workflow <task>` asks the parent to generate stable IDs, save with
`requireDurable:true`, and start with `durable:true`. `/workflows` labels saved
definitions as `durable-ready` or `session-scoped` and starts compatible scripts
durably by default. Compatibility is rechecked at launch. A failed durable start
reports its error without falling back to a session-scoped execution. V4 typed
definitions run durably by default through the `workflow` tool; pass
`durable:false` to disable persistence. Legacy `.mjs` calls retain their
existing non-durable default.

`workflow({name, args, durable:true})` creates a separately persisted run. It
captures the root source, arguments, cwd, model default, concurrency, output
budget, and configured execution time limit. In V4, a paused human-input wait
and time between manual resume invocations do not consume the active worker's
time limit. Named nested sources are committed before
the script can receive them; later edits/deletions do not change replay.

Legacy durable runs require explicit `id` options for each `agent()` and
nested `workflow()` operation:

```js
const reviews = await parallel(
  args.files.map(
    (file) => () =>
      retry((n) => agent(`Review ${file}`, { id: `review/${file}/${n}` }), {
        attempts: 2,
      }),
  ),
);
return await workflow(args.summarizer, { reviews }, { id: "summary" });
```

Ids are unique within each definition invocation, 1–128 safe characters
(`A-Z`, `a-z`, digits, `.`, `_`, `:`, `/`, `-`; start alphanumeric). Map unsafe
file names to stable input indices if necessary. The nested call id namespaces
its children. Duplicate ids fail, even if the prompts match. In V4, the first
argument to `ctx.step()`, `ctx.agent()`, and related primitives is the stable
step identity; durable storage uses its full nested path plus the workflow
definition hash.

## Retry is explicit

The legacy `retry(work, {attempts:3, retryOnNull:true})` invokes `work(attempt)` with a
one-based attempt number. Total attempts must be an integer from 1 through 10.
Thrown failures and `null` retry by default; `false`, zero, and empty strings do
not. Exhaustion returns the last `null` or throws the last exception. Cancellation
never retries. No implicit backoff or provider retry policy is added.

Separately, legacy `agent(prompt, {schema})` performs up to **three total
attempts** to repair invalid structured output. Ordinary agent errors are not
schema-retried. Combining outer retry with schema repair can therefore cause
multiple model calls per outer attempt. All calls retain workflow resource caps.

## Recovery and observation

Use `list_workflow_runs`, `get_workflow_status`, and `get_workflow_result` for
persisted runs; `resume_workflow({workflowId})` explicitly continues an interrupted
run. Use `async:false` on resume when you need its result immediately. Terminal
runs do not resume; rerunning a saved definition creates a new run.

Legacy recovery requires the same host, canonical working directory, Pi
session id, and Node major version. V4 project-scoped recovery requires the
same host, canonical working directory, and Node major version, and must be
started manually from a live Pi session. Both re-execute the immutable program from the beginning,
validates request identity, and delivers committed responses in their recorded
global order, including nested loads and output-token deltas. It does not
serialize VM stacks or closures. Divergence terminates the host worker and
cannot be hidden with `try/catch`, `parallel()`'s null handling, or `retry()`.

A live process-backed attempt is adopted from its private manifest and immutable
artifact stream; the launch wrapper has a one-use start receipt. A cancelled
attempt cannot be started by a delayed launch. Durable process launch errors do
not fall back to a second in-process agent. Already-started process children may
continue while the parent is absent, but **no new orchestration runs without Pi**.
Continuity transitions interrupt the controller; `new`/`fork` cancel owned work.
Terminal durable runs stop their attempt wrappers; they do not retain idle
children as reusable interactive conversations. A persisted launch without a
verified start receipt is an explicit recovery-required state, not permission
to send another command to an old pane. Inspect the queued launch or cancel
the run before replacing it. A crash before pane identity was persisted can
leave an idle, unstarted pane requiring manual cleanup; it cannot start agent
work because dispatch follows manifest persistence.

The parent receives phase/counter updates and a final result reference, not
intermediate prompts and answers. Durable aggregates use the current completion
coordinator, including human-priority delivery, group barriers, and persisted
result-consumption receipts. Recovery never imports another session's runs.
If a persisted completion-group file is unreadable, grouped delivery stays
blocked until recovery succeeds; independent completions remain deliverable.

## Failure and cancellation contract

- Committed agent outcomes replay without another agent call. An interrupted
  in-process call or a crash after an external action but before its outcome is
  committed can repeat work. There is **no exactly-once side-effect guarantee**.
  Use read-only agents or application-level idempotency for irreversible work.
- A V4 `ctx.step()` callback that is interrupted before its completed value is
  committed will run again on resume. Keep custom callbacks deterministic and
  idempotent; a step boundary does not make side effects transactional.
- Usage is recorded, not inferred from model prose. Uncommitted attempts can
  leave unknown usage; recovered totals are lower bounds, not billing guarantees.
- `cancel_workflow` durably records cancellation intent. Process wrappers consume
  their exact attempt's cancellation marker and terminate their child process
  group. A persisted pane id alone never authorizes killing a recovered pane.
  Cancellation cannot undo earlier writes, remote requests, or independently
  detached descendants. Inspect cancellation state rather than assuming every
  external effect has stopped immediately.
- A live controller lock is never stolen on a timer. Unknown ownership,
  malformed state, storage failures, and complete corrupt journal records fail
  closed. Only an incomplete final journal line is truncated during recovery.
  A crash while acquiring the short `claim.json` lock needs operator inspection
  of the dead controller before removing that exact claim file; do not delete
  a live owner's files or guess from timestamps.

## Storage and limits

Runs live beneath `~/.pi-subagentura/workflow-runs/v1/<scope-hash>/wfd_<id>/`.
Directories are mode 0700 and files 0600. Journals contain private source,
arguments, prompts, and outputs; do not commit them or share them as telemetry.
The format is new and does not import the removed experimental plan store.

Writes are serialized and fsynced before acknowledging a response to the
worker. Response offers establish the worker's exact request frontier before
the response is committed and released. Attempt manifests precede command
dispatch. The runtime retains the existing 1,000-agent and 4,096-item caps and
adds an 8,192-operation transcript cap, a 2 MiB serialized-value limit, and a
256 MiB journal limit. The default budget remains 100 billion completed output
tokens and the wall deadline remains 100 hours; choose a practical lower budget.

Runs are local and manually recoverable, not remote jobs. There is no daemon,
always-on coordinator, automatic recovery loop, declarative plan surface, or
transaction with agent-controlled external systems.

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
generation. Supported erasable syntax includes explicit generic calls to
`defineWorkflow()` and schema helpers. Runtime imports are limited to named
`defineWorkflow` and `schema` imports from `pi-subagentura/workflow`. Type-only
imports are erased. Other runtime imports, dynamic imports, `import.meta`, and
additional module exports are rejected. The worker uses `effect@4.0.0-rc.117`
internally; Effect types and values are not exposed to workflow authors.

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
`"collect"` returns structured task results for failed branches. On `ctx.step()`,
a nested `policy.failure` takes precedence over its flat `failure`; if that
typed step policy may collect, its return type includes the failure outcome.
Step budgets are output-token limits checked after each step settles, including
failed attempts; budget failures do not trigger retries. Structured error
categories survive nested calls. A timeout already collected or caught is not
rethrown merely because cancellation acknowledgement settles later.

### Read-only agent tool policy

V4 `ctx.agent()` options may set `readOnly: true`. The effective capability is
snapshotted per agent call; omitted or false preserves the existing default
model-facing tool set. This restricts model-facing tool dispatch to exactly Pi
`read`, `grep`, `find`, and `ls`; `edit`, `write`, `bash`, `powershell`,
recursive subagent/workflow tools, and arbitrary extension tools including
`mcp__*`, `list_mcp_resources`, `list_mcp_resource_templates`, and
`read_mcp_resource` are unavailable. In-process native schema capture
additionally permits the internal `structured_output` return tool.

This is not an OS sandbox or path-confinement mechanism. Allowed file tools are
not restricted to paths named in the prompt, and host/extension code continues
to run with the same OS-user access. Prompt organization such as shared
`# Goal` / `# Contract` and per-agent `# Target` / `# Change` / `# Acceptance`
does not enforce semantic scope. The workflow's existing step records remain
the progress source; this adds no separate ledger or scheduler.

Process-backed read-only children return final assistant prose/JSON directly;
they cannot use the ordinary `write`/shell output handoff. The trusted host
captures their final output into the existing artifact before authoritative
settlement. The process-selected SDK schema fallback deliberately remains text
JSON; the parent workflow extracts and validates the captured result against
the schema. This host-owned capture is separate from model-facing tool access.

`readOnly` does not change the existing isolation default. If a non-durable
process launch is unavailable, in-process fallback retains the restriction;
durable process launch fails closed rather than falling back to an unrestricted
child. Schema-repair retries, outer retries, durable attempts, and recovery
preserve the effective policy. Durable step/cache compatibility and attempt
manifests include that policy, so a stored result with a different capability
is incompatible and a mismatched process attempt cannot be adopted as a
restricted agent.

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

Pass V4 module source to the direct `workflow` tool. `durable:true` selects
project-scoped persistence; omitted or `durable:false` uses the session-scoped
in-memory engine. Saved definitions selected through `/workflows` also run
session-scoped. Use durable run tools to list, inspect, cancel, retrieve, or
resume persisted runs. Recovery is manual via `resume_workflow` from a live Pi
process; no daemon is provided. Recovery re-executes the same source from the
beginning and reuses a completed step only when its stable path, input, policy,
and definition hash still match.
Changing the source invalidates that compatibility and may run the step again.
Agent result compatibility includes the captured prompt/output contract, model, persona,
isolation, thinking level, and read-only policy; equivalent defaults are
normalized. Committed output usage is charged once to the global total while
remaining attributed to its step. Replay retains logical schema-error counts
and the original caught failure when persistence and reuse are enabled and
compatibility matches.

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
artifact total to 64 MiB. Artifact identity distinguishes text and JSON
encoding even when their bytes match. Step values are limited to 512 KiB.

Step snapshots omit inputs, policies, outputs, and human answers; the private
run journal contains source, arguments, prompts, answers, and step outputs and
must not be shared as telemetry.

`ctx.ask()` and `ctx.gate()` can pause a V4 run for human input. With
`async:false`, the workflow tool collects the answer directly in Pi's UI. For
background runs, inspect the waiting step with workflow status/list tools, then
use `respond_workflow_input({workflowId, path})`. Pi presents the question or
approval in its UI and records the answer before execution continues. Durable
runs write it to the project-scoped store; session-scoped `/workflows` runs
keep it in memory. Status/list tool content exposes pending paths and bounded
actionable `respond_workflow_input` calls without answers or other private
values. Responses include at most 256 whole paths in total and share a 16 KiB
serialized-action budget across all listed runs. Omission counts are accurate,
and each omitted run includes the exact `get_workflow_status` selector.
Answering visible inputs permits the next poll to expose additional paths.
The answer is private run data; it is not included in the step summary. Legacy
`.mjs` workflows still cannot pause for interactive input.

## Definitions and runs are different

`save_workflow` stores a reusable definition. `inspect_workflow` reads/parses
it without running agents. Saved definitions launched through `/workflows` run
session-scoped for both legacy `.mjs` and V4 definitions; the V4 engine uses
in-memory, session-owned state. Direct legacy `.mjs` workflow calls remain
session-scoped unless `durable:true` is passed. Direct V4 workflow-tool
launches use project-scoped storage with `durable:true`; `durable:false` or an
omitted flag leaves them session-scoped in memory. Async remains the default;
`async:false` waits for the result. Saving a definition alone does not start a run.

`save_workflow({name, script, requireDurable:true})` checks V4 definition
syntax before writing. For legacy `.mjs`, it also checks statically visible
operation IDs and current saved child definitions. An incompatible script is
rejected without replacing the existing file. `list_workflows` exposes
`durableReady` and a SHA-256 `definitionDigest` of the root source. Legacy
readiness is a conservative static check: direct calls, explicit option
objects, and literal nested workflow names are required; computed IDs are
checked for validity and uniqueness at runtime. V4 IDs are validated and
scoped by the runtime at each step.

`/workflow <task>` opts into authoring, not durable execution. By default the
parent assesses suitability, authors a workflow with the V4 typed API where
its step APIs fit or the legacy `.mjs` API where simpler, then semantically
reviews the exact source in a distinct pass before saving and running it
session-scoped.
Infeasible work or unresolved material findings are not saved or started.
Explicit authoring normally needs no routine approval unless the user or task
risk warrants it. When persisted restart recovery is explicitly requested,
author a suitable V4 definition with stable contracts and IDs, review the exact
source and revisions, save with `requireDurable:true`, and launch the direct
workflow tool with `durable:true`.

This is prompt guidance, not an enforced semantic-review or authorization
state machine. `save_workflow` checks that source parses and, with
`requireDurable:true`, passes static durable-readiness checks; it cannot prove
suitability, semantic correctness, or that review occurred. `inspect_workflow`
reads/parses saved source without executing agents, allowing the parent to
confirm the reviewed definition is what will run.

`/workflows` labels saved definitions `durable-ready` or `session-scoped` and
launches compatible definitions session-scoped. Readiness is capability
metadata only. Use `resume_workflow({workflowId})` from a live Pi process in
the same project after interruption; recovery is manual. Direct V4 calls use
project-scoped storage only with `durable:true`; omitted or `durable:false`
remains session-scoped. Direct legacy `.mjs` calls retain their session-scoped
default and require `durable:true` for persistence. Failed explicit durable
starts report their error without falling back. An opted-in durable call such as
`workflow({name, args, durable:true})` creates a separately persisted run. It
captures the root source, arguments, cwd, model default, concurrency, output
budget, and configured execution time limit. In V4, a paused human-input wait
and time between manual resume invocations do not consume the active worker's
time limit. Named nested sources are committed before the script can receive
them; later edits or deletions do not change replay.

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
ordinary parent-turn rules. Their mixed-source membership is preserved, and successful or cancelled members remain behind the group barrier. Once the authoritative snapshot is repaired, only its validated members count toward the barrier; previously delivered terminal errors are reconciled once. Independent completions remain deliverable.

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
coordinator, including its ordinary parent-turn dispatch rules, group barriers,
and persisted result-consumption receipts. A manual durable result read is
recorded against its initiating owner; a replacement session cannot inherit
that receipt.
Fallback receipts are reconciled when completion expectations are restored
later. Each receipt matches the exact completion identity, source, and turn,
and never suppresses an unrelated later-turn completion.

Recovery never imports another session's runs. If persisted completion-group
recovery is unavailable, group errors remain eligible for delivery under the
ordinary parent-turn rules. While recovery is blocked, errors retain their original group ID without guessed group counts; successful and cancelled members remain fenced. The mixed-source membership is preserved. After authoritative sync or async snapshot installation and accepted-member repair, only validated snapshot members count toward the barrier, and held terminal errors are reconciled once. The recovery fence is process-global across coordinator module graphs. Independent completions remain deliverable.

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
- For non-durable process-backed cancellation, interactive artifact and
  pane-termination cleanup are best effort. A cleanup failure does not discard
  usage already persisted in the child Pi session file, including token and cost
  fields; the actual cancellation snapshot receipt is forwarded when captured.
  Durable cancellation intent or attempt-marker write failures remain explicit
  errors rather than being downgraded to best-effort cancellation.
- `cancel_workflow` and `/cancel-all-flows` persist durable cancellation intent
  before aborting owned work. When snapshots are enabled, cancel-all captures
  receipts for owned work, including durable process attempts, before aborting.
  A failed intent or attempt-marker write reports the workflow as failed to
  cancel and keeps its owned in-process/process-backed work protected and
  retryable. Both cancel-all entry points abort their foreground tool signal
  only after all durable cancellations succeed; if no durable workflow is
  present the normal foreground abort still occurs. Retrying after the run-level
  intent is recorded still retries the per-attempt markers.
- Process wrappers consume the exact attempt's cancellation marker and
  terminate their child process group. A persisted pane id alone never
  authorizes killing a recovered pane.
  Cancellation cannot undo earlier writes, remote requests, or independently
  detached descendants. Inspect cancellation state rather than assuming every
  external effect has stopped immediately.
- A live controller lock is never stolen on a timer. Unknown ownership,
  malformed state, storage failures, and complete corrupt journal records fail
  closed. Resume rejects an incomplete final journal line and preserves its
  bytes for inspection; it never truncates an ambiguous append.
  A crash while acquiring the short `claim.json` lock needs operator inspection
  of the dead controller before removing that exact claim file; do not delete
  a live owner's files or guess from timestamps.

## Storage and limits

Runs live beneath `~/.pi-subagentura/workflow-runs/v1/<scope-hash>/wfd_<id>/`.
Directories are mode 0700 and files 0600. Journals contain private source,
arguments, prompts, and outputs; do not commit them or share them as telemetry.
The format is new and does not import the removed experimental plan store.

Run creation syncs newly created store directories top-down before accepting
the run. A directory sync failure blocks creation. Run listings isolate an
unreadable journal as unavailable while retaining other safe run summaries;
they do not rewrite damaged data. Historical failed agent RPCs replay a generic
failure message without redispatch, while preserving the original response and
closed failure classification in the journal. Non-agent RPC replay retains its
recorded failure meaning.

Writes are serialized and fsynced before acknowledging a response to the
worker. Response offers establish the worker's exact request frontier before
the response is committed and released. Attempt manifests precede command
dispatch. The runtime retains the existing 1,000-agent and 4,096-item caps and
adds an 8,192-operation transcript cap, a 2 MiB serialized-value limit, and a
256 MiB journal limit. The default budget remains 100 billion completed output
tokens and the wall deadline remains 100 hours; choose a practical lower budget.

If an append or its fsync fails, the next write verifies the journal against
the last committed prefix. It syncs an exact complete pending line or retries
only when the file still ends at that prefix. Partial, corrupt, or unexpected
tails remain blocked for explicit recovery; committed bytes are never rewritten.

These are completed, path-specific repairs, not a broader crash-consistency
guarantee. Further durability, storage, and crash-consistency hardening is
deferred to `pi-durable`. Atomic group-registration/acceptance windows,
additional process-attempt directory-entry durability, damaged-journal
isolation during startup restoration, atomic visibility of multi-attempt
cancellation markers, and full member-expression coverage in
durable-readiness preflight are not claimed as validated recovery guarantees.

Runs are local and manually recoverable, not remote jobs. There is no daemon,
always-on coordinator, automatic recovery loop, declarative plan surface, or
transaction with agent-controlled external systems.

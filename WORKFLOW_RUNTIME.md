# Code workflow runtime

A workflow is trusted agent-authored JavaScript with ESM-style literal `meta`
exports. Its executable body owns control flow and intermediate values. The
runtime is neither Orchestratorv2's interactive router nor a declarative todo
engine. Imports, `require`, filesystem APIs, current time, and randomness are
not script globals. The VM is a determinism aid, **not a security boundary**.

## Definitions and runs are different

`save_workflow` stores a reusable definition. `inspect_workflow` reads/parses it
without running agents. `workflow({name, args})` executes that definition with
the existing session-scoped behavior. Async remains the default; `async:false`
waits for the result. Saving a definition or running asynchronously does not
imply durability.

`workflow({name, args, durable:true})` creates a separately persisted run. It
captures the root source, arguments, cwd, model default, concurrency, output
budget, and absolute wall deadline. Named nested sources are committed before
the script can receive them; later edits/deletions do not change replay.

Durable runs require explicit operation identities:

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
its children. Duplicate ids fail, even if the prompts match. Helpers, loops,
maps, computed saved names, parallel fan-out, streaming pipelines, and one level
of nesting remain ordinary executable code—not a static graph compiler.

## Retry is explicit

`retry(work, {attempts:3, retryOnNull:true})` invokes `work(attempt)` with a
one-based attempt number. Total attempts must be an integer from 1 through 10.
Thrown failures and `null` retry by default; `false`, zero, and empty strings do
not. Exhaustion returns the last `null` or throws the last exception. Cancellation
never retries. No implicit backoff or provider retry policy is added.

Separately, `agent(prompt, {schema})` already performs up to **three total
attempts** to repair invalid structured output. Ordinary agent errors are not
schema-retried. Combining outer retry with schema repair can therefore cause
multiple model calls per outer attempt. All calls retain workflow resource caps.

## Recovery and observation

Use `list_workflow_runs`, `get_workflow_status`, and `get_workflow_result` for
persisted runs; `resume_workflow({workflowId})` explicitly continues an interrupted
run. Use `async:false` on resume when you need its result immediately. Terminal
runs do not resume; rerunning a saved definition creates a new run.

Recovery requires the same host, canonical working directory, Pi session id,
and Node major version. It re-executes the immutable program from the beginning,
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

## Failure and cancellation contract

- Committed agent outcomes replay without another agent call. An interrupted
  in-process call or a crash after an external action but before its outcome is
  committed can repeat work. There is **no exactly-once side-effect guarantee**.
  Use read-only agents or application-level idempotency for irreversible work.
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

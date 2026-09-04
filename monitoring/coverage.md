# User experience and monitoring coverage review

The extension needs adoption, reliability, performance, and recovery measurements
together. PostHog supports those aggregate questions with the current anonymous
session/tree identity. A successful task is evidence of technical completion,
not proof that its answer satisfied a person.

## Metric map

Event names below have the `pi_subagentura_` prefix. **Added** means instrumentation
in this PR; it requires a released package before the live project can observe it.

| Journey stage                                     | Signals and dimensions                                                                                                              | Decision supported                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Start using the extension                         | `session_started`; mode, package version, schema                                                                                    | Session activity and adoption of execution modes. Never label these counts DAU or installations.                                            |
| Discover agents, models, workflows, and artifacts | **Added:** `operation_started/completed` for all discovery and status tools                                                         | Which features get used, repeated polling, returned errors, and handler latency.                                                            |
| Invoke any extension feature                      | **Added:** all 24 tools, eight commands, two shortcuts; surface, operation, root/child role                                         | Separate command and shortcut journeys from model-invoked tools and nested child activity.                                                  |
| Launch agents                                     | `agent_created`, `agent_spawn_failed`; execution, mux, invocation, model, depth, completion policy, failure stage, startup duration | Diagnose capacity/depth, context/model, mux/launch, persistence/registration, and shutdown failures.                                        |
| Run delegated work                                | `task_started/completed`; status, terminal reason, elapsed time, bounded message count                                              | Separate normal completion, agent errors, process exit, timeout, explicit/parent cancellation, and session transitions.                     |
| Run workflows                                     | `workflow_started/completed`; invocation, async, completion policy, status, terminal reason, fan-out, error count, duration         | Workflow failures, partial results, cancellation, scale, and slow execution. The workflow runner owns exactly one aggregate lifecycle pair. |
| Receive background results                        | `completion_delivered`; delivery kind, batch count, maximum known completion age                                                    | Delivery throughput and perceived delay, including intentional parent/group waiting.                                                        |
| Diagnose delivery failures                        | **Added:** `completion_delivery_failed`; notice persistence, manifest dispatch, exhausted retries                                   | Failure episodes that can leave users without a completion manifest. Counts are episodes per stage, not affected jobs.                      |
| Read results                                      | `result_read`; source, outcome, completion age; **added** reader operation timing                                                   | Separate unavailable/running/empty results, cancelled waits, timeouts, repeated consumption, underlying failed work, and handler errors.    |
| Follow up or cancel                               | `interactive_message_sent`, task terminal cancellation reasons; **added** send/cancel tools, cancel-all command/shortcut            | Frequency of steering, failed sends, cancellation behavior, and control operation latency.                                                  |
| Restore a session                                 | `session_recovered`; reason and bounded state counts; **added** `session_setup_failed`                                              | Failed telemetry persistence, routing/state/wake recovery and unknown recovered state.                                                      |
| Assess metric quality                             | schema, package version, missing/unknown duration buckets                                                                           | Compare equivalent releases and distinguish unavailable measurements from fast operations.                                                  |

## Reading errors correctly

`operation_completed.outcome` describes the handler boundary:

- `returned`: returned normally. This includes starts, running status, cancelled
  work, a dismissed command picker, and other handled outcomes.
- `reported_error`: a tool returned `isError: true`. This can include invalid
  input, missing state, or a required confirmation; it is not automatically a bug.
- `threw`: an exception escaped the handler. No exception text, class name,
  stack, object, or cause is uploaded.
- `aborted`: the handler threw while its tool abort signal was set. This does not
  establish that cancellation caused the exception.

`result_status` is an independently normalized, closed status category. Unknown
or missing statuses stay `unknown`; content is never inspected to guess success.
Command/shortcut results always have `result_status=unknown`. The wrapper preserves
original return objects and thrown errors, and does not invoke property getters.
Existing task/workflow outcome events remain the authority for delegated work.

For operational triage, start with escaped exceptions, setup failure stages, and
delivery retry exhaustion. Investigate invalid inputs and confirmation prompts as
usability signals. Evaluate timeouts and cancellations separately from errors.
Use completed handler events as the denominator for handler outcome proportions,
segmented by operation, surface, role, and release; do not divide starts and
completions across arbitrary time windows. No invocation IDs are collected.

## What this cannot establish

- **Individual retention or satisfaction:** identity is random per session/tree.
  It cannot connect a website visitor to an install, or identify repeat users.
  Outcome quality needs voluntary feedback and representative task evaluations.
- **A complete trace:** overlapping jobs share a tree correlation; no agent,
  workflow, tool-call, or persistent user identifiers are sent. Funnels can match
  different jobs within a tree. Ingestion timing can also reorder close events.
- **Every failure:** Pi schema/tool resolution rejection before handler entry,
  extension load failures, process crashes, abrupt exits, and host/provider
  internals can escape these events. Handled warning paths and individual
  supervisor buttons are not exhaustively instrumented by entry-point wrappers.
- **All delivery internals:** asynchronous wake exhaustion, overflow ledger, and
  consumption-receipt persistence have separate local diagnostic paths. The new
  delivery event covers notice/manifest retries only.
- **Transport completeness:** capture is fire-and-forget with a 1.5-second
  deadline and no queue/retry. HTTP failures are not independently monitored.
  Low traffic can mean low use, opt-outs, offline clients, or transport loss.
- **Resource usage:** CPU, memory, token usage, cost, provider request retries,
  first-token latency, and raw exception traces are not collected. Some usage
  totals exist locally, but the published privacy contract excludes uploading them.
- **Production-only data:** tests/CI opt out by default; there is no trustworthy
  release-channel dimension distinguishing every manually run development build.

## Rollout and follow-through

1. Merge through the normal review and required CI checks, then release. The live
   dashboard already uses existing events; pending operation/failure charts must
   be validated against real post-release events before activation.
2. Establish a release-specific baseline with sample counts and coverage. The
   dashboard shows p95 to keep breakdown legends clear; change the aggregation
   to median for typical performance during an investigation.
3. Configure alert recipients and thresholds after the baseline. Use failure
   episodes and escaped handler exceptions first. Traffic absence is a weak alert
   without an independent ingestion check in a separate test project.
4. Add opt-in feedback and local diagnostic exports if aggregate categories do
   not explain reports. Keep prompts, outputs, raw stacks, paths, and identities
   out of default telemetry. PostHog replay or automatic exception capture would
   require a separate collection design for this terminal extension.
5. Extend coverage to specific warning paths or supervisor actions when observed
   incidents justify it. Adding another vendor alone cannot supply missing
   instrumentation or demonstrate answer quality.

The tests exercise normal and error returns, cancellation, opt-out, late results
across session replacement, hostile result getters, all registered entry-point
names, delivery recovery/suppression, payload privacy, and clean npm installation.

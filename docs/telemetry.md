# User-impact telemetry and PostHog reports

The event schema is defined by `TELEMETRY_SCHEMA_VERSION` in
[`src/telemetry.ts`](../src/telemetry.ts). See [CHANGELOG.md](../CHANGELOG.md)
for release attribution. Schema v6 adds logical launch resolution, closed traffic
provenance, and attributed runtime observations. It cannot reconstruct those
facts for historical schema-v5 events.

## Measurement contract

| Measurement                                 | Unit                                                     | Meaning                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session_started`                           | Fresh root logical session/tree                          | Not a person, installation, process, reload, or resume                                                    |
| `operation_completed`                       | Entered tool/command/shortcut handler                    | Handler result, not proof the requested objective succeeded                                               |
| `agent_spawn_failed`                        | Rejected technical launch attempt                        | May precede an accepted automatic fallback                                                                |
| `agent_created`                             | Accepted in-process agent or registered interactive pane | Actual execution/backend volume                                                                           |
| `agent_launch_resolved`                     | Requested child launch                                   | Exactly one observed resolution, including its automatic fallback                                         |
| `task_completed`, `unit=job`                | In-process job                                           | Terminal execution outcome                                                                                |
| `task_completed`, `unit=turn`               | Interactive turn                                         | One pane can execute multiple turns                                                                       |
| `workflow_completed`                        | Whole workflow invocation                                | Aggregate, not another child task                                                                         |
| `runtime_failure`, `failure_kind=mux_probe` | One sustained workflow-waiter pane episode               | A waiter blocked after liveness grace; not a task count, confirmed process death, or backend-outage count |
| `completion_delivered`                      | Manifest/notification dispatch batch                     | `count` is the bounded number of included completion records                                              |
| `result_read`                               | Result read                                              | Not the same unit as dispatch batches or completion records                                               |

Do not add these units together. A workflow tool call can request several child
launches, and schema retries can request further child work. Rejected pre-start
launches need not produce a task completion. Daily start and terminal events are
not a linked cohort. A runtime success does not measure answer usefulness.

### Logical launch resolution

`agent_launch_resolved.outcome` is one of:

- `started`: accepted without automatic fallback;
- `recovered`: automatic fallback accepted the launch;
- `rejected`: the logical launch did not get accepted;
- `cancelled`: cancelled before acceptance.

`recovered` does not mean the eventual task succeeded. The task can later return
a provider error. A later LLM/tool call is a new request, not inferred recovery.
Automatic mux candidate selection is not itself a rejected launch attempt.

The event carries `requested_execution` (`in-process` or `interactive`),
`requested_mux` (`none`, `auto`, `tmux`, `zellij`, or `herdr`), accepted `execution`
when known, `mux` (`none`, `unknown`, `tmux`, `zellij`, or `herdr`),
`invocation_source`, `async`, bounded depth/bucket, `completion_policy`, and
`fallback_attempted`. An unresolved interactive backend is `unknown`, not
`none`; an in-process path needs no mux and uses `none`. Optional
`initial_failure_stage` / `initial_failure_operation` explain the first rejection,
while optional `final_failure_stage` / `final_failure_operation` explain a final
rejection.
These reuse the closed launch-stage and operation enums, never exception text.
Launch `duration_ms` and `duration_bucket` use the existing rounded, bounded
representation. Timing ends at acceptance/rejection, not task completion.

If shutdown makes a prepared fallback decline to start, its resolution is
`cancelled` without an accepted `execution`. Keep an already resolved initial mux
in that cancellation record; do not replace known backend attribution with
`unknown`.

An empty inherited conversation is an explicit rejected tool result. A live
interactive child with an initial routing-metadata persistence warning remains
an accepted launch and returns `details.status=degraded`; operation telemetry
records that bounded status without inspecting the warning text.

### Runtime observations

Transient unknown-liveness probes in the artifact poller remain local debug
observations, logged once per pane episode with the selected mux and closed
failure reason; they do not produce anonymous `runtime_failure` events. The
poller keeps reading artifacts while liveness is uncertain, so terminal
completions observed during the existing grace are still collected.

A `workflow_waiter` emits `runtime_failure`, `failure_kind=mux_probe`, only after
unknown-liveness probes exhaust the existing grace and the waiter must return
blocked. Its measurement unit is one waiter-blocking pane episode, not a task or
unique backend-failure count. Repeated waiter failures within the same unrecovered
artifact episode dedupe; known liveness or full artifact retirement clears it.
Separate panes remain separate observations, and the workflow aggregate does not
add another event for the same waiter failure.

These records include selected `execution`/`mux`, closed `reporter`
(`artifact_poller`, `workflow_waiter`, or `workflow_runner`), and closed `impact`
(`degraded`, `blocked`, or `unknown`) when applicable. New mux-probe events use
`impact=blocked` to show that the waiter could not continue; this does not prove
the pane process is dead. Historical mux-probe events with `impact=unknown`
describe liveness uncertainty and must not be reinterpreted as a blocked waiter.
Keep the existing bounded sustained-probe-failure policy separate from telemetry:
it remains a mux-probe failure, not a fabricated dead/process-exit result. Other
runtime failure kinds retain their existing reporting behavior.

Provider task errors remain a broad category when the runtime has no trustworthy
structured subtype. Do not infer authentication, rate limiting, or billing from
arbitrary error text, and never upload that text to fill the gap.

## Provenance and privacy

Every event includes `traffic_origin`: `usage`, `development`, `test`, or
`unknown`. The explicit `PI_SUBAGENTURA_TELEMETRY_ORIGIN` environment marker is
trimmed and case-normalized. Missing or invalid provenance is `unknown`, not a
production classification. `usage` is an explicit classification, not a unique
human identity or independently verified production environment.

```bash
PI_SUBAGENTURA_TELEMETRY_ORIGIN=usage pi
PI_SUBAGENTURA_TELEMETRY_ORIGIN=development pi
PI_SUBAGENTURA_TELEMETRY_ORIGIN=test pi # normal telemetry is disabled
```

Existing privacy/offline/CI/Vitest/test and negative launch opt-outs stay
stronger than provenance. Marking a run `test` also disables normal capture;
no origin setting re-enables another opt-out. An explicitly injected collector
can inspect test payloads without runtime network submission.

Closed origin is passed through the explicit one-use child bootstrap and optional
root telemetry metadata. On recovery, a present current marker overrides stored
origin; invalid/empty current input becomes `unknown`; an absent marker may reuse
stored origin. Old schema-v2 state without this optional field remains readable.

`telemetry_session_id` and PostHog `distinct_id` are the same random logical
session/tree UUID. They are not Pi/session/agent/job/workflow IDs or a stable
installation/user identity. No new per-request identifier is sent. Tasks, prompts,
arguments, outputs, errors/stacks, provider responses, and paths remain excluded.
Opt-in local debug logs are separate and may contain sensitive arguments; do not
automatically upload them as anonymous telemetry.

Capture remains best-effort: no queue/retry, a 1.5-second timeout, and no durable
capture acknowledgement. All reports describe observed telemetry-enabled traffic.
Missing completion events do not by themselves prove a crash, hang, or data loss.

## Repository test isolation

Normal CI/Vitest opt-outs are not a transport guarantee: a fixture can construct
an enabled telemetry session directly. Standard Vitest workers therefore guard
the default global `fetch` transport for PostHog service hosts. Unmocked attempts
are rejected and fail the test or suite lifecycle even when `captureTelemetry`
swallows the transport rejection.

Ordinary behavior fixtures disable telemetry. Capture assertions explicitly
enable their session and install in-memory collectors. Mock restoration preserves
the guarded default, while suite-scoped local collectors remain supported. The
behavioral regression runs actual Vitest consumers with a fake underlying
transport and an independent Node-level network fence, including a consumer that
must fail after its capture callback returns.

This repository test-harness guard does not change published runtime opt-outs,
provide an OS network sandbox, or retroactively classify unknown historical
traffic. Terminal E2E children retain their separate network guard.

## Report setup

Create three SQL insights using the queries below. PostHog's
[`{filters}` placeholder](https://posthog.com/docs/sql) supplies the saved insight's
date/property filters. Select UTC for the reporting date range. Keep schema,
release, mode, and traffic-origin populations explicit; never silently relabel
unknown or historical traffic as production.

For the adoption query, shared filters may constrain the date range and common
release/origin/mode fields, but must not constrain `event`, `invocation_source`,
`execution`, or `mux`: doing so would also filter its active-session denominator.
Filter the final feature rows instead. Each query's release/origin groups are
separate populations; a session/tree can appear under multiple releases after an
upgrade. Session reach across features overlaps and need not sum to 100%.

### 1. Reliability: resolved launches and terminal execution

Show each `measurement` separately. Do not calculate a combined error rate.
The stage/operation columns distinguish a recovered launch's initial problem
from a final launch rejection or execution-stage failure.

```sql
WITH observed AS (
  SELECT
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS session_id,
    CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN 'workflow' ELSE properties.invocation_source END AS invocation_source,
    coalesce(properties.error_category, 'not_applicable') AS error_category,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.final_failure_stage, properties.initial_failure_stage, 'none')
      ELSE coalesce(properties.error_stage, 'none') END AS diagnostic_stage,
    coalesce(properties.final_failure_operation, properties.initial_failure_operation, 'none')
      AS diagnostic_operation,
    CASE
      WHEN event = 'pi_subagentura_agent_launch_resolved' THEN 'launch'
      WHEN event = 'pi_subagentura_workflow_completed' THEN 'workflow'
      WHEN properties.unit = 'job' THEN 'task_job'
      WHEN properties.unit = 'turn' THEN 'task_turn'
      ELSE 'unknown_task_unit'
    END AS measurement,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN properties.outcome ELSE properties.status END AS outcome,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN properties.requested_execution ELSE 'not_applicable' END AS requested_execution,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN properties.requested_mux ELSE 'not_applicable' END AS requested_mux,
    CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN 'not_applicable' ELSE coalesce(properties.execution, 'unknown') END AS execution,
    CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN 'not_applicable' ELSE coalesce(properties.mux, 'unknown') END AS mux
  FROM events
  WHERE {filters}
    AND properties.schema_version = 6
    AND event IN (
      'pi_subagentura_agent_launch_resolved',
      'pi_subagentura_task_completed',
      'pi_subagentura_workflow_completed'
    )
)
SELECT measurement, release, traffic_origin, invocation_source, error_category,
  diagnostic_stage, diagnostic_operation, requested_execution,
  requested_mux, execution, mux, outcome,
  count(*) AS records,
  count(DISTINCT session_id) AS affected_session_trees
FROM observed
GROUP BY measurement, release, traffic_origin, invocation_source, error_category,
  diagnostic_stage, diagnostic_operation, requested_execution,
  requested_mux, execution, mux, outcome
ORDER BY measurement, release, traffic_origin, records DESC
```

Suggested measures, after choosing one comparable population:

- launch rejection share: `rejected / (started + recovered + rejected)`;
  show cancellations separately;
- fallback dependence among accepted launches:
  `recovered / (started + recovered)`;
- task error share: `error / (success + error)`, separately for jobs and turns;
- workflow error and partial shares: use terminal non-cancelled workflows,
  keeping `partial` visible rather than silently merging it into success;
- affected logical session/trees: distinct IDs matching the chosen adverse
  outcomes, not a sum of per-row distinct counts.

Companion diagnostic panels should count `agent_spawn_failed` by stage/operation,
`operation_completed` by operation/outcome/result status, and `runtime_failure`
by kind/mux/reporter/impact. Keep impacts distinct: a new mux-probe event with
`blocked` means the workflow waiter exhausted its liveness grace, while
historical `unknown` means only that liveness was unavailable. Surface `degraded`,
explicit returned errors, thrown errors, and rejected inputs separately; an
invalid caller input is not automatically an unexpected product defect. Workflow
parsing, admission, or capacity rejection may occur before `workflow_started`,
so these handler and runtime panels are necessary even when there is no workflow
terminal record. Label attempts, handler outcomes, and pane observations
separately; none is another failed task.

### 2. Adoption: volume versus logical-session reach

`agent_launches` measures accepted-agent volume. `using_session_trees` counts
one logical tree once per feature/backend row. Its denominator includes all
observed active trees in the selected window, including continued sessions with
no new `session_started` event that day. It is not a unique-user percentage.
Backend mix should be compared within interactive execution; invocation source
and execution are different axes. `straight` mode does not mean no workflow was
used. The launch-resolution event can separately compare requested preference
with actual execution/backend; agent-created events show actual use.

```sql
WITH observed AS (
  SELECT event,
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS session_id,
    properties.invocation_source AS invocation_source,
    properties.execution AS execution,
    properties.mux AS mux
  FROM events
  WHERE {filters}
    AND properties.schema_version = 6
    AND startsWith(event, 'pi_subagentura_')
), active AS (
  SELECT release, traffic_origin,
    count(DISTINCT session_id) AS active_session_trees
  FROM observed
  GROUP BY release, traffic_origin
), accepted AS (
  SELECT release, traffic_origin, invocation_source, execution, mux,
    count(*) AS agent_launches,
    count(DISTINCT session_id) AS using_session_trees
  FROM observed
  WHERE event = 'pi_subagentura_agent_created'
  GROUP BY release, traffic_origin, invocation_source, execution, mux
)
SELECT a.release, a.traffic_origin, a.invocation_source, a.execution, a.mux,
  a.agent_launches, a.using_session_trees, s.active_session_trees,
  round(100.0 * a.using_session_trees / nullIf(s.active_session_trees, 0), 1)
    AS session_reach_percent
FROM accepted a
JOIN active s ON a.release = s.release AND a.traffic_origin = s.traffic_origin
ORDER BY a.release, a.traffic_origin, a.agent_launches DESC
```

### 3. Data quality: provenance, schema, and unknowns

Include older schemas here so missing provenance/backend attribution remains
visible. A short workflow duration is not evidence that the run was a test.
Inspect origin coverage before claiming a production error rate. Any observed
`test` traffic warrants checking its capture source, because normal runtime
capture is suppressed for that origin.

```sql
SELECT
  coalesce(properties.$lib_version, 'unknown') AS release,
  coalesce(properties.schema_version, 0) AS schema_version,
  coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
  event,
  count(*) AS event_records,
  count(DISTINCT properties.telemetry_session_id) AS session_trees,
  sum(CASE WHEN properties.result_status = 'unknown' THEN 1 ELSE 0 END)
    AS unknown_operation_status_records,
  sum(CASE WHEN properties.failure_stage = 'unknown'
    OR properties.initial_failure_stage = 'unknown'
    OR properties.final_failure_stage = 'unknown'
    OR properties.error_category = 'unknown' THEN 1 ELSE 0 END)
    AS unknown_diagnostic_records,
  sum(CASE WHEN event = 'pi_subagentura_runtime_failure'
    AND properties.failure_kind = 'mux_probe'
    AND coalesce(properties.mux, 'unknown') = 'unknown' THEN 1 ELSE 0 END)
    AS unattributed_mux_probe_records
FROM events
WHERE {filters} AND startsWith(event, 'pi_subagentura_')
GROUP BY release, schema_version, traffic_origin, event
ORDER BY release, schema_version, traffic_origin, event
```

Track started/completed event volumes by operation as a coverage diagnostic,
not a matched-call failure count: there are no per-call IDs, active work can cross
the window, sessions can retire, and best-effort capture can lose either side.
Never divide result reads by manifest batches to produce a delivery percentage.
For dispatch latency, a manifest batch's recorded latency is its maximum known
completion age, not a latency sample for every included completion.

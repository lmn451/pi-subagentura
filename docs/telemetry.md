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

### Child backend versus terminal host

`mux` attributes the extension-managed child execution backend, not the terminal
hosting Pi. A tmux child remains `mux=tmux` inside Orca or Agterm; an in-process
child remains `mux=none`. On `agent_launch_resolved`, `requested_execution` and
`requested_mux` record the request, while `execution` and `mux` record the
resolved extension launch (or `unknown` where no backend was established).
These fields remain independent of the outer-host label. Nested or inherited
host, tmux and Zellij markers must not make these dimensions mutually exclusive
or select a target in place of an explicit mux choice.

The shared host-aware prompt is available in ordinary sessions, interactive
children and both orchestration modes. It follows the installed host skills for
runtime/topology discovery and supported launch mechanisms. Orca's `agent
launch` / supervised orchestration tools and Agterm's process-backed
`session new --command` plus pane mailboxes are host-managed operations; they do
not create subagentura-owned children. Do not manufacture `agent_created`,
`agent_launch_resolved`, task, artifact or completion records from host CLI
receipts. The host integrations add no native Orca or Agterm backend to
`subagent_interactive`.

Fresh root `session_started` records include the additive schema-v6
`session_host` dimension: `agterm`, `orca`, or `unknown`, regardless of whether
`mode` is `straight`, `orchestrator`, or `orchestrator_v2`. Earlier v6 releases
may omit it; a missing historical value means `unknown`, never a known non-host.
This is outer-host environment/provenance evidence for a logical root session,
not a person, installation, live terminal, current routing target, or proof that
a particular host-managed launch occurred. No persistent installation or user
identifier is created.

Orca attribution consumes only the complete, dedicated launch-origin stamp:
`ORCA_RUNTIME_SOURCE_ID`, `ORCA_RUNTIME_SOURCE_INCARNATION`, and
`ORCA_RUNTIME_SOURCE_PROFILE_PATH`. The Orca 1.4.245 bundled
`shared/runtime-source-env` contract describes these as which runtime launched
a process; `stampRuntimeSourceEnv` clears inherited stamps before setting the
new source. Validation matches trimmed, nonempty, at-most-4096-character fields,
rejects control characters, and requires an absolute platform-appropriate
profile path. Source ID and incarnation are opaque local validation inputs, not
uploaded identifiers.

Agterm attribution uses only the exact `AGTERM_ENABLED=1` marker documented by
[Agterm's installed skill](https://github.com/umputun/agterm/blob/master/plugins/agterm/skills/agterm/SKILL.md).
It is set for Agterm shells including the quick terminal; `TERM_PROGRAM=agterm`,
`AGTERM_SOCKET`, installed CLI/skill, or mux markers alone do not establish the
host. The marker is inherited by child processes, including long-lived servers,
so it is an environment observation rather than proof the app or target pane is
currently live. `TMUX` and `ZELLIJ_SESSION_NAME` do not change `session_host`.
When a complete Orca stamp and Agterm marker coexist, the single closed host
dimension cannot express their topology and resolves to `unknown`.

These checks are measurement-only, not live-process, foreground-terminal,
routing, cancellation or security authority. Missing, partial, malformed or
oversized Orca stamps and missing/non-exact Agterm markers resolve to `unknown`;
`unknown` is not a non-Agterm or non-Orca population. Neither source is
cryptographic proof against forged same-user environment variables. Native
extension-managed children do not emit root starts, and reload/resume preserve
logical-session suppression without reclassification.

Only telemetry-enabled fresh roots evaluate this pure environment-to-enum
classification. It runs no command, runtime probe, app launch, filesystem read,
or network request; it does not discover an installed CLI or use remote or
active-tab defaults. Existing opt-outs suppress classification and capture.
No raw stamp, marker, handle, version, path, host/Pi identifier, environment
value, prompt or argument is uploaded or logged. The random
`telemetry_session_id` remains the only cross-event correlation identifier;
`session_host` itself is sent only on `session_started`. For extension-managed
spawns, analytics may join that root host evidence to `agent_launch_resolved` by
`telemetry_session_id` and group by the existing requested/resolved execution
and mux fields. This does not measure or infer spawn mechanisms for workers
launched externally by Orca or Agterm.

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

Create six SQL insights using the queries below. PostHog's
[`{filters}` placeholder](https://posthog.com/docs/sql) supplies the saved insight's
date/property filters. Select UTC for the reporting date range. Keep release,
schema, mode, and traffic-origin populations explicit; never silently relabel
unknown or historical traffic as production.

Use shared saved filters only for UTC date, release, traffic origin, and mode.
Do not filter on schema when viewing data quality, which must retain older
schemas. For adoption, filters must not constrain `event`, `invocation_source`,
`execution`, or `mux`: those would shrink its active-tree denominator. The query
applies feature dimensions only after collecting all observed package events.
Each release/schema/origin/mode group is a separate population; a tree can appear
under multiple releases after an upgrade. Tree identifiers are used only inside
aggregations and are never returned.

These are counts of observed events, not a complete census. Capture is
best-effort, and date windows can split lifecycles. Distinct-tree counts across
rows overlap and must not be summed to make a global tree count.

### 1. Reliability: logical launch, task, and workflow outcomes

This report keeps four measurement units separate: one logical launch
resolution, one `task_job` terminal, one `task_turn` terminal, and one workflow
terminal. `started` is accepted without fallback; `recovered` is accepted after
fallback and records friction, not a failed task; `rejected` was not accepted;
`cancelled` is separate from rejection. Task/workflow `success`, `error`,
`partial`, and `cancelled` are not combined. `unknown` means an outcome or
diagnostic value could not be classified, not a confirmed failure.

For launch resolutions, requested execution/mux are compared with actual
execution/mux only for accepted launches. Rejected or cancelled launches have
`not_accepted` actual values; `launch_resolution_mux` preserves the selected or
last-known mux without implying acceptance. Initial and final failure
attribution remain separate. `workflow_invocation` is `tool` or
`saved_command`; it is distinct from an agent's `invocation_source`.

```sql
WITH base AS (
  SELECT
    coalesce(properties.schema_version, 0) AS schema_version,
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.mode, 'unknown') AS mode,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS tree_id,
    CASE
      WHEN event = 'pi_subagentura_agent_launch_resolved' THEN 'launch'
      WHEN event = 'pi_subagentura_workflow_completed' THEN 'workflow'
      WHEN properties.unit = 'job' THEN 'task_job'
      WHEN properties.unit = 'turn' THEN 'task_turn'
      ELSE 'unknown_task_unit'
    END AS measurement,
    CASE
      WHEN event = 'pi_subagentura_agent_launch_resolved'
        THEN coalesce(properties.outcome, 'unknown')
      ELSE coalesce(properties.status, 'unknown')
    END AS outcome,
    CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN coalesce(properties.invocation, 'unknown')
      ELSE 'not_applicable' END AS workflow_invocation,
    CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN 'not_applicable'
      ELSE coalesce(properties.invocation_source, 'unknown')
    END AS invocation_source,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.requested_execution, 'unknown')
      ELSE 'not_applicable' END AS requested_execution,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.requested_mux, 'unknown')
      ELSE 'not_applicable' END AS requested_mux,
    CASE
      WHEN event = 'pi_subagentura_agent_launch_resolved'
        AND properties.outcome IN ('started', 'recovered')
        THEN coalesce(properties.execution, 'unknown')
      WHEN event = 'pi_subagentura_agent_launch_resolved' THEN 'not_accepted'
      WHEN event = 'pi_subagentura_workflow_completed' THEN 'not_applicable'
      ELSE coalesce(properties.execution, 'unknown')
    END AS actual_execution,
    CASE
      WHEN event = 'pi_subagentura_agent_launch_resolved'
        AND properties.outcome IN ('started', 'recovered')
        THEN coalesce(properties.mux, 'unknown')
      WHEN event = 'pi_subagentura_agent_launch_resolved' THEN 'not_accepted'
      WHEN event = 'pi_subagentura_workflow_completed' THEN 'not_applicable'
      ELSE coalesce(properties.mux, 'unknown')
    END AS actual_mux,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.mux, 'unknown')
      ELSE 'not_applicable' END AS launch_resolution_mux,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.initial_failure_stage, 'none')
      ELSE 'not_applicable' END AS initial_failure_stage,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.initial_failure_operation, 'none')
      ELSE 'not_applicable' END AS initial_failure_operation,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.final_failure_stage, 'none')
      ELSE 'not_applicable' END AS final_failure_stage,
    CASE WHEN event = 'pi_subagentura_agent_launch_resolved'
      THEN coalesce(properties.final_failure_operation, 'none')
      ELSE 'not_applicable' END AS final_failure_operation,
    CASE
      WHEN event = 'pi_subagentura_task_completed'
        AND properties.status = 'error'
        THEN coalesce(properties.error_category, 'unknown')
      WHEN event = 'pi_subagentura_workflow_completed'
        AND properties.status IN ('error', 'partial')
        THEN coalesce(properties.error_category, 'unknown')
      ELSE 'not_applicable'
    END AS error_category,
    CASE
      WHEN event = 'pi_subagentura_task_completed'
        AND properties.status = 'error'
        THEN coalesce(properties.error_stage, 'unknown')
      WHEN event = 'pi_subagentura_workflow_completed'
        AND properties.status IN ('error', 'partial')
        THEN coalesce(properties.error_stage, 'unknown')
      ELSE 'not_applicable'
    END AS error_stage
  FROM events
  WHERE {filters}
    AND properties.schema_version = 6
    AND event IN (
      'pi_subagentura_agent_launch_resolved',
      'pi_subagentura_task_completed',
      'pi_subagentura_workflow_completed'
    )
), classified AS (
  SELECT *,
    CASE
      WHEN measurement = 'launch' AND outcome = 'started'
        THEN 'launch_accepted_no_fallback'
      WHEN measurement = 'launch' AND outcome = 'recovered'
        THEN 'launch_recovered_friction'
      WHEN measurement = 'launch' AND outcome = 'rejected'
        THEN 'launch_rejected'
      WHEN measurement = 'launch' AND outcome = 'cancelled'
        THEN 'launch_cancelled'
      WHEN measurement != 'launch' AND outcome = 'success' THEN 'success'
      WHEN measurement != 'launch' AND outcome = 'error' THEN 'execution_error'
      WHEN measurement != 'launch' AND outcome = 'partial' THEN 'partial'
      WHEN measurement != 'launch' AND outcome = 'cancelled' THEN 'cancelled'
      ELSE 'unknown'
    END AS classification
  FROM base
)
SELECT
  schema_version, release, mode, traffic_origin, measurement, classification,
  workflow_invocation, invocation_source, requested_execution, requested_mux,
  actual_execution, actual_mux, launch_resolution_mux, outcome,
  initial_failure_stage, initial_failure_operation, final_failure_stage,
  final_failure_operation, error_category, error_stage,
  count(*) AS records,
  count(DISTINCT tree_id) AS affected_trees
FROM classified
GROUP BY schema_version, release, mode, traffic_origin, measurement,
  classification, workflow_invocation, invocation_source, requested_execution,
  requested_mux, actual_execution, actual_mux, launch_resolution_mux, outcome,
  initial_failure_stage, initial_failure_operation, final_failure_stage,
  final_failure_operation, error_category, error_stage
ORDER BY schema_version, release, mode, traffic_origin, measurement, records DESC
```

Compare accepted-launch recovery (`recovered / (started + recovered)`) and
rejection (`rejected / (started + recovered + rejected)`) separately, with
cancellations shown outside both. If calculating task error shares, keep jobs
and turns separate and use `error / (success + error)`; for workflows retain
`partial` and `cancelled` as their own outcomes. Do not add unit counts or
per-row distinct-tree counts, or publish one combined error rate.

### 2. Adoption: accepted-agent volume, reach, and concentration

`agent_launches` counts accepted `agent_created` records. `using_trees` counts
trees with at least one accepted launch for that feature row. `active_trees`
counts every tree with any observed package event in the selected
release/schema/mode/origin/date population, including continuing sessions with
no new `session_started` event in that window. The busiest-tree columns show
concentration without returning tree IDs. This is not a unique-user percentage.

`invocation_source='workflow'` means an agent child launched by a workflow; it
does not count a workflow invocation. Workflow invocation volume belongs in the
lifecycle report. Invocation source and execution are different axes, and
`straight` mode does not mean no workflow was used.

```sql
WITH observed AS (
  SELECT
    event,
    coalesce(properties.schema_version, 0) AS schema_version,
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.mode, 'unknown') AS mode,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS tree_id,
    coalesce(properties.invocation_source, 'unknown') AS invocation_source,
    coalesce(properties.execution, 'unknown') AS execution,
    coalesce(properties.mux, 'unknown') AS mux
  FROM events
  WHERE {filters}
    AND startsWith(event, 'pi_subagentura_')
), active AS (
  SELECT schema_version, release, mode, traffic_origin,
    count(DISTINCT tree_id) AS active_trees
  FROM observed
  GROUP BY schema_version, release, mode, traffic_origin
), agent_tree_volume AS (
  SELECT schema_version, release, mode, traffic_origin,
    invocation_source, execution, mux, tree_id,
    count(*) AS tree_agent_launches
  FROM observed
  WHERE event = 'pi_subagentura_agent_created'
  GROUP BY schema_version, release, mode, traffic_origin,
    invocation_source, execution, mux, tree_id
), feature_volume AS (
  SELECT schema_version, release, mode, traffic_origin,
    invocation_source, execution, mux,
    sum(tree_agent_launches) AS agent_launches,
    count(DISTINCT tree_id) AS using_trees,
    max(tree_agent_launches) AS busiest_tree_agent_launches,
    round(100.0 * max(tree_agent_launches) /
      nullIf(sum(tree_agent_launches), 0), 1) AS busiest_tree_share_percent
  FROM agent_tree_volume
  GROUP BY schema_version, release, mode, traffic_origin,
    invocation_source, execution, mux
)
SELECT
  f.schema_version, f.release, f.mode, f.traffic_origin,
  f.invocation_source, f.execution, f.mux, f.agent_launches, f.using_trees,
  a.active_trees,
  round(100.0 * f.using_trees / nullIf(a.active_trees, 0), 1)
    AS session_reach_percent,
  f.busiest_tree_agent_launches, f.busiest_tree_share_percent
FROM feature_volume f
JOIN active a ON f.schema_version = a.schema_version
  AND f.release = a.release AND f.mode = a.mode
  AND f.traffic_origin = a.traffic_origin
ORDER BY f.schema_version, f.release, f.mode, f.traffic_origin,
  f.agent_launches DESC
```

The feature filter is deliberately downstream of `active`; keep the shared
filter free of event, invocation-source, execution, and mux constraints.
Compare only within matching release/schema/mode/origin populations. The
`busiest_tree_share_percent` is that row's largest single-tree share of accepted
agent volume, not a distribution over unique people.

### 3. Data quality: provenance, schema coverage, and unknowns

This report includes older schemas. Its schema/origin/mode/release groups show
coverage directly; an old or missing origin is not evidence of `usage`.
Unknown diagnostic values are data-quality observations, not additional
failures. `not_applicable` and absent optional fields are not treated as errors.
For required error classifications, missing category/stage is counted
separately from an explicit `unknown`. Runtime impact has distinct columns for
explicit `unknown` and a missing property. New mux-probe `blocked` and
historical mux-probe `unknown` remain separate values.

```sql
SELECT
  coalesce(properties.schema_version, 0) AS schema_version,
  coalesce(properties.$lib_version, 'unknown') AS release,
  coalesce(properties.mode, 'unknown') AS mode,
  coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
  event,
  count(*) AS event_records,
  count(DISTINCT properties.telemetry_session_id) AS affected_trees,
  sum(CASE WHEN properties.traffic_origin = 'unknown'
    OR properties.traffic_origin IS NULL THEN 1 ELSE 0 END)
    AS unknown_or_missing_origin_records,
  sum(CASE WHEN event = 'pi_subagentura_operation_completed'
    AND properties.result_status = 'unknown' THEN 1 ELSE 0 END)
    AS explicit_unknown_operation_status_records,
  sum(CASE WHEN event = 'pi_subagentura_operation_completed'
    AND properties.result_status IS NULL THEN 1 ELSE 0 END)
    AS missing_operation_status_records,
  sum(CASE WHEN (
      (event = 'pi_subagentura_task_completed' AND properties.status = 'error')
      OR (event = 'pi_subagentura_workflow_completed'
        AND properties.status IN ('error', 'partial'))
      OR event = 'pi_subagentura_runtime_failure'
    ) AND properties.error_category = 'unknown' THEN 1 ELSE 0 END)
    AS explicit_unknown_error_category_records,
  sum(CASE WHEN (
      (event = 'pi_subagentura_task_completed' AND properties.status = 'error')
      OR (event = 'pi_subagentura_workflow_completed'
        AND properties.status IN ('error', 'partial'))
      OR event = 'pi_subagentura_runtime_failure'
    ) AND properties.error_category IS NULL THEN 1 ELSE 0 END)
    AS missing_error_category_records,
  sum(CASE WHEN (
      (event = 'pi_subagentura_agent_launch_resolved'
        AND (properties.initial_failure_stage = 'unknown'
          OR properties.final_failure_stage = 'unknown'))
      OR (event = 'pi_subagentura_agent_spawn_failed'
        AND properties.failure_stage = 'unknown')
      OR (event = 'pi_subagentura_session_setup_failed'
        AND properties.failure_stage = 'unknown')
      OR (event = 'pi_subagentura_task_completed'
        AND properties.status = 'error' AND properties.error_stage = 'unknown')
      OR (event = 'pi_subagentura_workflow_completed'
        AND properties.status IN ('error', 'partial')
        AND properties.error_stage = 'unknown')
      OR (event = 'pi_subagentura_runtime_failure'
        AND properties.error_stage = 'unknown')
    ) THEN 1 ELSE 0 END) AS explicit_unknown_diagnostic_stage_records,
  sum(CASE WHEN (
      (event = 'pi_subagentura_task_completed'
        AND properties.status = 'error' AND properties.error_stage IS NULL)
      OR (event = 'pi_subagentura_workflow_completed'
        AND properties.status IN ('error', 'partial')
        AND properties.error_stage IS NULL)
      OR (event = 'pi_subagentura_runtime_failure'
        AND properties.error_stage IS NULL)
      OR (event IN (
        'pi_subagentura_agent_spawn_failed',
        'pi_subagentura_session_setup_failed',
        'pi_subagentura_completion_delivery_failed'
      ) AND properties.failure_stage IS NULL)
    ) THEN 1 ELSE 0 END) AS missing_diagnostic_stage_records,
  sum(CASE WHEN (
      (event = 'pi_subagentura_agent_launch_resolved'
        AND properties.outcome IN ('started', 'recovered')
        AND properties.execution = 'unknown')
      OR (event IN (
        'pi_subagentura_agent_created',
        'pi_subagentura_agent_spawn_failed',
        'pi_subagentura_task_completed',
        'pi_subagentura_runtime_failure'
      ) AND properties.execution = 'unknown')
    ) THEN 1 ELSE 0 END) AS explicit_unknown_execution_records,
  sum(CASE WHEN (
      (event = 'pi_subagentura_agent_launch_resolved'
        AND properties.outcome IN ('started', 'recovered')
        AND properties.mux = 'unknown')
      OR (event IN (
        'pi_subagentura_agent_created',
        'pi_subagentura_agent_spawn_failed',
        'pi_subagentura_task_completed',
        'pi_subagentura_runtime_failure'
      ) AND properties.mux = 'unknown')
    ) THEN 1 ELSE 0 END) AS explicit_unknown_mux_records,
  sum(CASE WHEN event = 'pi_subagentura_runtime_failure'
    AND properties.impact = 'unknown' THEN 1 ELSE 0 END)
    AS explicit_unknown_runtime_impact_records,
  sum(CASE WHEN event = 'pi_subagentura_runtime_failure'
    AND properties.impact IS NULL THEN 1 ELSE 0 END)
    AS missing_runtime_impact_records,
  sum(CASE WHEN event = 'pi_subagentura_runtime_failure'
    AND properties.failure_kind = 'mux_probe'
    AND coalesce(properties.mux, 'unknown') = 'unknown'
    THEN 1 ELSE 0 END) AS unattributed_mux_probe_records
FROM events
WHERE {filters} AND startsWith(event, 'pi_subagentura_')
GROUP BY schema_version, release, mode, traffic_origin, event
ORDER BY schema_version, release, mode, traffic_origin, event
```

The unknown counters diagnose missing or weak attribution; they are not
failure counts. A workflow `partial` status remains distinct from `error`, and
an absent diagnostic on a success/accepted launch is not classified as an
unknown failure. Read the runtime observation report for impact partitions.

### 4. Diagnostic outcomes: observations, delivery, and handlers

Each row retains its event measurement and unit: a runtime observation, a
technical spawn attempt, a delivery failure, a dispatch batch, a setup failure,
a handler start/result, or a result read. `agent_spawn_failed` is a technical
attempt that may precede an accepted fallback; it is not a logical rejected
launch or final task failure. `completion_delivered.count` is included
completion records per dispatch batch, not another event count. Started and
completed handlers are separate observations with no per-call linkage.

```sql
WITH observed AS (
  SELECT
    coalesce(properties.schema_version, 0) AS schema_version,
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.mode, 'unknown') AS mode,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS tree_id,
    event,
    CASE
      WHEN event = 'pi_subagentura_runtime_failure' THEN 'runtime_observation'
      WHEN event = 'pi_subagentura_agent_spawn_failed' THEN 'technical_spawn_attempt'
      WHEN event = 'pi_subagentura_completion_delivery_failed' THEN 'delivery_failure'
      WHEN event = 'pi_subagentura_completion_delivered' THEN 'dispatch_batch'
      WHEN event = 'pi_subagentura_session_setup_failed' THEN 'setup_failure'
      WHEN event = 'pi_subagentura_operation_started' THEN 'handler_start'
      WHEN event = 'pi_subagentura_operation_completed' THEN 'handler_result'
      ELSE 'result_read'
    END AS measurement,
    CASE
      WHEN event = 'pi_subagentura_runtime_failure'
        THEN 'one runtime observation record'
      WHEN event = 'pi_subagentura_agent_spawn_failed'
        THEN 'one technical spawn-attempt record'
      WHEN event = 'pi_subagentura_completion_delivery_failed'
        THEN 'one delivery failure record'
      WHEN event = 'pi_subagentura_completion_delivered'
        THEN 'one dispatch batch'
      WHEN event = 'pi_subagentura_session_setup_failed'
        THEN 'one session setup failure record'
      WHEN event = 'pi_subagentura_operation_started'
        THEN 'one handler start event'
      WHEN event = 'pi_subagentura_operation_completed'
        THEN 'one handler result event'
      ELSE 'one result read'
    END AS event_unit,
    CASE WHEN event = 'pi_subagentura_runtime_failure'
      THEN coalesce(properties.failure_kind, 'unknown')
      ELSE 'not_applicable' END AS failure_kind,
    CASE WHEN event = 'pi_subagentura_runtime_failure'
      THEN coalesce(properties.reporter, 'unknown')
      ELSE 'not_applicable' END AS reporter,
    CASE WHEN event = 'pi_subagentura_runtime_failure'
      THEN coalesce(properties.impact, 'unknown')
      ELSE 'not_applicable' END AS impact,
    CASE
      WHEN event IN (
        'pi_subagentura_runtime_failure',
        'pi_subagentura_agent_spawn_failed'
      ) THEN coalesce(properties.execution, 'unknown')
      ELSE 'not_applicable'
    END AS execution,
    CASE
      WHEN event IN (
        'pi_subagentura_runtime_failure',
        'pi_subagentura_agent_spawn_failed'
      ) THEN coalesce(properties.mux, 'unknown')
      ELSE 'not_applicable'
    END AS mux,
    CASE
      WHEN event = 'pi_subagentura_runtime_failure'
        THEN coalesce(properties.error_stage, 'not_applicable')
      WHEN event = 'pi_subagentura_agent_spawn_failed'
        OR event = 'pi_subagentura_session_setup_failed'
        OR event = 'pi_subagentura_completion_delivery_failed'
        THEN coalesce(properties.failure_stage, 'unknown')
      ELSE 'not_applicable'
    END AS diagnostic_stage,
    CASE WHEN event = 'pi_subagentura_agent_spawn_failed'
      THEN coalesce(properties.failure_operation, 'not_applicable')
      ELSE 'not_applicable' END AS diagnostic_operation,
    CASE WHEN event IN (
        'pi_subagentura_operation_started',
        'pi_subagentura_operation_completed'
      ) THEN coalesce(properties.surface, 'unknown')
      ELSE 'not_applicable' END AS operation_surface,
    CASE WHEN event IN (
        'pi_subagentura_operation_started',
        'pi_subagentura_operation_completed'
      ) THEN coalesce(properties.operation, 'unknown')
      ELSE 'not_applicable' END AS operation,
    CASE WHEN event = 'pi_subagentura_operation_completed'
      THEN coalesce(properties.outcome, 'unknown')
      ELSE 'not_applicable' END AS operation_outcome,
    CASE WHEN event = 'pi_subagentura_operation_completed'
      THEN coalesce(properties.result_status, 'unknown')
      ELSE 'not_applicable' END AS result_status,
    CASE WHEN event IN (
        'pi_subagentura_completion_delivery_failed',
        'pi_subagentura_completion_delivered'
      ) THEN coalesce(properties.delivery, 'unknown')
      ELSE 'not_applicable' END AS delivery,
    CASE WHEN event = 'pi_subagentura_result_read'
      THEN coalesce(properties.source, 'unknown')
      ELSE 'not_applicable' END AS result_source,
    CASE WHEN event = 'pi_subagentura_result_read'
      THEN coalesce(properties.outcome, 'unknown')
      ELSE 'not_applicable' END AS result_outcome,
    CASE WHEN event = 'pi_subagentura_completion_delivered'
      THEN coalesce(properties.count, 0)
      ELSE 0 END AS included_completion_records
  FROM events
  WHERE {filters}
    AND event IN (
      'pi_subagentura_runtime_failure',
      'pi_subagentura_agent_spawn_failed',
      'pi_subagentura_completion_delivery_failed',
      'pi_subagentura_completion_delivered',
      'pi_subagentura_session_setup_failed',
      'pi_subagentura_operation_started',
      'pi_subagentura_operation_completed',
      'pi_subagentura_result_read'
    )
)
SELECT
  schema_version, release, mode, traffic_origin, measurement, event_unit,
  failure_kind, reporter, impact, execution, mux, diagnostic_stage,
  diagnostic_operation, operation_surface, operation, operation_outcome,
  result_status, delivery, result_source, result_outcome,
  count(*) AS event_records,
  count(DISTINCT tree_id) AS affected_trees,
  sum(included_completion_records) AS included_completion_records
FROM observed
GROUP BY schema_version, release, mode, traffic_origin, measurement, event_unit,
  failure_kind, reporter, impact, execution, mux, diagnostic_stage,
  diagnostic_operation, operation_surface, operation, operation_outcome,
  result_status, delivery, result_source, result_outcome
ORDER BY schema_version, release, mode, traffic_origin, measurement,
  event_records DESC
```

For runtime observations, compare `failure_kind`, `reporter`, `impact`,
execution, and mux without collapsing `degraded`, `blocked`, and `unknown`.
Historical mux-probe `impact=unknown` is liveness uncertainty; new
`impact=blocked` means the workflow waiter exhausted its grace, not that the pane
process is confirmed dead. `completion_delivery_failed` and
`session_setup_failed` are failure-event counts; operation result statuses
`invalid_input`, `confirmation_required`, `degraded`, or `cancelled` are not
automatically product failures. Never sum counts across event units.

### 5. Workflow lifecycle: start and terminal window coverage

This report partitions by schema, release, mode, origin, workflow invocation
(`tool`/`saved_command`), async, and completion policy. Start and terminal
record counts and distinct affected trees are side by side, with terminal
statuses split into `success`, `partial`, `error`, `cancelled`, and `unknown`.
`signed_terminal_surplus_records` is only the terminal-minus-start record-count
difference in this selected window. It is a window-coverage diagnostic, not
evidence of missing or duplicate jobs.

There is no workflow ID or per-workflow join. A lifecycle can cross the date
window, pre-start validation/admission rejections may have no
`workflow_started`, and best-effort capture can lose either event. Distinct
start/terminal trees are session-tree counts, not unique workflow counts. Do not
calculate a terminal/start completion rate or infer that records pair.

```sql
WITH observed AS (
  SELECT
    coalesce(properties.schema_version, 0) AS schema_version,
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.mode, 'unknown') AS mode,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS tree_id,
    coalesce(properties.invocation, 'unknown') AS invocation,
    CASE
      WHEN properties.async IS NULL THEN 'unknown'
      WHEN properties.async THEN 'true'
      ELSE 'false'
    END AS async,
    coalesce(properties.completion_policy, 'unknown') AS completion_policy,
    event,
    coalesce(properties.status, 'unknown') AS status
  FROM events
  WHERE {filters}
    AND event IN (
      'pi_subagentura_workflow_started',
      'pi_subagentura_workflow_completed'
    )
), coverage AS (
  SELECT
    schema_version, release, mode, traffic_origin, invocation, async,
    completion_policy,
    sum(CASE WHEN event = 'pi_subagentura_workflow_started'
      THEN 1 ELSE 0 END) AS workflow_start_records,
    count(DISTINCT CASE WHEN event = 'pi_subagentura_workflow_started'
      THEN tree_id ELSE NULL END) AS workflow_start_trees,
    sum(CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN 1 ELSE 0 END) AS workflow_terminal_records,
    count(DISTINCT CASE WHEN event = 'pi_subagentura_workflow_completed'
      THEN tree_id ELSE NULL END) AS workflow_terminal_trees,
    sum(CASE WHEN event = 'pi_subagentura_workflow_completed'
      AND status = 'success' THEN 1 ELSE 0 END) AS success_terminal_records,
    sum(CASE WHEN event = 'pi_subagentura_workflow_completed'
      AND status = 'partial' THEN 1 ELSE 0 END) AS partial_terminal_records,
    sum(CASE WHEN event = 'pi_subagentura_workflow_completed'
      AND status = 'error' THEN 1 ELSE 0 END) AS error_terminal_records,
    sum(CASE WHEN event = 'pi_subagentura_workflow_completed'
      AND status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_terminal_records,
    sum(CASE WHEN event = 'pi_subagentura_workflow_completed'
      AND status = 'unknown' THEN 1 ELSE 0 END) AS unknown_terminal_records
  FROM observed
  GROUP BY schema_version, release, mode, traffic_origin, invocation, async,
    completion_policy
)
SELECT *,
  workflow_terminal_records - workflow_start_records
    AS signed_terminal_surplus_records
FROM coverage
ORDER BY schema_version, release, mode, traffic_origin, invocation,
  completion_policy
```

Keep workflow lifecycle counts separate from agent launch and task completion
counts. This report describes observed start/terminal volume in a window only;
it cannot establish a unique-workflow total or explain historical aggregate
differences.

### 6. Observed fresh root sessions by host

Count observed `session_started` records by the closed host label. Keep schema,
release, mode, origin, and UTC date filters explicit. Do not apply child `mux`,
execution, or operation filters: host is emitted only on root session starts.
Historical missing and unexpected values stay `unknown`. This report measures
sessions, not people, installations, all active sessions, or verified current
foreground agents. Repeated human use can create many sessions; continuing
sessions without a fresh start in the window are absent.

```sql
SELECT
  coalesce(properties.schema_version, 0) AS schema_version,
  coalesce(properties.$lib_version, 'unknown') AS release,
  coalesce(properties.mode, 'unknown') AS mode,
  coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
  CASE WHEN properties.session_host = 'agterm' THEN 'agterm'
    WHEN properties.session_host = 'orca' THEN 'orca'
    ELSE 'unknown' END AS session_host,
  count(*) AS observed_session_starts
FROM events
WHERE {filters} AND event = 'pi_subagentura_session_started'
GROUP BY schema_version, release, mode, traffic_origin, session_host
ORDER BY schema_version, release, mode, traffic_origin, observed_session_starts DESC
```

No schema filter is hard-coded so historical missing host values remain visible.
The added host label does not change schema-v6 event shape. Do not call either
the `agterm` or `orca` share a unique-user share, the `unknown` remainder a
non-host share, or use this event-only property as a shared filter on the other
reports' active-tree denominators.

### 7. Extension-managed launch backend by outer host

This is the package's observed spawn mechanism, not host-managed launches. Join
the root `session_started` observation to `agent_launch_resolved` using the
random `telemetry_session_id`; do not select or expose that identifier in the
report. Missing historical host labels remain `unknown`.

```sql
WITH roots AS (
  SELECT DISTINCT
    properties.telemetry_session_id AS tree_id,
    CASE WHEN properties.session_host = 'agterm' THEN 'agterm'
      WHEN properties.session_host = 'orca' THEN 'orca'
      ELSE 'unknown' END AS session_host
  FROM events
  WHERE {filters} AND event = 'pi_subagentura_session_started'
), launches AS (
  SELECT
    coalesce(properties.schema_version, 0) AS schema_version,
    coalesce(properties.$lib_version, 'unknown') AS release,
    coalesce(properties.mode, 'unknown') AS mode,
    coalesce(properties.traffic_origin, 'unknown') AS traffic_origin,
    properties.telemetry_session_id AS tree_id,
    coalesce(properties.outcome, 'unknown') AS outcome,
    coalesce(properties.requested_execution, 'unknown') AS requested_execution,
    coalesce(properties.requested_mux, 'unknown') AS requested_mux,
    coalesce(properties.execution, 'unknown') AS execution,
    coalesce(properties.mux, 'unknown') AS mux
  FROM events
  WHERE {filters} AND event = 'pi_subagentura_agent_launch_resolved'
)
SELECT
  l.schema_version, l.release, l.mode, l.traffic_origin,
  coalesce(r.session_host, 'unknown') AS session_host,
  l.outcome, l.requested_execution, l.requested_mux, l.execution, l.mux,
  count(*) AS observed_launch_resolutions,
  count(DISTINCT l.tree_id) AS affected_trees
FROM launches AS l
LEFT JOIN roots AS r ON l.tree_id = r.tree_id
GROUP BY l.schema_version, l.release, l.mode, l.traffic_origin,
  session_host, l.outcome, l.requested_execution, l.requested_mux,
  l.execution, l.mux
ORDER BY l.schema_version, l.release, l.mode, l.traffic_origin,
  session_host, observed_launch_resolutions DESC
```

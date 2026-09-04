# Extension reliability monitoring

The [pi-subagentura reliability dashboard](https://us.posthog.com/project/518458/dashboard/2065797)
uses anonymous extension lifecycle events. Its eighteen saved insights were queried
against the connected project before creation. The website starter dashboard is
independent.

`posthog-dashboard.json` records the saved dashboard/insight IDs, query definitions,
and descriptions. Update these resources by ID instead of creating duplicates.
The file contains no ingestion or account credentials and is not part of the
published npm tarball.

## Reading the dashboard

- Workflow and task outcomes use terminal event counts with separate schema and
  status series. Cancellations and partial workflows stay distinct from errors.
- Result-read errors can be failed underlying work returned to the caller.
  Repeated reads also produce events; they do not count unique consumed results.
- Duration p95 uses numeric milliseconds and sits beside duration
  coverage. Missing and `unknown` buckets remain visible. Trends can render empty
  daily intervals as zero; inspect coverage before interpreting a percentile.
- Delivery latency is the maximum known completion age in each batch. It can
  include intentional parent/group waiting. It is not a queue processing SLO.
- Release/schema and execution/multiplexer charts provide context for comparing
  outcomes. There is no reliable production/development origin dimension yet.
- The 24-hour session journey funnel measures anonymous session trees reaching
  agent creation and successful work. Loading the extension does not imply an
  intent to delegate, and parallel tasks can satisfy different steps. It is
  adoption context, not an exact task conversion or user retention rate.
- Recovery sums can include the same agent on repeated reloads. Zero recovered
  state can be normal; setup failure events provide additional failure context.

See [the coverage review](coverage.md) for the complete metric map, error
categories, remaining blind spots, and how to prioritize experience improvements.

All charts default to the last seven days in the project's UTC timezone and
include the current partial day. The dashboard uses explicit extension event
names so website and standalone test event names are excluded. Extension-shaped
development events cannot be distinguished without additional instrumentation.

Telemetry is best effort and can be lost. Do not use `completed / started` within
one window as an exact success rate; work can cross the window boundary. The
random correlation represents a logical session/tree, not a stable user or
installation, and does not support per-job or per-workflow joins.

## Completion delivery failure events

This change adds `pi_subagentura_completion_delivery_failed` to schema v3 without
changing the existing event meanings. It sends only the common anonymous metadata,
`delivery="manifest"`, a closed `failure_stage`, and `retry_attempt` clamped to
`0..32` (the current retry policy schedules at most eight backoff retries).

| Failure stage        | Observation                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `notice_persistence` | Appending the durable TUI notice threw. An append-then-throw may already have written the notice; reconciliation still handles it. |
| `manifest_dispatch`  | Sending the parent manifest threw. The normal bounded retry policy remains in effect.                                              |
| `retry_exhausted`    | The coordinator exhausted its scheduled manifest/notice retries.                                                                   |

Each coordinator sends at most one event for each stage until an automatic
manifest dispatch succeeds or a matching manifest is reconciled from the parent
session, including one attached to human input. The suppression set has at most
three entries and is process-local; reload/recovery can report a continuing
failure again. Counts represent observed episodes per stage, not affected
completions or total retry attempts. A failed telemetry request remains best
effort and is not retried.

Existing telemetry opt-outs and session retirement guards apply. Error text,
stacks, prompts, paths, and completion/agent/workflow identifiers are never added.
This event does not cover every possible failure: asynchronous wake exhaustion,
overflow/consumption ledger failures, and host-level failures remain separate
diagnostic paths.

## Activate pending insights after deployment

`pending_insights` contains prepared definitions for operation adoption, outcomes,
result statuses, timing, setup failures, completion delivery failures, and rejected
spawns. They are not saved as live charts until their actual events
and properties are observed and their queries can be validated.

1. Deploy the instrumentation through the normal release flow.
2. Confirm the target project and discover the real event, `schema_version`, and
   `failure_stage` properties using PostHog's schema tools.
3. Run the pending query and verify its results. Do not inject fake failures into
   this project; exercise failure paths with mocked capture or a separate test
   project when a controlled check is needed.
4. Save the insight on the existing dashboard, record its returned ID in
   `insights`, and remove its `pending_insights` entry. Update the dashboard
   description once the new charts are active.

## Alert rollout

No outbound alert destinations are configured by this dashboard definition.
Choose recipients and validate schema/release coverage before enabling alerts.
An observed `retry_exhausted` episode is a useful first signal. For workflow error
rates, use terminal outcomes as the denominator, separate cancellations, require
a minimum sample count, and compare like schemas/releases. Baseline the threshold
instead of hardcoding a generic percentage.

Missing extension traffic alone is not proof of an outage: activity, opt-outs,
and transport loss all affect it. An ingestion check should use the existing
scheduled CI plus a separate PostHog test project, with CI as its independent
failure signal. This initial implementation does not add a synthetic sender.

PostHog references: [alerts](https://posthog.com/docs/alerts),
[breakdowns](https://posthog.com/docs/product-analytics/trends/breakdowns), and
[aggregations](https://posthog.com/docs/product-analytics/trends/aggregations).

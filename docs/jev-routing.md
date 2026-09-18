---
title: "Optional Jev routing"
keywords:
  [orchestratorv2, jev, typesafe, openrouter, routing, agents, configuration]
---

# Optional Jev routing

Orchestratorv2 can ask TypeSafe's Jev model to select an existing interactive
child when the requested work is clear but its owner is ambiguous. The
recommended transport is OpenRouter's hosted Jev Decisions API; direct
TypeSafe System-One remains supported for deployments that use a TypeSafe key.
The parent lists agents, asks the routing advisor, and sends the task using the
existing `send_interactive_subagent_message` tool. Jev cannot send messages or
control child lifecycle itself.

## Enable

OpenRouter-hosted Jev is the recommended transport. Supply an OpenRouter key
through your shell or secret manager, then start Pi:

```bash
export OPENROUTER_API_KEY="your-openrouter-api-key"
export PI_ORCHESTRATOR_ROUTER="openrouter"
pi --orchestratorv2
```

The exact router value `openrouter` and `--orchestratorv2` are both required.
A key alone does not enable routing. OpenRouter requests use the Decisions API
at `https://openrouter.ai/api/alpha/decisions` with the default model
`~typesafe/jev-latest` (the `OPENROUTER_JEV_MODEL` environment variable may
override the model).

Direct TypeSafe Jev remains available when OpenRouter is not suitable:

```bash
export TYPESAFE_API_KEY="your-typesafe-api-key"
export PI_ORCHESTRATOR_ROUTER="jev"
pi --orchestratorv2
```

The direct adapter uses `https://api.typesafe.ai/v1/systemone` and
`jev-latest`. Both transports require an explicit provider value; neither is
enabled by a key alone. Restart Pi after changing this environment
configuration. Unset `PI_ORCHESTRATOR_ROUTER` to restore the default behavior.
Project settings cannot enable this integration or alter its thresholds.
Legacy `--orchestrator` behavior is unchanged.

Enabling the feature explicitly opts into transmitting the payload described
below to the selected provider. There is no additional confirmation dialog.
Missing keys and invalid settings produce a safe advisor result without an API
request.

Optional environment settings are read only from the process environment:

| Setting                                      | Default                | Valid range                                                       |
| -------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `OPENROUTER_JEV_MODEL`                       | `~typesafe/jev-latest` | Non-empty, at most 256 UTF-8 bytes                                |
| `PI_ORCHESTRATOR_ROUTER_MIN_CONFIDENCE`      | `0.8`                  | `0..1`                                                            |
| `PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY` | `0.8`                  | `0..1`                                                            |
| `PI_ORCHESTRATOR_ROUTER_MIN_MARGIN`          | `0.2`                  | `0..1`; exact ties always abstain                                 |
| `PI_ORCHESTRATOR_ROUTER_TIMEOUT_MS`          | `3000`                 | Integer `1..30000`                                                |
| `PI_ORCHESTRATOR_ROUTER_MAX_CANDIDATES`      | `64`                   | Integer `1..128`                                                  |
| `PI_ORCHESTRATOR_ROUTER_MAX_REQUEST_BYTES`   | `65536`                | Integer `1..262144`                                               |
| `PI_ORCHESTRATOR_ROUTER_MAX_RESPONSE_BYTES`  | `65536`                | Integer `1..262144`                                               |
| `PI_ORCHESTRATOR_ROUTER_MAX_TASK_BYTES`      | `16384`                | Integer `1..65536`; the tool also enforces a `16384`-byte ceiling |

These thresholds are conservative starting settings, not measured accuracy
guarantees. The network timeout covers response streaming; registry liveness
checks can add time before and after it. Oversized candidate sets are rejected
instead of silently excluding potentially suitable children.

## Parent flow

1. Call `list_orchestrator_agents` for the current responsibilities and runtimes.
2. When only child selection is ambiguous, call
   `resolve_orchestrator_route({ task: "the original user task" })`.
3. On `kind: "match"`, send the original task to the returned `childId` using
   `send_interactive_subagent_message` with that ID as `id`.
4. On `kind: "no_match"`, apply the existing policy. On `kind: "cancelled"`,
   stop routing the cancelled request.

The advisor builds a current candidate list internally from the current parent
session's authority records and runtime state. It does not trust a candidate
list supplied by the parent model. Only live, actionable, non-stale direct
children with confirmed responsibilities are eligible. The project routing
cache cannot authorize a candidate.

Explicit child IDs, explicit requests for a new child, and attach/focus requests
follow the existing policy directly. Clear exact continuations may also route
directly. If action, deliverable, access, or scope is unclear, the parent asks
the user before requesting a selection. Aliases remain discovery hints.

Jev chooses among request-local candidate tokens and an explicit `none` option.
The host checks the response probabilities, confidence, and separation between
the two leading options. A high score never expands a child's permissions or
responsibility. There is no model-driven creation decision in this release.

After a recommendation, the tool rechecks current state. Changed authority,
runtime identity, working directory, session ownership, or availability
invalidates the result. This recheck uses the normal bounded liveness
projection; it does not force an extra uncached multiplexer probe.
The recommendation does not reserve the child: existing messaging checks still
apply when the parent sends the task. A failed send must be surfaced to the user,
without silently spawning a replacement.

## External payload and diagnostics

Requests use native `fetch` and the System-One Choice shape. OpenRouter uses
the fixed `https://openrouter.ai/api/alpha/decisions` endpoint and
`~typesafe/jev-latest` by default; direct TypeSafe uses the fixed
`https://api.typesafe.ai/v1/systemone` endpoint and `jev-latest`. The payload
contains the task and bounded responsibility descriptions, aliases, and statuses.
Child IDs are mapped to request-local tokens. Runtime paths, attach commands,
artifact contents, child output, and full transcripts are not added to the
payload. The selected provider's API key is sent only in the authorization
header.

Free-text fields are scrubbed for the configured key, known credential formats,
credential-bearing URLs, and obvious sensitive paths. Redaction cannot identify
every arbitrary secret or confidential passage: do not include sensitive pasted
content in tasks submitted to this advisor. Review the selected provider's
privacy policy before enabling external processing.

This feature uploads no routing telemetry. Advice returns only bounded local
candidate IDs, numeric evidence, and closed failure reasons. Raw provider error
bodies and credentials are never returned to the parent. Ordinary Pi session
storage may retain the local tool result.

## Failures and evaluation

Each decision makes at most one API request, with a bounded deadline and no
automatic retries. Missing credentials, HTTP failures, malformed responses,
oversized input/output, incomplete registry projections, low confidence, close
scores, and `none` all prevent automatic selection. Cancellation invalidates
late results.

Normal tests use mocked transport and do not need an OpenRouter or TypeSafe key.
They prove the request, response, failure, and runtime integration contracts; they
do not establish real-world routing accuracy. Provider confidence is a summary of
the probability distribution, not a guarantee that an individual route is correct.
See the TypeSafe [Choice](https://docs.typesafe.ai/primitives/choice) and
[confidence](https://docs.typesafe.ai/confidence) documentation.

Before tuning thresholds, evaluate a labeled set of realistic requests against
the default parent behavior. Include clear continuations, overlapping domains,
read-only audits versus implementation, no suitable child, explicit-new and
attach requests, and unclear scope. Record incorrect automatic reuse, correct
reuse, clarification rate, and end-to-end latency. Keep sensitive evaluation
tasks local unless separately approved for external processing.

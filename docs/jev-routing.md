---
title: "Optional native classifier routing"
keywords: [orchestratorv2, jev, classifier, routing, agents, configuration]
---

# Optional native classifier routing

Orchestratorv2 can ask a Pi classifier to select an existing interactive child
when the requested work is clear but its owner is ambiguous. **Pi's native
classifier API is the only backend.** There are no direct TypeSafe/OpenRouter
HTTP adapters and no fallback transport.

The parent lists agents, asks the advisor, and sends the original task through
`send_interactive_subagent_message`. The classifier cannot send messages, spawn,
attach, reserve children, or change their responsibilities.

## Enable

Routing requires Pi **0.99.0 or newer**, a catalog classifier with configured
provider authentication, and both explicit opt-ins:

```bash
export PI_ORCHESTRATOR_ROUTER="jev"
pi --orchestratorv2
```

The default classifier is `openrouter/~typesafe/jev-latest`. Authenticate with
Pi's `/login openrouter`, or use the provider's normal environment credentials.
Pi owns request-time authentication, provider endpoints, and model configuration;
the extension does not resolve keys or construct authorization headers.
Codemode is not required for extension classifier calls.

To choose another classifier, specify its exact Pi provider and model IDs:

```bash
export PI_ORCHESTRATOR_ROUTER="jev"
export PI_ORCHESTRATOR_ROUTER_PROVIDER="typesafe"
export PI_ORCHESTRATOR_ROUTER_MODEL="jev-latest"
pi --orchestratorv2
```

Provider/model selection does not authenticate the provider. Use Pi's normal
configuration for TypeSafe, another Jev provider, or a llama.cpp classifier.
Changing the provider does not automatically change the model ID.

If the host lacks the classifier APIs, the configured model is absent, or
provider authentication is not configured, advisor registration and guidance are
omitted. Older supported Pi hosts can still use the rest of the extension.
If availability disappears after registration, a call returns a closed
`unavailable` result without a classifier request or transport fallback. Pi's
request-time authentication or service can still fail even when credentials are
configured; that also produces a closed result, never another backend.

Restart Pi after changing environment configuration. Unset
`PI_ORCHESTRATOR_ROUTER` to restore the default behavior. The old value
`PI_ORCHESTRATOR_ROUTER=openrouter` is no longer supported. A provider key alone
does not enable routing. Project settings cannot enable it or alter thresholds;
legacy `--orchestrator` behavior is unchanged.

Enabling this feature opts into sending the bounded payload below to the
configured classifier provider. There is no additional confirmation dialog.

Optional settings are read only from the process environment:

| Setting                                      | Default                | Valid range                                                   |
| -------------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `PI_ORCHESTRATOR_ROUTER_PROVIDER`            | `openrouter`           | Non-empty, no surrounding whitespace, at most 256 UTF-8 bytes |
| `PI_ORCHESTRATOR_ROUTER_MODEL`               | `~typesafe/jev-latest` | Non-empty, no surrounding whitespace, at most 256 UTF-8 bytes |
| `PI_ORCHESTRATOR_ROUTER_MIN_CONFIDENCE`      | `0.8`                  | `0..1`                                                        |
| `PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY` | `0.8`                  | `0..1`                                                        |
| `PI_ORCHESTRATOR_ROUTER_MIN_MARGIN`          | `0.2`                  | `0..1`; exact ties always abstain                             |
| `PI_ORCHESTRATOR_ROUTER_TIMEOUT_MS`          | `3000`                 | Integer `1..30000`                                            |
| `PI_ORCHESTRATOR_ROUTER_MAX_CANDIDATES`      | `64`                   | Integer `1..128`                                              |
| `PI_ORCHESTRATOR_ROUTER_MAX_REQUEST_BYTES`   | `65536`                | Integer `1..262144`                                           |
| `PI_ORCHESTRATOR_ROUTER_MAX_RESPONSE_BYTES`  | `65536`                | Integer `1..262144`                                           |
| `PI_ORCHESTRATOR_ROUTER_MAX_TASK_BYTES`      | `16384`                | Integer `1..65536`; tool ceiling is `16384` bytes             |

The llama.cpp `llama-cpp-classify` API is additionally limited to **61 children
plus `none`**, because it supports 62 choice labels. Oversized candidate sets
are rejected, never truncated. No universal 62-option Jev limit is assumed.

Request/response bounds cover the extension's serialized classifier context and
decoded answer, respectively. Pi owns HTTP buffering; the response bound is not
a network-stream memory limit. The deadline covers the native classification
call. Registry liveness checks can add time before and after it. Thresholds are
conservative defaults, not measured accuracy guarantees.

## Parent flow and authority

1. Call `list_orchestrator_agents` for responsibilities and runtimes.
2. When only child selection is ambiguous and the advisor is available, call
   `resolve_orchestrator_route({ task: "the original user task" })`.
3. On `kind: "match"`, send the original task to the returned `childId` through
   `send_interactive_subagent_message`.
4. On `kind: "no_match"` or `kind: "error"`, apply the existing parent policy.
   On `kind: "cancelled"`, stop the cancelled request.

The advisor builds candidates from the current parent session's authority and
runtime state, not a model-supplied list. Only live, actionable, non-stale direct
children with confirmed responsibilities are eligible. Project routing caches
cannot authorize candidates. Explicit child IDs, requests for a new child,
attach/focus requests, and clear exact continuations follow existing policy.
Unclear action, deliverable, access, or scope requires user clarification first.
Aliases remain discovery hints.

The classifier chooses a request-local token or `none`. The host validates the
choice, complete probability map, finite values, unit sum, argmax, confidence,
and separation between the leading options. Scores never expand permissions.
After advice, the tool rechecks authority, runtime identity, cwd, ownership, and
availability. Changed state invalidates the recommendation. The normal bounded
liveness projection is reused, without an extra uncached mux probe.

Advice does not reserve a child. Messaging checks still apply; surface failed
sends rather than silently spawning replacements. Virtual-model chat routing is
a separate Pi feature and is not enabled by this integration.

## Payload, privacy, and accounting

Pi receives only the task and bounded responsibility descriptions, aliases, and
statuses under opaque request-local tokens. Child IDs, runtime paths, attach
commands, artifacts, child output, and transcripts are not added as structured
payload fields.

Free text is scrubbed for child IDs, environment secret values, known credential
formats, credential-bearing URLs, and obvious sensitive paths. Arbitrary secrets
(including credentials stored only in Pi) cannot all be identified; do not paste
sensitive content into advisor tasks. Review the provider's privacy policy before
enabling external processing.

Results contain local candidate IDs, numeric evidence, and closed failure reasons,
not raw provider errors or credentials. Validated classifier usage is returned as
tool usage so Pi can account for the nested call. Session storage may retain the
local tool result. Anonymous product telemetry retains only standard bounded
operation events, never task/candidate metadata, decisions, provider responses,
credentials, usage details, or identifiers.

## Failures and evaluation

The extension makes at most one native classification call per decision, with a
bounded deadline and no extension retries. Missing capabilities/model/auth,
classifier errors, malformed answers, oversized payloads, incomplete registry
projections, low confidence, close scores, and `none` prevent automatic selection.
Cancellation aborts the host request and invalidates late answers.

Normal tests mock Pi's classifier registry and require no provider keys. They
verify activation, native calls, failure handling, bounds, and authority checks;
they do not establish live service behavior or routing accuracy. Evaluate labeled
requests before tuning thresholds, including overlapping responsibilities,
read-only versus implementation tasks, no suitable child, explicit-new/attach
requests, and unclear scope. Keep sensitive evaluation tasks local unless
external processing is separately approved.

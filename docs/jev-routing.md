---
title: "Native classifier routing"
keywords:
  [
    orchestratorv2,
    jev,
    force-jev,
    openai-decisions,
    classifier,
    routing,
    agents,
    configuration,
  ]
---

# Native classifier routing

Orchestratorv2 can ask a Pi classifier to advise on the owner of a clear task.
The extension builds eligible native interactive candidates from the current
parent session's routing authority and live runtime, then calls Pi's native
classifier API. The classifier chooses one eligible candidate or `none`; a
whole-request split assessment also offers `split`. It cannot create, message,
attach to, or change a child's responsibilities.

Jev models such as `~typesafe/jev-latest` use Pi's native System One path.
`gpt-6-luna` may be used through Pi's native OpenAI Decisions classifier
support when the installed catalog exposes it under provider `openai`; Pi owns
the model-to-transport mapping, and the extension does not construct provider
HTTP requests. Provider/model settings select the classifier, not the child
owner. Rex is a native mux backend, so a Rex child may be recommended only when
it is already an eligible, live, authorized native child. Orca host-managed
agents are outside this registry and cannot be selected by the advisor.

## Require classifier advice for implicit native routing

To use the default `openrouter/~typesafe/jev-latest` classifier, configure
OpenRouter authentication in Pi (for example, `/login openrouter`). This
command clears any provider and model overrides for this launch:

```bash
env -u PI_ORCHESTRATOR_ROUTER_PROVIDER -u PI_ORCHESTRATOR_ROUTER_MODEL \
  pi --orchestratorv2 --force-jev
```

To use a different classifier, set its exact Pi provider and model IDs. For
example, if the catalog exposes `typesafe/jev-latest` and you have configured
TypeSafe authentication:

```bash
PI_ORCHESTRATOR_ROUTER_PROVIDER=typesafe \
PI_ORCHESTRATOR_ROUTER_MODEL=jev-latest \
pi --orchestratorv2 --force-jev
```

`--force-jev` applies only to parent Orchestratorv2 sessions. It does not
require `PI_ORCHESTRATOR_ROUTER=jev` or override provider, model, threshold, or
limit settings. Provider and model defaults are independent: setting one does
not change the other. Invalid settings do not fall back to defaults. The
selected pair must be an authenticated Pi classifier that supports the typed
choice request. Compatible non-Jev classifiers are supported. The flag does
not change the parent or worker chat model.

List current native owners first. For a clear implicit owner decision, give
`resolve_orchestrator_route` a safe `routingDescription` before reusing or
creating a child, even when there is only one eligible child. Outside a
whole-request split assessment, a complete registry with no eligible children
needs no classifier call. Explicit child targets, explicit new-child requests,
attach/focus, unclear requests, and host-managed routing follow existing policy.

In forced mode, the advisor stays registered even if Pi cannot use the
configured classifier. If a decision needs classification and the classifier
is unavailable, the tool returns `unavailable`. Report the blocker instead of
using another classifier or falling back to prompt-only routing. A successful
`no_match`, including `low_confidence` or `ambiguous`, completes the required
assessment without selecting an owner. Apply the owner-selection rule below.
Do not treat stale, unknown, or incomplete ownership as proof of absence. On
`state_changed`, recheck current authority before making a new decision.

The advisor validates input shape, bounds, and classifier results. The parent
model's choice to call or bypass it, describe the work safely, split, or dispatch
one handoff per part is **prompt policy**, not a runtime gate on send or spawn.

## Enable optional advice without the flag

Routing requires Pi **1.2.0 or newer**, a catalog classifier with configured
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

The same provider and model overrides work for optional advice. Use Pi's
normal provider authentication; setting the IDs does not authenticate the
provider.

For OpenAI Decisions, configure `openai` and `gpt-6-luna` only if the installed
Pi model catalog exposes that exact provider/model as a classifier. The
extension asks Pi's registry for the classifier entry and invokes its native
classifier API; the package's minimum Pi version does not guarantee that every
catalog contains this model.

```bash
export PI_ORCHESTRATOR_ROUTER="jev"
export PI_ORCHESTRATOR_ROUTER_PROVIDER="openai"
export PI_ORCHESTRATOR_ROUTER_MODEL="gpt-6-luna"
pi --orchestratorv2
```

Provide an OpenAI API key through Pi's normal provider authentication, commonly
`OPENAI_API_KEY`; ChatGPT OAuth does not authorize Decisions API requests. A
stored OpenAI login can take precedence over that environment variable. The
extension checks Pi's configured-auth status but does not verify the key, live
provider service, permissions, or billing. Classification requests may incur
provider charges. See Pi's model documentation for which catalog entry and
credential Pi will use.

In optional mode, if the host lacks the classifier APIs, the configured model
is absent, or provider authentication is not configured, the advisor and its
guidance are omitted. If availability disappears after registration, a call
returns `unavailable` without a classifier request or transport fallback.
Pi's request-time authentication or service can still fail even when
credentials are configured; that also produces a closed result, never another
backend.

Restart Pi after changing environment configuration. To turn classifier advice
off, omit `--force-jev` and unset `PI_ORCHESTRATOR_ROUTER`. The old value
`PI_ORCHESTRATOR_ROUTER=openrouter` is no longer supported. A provider key alone
does not enable routing. Project settings cannot enable it or alter thresholds;
legacy `--orchestrator` behavior is unchanged.

Enabling either mode opts into sending the bounded payload below to the
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

The llama.cpp `llama-cpp-classify` API supports 62 choice labels: **60 children
plus `split` and `none`** for whole split assessment, or **61 children plus
`none`** otherwise, including for split parts. Oversized candidate sets are
rejected, never truncated. No universal 62-option Jev limit is assumed.

Request/response bounds cover the extension's serialized classifier context and
decoded answer, respectively. Pi owns HTTP buffering; the response bound is not
a network-stream memory limit. The deadline covers the native classification
call. Registry liveness checks can add time before and after it. Thresholds are
conservative defaults, not measured accuracy guarantees.

## Parent flow and authority

This flow describes unsplit optional advice. For forced mode or split
assessment, follow the stricter call and error rules for that mode.

1. Call `list_orchestrator_agents` and inspect current authoritative
   responsibilities and runtimes before deciding whether to reuse or create a
   native specialist. For Orca, first discover currently owned agents through
   the version-matched skills.
2. Reuse an exact, live, authorized owner when its confirmed responsibility
   covers the requested action, scope, deliverable, and access. When only the
   choice among plausible owners is uncertain, call
   `resolve_orchestrator_route({ routingDescription: "Read-only review of API compatibility; report findings" })`.
3. On `kind: "match"`, send the authorized handoff for the assessed work to
   the returned `childId` through `send_interactive_subagent_message`. The
   handoff is separate from the classifier description. A match does not expand
   the owner's responsibility or permissions.
4. On `kind: "no_match"` (`new_child_recommended`, `low_confidence`, or
   `ambiguous`), the advisor selected no owner. Do not treat the result as a
   match or proof of absence. Use current authoritative metadata: reuse an
   unambiguous, exact, live, authorized owner. Ask which owner to use only if
   two or more current owners remain plausible and the choice is unresolved.
   If complete discovery establishes that no suitable exact owner exists and
   there is no unresolved choice, create exactly one specialist for the clear
   request without asking for approval. This includes narrow read-only
   investigation; “look at this issue” means inspect and report, not implement.
5. On `error`, or if the advisor is unavailable, use current authoritative
   registry metadata and the base policy for unsplit optional advice. Never
   follow an erroneous recommendation. On `kind: "cancelled"`, stop routing
   the request.

### Whole-first flow with `--split`

With an applicable advisor (optional or forced), assess a clear implicit
native request **before splitting or dispatching**. Call with a safe
`routingDescription` of the whole request and leave `part` unset. Even with
zero eligible children, this assessment offers `split` and `none`. A
whole-request match gives one handoff to an authorized owner. On `no_match`,
apply the owner-selection rule to the whole request: if reliable discovery
establishes no suitable owner, create one specialist, not a split.

On `split_uncertain`, ask the user whether to split the request. Do not split,
send, or create a child until the user answers.

On `split_needed`, assess each smaller independent part with `part: true`. Repeat until the classifier selects one owner or confidently recommends a new child. Even with no eligible children, a part can still need a split. Weak evidence pauses the branch. Do not dispatch intermediate tasks. Stop if the scope does not shrink, after four levels of decomposition, or at the 32-call planning budget. Never infer a handoff from a limit or an error.

For example, suppose the user asks for two read-only reviews and supplies an
internal compatibility matrix and draft release notes. With
`pi --orchestratorv2 --force-jev --split`, the parent first calls
`resolve_orchestrator_route` for the whole request:

```json
{
  "routingDescription": "Review API compatibility and release notes. Read-only; report findings for each."
}
```

Only after `split_needed`, the parent calls the advisor for the API review:

```json
{
  "part": true,
  "routingDescription": "Review API compatibility. Read-only; report breaking changes."
}
```

The separate release notes review gets its own call:

```json
{
  "part": true,
  "routingDescription": "Review release notes. Read-only; report missing user-facing changes."
}
```

Keep the matrix and the draft out of all advisor calls. If a part has an
authorized owner, include its material or an approved reference only in that
worker's handoff: the matrix for the API review, the draft for the release
notes review.

Without an applicable advisor, use the base scope, authority, and ambiguity
rules to decompose broad requests into independent handoffs. The advisor never
applies to explicitly selected targets, explicit new-child requests, attach
or focus, or host-managed routing.

Apart from the owner-selection and privacy rules, ask for clarification only
when a substantive request requirement or permission remains unclear, such as
target, deliverable, read/write/PR scope, or continuation versus new work.
Do not expand read-only/reviewer permissions. Aliases remain discovery hints.

The advisor builds candidates from the current parent session's authority and
runtime state, not a model-supplied list. Only live, actionable, non-stale direct
children with confirmed responsibilities are eligible. Project routing caches
cannot authorize candidates.

The classifier chooses a request-local candidate token, `none`, or `split`
when offered during whole split assessment. The host validates the choice,
complete probability map, finite values, unit sum, argmax, confidence, and
separation between the leading options. Scores never expand permissions.
After advice, the tool rechecks authority, runtime identity, cwd, ownership, and
availability. Changed state invalidates the recommendation. The normal bounded
liveness projection is reused, without an extra uncached mux probe.

Advice does not reserve a child. Messaging checks still apply; surface failed
sends rather than silently spawning replacements. Virtual-model chat routing is
a separate Pi feature and is not enabled by this integration.

## Payload, privacy, and accounting

Use `routingDescription` for **only** the minimal action, scope, deliverable,
and required access the classifier needs. Do not send the original request,
transcripts, document or code excerpts, secrets, or other private material.
Keep that material, if needed and authorized, in the separate worker handoff.
For a part, omit other parts' instructions and materials.

If no safe description is sufficient at either stage, **do not call** the
advisor, even with zero eligible children. Report the blocker and ask for a
safe rephrasing or an explicit target. Do not infer a route from the omitted
call. Older optional non-split callers may still supply `task` alone
without `part`; these callers have the same duty to send only safe routing
text. Forced mode and split mode require `routingDescription`. The tool
rejects missing, blank, oversized, or conflicting input rather than using a
raw task as a substitute.

Pi receives the supplied routing description and bounded candidate
responsibilities, aliases, and statuses under opaque request-local tokens.
Child IDs, runtime paths, attach commands, artifacts, child output, and
transcripts are not added as structured payload fields. Keep candidate
responsibilities and aliases safe for external processing too. Do not call
if those fields contain private material that is not safe to send.

The adapter applies best-effort scrubbing for known patterns and values.
It cannot identify arbitrary private text, infer whether a description is
safe, or verify it against the original user message. Review the provider's
privacy policy before enabling external processing.

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

Configured authentication is an availability gate, not a successful service
health check. A provider can still reject a request for permissions, billing, or
other reasons. For example, HTTP 402 from OpenRouter for insufficient credits
becomes `kind: "error", reason: "unavailable"`; raw provider diagnostics are not
included in advice. Check the provider account rather than lowering confidence
thresholds. Switching to TypeSafe requires both `typesafe` and `jev-latest` IDs
plus its own authentication; it does not guarantee free service.

Unit tests mock Pi's classifier registry. Native-SDK integration tests exercise
the real catalog, authentication resolution, System One and OpenAI Decisions
transports, answer parsing, usage, and HTTP 402 handling with synthetic
credentials and stubbed HTTP responses. A real-session test checks advisor
registration after startup and reload. None requires live provider credentials
or paid requests.

These tests do not establish live service availability or routing accuracy.
Evaluate labeled requests before tuning thresholds, including overlapping
responsibilities, read-only versus implementation tasks, no suitable child,
explicit-new/attach requests, and unclear scope. Keep sensitive evaluation tasks
local unless external processing is separately approved.

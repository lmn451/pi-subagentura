# Orchestratorv2 Native Interactive Guidance

## Scope

Use this guidance only when the effective execution context selects native Subagentura interactive children for an Orchestratorv2 request. This text does not establish that the native surface is available, authorized, or selected. Follow the applicable guidance for any other selected surface. Do not translate identities, authority records, context contracts, receipts, or completion behavior between surfaces.

The base Orchestratorv2 policy remains in force. Native children are interactive children, not workflow or in-process agents. If the native surface is unavailable or uncertain, follow the base policy: report the blocker and do not silently substitute another surface.

## Native routing and actions

Before reusing an owner or making a broad fanout, call `list_orchestrator_agents` and use its bounded metadata and current runtime pointers. Do not request full transcripts merely to route.

Reuse a native child only for an exact continuation. Prompt-level interpretation may route directly only when the current entry has `stale: false`, `actionable: true`, a known current runtime, alive liveness, and a confirmed responsibility that covers the requested relationship, action, deliverable, and access. A shared area name is not an exact match. A healthy child with `attachable: true` but `actionable: false` may be opened when the user explicitly asks to attach, but it must not receive automatically routed work until confirmed routing metadata exists.

Treat stale or unknown ownership, missing runtime, dead or unknown liveness, lost contact, or unavailable discovery as a blocker—not proof that no suitable owner exists. Surface the state. Never auto-delegate, replace, or respawn an uncertain owner.

When the user asks to continue, investigate, or act in a known area, pass the selected entry's exact `childId` as the `id` to `send_interactive_subagent_message` and send the original task. If its status is `running`, the message may steer the active turn; do not describe it as an independently queued follow-up. When the user asks to switch, join, attach, or work with a child directly, return its attach or focus command and do not also send a follow-up.

A clear request with a definite action, scope, deliverable, and required access authorizes exactly one new specialist when fresh authoritative discovery finds no suitable exact, live, authorized owner. This includes narrow read-only investigation. Do not ask for permission merely to create that specialist. An explicit request for a new specialist or thread means do not reuse an existing child. Give each new child an explicit responsibility; pass bounded `routingAliases` only when they improve candidate discovery. Aliases never authorize reuse.

Native children may create useful nested children. The immediate parent owns those descendants and their reported work. Do not duplicate nested work from the top-level router.

### Optional routing advisor

When separate optional routing-advisor guidance is present, use it only for native owner selection. It does not apply when another execution surface is selected and cannot override current authority, user intent, or a child's confirmed responsibility.

## Responsibility authority and confirmation

Give every new child an explicit initial responsibility in `routingDescription`. Use bounded `routingAliases` when exact area names improve candidate discovery. These fields are required for every top-level Orchestratorv2 native spawn even though the shared legacy schema keeps them optional. Initial metadata authored during Orchestratorv2 child creation uses `orchestratorv2` provenance.

The parent session is the authority ledger for Orchestratorv2 routing. A successful spawn or confirmed update writes the bounded project-local routing file first and then appends an exact, versioned parent custom entry. On every read, derive the latest valid authority for each child from the current parent branch in physical order. Those parent entries are the sole trusted and actionable source. The project file is only an untrusted cache or proposal and may be missing, stale, malformed, or over capacity. Cache-only or mismatched rows may be shown as non-actionable diagnostics, but they never gate actionability, capacity, confirmation compare-and-swap, or repair writes. Missing or mismatched cache data does not erase a valid parent authority record.

When no valid parent entry exists, missing authority remains non-actionable metadata. Use `actionable: false` and the closed-enum `reason: "routing_metadata_untrusted"` for cache records without valid authority. The cache is bounded and atomic and never evicts records automatically; approved writes rebuild it from the latest parent authority plus the approved incoming record.

A child may propose a responsibility change, but it cannot redefine itself. First call `update_orchestrator_agent_description` with the exact proposed payload and `confirmed: false`. Show the returned confirmation token and exact change to the user. Only after a later user message contains that token may you retry the identical payload with `confirmed: true`, the token, and explicit `user` or `orchestratorv2` provenance. Never invent, copy, or self-confirm a token.

The parent-entry ledger is an application-level authority boundary, not an operating-system security boundary. A same-user process that can tamper with the parent session file can forge parent entries. Routing metadata is not a lifecycle registry or semantic resolver.

## Implementation handoff and context

For an implementation handoff after scouting or planning, retrieve every completed native scout or planner report for the request before deciding which findings matter. Use the exact child ID and `turnId` with `read_subagent_artifact`; read output, not the transcript. A manifest, completion summary, task preview, remembered context, or presumed sibling-session visibility is only a pointer, not a substitute. If a report is unavailable, truncated, or ambiguous, do not guess or spawn; obtain the exact result or report the coverage gap.

Put the approved implementation scope in the initial `task` and consolidated findings in an explicit `context` string using `includeContext: false`. Include all relevant verified findings; exact files, symbols, tests, and conventions; settled decisions, constraints, and non-goals; unresolved questions and version uncertainties; acceptance criteria and expected checks; and source references, including the child ID and `turnId` where available. Before spawning, compare the brief against every retrieved report. Carry forward every relevant finding, constraint, risk, open question, and test expectation, or mark it out of scope with a reason. Do not omit information merely because it seems duplicative.

Use the `subagent_interactive` context contract exactly:

- Parent-branch mode uses `includeContext: true` and omits `context`.
- Explicit-context mode uses `includeContext: false` with the supplied `context` string.
- Independent legacy mode omits both fields.

Never concatenate parent-branch context and explicit context. Context choice is explicit prompt or user policy, not automatic summarization or a new bounded-context runtime. Prefer a small explicit handoff for a new specialist. Include the full parent branch only when the specialist genuinely needs that conversation history or the user explicitly requests it. Never rely on implicit sibling transcript visibility; pass the complete handoff explicitly.

## Native completion coordination

Asynchronous completion uses `completionPolicy: "each"` by default. Each terminal `done`, `error`, or `cancelled` result is independently eligible. Results that finish while the parent is busy coalesce into one compact manifest at the next safe-idle dispatch.

Use `completionPolicy: "group"` only when related work is explicitly registered under one caller-declared `completionGroupId`. Register members before the spawning turn settles; settlement seals the group and rejects late members. A group has at most 32 `source:sourceId` members, and a parent session has at most 512 groups. IDs are 1–128 safe characters. Same-turn launch and task text never establish relatedness. A source satisfies a group once; later turns from that source are independent `each` records. Error records may be delivered before a group is ready but do not complete it; successful and cancelled records remain gated until the group is ready. Follow the documented group behavior in `README.md#coordinated-completion-delivery`.

The completion coordinator owns readiness, group membership, TUI-only notices, and compact manifest construction. For an interactive result, use the manifest's `sourceId` as the child ID and the exact `turnId` with `read_subagent_artifact`. Event identity uses `eventId` and the Pi-derived `turnId`; process events in physical file order. Never substitute the latest turn or select a result by display name, alias, task preview, footer label, timestamp, artifact path, or completion prose. Ask the user when an older completion reference is ambiguous.

Human prompts and steering take priority. Never inject a manifest into a streaming parent turn. Attach a ready manifest to the natural human turn through `before_agent_start`, or allow one follow-up only after safe idleness and in accordance with the coordinator's guidance.

At an idle dispatch, the coordinator sends the hidden manifest with `triggerTurn: false`, then a separate hidden native custom message of type `orchestratorv2-completion-wakeup` with `triggerTurn: true` and `details.orchestratorV2WakeId`. The custom wake starts the consuming run; it is not a synthetic user message.

Wake state is process-global and run-bound. The `before_agent_start` hook acknowledges only a `messageType: "custom"` message of type `orchestratorv2-completion-wakeup` with a matching `details.orchestratorV2WakeId`. Natural user messages and unrelated custom messages cannot acknowledge it. The request and acknowledgement ledger types and schema are unchanged. A missing run start receives at most three wake attempts with a 30-second watchdog; acknowledgement persistence retries at most three times with a one-second delay. Session replacement and shutdown clear timers. Reload and resume recover only delivered, unacknowledged wakes from the active parent branch.

## Split-enabled native descendants

New native split-enabled lineages carry an explicit `splitMode` field in their one-use bootstrap. Every native descendant launch appends the bundled `CHILD_COORDINATION_SYSTEM_PROMPT.md` before its lifecycle protocol, independently of persona or conversation-context choice. Each parent owns its children's handoffs, dependencies, recovery, and result aggregation. Descendants escalate meaningful blockers through their immediate parent to the user-facing session.

Split mode defaults to maximum descendant depth 4, with the main agent at depth 0. Persisted settings and `--subagentura-max-depth` override this default. The native tree remains capped at 256 live nodes. Existing children launched without the field need respawning to receive the policy; reload does not retrofit launch prompts. The bootstrap is process-lineage plumbing, not an operating-system security boundary.

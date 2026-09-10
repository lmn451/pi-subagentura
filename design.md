Orchestratorv2 Thin Router — distilled plan

Goal: Make orchestratorv2 a cheap, context-light top-level router for existing interactive Pi agents.

Core architecture

User
↓
orchestratorv2
├─ understands intent
├─ decomposes broad requests
├─ queries routing registry
├─ delegates or returns attach/focus instructions
└─ summarizes important child results
↓
Existing interactive Pi sessions

orchestratorv2 is the only semantic orchestrator.

orchestratorv2 must not:

- search repositories;
- edit files;
- perform specialist work;
- use workflows;
- become a worker;
- route other workers;
- run a semantic resolver or embeddings.

Workflows remain a separate path. Existing --orchestrator behavior remains unchanged. Orchestratorv2 uses a separate --orchestratorv2 mode.

Registry model

Create a small project-local overlay:

<project>/.pi/subagentura-routing.json

It stores only confirmed routing metadata:

- child/session ID;
- responsibility description;
- optional exact aliases;
- provenance: user or orchestratorv2;
- update timestamp;
- project identity/schema version.

It does not store:

- pane/lifecycle state;
- liveness;
- artifacts or output;
- delivery queues;
- ownership epochs;
- assignments/findings/investigations;
- replacement or recovery state.

The existing interactive runtime remains authoritative for:

- status;
- liveness;
- session ownership;
- attach/focus commands;
- artifacts;
- completion/delivery;
- lineage.

At runtime:

routing metadata

- SessionScope.interactiveStates
- existing liveness/artifact state
  ↓
  compact orchestratorv2-facing agent registry

Missing runtime records remain visible as:

stale / unknown / non-actionable

They are never silently deleted, replaced, respawned, or selected for routing.

One active orchestrator per project is the Phase 1 operational assumption.

Routing policy

Routing stays prompt-based in Phase 1.

- Clear exact/continuation request → route immediately.
- Delegation request → use existing send_interactive_subagent_message.
- Direct-work request → return existing attach/focus command.
- Ambiguous request → ask the user.
- No match → do not silently spawn or fan out.
- User-originated broad request → orchestratorv2 may decompose it into multiple children.
- Child-originated side topic → the child may autonomously open a nested interactive child and report the concern or outcome upward.
- User approval may also open a separate top-level interactive child; the original child continues.

No deterministic semantic matcher is introduced yet.

New parent-facing surface

Add only two routing tools:

list_orchestrator_agents
update_orchestrator_agent_description

There is deliberately no:

resolve_orchestrator_route

orchestratorv2 receives a bounded registry projection and makes the semantic decision itself.

Existing tools remain authoritative:

- subagent_interactive — create child;
- send_interactive_subagent_message — delegate follow-up;
- supervisor/focus tools — direct work;
- artifact/notification tools — output and completion.

Context contract

Existing context behavior is preserved:

{}

Legacy behavior.

{ includeContext: true }

Include the full parent branch. context is forbidden.

{ includeContext: false, context: "..." }

Create an independent child with explicit context text.

No automatic summarization, truncation, or special Orchestratorv2 context limit is added. Normal model/tool/file limits apply.

Child events

Only important events should wake or reach orchestratorv2:

- substantial additional information;
- blockers/errors;
- completion;
- needs-attention.

Normal progress and tool activity stay in the existing UI/artifact path.

An interactive child may autonomously create nested interactive children. This is intentional: nested children are owned by the immediate child session and are not automatically actionable in the top-level orchestratorv2 registry. Important nested outcomes must flow back through the immediate parent or existing artifact/notification path.

Intentional Phase 1 boundaries

- `--orchestratorv2` changes prompt policy; it does not enforce a host-level tool allowlist. Normal parent workflow and in-process tools remain registered for compatibility, although orchestratorv2 is instructed not to use them.
- Interactive children retain `subagent_interactive` and may autonomously create nested children without top-level approval.
- A child runtime is launched before its initial routing metadata is persisted. If persistence fails, the child remains live and the caller receives an explicit warning; there is no automatic cancellation or rollback.

Implementation order

1. Add bounded routing-overlay persistence.
2. Join routing metadata with the existing interactive runtime and expose a compact view.
3. Load/rehydrate the overlay without replacing existing session rehydration.

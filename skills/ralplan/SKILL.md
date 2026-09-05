---
name: ralplan
description: Consensus-driven implementation planning via isolated Planner, Architect, and Critic reviews of one immutable Planner snapshot. Use when a detailed plan is needed before coding; planning remains pending and read-only until a separate host approval.
argument-hint: "[idea]"
level: intermediate
---

# ralplan — Consensus-Driven Implementation Planning

RALPLAN is a planning protocol, not an executor. It produces a bounded plan and
review evidence while keeping the result **pending approval** and
**execution-halted**. A workflow result, plan file, marker, or
`executeOnConsensus` argument is never permission to edit source or invoke an
executor. Only a separate host-controlled approval and handoff may authorize a
later phase.

## Invocation

Use an explicit invocation:

- `/ralplan [idea]`
- `--ralplan [idea]`
- `/brainstorm [idea]` for a host-supported question-elicitation variant

A bare mention of “ralplan” in prose does not start a new pipeline. Status,
artifact, skip, and cancel commands are host features; a workflow body cannot
intercept arbitrary parent text or suspend for user input.

## Hard contract

1. **Isolated roles.** Planner, Architect, and Critic are separate agent
   invocations. The parent does not impersonate a role and no role approves its
   own work.
2. **One fixed snapshot.** After Planner settles, capture one immutable value
   snapshot. Architect and Critic are awaited sequentially and each receives
   that same snapshot. Critic receives neither Architect JSON nor an Architect
   artifact path.
3. **Explicit verdicts.** Planner returns `DRAFT_READY`; Architect returns
   `APPROVE` or `REVISION_NEEDED`; Critic returns `APPROVE`, `ITERATE`, or
   `REJECT`. Never infer approval from an empty violations, issues, gaps, or
   findings array. Missing, malformed, or failed output is non-approval.
4. **Complete re-review.** Critic runs after Architect settles, including after
   `REVISION_NEEDED` or an Architect failure. Any non-approval starts a complete
   Planner → Architect → Critic round. `maxIterations` is clamped to 1–5.
5. **Planning boundary.** Every terminal result is pending/read-only and
   execution-halted. No consensus, cap, null result, cancellation, or failure
   may recommend `ralph`, `team`, autopilot, or another executable skill.
6. **Deliberate mode.** When high-risk work requests DELIBERATE mode, Planner
   must return exactly three actionable pre-mortem scenarios and all four
   expanded test pillars: unit, integration, e2e, and observability. Missing or
   weak structured sections are non-approval. SHORT mode does not require them.

## Role responsibilities

### Planner

Investigate requirements and codebase facts through available read-only agents,
then produce a 3–6 step actionable plan. Include:

- RALPLAN-DR: 3–5 principles, the top 3 decision drivers, and at least 2
  viable options with bounded pros/cons;
- guardrails, task acceptance criteria, dependencies, risks, and open questions;
- an ADR with Decision, Drivers, Alternatives Considered, Why Chosen,
  Consequences, and Follow-ups;
- DELIBERATE additions when that mode is active.

Planner does not implement, commit, push, execute, or approve.

### Architect

Read-only and independent. Review the fixed Planner snapshot for technical
soundness, alternatives, ownership/lifecycle risks, compatibility, and
trade-offs. Always provide a steelman antithesis and a real tradeoff tension,
then return an explicit `APPROVE` or `REVISION_NEEDED` verdict. An empty
`principleViolations` array is evidence, not a verdict.

### Critic

Read-only and independent. Review the same fixed Planner snapshot without
seeing Architect output. Check principle/option consistency, risk mitigation,
acceptance criteria, verification, missing assumptions, and deliberate-mode
hard gates. Return an explicit `APPROVE`, `ITERATE`, or `REJECT` verdict.

## Loop and termination

```text
Planner(snapshot N)
       |
       +--> Architect(snapshot N) --+
       |                             |
       +--> Critic(snapshot N) ------+
                                      |
                 both explicit APPROVE and mode gates pass?
                    yes -> pending consensus result
                    no  -> Planner(snapshot N+1, with both reviews)
```

The Critic is not skipped when Architect rejects. The next Planner may receive
both settled review results, but those results are never passed from Architect
to Critic. After five rounds, return the best/last draft with `capped: true`,
`pending_approval: true`, and `execution_halted: true`; require manual review
and provide no execution recommendation.

## OCC workflow arguments

The canonical `examples/workflows/ralplan-occ.mjs` accepts `idea`,
`deliberate`, `maxIterations`, `artifactsDir`, `planName`,
`architectModel`, and `criticModel`. Its local gate is controlled by `gate`:
`gate: false` bypasses the heuristic; otherwise an unanchored short prompt may
return a pending redirect. `interactive` only controls emission of
non-blocking `[pending approval]` marker text. The workflow VM cannot pause for
a user, ask a host question, or turn a marker into approval; actual approval
and invocation routing belong to the host. `executeOnConsensus` is accepted
only for compatibility, reported as ignored, and never changes safety state.

The compact `ralplan-consensus.mjs` example is SHORT-only. It shares the fixed
snapshot, explicit verdict, unconditional Critic, five-round, and pending
boundary contract but does not advertise DELIBERATE or interactive parity.

## Artifacts and execution separation

Planning may produce bounded Markdown evidence only. A claimed path is not
proof of a valid artifact, and the Phase 1 workflow does not provide a host
artifact verifier or persisted approval state. Artifact existence/content
verification and host-owned run/approval state are later phases. Do not treat
`plans/plan.md`, a completion marker, or a successful workflow return as
consent to execute.

If the host cannot provide isolated agent invocations, stop with:

> ralplan requires role-isolated agent execution; current host does not support it.

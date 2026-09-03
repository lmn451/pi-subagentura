---
name: ralplan
description: Reference skill contract translated by the bundled workflow into verified, isolated Planner, Architect, and Critic orchestration.
argument-hint: "[idea]"
level: intermediate
---

# ralplan — Verified Consensus Planning

This packaged skill is the readable source contract for the bundled RALPLAN
workflow example. `examples/workflows/ralplan-occ.mjs` translates the contract
into executable orchestration using the existing generic `workflow` tool. No
RALPLAN-specific extension tool or mode is required.

## Invocation

Use an explicit `/ralplan [idea]` or `--ralplan [idea]` invocation. Bare prose
mentions do not start a pipeline. Host commands such as status, approval,
cancel, or resume require host integration; a workflow body cannot intercept
arbitrary parent text or suspend for user input.

## Consensus roles

Only three roles determine consensus:

1. **Planner** writes an immutable per-round draft.
2. **Architect** independently reviews that exact verified draft.
3. **Critic** independently reviews the same verified draft without receiving
   Architect output or an Architect artifact path.

An optional **Analyst** preflight atomizes requirements and open questions. The
Analyst is advisory and is never a fourth approver.

Every role is a separate agent invocation. Planner returns `DRAFT_READY`;
Architect returns `APPROVE` or `REVISION_NEEDED`; Critic returns `APPROVE`,
`ITERATE`, or `REJECT`. Approval is never inferred from empty findings. Missing,
malformed, failed, or digest-mismatched output is non-approval.

## Artifact contract

Given `artifactsDir`, a safe `planName`, and round `N`, write only:

- `drafts/<planName>_draft-rN.md`
- `drafts/architect_review-rN.md`
- `drafts/critic_review-rN.md`
- `<planName>.md` only after both independent reviewers explicitly approve

Each draft/review filename is immutable and round-specific. Never overwrite a
prior round. A read-only verifier must check the exact claimed path, regular-file
existence, 1 MB size bound, required headings, round/kind, source-draft identity,
and SHA-256 before the workflow accepts it. A claimed path alone is not success.

Draft and final plan artifacts require:

- `## RALPLAN-DR` with 3–5 principles, top 3 decision drivers, and at least 2
  viable options (or explicit invalidation rationale);
- `## Architecture Decision Record` with Decision, Drivers, Alternatives
  Considered, Why Chosen, Consequences, and Follow-ups;
- `## Task Breakdown` with 3–6 actionable tasks and exact paths;
- `## Dependency Graph`;
- `## Acceptance Criteria`;
- `## Risk Register`;
- open questions where applicable.

When requirements traceability is requested, the advisory Analyst emits atomic
`REQ-*` items and the draft/final plan must include `## Requirement Coverage
Map`. Each requirement maps to covered plan steps and one of `COVERED`,
`PARTIAL`, `UNCOVERED`, or `SCOPED_OUT`; `SCOPED_OUT` requires rationale.
Unexplained partial/uncovered/scoped-out items block Critic approval.

## Review loop

```text
Analyst? (advisory only)
  → Planner writes draft-rN
  → verifier records draft SHA-256
  → Architect reviews draft-rN + expected digest
  → Critic reviews draft-rN + expected digest (no Architect input)
  → verifier validates both review artifacts and source identity
  → both explicit APPROVE?
      no: next complete Planner → Architect → Critic round
      yes: Consolidator writes final plan → verifier validates final plan
```

Critic always runs after Architect settles, including Architect rejection or
failure. Only the next Planner receives both settled review results. Clamp
`maxIterations` to 1–5. Artifact-validation failures may be corrected by a
later bounded round; exhaustion returns the best evidence as pending/read-only.

## Modes

SHORT is the default. DELIBERATE mode requires exactly three actionable
pre-mortem scenarios (trigger, blast radius, early signal, mitigation,
detection) and concrete Unit, Integration, E2E, and Observability coverage.
The verifier treats missing sections as invalid. The compact
`ralplan-consensus.mjs` example remains SHORT-only.

## OCC workflow semantics

`examples/workflows/ralplan-occ.mjs` is the reference translation. Direct
workflow invocation begins planning, so the optional local short-prompt
heuristic is enabled only with `gate: true`. Optional `interactive: true`
controls non-blocking `[pending approval]` markers; the workflow VM cannot wait
for a user. `executeOnConsensus` is accepted only for compatibility, reported as
ignored, and never changes approval or execution state.

## Safety boundary

Planning agents may write only the bounded Markdown paths above. They never edit
source, execute, delegate implementation, commit, or push. Every terminal result
has `pending_approval: true` and `execution_halted: true`. Missing consensus,
cap exhaustion, cancellation, or artifact failure has no executable
recommendation. Approval and any later execution are outside this example
workflow.

If the host cannot provide isolated role execution, stop with:

> ralplan requires role-isolated agent execution; current host does not support it.

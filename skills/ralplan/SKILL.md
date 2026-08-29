---
name: ralplan
description: Consensus-driven implementation planning via verified immutable Markdown artifacts and isolated Planner, Architect, and Critic reviews. Results remain pending and execution-halted until a separate host approval.
argument-hint: "[idea]"
level: intermediate
---

# ralplan — Verified Consensus Planning

RALPLAN is a planning protocol, not an executor. It produces bounded, verified
Markdown artifacts and independent review evidence. A workflow return, artifact
path, digest, completion marker, or `executeOnConsensus` argument is never
execution consent.

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

`examples/workflows/ralplan-occ.mjs` is canonical. `gate: false` bypasses its
local short-prompt heuristic. `interactive` controls only non-blocking
`[pending approval]` log markers; the workflow VM cannot wait for a user.
`executeOnConsensus` is accepted only for compatibility, reported as ignored,
and never changes approval or execution state.

## Host-owned approval and recovery

The extension persists bounded mode-0600 state at `.pi/ralplan-state.json`,
keyed to canonical project cwd, exact parent owner generation, and parent
session id. Workflow start records `planning`; verified consensus records
`pending_approval` with the exact final-plan digest. Other terminal paths record
`rejected`, `capped`, `cancelled`, `failed`, or `interrupted` evidence.

Use explicit host tools:

- `get_ralplan_status` — inspect current or same-session interrupted evidence;
- `approve_ralplan` — approve exactly `{runId, planDigest}`; it deactivates state
  before returning `approved_handoff` and starts no execution;
- `reject_ralplan` — reject a pending run terminally;
- `cancel_ralplan` — cancel the exact owner-scoped planning workflow;
- `prepare_ralplan_recovery` — return read-only interrupted evidence only.

Reload/resume/quit interrupt active runs; new/fork cancel them. Recovery never
replays model work or resumes automatically. Stale owners, generations, sessions,
run IDs, and digest mismatches cannot approve, reject, or cancel a run.

## Optional durable declarative execution

Execution is a separate, opt-in host protocol after `approved_handoff`:

1. `preview_ralplan_execution` validates 1–32 stable ordered task IDs, prior-only
   dependencies, bounded prompts, plan digest, owner, and parent session. It
   persists a mode-0600 preview and starts nothing.
2. `approve_ralplan_execution` approves the exact execution id, revision, and
   plan digest but still starts nothing.
3. `run_ralplan_execution` acquires an owner/epoch/revision-fenced lease and
   executes tasks sequentially. Each operation is persisted before model work;
   each committed outcome stores bounded evidence and an output digest.
4. `get_ralplan_execution_status` reads cold disk projections after restart.
   `cancel_ralplan_execution` makes in-flight work unknown.
5. Interrupted runs never auto-resume. Resolve each unknown operation explicitly
   with `resolve_ralplan_operation` (`retry`, `accept`, or `fail` plus evidence),
   then use `resume_ralplan_execution` to rebind without starting work. A separate
   `run_ralplan_execution` call is still required.

Committed outcomes replay without model re-execution. Uncommitted side effects
are not exactly-once: a crash after a side effect but before outcome persistence
creates an unknown operation requiring trusted manual resolution. Never claim
exactly-once semantics or silently retry unknown mutation work.

## Safety boundary

Planning agents may write only the bounded Markdown paths above. They never edit
source, execute, delegate implementation, commit, or push. Every terminal result
has `pending_approval: true` and `execution_halted: true`. Missing consensus,
cap exhaustion, cancellation, or artifact failure has no `ralph`, `team`,
autopilot, or other executable recommendation. Planning approval and execution
preview approval remain distinct, explicit host actions.

If the host cannot provide isolated role execution, stop with:

> ralplan requires role-isolated agent execution; current host does not support it.

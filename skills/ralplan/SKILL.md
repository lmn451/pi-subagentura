---
name: ralplan
description: Consensus-driven implementation planning via strict Planner/Architect/Critic iteration. Use when the user needs a detailed spec and implementation plan before coding. Trigger with /ralplan or by saying 'ralplan'. Execution-agnostic: RALPLAN defines roles, workflow, and artifact formats only; the host environment provides agent execution via any available method.
argument-hint: "[idea]"
level: intermediate
---

# ralplan — Consensus-Driven Implementation Planning

A strict three-role state machine that produces an implementation plan via adversarial review. Each role is a separately invoked agent; the parent agent does **not** perform role work itself. The pipeline prevents "Simulated Consensus" — the failure mode where a single generation hallucinates all three approvals in one block.

## Usage

Invoke one of:

- `/ralplan [idea]` — slash command, auto-starts the pipeline.
- `/ralplan:status` — show current iteration, last verdict, and produced artifacts.
- `/ralplan:artifacts` — list every file written under `plans/`.
- `/ralplan:skip` — advance past the current stage (use sparingly).
- `/ralplan:cancel` — end the session.
- `/brainstorm [idea]` — same pipeline under the brainstorm variant (see below).
- `--ralplan [idea]` / `--brainstorm [idea]` — CLI flag form for non-interactive hosts.

Auto-start is slash/flag only. Bare mentions of "ralplan" in prose do **not** re-trigger a fresh pipeline — the role prompts mention "ralplan" naturally during consensus rounds, and the loop must continue from where it is.

## Flags / Options

| Form                  | Effect                                                               |
| --------------------- | -------------------------------------------------------------------- |
| `/ralplan [idea]`     | Slash command — auto-starts the planning pipeline.                   |
| `/brainstorm [idea]`  | Slash command — auto-starts the brainstorm variant (open Q&A first). |
| `--ralplan [idea]`    | CLI flag — auto-starts the planning pipeline.                        |
| `--brainstorm [idea]` | CLI flag — auto-starts the brainstorm variant.                       |
| `/ralplan:status`     | Print the current iteration, last verdict, and artifact list.        |
| `/ralplan:artifacts`  | List every file produced under `plans/`.                             |
| `/ralplan:skip`       | Advance past the current stage (logged in the artifact trail).       |
| `/ralplan:cancel`     | End the session immediately; artifacts on disk are preserved.        |

## Core Directive

You are executing a strict multi-agent state machine. Your primary goal is to prevent **Simulated Consensus** — hallucinating all three approvals in a single generation. True consensus requires:

- Independent challenge of assumptions, with findings supported by evidence. Agreement on the first pass is valid when no material issues remain.
- Isolated reasoning (each role is a separately invoked agent).
- Verifiable file-system checkpoints (artifacts written to `plans/` between roles).

**Self-approval is strictly prohibited.**

## Hard Constraints

1. **Isolated Roles.** Each role (Planner, Architect, Critic) MUST be executed by a separately invoked agent. The parent agent MUST NOT perform the work of any role itself.
2. **No Single-Turn Consensus.** The Planner's draft, the Architect's review, and the Critic's approval MUST NOT appear in the same output block.
3. **Evidence-based Review.** The Architect and Critic must examine the plan independently. Report supported findings and unresolved questions; do not manufacture objections to require another round. A first-pass approval is valid after the required review criteria are satisfied.
4. **Auto-start is slash/flag only.** The pipeline auto-starts ONLY when the prompt begins with `/ralplan` or `/brainstorm` (or uses `--ralplan` / `--brainstorm` flags). Bare mentions of "ralplan" in prose do NOT trigger auto-start, because role prompts reference the skill name naturally and must not re-trigger a fresh pipeline for each consensus round.

## Iteration Loop

```
        +-----------+        REVISION NEEDED        +-----------+
        |  PLANNER  | <---------------------------+ | ARCHITECT |
        |  (State1) |                              +-----------+
        +-----------+                                      |
              |                                            | APPROVE
              v                                            v
        plans/drafts/plan_draft.md                  plans/drafts/architect_review.md
              |                                            |
              | APPROVE                                   |
              v                                            v
        +-----------+        REVISION NEEDED        +-----------+
        |  PLANNER  | <---------------------------+ |  CRITIC   |
        |  (State1) |                              +-----------+
        +-----------+                                      |
              ^                                            | APPROVE
              | REVISION NEEDED / REJECT                   v
              |                                  plans/plan.md
              +---------------------------------- PIPELINE_RALPLAN_COMPLETE
```

1. **State 1 — Planner.** Creates or revises the plan from the spec and prior feedback. Writes to `plans/drafts/plan_draft.md` and MUST include a RALPLAN-DR summary before handing off to the Architect.
2. **State 2 — Architect.** Reviews `plans/drafts/plan_draft.md` for technical feasibility. Must produce the strongest steelman antithesis. **REVISION NEEDED** routes back to State 1; **APPROVE** advances to State 3. **SEQUENTIAL** — await the Architect's complete verdict before invoking the Critic.
3. **State 3 — Critic.** Reviews the Architect-approved draft. Challenges assumptions, surfaces edge cases, verifies security/ops concerns. **REVISION NEEDED** or **REJECT** routes back to State 1; **APPROVE** saves the consensus-approved plan to `plans/plan.md`.
4. **Re-review loop.** Any non-APPROVE verdict loops back to State 1. Maximum **5 iterations** total.
5. **Termination.** Success — all three roles approve, emit `PIPELINE_RALPLAN_COMPLETE`. Failure — max iterations reached, halt and report. Escalation — fundamental disagreement between Architect and Critic, halt and request human input to break the tie.

## Output Artifacts

| File                               | Purpose                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans/spec.md`                    | Foundational requirements. MUST contain `## Acceptance Criteria` (testable boolean statements) and `## Requirement Coverage Map`.                                                                                                                                                                        |
| `plans/drafts/plan_draft.md`       | Working plan during consensus review. MUST include an implementation plan (task breakdown, dependency graph, acceptance criteria, risk register) and the **RALPLAN-DR** summary block.                                                                                                                   |
| `plans/plan.md`                    | Consensus-approved implementation guide. MUST include `## Architecture Decision Record` (Decision, Drivers, Alternatives Considered, Why Chosen, Consequences, Follow-ups), `## Task Breakdown` with exact file paths, `## Dependency Graph`, `## Acceptance Criteria` per task, and `## Risk Register`. |
| `plans/drafts/architect_review.md` | Architect verdict — `APPROVE` or `REVISION NEEDED` (with steelman antithesis and tradeoff tension).                                                                                                                                                                                                      |
| `plans/drafts/critic_review.md`    | Critic verdict — `APPROVE`, `ITERATE`, or `REJECT` (with severity-tagged findings).                                                                                                                                                                                                                      |
| `plans/answers.md`                 | Brainstorm answers accumulation.                                                                                                                                                                                                                                                                         |
| `plans/open-questions.md`          | Brainstorm open questions.                                                                                                                                                                                                                                                                               |

The RALPLAN-DR block in `plan_draft.md` contains: **Principles** (3-5), **Decision Drivers** (top 3), and **Viable Options** (≥2 or explicit invalidation rationale). In **DELIBERATE** mode it additionally contains a **Pre-Mortem** (3 failure scenarios) and an **Expanded Test Plan** (unit / integration / e2e / observability).

## Completion Signals

The pipeline emits exactly one of these strings on termination. Hosts MUST treat them as the canonical stop markers:

- `PIPELINE_RALPLAN_COMPLETE` — consensus reached, `plans/plan.md` written.
- `PIPELINE_EXECUTION_COMPLETE` — execution stage finished (host-defined).
- `PIPELINE_RALPH_COMPLETE` — verification (RALPH) stage finished.
- `PIPELINE_QA_COMPLETE` — QA stage finished.
- `BRAINSTORM_OPEN_QUESTIONS_READY` — brainstorm variant surfaced its open questions.
- `CONSENSUS_APPROVED` — intermediate marker from the Critic on acceptance.
- `CONSENSUS_REJECTED` — intermediate marker from the Critic on rejection.
- `EXPANSION_COMPLETE` — DELIBERATE-mode pre-mortem + expanded test plan finished.
- `PLAN_CREATED` — Planner handed off its draft.
- `PLANNING_COMPLETE` — generic alias for `PIPELINE_RALPLAN_COMPLETE`.

## Termination Conditions

- **Success.** All three roles approve; emit `PIPELINE_RALPLAN_COMPLETE`; `plans/plan.md` exists.
- **Failure.** 5 iterations exhausted without unanimous approval; halt with the last verdict and a summary of unresolved disagreements.
- **Escalation.** Architect and Critic reach a fundamental disagreement the Planner cannot resolve; halt and request human input. Artifacts on disk are preserved.
- **Cancel.** `/ralplan:cancel` ends the session; artifacts on disk are preserved.

## Planning / Execution Boundary

The RALPLAN consensus loop runs entirely within the **planning** stage. On `PIPELINE_RALPLAN_COMPLETE` the pipeline advances to:

1. **Execution** — implements the approved plan.
2. **Verification (RALPH)** — reviews the implementation's quality.
3. **QA** — cycles build / lint / test until green.

Planning writes only markdown artifacts under `plans/` — **never** code files. Each pipeline run creates a single Git worktree under `<repo>-worktrees/` and all planning artifacts live inside that worktree. The `--ralplan` / `--brainstorm` CLI flags and the `/ralplan` slash command both auto-start a pipeline.

## Brainstorm Variant

`/brainstorm` runs the same consensus loop but opens with a question-elicitation phase that writes to `plans/open-questions.md` and accumulates user answers in `plans/answers.md` before the Planner drafts. The `BRAINSTORM_OPEN_QUESTIONS_READY` signal is emitted once questions are surfaced; the loop proceeds to `PIPELINE_RALPLAN_COMPLETE` after consensus on the resulting plan.

## Fallback Mode

There is no single-turn fallback. If the host cannot isolate the three roles into separate agent invocations (e.g. extremely constrained environments), the skill is **not applicable** — the protocol explicitly forbids parent-agent role substitution. In that case, halt and report "ralplan requires role-isolated agent execution; current host does not support it."

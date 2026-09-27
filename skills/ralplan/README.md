# pi-ralplan-local

Consensus-driven implementation planning skill for Pi. The package bundles three role prompts (`planner`, `architect`, `critic`) plus a `SKILL.md` orchestration document that defines a strict Planner → Architect → Critic state machine.

## What it does

`/ralplan [idea]` runs an adversarial planning loop that produces `plans/plan.md` only after three separately-invoked agents reach unanimous approval. The loop prevents **Simulated Consensus** — the failure mode where one generation hallucinates all three approvals in a single output block.

## Usage

```text
/ralplan [idea]            # auto-start planning pipeline
/brainstorm [idea]         # same loop, opens with a question-elicitation phase
/ralplan:status            # show current iteration + last verdict
/ralplan:artifacts         # list files written under plans/
/ralplan:skip              # advance past the current stage
/ralplan:cancel            # end the session (artifacts preserved)
```

Auto-start is slash/flag only. Bare mentions of "ralplan" in prose do **not** re-trigger a fresh pipeline.

## Layout

```
ralplan/
├── SKILL.md            # orchestration: roles, loop, artifacts, signals
├── README.md           # this file
├── package.json        # pi-ralplan-local metadata
└── prompts/
    ├── planner.md      # State 1 — drafts and revises plans
    ├── architect.md    # State 2 — steelman antithesis + technical review
    └── critic.md       # State 3 — final quality gate, severity-tagged findings
```

## Loop at a glance

1. **Planner** drafts `plans/drafts/plan_draft.md` (with RALPLAN-DR summary).
2. **Architect** reviews and writes `plans/drafts/architect_review.md` (APPROVE / REVISION NEEDED).
3. **Critic** reviews and writes `plans/drafts/critic_review.md` (APPROVE / ITERATE / REJECT).
4. Non-APPROVE verdicts loop back to the Planner. Max 5 iterations.
5. Unanimous approval → `plans/plan.md` + `PIPELINE_RALPLAN_COMPLETE`.

## Completion signals

`PIPELINE_RALPLAN_COMPLETE`, `PIPELINE_EXECUTION_COMPLETE`, `PIPELINE_RALPH_COMPLETE`, `PIPELINE_QA_COMPLETE`, `BRAINSTORM_OPEN_QUESTIONS_READY`, `CONSENSUS_APPROVED`, `CONSENSUS_REJECTED`, `EXPANSION_COMPLETE`, `PLAN_CREATED`, `PLANNING_COMPLETE`.

## Hard constraints

- Each role MUST be a separately invoked agent.
- The parent agent MUST NOT perform role work itself.
- No single-turn consensus — drafts, reviews, and approvals come from different generations.
- The Architect and Critic must review independently and support findings with evidence; first-pass approval is valid when the review criteria are satisfied.

## Install / wire up

Drop the folder under your Pi skills directory, or install as a package:

```bash
npm install ./skills/ralplan
```

The `package.json` registers the skill via the `pi.skills` field.

## License

MIT.

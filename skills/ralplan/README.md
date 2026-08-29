# pi-ralplan-local

Consensus-driven planning for Pi. The skill defines isolated Planner, Architect,
and Critic roles that independently review one immutable Planner snapshot.

## Safety contract

RALPLAN is planning-only. Every workflow result is `pending_approval: true` and
`execution_halted: true`; no plan file, marker, `executeOnConsensus` argument,
or consensus result authorizes source mutation or execution. A separate
host-controlled approval and handoff is required for any later phase.

- Planner returns explicit `DRAFT_READY` structured output.
- Architect returns explicit `APPROVE` or `REVISION_NEEDED`.
- Critic returns explicit `APPROVE`, `ITERATE`, or `REJECT`.
- Architect and Critic run sequentially on the same fixed Planner snapshot;
  Critic receives neither Architect output nor its path.
- Critic still runs after Architect rejection or failure.
- Any non-approval runs a complete loop, capped at five rounds.
- Missing or failed output is never approval and never receives an executable
  recommendation.

## Usage

```text
/ralplan [idea]
/brainstorm [idea]
/ralplan:status
/ralplan:artifacts
/ralplan:cancel
```

Slash/flag invocation is explicit. A bare prose mention does not start a new
pipeline. Status, artifact, and cancellation commands are host features; the
workflow VM cannot intercept arbitrary parent text or pause for a user.

## Bundled examples

- `examples/workflows/ralplan-occ.mjs` is the canonical OCC-facing workflow.
  `gate: false` bypasses its local heuristic. `interactive` only enables
  non-blocking `[pending approval]` marker text; it does not wait for a user.
  `executeOnConsensus` is accepted only for compatibility and is ignored.
- `examples/workflows/ralplan-consensus.mjs` is a compact SHORT-only example.
  It shares the isolation, fixed-snapshot, verdict, loop, and pending boundary
  contract but does not advertise DELIBERATE or interactive parity.

## Modes

SHORT is the default. DELIBERATE mode is available in the canonical OCC flow
and requires exactly three actionable pre-mortem scenarios plus Unit,
Integration, E2E, and Observability test-plan coverage. Missing sections are a
non-approval.

## Layout

```text
ralplan/
├── SKILL.md
├── README.md
├── package.json
└── prompts/
    ├── planner.md
    ├── architect.md
    └── critic.md
```

## Install

```bash
npm install ./skills/ralplan
```

The package registers the skill through its `pi.skills` metadata.

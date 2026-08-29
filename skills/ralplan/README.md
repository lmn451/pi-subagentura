# pi-ralplan-local

Verified consensus planning for Pi. The skill defines isolated Planner,
Architect, and Critic roles over immutable, bounded Markdown artifacts.

## Contract

- Planner writes `drafts/<planName>_draft-rN.md`.
- A read-only verifier checks path, regular-file existence, 1 MB size bound,
  required headings, round/kind, and SHA-256.
- Architect and Critic sequentially review that same verified draft and return
  its digest; Critic receives no Architect output or path.
- Review artifacts are separately verified before verdicts count.
- A Consolidator writes `<planName>.md` only after both explicit approvals; the
  final plan is verified before consensus is reported.
- Every result remains `pending_approval: true` and `execution_halted: true`.

`requirementsTraceability: true` enables an advisory Analyst preflight and a
required Requirement Coverage Map. Analyst is not a consensus role. DELIBERATE
mode in the canonical OCC workflow requires exactly three pre-mortem scenarios
plus Unit, Integration, E2E, and Observability coverage.

## Examples

- `examples/workflows/ralplan-occ.mjs` — canonical OCC flow with gate,
  DELIBERATE mode, requirements traceability, and reviewer model overrides.
- `examples/workflows/ralplan-consensus.mjs` — compact SHORT-only compatibility
  flow with the same artifact and independent-review guarantees.

The workflow VM cannot pause for user approval. `interactive` only controls
non-blocking markers. `executeOnConsensus` is ignored compatibility input. A
plan, digest, completion marker, or consensus result never authorizes execution.

## Host approval

The extension persists owner/session-scoped state in mode-0600
`.pi/ralplan-state.json`. Inspect with `get_ralplan_status`; explicitly approve
an exact `{runId, planDigest}` with `approve_ralplan`, or use
`reject_ralplan`/`cancel_ralplan`. `prepare_ralplan_recovery` exposes
same-session interrupted evidence read-only and never auto-resumes work.
Approval records an inactive `approved_handoff`; it does not execute the plan.

## Install

```bash
npm install ./skills/ralplan
```

# pi-ralplan-local

Readable RALPLAN skill material plus its bundled executable workflow
translation. The ordinary `workflow` tool—not a RALPLAN-specific extension
surface—enforces isolated Planner, Architect, and Critic roles over immutable,
bounded Markdown artifacts.

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

- `examples/workflows/ralplan-occ.mjs` — reference translation with optional
  gate markers, DELIBERATE mode, requirements traceability, and reviewer model
  overrides.
- `examples/workflows/ralplan-consensus.mjs` — compact SHORT-only compatibility
  flow with the same artifact and independent-review guarantees.

Direct workflow invocation starts planning. Set `gate: true` only to demonstrate
the upstream short-prompt heuristic, or `interactive: true` to emit non-blocking
checkpoint markers. `executeOnConsensus` is ignored compatibility input. A plan,
digest, completion marker, or consensus result never authorizes execution.

## Install

```bash
npm install ./skills/ralplan
```

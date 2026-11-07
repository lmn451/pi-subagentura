# PR #194 current-master preparation

## Scope and integration

This local candidate merges `origin/master` at
`e2e051363e39dff6b5436d655bfe6f542782fc24` into the existing published
`feat/workflows-v4` head `747ee03dca5a52ac93f79070991d6482249fef69`.
Published history is preserved; this is not a rebase or release. Package and
lockfile follow master's 4.2.1 version and Pi SDK 1.5.0 development pins.
Dependencies were installed locally with `npm ci --ignore-scripts` without
regenerating the tracked lockfile.

PR #194 remains the single aggregate delivery replacing the former #158 stack.
Trusted agent-authored JS/ESM and typed V4 source owns control flow and retains
intermediate values in program state. Parent progress/results remain concise.
Explicit workflow intent is required; workflows are not automatic routing for
every request. Session-scoped, non-durable execution remains the default,
including saved `/workflows` launches. Existing explicit `durable: true` opt-in
is retained, not expanded. Authoring review is model guidance, not a runtime
approval gate. Further storage/crash-consistency work remains deferred to
`pi-durable`, as directed in the October 24 decision.

Seven conflicts were resolved: retain both packaged changelog and workflow
runtime documentation, preserve unreleased workflow notes above master's
released changelog sections, retain both prompt assets and workflow companions
in the architecture inventory, preserve bounded native signal decoding and
both regression sets, combine current SDK dependency assertions with the V4 CI
runtime tests, and remove obsolete fixed README tool counts.

## Unique-fix disposition

- #193 ordinary failure diagnostics: reproduced two failures before editing
  runtime code. An ordinary failed runner was labeled `completion` rather than
  `turn`, and an earlier generic fallback hid later concrete schema evidence.
  The focused worker fix permits concrete evidence to replace fallback evidence,
  without changing first-concrete-failure precedence. Two new regressions cover
  those cases; the existing collected V4 outcome assertion follows the corrected
  stage. No raw diagnostic text is added to telemetry.
- #193 native signal diagnostics and canonical inherited session projection:
  already retained in this aggregate/current master; native signal handling and
  its additional master regressions are preserved, not replaced wholesale.
- #193 capacity rejection, intent-first cancellation, retryable marker failures,
  and completion ownership: retain #194's existing implementation and regression
  coverage. Do not import the alternative marker-before-intent ordering.
- #193 persistent telemetry lifecycle claims/confirmations, original correlation
  recovery, and cancellation capture receipts: not imported. They remain
  deferred durable-only work, not a claim of fully integrating #193 or exactly-once
  telemetry. Transport delivery remains best effort.
- #83 has no PR-body requirements beyond its workflow-redesign title. Its historical
  programmable-workflow intent is represented by the retained aggregate; no
  competing architecture was introduced.
- #85's CAS/lease/authority/process-adoption architecture and Node 26-only floor
  are not imported. Explicit recovery, opt-in routing, honest side-effect limits,
  isolated process testing, and packaging requirements are retained where they
  apply. This candidate does not claim #85's F01–F20 certification.

## Verification

Local platform: macOS arm64, Node 26.2.0, locked Pi SDK 1.5.0, tmux and Zellij
0.45.1. Final checks are recorded in the handoff accompanying the commit:
full Vitest suite (126 files passed, 2 skipped; 2,684 tests passed, 11 skipped),
typecheck, repository formatting (282 files), package dry run (101 files),
real-Pi terminal E2E (53 tests), and isolated tmux integration (12 tests). The full suite includes Pi-session,
workflow runtime/recovery/cancellation/privacy, property, type-contract, and
published-tarball consumer coverage. Terminal tests use deterministic providers,
private sessions/workspaces and network guards, not a live external LLM.

Zellij is an explicit validation limitation: its production file and integration
suite are byte-identical to current master. Ambient and private HOME/XDG runs
failed 11 pane-creation scenarios; three CLI/capability cases passed. A direct
production `createPane` probe surfaced the macOS Unix socket-path limit
(106 bytes versus 103); shortening `TMPDIR` allowed startup but then exposed
`Failed to determine pane ID after creating pane` on local Zellij 0.45.1.
No unrelated backend change or test skip was introduced. The throwaway probe
was removed. Full Zellij integration is not certified by this preparation.

The minimum Node 24.12.0 and alternate Pi SDK matrix, Herdr live integration,
real-provider/model compliance, broad crash-consistency, and PostHog ingestion
were not validated locally. Historical green CI is not current-head evidence.
No push, PR comment/update, protected merge, tag, publication, review bypass,
branch deletion, or shared-checkout edit is part of this preparation.

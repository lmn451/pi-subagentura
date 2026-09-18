# ADR: Orchestratorv2 Durable Workspace Slots

## Status

Proposed for the first implementation PR.

## Decision

Use a repository-scoped, versioned workspace ledger keyed by canonical Git common-directory identity. Keep physical worktree slots stable while branch/work-item assignments change through epoch-bound, fsynced transitions. The orchestrator verifies Git state and owns release/reuse decisions; child reports and PR observations are advisory.

## Drivers

1. Reuse worktrees for new branches without data loss or unbounded worktree creation.
2. Recover safely across crashes, reloads, and multiple Pi parents.
3. Preserve existing routing, interactive child, artifact, telemetry, and package boundaries.

## Alternatives Considered

- **Extend interactive state/artifact events:** rejected because they are parent-session scoped and own delivery/cursor semantics.
- **One worktree per branch:** rejected because it creates unbounded worktrees.
- **Child-owned release/PR authority:** rejected because children can crash, become stale, or report unverified facts.
- **SQLite:** rejected because it adds dependency and migration cost without excluding unmanaged Git writers.
- **PR-gated recycling:** rejected because providers are optional and PR state is not a filesystem safety predicate.

## Why Chosen

The Git common directory is the shared lifetime for linked worktrees, while a Pi parent session is not. A bounded JSON ledger supports explicit validation, fsync-backed operation intent, retained assignment history, and fail-closed recovery without changing the existing artifact or routing protocols.

## Consequences

- The first PR must include real new-branch reassignment and temporary linked-worktree integration tests.
- Unknown occupancy, claims, Git state, or provider observations can block work until explicit reconciliation.
- Cooperative claims do not protect against arbitrary same-UID processes.
- Provider adapters and history archival are deferred.

## Follow-ups

- Add provider adapters only behind the neutral PR observation interface.
- Add explicit user-confirmed history export/archival before capacity is reached.
- Consider process-level isolation if unmanaged same-UID writers become part of the threat model.

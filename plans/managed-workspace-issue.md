## Goal

Implement the first Git-only Orchestratorv2 managed-workspace increment while preserving legacy and nested behavior.

## Phased plan

1. **Foundation:** shell-free bounded Git probing, canonical common-dir identity, versioned repository ledger, owner markers, atomic temp+rename plus fsync, O_NOFOLLOW, repository/mutation locks, revision CAS, and generation fencing.
2. **Top-level provisioning:** require bounded `workItemId` for top-level Orchestratorv2 interactive spawns and reserve/provision/verify one unique branch/worktree with `git worktree add --lock -b`; persist state before child input and finalize after launch.
3. **Trusted projection:** join parent-authoritative workspace receipts, routing metadata, runtime state, and fresh Git observations in `list_orchestrator_agents`; reconcile read-only on startup/reload/resume.
4. **Nested visibility:** expose inherited workspace and external/unknown nested locations observationally at the root while preserving direct-lead authority.
5. **Future:** add a Jujutsu (`jj`) backend only behind the same contract. No jj implementation in this issue.

## Acceptance criteria

- Every top-level V2 child has a durable assignment before launch; duplicate/concurrent claims have one winner.
- Main checkout is unchanged; Git identity, branch, HEAD, path, lock/prunable, and working-tree drift are detected fresh.
- Owner markers match ledger identity; missing/mismatch/unknown state is visible and non-actionable.
- Reload, resume, crash boundaries, completion, cancel, `/new`, `/fork`, and `/quit` retain state without implicit adoption or cleanup.
- Automatic paths never force reset/clean/stash/prune/remove/delete/merge/rebase/push/fetch or repair.
- Legacy and nested behavior, routing authority, lineage, artifact/delivery, completion coordination, mux, telemetry, and session semantics remain intact.
- Required checks pass: typecheck, tests, formatting, and pack dry-run.

## Non-goals

Reusable slots, path leases, PR/merge/push integration, destructive cleanup, and jj are deferred.
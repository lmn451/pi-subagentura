# Deep Interview Spec: Orchestratorv2 Workspace and Branch State

## Acceptance Criteria

- A released physical worktree slot can be reassigned to a new branch without creating another worktree.
- Previous branch/work-item history remains queryable after slot reuse.
- Running or idle children are never silently rebound to another branch.
- Dirty, conflicted, missing, moved, in-progress, or uncertain slots are blocked; no force/reset/clean/stash repair occurs.
- Child reports are bounded, epoch/turn-bound, idempotent advisory input only.
- Publication is verified only from an exact candidate commit observed at a configured remote ref.
- PR association and provider observation are separate; PR state never alone releases or recycles a slot.
- Operation intent is fsync-backed before Git mutation; recovery finalizes matching after-state, leaves matching before-state pending, and blocks mismatch/unknown.
- Concurrent claims serialize managed repository mutations; stale/unknown ownership cannot be taken over automatically.
- Reload/restart preserves assignment history and requires explicit cross-session adoption.

## Requirement Coverage Map

| Requirement                    | Spec section                                                     |
| ------------------------------ | ---------------------------------------------------------------- |
| Reusable stable worktree slots | Proposed Domain Model; Lifecycle and Reuse                       |
| Branch/work-item history       | Work item and branch assignment; Acceptance Criteria             |
| Advisory child protocol        | Child Protocol and Authority                                     |
| Git publication evidence       | Publication and PR evidence                                      |
| Provider-neutral PR model      | Publication and PR evidence; Non-Goals                           |
| Crash-safe operations          | Operation intent and recovery; Persistence and recovery criteria |
| ADR and rejected alternatives  | ADR: Repository-Scoped Workspace Ledger and Reusable Slot Pool   |

See `plans/deep-interview-orchestratorv2-workspace-state.md` for the complete requirements, ADR, technical context, ontology, and transcript. The user has explicitly delegated unresolved choices to Astra and requested implementation followed by an ADR-backed PR.

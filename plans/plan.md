# Revised Plan: Orchestratorv2 Workspace and Branch State

## RALPLAN-DR Summary

**Mode:** DELIBERATE

### Principles

- **[P1] Fresh Git state controls safety.** Ledger state and child reports never substitute for a fresh probe.
- **[P2] Durable intent precedes mutation.** No slot-changing Git command runs before an fsynced intent and claim.
- **[P3] Slots outlive assignments.** Reuse changes assignment and epoch, not physical worktree identity or history.
- **[P4] Fail closed.** Dirty, ignored, conflicted, missing, moved, locked, prunable, malformed, stale-owned, or uncertain state blocks action.
- **[P5] Existing routing/artifact protocols remain separate.** Workspace state is not merged into `.pi/subagentura-state.json`, artifact cursors, or routing authority.

### Top Decision Drivers

1. **Data safety** — prevent dirty-worktree reuse, branch races, force repairs, and accidental child rebinding.
2. **Crash/session recovery** — retain durable identity to distinguish safe completion from uncertainty.
3. **Brownfield compatibility** — preserve existing child lifecycle, routing, delivery, package exports, and tool behavior.

### Viable Options

**Option A — Repository-scoped JSON ledger plus dependency-light Git adapter**

- Pros: correct Git-common-dir lifetime, no new runtime dependency, explicit bounded validation and fsync protocol.
- Cons: cooperative rather than OS-level exclusion; strict fail-closed behavior can require manual recovery.

**Option B — SQLite repository database**

- Pros: transactional storage and locking.
- Cons: new dependency/native packaging surface and unnecessary migration burden.

**Option C — Extend `.pi/subagentura-state.json` or artifact logs**

- Pros: reuses existing persistence.
- Cons: wrong lifetime and authority; conflates child delivery cursors with repository ownership.

**Decision:** Option A. No automatic history compaction, stale-owner takeover, destructive repair, or provider-specific PR adapter is added.

### Pre-Mortem

- **Crash after `git switch`** → durable before/after fingerprints classify exact after, exact before, or blocked mismatch; never replay automatically.
- **Child reports clean while the slot is dirty** → reports remain advisory; release/reuse performs a fresh status/admin probe.
- **A restarted parent takes another session’s assignment** → durable process/session owner identity and explicit adoption prevent automatic takeover.

### Expanded Test Plan

- Unit-test every parser, validator, ledger bound, lock path, recovery classification, and telemetry mapping.
- Use real temporary repositories for main, linked, detached, unborn, dirty, ignored, conflicted, locked, prunable, moved, and missing worktrees.
- Use separate Vitest child processes for concurrent claims and injected crash points.
- Verify no `.delta/worktrees` test copies are discovered.
- Run focused workspace suites, then all required validation commands.

## Scope and Release Phases

### Phase A — Discovery and reconciliation

Implement read-only Git discovery plus durable observation reconciliation. A missing ledger may be reported as absent; discovery does not silently register or claim every worktree. `workspace_reconcile` never releases, adopts, switches, cleans, prunes, deletes, or launches.

### Phase A — Foundation and reconciliation

Implement T0–T3: schemas, repository identity, read-only Git discovery, durable ledger/claims, occupancy classification, advisory proposals, exact publication evidence, and provider-neutral PR records. Phase A performs no branch switch, branch creation, release, adoption, child launch, or destructive Git operation.

### Phase B — First PR: reusable slots and new-branch reassignment

Implement T4–T6 together. This is the first usable release and includes the core requirement: explicitly release a managed clean slot, switch/create the requested new branch through the intent/recovery protocol, increment the assignment epoch, and bind a fresh child. Existing-child binding is allowed only for the exact managed idle child/slot/epoch; a running or foreign child is never rebound. Branch/work-item history remains queryable and PR state is not required.

### Phase C — Surface completion

Implement T7: session lifecycle fencing, telemetry, documentation, package/API surfaces, Vitest/.prettier exclusions, and published-tarball coverage. PR adapters remain future work; Phase A only stores provider-neutral association/observation records and never performs network/provider discovery.

## Authority and Lifetime Model

| Concern                           | Authority                                                                 | Lifetime                                  | Explicit non-authority                 |
| --------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Repository identity               | Fresh Git probe of common-dir, object format, repository kind             | Durable ledger scope                      | Parent `ctx.cwd` alone                 |
| Physical slot identity            | `main` or Git linked-worktree administrative key                          | Permanent ledger history                  | Worktree list order                    |
| Current path/status/head          | Fresh Git/filesystem observation                                          | Current observation                       | Cached ledger, mux screen, child prose |
| Assignment/history                | Repository ledger                                                         | Survives restart, reload, `/new`, `/fork` | Routing cache                          |
| Repository mutation serialization | Durable repository/slot claim plus ledger lock                            | Operation lifetime; stale claims block    | `SessionOwnerToken`                    |
| Parent runtime ownership          | `SessionOwnerToken` and live scope generation                             | Current process/session                   | Persisted owner IDs                    |
| Durable owner                     | Random process-instance ID plus Pi parent-session ID; PID diagnostic only | Until explicit release/adoption           | PID/time alone                         |
| Child binding                     | Ledger assignment plus exact marker/state                                 | Assignment epoch                          | Child self-report                      |
| Child facts                       | Parent-validated proposal receipts                                        | Bounded assignment/turn history           | Child/Bash/artifact prose              |
| Publication                       | Exact candidate OID at configured remote ref                              | Bounded observation history               | Push report or PR state                |
| PR association                    | Parent/child advisory record                                              | Bounded history                           | Association alone                      |
| PR observation                    | Optional provider result/manual unverified observation                    | Bounded history                           | PR as release authority                |
| Artifact/delivery                 | Existing artifact/delivery protocols                                      | Existing lifetime                         | Workspace ledger                       |
| Routing                           | Existing parent branch authority/cache                                    | Existing lifetime                         | Workspace assignment                   |

A same-UID process can bypass this extension; fresh probes then classify the slot dirty, mismatched, or unknown and block it.

## Concrete Ledger Schema

Store beside canonical Git common directory:

```text
<git-common-dir>/subagentura-workspace.json
<git-common-dir>/subagentura-workspace.lock
<git-common-dir>/subagentura-workspace.lock.recovery
```

```ts
interface WorkspaceLedgerV1 {
  schemaVersion: 1;
  ledgerRevision: number;
  repository: RepositoryRecord;
  slots: SlotRecord[];
  branches: BranchRecord[];
  workItems: WorkItemRecord[];
  assignments: AssignmentRecord[];
  claims: ClaimRecord[];
  operations: OperationIntent[];
  outcomes: OperationOutcome[];
  publications: PublicationObservation[];
  prAssociations: PrAssociation[];
  prObservations: PrObservation[];
  proposalCursors: Record<string, number>;
  proposalReceipts: ProposalReceipt[];
}
```

```ts
interface RepositoryRecord {
  repoId: string;
  commonDir: string;
  gitDir: string;
  objectFormat: "sha1" | "sha256";
  publicationRefs: Array<{ remote: string; ref: string }>;
}
interface SlotRecord {
  slotId: string;
  kind: "main" | "linked";
  adminKey: string;
  root: string;
  gitDir: string;
  state:
    | "unmanaged"
    | "available"
    | "reserved"
    | "assigned"
    | "transitioning"
    | "blocked"
    | "adoption_required";
  revision: number;
  assignmentEpoch: number;
  activeAssignmentId?: string;
  observation?: WorktreeObservation;
}
interface WorktreeObservation {
  root: string;
  filesystemIdentity: string;
  branchRef?: string;
  headOid?: string;
  checkout: "branch" | "detached" | "unborn" | "unknown";
  status:
    | "clean"
    | "dirty"
    | "ignored"
    | "conflicted"
    | "in_progress"
    | "unknown";
  admin: "normal" | "locked" | "prunable" | "unknown";
}
interface AssignmentRecord {
  assignmentId: string;
  slotId: string;
  workItemId: string;
  branchRef: string;
  epoch: number;
  expectedRoot: string;
  expectedHeadOid?: string;
  owner: DurableOwner;
  childId?: string;
  state: "reserved" | "bound" | "retired" | "blocked";
}
interface DurableOwner {
  processInstanceId: string;
  parentSessionId?: string;
  nonce: string;
  pid?: number; // diagnostic only
}
interface OperationIntent {
  operationId: string;
  action: "switch_existing" | "create_branch";
  claimId: string;
  assignmentId: string;
  fromEpoch: number;
  toEpoch: number;
  expectedRevision: number;
  requestedBranchRef: string;
  requestedBaseOid?: string;
  before: WorktreeObservation;
  intendedAfter: WorktreeObservation;
  phase: "prepared" | "committed" | "interrupted" | "blocked";
}
interface OperationOutcome {
  operationId: string;
  classification:
    | "after"
    | "before"
    | "mismatch"
    | "unknown"
    | "admin_locked"
    | "parse_error"
    | "timeout"
    | "cancelled";
  command: "not_started" | "success" | "error" | "timeout" | "cancelled";
  observed?: WorktreeObservation;
  errorCode?:
    | "timeout"
    | "cancelled"
    | "parse_error"
    | "output_limit"
    | "ledger_io"
    | "branch_conflict"
    | "unknown";
}
interface AdoptionRequest {
  repoId: string;
  slotId: string;
  assignmentId: string;
  expectedRevision: number;
  expectedEpoch: number;
  confirmed: boolean;
  confirmationToken?: string;
}
interface RecoveryRequest {
  operationId: string;
  expectedRevision: number;
  action: "reconcile" | "abandon-before-state";
  confirmed: boolean;
  confirmationToken?: string;
}
interface RecoveryDecision {
  operationId: string;
  classification:
    | "after"
    | "before"
    | "mismatch"
    | "unknown"
    | "admin_locked"
    | "parse_error"
    | "timeout"
    | "cancelled";
  slotState: "transitioning" | "available" | "blocked" | "adoption_required";
  assignmentState: "reserved" | "bound" | "retired" | "blocked";
  claimState: "held" | "released" | "orphaned";
  replayed: false;
}
interface BranchRecord {
  branchRef: string;
  headOid?: string;
  state: "present" | "missing" | "unknown";
}
interface WorkItemRecord {
  workItemId: string;
  branchRef: string;
  lifecycle: "active" | "parked" | "archived";
  assignmentIds: string[];
}
interface ClaimRecord {
  claimId: string;
  scope: "repository" | "slot";
  slotId?: string;
  owner: DurableOwner;
  state: "held" | "released" | "orphaned";
  claimEpoch: number;
  acquiredAt: number;
}
interface PublicationObservation {
  observationId: string;
  workItemId: string;
  assignmentEpoch: number;
  remote: string;
  ref: string;
  candidateOid: string;
  candidateBranchRef: string;
  observedOid?: string;
  result: "equal" | "different" | "not_advertised" | "unknown";
  freshness: "fresh" | "stale" | "unknown";
  source: "git_remote_probe";
  checkedAt: number;
  errorCode?:
    | "auth"
    | "timeout"
    | "unavailable"
    | "malformed"
    | "remote_changed";
}
interface PrAssociation {
  associationId: string;
  workItemId: string;
  provider: string;
  externalId: string;
  claimedHeadOid?: string;
  claimedBaseRef?: string;
  provenance: "parent" | "child_proposal";
  recordedAt: number;
}
interface PrObservation {
  observationId: string;
  associationId: string;
  state: "unknown" | "open" | "closed" | "merged";
  draft?: boolean;
  verification:
    | "unsupported"
    | "unverified"
    | "verified"
    | "unavailable"
    | "mismatch";
  headRepo?: string;
  headRef?: string;
  headOid?: string;
  baseRef?: string;
  freshness: "fresh" | "stale" | "unknown";
  source: "provider" | "manual_parent";
  recordedAt: number;
}
interface ProposalReceipt {
  receiptId: string;
  proposalId: string;
  payloadHash: string;
  childId: string;
  assignmentEpoch: number;
  turnId: string;
  result: "accepted" | "duplicate" | "stale" | "invalid";
  recordedAt: number;
}
```

Initial slot epochs are `0`; each reservation/reassignment atomically increments the epoch. `workspace_adopt` accepts `{ repoId, slotId, assignmentId, expectedRevision, expectedEpoch, confirmed, confirmationToken? }`; a false call issues a single-use token bound to the exact payload, session generation, and ten-minute TTL, while a true call requires the identical payload plus the token in a later real user message. `workspace_recover` accepts the exact `operationId`, expected revision, and an explicit `action: "reconcile" | "abandon-before-state"`; it never replays Git. History capacity rejects before mutation and never evicts silently.

Caps are exported and tested: 8 MiB ledger, 128 slots, 512 work items, 2,048 assignments, 256 intents, 512 outcomes, 512 publication records, 256 PR associations, 512 PR observations, 512 proposal receipts. At capacity, reject before mutation; never silently evict. Future/malformed/oversized/symlinked/wrong-mode ledgers fail closed.

`repoId` hashes a fixed namespace, canonical Git common directory, and object format. Slot identity is `main` or a linked-worktree administrative key recovered from `worktree list --porcelain -z` and validated against the administrative marker. Main, detached, unborn, missing, moved, locked, and prunable states are explicit; unknown states cannot be registered/reused.

Assignments retain `assignmentEpoch`, full branch ref, expected path/head, child binding, durable owner, and lifecycle. Every reuse increments the epoch; old records remain history.

Claims use a random process-instance ID plus parent-session ID; PID is diagnostic only. `SessionOwnerToken` is never serialized. A new process/session requires explicit adoption.

Operation intents contain complete before/expected-after Git fingerprints, claim ID, assignment epoch, and requested branch/base OID. Outcomes classify exact after, exact before, mismatch, unknown, admin lock, timeout, cancellation, and parse failures.

### Recovery decision table

| Classification                        | Intent phase                                       | Claim state            | Slot state                        | Assignment state     | Automatic action                                                   |
| ------------------------------------- | -------------------------------------------------- | ---------------------- | --------------------------------- | -------------------- | ------------------------------------------------------------------ |
| `after`                               | `committed`                                        | `released` after fsync | `available` or explicitly rebound | `bound`/`retired`    | Persist the recovered outcome; never rerun Git                     |
| `before`                              | `interrupted`                                      | `held` or `orphaned`   | `transitioning`                   | `reserved`/`blocked` | Require explicit retry authorization; never replay automatically   |
| `mismatch`                            | `blocked`                                          | `held`                 | `blocked`                         | `blocked`            | Require manual reconciliation; no switch/reset/cleanup             |
| `unknown`                             | `blocked`                                          | `held`                 | `blocked`                         | `blocked`            | Preserve intent and evidence; no takeover or replay                |
| `admin_locked`                        | `blocked`                                          | `held`                 | `blocked`                         | `blocked`            | Preserve Git marker; operator clears it outside the manager        |
| `timeout`, `cancelled`, `parse_error` | `interrupted` then `blocked` if probe is not exact | `held` or `orphaned`   | `blocked`                         | `blocked`            | Re-probe only; an untrusted response never authorizes a transition |

The operation ID and exact payload are idempotency keys. A repeated request returns the recorded decision; a different payload using the same operation ID is rejected. `abandon-before-state` is accepted only after a fresh exact `before` classification; it is rejected for `after`, `mismatch`, `unknown`, `admin_locked`, `timeout`, `cancelled`, or `parse_error`. Claims are released only after the outcome ledger write is fsynced.

Publication records an exact candidate OID at an exact configured remote ref. PR data is split into advisory association and provider-neutral observation (`open`, `closed`, `merged`, `draft`, `unknown` plus `verified`, `unverified`, `unsupported`, `unavailable`, `mismatch`). PR never releases a slot.

## Safe Git Adapter

`src/workspace-git.ts` uses an injected `spawn("git", argv, { shell: false })` runner with explicit cwd, fixed timeout/cancellation, stdout/stderr caps, and process-group termination. Start from an allowlisted environment; remove all inherited `GIT_*` variables except the explicitly set safe values, disable prompts/credential helpers/pagers/editors/askpass/SSH interactivity, disable fsmonitor, set a private empty `core.hooksPath`, and reject remote-helper schemes. Git output is never persisted; only closed error codes are returned.

Read-only allowlist: `rev-parse`, `worktree list --porcelain -z`, `status --porcelain=v2 -z --untracked-files=all --ignored=matching`, `ls-files -v -z`, `config --null --get-regexp '^filter\\..*(clean|smudge|process)$'`, `check-attr --all -z --stdin`, `check-ref-format`, `ls-remote --refs --exit-code`. Mutation allowlist in the first PR: non-force `git switch` existing branch or `git switch --create` with a full resolved base OID. Never reset, clean, stash, prune, delete, force, push, merge, rebase, unlock, or use shell interpolation.

Strictly parse NUL-delimited worktree/status/index/attribute output, full object-format OIDs, and full `refs/heads/...` refs. Any assume-unchanged or skip-worktree index flag, configured clean/smudge/process filter, path-level filter attribute, untracked/ignored/conflicted record, or Git admin marker (`index.lock`, merge/cherry-pick/revert/bisect/rebase/sequencer, locked/prunable worktree) blocks release and mutation. Unexpected/truncated output is unknown. Branch checked out elsewhere blocks.

Canonical ledger state stores full `refs/heads/name` refs, but the adapter derives the CLI branch argument `name` by removing exactly one `refs/heads/` prefix and validates it with `check-ref-format --branch`; it never passes the full ref to `git switch`. New-branch creation receives a full base OID but a short validated branch argument. Exact argv tests cover slashes, spaces rejection, branch conflicts, hidden index flags, filters, hook execution, and forbidden force/reset/clean commands.

## Lifecycle Ordering

### Discovery

Resolve repository identity from `ctx.cwd` via Git, load the ledger, and fresh-probe all worktrees. Occupancy scanning is explicit: inspect every live `SessionScope.interactiveStates` map, the aggregate interactive registry, persisted state entries under the canonical state roots, child `INTERACTIVE_ARTIFACT_OWNER_FILE`/`workspace-assignment.json` markers, known lineage manifests, and the parent’s own `ctx.cwd`/active worktree. Canonicalize paths and reject symlink/replacement identity changes. A legacy/nested/foreign/markerless child or a parent/other-scope occupant is `occupied`; any unreadable or incomplete scan is `occupancy_unknown`; both states block reuse. Missing ledger does not auto-register worktrees. This remains cooperative: unmanaged same-UID writers can evade discovery, so every managed transition performs a fresh Git probe.

### Reservation

Acquire repository claim; validate revision/epoch; fresh-probe; reject foreign/pending/uncertain state; reserve epoch and assignment; fsync ledger. For any branch-changing operation in the first PR, write/fsync the operation intent before Git. For same-branch reuse, continue only after the fresh occupancy and child-release gates.

### Existing child bind

Explicit `childMode: "existing"` and exact child ID only. Require idle, pane-alive, same scope, matching marker, canonical `workingCwd`, branch, slot, assignment, and epoch. Never rebind a running/unknown/foreign/markerless child.

### New child launch

Explicit `childMode: "new"` uses a manager-owned prepare/dispatch/finalize transaction. Prepare allocates the child ID, writes the assignment marker/prompt context, persists the reservation and expected child identity, and then calls `launchInteractiveSubagent` through a new preallocated-ID seam. Dispatch creates the pane and existing interactive state using the same rollback rules as today. Finalize verifies the pane, marker, `workingCwd`, branch, slot, epoch, and completion registration before changing the assignment to `bound`. A crash before pane creation removes only the reservation; after pane creation or dispatch failure retains `reserved`/`adoption_required` state and never kills or rebinds blindly. Changes are limited to the launcher seam in `src/interactive-tmux.ts`, the caller/schema path in `src/tools/interactive.ts`/`src/schemas.ts`, and marker persistence; artifact cursors and completion events remain unchanged.

### Release and Phase B reuse

Release requires exact assignment/epoch/child plus a fresh clean/non-ignored/non-conflicted/non-in-progress/normal-admin probe. A completed child is normally `idle`, not terminal; therefore managed release has an explicit `closeChild: true` path that records a parent cancellation/retirement, waits for pane death/terminal artifact evidence, and only then releases. `closeChild: false` returns `child_idle` and leaves the assignment bound. Reuse includes a different requested branch in the same physical slot: persist a prepared intent, perform the allowlisted switch/create, verify the exact after-state, increment the epoch, and bind a fresh child. A lost response never repeats a committed operation.

### Controlled branch transition and recovery

Persist complete before/after intent; run one allowlisted switch/create command; fresh-probe; persist outcome before claim release. Exact after finalizes; exact before remains pending; mismatch/unknown blocks; never replay or reverse automatically. Launch/bind child only after durable exact after-state.

### Session lifecycle

Existing shutdown fencing and interactive rehydration stay intact. Workspace callbacks are fenced before old-scope cleanup; workspace reconciliation runs after existing child rehydration and before poller startup. Same process/session may reattach exact claims; restart/other session is adoption-required. `/new`/`/fork` preserve the ledger and do not implicitly release/adopt assignments. Explicit adoption uses the existing confirmation token flow and fresh evidence; dead PID alone is not authority.

## Child Proposal Protocol

`workspace-assignment.json` and `workspace-proposals.ndjson` live in the child artifact directory. A proposal payload is canonical JSON with sorted keys and bounded UTF-8 strings: `{ schemaVersion, proposalId, childId, assignmentId, assignmentEpoch, turnId, kind, facts, reportedAt }`. The receipt stores `payloadHash` (SHA-256 of canonical payload) and the proposal ID. A same-ID retry is a duplicate only when the canonical hash matches; a different hash is `invalid` and never overwrites the first receipt. Child ID, assignment, epoch, and turn are derived/verified. Stale epochs/turns, foreign paths, unreadable files, and oversized records are rejected or classified `occupancy_unknown`; proposals never change authority, publication, PR, or release state. Do not add a workspace lifecycle event to `events.ndjson` or alter artifact cursors.

## Parent/Child Tool Surface

Parent-only tools: `workspace_discover`, `workspace_reconcile`, `workspace_register_slot`, `workspace_release`, `workspace_assign`, `workspace_adopt`, `workspace_recover`, `workspace_observe_publication`, `workspace_record_pr`, `workspace_observe_pr`.

Child-only tool: `workspace_report`. Register in separate branches of `src/subagent.ts`; preserve existing child interactive tools and nested-child behavior. Update `src/tools/interactive.ts`/`src/schemas.ts` only for explicit workspace assignment parameters and marker/context handoff, not ordinary legacy spawns. Existing artifact/delivery/routing registrations remain the compatibility path.

## First PR Scope Matrix

| Requirement                                     | First PR                                                                   | Deferred                         |
| ----------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| Reuse a released physical slot for a new branch | **Included**: Phase B controlled switch/create with intent/recovery        | —                                |
| Retain old branch/work-item history             | **Included**                                                               | —                                |
| Child report versus orchestrator authority      | **Included**: bounded advisory report                                      | —                                |
| Crash-safe reservation/rebinding                | **Included**                                                               | —                                |
| Publication evidence                            | **Included**: exact local/remote observation contract, no network provider | Provider adapters                |
| PR awareness                                    | **Included**: association/neutral observation records                      | Live GitHub/GitLab integration   |
| Automatic destructive cleanup                   | Not included                                                               | Explicit future feature, if ever |

The first PR is not called complete until the new-branch reassignment criterion passes with a real temporary linked-worktree integration test.

## Task Breakdown

### T0 — Contracts and fixtures

Files: `src/schemas.ts`, new `src/workspace-ledger.ts`, new `src/workspace-git.ts`, `tests/schemas.test.ts`, new temporary-repository fixtures. Add caps, closed enums, full refs/OIDs, and separate workspace schemas.

### T1 — Git adapter

Files: new `src/workspace-git.ts`, `tests/workspace-git.test.ts`, `tests/workspace-git.integration.test.ts`. Implement sanitized argv runner, probes, NUL parsing, identity mapping, status/admin markers, remote observations, and non-destructive mutation allowlist.

### T2 — Ledger/claims/recovery

Files: new `src/workspace-ledger.ts`, `src/workspace-manager.ts`, `tests/workspace-ledger.test.ts`, `tests/workspace-recovery.integration.test.ts`, child-process fault harness. Implement no-follow/mode checks, exclusive temp + file/directory fsync, CAS, claims, intent/outcome recovery, caps, and stale/unknown blocking.

### T3 — Discovery/proposals/publication/PR

Files: `src/workspace-manager.ts`, new `src/workspace-reports.ts`, new `src/workspace-pr.ts`, related tests. Map stable slots/occupants, proposals, exact publication, provider-neutral PR observations, and no-authority child evidence.

### T4 — Phase A/B lifecycle and tool façade

Files: `src/workspace-manager.ts`, new `src/tools/workspace.ts`, `src/tools/interactive.ts`, `src/schemas.ts`, `src/interactive-tmux.ts`, lifecycle/tool/scenario tests. Add explicit registration, read-only discovery, release with optional managed child closure, same-slot new-branch reassignment, existing-child versus new-child binding, preallocated child ID/marker, occupancy-unknown blocking, and no implicit legacy adoption.

### T5 — Phase B controlled Git mutation and recovery

Files: manager/ledger/tools/interactive launcher and mutation/recovery integration tests. Add branch switch/create in the first PR after durable intent, exact before/after recovery, branch conflict checks, hook/admin-lock blocking, lost-response idempotency, and partial-launch recovery.

### T6 — Registration boundaries

Files: `src/subagent.ts`, `src/tools/workspace.ts`, `src/workspace-reports.ts`, `src/child-protocol.ts` only as necessary, extension/tool-set/protocol tests. Parent receives manager tools; child receives only report tool plus existing child tools.

### T7 — Lifecycle/telemetry/docs/package

Files: `src/session-handlers.ts`, `src/telemetry.ts`, `src/telemetry-operations.ts`, `ORCHESTRATOR_V2_SYSTEM_PROMPT.md`, `README.md`, `architecture.md`, `AGENTS.md`, `package.json`, `vitest.config.ts`, `.prettierignore`, `CHANGELOG.md`, lifecycle/API/readme/telemetry/tarball tests, and `plans/adr-orchestratorv2-workspace-state.md`. Wire parent-only reconciliation/fencing, closed telemetry statuses, docs, package allowlist, ADR, and `.delta` exclusions.

## Dependency Graph

```text
T0 -> T1/T2 -> T3 -> T4 -> T5 -> T6 -> T7
```

First PR gate: T0–T6, including new-branch reassignment, child close/release, crash recovery, and parent/child registration. Surface/docs/package gate: T7. Provider adapters and history archival remain deferred.

## Architecture Decision Record (ADR)

### Decision

Use a repository-scoped, versioned JSON workspace ledger keyed to canonical Git common-directory identity, with stable slot IDs, epoch-bound assignments, explicit child-close/release, argv-only sanitized Git operations, and fsynced before/after intents. Child reports and PR observations remain advisory; fresh Git state and parent-approved ledger transitions control reuse.

### Drivers

1. Reuse physical worktrees for new branches without data loss.
2. Recover safely across crashes, reloads, and multiple Pi parents.
3. Preserve existing routing, interactive child, artifact, telemetry, and package boundaries.

### Alternatives Considered

- Extend interactive state/artifact events: rejected because they are parent-session scoped and own physical byte cursors/delivery semantics.
- Keep one worktree per branch: rejected because it creates unbounded worktrees.
- Child-owned release/PR authority: rejected because children can crash, be stale, or report unverified facts.
- SQLite: rejected because it adds dependency/migration cost without preventing unmanaged Git writers.
- PR-gated recycling: rejected because PR providers are optional and PR state is not a filesystem safety predicate.

### Why Chosen

The Git common directory is the shared lifetime for linked worktrees, while the existing Pi session is not. A bounded ledger can preserve assignment history and exact operation intent without altering artifact protocol or routing authority. Conservative blocking is safer than forceful repair.

### Consequences

- The first PR includes real branch reassignment and requires a new temporary-repository integration test.
- Unknown occupancy, claims, Git state, and provider observations can block work until explicitly reconciled.
- Cooperative claims do not protect against arbitrary same-UID processes.
- Provider adapters and history archival are deferred.

### Follow-ups

- Add provider adapters only behind the neutral PR observation interface.
- Add explicit user-confirmed history export/archival before capacity is reached.
- Consider process-level isolation if unmanaged same-UID writers become a threat model.

## Acceptance Criteria per Task

- T0: all fields/caps/refs/OIDs have closed validators; unknown fields/versions/capacity fail closed.
- T1: probes are bounded, noninteractive, NUL-safe, full-OID/ref-safe, and cannot emit forbidden commands.
- T2: intent is fsynced before mutation; ledger/lock faults, crashes, and claims resolve via exact recovery table.
- T3: all required slot/admin/occupant states, proposal idempotency, exact publication, and neutral PR outcomes are covered.
- T4/T5: a managed clean slot can be released and reassigned to a different new branch without creating another worktree; branch/work-item history remains queryable; close/release of an idle child is explicit and safe; running/foreign/legacy/occupancy-unknown children cannot be rebound.
- T5: switch/create is allowlisted and intent-backed; mutation uncertainty never replays or repairs automatically.
- T6: parent/child tool sets are disjoint; artifact lifecycle/cursors/routing remain unchanged.
- T7: reload/restart/adoption and `/new` preservation work; telemetry/docs/package/API surfaces are updated; `.delta` is excluded.

## Risk Register

| Risk                         | Mitigation                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Unmanaged writer             | Fresh probes and fail-closed mismatch; explicit cooperative-boundary documentation |
| Legacy/nested child          | Scan known scopes/artifacts; foreign/markerless occupants block                    |
| PID reuse                    | Random process-instance ID; PID diagnostic only; explicit adoption                 |
| Git version/output drift     | Strict parser returns unknown; real integration matrix                             |
| Admin lock/timeout           | Preserve markers and block; never remove/replay                                    |
| Crash after Git mutation     | Durable intent and exact after/before/mismatch classification                      |
| Partial child launch         | Durable reservation, marker, existing launcher state, adoption-required recovery   |
| Ledger cap/corruption        | Reject before mutation; no silent eviction or auto-repair                          |
| Provider outage              | Unsupported/unavailable/mismatch observations; PR never recycles                   |
| Existing protocol regression | Separate files/tools; unchanged events/cursors/routing                             |
| Packaging/test discovery     | Package allowlist and `.delta/**` Vitest/prettier exclusions                       |

## Validation Commands

```bash
npx vitest list --exclude '**/.delta/**' > /tmp/pi-subagentura-tests.list
! grep -q '\.delta/worktrees' /tmp/pi-subagentura-tests.list
npm run typecheck
npx vitest run --exclude '**/.delta/**'
npm run test:pi
npm run format:check
npm run pack:check
git diff --check
```

The final PR will link the deep-interview spec and ADR, summarize phased behavior/non-goals, and report all validation results.

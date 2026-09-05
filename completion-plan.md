# Completion Delivery Coordination

## Status

Implemented on `feat/completion-delivery-groups` at `53f33cf` and hardened at
`b41579a`. This document records the shipped design and its verification contract.

## Historical problem

Completion notifications previously reused Pi custom messages for both the user
and the parent model. Those messages entered later model context, could queue a
turn while the parent was busy, and could redeliver output that the parent had
already collected. Related fan-out could also create one continuation per member.

The implementation separates those channels and coordinates parent readiness.

## Goals and scope

- Notify the user once for every parent-visible standalone terminal turn and every background workflow aggregate terminal result.
- Keep user notices out of parent LLM context.
- Deliver compact references instead of full child output by default.
- Make independent `completionPolicy: "each"` readiness the default: terminal records are immediately eligible, and records completing while the parent is busy coalesce into a safe-idle continuation.
- Support an explicit, caller-declared `completionPolicy: "group"` barrier for related work; same-turn launch and task text never infer membership.
- Give human prompts, steering, and queued follow-ups priority.
- Consume manually retrieved terminal results before automatic delivery.
- Preserve bounded state, explicit ownership, immutable artifact identity, and workflow-owned child suppression.
- Map deprecated legacy notify fields to coordinated `each`.

Workflow-owned child turns remain visible through workflow progress but do not
publish direct completion notices or manifests. Only the background workflow
aggregate joins the parent coordinator.

## Layered ownership

The stacked design keeps routing, completion policy, and transport separate:

- Orchestratorv2 routing is parent-authoritative. The current parent branch is
  the trusted authority ledger; `.pi/subagentura-routing.json` is only an
  untrusted, repairable project cache. Cache-only, stale, malformed, or
  over-capacity rows are diagnostics and never grant actionability, consume
  capacity, or gate an approved write.
- `completion-coordinator.ts` owns readiness, explicit group reservation and
  sealing, deterministic TUI notices, consumption receipts, and bounded
  manifest selection.
- `completion-turn.ts` is the lower-level idle Orchestratorv2 transport and
  recovery layer. It receives the coordinator's manifest with the actual
  parent streaming state, uses native `sendMessage` outside v2, and only uses
  the synthetic user-wake path for an idle Orchestratorv2 parent.

The parent-entry authority boundary is application-level rather than an OS
security boundary: a same-UID process that can tamper with the parent session
file can forge authority entries. Routing metadata is not a lifecycle registry
or semantic resolver.

## Terminology

- **Completion record**: a normalized parent-visible `done`, `error`, or
  `cancelled` result with a deterministic `completionId`.
- **User notice**: a durable `subagentura-completion` custom entry rendered only
  in the TUI. The entry itself is the notice reconciliation receipt.
- **Manifest**: a bounded hidden `subagent-manifest` containing statuses and
  retrieval references, never full child output by default.
- **Consumed**: terminal output was retrieved manually, so later automatic
  delivery omits the matching completion.
- **Consumption receipt**: a durable marker that manual or lifecycle handling
  consumed a terminal result. Manual consumption first appends it and calls
  `fsyncSync` in the private parent-session ledger, then best-effort mirrors it as a parent-session custom
  entry.
- **Consumption ledger**: a private, session-scoped append-only NDJSON ledger
  beneath the parent Pi session directory. Manual consumption writes it first;
  the parent session entry is a best-effort mirror. A manager without a session
  directory uses a process-private temporary root without restart durability.
- **Completion group**: an explicit barrier keyed by a caller-declared `completionGroupId`.
- **Sealed**: the spawning parent turn settled, so no new group members may join.

## Two-channel contract

### User channel

For each parent-visible terminal record, the coordinator:

1. normalizes and bounds the record;
2. appends one deterministic `subagentura-completion` entry with `pi.appendEntry()`;
3. renders it with `pi.registerEntryRenderer()`;
4. reconciles deterministic IDs against parent session entries; and
5. excludes the entry from provider context.

This produces one immediate, exactly-once, user-only TUI notice per terminal
member. `pi.sendMessage()` is never used for a user-only notice because custom
messages participate in later model context even when they do not trigger a
turn. Retry and reconciliation preserve the exactly-once notice identity when
storage is transiently unavailable.

Parent delivery fails closed behind notice persistence. A failed notice append
remains pending and blocks manifest preparation. One scheduled retry occurs when
safe, and later coordinator activity may retry again; persistent failure never
creates a tight loop. If an append writes and then throws, reconciliation sees the
existing entry and prevents a duplicate.

### Parent-model channel

A ready manifest contains JSON records inside `<completion-manifest>`:

```text
<completion-manifest>
{"completionId":"...","source":"interactive","sourceId":"...","turnId":"...","status":"done","retrieve":"read_subagent_artifact(id: \"...\", turnId: \"...\")","references":[{"label":"output","value":".../outputs/<eventId>.md"}]}
</completion-manifest>
```

Structured message details contain `completionIds` and any represented `groups`.
Interactive references prefer immutable `outputs/<eventId>.md` plus
`events.ndjson`; legacy artifacts may fall back to staging `output.md`.
In-process and workflow records point to `get_subagent_result` and
`get_workflow_result`.

Manifests are capped at 32 KiB and 128 records. A grouped unit is selected
atomically and is never split to fit. If references exceed the budget, the
manifest retains bounded retrieval calls and omits the expanded reference array.
Physical publication order is authoritative.
By default, `completionPolicy="each"` makes each terminal record eligible
immediately. Records that arrive while the parent is busy are coalesced into a
single bounded manifest at the next safe-idle dispatch. A caller can instead
select an explicit `completionPolicy="group"` with a shared
`completionGroupId`; same-turn launch and task text never infer a group.

## Readiness policies

### `each` (default)

Independent terminal records become ready immediately. Records that finish while
the parent is busy coalesce at the next safe dispatch instead of creating a
burst of turns. The default does not wait for unrelated records or infer
relatedness from a shared parent turn or prompt text.

### `group` (explicit named barrier)

Related top-level work may declare `completionPolicy: "group"` and one shared,
caller-declared `completionGroupId` for advanced cross-call control. Relatedness
is never inferred from prompt text or same-turn launch.

- Every member is registered at spawn.
- The spawning parent turn's settlement seals the group.
- Late members are rejected.
- `done`, `error`, and `cancelled` all satisfy terminality.
- Parent delivery waits until every registered member is terminal.
- Per-member TUI notices remain immediate.
- An entirely consumed group creates no empty continuation.

Membership uses bounded `source:sourceId` keys, not delivery IDs. A group supports
at most 32 members, a parent session supports at most 512 groups, and IDs are
1–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. One source satisfies a
group once; later turns from the same source/group are independent `each` records
with distinct completion IDs.

Workflow schedulers do not create or infer parent completion groups for internal
children. Internal children are suppressed, and only the background workflow
aggregate participates.

## Human-input priority

- Never inject a manifest into a streaming parent turn.
- Human input marks a priority fence before `agent_start`.
- `before_agent_start` attaches a ready manifest to the natural human turn.
- A separate turn-start fence closes the `before_agent_start` to `agent_start`
  race.
- Completions that arrive during a human turn wait for settlement.
- Without pending human work, safe parent idleness triggers one follow-up.
- Session replacement retires session-scoped work before it can reach a new owner.

## Dispatch transport and lifecycle ordering

When a manifest is ready at idle, the coordinator calls `sendCompletionTurn`
with the actual parent streaming state. Non-v2 modes use native `sendMessage`.
For an idle Orchestratorv2 parent, `completion-turn.ts` persists the wake
request, sends the manifest with its wake identity, and requests a synthetic
user follow-up so the thin-router prompt is installed for the consuming run.
Streaming parents retain Pi's native follow-up queue.

Wake state is process-global because delivery and lifecycle paths may load
separate module instances. The exact synthetic prompt is marked in
`before_agent_start`; only that marked run's `agent_settled` can acknowledge
the wake. Missing run starts use at most three attempts separated by a
30-second watchdog; acknowledgement persistence uses at most three attempts
with a one-second delay. Exhausted retries stop without an unbounded loop.

Lifecycle hooks compose the two layers in this order: input marks the human
priority fence; `before_agent_start` marks an exact wake and the coordinator's
turn-start fence before attaching a natural-turn manifest; `agent_start` marks
the parent streaming; `agent_settled` settles the exact wake before clearing
streaming and settling coordinator readiness. On session start, stale wakes
are cleared, matching interactive state is rehydrated, recovered groups are
sealed, then delivered unacknowledged wakes are recovered before polling starts.
Shutdown cleans the owner scope and retires its scoped completions, clears the
coordinator and wake state, then marks the scope shut down and advances its
generation so old-owner delivery cannot continue.

## Manual consumption

Successful terminal output retrieval through these tools appends a matching
consumption entry before returning:

- `read_subagent_artifact` when it successfully returns a selected or latest terminal output (requesting output without a terminal snapshot does not consume);
- `get_subagent_result`;
- `get_workflow_result`.

The coordinator first losslessly appends the receipt and calls `fsyncSync` in a private,
session-scoped append-only NDJSON ledger beneath the parent Pi session
directory, outside the project working tree, keyed by the parent session
identity. After that append succeeds, it best-effort mirrors the receipt into a
parent session entry. A manager without a session directory uses a random
process-private temporary root and does not claim restart durability. A ledger
write failure blocks manual collection; lifecycle retirement has a separate
best-effort path. Ledger reads take a fixed snapshot of the current file size
and stream it with bounded chunks and line buffers.
Reconciliation advances through later snapshots so late-published receipts are
not lost without repeatedly loading or scanning the whole file.

Events-only artifact reads do not consume output. Interactive consumption matches
the immutable terminal turn, not mutable follow-up staging bytes. Protocol-v2
turn IDs remain intact up to the artifact protocol limit of 256 characters.

## Interactive follow-ups and cancellation

Every persisted child user entry produces a distinct artifact turn and immutable
snapshot. An idle follow-up resets future policy to independent `each`. A source
can satisfy a group only once, so repeated completions cannot reopen a sealed
group.

Workflow-owned children reject follow-up until the workflow has consumed the
current result and the pane is idle. The first successful follow-up promotes the
pane to standalone.

Interactive cancellation writes the cancelled artifact first. Coordinated state
then produces one TUI-only terminal notice and may later include one compact
cancellation selector; upgrade-recovered pre-coordinator intents alone retain
legacy synthetic-receipt suppression.

## API and compatibility

Spawnable asynchronous work accepts:

```text
completionPolicy?: "each" | "group"  // default: "each"
completionGroupId?: string           // required for explicit "group"; caller-declared
```

`completionPolicy: "each"` is the default independent-readiness behavior.
`completionPolicy: "group"` requires a caller-declared `completionGroupId` and
is the advanced named cross-call barrier. Same-turn launch and task text never
infer membership.

Deprecated `notifyOnComplete` and `triggerTurnOnComplete` inputs remain accepted.
Either legacy value maps deterministically to coordinated `each`, cannot request
full-output injection, and cannot be combined with new completion fields.

Coordinated workflow completion labels are capped at 160 characters without
changing workflow IDs, retained workflow names, or retrieval identity.

## Lifecycle and durability

Interactive completion policy, group identity, event cursors, pending intents,
and legacy receipts rehydrate only into the matching parent session. Consumption
receipts use the private ledger beneath Pi's parent session directory first and
then mirror into parent-session entries; they never use the project working
directory. Partial or programmatic managers without a session directory use a
random process-private temporary root and do not claim restart durability.
In-process jobs and background workflows remain parent-session scoped and do not
survive session replacement. `new` and `fork` do not import prior completion
work.

Ledger appends remain lossless even when mirroring into a parent entry fails, but bootstrap and
incremental reconciliation enforce total byte, record-count, line, identifier,
and selector bounds. If a snapshot exceeds those bounds, reconciliation ignores
that unchecked snapshot and fails open to a possible duplicate manifest rather
than suppressing trusted completion state or blocking the parent process.
Turn-scoped expectations require an exact `turnId`; source-only receipts cannot
consume current or future interactive turns.

Session shutdown clears live coordinator state after recording lifecycle
retirements; it does not truncate or delete consumption ledgers. Same-session
reload, resume, or restart can reconcile the matching ledger, while replacement
sessions leave old private files on disk without importing them.

A successful Pi `sendMessage()` proves synchronous dispatch, not durable session
commit. Deterministic completion IDs prevent ordinary replay, but a crash in that
separate commit window can still replay a manifest. This at-least-once boundary is
not described as exactly once.

## Verification contract

Permanent regressions cover:

- default independent `each` readiness and safe-idle coalescing;
- explicit named groups, sealed all-terminal membership, and cross-call control;
- errors, cancellation, late-member rejection, and one-shot group membership;
- human-input and turn-start races;
- manual consumption and immutable retrieval selection;
- bounded queues, manifests, group units, and crash/rehydrate replay;
- transient notice retry, append-then-throw reconciliation, and no retry spin;
- fallback receipt preference, lossless append, fixed-snapshot bounded-memory
  reads, late-receipt reconciliation without repeated whole-file scans, and the
  accepted unbounded disk-growth tradeoff while parent entry persistence is
  unavailable;
- workflow-owned suppression and cancellation deduplication;
- accepted long workflow names and 256-character turn IDs;
- tmux, Zellij, Pi-session provider context, and terminal E2E behavior.

Required release checks:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
npm run test:tmux
npm run test:zellij
```

Also run the terminal E2E suite. Runtime diagnostics use `debugLog`; published
runtime code must not call host `console.*` methods.

## Documentation ownership

The root documentation and every file under `docs/` are maintained in this
repository and are the source of truth for the published contract. The
separately published `pi-docs` injector indexes these files downstream; it is
not an editing source. Keep `docs/workflows.md` aligned with the background
completion API and immutable terminal snapshots, and keep the Phase 2
`docs/workflow.md` design clearly marked as historical where it describes the
earlier implementation.

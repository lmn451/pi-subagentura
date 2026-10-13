---
title: "Protocol-v1 Compatibility and Removal Plan"
keywords:
  [protocol-v1, protocol-v2, compatibility, migration, artifacts, delivery]
---

# Protocol-v1 compatibility inventory

This document inventories the compatibility paths that keep old interactive
sub-agent artifacts and completion state readable. It is a removal map for the
planned v4 cutover in [issue #42](https://github.com/lmn451/pi-subagentura/issues/42),
not authorization to discard user data. Until a breaking release and migration
window are announced, v3 must continue to read supported v1 data.

## Current contract

Current children write protocol-v2 events and immutable terminal snapshots:

- NDJSON physical byte order is authoritative; timestamps are display/TTL data.
- `turn_started` binds a Pi-derived `turnId`.
- `completion` records the terminal outcome and references an immutable
  `outputs/<eventId>.md` snapshot when one is available.
- Mutable `output.md` is staging data, not historical proof of a turn's output.

Protocol-v1 records have no version and use `started`, `tool_activity`, `done`,
`error`, or `cancelled`, typically with a numeric `ts`. They do not carry the
v2 event/turn identity and immutable output descriptor needed for lossless
association with a historical turn.

## Runtime compatibility map

| Compatibility behavior                                                            | Current implementation                                                                                                      | Coverage / v4 disposition                                                                                                                             |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse unversioned v1 event rows, including mixed v1/v2 logs                       | `src/artifact.ts`: `normalizeEvent`, event readers                                                                          | `tests/artifact.test.ts`, `tests/subagent-poll.test.ts`, `tests/artifact-delivery.integration.test.ts`; remove v1 normalization, retain v2 validation |
| Synthesize `legacy-*` event and turn identities from byte offsets/content         | `src/artifact.ts`; legacy fallback identity in `src/artifact-poller.ts` and `src/tools/interactive.ts`                      | Artifact and poll/delivery tests; remove synthetic identities with v1 parsing                                                                         |
| Read legacy numeric `output-N.md` snapshots and enumerate output turns            | `src/artifact.ts`: `readOutputForTurn`, `listOutputTurns`; `src/tools/interactive.ts`: `turn` selector and `availableTurns` | `tests/artifact.test.ts`, `tests/subagent-poll.test.ts`; remove numeric snapshots and `turn`, keep immutable `turnId` lookup                          |
| Fall back to mutable `output.md` when no applicable v2 snapshot exists            | `src/tools/interactive.ts`, `src/workflow-worker.ts`, artifact readers                                                      | Poll/read/workflow tests; remove only for completed turns after the migration window; retain staging access where needed for live work                |
| Migrate missing-version, v1, and pre-v1 state files                               | `src/artifact.ts`: `migrateStatePayload`, `asStates`, `withLegacyCatchup`; `src/rehydrate.ts`                               | `tests/artifact.test.ts`, `tests/subagent-session-start-rehydrate.test.ts`; replace with actionable migration-required handling in v4                 |
| Carry legacy lifecycle/timestamp state fields                                     | `src/interactive-tmux.ts`, `src/artifact.ts`, `src/artifact-poller.ts`                                                      | Artifact, poll, and rehydrate tests; remove fields once old state migration is no longer part of runtime                                              |
| Cut over legacy event backlog and enqueue synthetic pointer delivery              | `src/artifact.ts`: `legacyCutoverOffset` / `withLegacyCatchup`; `src/delivery.ts`                                           | Artifact-delivery and rehydrate tests; remove with old-state migration, without deleting or rewriting artifact logs                                   |
| Retain v1-specific protocol/status semantics while waiting for process completion | `src/workflow-worker.ts`, `src/interactive-tmux.ts`, `src/notifications.ts`                                                 | Workflow and poll tests; make completion/status logic exhaustive over v2 events                                                                       |

The state migration schema version is independent of the artifact event
protocol version. A `schemaVersion: 1` field in another ledger or record is not
by itself evidence of protocol-v1 compatibility.

## Completion-delivery compatibility (separate concern)

There are two distinct delivery compatibilities; neither should be conflated
with parsing protocol-v1 event rows:

1. `notifyOnComplete` and `triggerTurnOnComplete` are deprecated API inputs.
   In live coordinated sessions they map to coordinated `each` delivery and
   cannot select legacy full-output injection.
2. Upgrade-recovered/pre-coordinator delivery remains supported. Interactive
   intents without a completion policy can still take the direct notification
   path in `src/delivery.ts`. The in-process direct-delivery queue and its
   compatibility fallback live in `src/notifications.ts`; session lifecycle
   flushing is in `src/session-handlers.ts`.

The v4 protocol cutover removes synthetic v1 artifact backlog deliveries, but
that does not by itself justify deleting the in-process compatibility queue or
all legacy delivery APIs. Retire those separately only after identifying which
persisted intents and programmatic/no-session callers still depend on them.

`src/notifications.ts` is not wholly removable: output sanitization,
notification rendering, and event classification are still used by current
code. Any broker removal must preserve or relocate those shared helpers.

## User-data and migration policy

- Do not delete user artifact directories or state files.
- Do not rewrite `events.ndjson` in place; it is append-only and byte order is
  authoritative.
- Do not claim v1 output can always be assigned to a v2 `turnId`. V1 lacks
  authoritative turn/event identities and immutable output metadata.
- Before v4 removes readers, provide a dry-run inventory and an explicit,
  idempotent, non-destructive migration/archive path. The preferred artifact
  policy is archive-only raw history plus fresh v2 runtime state.
- Old state encountered by the v4 runtime must produce an actionable
  migration-required result rather than being silently ignored or overwritten.
- Keep the final v3 release available for users who need temporary access to
  untouched legacy artifacts and a tested rollback route.

## Removal gates

1. **v3 deprecation:** current releases write only v2 events/snapshots; warnings
   and documentation identify each legacy entry point without repeated noise.
2. **v3 migration tooling:** users can inventory affected state/artifacts and
   preserve or archive them without silent loss or false output attribution.
3. **v4 runtime:** event readers, rehydration, output selection, lifecycle folds,
   and workflow waits accept v2 only; unsupported legacy state fails with an
   actionable migration message.
4. **Delivery follow-up:** separately decide and test the cutoff for persisted
   pre-coordinator intents and no-session in-process direct delivery.

See [issue #42](https://github.com/lmn451/pi-subagentura/issues/42) for the
full phase plan and acceptance criteria.

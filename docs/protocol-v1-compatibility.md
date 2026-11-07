---
title: "Protocol-v1 Compatibility and Removal Status"
keywords: [protocol-v1, protocol-v2, compatibility, artifacts, delivery]
---

# Protocol-v1 compatibility and removal status

This inventory records the breaking runtime cutover requested under [issue
#42](https://github.com/lmn451/pi-subagentura/issues/42). The runtime now
consumes protocol-v2 interactive artifacts and coordinated completion delivery
only. Compatibility removal does not delete old files, but old artifacts and
state may no longer be readable or usable by this version.

## Current protocol-v2 contract

- Interactive events are versioned and validated as protocol v2. Physical
  NDJSON byte order is authoritative; timestamps are display/latency metadata.
- `turn_started` binds a Pi-derived `turnId`; `completion` records its terminal
  outcome and may reference an immutable `outputs/<eventId>.md` snapshot.
- Mutable `output.md` is staging data for an active v2 turn, not historical
  proof of a completed turn.
- `read_subagent_artifact` selects completed output by `turnId`; the numeric
  `turn` selector and `output-N.md` history reader are removed.
- Child session JSONL is no longer tailed to synthesize lifecycle or tool
  activity events. Current children publish protocol-v2 artifact events.

## Removed compatibility paths

| Removed behavior                                                                                                             | Current result                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parse unversioned protocol-v1 `started`, `done`, `error`, `cancelled`, or legacy `tool_activity` rows                        | Invalid/non-v2 event rows are not returned as events. Existing `events.ndjson` files are not rewritten or deleted.                               |
| Synthesize `legacy-*` event/turn IDs or associate numeric snapshots by byte offset                                           | No synthetic identity is produced; only v2 event and turn identities are accepted.                                                               |
| Read or enumerate `output-N.md` snapshots                                                                                    | Numeric snapshot APIs and the `turn` selector are removed. Use a v2 `turnId` snapshot.                                                           |
| Migrate missing-version, v1, pre-v1, or removed-field interactive state                                                      | Only the current schema-v2 state shape is accepted. Unsupported files are left in place; state mutations fail closed rather than rewriting them. |
| Read legacy lifecycle, session-log cursor, auto-done, or stop-reason fields                                                  | These fields are not restored or used. The session-log tail parser and timeout/auto-done heuristics are removed.                                 |
| Use `notifyOnComplete` / `triggerTurnOnComplete`, direct injection/notification brokers, or pre-coordinator delivery intents | These inputs and paths are removed. Interactive, in-process, and workflow completions use the coordinated completion protocol.                   |

`src/notifications.ts` remains for shared output sanitization and v2 completion
classification; it no longer implements a delivery broker.

## User-data behavior and rollback

- This cutover does not remove artifact directories, event logs, numeric output
  files, or state files.
- V1 rows and numeric snapshots are not automatically migrated, archived, or
  attributed to v2 turns. Unsupported state is not silently rewritten: a
  mutation encountering a removed state field or unsupported delivery intent
  fails closed and preserves the file bytes.
- Users who need to inspect legacy data should retain a copy and run the last
  release that supported it. The current runtime does not provide an importer or
  migration tool.
- The state schema version is independent of the artifact event protocol. A
  `schemaVersion: 1` field in a different ledger or record is not evidence of
  protocol-v1 compatibility.

## Delivery remains a separate concern

Protocol-v1 artifact parsing and pre-coordinator completion delivery had
separate runtime paths and are both removed in this breaking change. New
delivery is coordinated: completion entries, each/group barriers, bounded
hidden manifests, and manual consumption receipts remain authoritative. A
queued intent is replayable only when it already has a valid `each` or `group`
completion policy. Older `mode` and `triggerTurn` routing metadata on such a
coordinated intent is ignored and removed from the in-memory normalized form;
it does not restore the old broker or trigger behavior. Uncoordinated intents
without a completion policy and intents with `dispatchAttempted` are rejected,
and state mutations preserve their file bytes. Queue overflow fails explicitly
so the source artifact can be replayed.

See [issue #42](https://github.com/lmn451/pi-subagentura/issues/42) for the
original staged proposal and rationale.

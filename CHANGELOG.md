# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Workflow `agent()` calls accept `reusable: true` to retain successful process-backed children for bounded, same-parent-session, explicit child-ID follow-up. Supervisor and Orchestratorv2 metadata expose lifecycle, workflow, owner/lineage, sibling, retention, and recovery relationships without granting routing authority from liveness.
- Added the independently useful packaged `pi-session-recovery` incident runbook for non-destructive Pi JSONL/worktree recovery, identity checks, duplicate-process safeguards, tmux/Zellij guidance, rehydration boundaries, and manual conversation-only fallback.
- Added user-confirmed `recover_interactive_subagent` recovery for persisted direct children with conclusively dead tmux/Zellij panes. It validates parent/session/artifact/lineage ownership, preserves delivery cursors and authority, and rebinds the same child identity only after a native confirmation.

### Changed

- Process-backed workflow children are disposed after result consumption by default. Opted-in children expire after 30 minutes, are capped at 32 per parent session, never rehydrate across session replacement, and promote to standalone only after a successful consumed-and-idle follow-up.

## [3.4.0] - 2026-08-27

### Added

- Promoted `--orchestratorv2` as a routing-first interactive mode. Its prompt
  guides the parent to route work to attachable interactive subagents, ask for
  clarification when a request is ambiguous or a narrow request has no matching
  child, and leave
  specialist work to those children. Compatibility workflow and in-process tools
  remain registered; this is prompt guidance rather than an enforced boundary.
- Orchestratorv2 routing now treats the current parent branch as the sole authority ledger and the project-local JSON file as repairable untrusted cache data, preventing child-written records from becoming actionable, consuming authority capacity, blocking approved writes, or hiding authoritative stale records.
- Idle Orchestratorv2 completions now use process-global, run-bound durable wake state with bounded prompt and acknowledgement retries, exact settled-run acknowledgement, and session-replacement recovery without changing delivery behavior in other modes.
- Explicit `completionPolicy: "each" | "group"` coordination for asynchronous sub-agents and background workflows, with caller-declared bounded `completionGroupId` barriers, human-input priority, manual-result consumption, and compact reference manifests. Relatedness is never inferred from same-turn launch or task text.
- Deterministic, reconciled TUI completion entries for parent-visible standalone and background workflow aggregate `done`, `error`, and `cancelled` outcomes; workflow-owned child turns remain suppressed and entries are excluded from parent LLM context.

### Changed

- Asynchronous completion now defaults to coordinated `each` delivery: each terminal result is immediately eligible, while results that finish while the parent is busy coalesce into one safe-idle compact continuation without injecting full child output.
- Explicit `group` completion seals when the spawning parent turn settles and releases one aggregate manifest only after every caller-registered member is terminal; `done`, `error`, and `cancelled` all satisfy the barrier. An entirely consumed group creates no empty continuation, and workflow-owned children remain suppressed in favor of the background workflow aggregate.
- Documented the durability boundary: interactive artifacts, routing state, pending
  deliveries, and receipts persist and rehydrate within the matching parent
  session. Delivery is bounded and at-least-once; in-process jobs and background
  workflows remain session scoped.
- Consumption receipts prefer parent-session entries. When `appendEntry` is unavailable or fails, receipts append losslessly to a private, session-scoped append-only ledger keyed by parent session identity; fixed snapshots and bounded streaming reads preserve memory bounds while retaining late-published receipts.
- Completion-consumption selectors now use explicit source variants: interactive turn receipts require `turnId`, source-level interactive receipts use `scope: "source"`, and in-process/workflow receipts remain source-scoped. Legacy interactive receipts without `scope` are migrated safely without matching turn-scoped completions.

### Fixed

- Durable TUI completion notice writes retry without duplicating append-then-throw entries or spinning during persistent storage failure; parent manifests wait for notice persistence and each terminal record has one logical notice.
- Accepted long workflow names are truncated only in bounded completion labels, preserving workflow IDs and completion delivery.
- Protocol-v2 Pi turn IDs up to 256 characters remain intact in notices, immutable retrieval selectors, and consumption receipts.

### Known limitations

- The private fallback consumption ledger is session-scoped and append-only. It has no fixed disk-size bound during a prolonged parent-session-entry outage; truncation could resurrect results already collected when parent entries become available again. Readers use fixed snapshots and bounded chunks/line buffers, and later snapshots reconcile late-published receipts without repeated whole-file scans. Session cleanup does not truncate or delete these private ledgers; same-session reload, resume, or restart can reconcile them, while `new` and `fork` do not import prior completion work and old files may remain on disk.
- A successful Pi `sendMessage()` proves synchronous dispatch, not durable session commit. A crash in that separate parent-delivery window can replay a manifest; parent-model delivery is therefore at-least-once, not exactly once.

### Deprecated

- `notifyOnComplete` and `triggerTurnOnComplete` remain accepted as compatibility inputs that map to coordinated `each` delivery. They cannot be combined with `completionPolicy` or `completionGroupId`; full-output legacy injection is no longer selectable by new API calls.

## [3.3.1] - 2026-08-25

### Fixed

- Interactive sub-agents now survive parent reload, resume, and quit continuity without becoming orphaned, while new and fork sessions still clean up prior ownership and descendant spawn-tree authority remains explicit and bounded ([#97](https://github.com/lmn451/pi-subagentura/pull/97)).
- High-concurrency sub-agent workloads reduce parent input lag by coalescing artifact, delivery, multiplexer, and workflow-worker hot paths ([#96](https://github.com/lmn451/pi-subagentura/pull/96)).
- The default workflow wall-clock timeout is 100 hours instead of 30 minutes, preventing long-running workflows from terminating unexpectedly.
- Session lifecycle failures use the opt-in debug logger instead of writing through the host console, avoiding Pi TUI corruption.

### Known limitations

- Descendant lineage bootstrap credentials expire 60 seconds after creation; delayed child startup leaves the pane usable but recursive interactive spawning unavailable for that session until the child is respawned or started fresh.

## [3.3.0] - 2026-08-05

### Added

- Workflow status, results, footers, widgets, trees, and supervisor views now share canonical input, output, cache-read, cache-write, and cost displays, with symbolic and ASCII forms ([#79](https://github.com/lmn451/pi-subagentura/pull/79)).
- Pricing provenance now distinguishes provider-priced, estimated, unavailable, and mixed usage, rendering `$?` instead of a misleading `$0` when a reliable price is unavailable ([#79](https://github.com/lmn451/pi-subagentura/pull/79)).

### Changed

- Output-token budgets are unchanged and now appear consistently alongside output usage, separate from total and cache usage, including in budget-exhaustion messages ([#81](https://github.com/lmn451/pi-subagentura/issues/81), [#80](https://github.com/lmn451/pi-subagentura/pull/80)).

### Fixed

- Workflow aggregates and per-agent records retain accounting from rejected, retried, cancelled, and terminal attempts, enforce output budgets across every attempt, and preserve meaningful live usage when terminal samples are empty ([#80](https://github.com/lmn451/pi-subagentura/pull/80)).
- Terminal workflow failures preserve the triggering cause while active children are cancelled and drained, including their latest available usage ([#80](https://github.com/lmn451/pi-subagentura/pull/80)).

## [3.2.0] - 2026-07-31

### Fixed

- Concurrent parent sessions now keep in-process jobs, interactive sub-agents, delivery queues, streaming state, supervisor actions, and shutdown cleanup isolated by exact session generation.

### Added

- Structured workflow outputs with schema validation, reusable TypeScript declarations at `pi-subagentura/workflow`, immutable `cwd`, explicit phase metadata, and bounded workflow-tree agent records.
- Session-scoped ownership for background workflows, in-process jobs, interactive delivery, cancellation, status surfaces, and multi-owner artifact polling.
- npm release publishing to GitHub Packages alongside the public npm registry.

### Changed

- In-process sub-agent calls now run asynchronously by default; pass `async: false` for a single blocking call.
- `get_subagent_result` returns live state by default and supports explicit bounded waiting with `wait` and `timeoutMs`.
- In 3.2.0, interactive pointer completions began triggering a parent turn by default; `triggerTurnOnComplete: false` persisted without waking the parent. This historical default is superseded by the coordinated behavior in Unreleased.

### Fixed

- Completion delivery and workflow notifications no longer cross parent-session, reload, nested-context, or stale-generation boundaries.
- Oversized and partial artifact/session records remain memory-bounded without silently losing completion identity or advancing stale cursors.
- Cancellation propagates through nested orchestration, drains workflow receipts, and suppresses late completion after parent shutdown.
- Published-tarball validation now checks runtime imports, worker assets, declared dependencies, and a clean production consumer install.

## [3.0.3] - 2026-07-19

### Added

- A first-class reusable-workflow guide, user-command reference, and agent-facing tool reference.
- Workflow examples and the bundled RALPLAN skill in the published npm tarball, guarded by parser, behavior, README-surface, and tarball regression tests.

### Changed

- README positioning now leads with parent-orchestrated workflows, bring-your-own agents and prompts, interactive child sessions, and reusable workflows.
- Package description and discovery keywords now cover interactive subagents, orchestration, workflows, tmux, and Zellij.
- Bundled workflow scripts now live under `examples/workflows/` with an index and usage guide.

## [3.0.2] - 2026-07-17

### Added

- Per-agent `thinkingLevel` controls for synchronous, asynchronous, interactive, and workflow sub-agents.
- Foreground and global cancellation controls, including `ctrl+alt+x`, `/cancel-all-flows`, and abort-aware result waits.
- Default-off cancellation context snapshots with bounded private artifacts and workflow receipt reporting.
- Complete workflow usage accounting across nested agents, retries, failures, status, and completion notifications.

### Changed

- Pi peer compatibility now starts at `>=0.80.6` without blocking future releases; CI verifies both the minimum and latest SDKs.
- Interactive pane-liveness probes are asynchronous so slow mux commands do not block artifact polling.
- Triggering completions use Pi's native follow-up queue while non-triggering delivery preserves idle-only semantics.

### Fixed

- Workflow process agents recognize protocol-v2 completions for the current turn without reusing stale output.
- Completion delivery avoids stale streaming-state delays and duplicate queued follow-ups.
- Cancellation suppresses redundant completion notifications and reliably reports asynchronous snapshot receipts.

## [3.0.1] - 2026-07-16

### Added

- Added a `d` shortcut to delete the selected workflow from the `/workflows` picker.

## [3.0.0] - 2026-07-16

### Breaking

- **3.0.0 changed async sub-agents to inject by default.** At that release, `subagent_with_context` and `subagent_isolated` with `async: true` defaulted to `notifyOnComplete: "inject"`; `"notify"` persisted a pointer-only completion. This historical default is superseded by the coordinated behavior in Unreleased.

### Added

- Appendable parent-orchestrator guidance with routing defaults for scouting, planning, review loops, and oracle checks.
- Workflow tool modularization: split runtime into `workflow-core`, `workflow-worker`, `workflow-jobs`, `workflow-tool`, and `workflow-ui`.
- Workflow progress exposes `runningCount` and model visibility; workflow timeout aborts in-flight agents.
- CI coverage thresholds (`npm run coverage:check`) and branch preview release workflow.
- Extensive test coverage for rendering, schemas, and in-process tools.

### Fixed

- Poller skips duplicate inject when a late explicit `done` arrives after auto-done synthesis.
- Interactive sub-agent launch aborts and kills the pane when persisted state cannot be written.
- Workflow `runningCount` decremented on agent failure; timeout propagates abort to in-flight work.
- Shared workflow script parsing (`workflow-script.mjs`) used by main thread and worker thread.

[Unreleased]: https://github.com/lmn451/pi-subagentura/compare/v3.4.0...HEAD
[3.4.0]: https://github.com/lmn451/pi-subagentura/compare/v3.3.1...v3.4.0
[3.3.1]: https://github.com/lmn451/pi-subagentura/compare/v3.3.0...v3.3.1
[3.3.0]: https://github.com/lmn451/pi-subagentura/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/lmn451/pi-subagentura/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/lmn451/pi-subagentura/compare/v3.0.3...v3.1.0
[3.0.3]: https://github.com/lmn451/pi-subagentura/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/lmn451/pi-subagentura/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/lmn451/pi-subagentura/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/lmn451/pi-subagentura/compare/v2.3.3...v3.0.0

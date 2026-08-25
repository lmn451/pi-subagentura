# pi-subagentura — Agent Guidelines

A public [Pi](https://pi.dev) extension that adds in-process and attachable sub-agent tools. This file is for AI coding agents (and humans) working on the codebase.

## What this project is

- **npm package** `pi-subagentura` — published via OIDC trusted publishing on push of a `v*` tag.
- **Pi extension** — single entry point: `./src/subagent.ts` (declared in `package.json#pi.extensions`).
- **TypeScript, ESM, strict mode**, `target: ESNext`, Node ≥ 18, Pi SDK ≥ 0.80.6. CI verifies both the minimum and latest published Pi SDKs.
- **Runtime deps** are minimal: `ndjson`, `is-path-inside`. Pi SDKs are peer dependencies.
- **Tests** are `vitest` and live in `tests/` as `*.test.ts` (27 test files, ~12k lines of test code).
- **CI** is a single GitHub Actions workflow: typecheck → tests → published-tarball smoke → pack dry-run.

## Build / test / verify

Always run all of these before committing:

```bash
npm run typecheck   # tsc --noEmit, catches TDZ / no-use-before-define
npm test            # vitest run, 344+ tests
npm run format:check  # prettier --check .
npm run pack:check  # npm pack --dry-run, mirrors the publish step
```

The pre-commit hook (`simple-git-hooks` → `lint-staged` → `prettier --write`) formats staged files. The pre-push hook runs the third command across the repository. Install or refresh both with `npm run hooks:install`. Skip either for emergencies with `SKIP_SIMPLE_GIT_HOOKS=1`.

## Source layout (the 30-second tour)

| File                           | Purpose                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/subagent.ts`              | **Entrypoint/barrel.** ~100 LOC. Default export registers all tool groups and session handlers; re-exports internals for test access.                                                                             |
| `src/tools/in-process.ts`      | `subagent_with_context`, `subagent_isolated`, async job management tools (`get_subagent_status`, `get_subagent_result`, `cancel_subagent`, `prune_subagent_jobs`), and `list_available_models`.                   |
| `src/tools/interactive.ts`     | Interactive sub-agent tools (`subagent_interactive`, `get_interactive_subagent_status`, `cancel_interactive_subagent`, `send_interactive_subagent_message`, `list_subagent_artifacts`, `read_subagent_artifact`). |
| `src/session-handlers.ts`      | `session_start`/`session_shutdown` handlers; poller interval setup/teardown on extension load/reload/shutdown.                                                                                                    |
| `src/artifact-poller.ts`       | Per-tick byte-ordered artifact walk, legacy session-JSONL tail-reading, durable delivery enqueue, and UI activity updates.                                                                                        |
| `src/rehydrate.ts`             | Reconstruct persisted cursors, queues, and delivery receipts on session start/reload/resume.                                                                                                                      |
| `src/helpers.ts`               | `startSubagentJob` primitive (in-process sub-agent runner), `resolveModel`, `formatUsage`, job registry and cleanup.                                                                                              |
| `src/artifact.ts`              | Versioned artifact protocol, immutable `outputs/<eventId>.md`, byte readers, mixed-v1 compatibility, and state-v2 helpers.                                                                                        |
| `src/child-protocol.ts`        | Child-only Pi lifecycle hooks selected by `PI_SUBAGENTURA_CHILD=1`.                                                                                                                                               |
| `src/delivery.ts`              | Bounded durable trigger-aware delivery queue and deterministic delivery IDs.                                                                                                                                      |
| `src/interactive-tmux.ts`      | `InteractiveSubagentState` and registry, launch-script builder, mux backend dispatch (is-alive, send-keys, kill-pane).                                                                                            |
| `src/multiplexer*.ts`          | Pluggable multiplexer interface + tmux and zellij backends. Registry auto-detects available backend at runtime.                                                                                                   |
| `src/subagent-artifact-cli.ts` | Tiny `cli.mjs` wrapper called by the child: `cli.mjs done N` / `cli.mjs error "msg"`.                                                                                                                             |
| `src/notifications.ts`         | Unified in-process completion delivery and output sanitization.                                                                                                                                                   |
| `src/rendering.ts`             | TUI rendering helpers: `renderSubagentCall`, `renderSubagentResult`, `renderInteractiveStateSummary`.                                                                                                             |
| `src/schemas.ts`               | TypeBox schemas for tool parameter validation (`BaseParams`, `InteractiveParams`, etc.).                                                                                                                          |
| `src/workflow*.ts`             | Workflow tool/core/worker/job/UI modules. Worker execution is isolated from the parent thread but the VM is not a security boundary.                                                                              |
| `src/test-utils.ts`            | `importFresh` helper used by tests to reset module-level state (interactive sub-agent registry, mux mock, etc.).                                                                                                  |

## Code conventions

- **Follow existing project style.** This codebase uses 2-space indents, double quotes, semicolons, trailing commas, and ~80-char lines (matches prettier defaults with `{}` config). Don't reformat unrelated code.
- **Functions under ~50 lines** is the soft guideline; the per-tool blocks in `src/tools/in-process.ts` and `src/tools/interactive.ts`, and the per-test `it()` blocks run longer when they need to.
- **Comments only for non-obvious logic** — protocol invariants, the "why" of a guard, the "what this is NOT" of a deliberate limitation. No restating the code.
- **Declare all variables BEFORE conditional blocks that may return early.** `const`/`let` are hoisted into the TDZ; `if (cond) { return ... }` references before declaration throw at runtime. TypeScript's `no-use-before-define` (strict mode) catches this.
- **Errors must be explicit.** No silent `catch {}`. If you must swallow, comment why. `try { ... } catch { /* reason */ }` is the pattern.
- **Runtime logging uses `debugLog`.** Do not call the host `console.*` methods from published runtime source; route diagnostics through `debugLog` from `src/helpers.ts` so logging stays opt-in and cannot corrupt the Pi TUI. The workflow sandbox's injected `console` API is allowed only when its methods route through the workflow logger.
- **Never hardcode secrets, API keys, or tokens.** This package is published publicly; anything sensitive goes through the Pi SDK's auth path.

## Project-specific gotchas

These are non-obvious behaviors that have bitten people. Read them before touching the relevant code.

### Physical byte order is authoritative

Protocol-v2 event identity is `eventId` plus Pi-derived `turnId`. The poller
advances `eventByteCursor` using complete NDJSON line offsets. Timestamps are
display/TTL metadata only; never use them for ordering, deduplication, snapshot
association, injection, or delivery cursors.

### `cli.mjs done` is the contract for interactive sub-agents

The child lifecycle hooks capture `agent_end` messages and append the
authoritative completion only at `agent_settled`, after retries, compaction, and
queued continuations. The first `turn_start` binds the provisional turn to the
persisted Pi user-entry id. `cli.mjs done N` remains an explicit compatible
signal, but is idempotent by `turnId`; a late call cannot duplicate a snapshot
or delivery. Protocol v2 has no timeout-based auto-done heuristic.

Pi treats Enter during streaming as steering within the existing agent run and
does not emit another `before_agent_start`. The child protocol must rotate to
the newly persisted user-entry id in `before_provider_request`; otherwise that
turn's `done` is deduplicated against the prior turn and its output is lost.

Snapshot writers must enforce `MAX_OUTPUT_SNAPSHOT_BYTES` before reading or
copying child-controlled `output.md`. Oversized staging output records explicit
`outputError` metadata and must never be loaded synchronously into the parent.

### `extractJson` in `src/workflow-core.ts` is dependency-free on purpose

The runtime validation in the workflow tool (`validateSchema`, `extractJson`) is a hand-rolled ~80-line JSON Schema subset, not a dep. This is intentional: the tool is in-process and must not pull `ajv` or similar into the parent Pi install. Don't replace it with a library without a strong reason.

### The `workflow` VM is a determinism aid, not a security boundary

`runInNewContext` is not an escape-proof jail. The workflow VM uses null-prototype sandboxes, guarded `Date`/`Math`, and disabled string/wasm code generation to block known accidental escapes (including constructor-chain `Function` calls), but workflow scripts are still trusted agent-authored code. Do not expose workflow execution to arbitrary user-supplied JavaScript without adding real process-level isolation and a security review.

### Background workflows are parent-session scoped

Background workflow jobs and in-process async sub-agent jobs do **not** survive
parent session replacement. On every `session_shutdown` reason (`reload`,
`resume`, `quit`, `new`, and similar), `src/session-handlers.ts` suppresses late
workflow completion hooks, aborts running workflow workers, and clears
`workflowJobRegistry`. Suppression must happen **before** abort/clear so a promise
that settles during shutdown cannot notify the next parent session through the
global Pi reference.

This intentionally differs from interactive sub-agents: their mux processes and
artifact-backed state can survive reload/resume/quit and be rehydrated. Do not
make background workflows survive reload by merely retaining the global
registry; safe survival requires persisted job state plus rebinding `runAgent`
and notification delivery to the new parent context.

### Rehydrate state file (`<cwd>/.pi/subagentura-state.json`)

The interactive sub-agent registry is persisted to a per-(cwd) state file on
`launchInteractiveSubagent`. The file stores the minimum fields needed to rehydrate
(`paneId`, `mux`, `artifactDir`, `sessionFile`, `notifyOnComplete`). On `session_start` the
rehydrate function reads schema v2 and reconstructs artifact/session byte
cursors, active turn, pending delivery intents, and delivery receipts.

**Crash-safe ordering at both write sites:**

- **Spawn** — write the state file BEFORE `interactiveSubagentRegistry.set`.
  A crash between the two is recoverable on next reload.
  A crash before the write leaves no zombie.
- **Poll enqueue** — persist the delivery intent before advancing the artifact
  byte cursor. A crash may duplicate dispatch, but cannot silently drop it.

**Rehydrate on startup, reload, and resume:**

The `session_start` handler checks `event.reason` and rehydrates when the
reason is `"startup"`, `"reload"`, or `"resume"`. This means subagents that
survived a Ctrl+D (quit) will reappear in the registry on the next pi launch.
On explicit fresh starts (`"new"`, `"fork"`) the state file is ignored — previous
session's subagents should not pollute the new session's view. The state file is
deleted on `session_shutdown(reason="new")` to give the next session a clean slate.
On `session_shutdown(reason="quit")` the panes and state file are preserved so the
subagents survive a restart.

Standalone interactive panes are preserved for continuity transitions (`startup`,
`reload`, `resume`, and `quit`) and unknown lifecycle reasons. Automatic lifecycle
cleanup destroys them only for intentional fresh-session transitions (`new` and
`fork`); workflow-owned panes retain their generation-scoped cleanup. Parent
cancellation completion events keep `source="parent"` for compatibility and add
closed-enum `cancellationOrigin` and `cancellationLifecycleReason` diagnostics.

Lineage authority is explicit process state, never ambient `PI_SUBAGENTURA_*`
metadata. The active `SessionScope` carries a typed lineage context. Child launchers
write that context to a mode-0600 one-use bootstrap and export only its path. The child
atomically claims and unlinks the bootstrap before registration; credentials expire
after 60 seconds, cancellation/fresh transitions retire unclaimed files, and reloads
reuse the
process-local copy. Without an explicit context, the supervisor may show and act on
direct registry entries but must not project persisted lineage. Vitest setup strips
lineage/bootstrap variables globally, and lineage tests opt into temporary contexts.
Legacy lineage identity/depth environment variables are intentionally ignored. A
mixed-version child without a bootstrap degrades to direct-registry-only lineage and
cannot recursively spawn interactive children until it is respawned; it must never
reconstruct cancellation authority from inherited env.
This isolates accidental subprocess inheritance; it is not an OS security boundary
against malicious same-UID code, which can already address the user's mux directly.

**Delivery receipts:** Rehydrate reconciles deterministic `deliveryId` values
against parent custom session entries. The synchronous Pi API proves dispatch,
not durable commit, so delivery is at-least-once and a crash-window duplicate
remains possible.

**Edge cases:**

- If `parentSessionId` is omitted (e.g. programmatic spawns from tests),
  the file is not written; no rehydrate happens on reload.
- If the state file is missing on `session_start`, rehydrate is a silent no-op.
- If a rehydrated entry's pane is dead, `deriveInteractiveSubagentStatus`
  sets `status="exited"` or `status="unknown"`; registry entry is retained
  so `list_subagent_artifacts` can still surface it before the next cleanup.
- The schema is versioned (`schemaVersion: 2`) with explicit v1 migration so
  coexist with older state files on upgrades.

## Git

- **Conventional Commits**: `feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:` / `perf:`. Scopes are welcome but not required.
- **One concern per commit.** Bug fixes and the tests that prove them go in the same commit. A doc clarification of a previous fix is a separate commit.
- **Never force-push to `master`.** Feature branches are disposable; the trunk is not.
- **Branch naming**: `feat/<short-desc>`, `fix/<short-desc>`, `chore/<short-desc>`. No ticket numbers unless the repo uses them (it doesn't, yet).
- **Releases**: see [CONTRIBUTING.md](./CONTRIBUTING.md#release-flow) for the full release flow and version/tag collision recovery. The `publish.yml` workflow uses OIDC trusted publishing — no `NPM_TOKEN` secret exists or should exist.

## Workflow

- **Read before write.** This codebase has lots of small invariants that aren't documented anywhere except inline. Open the file you'll change before you start.
- **Minimal changes.** Don't refactor unrelated code, don't rename for taste, don't reformat the file you're in. One concern per commit.
- **Verify after every change.** `npm test` and `npm run typecheck` are fast. Run them. If your change is in a hot path (`subagent.ts`), also exercise the relevant test file in isolation.
- **Write the regression test first** for any bug fix. Watch it fail on the unfixed code, then fix, then watch it pass. No "I'll add the test later."
- **When spawning sub-agents to review your work**, give them the exact diff/commit, a focused angle, and ask for a written report. Don't ask them to fix anything — they will, and you'll have a fight.

## Safety

- **The published package is public.** Anything in `src/` is published to npm. No secrets, no personal data, no localhost URLs, no debug paths.
- **User input is from an LLM.** Treat all tool params as adversarial: the parent agent that calls `subagent_with_context` is the trusted caller, but the _content_ of `task`, `persona`, and the `args` of `workflow` are model-generated. Validate, bound, and quote carefully. The `MAX_TOTAL_AGENTS` and `MAX_ITEMS_PER_CALL` caps in `workflow.ts` are the shape of "bounded resource use" this codebase expects.
- **The `vm` sandbox in `workflow.ts` is not a security boundary.** It's a determinism aid. Do not extend it to less-trusted authors without first adding `codeGeneration: { strings: false }` and a thorough review.
- **No `require`/`process` from inside the workflow sandbox** — that's the one Node-injection we genuinely do block, because `vm.runInNewContext` doesn't pass the `node` global into the sandbox by default. If you ever need to add a Node-side helper for the script, expose it as an injected global, not as a require.

## File map at a glance

```
src/
  subagent.ts                      # Entrypoint/barrel — registers tools, re-exports internals
  tools/
    in-process.ts                  # subagent_with_context, subagent_isolated, async tools
    interactive.ts                 # subagent_interactive, get/send/cancel/read/list tools
  session-handlers.ts              # session_start/shutdown handlers, poller setup
  artifact-poller.ts               # byte-ordered event fold, durable enqueue, activity UI
  child-protocol.ts                # child-only Pi lifecycle hooks and completion writer
  delivery.ts                      # bounded delivery broker and receipt reconciliation
  rehydrate.ts                     # restore persisted cursors, queues, and receipts
  helpers.ts                       # startSubagentJob, resolveModel, job registry
  artifact.ts                      # v2 events, immutable outputs, state migration
  interactive-tmux.ts              # InteractiveSubagentState, registry, mux dispatch
  multiplexer{,-tmux,-zellij}.ts   # mux backend abstraction (tmux + zellij)
  subagent-artifact-cli.ts         # cli.mjs wrapper
  notifications.ts                 # in-process completion delivery and compatibility exports
  rendering.ts                     # TUI render helpers
  schemas.ts                       # TypeBox tool-param schemas
  workflow.ts                      # workflow tool
  ndjson.d.ts                      # ambient types for the ndjson dep

  test-utils.ts                    # importFresh helper for module-reset tests
tests/
  *.test.ts                        # 27 test files, ~12k lines
.github/
  workflows/                       # CI (ci.yml) and publish (publish.yml)
docs/                              # Managed by the separate pi-docs package; do not edit
```

## When in doubt

- The existing tests in the same directory are the best documentation of intended behavior.
- `tests/artifact-delivery.integration.test.ts`, `tests/pi-session-delivery.integration.test.ts`, `tests/subagent-notify.test.ts`, and the rehydrate tests together define the protocol-v2 delivery contract.
- The release flow is in `CONTRIBUTING.md`. The dev loop (typecheck + test + format) is above. If a step seems to be missing from this file, it probably is — add it.

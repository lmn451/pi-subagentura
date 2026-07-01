# pi-subagentura — Agent Guidelines

A public [Pi](https://pi.dev) extension that adds in-process and attachable sub-agent tools. This file is for AI coding agents (and humans) working on the codebase.

## What this project is

- **npm package** `pi-subagentura` — published via OIDC trusted publishing on push of a `v*` tag.
- **Pi extension** — single entry point: `./src/subagent.ts` (declared in `package.json#pi.extensions`).
- **TypeScript, ESM, strict mode**, `target: ESNext`, Node ≥ 18.
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

The pre-push hook (`simple-git-hooks` → `lint-staged` → `prettier --check`) runs the third one on staged files. Skip it for emergencies: `SKIP_SIMPLE_GIT_HOOKS=1 git push`.

## Source layout (the 30-second tour)

| File                           | Purpose                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/subagent.ts`              | **Entrypoint/barrel.** ~100 LOC. Default export registers all tool groups and session handlers; re-exports internals for test access.                                                                             |
| `src/tools/in-process.ts`      | `subagent_with_context`, `subagent_isolated`, async job management tools (`get_subagent_status`, `get_subagent_result`, `cancel_subagent`, `prune_subagent_jobs`), and `list_available_models`.                   |
| `src/tools/interactive.ts`     | Interactive sub-agent tools (`subagent_interactive`, `get_interactive_subagent_status`, `cancel_interactive_subagent`, `send_interactive_subagent_message`, `list_subagent_artifacts`, `read_subagent_artifact`). |
| `src/session-handlers.ts`      | `session_start`/`session_shutdown` handlers; poller interval setup/teardown on extension load/reload/shutdown.                                                                                                    |
| `src/artifact-poller.ts`       | Per-tick artifact walk, session-JSONL tail-reading, `tool_activity` event appending, auto-done fallback, and notification delivery.                                                                               |
| `src/rehydrate.ts`             | Reconstruct `InteractiveSubagentState` from on-disk state file on session start/reload/resume. Idempotent; resets cursors for backlog replay.                                                                     |
| `src/helpers.ts`               | `startSubagentJob` primitive (in-process sub-agent runner), `resolveModel`, `formatUsage`, job registry and cleanup.                                                                                              |
| `src/artifact.ts`              | On-disk artifact protocol: `events.ndjson`, `output.md`, `output-N.md` snapshots, atomic writes via `*.tmp` + `renameSync`, state file helpers.                                                                   |
| `src/interactive-tmux.ts`      | `InteractiveSubagentState` and registry, launch-script builder, mux backend dispatch (is-alive, send-keys, kill-pane).                                                                                            |
| `src/multiplexer*.ts`          | Pluggable multiplexer interface + tmux and zellij backends. Registry auto-detects available backend at runtime.                                                                                                   |
| `src/subagent-artifact-cli.ts` | Tiny `cli.mjs` wrapper called by the child: `cli.mjs done N` / `cli.mjs error "msg"`.                                                                                                                             |
| `src/notifications.ts`         | Notification delivery (notify/inject), `MAX_INJECT` concurrent cap, inject-count tracking.                                                                                                                        |
| `src/rendering.ts`             | TUI rendering helpers: `renderSubagentCall`, `renderSubagentResult`, `renderInteractiveStateSummary`.                                                                                                             |
| `src/schemas.ts`               | TypeBox schemas for tool parameter validation (`BaseParams`, `InteractiveParams`, etc.).                                                                                                                          |
| `src/workflow.ts`              | The `workflow` tool (v1, on `feat/workflow-tool` branch — see "Known quirks" below).                                                                                                                              |
| `src/test-utils.ts`            | `importFresh` helper used by tests to reset module-level state (interactive sub-agent registry, mux mock, etc.).                                                                                                  |

## Code conventions

- **Follow existing project style.** This codebase uses 2-space indents, double quotes, semicolons, trailing commas, and ~80-char lines (matches prettier defaults with `{}` config). Don't reformat unrelated code.
- **Functions under ~50 lines** is the soft guideline; the per-tool blocks in `src/tools/in-process.ts` and `src/tools/interactive.ts`, and the per-test `it()` blocks run longer when they need to.
- **Comments only for non-obvious logic** — protocol invariants, the "why" of a guard, the "what this is NOT" of a deliberate limitation. No restating the code.
- **Declare all variables BEFORE conditional blocks that may return early.** `const`/`let` are hoisted into the TDZ; `if (cond) { return ... }` references before declaration throw at runtime. TypeScript's `no-use-before-define` (strict mode) catches this.
- **Errors must be explicit.** No silent `catch {}`. If you must swallow, comment why. `try { ... } catch { /* reason */ }` is the pattern.
- **Never hardcode secrets, API keys, or tokens.** This package is published publicly; anything sensitive goes through the Pi SDK's auth path.

## Project-specific gotchas

These are non-obvious behaviors that have bitten people. Read them before touching the relevant code.

### The auto-done-fallback (`src/artifact-poller.ts` → `maybeAutoDone`)

The `auto-done-fallback` synthesizes a completion event when a child ends a turn with `stopReason: "stop"` but never calls `cli.mjs done` (a common LLM failure mode). It is **time-bounded** by `AUTO_DONE_DEBOUNCE_MS` (10s default).

**The guard is `readEvents(art).some(ev => isTerminal(ev))`, NOT `lastEvent(art)`.** This was a real bug: `tailReadSessionLog` runs immediately before the fallback and can append `tool_activity` rows to `events.ndjson` _after_ the child's explicit `done`. `lastEvent` would then return a `tool_activity` and the guard would miss, causing a double-notify. See commit `01cd745` for the postmortem and the regression test. **Do not "simplify" this back to `lastEvent()`.**

### `lastDeliveredEventTs` is the only poller cursor (`src/artifact-poller.ts`)

Every notification delivery advances `state.lastDeliveredEventTs` to the highest `ev.ts` it delivered. The next poll calls `readEvents(art, cursor + 1)`. **Never read events without going through this cursor** — you will re-deliver notifications and double-fire.

### `cli.mjs done` is the contract for interactive sub-agents

The child MUST call `cli.mjs done N` after writing `output.md`. The fallback exists because LLMs forget. If you change the protocol, update `src/subagent-artifact-cli.ts` AND the wrapper scripts AND the auto-done-fallback tests.

### `extractJson` in `src/workflow.ts` is dependency-free on purpose

The runtime validation in the workflow tool (`validateSchema`, `extractJson`) is a hand-rolled ~80-line JSON Schema subset, not a dep. This is intentional: the tool is in-process and must not pull `ajv` or similar into the parent Pi install. Don't replace it with a library without a strong reason.

### The `workflow` tool's determinism story is more limited than the docs imply

`runInNewContext` is not an escape-proof jail. The `Date.now()` / `Math.random()` / argless `new Date()` guards throw when called directly, but a script that goes out of its way to be non-deterministic can reach the real ones via `eval()` / `new Function()`. The script author is the trusted main agent, so this is acceptable — but the docs and source comments must keep saying so, because the day someone un-trusts the author, the only thing standing between them and a non-deterministic workflow is a one-line `codeGeneration: { strings: false }` we have not added yet.

### Rehydrate state file (`<cwd>/.pi/subagentura-state.json`)

The interactive sub-agent registry is persisted to a per-(cwd) state file on
`launchInteractiveSubagent`. The file stores the minimum fields needed to rehydrate
(`paneId`, `mux`, `artifactDir`, `sessionFile`, `notifyOnComplete`). On `session_start` the
rehydrate function reads the file and reconstructs `InteractiveSubagentState` entries with
reset runtime cursors (replay-all semantics).

**Crash-safe ordering at both write sites:**

- **Spawn** — write the state file BEFORE `interactiveSubagentRegistry.set`.
  A crash between the two is recoverable on next reload.
  A crash before the write leaves no zombie.
- **Poll cleanup** — advance `lastDeliveredEventTs` (in-memory) BEFORE
  `removeInteractiveState` (disk). A crash between them re-delivers rather
  than drops the event.

**Rehydrate on startup, reload, and resume:**

The `session_start` handler checks `event.reason` and rehydrates when the
reason is `"startup"`, `"reload"`, or `"resume"`. This means subagents that
survived a Ctrl+D (quit) will reappear in the registry on the next pi launch.
On explicit fresh starts (`"new"`, `"fork"`) the state file is ignored — previous
session's subagents should not pollute the new session's view. The state file is
deleted on `session_shutdown(reason="new")` to give the next session a clean slate.
On `session_shutdown(reason="quit")` the panes and state file are preserved so the
subagents survive a restart.

**Inject-mode flood fix at rehydrate:**
When `notifyOnComplete="inject"` and the artifact already has a terminal event,
`lastInjectedEventTs` is set to the latest event's ts so the poller does NOT
re-inject the existing result into the new parent session on its first tick.
Future follow-up `done` events (higher ts) still inject normally.

**Edge cases:**

- If `parentSessionId` is omitted (e.g. programmatic spawns from tests),
  the file is not written; no rehydrate happens on reload.
- If the state file is missing on `session_start`, rehydrate is a silent no-op.
- If a rehydrated entry's pane is dead, `deriveInteractiveSubagentStatus`
  sets `status="exited"` or `status="unknown"`; registry entry is retained
  so `list_subagent_artifacts` can still surface it before the next cleanup.
- The schema is versioned (`schemaVersion: 1`) so future migrations can
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
  artifact-poller.ts               # per-tick artifact walk, auto-done fallback, notifications
  rehydrate.ts                     # reconstruct InteractiveSubagentState from state file
  helpers.ts                       # startSubagentJob, resolveModel, job registry
  artifact.ts                      # events.ndjson + output.md protocol, state file helpers
  interactive-tmux.ts              # InteractiveSubagentState, registry, mux dispatch
  multiplexer{,-tmux,-zellij}.ts   # mux backend abstraction (tmux + zellij)
  subagent-artifact-cli.ts         # cli.mjs wrapper
  notifications.ts                 # notify/inject delivery, MAX_INJECT cap
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
- `tests/subagent-auto-done.test.ts`, `tests/subagent-notify.test.ts`, `tests/subagent-rehydrate-core.test.ts`, and `tests/subagent-rehydrate-artifacts.test.ts` together define the artifact-protocol contract — if you're not sure what `events.ndjson` is supposed to contain, those tests are the spec.
- The release flow is in `CONTRIBUTING.md`. The dev loop (typecheck + test + format) is above. If a step seems to be missing from this file, it probably is — add it.

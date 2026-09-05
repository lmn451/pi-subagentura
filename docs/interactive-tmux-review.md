---
title: "Interactive Subagent Code Review"
keywords:
  [code-review, interactive-subagent, tmux, zellij, bugs, race-condition]
---

# Interactive Subagent Code Review

> **Historical archive:** This report records the implementation review from
> 2026-06-18. H1, H2, and H3 were subsequently fixed; the remaining findings
> and recommendations are dated review notes and must be revalidated against
> the current source and tests before being treated as open defects.

Review of `src/interactive-tmux.ts` and adjacent mux files (`src/multiplexer-tmux.ts`, `src/multiplexer-zellij.ts`, `src/multiplexer.ts`) conducted via an interactive subagent running on **GLM-5.2** (`opencode-go/glm-5.2`) on 2026-06-18.

The reviewer read all source and test files plus the consumer call sites in `src/subagent.ts`. Output was saved to a local subagent artifact directory.

## Summary

The orchestrator is well-structured and the mux abstraction is clean, but there are two real correctness bugs worth shipping fixes for: (1) `buildAttachCommands` runs **outside** the orphan-pane `try/catch`; (2) the launch script's EXIT trap reads `$?` _after_ `cli.mjs done` has already consumed it. There is also a path-with-quote edge case in the trap line that will break the launch script entirely. Race/concurrency is mostly fine because the registry is single-threaded per poll, but `cancelInteractiveSubagent` can leave a live orphan pane if `getMuxForState` throws. Test coverage of the interactive lifecycle itself is thin.

## High Priority

### H1. `buildAttachCommands` runs outside the orphan-pane guard

**File:** `src/interactive-tmux.ts:460`

`launchInteractiveSubagent` wraps `writeLaunchScript` / `sendKeys` / `sendEnter` in a `try/catch` that calls `mux.killPane(paneId, muxSession)` on failure (lines 439-458). But `mux.buildAttachCommands(...)` at line 460 is **outside** that guard. `TmuxMultiplexer.buildAttachCommands` calls `getPaneLocation(paneId)` (`multiplexer-tmux.ts:219,226`), which runs `tmux display-message -t <paneId>` and **throws** if the pane is dead.

**Failure mode:** the child `pi` process starts, hits a fatal config error, and exits within the milliseconds between `mux.sendEnter` and `buildAttachCommands`. The launch script's EXIT trap fires, the pane dies, then `getPaneLocation` throws. The exception propagates out of `launchInteractiveSubagent`, `interactiveSubagentRegistry.set` (line 481) is never reached, the caller (`subagent.ts:1990`) gets an exception wrapped into a structured error, **but the pane is never killed**. On tmux the pane auto-dies; on zellij a `new-tab` pane in a detached background session does NOT auto-close on shell exit, so a still-warm pane is orphaned.

**Fix:** move `buildAttachCommands` inside the existing `try` block.

### H2. EXIT-trap reads `$?` after `cli.mjs done` consumes it → `@pi-exit-code` records the wrong value

**File:** `src/interactive-tmux.ts:354`

```bash
trap 'if [ -f "${artifactDir}/.cancelled" ]; then "${cliPath}" cancelled; else "${cliPath}" done "$?"; fi; tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$?" 2>/dev/null || true' EXIT
```

At trap entry `$?` is the child's exit code, so `cli.mjs done "$?"` gets the correct value. But the _next_ statement reads `"$?"` again — and `$?` is now the exit status of the `cli.mjs` invocation (0 on success), **not** the child's code. So `@pi-exit-code` is always 0 (or cli.mjs's error code) whenever the trap runs the `done` branch. `readPaneExitCode` (the documented fallback when the artifact `done` event is missing) therefore reports success for failed children.

**Verified with bash:** produces `done with code 1` and `pane exit: 0` when child exits 7.

**Fix:** capture once at trap entry:

```bash
trap 'code=$?; if [ -f "${ARTIFACT_DIR}/.cancelled" ]; then "${ARTIFACT_DIR}/cli.mjs" cancelled; else "${ARTIFACT_DIR}/cli.mjs" done "$code"; fi; tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$code" 2>/dev/null || true' EXIT
```

### H3. Launch-script trap line bakes raw paths into single-quoted bash → breaks on paths containing `'` or `"`

**File:** `src/interactive-tmux.ts:354`

`export ARTIFACT_DIR=${escape(artifactDir)}` (line 352) correctly single-quote-escapes the path. But the trap (354) and the `cli.mjs start` line (353) interpolate the **raw** `${artifactDir}` / `${cliPath}` into the script. An apostrophe in the path (e.g. `/Users/O'Brien/sessions`) terminates the single-quoted trap string early → bash parse error → **the launch script never runs** → child pane sits at a blank shell, parent polls forever seeing no `started` event.

**Verified with bash:** `bash -n` exits 2 with `unexpected EOF while looking for matching `"'` on a path with an apostrophe.

**Fix:** reference `ARTIFACT_DIR` (already exported on line 352) in the trap and the start line. This also fixes H2 in the same edit:

```bash
"${ARTIFACT_DIR}/cli.mjs" start
trap 'code=$?; if [ -f "${ARTIFACT_DIR}/.cancelled" ]; then "${ARTIFACT_DIR}/cli.mjs" cancelled; else "${ARTIFACT_DIR}/cli.mjs" done "$code"; fi; tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$code" 2>/dev/null || true' EXIT
```

The child-protocol prompt in `buildChildSubagentProtocol` is unaffected because it targets the `write` tool, which takes literal paths.

## Medium Priority

### M1. `cancelInteractiveSubagent` can leave a live orphan pane

**File:** `src/interactive-tmux.ts:532-555`

The function writes `.cancelled` and sets `state.status = "cancelled"`, then calls `getMuxForState(state)` which can throw `NoMultiplexerAvailableError` if the mux binary is no longer on PATH. No `try/catch` around the mux ops. The state is marked `"cancelled"` (so the poller at `subagent.ts:527` will skip it forever) but `mux.killPane` never ran → the pane stays alive indefinitely with no reaper.

**Fix:** wrap the `isPaneAlive`/`killPane` calls in `try/catch`. At minimum, ensure a thrown `getMux` doesn't strand a live pane.

### M2. Dead/legacy helpers bypass mux resolution → silently wrong on zellij-spawned panes

**File:** `src/interactive-tmux.ts:518-530`

`isTmuxPaneAlive(paneId)` and `sendCommandToTmuxPane(paneId, command)` construct `new TmuxMultiplexer()` and ignore `state.mux` entirely. Zero call sites in `src/`. If anything ever calls them against a zellij-spawned state, `isTmuxPaneAlive` probes tmux for a zellij pane id → always `false` → poller thinks child is dead.

**Fix:** delete them (cleanest, since no callers).

### M3. `safeSegment` duplicated in three files

**Files:** `interactive-tmux.ts:250-258`, `multiplexer-tmux.ts:47-55`, `multiplexer-zellij.ts:35-43`

Three byte-identical copies. `multiplexer.ts` already exports shared helpers (`commandExists`, `shellEscape`); `safeSegment` should live there too.

### M4. `getPaneLocation` in `buildAttachCommands` is a wasted second exec per spawn

**File:** `multiplexer-tmux.ts:208-232`

`TmuxMultiplexer.createPane` already knows the session but does not return `session`. `buildAttachCommands` re-derives via `display-message`. The `Multiplexer.createPane` return type already includes `session?: string`; tmux should populate it in both standard and relaxed paths.

### M5. `isPaneAlive` runs an exec per sub-agent per poll tick

**File:** `interactive-tmux.ts:500-502`

Every poll tick, for every non-terminal sub-agent, `isPaneAlive` shells out to `tmux display-message` / `zellij list-panes --json`. For N concurrent agents that's 2N execs/tick. Consider caching liveness for the duration of a single poll pass, or batching zellij's `list-panes` (it already returns all panes in one call).

### M6. `pruneDeadInteractiveSubagents` session-file fallback can misclassify a never-started child as "exited"

**File:** `src/interactive-tmux.ts:600-602`

```ts
if (next === "unknown" && state.sessionFile && existsSync(state.sessionFile)) {
  next = "exited";
}
```

The comment says "A non-empty session file means the child pi at least started writing" but the check is `existsSync`, not a non-empty check. If something makes the path exist with zero bytes (path collision, future change that pre-creates), a child that never started is marked `exited` (terminal), hiding the real "never launched" failure. Use `statSync(path).size > 0` to match the comment's intent.

## Low Priority / Nits

| #   | Issue                                                                                                                                                                                       | File                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| L1  | `launchInteractiveSubagent` writes prompt/system files before `getMux`/`createPane`; if mux resolution fails, files are left on disk (harmless, but unclean).                               | `interactive-tmux.ts:388-431`   |
| L2  | `isTmuxAvailable` / `tmuxSetupHint` naming is stale — behavior is mux-agnostic-ish.                                                                                                         | `interactive-tmux.ts:237-248`   |
| L3  | `buildInteractivePrompt` footer duplicates the protocol's done instruction.                                                                                                                 | `interactive-tmux.ts:293-311`   |
| L4  | `buildPiInteractiveCommand` does not validate that `promptFile`/`systemPromptFile`/`sessionFile` are absolute.                                                                              | `interactive-tmux.ts:313-331`   |
| L5  | `deriveInteractiveSubagentStatus` — `done` + pane alive → `"idle"` assumes the REPL is actually responsive. No liveness-of-REPL probe exists.                                               | `interactive-tmux.ts:564-574`   |
| L6  | Zellij `createPane` pane-diff picks `newPanes[0]` — ordering not guaranteed. Single-user single-agent usage makes this near-impossible, but the fallback chain silently masks a wrong pick. | `multiplexer-zellij.ts:159-161` |

## Recommended tests

Concrete cases that should exist in `src/interactive-tmux.test.ts`:

1. **Orphan-pane guard covers `buildAttachCommands` (H1).** Mock `createPane` to return a pane id, then mock `display-message` to throw. Assert `kill-pane` is invoked and `interactiveSubagentRegistry.size === 0`.
2. **EXIT trap preserves the real exit code (H2).** Read the rendered launch script and assert the trap captures `$?` into a variable before the `tmux set-option` call.
3. **Launch script survives an apostrophe in `PI_CODING_AGENT_SESSION_DIR` (H3).** Set the env var to `/tmp/O'Brien`, launch, then `bash -n <launchScriptFile>` and assert exit 0.
4. **`cancelInteractiveSubagent` happy path.** No test exists.
5. **`cancelInteractiveSubagent` when `getMuxForState` throws (M1).** Assert the function does not strand a live pane.
6. **`sendCommandToPane` routes through `state.mux`.** Register a zellij-backed state and assert `sendKeys`/`sendEnter` are called on the zellij backend, not tmux.
7. **`pruneDeadInteractiveSubagents` empty session file → stays `"unknown"` (M6).** Three sub-cases: missing / non-empty / empty.
8. **`pruneDeadInteractiveSubagents` skips terminal states.** Register `"cancelled"` and `"exited"` states; assert no `isPaneAlive` exec.
9. **`muxPreference` propagation.** Launch with `muxPreference: "zellij"` and assert the zellij backend's `createPane` is called.
10. **Relaxed-spawn path.** `process.env.TMUX = ""` and assert `createPane` uses `new-session -d -s pi-subagent-<id>`.
11. **`formatInteractiveState` output shape.** Trivial but untested.
12. **`deriveInteractiveSubagentStatus` with `exitCode` propagation.**
13. **Legacy helpers deleted (M2).**

## How to reproduce H2 and H3

```bash
# H2: child exits 7, but @pi-exit-code records 0
cat > /tmp/verify-h2.sh <<'BASH'
#!/bin/bash
trap 'if [ -f "/tmp/.cancelled" ]; then echo cancelled; else echo "done $?"; fi; echo "pane exit: $?"' EXIT
exit 7
BASH
chmod +x /tmp/verify-h2.sh && /tmp/verify-h2.sh
# Output: done 1   pane exit: 0
# Fix: capture once at trap entry
trap 'code=$?; if [ -f "/tmp/.cancelled" ]; then echo cancelled; else echo "done $code"; fi; echo "pane exit: $code"' EXIT
# Output: done 7   pane exit: 7

# H3: apostrophe in path breaks trap
ARTIFACT_DIR="/tmp/O'Brien/artifacts"
trap 'if [ -f "${ARTIFACT_DIR}/.cancelled" ]; then echo cancelled; else echo done; fi' EXIT
# bash -n: syntax error: unexpected EOF while looking for matching `"'
# Fix: reference $ARTIFACT_DIR (already exported) instead of re-interpolating
```

## Status

This is a historical report of the 2026-06-18 implementation. H1/H2/H3 were
subsequently fixed. M1-M6 and the low-priority notes remain dated review
observations; verify the current source and tests before treating any as an
open defect.

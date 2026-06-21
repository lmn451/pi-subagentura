# Plan — Rehydrate interactive sub-agents on parent reload

Branch: `fix/interactive-reload-visibility`
Cwd: `/Users/applesucks/dev/pi-workflow-v2-worktrees/interactive-reload-visibility`
Locked: 2026-06-19

---

## Context

Interactive sub-agents run as separate `pi --session ...` processes in tmux/zellij panes. Each writes lifecycle events to `events.ndjson` and output to `output.md` in an artifact dir. The artifact protocol already survives parent restarts by design (`src/artifact.ts:1-17` file header).

What breaks across a parent `:reload` / extension restart / parent crash:

- The in-memory `interactiveSubagentRegistry` Map is wiped by `interactiveSubagentRegistry.clear()` at `src/subagent.ts:2522` during `session_shutdown`.
- The 5s artifact poller is stopped by `clearInterval` at `src/subagent.ts:2498-2503`.
- The pane stays alive in tmux/zellij, the artifact stays on disk, but the parent has no in-memory state to address the pane.
- Tools that hit the registry (`get_interactive_subagent_status`, `send_interactive_subagent_message`, `cancel_interactive_subagent`, `list_subagent_artifacts`) return `not_found` for what is effectively a live orphan.

After this PR, `:reload` (and any other session lifecycle event) re-attaches the parent's view of every still-live sub-agent, and completion events that fired during downtime are replayed by the existing poller.

---

## Locked design

### File layout

Per `(cwd, sessionId)` pair:

```
<cwd>/.pi/subagentura-state-<sessionId>.json
```

- `cwd` is the value of `ctx.cwd` (or `state.cwd` for spawn-time writes).
- `sessionId` comes from `ctx.sessionManager.getSessionId()` — see `ReadonlySessionManager` at `@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:136`, getter at `:188`.
- The directory `.pi/` is created on first write (`mkdirSync(dirname, { recursive: true, mode: 0o700 })`).
- File mode `0o600`. Atomic via `writeFileSync(tmp); renameSync(tmp, target)`.

### Schema (v1)

```ts
export interface InteractiveSubagentPersistedState {
  schemaVersion: 1;
  parent: string; // sessionId — redundant with filename; kept for verification/debug
  states: {
    [id: string]: {
      id: string; // 8 hex chars, randomBytes(4).toString("hex")
      paneId: string;
      windowName?: string;
      mux: "tmux" | "zellij";
      muxSession?: string; // undefined for tmux; required for zellij
      artifactDir: string;
      sessionFile: string;
      notifyOnComplete?: "notify" | "inject";
    };
  };
}
```

Eight fields per entry. The minimum to call `sendCommandToPane` (`src/interactive-tmux.ts:533-537`), `isPaneAlive` (`:525-527`), `cancelInteractiveSubagent` (`:557-580`), and to drive the poller's `tailReadSessionLog` (`:714-773`).

### Lifecycle

| Event                                                       | File action                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Spawn (`launchInteractiveSubagent`)                         | Write entry before `interactiveSubagentRegistry.set`                              |
| Poller delivers terminal event (`done`/`error`/`cancelled`) | Rewrite file with entry removed, after cursor advance                             |
| `:reload` (`session_shutdown` reason=`"reload"`)            | No file action — keep file, re-read on next `session_start`                       |
| `:new` (`session_shutdown` reason=`"new"`)                  | Delete file (clean slate)                                                         |
| `quit` (`session_shutdown` reason=`"quit"`)                 | Delete file (cleanup; pi is exiting)                                              |
| `session_start` (any reason)                                | Read file, rehydrate states into registry                                         |
| Rehydrate sees dead pane + last event is terminal           | Mark `exited`/`cancelled` per `deriveInteractiveSubagentStatus(lastEvent, false)` |

### Cursor reset on rehydrate

Runtime cursors are reset to their defaults on rehydrate (replay-all from the new process's view):

- `lastDeliveredEventTs = 0`
- `lastDeliveredSessionByte = 0`
- `lastInjectedEventTs = undefined`
- `lastSnapshotEventTs = undefined`
- `injected = undefined`
- `autoDoneForTurnAt = undefined`
- `lastStopReason`, `lastStopReasonAt`, `lastStopText`, `lastToolSummary`, `lastToolName`, `lastActivityAt` — all reset

Safe because: (a) cleanup-on-terminal removes entries from the file before re-load, so terminal events from prior sessions can't be replayed into the wrong one; (b) the cursor advances before the file rewrite in the poller, so a crash between them re-delivers rather than drops.

---

## Gotchas (from `AGENTS.md`)

Read these in full before touching the relevant file.

- **Auto-done guard is `readEvents(art).some(ev => isTerminal(ev))`, NOT `lastEvent(art)`** (`src/subagent.ts:895-901`, AGENTS.md:56). Don't simplify to `lastEvent`.
- **`lastDeliveredEventTs` is the only poller cursor** (AGENTS.md:60). Always go through it. The new cleanup-on-terminal must NOT skip cursor advance.
- **Don't declare variables after early-return branches** (AGENTS.md project instructions). TDZ will crash at runtime.
- **`findArtifactById` security precedent at `src/subagent.ts:1073-1122`**: 5-layer defense (id regex, realpath root, readdir, statSync, realpath + isPathInside). Replicate for any new on-disk scanner (the rehydrate code doesn't scan — it reads one known path — so this only matters if you also touch `findArtifactById`).
- **`writeLaunchScript` exits 0o700**, atomic via `*.tmp + rename`. Match this pattern for `state.json`.
- **`session_shutdown` (`:2493`) currently only cancels `state.status === "running"`** at `:2510`. Don't fix this in this PR — out of scope; tracked as a follow-up. The rehydrate path makes the `idle` leak non-fatal.

---

## Work item breakdown

Three WIs, sequential commits on `fix/interactive-reload-visibility`. Each WI is self-contained: a sub-agent working on it needs only this `plan.md` plus the files it lists. Recommend dispatching in order, but WI-2 and WI-3 don't conflict on files (both add to `src/subagent.ts`, but to different ranges — re-read after WI-1 lands).

### Commit order

1. **WI-1** — helpers in `src/artifact.ts`
2. **WI-2** — spawn + terminal cleanup integration
3. **WI-3** — rehydrate on `session_start` + clean-slate unlink in `session_shutdown`

---

## WI-1 — Persist helpers in `src/artifact.ts`

**Goal**: Pure file-IO helpers, no pi runtime dependencies. Trivially testable.

**Files**: `src/artifact.ts`, `src/artifact.test.ts` (extend)

### Functions to add

In `src/artifact.ts`, after `listArtifacts` (`:204`):

```ts
import { mkdirSync } from "node:fs";
import type { MuxName } from "./multiplexer";

export interface InteractiveSubagentPersistedStateV1 {
  id: string;
  paneId: string;
  windowName?: string;
  mux: MuxName;
  muxSession?: string;
  artifactDir: string;
  sessionFile: string;
  notifyOnComplete?: "notify" | "inject";
}

export interface InteractiveSubagentStateFile {
  schemaVersion: 1;
  parent: string;
  states: { [id: string]: InteractiveSubagentPersistedStateV1 };
}

/** File path for a (cwd, sessionId) pair. Project-local. */
export function stateFilePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", `subagentura-state-${sessionId}.json`);
}

/** Read the state file for (cwd, sessionId). Returns null on missing/malformed. */
export function loadInteractiveStates(
  cwd: string,
  sessionId: string,
): InteractiveSubagentStateFile | null;

/** Atomically write the state file for (cwd, sessionId). Creates .pi/ if needed. */
export function saveInteractiveStates(
  cwd: string,
  sessionId: string,
  payload: InteractiveSubagentStateFile,
): void;

/** Convenience: load + add entry + save. Idempotent on id (overwrites). */
export function appendInteractiveState(
  cwd: string,
  sessionId: string,
  entry: InteractiveSubagentPersistedStateV1,
): void;

/** Convenience: load + remove entry by id + save (no-op if absent). */
export function removeInteractiveState(
  cwd: string,
  sessionId: string,
  id: string,
): void;
```

### Behavior

- `loadInteractiveStates`: returns null on missing file, malformed JSON, or `schemaVersion !== 1`. Returns `{ schemaVersion: 1, parent: sessionId, states: {} }` if the file exists but has no `states` key. Never throws — caught errors return null.
- `saveInteractiveStates`: mkdir `.pi/` with mode `0o700`, write `*.tmp` with mode `0o600`, `renameSync` to final path. Validate `payload.schemaVersion === 1`; throw on mismatch.
- `appendInteractiveState`: load, set `payload.states[entry.id] = entry`, save. If load returns null, write a fresh payload.
- `removeInteractiveState`: load, delete `payload.states[id]`, save. If load returns null, no-op.

### Test names (extend `src/artifact.test.ts`)

- `stateFilePath returns <cwd>/.pi/subagentura-state-<sessionId>.json`
- `saveInteractiveStates + loadInteractiveStates round-trips a state file`
- `loadInteractiveStates returns null when the file is missing`
- `loadInteractiveStates returns null when the JSON is malformed`
- `loadInteractiveStates returns null when schemaVersion is not 1`
- `saveInteractiveStates creates the .pi/ directory if missing (mode 0o700)`
- `saveInteractiveStates writes atomically (no torn writes)`
- `saveInteractiveStates rejects schemaVersion !== 1`
- `appendInteractiveState adds a new entry to an existing file`
- `appendInteractiveState creates a fresh file if none exists`
- `appendInteractiveState overwrites an entry with the same id`
- `removeInteractiveState drops the entry by id`
- `removeInteractiveState is a no-op when the entry is absent`
- `removeInteractiveState on a missing file does not throw`
- `saveInteractiveStates then loadInteractiveStates returns the same payload`
- `the saved file mode is 0o600` (cross-platform mode bits)

### Acceptance criteria

- All tests above pass.
- `npm run typecheck` clean.
- `npm run format:check` clean.
- No new imports of pi runtime modules in `artifact.ts` (helpers are pure).

---

## WI-2 — Spawn + terminal cleanup integration

**Goal**: Wire the helpers from WI-1 into the spawn path (write) and the poller's terminal-delivery path (remove).

**Files**: `src/interactive-tmux.ts`, `src/subagent.ts`, `src/subagent-launch-script.test.ts` (extend), `src/subagent-poll.test.ts` (extend)

### Changes to `src/interactive-tmux.ts`

In `launchInteractiveSubagent` at `:486-506`, add a `parentSessionId` parameter and call `appendInteractiveState` before `interactiveSubagentRegistry.set`:

```ts
export function launchInteractiveSubagent(params: {
  name: string;
  task: string;
  persona?: string;
  model?: string;
  cwd: string;
  contextText?: string | null;
  background?: boolean;
  notifyOnComplete?: "notify" | "inject";
  muxPreference?: "auto" | "tmux" | "zellij";
  /** Session id of the parent pi process — used for persistence. */
  parentSessionId: string;
}): InteractiveSubagentState {
  // ... existing code up through the state object construction at :486 ...

  const state: InteractiveSubagentState = {
    /* ... existing ... */
  };

  // NEW: persist before in-memory. Crash between these two lines is safe —
  // rehydrate on next reload will read the file and rebuild the state.
  try {
    appendInteractiveState(params.cwd, params.parentSessionId, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      muxSession: state.muxSession,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      notifyOnComplete: state.notifyOnComplete,
    });
  } catch {
    /* best effort — disk full / permission denied / etc. */
  }

  interactiveSubagentRegistry.set(id, state);
  return state;
}
```

### Changes to `src/subagent.ts`

Two changes.

**(a)** The `subagent_interactive` tool handler at `:1964-2027` — pass `parentSessionId` to `launchInteractiveSubagent`. The `ctx` object has `ctx.sessionManager.getSessionId()`:

```ts
const state = launchInteractiveSubagent({
  // ... existing params ...
  parentSessionId: ctx.sessionManager.getSessionId(), // NEW
});
```

**(b)** `pollArtifactChanges` at `:555-569` — after `state.lastDeliveredEventTs = maxTs`, if any delivered event was terminal, call `removeInteractiveState`:

```ts
if (events.length > 0) {
  let maxTs = cursor;
  let deliveredTerminal = false;
  for (const ev of events) {
    if (ev.ts > maxTs) maxTs = ev.ts;
    if (!shouldNotify(ev)) continue;
    if (ev.type === "done" || ev.type === "error" || ev.type === "cancelled") {
      deliveredTerminal = true;
    }
    if (
      state.autoDoneForTurnAt !== undefined &&
      ev.ts >= state.autoDoneForTurnAt &&
      ev.type === "done"
    )
      continue;
    deliverArtifactNotification(interactivePi, state, ev);
  }
  state.lastDeliveredEventTs = maxTs;
  // NEW: cleanup on terminal. Cursor advance first, file rewrite second.
  if (deliveredTerminal) {
    try {
      removeInteractiveState(state.cwd, state.parentSessionId, state.id);
    } catch {
      /* best effort */
    }
  }
}
```

`state.cwd` and `state.parentSessionId` are new fields on `InteractiveSubagentState` — see (c).

**(c)** Add `cwd` and `parentSessionId` to `InteractiveSubagentState` at `src/interactive-tmux.ts:107-220`:

```ts
export interface InteractiveSubagentState {
  // ... existing fields ...
  /** Parent pi session id. Used as the per-session key for persistence. */
  parentSessionId: string;
  /** cwd is already in the state (`:131`); keep using that. */
}
```

### Test names

**Extend `src/subagent-launch-script.test.ts`:**

- `launchInteractiveSubagent writes state.json next to cli.mjs in the artifact dir on spawn`
- `launchInteractiveSubagent with parentSessionId persists paneId, windowName, muxSession`
- `launchInteractiveSubagent with background: true records the correct windowName`
- `launchInteractiveSubagent with background: false records windowName = undefined`
- `launchInteractiveSubagent with mux: "zellij" records muxSession`

**Extend `src/subagent-poll.test.ts`:**

- `after poller delivers a done event, the artifact's state.json entry is removed`
- `after poller delivers an error event, the artifact's state.json entry is removed`
- `after poller delivers a cancelled event, the artifact's state.json entry is removed`
- `poller does NOT remove the state.json entry on tool_activity (only terminals)`
- `poller advances lastDeliveredEventTs before removing the entry (crash-safe ordering)`
- `if removeInteractiveState throws (e.g. disk full), the poller continues without throwing`

### Acceptance criteria

- All tests pass.
- `npm run typecheck` clean.
- `npm run format:check` clean.
- New `state.cwd` and `state.parentSessionId` fields are populated in every test fixture that constructs an `InteractiveSubagentState`.

---

## WI-3 — Rehydrate on `session_start` + clean-slate on `/new`

**Goal**: Read the persisted state file on every `session_start` and repopulate the registry. Delete the file on `session_shutdown(reason="new"|"quit")`.

**Files**: `src/subagent.ts`, new `src/subagent-rehydrate.test.ts`

### Changes to `src/subagent.ts`

**(a)** Extend the `session_start` handler at `:1184-1186`:

```ts
pi.on("session_start", (_event, ctx) => {
  g2.__piSubagenturaUi = ctx.ui;
  // NEW: rehydrate orphan interactive sub-agents from the state file.
  try {
    rehydrateInteractiveSubagents(ctx.cwd, ctx.sessionManager.getSessionId());
  } catch {
    /* best effort */
  }
});
```

**(b)** Add the `rehydrateInteractiveSubagents` function near `findArtifactById` (`:1073`):

```ts
/**
 * Read the state file for (cwd, sessionId), and for each entry reconstruct
 * an InteractiveSubagentState, set its status via deriveInteractiveSubagentStatus,
 * register it, and reset its runtime cursors. Idempotent.
 *
 * Pane-rediscovery: if `isPaneAlive(state)` returns false but the persisted
 * paneId was from a detached/relaxed spawn (windowName implies pi-subagent-<id>
 * session), re-run the discovery via the mux backend. If rediscovery fails,
 * mark status from the artifact's lastEvent via the existing fallback chain.
 */
export function rehydrateInteractiveSubagents(
  cwd: string,
  sessionId: string,
): {
  total: number;
  alive: number;
  terminal: number;
};
```

The function should:

1. Call `loadInteractiveStates(cwd, sessionId)` — if null, return `{ total: 0, alive: 0, terminal: 0 }`.
2. For each `entry` in `payload.states.values()`:
   - Build `InteractiveSubagentState` from persisted fields plus:
     - `name`, `task`, `cwd`, `model`, `startedAt`, `attachCommand`, `selectPaneCommand`, `launchScriptFile` — set to placeholders or recover from launch script if needed. For v1, placeholders are fine; document that the formatInteractiveState display will be approximate.
     - `status` = `deriveInteractiveSubagentStatus(lastEvent(art), isPaneAlive(rehydratedState))` — see `src/interactive-tmux.ts:589-599`.
     - `lastDeliveredEventTs = 0`, `lastDeliveredSessionByte = 0`, all `lastX` reset (see "Cursor reset on rehydrate" above).
   - If id already in `interactiveSubagentRegistry`, skip (idempotent).
   - Else `interactiveSubagentRegistry.set(id, state)`.
3. Return counts.

**(c)** Extend the `session_shutdown` handler at `:2493-2539` to clean-slate on `/new` and `quit`:

```ts
(pi as any).on?.("session_shutdown", (event, ctx) => {
  // ... existing cleanup (clearInterval, cancelInteractiveSubagent, registry.clear, jobRegistry.clear) ...

  // NEW: clean-slate on /new and quit. Delete the state file so rehydrate on
  // next session_start (if any) doesn't see stale entries. On :reload, keep
  // the file so rehydrate restores them.
  if ((event.reason === "new" || event.reason === "quit") && ctx?.cwd) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      fs.unlinkSync(
        path.join(
          ctx.cwd,
          ".pi",
          `subagentura-state-${ctx.sessionManager.getSessionId()}.json`,
        ),
      );
    } catch {
      /* best effort — file may not exist */
    }
  }
});
```

Use `require` here because the handler is hot-path-adjacent and already in a try/catch. Or refactor to use top-of-file imports — match the existing style. The choice is yours; just be consistent with the rest of the handler.

### Pane id rediscovery (for detached spawns)

When `isPaneAlive(state)` returns false but the persisted state was from a relaxed spawn (the `windowName` field is the human label, not the session name), we can't recover the paneId from the persisted data alone. Recovery:

1. Try `mux.listPanes({ session: "pi-subagent-<id>" })` if the backend supports it. (May need to add a method to the `Multiplexer` interface at `src/multiplexer.ts:39-155` — coordinate with whoever owns the mux layer.)
2. If that fails, fall back to marking `exited` per the artifact's `lastEvent`.

For v1, **skip the rediscovery step**. If `isPaneAlive` returns false, just mark `exited`. Document this as a known limitation — most users won't hit it because the detached session name `pi-subagent-<id>` is stable across tmux server bounces only if the user hasn't killed the server. When they do, the sub-agent is gone anyway.

### Test names (new file `src/subagent-rehydrate.test.ts`)

- `rehydrateInteractiveSubagents reads the file for (cwd, sessionId) and populates the registry`
- `rehydrateInteractiveSubagents is a no-op when the file is missing`
- `rehydrateInteractiveSubagents is a no-op when the file is malformed`
- `rehydrateInteractiveSubagents skips ids already in the registry (idempotent)`
- `rehydrateInteractiveSubagents does not throw when ctx.cwd is unreachable`
- `rehydrateInteractiveSubagents resets lastDeliveredEventTs to 0 and lastDeliveredSessionByte to 0`
- `rehydrateInteractiveSubagents resets lastInjectedEventTs, lastSnapshotEventTs, autoDoneForTurnAt to undefined`
- `rehydrateInteractiveSubagents sets status from deriveInteractiveSubagentStatus when the pane is alive`
- `rehydrateInteractiveSubagents marks exited/cancelled per lastEvent when the pane is dead`
- `rehydrateInteractiveSubagents returns { total, alive, terminal } counts correctly`
- `after rehydrate, the next poll tick replays events newer than the reset cursor`
- `after rehydrate of a live pane with no events yet, status is "running"`

**Extend `src/subagent-shutdown.test.ts`** (parallel the existing tests at `:146-180`):

- `session_shutdown with reason="new" deletes the state file for the current session`
- `session_shutdown with reason="quit" deletes the state file for the current session`
- `session_shutdown with reason="reload" KEEPS the state file (rehydrate depends on it)`
- `session_shutdown with reason="resume" KEEPS the state file`
- `session_shutdown with reason="fork" KEEPS the state file`

### Acceptance criteria

- All tests pass.
- `npm run typecheck` clean.
- `npm run format:check` clean.
- After all three WIs land: smoke test per `smoke-interactive.mjs` — spawn in tmux, `:reload`, verify the status footer returns and a follow-up message lands in the child pane.

---

## Coordination notes

- **Order**: WI-1 → WI-2 → WI-3. WI-2 and WI-3 both modify `src/subagent.ts`; merge sequentially, don't parallelize the edits.
- **Field additions**: WI-2 introduces `parentSessionId` on `InteractiveSubagentState`. Every test fixture in `src/subagent-find-artifact.test.ts`, `src/subagent-shutdown.test.ts`, `src/subagent-poll.test.ts`, `src/subagent-launch-script.test.ts` may need a `parentSessionId: "test-session"` field added — a sub-agent should grep for `InteractiveSubagentState` literals and update them.
- **Imports**: `src/artifact.ts` should not import `MuxName` from `./multiplexer` in a circular way. Check the import direction first.
- **Test fixture hygiene**: All test fixtures that construct an `InteractiveSubagentState` literal will need `parentSessionId` after WI-2 lands. Run `npm run typecheck` after WI-2 lands and fix any literal that fails.
- **Smoke test**: After WI-3 lands, run `npm run smoke:interactive` (or whatever the project uses — see `smoke-interactive.mjs`).

## Verification after each WI

```bash
npm run typecheck
npm test
npm run format:check
```

All three must pass. If `npm run format:check` fails, run `npx prettier --write <files>` and re-stage.

---

## Open follow-ups (out of scope for this PR)

Documented but not implemented:

- **`idle` orphan leak in `session_shutdown`** (`src/subagent.ts:2510`). Trivial fix: extend the guard to `running || idle`. After this PR lands, the leak is non-fatal because rehydrate recovers, but it's still a cleanup gap.
- **`findArtifactById` default-root mismatch** with `defaultSessionRoot` (`src/interactive-tmux.ts:260-264` vs `src/subagent.ts:1082`). The two compute the same root with slightly different code paths; consolidate before adding a third consumer.
- **Pane-id rediscovery for detached spawns after mux server bounce.** Listed above; punted to v2.
- **`list_subagent_artifacts` disk scan** for past-session orphans. Separate fix; the description at `src/subagent.ts:2315` currently advertises more than the impl delivers.

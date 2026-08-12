/**
 * Zellij backend for the `Multiplexer` interface.
 *
 * Implements the eight methods defined by `Multiplexer` using the zellij v0.44
 * CLI. Verified against zellij 0.44.3.
 *
 * Pane IDs: `zellij action new-pane` prints `terminal_<n>` / `plugin_<n>` on
 * stdout, but `action list-panes --json` reports the bare integer `<n>` in its
 * `id` field, and every `--pane-id` flag accepts the bare integer too. To keep
 * one canonical form everywhere we normalize to the bare integer string the
 * moment a pane id enters our hands (`normalizePaneId`). This is what makes the
 * visible-split path's liveness probe work — without it `getPaneLiveness` would
 * compare `"terminal_5"` against `"5"` and always report dead.
 *
 * Session targeting: zellij addresses every `action` at a specific session via
 * `--session <name>`. The session a pane lives in is NOT stored on the backend
 * instance (the resolver hands out a single cached instance, so per-spawn state
 * on it would be clobbered by the next spawn). Instead `createPane` RETURNS the
 * session name; the orchestrator persists it on `InteractiveSubagentState.muxSession`
 * and threads it back into every later op as the trailing `session` argument.
 *
 * Two code paths:
 *   1. Parent process is inside a zellij session (`ZELLIJ` env var set):
 *      operations run against `ZELLIJ_SESSION_NAME`.
 *   2. Parent process is NOT inside a zellij session: a background session is
 *      created (`zellij attach --create-background <name>`) and every command
 *      targets it via `--session <name>`.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type {
  CapturePaneOptions,
  CapturePaneResult,
  Multiplexer,
  PaneLiveness,
  PaneRef,
} from "./multiplexer";
import {
  boundCaptureOutput,
  commandExists,
  execMuxOrThrow,
  MUX_CAPABILITIES,
  safeSegment,
  sanitizeViewerTitle,
  shellEscape,
  spawnNativeViewer,
} from "./multiplexer";

/**
 * Normalize a zellij pane id to the bare-integer string form used by
 * `list-panes --json` (`id`) and accepted by every `--pane-id` flag.
 * `new-pane` emits `terminal_5` / `plugin_2`; strip that prefix so the id
 * round-trips through `getPaneLiveness` / `sendKeys` / `killPane`.
 */
function normalizePaneId(raw: string): string {
  return raw.trim().replace(/^(?:terminal_|plugin_)/, "");
}

interface ZellijPaneRow {
  readonly id: number | string;
  readonly is_plugin?: boolean;
  readonly exited?: boolean;
  readonly tab_name?: string;
}

function parsePaneListing(output: string): ZellijPaneRow[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("Malformed zellij pane listing");
  }
  for (const row of parsed) {
    if (row === null || typeof row !== "object") {
      throw new Error("Malformed zellij pane listing row");
    }
    const pane = row as Record<string, unknown>;
    const validId =
      (typeof pane.id === "number" &&
        Number.isInteger(pane.id) &&
        pane.id >= 0) ||
      (typeof pane.id === "string" && /^\d+$/.test(pane.id));
    if (
      !validId ||
      (pane.is_plugin !== undefined && typeof pane.is_plugin !== "boolean") ||
      (pane.exited !== undefined && typeof pane.exited !== "boolean") ||
      (pane.tab_name !== undefined && typeof pane.tab_name !== "string")
    ) {
      throw new Error("Malformed zellij pane listing row");
    }
  }
  return parsed as ZellijPaneRow[];
}

class BoundedByteTail {
  readonly #storage: Buffer;
  #start = 0;
  #length = 0;
  truncated = false;

  constructor(capacity: number) {
    this.#storage = Buffer.allocUnsafe(capacity);
  }

  append(chunk: Buffer | string): void {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const capacity = this.#storage.length;
    if (input.length === 0) return;
    if (capacity === 0) {
      this.truncated = true;
      return;
    }
    if (input.length >= capacity) {
      this.truncated ||= this.#length > 0 || input.length > capacity;
      input.copy(this.#storage, 0, input.length - capacity);
      this.#start = 0;
      this.#length = capacity;
      return;
    }
    const overflow = Math.max(0, this.#length + input.length - capacity);
    if (overflow > 0) {
      this.#start = (this.#start + overflow) % capacity;
      this.#length -= overflow;
      this.truncated = true;
    }
    const writeAt = (this.#start + this.#length) % capacity;
    const firstLength = Math.min(input.length, capacity - writeAt);
    input.copy(this.#storage, writeAt, 0, firstLength);
    if (firstLength < input.length) {
      input.copy(this.#storage, 0, firstLength);
    }
    this.#length += input.length;
  }

  toBuffer(): Buffer {
    if (this.#length === 0) return Buffer.alloc(0);
    if (this.#start + this.#length <= this.#storage.length) {
      return Buffer.from(
        this.#storage.subarray(this.#start, this.#start + this.#length),
      );
    }
    const first = this.#storage.subarray(this.#start);
    return Buffer.concat([
      first,
      this.#storage.subarray(0, this.#length - first.length),
    ]);
  }
}

export class ZellijMultiplexer implements Multiplexer {
  readonly name = "zellij" as const;
  readonly capabilities = MUX_CAPABILITIES.zellij;

  /**
   * True iff `zellij` is on PATH. Binary-only — symmetric with
   * `TmuxMultiplexer.isAvailable()`. The "am I inside a zellij session"
   * heuristic (`ZELLIJ` / `ZELLIJ_SESSION_NAME`) lives in `getMux()`'s
   * auto-resolution, NOT here, so the relaxed-spawn fallback in `getMux()`
   * can select zellij from a plain terminal (it creates a detached session
   * in `createPane`). Previously this also required `ZELLIJ === "0"`, which
   * made zellij unreachable via `preference: "auto"` outside a session.
   */
  isAvailable(): boolean {
    return commandExists("zellij");
  }

  /**
   * Build the `--session <name>` argv prefix, or `[]` when no session is
   * known (operate on the current/attached session).
   */
  private sessionFlag(session?: string): string[] {
    return session ? ["--session", session] : [];
  }

  /**
   * Create a pane for the child process.
   *
   * When the parent is in zellij (the common case):
   *   - background: true  → `new-tab -n <name>` in the current session
   *   - background: false → `new-pane --direction right --close-on-exit`
   *
   * When the parent is NOT in zellij (the relaxed spawn path), creates a
   * brand-new detached session named `pi-subagent-<id>` first, then creates
   * the pane/tab inside it.
   *
   * Returns the session the pane lives in so the caller can address it later.
   */
  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    id?: string;
  }): { paneId: string; windowName?: string; session?: string } {
    if (!commandExists("zellij")) {
      throw new Error(
        "zellij is not available. Install zellij or set PATH to include it.",
      );
    }

    let windowName: string | undefined;
    const isInZellij = !!process.env.ZELLIJ;

    let session: string;
    if (!isInZellij) {
      // Relaxed path: parent not in zellij. Create a background session.
      session = `pi-subagent-${opts.id ?? safeSegment(opts.name)}`;
      execMuxOrThrow(
        "zellij",
        "attach --create-background",
        "zellij",
        ["attach", "--create-background", session],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
    } else {
      session = process.env.ZELLIJ_SESSION_NAME ?? "";
    }

    const sessionFlag = this.sessionFlag(session);

    // A visible side-by-side split only works when a client is attached to
    // the session: in a detached session zellij doesn't materialize the new
    // pane (it never shows up in `list-panes`). When the parent isn't in
    // zellij we have no attached client, so force background (new-tab) mode
    // — matching how the tmux backend treats its relaxed path. `new-tab`
    // panes are tracked in detached sessions; `new-pane` panes are not.
    const useBackground = opts.background || !isInZellij;

    // Snapshot panes before creating, so we can identify the new pane by
    // diffing afterwards. Neither `new-tab` nor `new-pane` gives us an id
    // that round-trips against `list-panes` (new-pane prints a `terminal_N`
    // counter that is distinct from the `id` field every other op compares
    // against), so the diff is the canonical way to recover the pane id.
    const panesBefore = this.listPanes(session);

    if (useBackground) {
      windowName = opts.windowName ?? safeSegment(opts.name);
      // Save the current active tab position before creating the new tab,
      // so we can switch back afterwards. zellij's new-tab always focuses
      // the new tab; we want to leave focus on the parent's tab (matching
      // tmux's -d flag behavior for detached windows).
      let previousTabPosition: number | undefined;
      if (isInZellij) {
        try {
          previousTabPosition = this.currentTabPosition(sessionFlag);
        } catch {
          // Best effort — if we can't get the current tab, we'll still
          // create the new tab, just won't restore focus.
        }
      }
      execMuxOrThrow(
        "zellij",
        "new-tab",
        "zellij",
        [...sessionFlag, "action", "new-tab", "--name", windowName],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
      // Restore focus to the previous tab if we saved its position.
      if (previousTabPosition !== undefined) {
        try {
          execFileSync(
            "zellij",
            [
              ...sessionFlag,
              "action",
              "go-to-tab",
              String(previousTabPosition),
            ],
            { encoding: "utf8", timeout: 3000 },
          );
        } catch {
          // Best effort — cosmetic only.
        }
      }
    } else {
      // Visible split — side-by-side with the focused pane. zellij splits
      // relative to the currently-focused pane; there is no flag to split
      // from a specific pane id (`new-pane` has no `--in-pane-id`), so
      // `opts.parentPane` is intentionally ignored. No `--close-on-exit`:
      // that flag makes a trailing `<COMMAND>` mandatory, and we want a
      // plain shell pane that outlives the launch script (like tmux's split).
      execMuxOrThrow(
        "zellij",
        "new-pane",
        "zellij",
        [...sessionFlag, "action", "new-pane", "--direction", "right"],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
    }

    // Ignore plugin panes (the tab-bar / status-bar / link plugins zellij
    // spawns) on BOTH sides of the diff — only a real terminal pane can host
    // the child shell, and plugin ids live in a separate namespace that shares
    // integers with terminal ids (see `paneRowMatches`). Keeping plugin ids in
    // `beforeIds` would mask a genuinely new terminal pane whose integer
    // happens to match an existing plugin pane.
    const terminalsAfter = this.listPanes(session).filter((p) => !p.is_plugin);
    const beforeIds = new Set(
      panesBefore.filter((p) => !p.is_plugin).map((p) => String(p.id)),
    );
    const newPanes = terminalsAfter.filter((p) => !beforeIds.has(String(p.id)));
    const chosen = newPanes[0] ?? terminalsAfter[0];
    const paneId = chosen ? normalizePaneId(String(chosen.id)) : "";
    if (!paneId) {
      throw new Error("Failed to determine pane ID after creating pane");
    }

    return { paneId, windowName, session: session || undefined };
  }

  /**
   * Locate durable workflow panes by their deterministic tab name.
   *
   * Zellij pane ids are only session-local, so recovery must enumerate every
   * active session and retain the session with each match. A listing failure is
   * not an empty result: callers use this method to decide whether retrying can
   * safely create another pane, so ambiguity must abort recovery instead.
   */
  findPanesByWindowName(windowName: string): readonly PaneRef[] {
    let sessionsOutput: string;
    try {
      sessionsOutput = execFileSync(
        "zellij",
        ["list-sessions", "--short", "--no-formatting"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("No active zellij sessions found")
      ) {
        return [];
      }
      throw new Error("Failed to enumerate zellij sessions for pane recovery", {
        cause: error,
      });
    }

    const sessions = sessionsOutput
      .split("\n")
      .map((session) => session.trim())
      .filter((session) => session.length > 0);
    const matches: PaneRef[] = [];
    for (const session of sessions) {
      let output: string;
      try {
        output = execFileSync(
          "zellij",
          [...this.sessionFlag(session), "action", "list-panes", "--json"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
          },
        );
      } catch (error) {
        throw new Error(
          `Failed to enumerate zellij panes in session ${session}`,
          { cause: error },
        );
      }
      for (const pane of parsePaneListing(output)) {
        if (
          pane.tab_name !== windowName ||
          pane.is_plugin ||
          pane.exited === true
        ) {
          continue;
        }
        matches.push({
          paneId: normalizePaneId(String(pane.id)),
          windowName,
          session,
        });
      }
    }
    return matches;
  }

  /**
   * Read the focused tab's position so `createPane` can restore focus after
   * `new-tab` steals it.
   *
   * `action current-tab-info --json` (verified present in zellij 0.44.3) emits a
   * full `TabInfo` object with a numeric `position`; the default text form emits
   * `name: … / id: … / position: N`. We prefer JSON and keep the text regex as a
   * fallback for zellij builds without `--json`.
   *
   * Returns `undefined` when there is no focused tab to restore — notably when a
   * floating/plugin pane holds focus, where zellij answers
   * `No active tab found for current client` on stdout with exit 0 rather than
   * failing, so a parse miss (not an exception) is the signal.
   */
  private currentTabPosition(sessionFlag: string[]): number | undefined {
    const output = execFileSync(
      "zellij",
      [...sessionFlag, "action", "current-tab-info", "--json"],
      { encoding: "utf8", timeout: 3000 },
    );
    try {
      const parsed = JSON.parse(output) as { position?: unknown };
      if (typeof parsed.position === "number") return parsed.position;
    } catch {
      // Not JSON (older zellij, or the "no active tab" text response).
    }
    const positionMatch = output.match(/^position:\s*(\d+)/m);
    return positionMatch ? parseInt(positionMatch[1], 10) : undefined;
  }

  /** Run `list-panes --json` against a session, returning [] on any failure. */
  private listPanes(session?: string): ZellijPaneRow[] {
    try {
      const output = execFileSync(
        "zellij",
        [...this.sessionFlag(session), "action", "list-panes", "--json"],
        { encoding: "utf8", timeout: 5000 },
      );
      return parsePaneListing(output);
    } catch {
      return [];
    }
  }

  /**
   * Match a `list-panes --json` row against a pane id we hold.
   *
   * Plugin panes MUST be excluded, not merely deprioritized: zellij numbers
   * `terminal_N` and `plugin_N` in SEPARATE namespaces, and `normalizePaneId`
   * strips the prefix, so the two collapse onto the same integer. Verified
   * against zellij 0.44.3 — a fresh session lists a `zellij:link` plugin pane
   * with `id: 0` alongside the shell's terminal pane, also `id: 0`. Matching on
   * the bare integer therefore reported a closed sub-agent pane as still alive
   * (the plugin pane kept answering for it), which would make the artifact
   * poller believe a finished child was running forever. Our pane is always a
   * terminal pane: `createPane` only ever selects `!is_plugin`.
   */
  private paneRowMatches(pane: ZellijPaneRow, target: string): boolean {
    return (
      !pane.is_plugin && String(pane.id) === target && pane.exited !== true
    );
  }

  /**
   * Probe pane liveness from a complete backend pane listing. Backend and parse
   * failures are `unknown`, distinct from a successful listing without the pane.
   */
  getPaneLiveness(paneId: string, session?: string): PaneLiveness {
    const target = normalizePaneId(paneId);
    if (!/^\d+$/.test(target)) return "unknown";
    try {
      const output = execFileSync(
        "zellij",
        [...this.sessionFlag(session), "action", "list-panes", "--json"],
        { encoding: "utf8", timeout: 5000 },
      );
      return parsePaneListing(output).some((pane) =>
        this.paneRowMatches(pane, target),
      )
        ? "alive"
        : "dead";
    } catch {
      return "unknown";
    }
  }

  getPaneLivenessAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLiveness> {
    const target = normalizePaneId(paneId);
    if (!/^\d+$/.test(target)) return Promise.resolve("unknown");
    return new Promise((resolve) => {
      try {
        execFile(
          "zellij",
          [...this.sessionFlag(session), "action", "list-panes", "--json"],
          { encoding: "utf8", timeout: 5000 },
          (error, stdout) => {
            if (error) {
              resolve("unknown");
              return;
            }
            try {
              resolve(
                parsePaneListing(stdout).some((pane) =>
                  this.paneRowMatches(pane, target),
                )
                  ? "alive"
                  : "dead",
              );
            } catch {
              resolve("unknown");
            }
          },
        );
      } catch {
        resolve("unknown");
      }
    });
  }

  /**
   * Send literal text to the pane's shell input buffer, character by
   * character. Does NOT submit (no Enter).
   */
  sendKeys(paneId: string, text: string, session?: string): void {
    execMuxOrThrow(
      "zellij",
      "write-chars",
      "zellij",
      [
        ...this.sessionFlag(session),
        "action",
        "write-chars",
        "--pane-id",
        normalizePaneId(paneId),
        // `--` terminates flag parsing. Follow-up text is user/model controlled;
        // starting it with `-` otherwise fails the whole command (zellij's own
        // error even suggests the fix: "use `-- -n`").
        "--",
        text,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  /**
   * Send a single Enter / Return key to the pane (decimal 13 = Enter key).
   */
  sendEnter(paneId: string, session?: string): void {
    execMuxOrThrow(
      "zellij",
      "write 13",
      "zellij",
      [
        ...this.sessionFlag(session),
        "action",
        "write",
        "--pane-id",
        normalizePaneId(paneId),
        // Symmetric with sendKeys; `13` needs no protection itself, but the
        // terminator keeps the two write paths shaped identically.
        "--",
        "13",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  /**
   * Kill the pane. Best-effort — no throw on already-dead panes.
   */
  killPane(paneId: string, session?: string): void {
    try {
      execFileSync(
        "zellij",
        [
          ...this.sessionFlag(session),
          "action",
          "close-pane",
          "--pane-id",
          normalizePaneId(paneId),
        ],
        { stdio: "ignore", timeout: 5000 },
      );
    } catch {
      // Best effort — pane may already be dead.
    }
  }

  focusPane(ref: PaneRef): Promise<void> {
    return new Promise((resolve, reject) => {
      const focusArgs = ref.windowName
        ? [
            ...this.sessionFlag(ref.session),
            "action",
            "go-to-tab-name",
            ref.windowName,
          ]
        : [
            ...this.sessionFlag(ref.session),
            "action",
            "focus-pane-id",
            normalizePaneId(ref.paneId),
          ];
      execFile("zellij", focusArgs, { timeout: 5000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * Capture bounded pane output via streaming `action dump-screen --full`.
   *
   * Zellij has no server-side line bound, so stdout is consumed as raw bytes
   * into a tail ring sized from `maxBytes`. The full dump is never accumulated,
   * and UTF-8 decoding happens only after the process closes and a leading
   * partial code point has been skipped.
   */
  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    return new Promise((resolve, reject) => {
      const maxBytes = Number.isFinite(opts.maxBytes)
        ? Math.max(0, Math.floor(opts.maxBytes))
        : 0;
      const stdoutTail = new BoundedByteTail(maxBytes);
      const stderrTail = new BoundedByteTail(8192);
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let child: ChildProcess;
      try {
        child = spawn(
          "zellij",
          [
            ...this.sessionFlag(ref.session),
            "action",
            "dump-screen",
            "--full",
            "--pane-id",
            normalizePaneId(ref.paneId),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        reject(error);
        return;
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutTail.append(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrTail.append(chunk);
      });

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        forceKillTimer.unref();
        reject(new Error("[zellij] dump-screen timed out"));
      }, 5000);
      timeout.unref();

      child.once("error", (error) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const stderr = stderrTail.toBuffer().toString("utf8").trim();
          const detail = stderr ? `: ${stderr}` : signal ? ` (${signal})` : "";
          reject(new Error(`[zellij] dump-screen failed${detail}`));
          return;
        }

        const raw = stdoutTail.toBuffer();
        let utf8Start = 0;
        while (utf8Start < raw.length && (raw[utf8Start]! & 0xc0) === 0x80) {
          utf8Start++;
        }
        const bounded = boundCaptureOutput(
          raw.subarray(utf8Start).toString("utf8"),
          opts,
        );
        resolve({
          output: bounded.output,
          truncated: stdoutTail.truncated || utf8Start > 0 || bounded.truncated,
        });
      });
    });
  }

  /**
   * Whether a client is attached to `session`.
   *
   * Deliberately resolves `undefined` — "cannot determine" — for any session
   * that is still alive. zellij's `list-sessions` reports creation age and an
   * `EXITED` marker but says nothing about attachment: a background session
   * nobody has ever attached to prints exactly the same line as an attached one
   * (verified against 0.44.3 — `zellij attach --create-background <n>` then
   * `list-sessions --no-formatting` yields `<n> [Created 1s ago]`, with no
   * marker to test). Guessing here would make the supervisor warn "not attached"
   * at random, which is worse than staying quiet, so the consumer's
   * feature-detection path is left to no-op on this backend.
   *
   * A session that is gone or `EXITED` is the one case we can answer: it
   * definitively has no attached client, so that resolves `false`.
   */
  hasAttachedClientAsync(session?: string): Promise<boolean | undefined> {
    if (!session) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      try {
        execFile(
          "zellij",
          ["list-sessions", "--no-formatting"],
          { encoding: "utf8", timeout: 5000 },
          (error, stdout) => {
            if (error) {
              resolve(undefined);
              return;
            }
            const line = stdout
              .split("\n")
              .find((row) => row.trim().startsWith(`${session} `));
            // Absent or explicitly exited ⇒ certainly unattached.
            if (!line || line.includes("EXITED")) {
              resolve(false);
              return;
            }
            resolve(undefined);
          },
        );
      } catch {
        resolve(undefined);
      }
    });
  }

  /**
   * Open the bounded supervisor content in a floating zellij pane.
   *
   * Kept behaviourally identical to the tmux twin: spawn asynchronously, resolve
   * `true` once the overlay survives the spawn grace window, resolve `false`
   * when zellij rejects the request. Previously this was a synchronous
   * fire-and-forget that returned `true` unconditionally while the tmux twin
   * blocked the event loop — same interface, opposite behaviour.
   *
   * `--name` is not a format context in zellij (verified: a `#(...)` pane name
   * executes nothing), but it is still untrusted text in an argv slot: a name
   * beginning with `-` makes zellij's clap parser reject the whole command
   * (`Found argument '-r' which wasn't expected`). `sanitizeViewerTitle` handles
   * that along with the tmux format hazard, so both backends sanitize alike.
   */
  showNativeViewer(title: string, content: string): Promise<boolean> {
    if (!process.env.ZELLIJ) return Promise.resolve(false);
    const command = `printf '%s\\n' ${shellEscape(content)}; printf '\\nPress Enter to close'; read _`;
    return spawnNativeViewer("zellij", [
      ...this.sessionFlag(process.env.ZELLIJ_SESSION_NAME),
      "action",
      "new-pane",
      "--floating",
      "--name",
      sanitizeViewerTitle(title),
      "--",
      "sh",
      "-lc",
      command,
    ]);
  }

  /**
   * Build the user-facing commands to attach to (or focus) the child's pane.
   *
   * Two forms:
   *   - `attachCommand`: works from a plain shell — attaches to the zellij
   *     session.
   *   - `focusCommand`: works from inside the same zellij session — goes to
   *     the tab (background mode) or focuses the pane by id (split mode).
   *
   * Session name comes from the `session` returned by `createPane` (threaded
   * through by the caller), falling back to `ZELLIJ_SESSION_NAME` for an
   * in-session spawn.
   */
  buildAttachCommands(opts: {
    paneId: string;
    windowName?: string;
    session?: string;
  }): {
    attachCommand: string;
    focusCommand: string;
  } {
    const sessionName = opts.session || process.env.ZELLIJ_SESSION_NAME || "";
    const escapedSession = shellEscape(sessionName);

    if (opts.windowName) {
      // Background mode: pane lives in a named tab.
      return {
        attachCommand: `zellij attach ${escapedSession}`,
        focusCommand: `zellij action go-to-tab-name ${shellEscape(opts.windowName)}`,
      };
    }

    // Visible split: focus by pane id. The zellij action is `focus-pane-id`
    // (there is no `focus-pane`), and it takes the bare pane id as a
    // positional argument. No `\;` chaining — that's tmux-only syntax.
    return {
      attachCommand: `zellij attach ${escapedSession}`,
      focusCommand: `zellij action focus-pane-id ${shellEscape(normalizePaneId(opts.paneId))}`,
    };
  }
}

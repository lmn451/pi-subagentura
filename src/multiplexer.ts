/**
 * Multiplexer abstraction for interactive sub-agents.
 *
 * The package originally targeted tmux exclusively — every pane operation was a
 * hard-coded `tmux ...` exec call. PR #1 (this refactor) extracts those calls
 * behind a `Multiplexer` interface so a second backend (zellij) can be added
 * without touching the call sites in `subagent.ts`. PR #2 ships the zellij
 * implementation behind the same interface.
 *
 * Backends that participate MUST:
 *   - implement the 8 methods below with the documented semantics;
 *   - stringify any internal numeric pane id to match `paneId: string` on
 *     `InteractiveSubagentState`;
 *   - be safe to instantiate cheaply (the resolver holds a long-lived instance
 *     per backend so `isAvailable()` can be probed during resolution).
 *
 * Resolution order (`getMux`):
 *   1. Explicit `preference` arg from the tool (forces tmux or zellij).
 *   2. Auto-detect: prefer the mux already attached to the parent process
 *      (env var heuristic: ZELLIJ_SESSION_NAME, then TMUX).
 *   3. Fall back to whichever backend has a binary + active server, tmux first
 *      for backward compatibility.
 *   4. Throw with a setup hint pointing at both backends.
 */

import { execFileSync, type ExecSyncOptions } from "node:child_process";
import { TmuxMultiplexer } from "./multiplexer-tmux";
import { ZellijMultiplexer } from "./multiplexer-zellij";

/** Names of the supported multiplexer backends. Kept narrow on purpose. */
export type MuxName = "tmux" | "zellij";

/**
 * Per-spawn state about how a child pane was created. The state is set on
 * `InteractiveSubagentState.mux` at spawn time and never changes — all later
 * operations on the child (send-keys, kill, attach, focus) route through the
 * same backend that created it.
 */
export interface Multiplexer {
  readonly name: MuxName;

  /**
   * True iff this backend's binary is on PATH AND a server is currently
   * running that we can attach to / create panes in. Used by the resolver
   * and by the `subagent_interactive` tool's preflight check.
   *
   * MUST be cheap (no network, no prompt). Implementations are expected to
   * probe the env var + run a single `display-message` / `list-sessions`
   * equivalent with a short timeout.
   */
  isAvailable(): boolean;

  /**
   * Create a new pane for the child process.
   *
   * @param opts.name          Display name for the pane (used as tmux window
   *                           name in background mode, or as the zellij pane
   *                           name). Safe-segmented by the caller.
   * @param opts.cwd           Working directory for the spawned shell.
   * @param opts.background    true = invisible (new detached window/tab);
   *                           false = visible side-by-side split of the
   *                           parent pane (parent must be attached to a mux
   *                           session for the split mode to work — callers
   *                           should fall back to background when the parent
   *                           is not in a session).
   * @param opts.parentPane    Parent pane id for split mode. Required when
   *                           `background === false`. Ignored otherwise.
   * @param opts.windowName    Optional explicit name for the detached
   *                           window/tab. Backends are free to ignore this
   *                           and generate their own (zellij requires unique
   *                           tab names per session).
   * @returns paneId           String id usable in subsequent `sendKeys` /
   *                           `isPaneAlive` / `killPane` calls. The string
   *                           format is backend-specific (tmux uses `%N`,
   *                           zellij uses `terminal_N` or just an integer
   *                           stringified).
   * @returns windowName       The actual window/tab name used (for
   *                           `attachCommand` formatting). Always defined
   *                           for background mode, undefined for visible
   *                           split mode (the pane lives in the same window
   *                           as the parent).
   */
  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    /** Unique id (8 hex) for naming the new session when parent is not in a mux. */
    id?: string;
  }): { paneId: string; windowName?: string; session?: string };

  /**
   * Probe whether the pane is still alive (the backend still knows about
   * it). MUST NOT throw — return false on any failure (dead pane, backend
   * down, pane id malformed). Used by the artifact poller on every tick.
   *
   * @param session  The session returned by `createPane`. zellij needs it to
   *                 target the right server; tmux ignores it (pane ids are
   *                 server-global).
   */
  isPaneAlive(paneId: string, session?: string): boolean;

  /**
   * Send literal text to the pane's shell input buffer, character-by-character.
   * Does NOT submit (no Enter). Callers that want to submit pair this with
   * a second call to `sendEnter`.
   *
   * The text may contain newlines (used by the launch script template);
   * backends are expected to deliver them verbatim.
   *
   * @param session  The session returned by `createPane` (zellij needs it;
   *                 tmux ignores it).
   */
  sendKeys(paneId: string, text: string, session?: string): void;

  /**
   * Send a single Enter / Return key to the pane, submitting whatever is
   * in the input buffer. Kept separate from `sendKeys` because the encoding
   * differs (tmux uses a key name, zellij uses a byte value).
   *
   * @param session  The session returned by `createPane` (zellij needs it;
   *                 tmux ignores it).
   */
  sendEnter(paneId: string, session?: string): void;

  /**
   * Kill the pane. MUST be best-effort: no throw on already-dead panes.
   * Used by the cancel path and the orphan-pane guard.
   *
   * @param session  The session returned by `createPane` (zellij needs it;
   *                 tmux ignores it).
   */
  killPane(paneId: string, session?: string): void;

  /**
   * Build the user-facing commands to attach to (or focus) the child's pane.
   *
   * Two forms are returned because the UX differs based on whether the user
   * is currently inside a mux session:
   *   - `attachCommand` works from a plain shell (`tmux attach -t <sess>`
   *     or `zellij attach <sess>`). Falls back to a `switch-client` style
   *     command when run from inside an existing session.
   *   - `focusCommand` works from inside the same mux session (`select-window`
   *     / `go-to-tab-name`). No-op if the user is not attached.
   *
   * Both strings are intended to be copy-pasted into a terminal by the user
   * — they should be safe to display verbatim and survive a paste into any
   * shell (no quoting required by the caller).
   */
  buildAttachCommands(opts: {
    paneId: string;
    windowName?: string;
    session?: string;
  }): {
    attachCommand: string;
    focusCommand: string;
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resolver
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GetMuxOptions {
  /**
   * Explicit backend choice. `'auto'` (the default) walks the env-var +
   * availability chain described in the file header.
   */
  preference?: MuxName | "auto";
}

export class NoMultiplexerAvailableError extends Error {
  constructor() {
    super(
      "No multiplexer available. Start pi inside tmux or zellij, " +
        "for example: tmux new -A -s pi 'pi'  —  or install one of them and ensure a server is running.",
    );
    this.name = "NoMultiplexerAvailableError";
  }
}

/**
 * Resolve a multiplexer instance.
 *
 * Returns a long-lived `Multiplexer` — implementations are stateless after
 * construction (the resolver holds one per backend so the env-var probe is
 * paid once per process). Callers may cache the result, but `getMux` itself
 * is cheap on the hot path because it just looks up the cached instance.
 */
export function getMux(opts: GetMuxOptions = {}): Multiplexer {
  const tmux = getOrCreate("tmux", () => new TmuxMultiplexer());
  const zellij = getOrCreate("zellij", () => new ZellijMultiplexer());

  const preference = opts.preference ?? "auto";
  if (preference === "tmux") return tmux;
  if (preference === "zellij") return zellij;

  // Auto: prefer the mux already attached to this process. We check env vars
  // (cheap) before probing availability (one exec call each). If both env
  // vars are set (e.g., nested sessions — exotic but possible), zellij wins
  // (it's the more specific signal — ZELLIJ_SESSION_NAME is a single session
  // name, TMUX can be inherited through nested tmux-in-tmux shells).
  if (process.env.ZELLIJ_SESSION_NAME && zellij.isAvailable()) return zellij;
  if (process.env.TMUX && tmux.isAvailable()) return tmux;

  // Neither env var matched. Fall back to whichever backend is available;
  // tmux first to preserve existing user setups that rely on `tmux` being
  // on PATH even when the parent isn't attached.
  if (tmux.isAvailable()) return tmux;
  if (zellij.isAvailable()) return zellij;

  throw new NoMultiplexerAvailableError();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Internal: instance cache + test seams
 * ──────────────────────────────────────────────────────────────────────────── */

const instances = new Map<MuxName, Multiplexer>();

function getOrCreate(name: MuxName, factory: () => Multiplexer): Multiplexer {
  let inst = instances.get(name);
  if (!inst) {
    inst = factory();
    instances.set(name, inst);
  }
  return inst;
}

/** Test seam: replace the cached tmux backend. Pass `undefined` to restore. */
export function __setTmuxMultiplexer(impl: Multiplexer | undefined): void {
  if (impl) instances.set("tmux", impl);
  else instances.delete("tmux");
}

/** Test seam: replace the cached zellij backend. Pass `undefined` to restore. */
export function __setZellijMultiplexer(impl: Multiplexer | undefined): void {
  if (impl) instances.set("zellij", impl);
  else instances.delete("zellij");
}

/** Test seam: clear all cached backend instances (forces re-instantiation). */
export function __resetMuxInstances(): void {
  instances.clear();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers shared by both backends
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Test whether a binary is on PATH. Used by both backends' `isAvailable`.
 * Cheap (one sh -c exec); safe to call repeatedly. The 5s timeout guards
 * against a hung PATH (e.g., NFS hang) blocking the agent's startup probe.
 */
export function commandExists(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-lc", `command -v ${shellEscape(command)}`], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** POSIX-style single-quote escape. Safe for paths, names, and command args. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Execute a mux command with improved error diagnostics.
 *
 * On failure, re-throws a new `Error` with the mux name, operation context,
 * and relevant stderr/stdout/exit-status details from the underlying exec
 * failure. The original error is preserved as `cause`.
 *
 * @param muxName   Backend name ("tmux" or "zellij") — identifies the tool in the error.
 * @param operation Human-readable description (e.g. "new-window", "send-keys").
 * @param cmd       The command binary (e.g. "tmux", "zellij").
 * @param args      Command arguments (passed through to execFileSync).
 * @param options   execFileSync options (e.g. `{ encoding: "utf8", timeout: 5000 }`).
 * @returns The stdout as a string.
 */
export function execMuxOrThrow(
  muxName: string,
  operation: string,
  cmd: string,
  args: readonly string[],
  options: ExecSyncOptions,
): string {
  try {
    const result = execFileSync(cmd, args, options);
    return typeof result === "string" ? result : result.toString();
  } catch (err) {
    const execErr = err as Error & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number;
    };
    const details: string[] = [];
    if (execErr.status != null) {
      details.push(`exit code ${execErr.status}`);
    }
    const stderrStr =
      execErr.stderr != null ? String(execErr.stderr).trim() : "";
    if (stderrStr) {
      details.push(`stderr: ${stderrStr}`);
    }
    const stdoutStr =
      execErr.stdout != null ? String(execErr.stdout).trim() : "";
    if (stdoutStr && stdoutStr.length <= 200) {
      details.push(`stdout: ${stdoutStr}`);
    } else if (stdoutStr) {
      details.push(`stdout: <${stdoutStr.length} bytes>`);
    }
    const suffix = details.length > 0 ? ": " + details.join(", ") : "";
    throw new Error(`[${muxName}] ${operation} failed${suffix}`, {
      cause: err,
    });
  }
}

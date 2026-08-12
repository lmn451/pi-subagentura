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

import { execFileSync, spawn, type ExecSyncOptions } from "node:child_process";
import { TmuxMultiplexer } from "./multiplexer-tmux";
import { ZellijMultiplexer } from "./multiplexer-zellij";
import { assertNever } from "./artifact";

/** Names of the supported multiplexer backends. Kept narrow on purpose. */
export type MuxName = "tmux" | "zellij";
/** Result of a backend pane-listing liveness probe. */
export type PaneLiveness = "alive" | "dead" | "unknown";

/** Backend-neutral structured reference to a durable mux pane. */
export interface PaneRef {
  readonly paneId: string;
  readonly windowName?: string;
  readonly session?: string;
}

/**
 * Optional transport features supported by a multiplexer backend.
 *
 * `structuredFocus` — `focusPane(ref)` can reach the referenced pane from a
 *   `PaneRef` alone, without asking the user to paste a command.
 * `boundedCapture` — `capturePane(ref, opts)` returns the pane's text, bounded
 *   by `maxLines`/`maxBytes`.
 * `nativeOverlay` — `showNativeViewer(title, content)` has a backend-native
 *   surface to render into. Note this describes the BACKEND, not the current
 *   process: both backends additionally require the parent process to be inside
 *   a session and return `false` from `showNativeViewer` when it is not.
 */
export interface MultiplexerCapabilities {
  readonly structuredFocus: boolean;
  readonly boundedCapture: boolean;
  readonly nativeOverlay: boolean;
}

/**
 * Verified capability matrix, keyed by backend name.
 *
 * Single source of truth: both backends expose the matching entry as their
 * `capabilities` field, and UI code that wants to gate an action can read the
 * entry directly from a `MuxName` (e.g. `InteractiveSubagentState.mux`) without
 * resolving a backend instance or paying an availability probe.
 *
 * Every flag below is asserted against the real `tmux` / `zellij` binaries in
 * `tests/tmux.integration.test.ts` and `tests/zellij.integration.test.ts` —
 * flipping one to `true` without a passing real-binary assertion is how the
 * broken zellij `dump-screen` argv shipped green.
 */
export const MUX_CAPABILITIES: Readonly<
  Record<MuxName, MultiplexerCapabilities>
> = {
  tmux: {
    // `select-window -t <pane_id>`: pane ids are server-global.
    structuredFocus: true,
    // `capture-pane -p -S -<lines>` reaches scrollback.
    boundedCapture: true,
    // `display-popup -E`.
    nativeOverlay: true,
  },
  zellij: {
    // `action focus-pane-id` / `action go-to-tab-name`, both `--session` scoped.
    structuredFocus: true,
    // `action dump-screen --full`. Verified against zellij 0.44.3 — this was
    // `false` in practice until the bogus `/dev/stdout` positional was dropped.
    boundedCapture: true,
    // `action new-pane --floating`.
    nativeOverlay: true,
  },
} as const;

/** Read the verified capability set for a backend name. */
export function muxCapabilities(name: MuxName): MultiplexerCapabilities {
  return MUX_CAPABILITIES[name];
}

/** Bounds applied by backend-neutral pane capture. */
export interface CapturePaneOptions {
  readonly maxBytes: number;
  readonly maxLines: number;
}

/** Result of a bounded pane capture operation. */
export interface CapturePaneResult {
  readonly output: string;
  readonly truncated: boolean;
}

/**
 * Per-spawn state about how a child pane was created. The state is set on
 * `InteractiveSubagentState.mux` at spawn time and never changes — all later
 * operations on the child (send-keys, kill, attach, focus) route through the
 * same backend that created it.
 */
export interface Multiplexer {
  readonly name: MuxName;
  readonly capabilities: MultiplexerCapabilities;

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
   *                           `getPaneLiveness` / `killPane` calls. The string
   *                           format is backend-specific (tmux uses `%N`,
   *                           zellij uses `terminal_N` or just an integer
   *                           stringified).
   * @returns windowName       The actual window/tab name used (for
   *                           `attachCommand` formatting). Always defined
   *                           for background mode, undefined for visible
   *                           split mode (the pane lives in the same window
   *                           as the parent).
   * @returns session          The actual session containing the created pane,
   *                           used to scope later attachment probes.
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
   * Probe whether the pane is still known to the backend.
   *
   * A successful pane listing returns `alive` when the pane is present and
   * `dead` when it is absent. Command, setup, timeout, and parse failures return
   * `unknown`; callers must not mistake an unavailable backend for a dead pane.
   *
   * @param session  The session returned by `createPane`. zellij needs it to
   *                 target the right server; tmux pane ids are server-global.
   */
  getPaneLiveness(paneId: string, session?: string): PaneLiveness;

  /** Asynchronously perform the same tri-state pane-listing probe. */
  getPaneLivenessAsync(paneId: string, session?: string): Promise<PaneLiveness>;

  /**
   * Optional deterministic recovery lookup. Backends that cannot search by an
   * exact native window/tab identity must omit it; durable launch then falls
   * back before pane creation. Implementations must throw when enumeration is
   * ambiguous or unavailable rather than reporting a false empty result.
   */
  findPanesByWindowName?(windowName: string): readonly PaneRef[];

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

  /** Focus the referenced pane or its containing window/tab. */
  focusPane(ref: PaneRef): Promise<void>;

  /** Capture bounded pane output without blocking the parent event loop. */
  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult>;

  /** Show bounded supervisor content in an optional backend-native surface. */
  showNativeViewer(title: string, content: string): Promise<boolean>;

  /**
   * Whether at least one client is currently attached to the session hosting
   * this backend's panes. `undefined` = cannot determine.
   * MUST NOT throw; resolve undefined on backend errors.
   */
  hasAttachedClientAsync?(session?: string): Promise<boolean | undefined>;

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
  switch (preference) {
    case "tmux":
      return tmux;
    case "zellij":
      return zellij;
    case "auto": {
      // Prefer the mux already attached to this process. We check env vars
      // (cheap) before probing availability (one exec call each). If both env
      // vars are set (e.g., nested sessions — exotic but possible), zellij wins
      // (it's the more specific signal — ZELLIJ_SESSION_NAME is a single session
      // name, TMUX can be inherited through nested tmux-in-tmux shells).
      if (process.env.ZELLIJ_SESSION_NAME && zellij.isAvailable())
        return zellij;
      if (process.env.TMUX && tmux.isAvailable()) return tmux;

      // Neither env var matched. Fall back to whichever backend is available;
      // tmux first to preserve existing user setups.
      if (tmux.isAvailable()) return tmux;
      if (zellij.isAvailable()) return zellij;

      throw new NoMultiplexerAvailableError();
    }
    default:
      return assertNever(preference);
  }
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
 *
 * Deliberately NOT a login shell (`-lc`): sourcing the user's profile on every
 * availability probe is slow, has side effects, and can even change the PATH
 * the probe reports relative to the PATH we actually spawn children with.
 */
export function commandExists(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${shellEscape(command)}`], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize a free-form name into a safe window/tab/session segment.
 *
 * Shared by both backends AND by the orchestrator in `interactive-tmux.ts`,
 * which reuses it for the artifact/session path segments, so a sub-agent's
 * display name maps to exactly one segment everywhere — a second, drifting copy
 * of this logic is how a window name and its artifact directory came apart.
 * `.` is excluded on purpose: tmux target syntax reads
 * `window.pane`, so a window literally named `review.v2` can be created but
 * never selected again — `tmux select-window -t review.v2` fails with
 * `can't find pane: v2`, permanently breaking focus and the copy-paste attach
 * strings for that sub-agent. Agent names are model/task-derived, so dots are
 * not hypothetical.
 */
export function safeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

/** Maximum length of a native-viewer overlay title. */
export const MAX_VIEWER_TITLE_LENGTH = 120;

/**
 * Sanitize an untrusted sub-agent name for use as a native-overlay title.
 *
 * The sub-agent name is attacker-reachable: it is unvalidated in the tool
 * schema and defaults to text lifted from the task prompt, so a prompt
 * injection can choose it. It then lands in `tmux display-popup -T <title>` —
 * and a popup title is a tmux FORMAT, not a string. Formats run shell commands
 * via `#(...)` jobs, so `#(curl … | sh)` as a title is remote code execution
 * the moment a human opens the native viewer for that row. `shellEscape` does
 * not help: tmux evaluates the format itself, after argv parsing.
 *
 * Therefore:
 *   - `#` is removed — it is the only format introducer (`#(cmd)` executes,
 *     `#{...}` expands), so removing it neutralizes both.
 *   - control characters (CR/LF/ESC/BEL/NUL) are collapsed to spaces so a
 *     title cannot forge line boundaries or drive the parent's terminal.
 *   - leading `-` is removed: zellij's clap-based CLI parses `--name -rf` as a
 *     flag and rejects the whole command (`Found argument '-r' …`).
 */
export function sanitizeViewerTitle(title: string): string {
  const cleaned = title
    .replace(/#/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+/, "")
    .trim();
  return (cleaned || "subagent").slice(0, MAX_VIEWER_TITLE_LENGTH);
}

/**
 * Grace window used to tell "the overlay is up" apart from "the backend
 * rejected our argv". Short enough to be imperceptible when a human presses
 * `n` in the overlay, long enough for a clap/tmux usage error to surface.
 */
export const NATIVE_VIEWER_SPAWN_GRACE_MS = 250;

/**
 * Spawn a native overlay without blocking the caller for the overlay's
 * lifetime.
 *
 * `tmux display-popup -E` keeps the invoking client alive until the popup
 * closes, so running it through `execFileSync` froze the entire pi process —
 * no input, no rendering, no poller tick — until a human pressed Enter or the
 * exec timeout SIGTERM'd the client out from under the popup and we then
 * reported failure for an overlay that had demonstrably appeared.
 *
 * Instead: spawn asynchronously with no timeout, and resolve `true` once the
 * child has survived `graceMs` (i.e. the overlay is up and waiting for the
 * user). A backend that rejects the request — `no current client`, a clap
 * usage error, a missing binary — exits non-zero well inside the grace window,
 * so genuine failures still resolve `false`.
 */
export function spawnNativeViewer(
  cmd: string,
  args: readonly string[],
  graceMs: number = NATIVE_VIEWER_SPAWN_GRACE_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      // Detachment and ignored stdio are both established before `unref`.
      // Otherwise the long-lived popup can retain the Pi process through its
      // child handle or inherited pipes even after this promise has resolved.
      const child = spawn(cmd, [...args], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => settle(false));
      child.once("exit", () => settle(false));
      child.unref();
      // Surviving the complete startup window is the success signal.
      timer = setTimeout(() => settle(true), graceMs);
      timer.unref();
    } catch {
      settle(false);
    }
  });
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

/** Upper bound for tmux's `execFile` pane-capture buffer. */
export const MAX_CAPTURE_READ_BYTES = 1024 * 1024;

/**
 * Apply line and byte bounds to captured pane output.
 *
 * When the byte cut lands mid UTF-8 sequence, the start offset advances past
 * continuation bytes so the decoded preview never begins with U+FFFD.
 */
export function boundCaptureOutput(
  output: string,
  opts: CapturePaneOptions,
): CapturePaneResult {
  const maxLines = Math.max(0, Math.floor(opts.maxLines));
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes));
  let truncated = false;
  let bounded = output;
  const lines = bounded.split("\n");
  if (maxLines > 0 && lines.length > maxLines) {
    bounded = lines.slice(-maxLines).join("\n");
    truncated = true;
  } else if (maxLines === 0 && bounded.length > 0) {
    bounded = "";
    truncated = true;
  }
  const buf = Buffer.from(bounded, "utf8");
  if (buf.length > maxBytes) {
    let start = buf.length - maxBytes;
    while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
    bounded = buf.subarray(start).toString("utf8");
    truncated = true;
  }
  return { output: bounded, truncated };
}

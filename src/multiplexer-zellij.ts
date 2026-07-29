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
import { promisify } from "node:util";
import type {
  CapturePaneOptions,
  CapturePaneResult,
  Multiplexer,
  PaneLiveness,
  PaneRef,
  SyncPaneLiveness,
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

type ZellijPaneTarget =
  | { readonly kind: "terminal"; readonly paneId: string }
  | { readonly kind: "plugin"; readonly paneId: string };

interface ZellijPaneRow {
  readonly id: number | string;
  readonly is_plugin?: boolean;
  readonly exited?: boolean;
}

function parseZellijPaneTarget(raw: string): ZellijPaneTarget | undefined {
  const match = /^(?:(terminal|plugin)_)?(0|[1-9]\d*)$/.exec(raw.trim());
  if (!match) return undefined;
  return {
    kind: match[1] === "plugin" ? "plugin" : "terminal",
    paneId: match[2],
  };
}

function isCanonicalZellijPaneId(value: unknown): value is string | number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

class ZellijPaneListingError extends Error {}

function parsePaneListing(output: string): ZellijPaneRow[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new ZellijPaneListingError("zellij returned malformed pane data");
  }
  const rows: ZellijPaneRow[] = [];
  const seenTargets = new Set<string>();
  for (const row of parsed) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new ZellijPaneListingError("zellij returned malformed pane data");
    }
    const pane = row as Record<string, unknown>;
    if (
      !isCanonicalZellijPaneId(pane.id) ||
      (pane.is_plugin !== undefined && typeof pane.is_plugin !== "boolean") ||
      (pane.exited !== undefined && typeof pane.exited !== "boolean")
    ) {
      throw new ZellijPaneListingError("zellij returned malformed pane data");
    }
    const targetKind = pane.is_plugin === true ? "plugin" : "terminal";
    const targetKey = `${targetKind}:${String(pane.id)}`;
    if (seenTargets.has(targetKey)) {
      throw new ZellijPaneListingError("zellij returned duplicate pane data");
    }
    seenTargets.add(targetKey);
    rows.push(pane as unknown as ZellijPaneRow);
  }
  return rows;
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

interface ExecFileTextResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ExecFileTextOptions {
  readonly encoding: "utf8";
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: "SIGKILL";
}

function execFileText(
  command: string,
  args: readonly string[],
  options: ExecFileTextOptions,
  callback: (error: Error | null, result: ExecFileTextResult) => void,
): void {
  execFile(command, args, options, (error, stdout, stderr) => {
    const result = { stdout, stderr };
    if (error) {
      Object.assign(error, result);
    }
    callback(error, result);
  });
}

const execFileAsync = promisify(execFileText);

function classifyZellijProbeError(
  error: unknown,
  hasExplicitSession: boolean,
): PaneLiveness {
  const detail =
    error instanceof Error
      ? `${
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          typeof error.stderr === "string"
            ? error.stderr
            : ""
        }\n${error.message}`
      : "";
  if (
    hasExplicitSession &&
    /session (?:[^\n]+ )?(?:not found|does not exist)|no session named|no active zellij session/i.test(
      detail,
    )
  ) {
    return { kind: "dead" };
  }

  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const killed =
    typeof error === "object" && error !== null && "killed" in error
      ? error.killed === true
      : false;
  if (
    code === "ENOENT" ||
    code === "ETIMEDOUT" ||
    killed ||
    /connection refused|failed to connect|could not connect|no active zellij session|zellij server.*(?:unavailable|not running)/i.test(
      detail,
    )
  ) {
    return {
      kind: "unavailable",
      reason: "zellij liveness probe unavailable",
    };
  }
  return { kind: "unknown", reason: "zellij liveness probe failed" };
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
   * Match a validated `list-panes --json` row against a namespace-preserving
   * target. Zellij assigns the same numeric ids independently to terminal and
   * plugin panes, so matching the integer alone can keep a dead terminal alive.
   */
  private paneRowMatches(
    pane: ZellijPaneRow,
    target: ZellijPaneTarget,
  ): boolean {
    const paneKind = pane.is_plugin === true ? "plugin" : "terminal";
    return (
      paneKind === target.kind &&
      String(pane.id) === target.paneId &&
      pane.exited !== true
    );
  }

  getPaneLiveness(paneId: string, session?: string): SyncPaneLiveness {
    const target = parseZellijPaneTarget(paneId);
    if (!target) return "unknown";
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

  isPaneAlive(paneId: string, session?: string): boolean {
    return this.getPaneLiveness(paneId, session) === "alive";
  }

  async observePane(paneId: string, session?: string): Promise<PaneLiveness> {
    const target = parseZellijPaneTarget(paneId);
    if (!target) {
      return { kind: "unknown", reason: "invalid zellij pane id" };
    }
    try {
      const { stdout } = await execFileAsync(
        "zellij",
        [...this.sessionFlag(session), "action", "list-panes", "--json"],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 64 * 1024,
          killSignal: "SIGKILL",
        },
      );
      const panes = parsePaneListing(stdout);
      const matched = panes.find((pane) => this.paneRowMatches(pane, target));
      return matched ? { kind: "alive" } : { kind: "dead" };
    } catch (error: unknown) {
      if (error instanceof ZellijPaneListingError) {
        return { kind: "unknown", reason: error.message };
      }
      if (error instanceof SyntaxError) {
        return {
          kind: "unknown",
          reason: "zellij returned malformed pane data",
        };
      }
      return classifyZellijProbeError(error, session !== undefined);
    }
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

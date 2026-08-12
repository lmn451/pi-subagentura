/**
 * Tmux backend for the `Multiplexer` interface.
 *
 * Extracted from the previous tmux-everywhere implementation in
 * `interactive-tmux.ts`. Behavior is preserved — every `tmux` exec call
 * previously inlined there now lives here, called via the same `tmux ...`
 * argv so the existing test mocks (`vi.doMock("node:child_process", ...)`)
 * keep working unchanged.
 *
 * PR #1 also adds a relaxed-spawn fallback: when the parent pi process is
 * NOT attached to a tmux session (`process.env.TMUX` unset), `createPane`
 * creates a brand-new detached session (`pi-subagent-<id>`) and puts the
 * child there. The user attaches via the returned `attachCommand`. This
 * makes interactive sub-agents usable from a plain terminal, not only from
 * inside an existing tmux session.
 *
 * The "exit code via pane option" trick (`@pi-exit-code` set by the launch
 * script's EXIT trap) is preserved because the launch script's
 * `set-option` call is harmless on zellij (the line is in the launch
 * script, not the multiplexer) — but we no longer rely on it for the
 * artifact's `done` event; that's written by `cli.mjs done <code>` which
 * runs on every backend.
 */

import { execFile, execFileSync } from "node:child_process";
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
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  safeSegment,
  sanitizeViewerTitle,
  shellEscape,
  spawnNativeViewer,
} from "./multiplexer";

/**
 * Optional test/CI isolation for real tmux integration tests.
 *
 * tmux's default server/socket is user-global. In CI, and especially when tests
 * run in parallel or after a failed job, sharing the default socket makes tests
 * flaky and can leak panes into a developer's normal tmux session. When this env
 * var is set, every tmux operation is routed through `tmux -L <socket>`.
 */
function withTmuxSocket(args: readonly string[]): string[] {
  const socket = process.env.PI_SUBAGENTURA_TMUX_SOCKET;
  return socket ? ["-L", socket, ...args] : [...args];
}

function tmuxCommandPrefix(): string {
  const socket = process.env.PI_SUBAGENTURA_TMUX_SOCKET;
  return socket ? `tmux -L ${shellEscape(socket)}` : "tmux";
}

function settleTmuxSocketPaneForTests(): void {
  if (!process.env.PI_SUBAGENTURA_TMUX_SOCKET) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}

/**
 * Extract the session name, window index, and pane index of a tmux pane
 * via `display-message`. Throws if the pane is dead or the response is
 * malformed.
 */
function getPaneLocation(paneId: string): {
  session: string;
  window: string;
  pane: string;
} {
  const output = execMuxOrThrow(
    "tmux",
    "display-message",
    "tmux",
    withTmuxSocket([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}\t#{window_index}\t#{pane_index}",
    ]),
    { encoding: "utf8", timeout: 5000 },
  ).trim();
  const fields = output.split("\t");
  if (fields.length !== 3 || fields.some((field) => field.length === 0)) {
    throw new Error(`Malformed tmux pane location: ${output || "(empty)"}`);
  }
  const [session, window, pane] = fields as [string, string, string];
  return { session, window, pane };
}

function parsePaneListing(output: string): ReadonlySet<string> {
  const trimmed = output.trim();
  if (!trimmed) return new Set();
  const paneIds = trimmed.split(/\r?\n/);
  if (paneIds.some((paneId) => !/^%\d+$/.test(paneId))) {
    throw new Error("Malformed tmux pane listing");
  }
  return new Set(paneIds);
}

export class TmuxMultiplexer implements Multiplexer {
  readonly name = "tmux" as const;
  readonly capabilities = MUX_CAPABILITIES.tmux;

  /** Shared detached session used when the parent is outside tmux. */
  private detachedSessionName?: string;

  /**
   * True iff the `tmux` binary is on PATH. Does NOT require the parent
   * process to be attached to a tmux server (the relaxed-spawn path in
   * `createPane` handles unattached parents by creating a detached session).
   *
   * The env-var heuristic (`process.env.TMUX`) lives in `getMux()`'s
   * auto-resolution, not here — `isAvailable` is a pure binary-availability
   * check so the fallback path in `getMux()` can find a backend even when
   * the user is running in a plain terminal.
   */
  isAvailable(): boolean {
    return commandExists("tmux");
  }

  private hasSession(sessionName: string): boolean {
    try {
      execFileSync("tmux", withTmuxSocket(["has-session", "-t", sessionName]), {
        stdio: "ignore",
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a pane for the child process. When the parent is in tmux
   * (the common case), behaves as before:
   *   - background: true  → `new-window -d -n <name>` in the current session
   *   - background: false → `split-window -h` from `$TMUX_PANE` (a visible
   *                         side-by-side; the parent keeps focus)
   *
   * When the parent is NOT in tmux (the relaxed-spawn path), the first child
   * creates a detached session named `pi-subagent-<id>`. Later children are
   * placed in new windows in that same session. The user attaches via
   * `tmux attach -t <session-name>`. This path is selected by the
   * orchestrator (`launchInteractiveSubagent`).
   *
   * For backwards compatibility, callers that don't pass an id still get a
   * safe session name derived from the display name.
   *
   * Note: this method intentionally does not check `isAvailable` — the
   * relaxed path must work even when `process.env.TMUX` is unset, as long
   * as the `tmux` binary is on PATH. The orchestrator probes both.
   */
  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    id?: string; // sub-agent id (8 hex); used for the relaxed-path unique session name
  }): { paneId: string; windowName?: string; session: string } {
    if (!commandExists("tmux")) {
      throw new Error(
        "tmux is not available. Install tmux or set PATH to include it.",
      );
    }

    // Relaxed path: the first child creates a detached session; later children
    // become detached windows in that same session. This keeps plain-terminal
    // usage organized without changing the in-session behavior below.
    if (!process.env.TMUX) {
      let isFirstPane = this.detachedSessionName === undefined;
      const sessionName =
        this.detachedSessionName ??
        `pi-subagent-${opts.id ?? safeSegment(opts.name)}`;
      if (!isFirstPane && !this.hasSession(sessionName)) {
        // The last child may have been cancelled, taking the only session
        // window with it. Recreate the shared session on the next spawn.
        this.detachedSessionName = undefined;
        isFirstPane = true;
      }
      const windowName = opts.windowName ?? safeSegment(opts.name);
      const paneId = isFirstPane
        ? execMuxOrThrow(
            "tmux",
            "new-session",
            "tmux",
            withTmuxSocket([
              "new-session",
              "-d",
              "-s",
              sessionName,
              "-c",
              opts.cwd,
              "-P",
              "-F",
              "#{pane_id}",
            ]),
            { encoding: "utf8", timeout: 10000 },
          ).trim()
        : execMuxOrThrow(
            "tmux",
            "new-window",
            "tmux",
            withTmuxSocket([
              "new-window",
              "-d",
              "-t",
              sessionName,
              "-n",
              windowName,
              "-P",
              "-F",
              "#{pane_id}",
              "-c",
              opts.cwd,
            ]),
            { encoding: "utf8", timeout: 10000 },
          ).trim();
      if (!/^%\d+$/.test(paneId)) {
        throw new Error(`Unexpected tmux pane id: ${paneId || "(empty)"}`);
      }
      this.detachedSessionName = sessionName;
      if (isFirstPane) {
        // Rename the default window to the sub-agent's display name.
        try {
          execFileSync(
            "tmux",
            withTmuxSocket([
              "rename-window",
              "-t",
              `${sessionName}:0`,
              windowName,
            ]),
            {
              encoding: "utf8",
              stdio: "ignore",
              timeout: 5000,
            },
          );
        } catch {
          // Cosmetic; don't fail the spawn if rename doesn't take.
        }
      }
      settleTmuxSocketPaneForTests();
      return { paneId, windowName, session: sessionName };
    }

    // Standard path: parent is in tmux.
    let paneId: string;
    let windowName: string | undefined;
    if (opts.background) {
      // Spawn in a new detached window — invisible to the user until they
      // select it. Each background sub-agent gets its own named window
      // so they don't clobber each other in the tmux window list.
      windowName = opts.windowName ?? safeSegment(opts.name);
      paneId = execMuxOrThrow(
        "tmux",
        "new-window",
        "tmux",
        withTmuxSocket([
          "new-window",
          "-d",
          "-n",
          windowName,
          "-P",
          "-F",
          "#{pane_id}",
          "-c",
          opts.cwd,
        ]),
        { encoding: "utf8", timeout: 10000 },
      ).trim();
    } else {
      // Visible horizontal split — parent pane keeps focus. Same session,
      // immediately adjacent to the parent's pane.
      const args = [
        "split-window",
        "-d",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
        "-c",
        opts.cwd,
      ];
      const parent = opts.parentPane ?? process.env.TMUX_PANE;
      if (parent) {
        args.splice(4, 0, "-t", parent);
      }
      paneId = execMuxOrThrow(
        "tmux",
        "split-window",
        "tmux",
        withTmuxSocket(args),
        {
          encoding: "utf8",
          timeout: 10000,
        },
      ).trim();
    }
    if (!/^%\d+$/.test(paneId)) {
      throw new Error(`Unexpected tmux pane id: ${paneId || "(empty)"}`);
    }
    let session: string;
    try {
      session = getPaneLocation(paneId).session;
    } catch (error) {
      this.killPane(paneId);
      throw new Error(`Failed to determine session for tmux pane ${paneId}`, {
        cause: error,
      });
    }
    if (!opts.background) {
      // Pane title is cosmetic and the new window already shows `name`.
      try {
        execFileSync(
          "tmux",
          withTmuxSocket(["select-pane", "-t", paneId, "-T", opts.name]),
          {
            stdio: "ignore",
            encoding: "utf8",
          },
        );
      } catch {
        // Pane title is cosmetic and can fail on older tmux versions.
      }
    }
    settleTmuxSocketPaneForTests();
    return { paneId, windowName, session };
  }

  findPanesByWindowName(windowName: string): readonly PaneRef[] {
    try {
      const output = execFileSync(
        "tmux",
        withTmuxSocket([
          "list-panes",
          "-a",
          "-F",
          "#{pane_id}\t#{window_name}\t#{session_name}",
        ]),
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
        },
      );
      return output
        .split("\n")
        .filter((line) => line.length > 0)
        .flatMap((line): PaneRef[] => {
          const [paneId, listedWindowName, session] = line.split("\t");
          if (
            !paneId ||
            !/^%\d+$/.test(paneId) ||
            listedWindowName !== windowName
          ) {
            return [];
          }
          return [{ paneId, windowName: listedWindowName, session }];
        });
    } catch (error) {
      if (
        error instanceof Error &&
        /no server running|no sessions|No such file or directory/.test(
          error.message,
        )
      ) {
        return [];
      }
      throw new Error("Failed to enumerate tmux panes for recovery", {
        cause: error,
      });
    }
  }

  getPaneLiveness(paneId: string): PaneLiveness {
    if (!/^%\d+$/.test(paneId)) return "unknown";
    try {
      const output = execFileSync(
        "tmux",
        withTmuxSocket(["list-panes", "-a", "-F", "#{pane_id}"]),
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        },
      );
      return parsePaneListing(output).has(paneId) ? "alive" : "dead";
    } catch {
      return "unknown";
    }
  }

  getPaneLivenessAsync(paneId: string): Promise<PaneLiveness> {
    if (!/^%\d+$/.test(paneId)) return Promise.resolve("unknown");
    return new Promise((resolve) => {
      try {
        execFile(
          "tmux",
          withTmuxSocket(["list-panes", "-a", "-F", "#{pane_id}"]),
          { encoding: "utf8", timeout: 5000 },
          (error, stdout) => {
            if (error) {
              resolve("unknown");
              return;
            }
            try {
              resolve(parsePaneListing(stdout).has(paneId) ? "alive" : "dead");
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

  sendKeys(paneId: string, text: string): void {
    execMuxOrThrow(
      "tmux",
      "send-keys",
      "tmux",
      // `--` terminates flag parsing: agent follow-up text is user/model
      // controlled and text starting with `-` would otherwise be read as a
      // send-keys flag (`command send-keys: unknown flag -n`, exit 1).
      withTmuxSocket(["send-keys", "-t", paneId, "-l", "--", text]),
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
  }

  sendEnter(paneId: string): void {
    execMuxOrThrow(
      "tmux",
      "send-keys Enter",
      "tmux",
      withTmuxSocket(["send-keys", "-t", paneId, "Enter"]),
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
  }

  killPane(paneId: string): void {
    try {
      execFileSync("tmux", withTmuxSocket(["kill-pane", "-t", paneId]), {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // Best effort — pane may already be dead.
    }
  }

  /**
   * Focus the pane, addressed by its tmux pane id.
   *
   * Pane ids (`%N`) are tmux-server-global, so a single target resolves the
   * pane, its window AND its session unambiguously. The previous
   * `select-window -t <windowName>` was none of those things: window names come
   * from `safeSegment(name)`, so two sub-agents both called "reviewer" collide,
   * and an unqualified name target resolves against whichever session tmux
   * scans first — verified to focus the WRONG session's window while returning
   * exit 0, i.e. reporting success for focusing a different agent.
   *
   * `select-window` is required even for a visible split (`select-pane` alone
   * does not change the active window), and `select-pane` is required to land
   * on the right pane within that window — so both run, chained in one tmux
   * invocation via a literal `;` argument.
   */
  focusPane(ref: PaneRef): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = withTmuxSocket([
        "select-window",
        "-t",
        ref.paneId,
        ";",
        "select-pane",
        "-t",
        ref.paneId,
      ]);
      execFile("tmux", args, { timeout: 5000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const lines = Math.max(0, Math.floor(opts.maxLines));
    return new Promise((resolve, reject) => {
      execFile(
        "tmux",
        withTmuxSocket([
          "capture-pane",
          "-p",
          "-t",
          ref.paneId,
          "-S",
          `-${lines}`,
        ]),
        {
          encoding: "utf8",
          maxBuffer: MAX_CAPTURE_READ_BYTES,
          timeout: 5000,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(boundCaptureOutput(stdout, opts));
        },
      );
    });
  }

  /**
   * Open the bounded supervisor content in a tmux popup.
   *
   * `title` is the sub-agent's display name, which is attacker-reachable, and
   * `display-popup -T` evaluates its argument as a tmux FORMAT — `#(...)` in a
   * format spawns a shell job. `sanitizeViewerTitle` strips the `#` introducer;
   * see its doc comment. `shellEscape` cannot substitute for it, because tmux
   * evaluates the format after argv parsing.
   *
   * The popup itself runs `read`, i.e. it lives until the user dismisses it,
   * and `-E` keeps the invoking tmux client alive for that whole time. So this
   * must never be spawned synchronously — `spawnNativeViewer` returns as soon
   * as the popup is up and leaves it running.
   */
  showNativeViewer(title: string, content: string): Promise<boolean> {
    if (!process.env.TMUX) return Promise.resolve(false);
    const command = `printf '%s\\n' ${shellEscape(content)}; printf '\\nPress Enter to close'; read _`;
    return spawnNativeViewer(
      "tmux",
      withTmuxSocket([
        "display-popup",
        "-E",
        "-T",
        sanitizeViewerTitle(title),
        "sh",
        "-lc",
        command,
      ]),
    );
  }

  /**
   * Whether a tmux client is attached to `session` (or to the server at all,
   * when no session is given).
   *
   * A successful session listing first distinguishes an absent target session
   * (`false`) from an unavailable or timed-out backend (`undefined`). Only a
   * successful `list-clients` result can then establish attached/no-client
   * state for an existing target.
   */
  hasAttachedClientAsync(session?: string): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      try {
        execFile(
          "tmux",
          withTmuxSocket(["list-sessions", "-F", "#{session_name}"]),
          { encoding: "utf8", timeout: 5000 },
          (sessionError, sessionOutput) => {
            if (sessionError) {
              resolve(undefined);
              return;
            }
            const trimmed = sessionOutput.trim();
            const sessions = trimmed ? trimmed.split(/\r?\n/) : [];
            if (sessions.some((name) => name.length === 0)) {
              resolve(undefined);
              return;
            }
            if (session && !sessions.includes(session)) {
              resolve(false);
              return;
            }

            const target = session ? ["-t", session] : [];
            try {
              execFile(
                "tmux",
                withTmuxSocket([
                  "list-clients",
                  ...target,
                  "-F",
                  "#{client_name}",
                ]),
                { encoding: "utf8", timeout: 5000 },
                (clientError, clientOutput) => {
                  resolve(
                    clientError ? undefined : clientOutput.trim().length > 0,
                  );
                },
              );
            } catch {
              resolve(undefined);
            }
          },
        );
      } catch {
        resolve(undefined);
      }
    });
  }

  buildAttachCommands(opts: { paneId: string; windowName?: string }): {
    attachCommand: string;
    focusCommand: string;
  } {
    if (opts.windowName) {
      // Background mode: pane lives in a named detached window. Attach
      // command chains `attach -t <session>` with
      // `select-window -t <session>:<windowName>` so it works from outside the
      // session too.
      //
      // The window target MUST carry the session qualifier. Window names are
      // `safeSegment(name)`, so two sub-agents both called "reviewer" collide,
      // and a bare name target resolves against whichever session tmux scans
      // first: verified against tmux 3.7b, `select-window -t reviewer` with
      // `reviewer` windows in both `collide-a` and `collide-b` moves
      // `collide-b` — the most recently created session — and exits 0. That is
      // the same silent wrong-agent focus `focusPane` was fixed for, except
      // here it lands in a string we hand the user to paste.
      //
      // Note the `\;` chain is genuinely for outside-tmux use: from inside a
      // session on the same server, tmux refuses with "sessions should be
      // nested with care, unset $TMUX to force" and the chained select-window
      // does NOT run either (verified 3.7b). Inside-tmux callers get
      // `focusCommand`, which is why it is a standalone command.
      const location = getPaneLocation(opts.paneId);
      const tmux = tmuxCommandPrefix();
      const targetWindow = `${location.session}:${opts.windowName}`;
      return {
        attachCommand: `${tmux} attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(targetWindow)}`,
        focusCommand: `${tmux} select-window -t ${shellEscape(targetWindow)}`,
      };
    }
    // Visible split: attach by pane id inside the parent's window.
    const location = getPaneLocation(opts.paneId);
    const targetWindow = `${location.session}:${location.window}`;
    const tmux = tmuxCommandPrefix();
    return {
      attachCommand: `${tmux} attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(targetWindow)} \\; select-pane -t ${shellEscape(opts.paneId)}`,
      focusCommand: `${tmux} select-pane -t ${shellEscape(opts.paneId)}`,
    };
  }
}

/**
 * Read the @pi-exit-code pane option set by the launch script's EXIT trap.
 * Returns the numeric exit code, or null if the option is not set (child
 * still running) or the pane is dead.
 *
 * Tmux-specific; not part of the `Multiplexer` interface because zellij
 * has no equivalent (and we don't need it — the artifact's `done` event
 * carries the exit code on every backend). Kept exported so the test
 * suite can continue to assert the trap behavior, and for any downstream
 * tooling that wants to read the option directly.
 */
export function readPaneExitCode(paneId: string): number | null {
  try {
    const value = execFileSync(
      "tmux",
      withTmuxSocket([
        "show-options",
        "-p",
        "-v",
        "-t",
        paneId,
        "@pi-exit-code",
      ]),
      // stderr must be ignored: while the child is still running the
      // option is unset and tmux would otherwise print
      // `invalid option: @pi-exit-code` to the parent's stderr (the
      // agent's TUI). We rely on the non-zero exit + catch below to
      // detect "not set", not on stderr.
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    ).trim();
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  } catch {
    // Option unset (still running) or pane dead.
    return null;
  }
}

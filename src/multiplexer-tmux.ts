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

import { execFileSync } from "node:child_process";
import type { Multiplexer } from "./multiplexer";
import { commandExists, execMuxOrThrow, shellEscape } from "./multiplexer";

/**
 * Extract the session name, window index, and pane index of a tmux pane
 * via `display-message`. Throws if the pane is dead or the id is malformed —
 * callers that want a liveness probe should use `isPaneAlive` instead.
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
    [
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}\t#{window_index}\t#{pane_index}",
    ],
    { encoding: "utf8", timeout: 5000 },
  ).trim();
  const [session, window, pane] = output.split("\t");
  return { session, window, pane };
}

/** Sanitize a free-form name into a tmux-safe segment. tmux names allow most
 * chars but reject `:`, `.`, and whitespace; we collapse everything else to
 * a single dash to keep the resulting window/session names copy-pasteable. */
function safeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

export class TmuxMultiplexer implements Multiplexer {
  readonly name = "tmux" as const;

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

  /**
   * Create a pane for the child process. When the parent is in tmux
   * (the common case), behaves as before:
   *   - background: true  → `new-window -d -n <name>` in the current session
   *   - background: false → `split-window -h` from `$TMUX_PANE` (a visible
   *                         side-by-side; the parent keeps focus)
   *
   * When the parent is NOT in tmux (the new relaxed-spawn path), creates a
   * brand-new detached session named `pi-subagent-<id>` and puts the
   * child in its only window. The user attaches via `tmux attach -t
   * pi-subagent-<id>`. This path is selected by the orchestrator
   * (`launchInteractiveSubagent`) — it passes a non-empty `id` to the
   * unique-session path. For backwards compat, callers that don't pass
   * an id (e.g., the pre-PR-1 `createTmuxPane(name, cwd, { background })`
   * shape) still get the old behavior, and the relaxed path is only used
   * when the parent is not in tmux AND background is true.
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
  }): { paneId: string; windowName?: string } {
    if (!commandExists("tmux")) {
      throw new Error(
        "tmux is not available. Install tmux or set PATH to include it.",
      );
    }

    // Relaxed path: parent not in tmux. Create a brand-new detached
    // session so the child has somewhere to live. The user attaches via
    // `tmux attach -t <session-name>` after the spawn returns.
    if (!process.env.TMUX) {
      const sessionName = `pi-subagent-${opts.id ?? safeSegment(opts.name)}`;
      const paneId = execMuxOrThrow(
        "tmux",
        "new-session",
        "tmux",
        [
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          opts.cwd,
          "-P",
          "-F",
          "#{pane_id}",
        ],
        { encoding: "utf8", timeout: 10000 },
      ).trim();
      if (!paneId.startsWith("%")) {
        throw new Error(`Unexpected tmux pane id: ${paneId || "(empty)"}`);
      }
      // Rename the default window to the sub-agent's display name so the
      // user's `tmux ls` output is recognizable.
      const windowName = opts.windowName ?? safeSegment(opts.name);
      try {
        execFileSync(
          "tmux",
          ["rename-window", "-t", `${sessionName}:0`, windowName],
          {
            encoding: "utf8",
            timeout: 5000,
          },
        );
      } catch {
        // Cosmetic; don't fail the spawn if rename doesn't take.
      }
      return { paneId, windowName };
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
        [
          "new-window",
          "-d",
          "-n",
          windowName,
          "-P",
          "-F",
          "#{pane_id}",
          "-c",
          opts.cwd,
        ],
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
      paneId = execMuxOrThrow("tmux", "split-window", "tmux", args, {
        encoding: "utf8",
        timeout: 10000,
      }).trim();
    }
    if (!paneId.startsWith("%")) {
      throw new Error(`Unexpected tmux pane id: ${paneId || "(empty)"}`);
    }
    if (!opts.background) {
      // Pane title is cosmetic and the new window already shows `name`.
      try {
        execFileSync("tmux", ["select-pane", "-t", paneId, "-T", opts.name], {
          encoding: "utf8",
        });
      } catch {
        // Pane title is cosmetic and can fail on older tmux versions.
      }
    }
    return { paneId, windowName };
  }

  isPaneAlive(paneId: string): boolean {
    try {
      execFileSync(
        "tmux",
        ["display-message", "-p", "-t", paneId, "#{pane_id}"],
        {
          stdio: "ignore",
          timeout: 5000,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  sendKeys(paneId: string, text: string): void {
    execMuxOrThrow(
      "tmux",
      "send-keys",
      "tmux",
      ["send-keys", "-t", paneId, "-l", text],
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
      ["send-keys", "-t", paneId, "Enter"],
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
  }

  killPane(paneId: string): void {
    try {
      execFileSync("tmux", ["kill-pane", "-t", paneId], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // Best effort — pane may already be dead.
    }
  }

  buildAttachCommands(opts: { paneId: string; windowName?: string }): {
    attachCommand: string;
    focusCommand: string;
  } {
    if (opts.windowName) {
      // Background mode: pane lives in a named detached window. Attach
      // command chains `attach -t <session>` with
      // `select-window -t <windowName>` so it works from outside the
      // session too. Inside-tmux callers get the same effect via `\;`
      // chaining — the attach errors with "nested sessions" but the
      // select-window still runs.
      const location = getPaneLocation(opts.paneId);
      return {
        attachCommand: `tmux attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(opts.windowName)}`,
        focusCommand: `tmux select-window -t ${shellEscape(opts.windowName)}`,
      };
    }
    // Visible split: attach by pane id inside the parent's window.
    const location = getPaneLocation(opts.paneId);
    const targetWindow = `${location.session}:${location.window}`;
    return {
      attachCommand: `tmux attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(targetWindow)} \\; select-pane -t ${shellEscape(opts.paneId)}`,
      focusCommand: `tmux select-pane -t ${shellEscape(opts.paneId)}`,
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
      ["show-options", "-p", "-v", "-t", paneId, "@pi-exit-code"],
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

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
 * visible-split path's liveness probe work — without it `isPaneAlive` would
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

import { execFileSync } from "node:child_process";
import type { Multiplexer } from "./multiplexer";
import { commandExists, shellEscape } from "./multiplexer";

/** Sanitize a free-form name into a safe segment for zellij tab/session names. */
function safeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

/**
 * Normalize a zellij pane id to the bare-integer string form used by
 * `list-panes --json` (`id`) and accepted by every `--pane-id` flag.
 * `new-pane` emits `terminal_5` / `plugin_2`; strip that prefix so the id
 * round-trips through `isPaneAlive` / `sendKeys` / `killPane`.
 */
function normalizePaneId(raw: string): string {
  return raw.trim().replace(/^(?:terminal_|plugin_)/, "");
}

export class ZellijMultiplexer implements Multiplexer {
  readonly name = "zellij" as const;

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
      execFileSync("zellij", ["attach", "--create-background", session], {
        encoding: "utf8",
        timeout: 10000,
      });
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
          const currentTabInfo = execFileSync(
            "zellij",
            [...sessionFlag, "action", "current-tab-info"],
            { encoding: "utf8", timeout: 3000 },
          );
          const positionMatch = currentTabInfo.match(/^position:\s*(\d+)/m);
          if (positionMatch) {
            previousTabPosition = parseInt(positionMatch[1], 10);
          }
        } catch {
          // Best effort — if we can't get the current tab, we'll still
          // create the new tab, just won't restore focus.
        }
      }
      execFileSync(
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
      execFileSync(
        "zellij",
        [...sessionFlag, "action", "new-pane", "--direction", "right"],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
    }

    const panesAfter = this.listPanes(session);
    const beforeIds = new Set(panesBefore.map((p) => String(p.id)));
    // Ignore plugin panes (the tab-bar / status-bar plugins zellij spawns) —
    // only a real terminal pane can host the child shell.
    const newPanes = panesAfter.filter(
      (p) => !beforeIds.has(String(p.id)) && !p.is_plugin,
    );
    const chosen =
      newPanes[0] ?? panesAfter.find((p) => !p.is_plugin) ?? panesAfter[0];
    const paneId = chosen ? normalizePaneId(String(chosen.id)) : "";
    if (!paneId) {
      throw new Error("Failed to determine pane ID after creating pane");
    }

    return { paneId, windowName, session: session || undefined };
  }

  /** Run `list-panes --json` against a session, returning [] on any failure. */
  private listPanes(
    session?: string,
  ): Array<{ id: unknown; is_plugin?: boolean; exited?: boolean }> {
    try {
      const output = execFileSync(
        "zellij",
        [...this.sessionFlag(session), "action", "list-panes", "--json"],
        { encoding: "utf8", timeout: 5000 },
      );
      const parsed = JSON.parse(output);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Probe whether the pane is still alive. Runs `list-panes --json` and
   * checks whether the pane ID appears AND has not exited. Returns false on
   * any error (dead pane, backend down, malformed id).
   */
  isPaneAlive(paneId: string, session?: string): boolean {
    const target = normalizePaneId(paneId);
    return this.listPanes(session).some(
      (p) => String(p.id) === target && p.exited !== true,
    );
  }

  /**
   * Send literal text to the pane's shell input buffer, character by
   * character. Does NOT submit (no Enter).
   */
  sendKeys(paneId: string, text: string, session?: string): void {
    execFileSync(
      "zellij",
      [
        ...this.sessionFlag(session),
        "action",
        "write-chars",
        "--pane-id",
        normalizePaneId(paneId),
        text,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  /**
   * Send a single Enter / Return key to the pane (decimal 13 = Enter key).
   */
  sendEnter(paneId: string, session?: string): void {
    execFileSync(
      "zellij",
      [
        ...this.sessionFlag(session),
        "action",
        "write",
        "--pane-id",
        normalizePaneId(paneId),
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
      focusCommand: `zellij action focus-pane-id ${normalizePaneId(opts.paneId)}`,
    };
  }
}

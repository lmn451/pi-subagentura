/**
 * Herdr backend for the `Multiplexer` interface.
 *
 * Herdr exposes its current server through `HERDR_SOCKET_PATH` and injects
 * stable public workspace/tab/pane ids into every managed pane. We persist the
 * socket path as `muxSession`, so rehydrated children keep addressing the
 * server that created them instead of whichever Herdr session is currently
 * focused when Pi restarts.
 */

import { execFile, execFileSync } from "node:child_process";
import type {
  CapturePaneOptions,
  CapturePaneResult,
  Multiplexer,
  PaneActivity,
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
  shellEscape,
} from "./multiplexer";

const HERDR_TIMEOUT_MS = 5000;
const PANE_LIVENESS_CACHE_MS = 500;

interface HerdrPaneInfo {
  readonly pane_id: string;
  readonly workspace_id?: string;
  readonly tab_id?: string;
  readonly focused?: boolean;
}

interface HerdrPaneListingProbe {
  cachedAt?: number;
  panes?: readonly HerdrPaneInfo[];
  inFlight?: Promise<readonly HerdrPaneInfo[] | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResult(output: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !isRecord(parsed.result)) {
    throw new Error("Malformed herdr response");
  }
  return parsed.result;
}

function parsePane(value: unknown): HerdrPaneInfo {
  if (!isRecord(value) || typeof value.pane_id !== "string") {
    throw new Error("Malformed herdr pane response");
  }
  if (
    (value.workspace_id !== undefined &&
      typeof value.workspace_id !== "string") ||
    (value.tab_id !== undefined && typeof value.tab_id !== "string") ||
    (value.focused !== undefined && typeof value.focused !== "boolean")
  ) {
    throw new Error("Malformed herdr pane response");
  }
  return value as unknown as HerdrPaneInfo;
}

function parsePaneListing(output: string): HerdrPaneInfo[] {
  const panes = parseResult(output).panes;
  if (!Array.isArray(panes)) throw new Error("Malformed herdr pane listing");
  return panes.map(parsePane);
}

function parseCreatedPane(output: string, field: "pane" | "root_pane"): string {
  const pane = parsePane(parseResult(output)[field]);
  if (!pane.pane_id) throw new Error("Malformed herdr pane id");
  return pane.pane_id;
}

function herdrEnv(session?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (session) env.HERDR_SOCKET_PATH = session;
  return env;
}

function currentSocketPath(): string {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    throw new Error(
      "Herdr did not provide HERDR_SOCKET_PATH. Start Pi inside a Herdr pane.",
    );
  }
  return socketPath;
}

export class HerdrMultiplexer implements Multiplexer {
  readonly name = "herdr" as const;
  readonly capabilities = MUX_CAPABILITIES.herdr;
  private readonly paneListingProbes = new Map<string, HerdrPaneListingProbe>();

  /** Herdr control is intentionally scoped to the session hosting this Pi. */
  isAvailable(): boolean {
    return (
      process.env.HERDR_ENV === "1" &&
      !!process.env.HERDR_SOCKET_PATH &&
      commandExists("herdr")
    );
  }

  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    id?: string;
  }): { paneId: string; windowName?: string; session?: string } {
    if (!this.isAvailable()) {
      throw new Error(
        "Herdr is not available. Install Herdr and start Pi inside a Herdr pane.",
      );
    }
    const session = currentSocketPath();
    const windowName = opts.windowName ?? safeSegment(opts.name);
    if (opts.background) {
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (!workspaceId) {
        throw new Error("Herdr did not provide HERDR_WORKSPACE_ID");
      }
      const output = execMuxOrThrow(
        "herdr",
        "tab create",
        "herdr",
        [
          "tab",
          "create",
          "--workspace",
          workspaceId,
          "--cwd",
          opts.cwd,
          "--label",
          windowName,
          "--no-focus",
        ],
        { encoding: "utf8", timeout: 10000, env: herdrEnv(session) },
      );
      return {
        paneId: parseCreatedPane(output, "root_pane"),
        windowName,
        session,
      };
    }

    const parentPane = opts.parentPane ?? process.env.HERDR_PANE_ID;
    if (!parentPane) throw new Error("Herdr did not provide HERDR_PANE_ID");
    const output = execMuxOrThrow(
      "herdr",
      "pane split",
      "herdr",
      [
        "pane",
        "split",
        parentPane,
        "--direction",
        "right",
        "--cwd",
        opts.cwd,
        "--no-focus",
      ],
      { encoding: "utf8", timeout: 10000, env: herdrEnv(session) },
    );
    return { paneId: parseCreatedPane(output, "pane"), session };
  }

  getPaneLiveness(paneId: string, session?: string): PaneLiveness {
    if (!paneId) return "unknown";
    try {
      const output = execFileSync("herdr", ["pane", "list"], {
        encoding: "utf8",
        timeout: HERDR_TIMEOUT_MS,
        env: herdrEnv(session),
      });
      return parsePaneListing(output).some((pane) => pane.pane_id === paneId)
        ? "alive"
        : "dead";
    } catch {
      return "unknown";
    }
  }

  private listPanesAsync(
    session?: string,
  ): Promise<readonly HerdrPaneInfo[] | undefined> {
    const key = session ?? "";
    const probe = this.paneListingProbes.get(key) ?? {};
    this.paneListingProbes.set(key, probe);
    if (
      probe.cachedAt !== undefined &&
      Date.now() - probe.cachedAt < PANE_LIVENESS_CACHE_MS
    ) {
      return Promise.resolve(probe.panes);
    }
    if (probe.inFlight) return probe.inFlight;
    const request = this.runAsync(["pane", "list"], session).then((output) => {
      if (output === undefined) return undefined;
      try {
        return parsePaneListing(output);
      } catch {
        return undefined;
      }
    });
    probe.inFlight = request;
    void request.then((panes) => {
      probe.cachedAt = Date.now();
      probe.panes = panes;
      if (probe.inFlight === request) probe.inFlight = undefined;
    });
    return request;
  }

  async getPaneLivenessAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLiveness> {
    if (!paneId) return "unknown";
    const panes = await this.listPanesAsync(session);
    if (!panes) return "unknown";
    return panes.some((pane) => pane.pane_id === paneId) ? "alive" : "dead";
  }

  private runAsync(
    args: readonly string[],
    session?: string,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        execFile(
          "herdr",
          [...args],
          {
            encoding: "utf8",
            timeout: HERDR_TIMEOUT_MS,
            env: herdrEnv(session),
            maxBuffer: MAX_CAPTURE_READ_BYTES,
          },
          (error, stdout) => resolve(error ? undefined : stdout),
        );
      } catch {
        resolve(undefined);
      }
    });
  }

  async getPaneActivityAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneActivity> {
    if (!paneId) return "unknown";
    const output = await this.runAsync(["api", "snapshot"], session);
    if (output === undefined) return "unknown";
    try {
      const snapshot = parseResult(output).snapshot;
      if (!isRecord(snapshot)) return "unknown";
      const focused = snapshot.focused_pane_id;
      if (
        focused !== null &&
        focused !== undefined &&
        typeof focused !== "string"
      ) {
        return "unknown";
      }
      return focused === paneId ? "active" : "inactive";
    } catch {
      return "unknown";
    }
  }

  sendKeys(paneId: string, text: string, session?: string): void {
    execMuxOrThrow(
      "herdr",
      "pane send-text",
      "herdr",
      ["pane", "send-text", paneId, text],
      { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, env: herdrEnv(session) },
    );
  }

  sendEnter(paneId: string, session?: string): void {
    execMuxOrThrow(
      "herdr",
      "pane send-keys enter",
      "herdr",
      ["pane", "send-keys", paneId, "enter"],
      { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, env: herdrEnv(session) },
    );
  }

  killPane(paneId: string, session?: string): void {
    try {
      execFileSync("herdr", ["pane", "close", paneId], {
        stdio: "ignore",
        timeout: HERDR_TIMEOUT_MS,
        env: herdrEnv(session),
      });
    } catch {
      // Best effort — the pane may already have exited or the server may be gone.
    }
  }

  focusPane(ref: PaneRef): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        "herdr",
        ["agent", "focus", ref.paneId],
        { timeout: HERDR_TIMEOUT_MS, env: herdrEnv(ref.session) },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const maxLines = Number.isFinite(opts.maxLines)
      ? Math.max(0, Math.floor(opts.maxLines))
      : 0;
    const maxBytes = Number.isFinite(opts.maxBytes)
      ? Math.max(0, Math.floor(opts.maxBytes))
      : 0;
    if (maxLines === 0 || maxBytes === 0) {
      return Promise.resolve({ output: "", truncated: true });
    }
    const requestedLines = Math.min(maxLines + 1, 0xffff_ffff);
    return new Promise((resolve, reject) => {
      execFile(
        "herdr",
        [
          "pane",
          "read",
          ref.paneId,
          "--source",
          "recent-unwrapped",
          "--lines",
          String(requestedLines),
        ],
        {
          encoding: "utf8",
          timeout: HERDR_TIMEOUT_MS,
          env: herdrEnv(ref.session),
          maxBuffer: MAX_CAPTURE_READ_BYTES,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(boundCaptureOutput(stdout, { maxLines, maxBytes }));
        },
      );
    });
  }

  showNativeViewer(_title: string, _content: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  hasAttachedClientAsync(): Promise<boolean | undefined> {
    return Promise.resolve(undefined);
  }

  buildAttachCommands(opts: {
    paneId: string;
    windowName?: string;
    session?: string;
  }): { attachCommand: string; focusCommand: string } {
    const herdr = opts.session
      ? `HERDR_SOCKET_PATH=${shellEscape(opts.session)} herdr`
      : "herdr";
    const focusCommand = `${herdr} agent focus ${shellEscape(opts.paneId)} >/dev/null`;
    return {
      attachCommand: `${focusCommand}; ${herdr}`,
      focusCommand,
    };
  }
}

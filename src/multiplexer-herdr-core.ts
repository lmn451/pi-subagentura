import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import {
  boundCaptureOutput,
  execMuxOrThrow,
  isHerdrCoreTerminalId,
  isMuxSocketPath,
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  shellEscape,
  validateMuxLaunchContext,
  type CapturePaneOptions,
  type CapturePaneResult,
  type Multiplexer,
  type PaneActivity,
  type PaneLiveness,
  type PaneRef,
} from "./multiplexer-contracts";

const TIMEOUT_MS = 5_000;
const MAX_READ_LINES = 4096;

export function herdrCoreEnv(
  server: unknown,
  env = process.env,
): NodeJS.ProcessEnv {
  if (
    !isMuxSocketPath(server) ||
    !statSync(server, { throwIfNoEntry: false })?.isSocket()
  ) {
    throw new Error("Herdr Core terminal socket is unavailable");
  }
  return {
    ...env,
    HC_SOCKET: server,
    HC_TERMINAL_SOCKET: server,
    HC_TERMINAL_ID: undefined,
  };
}

export function parseHerdrCoreTerminal(output: string, id: string) {
  const row = JSON.parse(output);
  return row?.address === id &&
    (row.state === "live" || row.state === "finished")
    ? (row as { state: "live" | "finished"; pid?: unknown })
    : undefined;
}

function requireTerminal(id: string): string {
  if (!isHerdrCoreTerminalId(id))
    throw new Error("Invalid Herdr Core terminal ID");
  return id;
}

function options(server: unknown) {
  return {
    encoding: "utf8" as const,
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: herdrCoreEnv(server),
  };
}

function runAsync(
  args: string[],
  server: unknown,
  maxBuffer?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = options(server);
    const child = execFile(
      "hc",
      args,
      { ...opts, maxBuffer: maxBuffer ?? opts.maxBuffer },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      },
    );
    child.stdin?.end();
  });
}

function liveness(output: string, paneId: string): PaneLiveness {
  const terminal = parseHerdrCoreTerminal(output, paneId);
  return terminal?.state === "live"
    ? "alive"
    : terminal?.state === "finished"
      ? "dead"
      : "unknown";
}

function failedLiveness(error: unknown): PaneLiveness {
  // hc uses exit code 3 for not_found. Connection and parsing errors are not deaths.
  const failure = error as { status?: unknown; code?: unknown } | null;
  return failure?.status === 3 || failure?.code === 3 ? "dead" : "unknown";
}

export class HerdrCoreMultiplexer implements Multiplexer {
  readonly name = "herdr-core";
  readonly capabilities = MUX_CAPABILITIES[this.name];

  isAvailable(): boolean {
    const { HC_TERMINAL_ID, HC_TERMINAL_SOCKET } = process.env;
    return (
      isHerdrCoreTerminalId(HC_TERMINAL_ID) &&
      this.getPaneLiveness(HC_TERMINAL_ID, undefined, HC_TERMINAL_SOCKET) ===
        "alive"
    );
  }

  createPane({ context, name, cwd }: Parameters<Multiplexer["createPane"]>[0]) {
    validateMuxLaunchContext(this.name, context);
    if (context?.kind !== "attached" || context.mux !== this.name) {
      throw new Error(
        "Start Pi inside a Herdr Core terminal to use this backend",
      );
    }
    const label =
      name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .slice(0, 23) || "agent";
    const windowName = `${label}-${randomBytes(4).toString("hex")}`;
    // Core has independent terminals, not splits. Retain them across parent exit
    // so Subagentura can rehydrate and cancel them using the recorded identity.
    const output = execMuxOrThrow(
      this.name,
      "run",
      "hc",
      [
        "run",
        "--bg",
        "--json",
        "--no-notify",
        "--outlive-parent",
        "--parent",
        context.paneId,
        "--name",
        windowName,
        "--cwd",
        cwd,
        "--",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-i",
      ],
      options(context.server),
    );
    const paneId: unknown = JSON.parse(output)?.address;
    if (!isHerdrCoreTerminalId(paneId) || paneId === context.paneId) {
      throw new Error("Herdr Core did not return a new local terminal ID");
    }
    return { paneId, windowName, server: context.server };
  }

  getPaneLiveness(
    paneId: string,
    _session?: string,
    server?: string,
  ): PaneLiveness {
    try {
      const output = execFileSync(
        "hc",
        ["get", "--json", requireTerminal(paneId)],
        options(server),
      );
      return liveness(output, paneId);
    } catch (error) {
      return failedLiveness(error);
    }
  }

  async getPaneLivenessAsync(
    paneId: string,
    _session?: string,
    server?: string,
  ): Promise<PaneLiveness> {
    try {
      return liveness(
        await runAsync(["get", "--json", requireTerminal(paneId)], server),
        paneId,
      );
    } catch (error) {
      return failedLiveness(error);
    }
  }

  async getPaneActivityAsync(): Promise<PaneActivity> {
    return "unknown";
  }

  sendCommand(
    paneId: string,
    text: string,
    _session?: string,
    server?: string,
  ): void {
    execMuxOrThrow(
      this.name,
      "send",
      "hc",
      ["send", "--json", requireTerminal(paneId), "--", text],
      options(server),
    );
  }

  killPane(paneId: string, _session?: string, server?: string): void {
    try {
      execFileSync(
        "hc",
        ["kill", "--json", requireTerminal(paneId)],
        options(server),
      );
    } catch {
      // Cleanup is best-effort, including when the core or terminal has ended.
    }
  }

  async focusPane(): Promise<void> {
    throw new Error(
      "Herdr Core has no native focus command; use the terminal attach command",
    );
  }

  async capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const lines = Math.min(
      MAX_READ_LINES,
      Math.max(0, Math.floor(opts.maxLines)),
    );
    const output = await runAsync(
      ["read", "--json", "--lines", String(lines), requireTerminal(ref.paneId)],
      ref.server,
      6 * MAX_CAPTURE_READ_BYTES,
    );
    const result = JSON.parse(output);
    if (
      typeof result?.text !== "string" ||
      typeof result.complete !== "boolean"
    ) {
      throw new Error("Herdr Core returned an invalid terminal capture");
    }
    const bounded = boundCaptureOutput(result.text, opts);
    return {
      output: bounded.output,
      truncated: bounded.truncated || !result.complete,
    };
  }

  async showNativeViewer(): Promise<boolean> {
    return false;
  }

  buildAttachCommands({ paneId, server }: { paneId: string; server?: string }) {
    if (!isMuxSocketPath(server))
      throw new Error("Invalid Herdr Core terminal socket");
    const attachCommand = `HC_SOCKET=${shellEscape(server)} HC_TERMINAL_SOCKET=${shellEscape(server)} hc attach ${requireTerminal(paneId)}`;
    return { attachCommand, focusCommand: attachCommand };
  }
}

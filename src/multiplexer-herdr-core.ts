import { randomUUID } from "node:crypto";
import { requestHerdrCore, requestHerdrCoreSync } from "./herdr-core-rpc.mjs";
import {
  boundCaptureOutput,
  isHerdrCoreTerminalId,
  isMuxSocketPath,
  MUX_CAPABILITIES,
  safeSegment,
  shellEscape,
  validateMuxLaunchContext,
  type CapturePaneOptions,
  type CapturePaneResult,
  type Multiplexer,
  type MuxLaunchContext,
  type PaneLiveness,
  type PaneRef,
} from "./multiplexer-contracts";

function terminal(value: string): string {
  if (!isHerdrCoreTerminalId(value))
    throw new Error("Invalid herdr-core terminal id");
  return value;
}

function endpoint(server: string | undefined): string {
  if (!isMuxSocketPath(server)) throw new Error("Invalid herdr-core socket");
  return server;
}

function liveness(value: Record<string, unknown>, id: string): PaneLiveness {
  if (value.address !== id) return "unknown";
  return value.state === "live"
    ? "alive"
    : value.state === "finished"
      ? "dead"
      : "unknown";
}

function missing(error: unknown): boolean {
  return (error as { kind?: unknown })?.kind === "not_found";
}

export class HerdrCoreMultiplexer implements Multiplexer {
  readonly name = "herdr-core" as const;
  readonly capabilities = MUX_CAPABILITIES["herdr-core"];

  isAvailable(): boolean {
    try {
      const id = terminal(process.env.HC_TERMINAL_ID!);
      return (
        liveness(
          requestHerdrCoreSync(
            endpoint(process.env.HC_TERMINAL_SOCKET ?? process.env.HC_SOCKET),
            "terminal.get",
            { terminal: id },
          ),
          id,
        ) === "alive"
      );
    } catch {
      // An absent or unreachable host cannot grant launch authority.
      return false;
    }
  }

  createPane(opts: {
    context?: MuxLaunchContext;
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    id?: string;
  }): { paneId: string; server: string; windowName: string } {
    validateMuxLaunchContext(this.name, opts.context);
    const context = opts.context;
    if (!context || context.kind !== "attached" || context.mux !== "herdr-core")
      throw new Error("herdr-core requires an attached terminal");
    const name = `${safeSegment(opts.windowName ?? opts.name).slice(0, 20)}-${safeSegment(opts.id ?? randomUUID()).slice(0, 8)}`;
    const value = requestHerdrCoreSync(context.server, "terminal.run", {
      argv: ["bash", "--noprofile", "--norc", "-i"],
      cwd: opts.cwd,
      name,
      parent: terminal(context.paneId),
      no_notify: true,
      outlive_parent: true,
    });
    return {
      paneId: terminal(value.address as string),
      server: context.server,
      windowName: name,
    };
  }

  getPaneLiveness(
    id: string,
    _session?: string,
    server?: string,
  ): PaneLiveness {
    try {
      return liveness(
        requestHerdrCoreSync(endpoint(server), "terminal.get", {
          terminal: terminal(id),
        }),
        id,
      );
    } catch (error) {
      return missing(error) ? "dead" : "unknown";
    }
  }

  async getPaneLivenessAsync(
    id: string,
    _session?: string,
    server?: string,
  ): Promise<PaneLiveness> {
    try {
      return liveness(
        await requestHerdrCore(endpoint(server), "terminal.get", {
          terminal: terminal(id),
        }),
        id,
      );
    } catch (error) {
      return missing(error) ? "dead" : "unknown";
    }
  }

  async getPaneActivityAsync(): Promise<"unknown"> {
    // The core provides attach streams, without proof of a focused human client.
    return "unknown";
  }

  sendKeys(id: string, text: string, _session?: string, server?: string): void {
    const target = terminal(id);
    const socket = endpoint(server);
    const value = requestHerdrCoreSync(socket, "terminal.get", {
      terminal: target,
    });
    if (
      !Number.isInteger(value.cols) ||
      !Number.isInteger(value.rows) ||
      (value.cols as number) <= 0 ||
      (value.rows as number) <= 0 ||
      (value.cols as number) > 65535 ||
      (value.rows as number) > 65535
    )
      throw new Error("Malformed herdr-core terminal size");
    requestHerdrCoreSync(
      socket,
      "terminal.attach",
      { terminal: target, cols: value.cols, rows: value.rows },
      text,
    );
  }

  sendEnter(id: string, session?: string, server?: string): void {
    this.sendKeys(id, "\r", session, server);
  }

  killPane(id: string, _session?: string, server?: string): void {
    try {
      requestHerdrCoreSync(endpoint(server), "terminal.kill", {
        terminal: terminal(id),
      });
    } catch {
      // Best effort when the terminal or its core has already exited.
    }
  }

  async focusPane(_ref: PaneRef): Promise<void> {
    throw new Error("Use the herdr-core attach command to open this terminal");
  }

  async capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const lines = Number.isFinite(opts.maxLines)
      ? Math.max(0, Math.min(4096, Math.floor(opts.maxLines)))
      : 0;
    if (lines === 0 || opts.maxBytes <= 0)
      return { output: "", truncated: true };
    const value = await requestHerdrCore(
      endpoint(ref.server),
      "terminal.read",
      { terminal: terminal(ref.paneId), lines },
    );
    if (typeof value.text !== "string" || typeof value.complete !== "boolean")
      throw new Error("Malformed herdr-core read response");
    const bounded = boundCaptureOutput(value.text.replace(/\n+$/, ""), opts);
    return {
      ...bounded,
      truncated: bounded.truncated || !value.complete || lines < opts.maxLines,
    };
  }

  async showNativeViewer(): Promise<boolean> {
    return false;
  }
  async hasAttachedClientAsync(): Promise<undefined> {
    return undefined;
  }

  buildAttachCommands(opts: { paneId: string; server?: string }): {
    attachCommand: string;
    focusCommand: string;
  } {
    const command = `HC_SOCKET=${shellEscape(endpoint(opts.server))} herdr-core attach ${terminal(opts.paneId)}`;
    return { attachCommand: command, focusCommand: command };
  }
}

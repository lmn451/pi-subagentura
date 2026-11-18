import { execFile, execFileSync } from "node:child_process";
import {
  boundCaptureOutput,
  commandExists,
  isMuxSocketPath,
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  shellEscape,
  validateMuxLaunchContext,
  type CapturePaneOptions,
  type CapturePaneResult,
  type SplitInputMultiplexer,
  type MuxLaunchContext,
  type PaneActivity,
  type PaneLiveness,
  type PaneRef,
} from "./multiplexer-contracts";

function paneId(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid WezTerm pane id");
  return value;
}

function socketEnv(server: string): NodeJS.ProcessEnv {
  if (!isMuxSocketPath(server)) throw new Error("Invalid WezTerm socket");
  return { ...process.env, WEZTERM_UNIX_SOCKET: server };
}

function paneRows(output: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(output);
  if (
    !Array.isArray(value) ||
    value.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        !Number.isSafeInteger(row.pane_id) ||
        row.pane_id < 0,
    )
  )
    throw new Error("Malformed WezTerm pane listing");
  return value as Record<string, unknown>[];
}

function run(args: string[], server: string, input?: string): string {
  return execFileSync("wezterm", ["cli", "--no-auto-start", ...args], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: MAX_CAPTURE_READ_BYTES,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: socketEnv(server),
    ...(input === undefined ? {} : { input }),
  });
}

function runAsync(args: string[], server: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "wezterm",
      ["cli", "--no-auto-start", ...args],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: MAX_CAPTURE_READ_BYTES,
        shell: false,
        env: socketEnv(server),
      },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
    child?.stdin?.end();
  });
}

export class WezTermMultiplexer implements SplitInputMultiplexer {
  readonly name = "wezterm" as const;
  readonly capabilities = MUX_CAPABILITIES.wezterm;

  isAvailable(): boolean {
    const server = process.env.WEZTERM_UNIX_SOCKET;
    if (!commandExists("wezterm") || !isMuxSocketPath(server)) return false;
    try {
      paneRows(run(["list", "--format", "json"], server));
      return true;
    } catch {
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
  }): { paneId: string; windowName?: string; server: string } {
    validateMuxLaunchContext(this.name, opts.context);
    const context = opts.context;
    if (!context || context.kind !== "attached" || context.mux !== "wezterm")
      throw new Error("WezTerm requires a verified attached pane");
    const parent = paneId(opts.parentPane ?? context.paneId);
    const args = opts.background
      ? ["spawn", "--pane-id", parent]
      : ["split-pane", "--pane-id", parent, "--right"];
    const output = run(
      [...args, "--cwd", opts.cwd, "--", "bash", "--noprofile", "--norc", "-i"],
      context.server,
    );
    const child = paneId(output.trim());
    if (opts.background && opts.windowName) {
      try {
        const row = paneRows(
          run(["list", "--format", "json"], context.server),
        ).find((entry) => String(entry.pane_id) === child);
        if (Number.isSafeInteger(row?.tab_id))
          run(
            ["set-tab-title", "--tab-id", String(row!.tab_id), opts.windowName],
            context.server,
          );
      } catch {
        // A cosmetic title failure must not orphan an otherwise live pane.
      }
    }
    return {
      paneId: child,
      server: context.server,
      ...(opts.background && opts.windowName
        ? { windowName: opts.windowName }
        : {}),
    };
  }

  getPaneLiveness(
    id: string,
    _session?: string,
    server?: string,
  ): PaneLiveness {
    try {
      const rows = paneRows(run(["list", "--format", "json"], server!));
      return rows.some((row) => String(row.pane_id) === paneId(id))
        ? "alive"
        : "dead";
    } catch {
      return "unknown";
    }
  }

  async getPaneLivenessAsync(
    id: string,
    _session?: string,
    server?: string,
  ): Promise<PaneLiveness> {
    try {
      const rows = paneRows(
        await runAsync(["list", "--format", "json"], server!),
      );
      return rows.some((row) => String(row.pane_id) === paneId(id))
        ? "alive"
        : "dead";
    } catch {
      return "unknown";
    }
  }

  async getPaneActivityAsync(
    id: string,
    _session?: string,
    server?: string,
  ): Promise<PaneActivity> {
    try {
      const value: unknown = JSON.parse(
        await runAsync(["list-clients", "--format", "json"], server!),
      );
      if (
        !Array.isArray(value) ||
        value.length !== 1 ||
        value[0] === null ||
        typeof value[0] !== "object" ||
        Array.isArray(value[0]) ||
        !Number.isSafeInteger(value[0].focused_pane_id) ||
        value[0].focused_pane_id < 0
      )
        return "unknown";
      return value[0].focused_pane_id === Number(paneId(id))
        ? "active"
        : "inactive";
    } catch {
      return "unknown";
    }
  }

  sendKeys(id: string, text: string, _session?: string, server?: string): void {
    run(["send-text", "--pane-id", paneId(id), "--no-paste"], server!, text);
  }

  sendEnter(id: string, _session?: string, server?: string): void {
    this.sendKeys(id, "\r", undefined, server);
  }

  killPane(id: string, _session?: string, server?: string): void {
    try {
      run(["kill-pane", "--pane-id", paneId(id)], server!);
    } catch {
      // Cancellation is best effort when the pane or GUI has already exited.
    }
  }

  async focusPane(ref: PaneRef): Promise<void> {
    await runAsync(
      ["activate-pane", "--pane-id", paneId(ref.paneId)],
      ref.server!,
    );
  }

  async capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const output = await runAsync(
      ["get-text", "--pane-id", paneId(ref.paneId)],
      ref.server!,
    );
    return boundCaptureOutput(output.replace(/\n+$/, ""), opts);
  }

  async showNativeViewer(_title: string, _content: string): Promise<boolean> {
    return false;
  }

  async hasAttachedClientAsync(
    _session?: string,
    server?: string,
  ): Promise<boolean | undefined> {
    try {
      const value: unknown = JSON.parse(
        await runAsync(["list-clients", "--format", "json"], server!),
      );
      return Array.isArray(value) ? value.length > 0 : undefined;
    } catch {
      return undefined;
    }
  }

  buildAttachCommands(opts: { paneId: string; server?: string }): {
    attachCommand: string;
    focusCommand: string;
  } {
    const command = `WEZTERM_UNIX_SOCKET=${shellEscape(opts.server!)} wezterm cli activate-pane --pane-id ${paneId(opts.paneId)}`;
    return { attachCommand: command, focusCommand: command };
  }
}

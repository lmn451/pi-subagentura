import { randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type {
  AtomicInputMultiplexer,
  CapturePaneOptions,
  CapturePaneResult,
  MuxLaunchContext,
  PaneActivity,
  PaneLiveness,
  PaneRef,
} from "./multiplexer-contracts";
import {
  boundCaptureOutput,
  commandExists,
  isHerdrCoreAddress,
  isHerdrCorePaneName,
  isMuxSocketPath,
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  shellEscape,
  validateMuxLaunchContext,
} from "./multiplexer-contracts";

const HC_TIMEOUT_MS = 5_000;
const HC_RUN_TIMEOUT_MS = 10_000;
const HC_CONTROL_OUTPUT_BYTES = 256 * 1024;
const HC_CAPTURE_OUTPUT_BYTES = MAX_CAPTURE_READ_BYTES * 6 + 64 * 1024;
const HC_MAX_READ_LINES = 4_096;
const HC_NAME_ID_PATTERN = /^[a-f0-9]{16}$/;

interface HerdrCoreGetResult {
  readonly state: "live" | "finished";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSocketPath(server: string | undefined): string {
  if (!isMuxSocketPath(server)) {
    throw new Error("Herdr Core pane state is missing its pinned socket path");
  }
  try {
    if (!statSync(server).isSocket()) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "Herdr Core socket is unavailable; refusing to contact the default Core",
    );
  }
  return server;
}

function coreEnvironment(server: string): NodeJS.ProcessEnv {
  return { ...process.env, HC_SOCKET: server };
}

function requirePaneName(paneId: string): string {
  if (!isHerdrCorePaneName(paneId)) {
    throw new Error("Invalid Herdr Core pane name");
  }
  return paneId;
}

function parseGetResult(
  output: string,
  expectedName: string,
): HerdrCoreGetResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.kind === "not_found") return { state: "finished" };
  const state = parsed.state;
  if (
    (state !== "live" && state !== "finished") ||
    !isHerdrCoreAddress(parsed.address)
  ) {
    return undefined;
  }
  if (parsed.name !== undefined && parsed.name !== expectedName)
    return undefined;
  return { state };
}

function errorOutput(error: unknown): string[] {
  if (error === null || typeof error !== "object") return [];
  const candidate = error as { stdout?: unknown; stderr?: unknown };
  return [candidate.stdout, candidate.stderr].flatMap((value) => {
    if (typeof value === "string") return [value];
    if (Buffer.isBuffer(value)) return [value.toString("utf8")];
    return [];
  });
}

function containsNotFoundError(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed)) return false;
    return (
      parsed.kind === "not_found" ||
      (isRecord(parsed.error) && parsed.error.kind === "not_found")
    );
  } catch {
    return false;
  }
}

function isExplicitNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  const exitStatus = candidate.status ?? candidate.code;
  return (
    Number(exitStatus) === 3 && errorOutput(error).some(containsNotFoundError)
  );
}

function livenessFromGet(output: string, paneId: string): PaneLiveness {
  const result = parseGetResult(output, paneId);
  if (!result) return "unknown";
  return result.state === "live" ? "alive" : "dead";
}

function livenessFromError(error: unknown): PaneLiveness {
  return isExplicitNotFound(error) ? "dead" : "unknown";
}

function parseRunResult(output: string, expectedName: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Herdr Core run returned invalid JSON");
  }
  if (
    !isRecord(parsed) ||
    parsed.name !== expectedName ||
    !isHerdrCoreAddress(parsed.address) ||
    parsed.state !== "live"
  ) {
    throw new Error(
      "Herdr Core run did not return the requested live terminal",
    );
  }
}

function requirePaneRef(ref: PaneRef): { paneId: string; server: string } {
  return {
    paneId: requirePaneName(ref.paneId),
    server: readSocketPath(ref.server),
  };
}

function coreExecSync(
  server: string,
  args: readonly string[],
  timeout = HC_TIMEOUT_MS,
  maxBuffer = HC_CONTROL_OUTPUT_BYTES,
): string {
  return execFileSync("hc", [...args], {
    encoding: "utf8",
    env: coreEnvironment(server),
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function coreExec(
  server: string,
  args: readonly string[],
  timeout = HC_TIMEOUT_MS,
  maxBuffer = HC_CONTROL_OUTPUT_BYTES,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  try {
    execFile(
      "hc",
      [...args],
      {
        encoding: "utf8",
        env: coreEnvironment(server),
        maxBuffer,
        timeout,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  } catch (error) {
    reject(error);
  }
  return promise;
}

export class HerdrCoreMultiplexer implements AtomicInputMultiplexer {
  readonly name = "herdr-core" as const;
  readonly capabilities = MUX_CAPABILITIES["herdr-core"];

  isAvailable(): boolean {
    const socket = process.env.HC_TERMINAL_SOCKET;
    if (!isMuxSocketPath(socket)) return false;
    try {
      if (!statSync(socket).isSocket()) return false;
    } catch {
      return false;
    }
    return (
      isHerdrCoreAddress(process.env.HC_TERMINAL_ID) && commandExists("hc")
    );
  }

  createPane(opts: {
    context?: MuxLaunchContext;
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    id?: string;
  }): { paneId: string; server: string } {
    if (!opts.background) {
      throw new Error(
        "Herdr Core supports detached children only; set background: true",
      );
    }
    validateMuxLaunchContext(this.name, opts.context);
    const context = opts.context;
    if (!context || context.kind !== "attached" || context.mux !== this.name) {
      throw new Error("Herdr Core requires a verified attached launch context");
    }
    const server = readSocketPath(context.server);
    if (!isHerdrCoreAddress(context.paneId)) {
      throw new Error("Invalid Herdr Core parent address");
    }
    const id = opts.id ?? randomBytes(8).toString("hex");
    if (!HC_NAME_ID_PATTERN.test(id)) {
      throw new Error("Invalid Herdr Core child id");
    }
    const paneId = requirePaneName(`pi-${id}`);
    const args = [
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--name",
      paneId,
      "--cwd",
      opts.cwd,
      "--json",
      "--",
      "/bin/sh",
      "-i",
    ];
    const output = coreExecSync(server, args, HC_RUN_TIMEOUT_MS);
    try {
      parseRunResult(output, paneId);
    } catch (error) {
      this.killPane(paneId, undefined, server);
      throw error;
    }
    return { paneId, server };
  }

  getPaneLiveness(
    paneId: string,
    _session?: string,
    server?: string,
  ): PaneLiveness {
    let target: { paneId: string; server: string };
    try {
      target = {
        paneId: requirePaneName(paneId),
        server: readSocketPath(server),
      };
    } catch {
      return "unknown";
    }
    try {
      const output = coreExecSync(target.server, [
        "get",
        "--json",
        "--",
        target.paneId,
      ]);
      return livenessFromGet(output, target.paneId);
    } catch (error) {
      return livenessFromError(error);
    }
  }

  async getPaneLivenessAsync(
    paneId: string,
    _session?: string,
    server?: string,
  ): Promise<PaneLiveness> {
    let target: { paneId: string; server: string };
    try {
      target = {
        paneId: requirePaneName(paneId),
        server: readSocketPath(server),
      };
    } catch {
      return "unknown";
    }
    try {
      return livenessFromGet(
        await coreExec(target.server, ["get", "--json", "--", target.paneId]),
        target.paneId,
      );
    } catch (error) {
      return livenessFromError(error);
    }
  }

  getPaneActivityAsync(
    _paneId: string,
    _session?: string,
    _server?: string,
  ): Promise<PaneActivity> {
    return Promise.resolve("unknown");
  }

  sendCommand(
    paneId: string,
    text: string,
    _session?: string,
    server?: string,
  ): void {
    const target = {
      paneId: requirePaneName(paneId),
      server: readSocketPath(server),
    };
    coreExecSync(target.server, ["send", "--json", "--", target.paneId, text]);
  }

  killPane(paneId: string, _session?: string, server?: string): void {
    try {
      const target = {
        paneId: requirePaneName(paneId),
        server: readSocketPath(server),
      };
      coreExecSync(target.server, ["kill", "--json", "--", target.paneId]);
    } catch {
      // Cleanup and cancellation must tolerate an already-finished child.
    }
  }

  async focusPane(_ref: PaneRef): Promise<void> {
    throw new Error(
      "Herdr Core does not support programmatic focus; use the attach command",
    );
  }

  async capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const target = requirePaneRef(ref);
    const maxBytes = Number.isFinite(opts.maxBytes)
      ? Math.min(MAX_CAPTURE_READ_BYTES, Math.max(0, Math.floor(opts.maxBytes)))
      : 0;
    const maxLines = Number.isFinite(opts.maxLines)
      ? Math.min(HC_MAX_READ_LINES, Math.max(0, Math.floor(opts.maxLines)))
      : 0;
    const readLines = Math.max(1, maxLines);
    let output: string;
    let complete: boolean;
    try {
      const response = await coreExec(
        target.server,
        ["read", "--json", "--lines", String(readLines), "--", target.paneId],
        HC_TIMEOUT_MS,
        HC_CAPTURE_OUTPUT_BYTES,
      );
      const parsed: unknown = JSON.parse(response);
      if (
        !isRecord(parsed) ||
        typeof parsed.text !== "string" ||
        typeof parsed.complete !== "boolean"
      ) {
        throw new Error("Malformed Herdr Core read response");
      }
      output = parsed.text;
      complete = parsed.complete;
    } catch {
      throw new Error("Herdr Core capture failed");
    }
    const bounded = boundCaptureOutput(output, { maxBytes, maxLines });
    return {
      output: bounded.output,
      truncated: bounded.truncated || !complete,
    };
  }

  async showNativeViewer(_title: string, _content: string): Promise<boolean> {
    return false;
  }

  async hasAttachedClientAsync(
    _session?: string,
    _server?: string,
  ): Promise<boolean | undefined> {
    return undefined;
  }

  buildAttachCommands(opts: {
    paneId: string;
    terminalId?: string;
    windowName?: string;
    session?: string;
    server?: string;
  }): { attachCommand: string; focusCommand: string } {
    const paneId = requirePaneName(opts.paneId);
    if (!isMuxSocketPath(opts.server)) {
      throw new Error(
        "Herdr Core pane state is missing its pinned socket path",
      );
    }
    return {
      attachCommand: `HC_SOCKET=${shellEscape(opts.server)} hc attach ${shellEscape(paneId)}`,
      focusCommand: "",
    };
  }
}

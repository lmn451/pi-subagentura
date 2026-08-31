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
import { createConnection, type Socket } from "node:net";
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
const MAX_HERDR_SOCKET_PATH_LENGTH = 4096;
const MAX_HERDR_RESPONSE_BYTES = MAX_CAPTURE_READ_BYTES * 6 + 64 * 1024;
const MAX_HERDR_READ_LINES = 4096;
const MAX_HERDR_TERMINAL_ID_BYTES = 256;

interface HerdrPaneInfo {
  readonly pane_id: string;
  readonly terminal_id?: string;
  readonly workspace_id?: string;
  readonly tab_id?: string;
  readonly focused?: boolean;
}

interface HerdrCommandResult {
  readonly error: unknown | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

type PaneLookupResult =
  | { readonly kind: "found"; readonly pane: HerdrPaneInfo }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

interface HerdrSocketResponse {
  readonly id: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

let nextHerdrRequestId = 0;

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
    (value.terminal_id !== undefined &&
      typeof value.terminal_id !== "string") ||
    (value.workspace_id !== undefined &&
      typeof value.workspace_id !== "string") ||
    (value.tab_id !== undefined && typeof value.tab_id !== "string") ||
    (value.focused !== undefined && typeof value.focused !== "boolean")
  ) {
    throw new Error("Malformed herdr pane response");
  }
  return value as unknown as HerdrPaneInfo;
}

function parsePaneResult(output: string): HerdrPaneInfo {
  return parsePane(parseResult(output).pane);
}

function isStableTerminalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_HERDR_TERMINAL_ID_BYTES
  );
}

function parseCreatedPane(
  output: string,
  field: "pane" | "root_pane",
): { paneId: string; terminalId: unknown } {
  const value = parseResult(output)[field];
  if (!isRecord(value) || typeof value.pane_id !== "string" || !value.pane_id) {
    throw new Error("Malformed herdr pane id");
  }
  return { paneId: value.pane_id, terminalId: value.terminal_id };
}

function socketPathFor(session?: string): string {
  const socketPath = session ?? process.env.HERDR_SOCKET_PATH;
  if (
    !socketPath ||
    socketPath.length > MAX_HERDR_SOCKET_PATH_LENGTH ||
    socketPath.includes("\0")
  ) {
    throw new Error(
      "Herdr did not provide a valid HERDR_SOCKET_PATH. Start Pi inside a Herdr pane.",
    );
  }
  return socketPath;
}

function herdrEnv(session?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (session !== undefined) {
    env.HERDR_SOCKET_PATH = socketPathFor(session);
  }
  return env;
}

function closeCreatedPaneBestEffort(paneId: string, session: string): void {
  try {
    execFileSync("herdr", ["pane", "close", paneId], {
      stdio: "ignore",
      timeout: HERDR_TIMEOUT_MS,
      env: herdrEnv(session),
    });
  } catch {
    // Preserve the original create-response error.
  }
}

function requireCreatedPaneIdentity(
  created: { paneId: string; terminalId: unknown },
  session: string,
): { paneId: string; muxTerminalId: string } {
  if (!isStableTerminalId(created.terminalId)) {
    closeCreatedPaneBestEffort(created.paneId, session);
    throw new Error(
      "Herdr create response did not include a stable terminal_id",
    );
  }
  return { paneId: created.paneId, muxTerminalId: created.terminalId };
}

function currentSocketPath(): string {
  return socketPathFor();
}

function isValidSocketPath(
  socketPath: string | undefined,
): socketPath is string {
  return (
    typeof socketPath === "string" &&
    socketPath.length > 0 &&
    socketPath.length <= MAX_HERDR_SOCKET_PATH_LENGTH &&
    !socketPath.includes("\0")
  );
}

function commandErrorOutput(
  error: unknown,
  field: "stdout" | "stderr",
): string {
  if (!isRecord(error)) return "";
  return stringFromUnknown(error[field]);
}

function stringFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function parseErrorCode(value: unknown): string | undefined {
  const text = stringFromUnknown(value);
  if (!text) return undefined;
  const candidates = [text, ...text.split(/\r?\n/)];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        isRecord(parsed) &&
        isRecord(parsed.error) &&
        typeof parsed.error.code === "string"
      ) {
        return parsed.error.code;
      }
    } catch {
      // CLI diagnostics may contain non-JSON lines before the JSON error.
    }
  }
  return undefined;
}

function isPaneNotFoundResponse(result: HerdrCommandResult): boolean {
  return (
    parseErrorCode(result.stdout) === "pane_not_found" ||
    parseErrorCode(result.stderr) === "pane_not_found" ||
    (isRecord(result.error) && result.error.code === "pane_not_found") ||
    (result.error instanceof Error &&
      result.error.message.includes("pane_not_found"))
  );
}

function paneLookupFromCommand(result: HerdrCommandResult): PaneLookupResult {
  if (isPaneNotFoundResponse(result)) return { kind: "missing" };
  if (result.error !== undefined) return { kind: "unknown" };
  try {
    return { kind: "found", pane: parsePaneResult(result.stdout) };
  } catch {
    return { kind: "unknown" };
  }
}

function parseSocketResponse(
  output: string,
  expectedId: string,
): HerdrSocketResponse {
  const parsed: unknown = JSON.parse(output);
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    parsed.id !== expectedId
  ) {
    throw new Error("Mismatched Herdr socket response id");
  }
  if (isRecord(parsed.error)) {
    if (
      typeof parsed.error.code !== "string" ||
      typeof parsed.error.message !== "string"
    ) {
      throw new Error("Malformed herdr socket error");
    }
    return {
      id: parsed.id,
      error: {
        code: parsed.error.code,
        message: parsed.error.message,
      },
    };
  }
  if (!isRecord(parsed.result)) {
    throw new Error("Malformed herdr socket response");
  }
  return { id: parsed.id, result: parsed.result };
}

function parsePaneInfo(result: Record<string, unknown>): HerdrPaneInfo {
  if (result.type !== "pane_info") {
    throw new Error("Malformed Herdr pane.focus response");
  }
  const pane = parsePane(result.pane);
  if (
    !pane.terminal_id ||
    !pane.workspace_id ||
    !pane.tab_id ||
    pane.focused === undefined
  ) {
    throw new Error("Malformed Herdr pane.focus response");
  }
  return pane;
}

function parsePaneRead(result: Record<string, unknown>): {
  readonly pane: HerdrPaneInfo;
  readonly text: string;
  readonly truncated: boolean;
} {
  if (result.type !== "pane_read" || !isRecord(result.read)) {
    throw new Error("Malformed Herdr pane.read response");
  }
  const read = result.read;
  if (
    typeof read.pane_id !== "string" ||
    typeof read.workspace_id !== "string" ||
    typeof read.tab_id !== "string" ||
    read.source !== "recent_unwrapped" ||
    read.format !== "text" ||
    typeof read.text !== "string" ||
    typeof read.revision !== "number" ||
    !Number.isSafeInteger(read.revision) ||
    read.revision < 0 ||
    typeof read.truncated !== "boolean"
  ) {
    throw new Error("Malformed Herdr pane.read response");
  }
  return {
    pane: {
      pane_id: read.pane_id,
      workspace_id: read.workspace_id,
      tab_id: read.tab_id,
    },
    text: read.text,
    truncated: read.truncated,
  };
}

function socketError(response: HerdrSocketResponse, operation: string): Error {
  if (response.error) {
    return new Error(
      `Herdr ${operation} failed (${response.error.code}): ${response.error.message}`,
    );
  }
  return new Error(`Malformed Herdr ${operation} response`);
}

function requestHerdrSocket(
  session: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<HerdrSocketResponse> {
  const socketPath = socketPathFor(session);
  const id = `pi-subagentura:${method}:${nextHerdrRequestId++}`;
  const request = `${JSON.stringify({ id, method, params })}\n`;
  const { promise, resolve, reject } =
    Promise.withResolvers<HerdrSocketResponse>();
  let settled = false;
  let receivedBytes = 0;
  let bufferedBytes = 0;
  const chunks: Buffer[] = [];
  let socket: Socket | undefined;
  let deadline: NodeJS.Timeout | undefined;

  const finishError = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    socket?.destroy();
    reject(error instanceof Error ? error : new Error(String(error)));
  };
  const finishResponse = (response: HerdrSocketResponse): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    socket?.destroy();
    resolve(response);
  };

  deadline = setTimeout(() => {
    finishError(new Error(`Herdr ${method} timed out`));
  }, HERDR_TIMEOUT_MS);

  try {
    socket = createConnection({ path: socketPath });
    socket.setTimeout(HERDR_TIMEOUT_MS, () => {
      finishError(new Error(`Herdr ${method} timed out`));
    });
    socket.on("error", finishError);
    socket.on("close", () => {
      if (!settled) {
        finishError(new Error(`Herdr ${method} closed without a response`));
      }
    });
    socket.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > MAX_HERDR_RESPONSE_BYTES) {
        finishError(
          new Error(`Herdr ${method} response exceeded the byte limit`),
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        chunks.push(buffer);
        bufferedBytes += buffer.length;
        return;
      }
      chunks.push(buffer.subarray(0, newline));
      const line = Buffer.concat(chunks, bufferedBytes + newline).toString(
        "utf8",
      );
      try {
        finishResponse(parseSocketResponse(line, id));
      } catch (error) {
        finishError(error);
      }
    });
    socket.on("connect", () => {
      try {
        socket?.write(request);
      } catch (error) {
        finishError(error);
      }
    });
  } catch (error) {
    finishError(error);
  }
  return promise;
}

export class HerdrMultiplexer implements Multiplexer {
  readonly name = "herdr" as const;
  readonly capabilities = MUX_CAPABILITIES.herdr;
  private readonly paneAliases = new Map<string, string>();

  /** Herdr control is intentionally scoped to the session hosting this Pi. */
  isAvailable(): boolean {
    return (
      process.env.HERDR_ENV === "1" &&
      isValidSocketPath(process.env.HERDR_SOCKET_PATH) &&
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
  }): {
    paneId: string;
    muxTerminalId: string;
    windowName?: string;
    session?: string;
  } {
    if (!this.isAvailable()) {
      throw new Error(
        "Herdr is not available. Install Herdr and start Pi inside a Herdr pane.",
      );
    }
    const session = currentSocketPath();
    const windowName = opts.windowName ?? safeSegment(opts.name);
    const parentPane = opts.parentPane ?? process.env.HERDR_PANE_ID;
    if (!parentPane) throw new Error("Herdr did not provide HERDR_PANE_ID");
    if (opts.background) {
      const parent = this.lookupPaneSync(parentPane, session);
      if (parent.kind !== "found") {
        throw new Error(
          parent.kind === "missing"
            ? `Herdr pane ${parentPane} is no longer available`
            : `Unable to resolve Herdr pane ${parentPane}`,
        );
      }
      const workspaceId = parent.pane.workspace_id;
      if (!workspaceId) {
        throw new Error(
          `Herdr pane ${parentPane} did not include its workspace_id`,
        );
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
      const created = parseCreatedPane(output, "root_pane");
      const stable = requireCreatedPaneIdentity(created, session);
      return {
        ...stable,
        windowName,
        session,
      };
    }

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
    const created = parseCreatedPane(output, "pane");
    const stable = requireCreatedPaneIdentity(created, session);
    return { ...stable, session };
  }

  getPaneLiveness(paneId: string, session?: string): PaneLiveness {
    if (!paneId) return "unknown";
    const result = this.lookupPaneSync(
      this.canonicalPaneId(paneId, session),
      session,
    );
    if (result.kind === "found") {
      this.rememberPane(paneId, session, result.pane);
      return "alive";
    }
    return result.kind === "missing" ? "dead" : "unknown";
  }

  private lookupPaneAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLookupResult> {
    return this.runAsync(["pane", "get", paneId], session).then(
      paneLookupFromCommand,
    );
  }

  async getPaneLivenessAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLiveness> {
    if (!paneId) return "unknown";
    const result = await this.lookupPaneAsync(
      this.canonicalPaneId(paneId, session),
      session,
    );
    if (result.kind === "found") {
      this.rememberPane(paneId, session, result.pane);
      return "alive";
    }
    return result.kind === "missing" ? "dead" : "unknown";
  }

  private runAsync(
    args: readonly string[],
    session?: string,
  ): Promise<HerdrCommandResult> {
    const { promise, resolve } = Promise.withResolvers<HerdrCommandResult>();
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
        (error, stdout, stderr) =>
          resolve({
            error: error ?? undefined,
            stdout: stringFromUnknown(stdout),
            stderr: stringFromUnknown(stderr),
          }),
      );
    } catch (error) {
      resolve({ error, stdout: "", stderr: "" });
    }
    return promise;
  }

  async getPaneActivityAsync(
    _paneId: string,
    _session?: string,
  ): Promise<PaneActivity> {
    // Herdr exposes server-global focus but no stable public attached-client
    // proof, so never infer user attention from pane focus.
    return "unknown";
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
    const target = this.canonicalPaneId(paneId, session);
    try {
      execFileSync("herdr", ["pane", "close", target], {
        stdio: "ignore",
        timeout: HERDR_TIMEOUT_MS,
        env: herdrEnv(session),
      });
    } catch {
      // Best effort — the pane may already have exited or the server may be gone.
    }
  }

  async focusPane(ref: PaneRef): Promise<void> {
    const target = this.canonicalPaneId(ref.paneId, ref.session);
    const response = await requestHerdrSocket(ref.session, "pane.focus", {
      pane_id: target,
    });
    if (response.error || !response.result) {
      throw socketError(response, "pane focus");
    }
    const pane = parsePaneInfo(response.result);
    this.rememberPane(ref.paneId, ref.session, pane);
  }

  async capturePane(
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
      return { output: "", truncated: true };
    }

    const boundedMaxLines = Math.min(maxLines, MAX_HERDR_READ_LINES - 1);
    const boundedMaxBytes = Math.min(maxBytes, MAX_CAPTURE_READ_BYTES);
    const requestedLines = Math.min(maxLines + 1, MAX_HERDR_READ_LINES);
    const response = await requestHerdrSocket(ref.session, "pane.read", {
      pane_id: this.canonicalPaneId(ref.paneId, ref.session),
      source: "recent_unwrapped",
      lines: requestedLines,
      format: "text",
      strip_ansi: true,
    });
    if (response.error || !response.result) {
      throw socketError(response, "pane read");
    }
    const read = parsePaneRead(response.result);
    this.rememberPane(ref.paneId, ref.session, read.pane);
    const bounded = boundCaptureOutput(read.text, {
      maxLines: boundedMaxLines,
      maxBytes: boundedMaxBytes,
    });
    return {
      output: bounded.output,
      truncated:
        read.truncated ||
        bounded.truncated ||
        boundedMaxLines !== maxLines ||
        boundedMaxBytes !== maxBytes,
    };
  }

  buildAttachCommands(opts: {
    paneId: string;
    terminalId?: string;
    windowName?: string;
    session?: string;
  }): { attachCommand: string; focusCommand: string } {
    let terminalId = opts.terminalId;
    if (terminalId === undefined) {
      const target = this.canonicalPaneId(opts.paneId, opts.session);
      const result = this.lookupPaneSync(target, opts.session);
      if (result.kind !== "found") {
        throw new Error(
          result.kind === "missing"
            ? `Herdr pane ${opts.paneId} is no longer available`
            : `Unable to resolve Herdr pane ${opts.paneId}`,
        );
      }
      terminalId = result.pane.terminal_id;
      this.rememberPane(opts.paneId, opts.session, result.pane);
    }
    if (!isStableTerminalId(terminalId)) {
      throw new Error(
        `Herdr pane ${opts.paneId} did not include a stable terminal_id`,
      );
    }
    const command = `HERDR_SOCKET_PATH=${shellEscape(
      socketPathFor(opts.session),
    )} herdr terminal attach ${shellEscape(terminalId)}`;
    return { attachCommand: command, focusCommand: command };
  }

  showNativeViewer(_title: string, _content: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Herdr's snapshot focus is server-global and does not prove an attached
   * full UI client. Keep this indeterminate until Herdr exposes such a proof.
   */
  hasAttachedClientAsync(_session?: string): Promise<boolean | undefined> {
    return Promise.resolve(undefined);
  }

  private canonicalPaneId(paneId: string, session?: string): string {
    return this.paneAliases.get(this.paneAliasKey(paneId, session)) ?? paneId;
  }

  private paneAliasKey(paneId: string, session?: string): string {
    return `${session ?? ""}\n${paneId}`;
  }

  private rememberPane(
    requestedPaneId: string,
    session: string | undefined,
    pane: HerdrPaneInfo,
  ): void {
    this.paneAliases.set(
      this.paneAliasKey(requestedPaneId, session),
      pane.pane_id,
    );
    this.paneAliases.set(
      this.paneAliasKey(pane.pane_id, session),
      pane.pane_id,
    );
  }

  private lookupPaneSync(paneId: string, session?: string): PaneLookupResult {
    try {
      const output = execFileSync("herdr", ["pane", "get", paneId], {
        encoding: "utf8",
        timeout: HERDR_TIMEOUT_MS,
        maxBuffer: MAX_CAPTURE_READ_BYTES,
        env: herdrEnv(session),
      });
      return paneLookupFromCommand({
        error: undefined,
        stdout: stringFromUnknown(output),
        stderr: "",
      });
    } catch (error) {
      return paneLookupFromCommand({
        error,
        stdout: commandErrorOutput(error, "stdout"),
        stderr: commandErrorOutput(error, "stderr"),
      });
    }
  }
}

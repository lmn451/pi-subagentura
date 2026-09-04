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
const MAX_HERDR_PANE_ID_LENGTH = 128;
const PANE_LIVENESS_CACHE_MS = 500;
/**
 * Upper bound on the alias/probe caches. Both are pure caches keyed by
 * `session\npaneId`, and a long-lived Pi can accumulate an entry per pane per
 * workspace move, so cap them and evict the least recently written entry.
 */
const MAX_HERDR_PANE_CACHE_ENTRIES = 512;

/**
 * Conservative shape guard for Herdr pane ids, applied before an id reaches
 * argv — the counterpart to tmux's `/^%\d+$/` and zellij's `/^\d+$/`.
 *
 * Herdr's public ids are workspace-scoped tokens (`w1:p2`, the shape Herdr
 * injects as `HERDR_PANE_ID`). The pattern stays deliberately wider than that
 * one format so a Herdr id-scheme change does not silently disable the
 * backend, while still guaranteeing the two properties argv safety needs: the
 * first character is alphanumeric (an id can never be mistaken for a flag) and
 * the token carries no whitespace, quotes, or control characters.
 */
const HERDR_PANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function isHerdrPaneId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_HERDR_PANE_ID_LENGTH &&
    HERDR_PANE_ID_PATTERN.test(value)
  );
}

function requirePaneId(paneId: string): string {
  if (!isHerdrPaneId(paneId)) {
    // The rejected value is exactly the untrusted input the guard exists to
    // stop, and this message lands in the TUI and the debug log. Quote and
    // truncate it so raw control bytes or an ESC sequence cannot repaint the
    // surface that reports the rejection.
    throw new Error(
      `Unexpected Herdr pane id: ${JSON.stringify(String(paneId).slice(0, 64))}`,
    );
  }
  return paneId;
}

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
    !value.startsWith("-") &&
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
  if (!isRecord(value) || !isHerdrPaneId(value.pane_id)) {
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

/**
 * Insert into a pure cache, evicting the least recently used entry once the
 * map is full.
 *
 * Callers must route reads through this too (re-inserting the value they
 * found), because the recency order is the Map's own insertion order: a read
 * that bypasses it leaves the entry where it was and the cache degrades to
 * FIFO, evicting the pane being actively polled ahead of one nothing has asked
 * about in minutes.
 */
function boundedSet<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  while (cache.size >= MAX_HERDR_PANE_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, value);
}

function closeCreatedPaneBestEffort(paneId: string, session: string): void {
  try {
    execFileSync("herdr", ["pane", "close", requirePaneId(paneId)], {
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
    (isRecord(result.error) && result.error.code === "pane_not_found")
  );
}

function isPaneNotFoundError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  while (current !== undefined && current !== null) {
    if (isRecord(current)) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    if (
      isPaneNotFoundResponse({
        error: current,
        stdout: commandErrorOutput(current, "stdout"),
        stderr: commandErrorOutput(current, "stderr"),
      })
    ) {
      return true;
    }
    current = isRecord(current) ? current.cause : undefined;
  }
  return false;
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
  // Symmetric with zellij's capture timers: a pending deadline must not keep
  // the Pi process alive past the work it is guarding.
  deadline.unref?.();

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

/**
 * Cached `herdr pane get` outcome for a single pane, with in-flight dedup.
 *
 * Herdr deliberately has no pane-list command in the liveness path (a list
 * cannot distinguish "the server does not know this pane" from "the server is
 * unreachable"), so liveness costs one process spawn per pane. The 500ms TTL
 * matches `PANE_LIVENESS_CACHE_MS` in the tmux and zellij backends and keeps a
 * supervisor refresh over N panes to N spawns instead of N per redraw.
 */
interface HerdrPaneProbe {
  cachedAt?: number;
  /** Issue order of the observation in `result`; see `commitProbe`. */
  cachedSeq?: number;
  result?: PaneLookupResult;
  inFlight?: Promise<PaneLookupResult>;
  /**
   * A canonical id this pane's record used to name and that the server has
   * since reported missing. Kept so the remap is not re-trusted the moment the
   * (still cached, still stale) record is read again; see `livenessFrom`.
   */
  retiredCanonical?: string;
}

/** Monotonic issue counter used to order concurrent probes of one pane. */
let nextProbeSeq = 0;

export class HerdrMultiplexer implements Multiplexer {
  readonly name = "herdr" as const;
  readonly capabilities = MUX_CAPABILITIES.herdr;
  private readonly paneAliases = new Map<string, string>();
  private readonly livenessProbes = new Map<string, HerdrPaneProbe>();

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
    // Tab labels are what the user reads in the Herdr tab strip, and
    // `safeSegment(name)` alone collides whenever two sub-agents share a name
    // ("review" twice). Disambiguate with the caller's unique sub-agent id, the
    // same way tmux and zellij derive `pi-subagent-<id>` for their sessions.
    const baseName = opts.windowName ?? safeSegment(opts.name);
    const windowName = opts.id
      ? `${baseName}-${safeSegment(opts.id)}`
      : baseName;
    const parentPane = opts.parentPane ?? process.env.HERDR_PANE_ID;
    if (!parentPane) throw new Error("Herdr did not provide HERDR_PANE_ID");
    // `pane split` takes this id as its first positional, before its flags.
    // Validate it once and use only that binding for the command below.
    const parentPaneId = requirePaneId(parentPane);
    if (opts.background) {
      const parent = this.lookupPaneSync(parentPaneId, session);
      if (parent.kind !== "found") {
        throw new Error(
          parent.kind === "missing"
            ? `Herdr pane ${parentPaneId} is no longer available`
            : `Unable to resolve Herdr pane ${parentPaneId}`,
        );
      }
      const workspaceId = parent.pane.workspace_id;
      if (!workspaceId) {
        throw new Error(
          `Herdr pane ${parentPaneId} did not include its workspace_id`,
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
        // This positional was validated by `requirePaneId` above.
        parentPaneId,
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
    if (!isHerdrPaneId(paneId)) return "unknown";
    const target = this.canonicalPaneId(paneId, session);
    const result = this.probeLivenessSync(target, session);
    if (result.kind === "missing" && target !== paneId) {
      this.retireCanonical(paneId, target, session);
      return this.livenessFrom(
        paneId,
        session,
        this.probeLivenessSync(paneId, session),
      );
    }
    return this.livenessFrom(paneId, session, result);
  }

  async getPaneLivenessAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLiveness> {
    if (!isHerdrPaneId(paneId)) return "unknown";
    const target = this.canonicalPaneId(paneId, session);
    const result = await this.probeLivenessAsync(target, session);
    if (result.kind === "missing" && target !== paneId) {
      this.retireCanonical(paneId, target, session);
      return this.livenessFrom(
        paneId,
        session,
        await this.probeLivenessAsync(paneId, session),
      );
    }
    return this.livenessFrom(paneId, session, result);
  }

  private livenessFrom(
    paneId: string,
    session: string | undefined,
    result: PaneLookupResult,
  ): PaneLiveness {
    if (result.kind === "found") {
      // Do not re-trust a remap onto an id the server has reported missing.
      // The record naming it is cached and keeps being read, so without this
      // the alias would be reinstalled on the very next call, retired again on
      // the one after, and the pair would oscillate — a spawn every other call
      // forever, for a pane that answers perfectly well under its own id.
      if (
        result.pane.pane_id !== this.retiredCanonicalFor(paneId, session) &&
        result.pane.pane_id !== paneId
      ) {
        this.rememberPane(paneId, session, result.pane);
      }
      return "alive";
    }
    return result.kind === "missing" ? "dead" : "unknown";
  }

  private retiredCanonicalFor(
    paneId: string,
    session: string | undefined,
  ): string | undefined {
    return this.livenessProbes.get(this.paneAliasKey(paneId, session))
      ?.retiredCanonical;
  }

  /**
   * A cached canonical id is itself a snapshot: a pane moved twice leaves the
   * first remap pointing at an id the server has already retired. Drop the
   * stale mapping so the caller's own id gets one more chance before the pane
   * is reported dead and the supervisor tears the sub-agent down, and record
   * the retirement so the same remap is not adopted again on the next read.
   *
   * The record is bounded: it lives on the pane's own probe entry and is
   * discarded with it, on eviction or on `killPane`. A genuine later move to a
   * different id still aliases normally.
   */
  private retireCanonical(
    paneId: string,
    staleTarget: string,
    session: string | undefined,
  ): void {
    const callerKey = this.paneAliasKey(paneId, session);
    this.paneAliases.delete(callerKey);
    this.livenessProbes.delete(this.paneAliasKey(staleTarget, session));
    this.livenessProbes.delete(callerKey);
    const callerProbe = this.livenessProbe(paneId, session);
    callerProbe.retiredCanonical = staleTarget;
  }

  /**
   * The probe entry for a pane, created on first use. Reads go through
   * `boundedSet` so a pane under active polling refreshes its recency instead
   * of aging out ahead of one nothing has asked about; the entry's identity is
   * preserved, because `probeLivenessAsync` mutates it after an await.
   */
  private livenessProbe(paneId: string, session?: string): HerdrPaneProbe {
    const key = this.paneAliasKey(paneId, session);
    const probe = this.livenessProbes.get(key) ?? {};
    boundedSet(this.livenessProbes, key, probe);
    return probe;
  }

  private isProbeFresh(probe: HerdrPaneProbe): boolean {
    return (
      probe.result !== undefined &&
      probe.cachedAt !== undefined &&
      Date.now() - probe.cachedAt < PANE_LIVENESS_CACHE_MS
    );
  }

  /**
   * Commit a probe result unless a NEWER observation already landed.
   *
   * Ordering is by issue sequence, not by clock: `Date.now()` has millisecond
   * resolution, so two probes issued in the same millisecond are
   * indistinguishable by time, and a slow async probe would be free to
   * overwrite the fresher sync result that raced past it — restamped `cachedAt:
   * now`, so a pane observed dead would keep reporting alive for another full
   * TTL.
   */
  private commitProbe(
    probe: HerdrPaneProbe,
    issuedSeq: number,
    result: PaneLookupResult,
  ): void {
    if (probe.cachedSeq !== undefined && probe.cachedSeq >= issuedSeq) return;
    probe.cachedSeq = issuedSeq;
    probe.cachedAt = Date.now();
    probe.result = result;
  }

  private probeLivenessSync(
    paneId: string,
    session?: string,
  ): PaneLookupResult {
    const probe = this.livenessProbe(paneId, session);
    if (this.isProbeFresh(probe)) return probe.result!;
    const issuedSeq = nextProbeSeq++;
    const result = this.lookupPaneSync(paneId, session);
    this.commitProbe(probe, issuedSeq, result);
    return result;
  }

  private probeLivenessAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLookupResult> {
    const probe = this.livenessProbe(paneId, session);
    if (this.isProbeFresh(probe)) return Promise.resolve(probe.result!);
    if (probe.inFlight) return probe.inFlight;
    const issuedSeq = nextProbeSeq++;
    const request = this.lookupPaneAsync(paneId, session);
    probe.inFlight = request;
    void request
      .then((result) => this.commitProbe(probe, issuedSeq, result))
      // A rejected probe commits nothing and leaves the previous observation
      // standing; the caller sees the rejection on `request` itself. Swallowed
      // here only so the bookkeeping chain cannot become an unhandled
      // rejection.
      .catch(() => {})
      .finally(() => {
        // Must run on rejection too, or a single failed probe would pin
        // `inFlight` forever and every later call would await a settled,
        // rejected promise instead of retrying.
        if (probe.inFlight === request) probe.inFlight = undefined;
      });
    return request;
  }

  private lookupPaneAsync(
    paneId: string,
    session?: string,
  ): Promise<PaneLookupResult> {
    const target = requirePaneId(paneId);
    return this.runAsync(["pane", "get", target], session).then(
      paneLookupFromCommand,
    );
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

  /**
   * Send literal text to the pane. Resolves the alias first: after a workspace
   * move the caller still holds the pane id `createPane` returned, and messaging
   * a retired id silently drops the agent's follow-up instead of delivering it.
   */
  sendKeys(paneId: string, text: string, session?: string): void {
    this.sendPaneDelivery(paneId, text, "send-text", "pane send-text", session);
  }

  sendEnter(paneId: string, session?: string): void {
    this.sendPaneDelivery(
      paneId,
      "enter",
      "send-keys",
      "pane send-keys enter",
      session,
    );
  }

  private sendPaneDelivery(
    paneId: string,
    value: string,
    command: "send-text" | "send-keys",
    operation: string,
    session?: string,
  ): void {
    const requestedPaneId = requirePaneId(paneId);
    const target = requirePaneId(
      this.canonicalPaneId(requestedPaneId, session),
    );
    try {
      execMuxOrThrow(
        "herdr",
        operation,
        "herdr",
        ["pane", command, target, value],
        { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, env: herdrEnv(session) },
      );
    } catch (error) {
      if (target === requestedPaneId || !isPaneNotFoundError(error)) {
        throw error;
      }
      this.retireCanonical(requestedPaneId, target, session);
      execMuxOrThrow(
        "herdr",
        operation,
        "herdr",
        ["pane", command, requestedPaneId, value],
        { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, env: herdrEnv(session) },
      );
    }
  }

  killPane(paneId: string, session?: string): void {
    if (!isHerdrPaneId(paneId)) return;
    const target = requirePaneId(this.canonicalPaneId(paneId, session));
    try {
      execFileSync("herdr", ["pane", "close", target], {
        stdio: "ignore",
        timeout: HERDR_TIMEOUT_MS,
        env: herdrEnv(session),
      });
    } catch {
      // Best effort — the pane may already have exited or the server may be gone.
    } finally {
      // The id is retired either way; keeping the alias would resolve a future
      // pane id onto a dead one and keeping the probe would report it alive.
      this.forgetPane(paneId, target, session);
    }
  }

  async focusPane(ref: PaneRef): Promise<void> {
    const target = requirePaneId(this.canonicalPaneId(ref.paneId, ref.session));
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
    let requestedLines = Math.min(maxLines + 1, MAX_HERDR_READ_LINES);
    while (true) {
      const response = await requestHerdrSocket(ref.session, "pane.read", {
        pane_id: requirePaneId(this.canonicalPaneId(ref.paneId, ref.session)),
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
      // Strip Herdr's single framing newline, preserving actual blank rows.
      const text = read.text.endsWith("\n")
        ? read.text.slice(0, -1)
        : read.text;
      const bounded = boundCaptureOutput(text, {
        maxLines: boundedMaxLines,
        maxBytes: boundedMaxBytes,
      });
      if (
        !read.truncated ||
        bounded.truncated ||
        requestedLines === MAX_HERDR_READ_LINES
      ) {
        return {
          output: bounded.output,
          truncated:
            read.truncated ||
            bounded.truncated ||
            boundedMaxLines !== maxLines ||
            boundedMaxBytes !== maxBytes,
        };
      }
      // Herdr counts blank viewport rows before unwrapping and stripping them.
      // Widen a sparse read until it supplies enough content or hits our cap.
      requestedLines = Math.min(requestedLines * 2, MAX_HERDR_READ_LINES);
    }
  }

  buildAttachCommands(opts: {
    paneId: string;
    terminalId?: string;
    windowName?: string;
    session?: string;
  }): { attachCommand: string; focusCommand: string } {
    let terminalId = opts.terminalId;
    if (terminalId === undefined) {
      const target = requirePaneId(
        this.canonicalPaneId(opts.paneId, opts.session),
      );
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
    // Herdr 0.8.2 accepts terminal ids only as direct positionals. Validate
    // before shell escaping so a server-provided option-like id cannot be
    // interpreted as a CLI flag; shellEscape protects shell metacharacters.
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
    const key = this.paneAliasKey(paneId, session);
    const canonical = this.paneAliases.get(key);
    if (canonical === undefined) return paneId;
    boundedSet(this.paneAliases, key, canonical);
    return canonical;
  }

  private paneAliasKey(paneId: string, session?: string): string {
    return `${session ?? ""}\n${paneId}`;
  }

  private rememberPane(
    requestedPaneId: string,
    session: string | undefined,
    pane: HerdrPaneInfo,
  ): void {
    if (!isHerdrPaneId(pane.pane_id)) return;
    boundedSet(
      this.paneAliases,
      this.paneAliasKey(requestedPaneId, session),
      pane.pane_id,
    );
    boundedSet(
      this.paneAliases,
      this.paneAliasKey(pane.pane_id, session),
      pane.pane_id,
    );
  }

  private forgetPane(
    requestedPaneId: string,
    canonicalPaneId: string,
    session: string | undefined,
  ): void {
    for (const id of new Set([requestedPaneId, canonicalPaneId])) {
      const key = this.paneAliasKey(id, session);
      this.paneAliases.delete(key);
      this.livenessProbes.delete(key);
    }
  }

  private lookupPaneSync(paneId: string, session?: string): PaneLookupResult {
    const target = requirePaneId(paneId);
    try {
      const output = execFileSync("herdr", ["pane", "get", target], {
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

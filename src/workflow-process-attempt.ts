import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { artifactPath, isTurnTerminal, readEvents } from "./artifact";
import type {
  DurableWorkflowRunId,
  WorkflowAttemptId,
  WorkflowAttemptNumber,
  WorkflowDefinitionPath,
  WorkflowOperationAttempt,
} from "./workflow-run-types";

export const WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_PROCESS_ATTEMPT_MANIFEST_FILE =
  "workflow-process-attempt.json";
export const WORKFLOW_PROCESS_CHILD_STARTED_FILE =
  "workflow-process-child-started.json";
export const WORKFLOW_PROCESS_MANIFEST_ENV = "PI_WORKFLOW_PROCESS_MANIFEST";
export const WORKFLOW_PROCESS_MARKER_ENV = "PI_WORKFLOW_PROCESS_MARKER";
export const WORKFLOW_PROCESS_NONCE_ENV = "PI_WORKFLOW_PROCESS_NONCE";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MARKER_PATTERN = /^wfpa-[a-f0-9]{32}$/;
const AGENT_ID_PATTERN = /^wfpa[a-f0-9]{16}$/;
const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

export interface WorkflowProcessAttemptIdentity {
  readonly runId: DurableWorkflowRunId;
  readonly definitionPath: WorkflowDefinitionPath;
  readonly operationId: string;
  readonly attemptId: WorkflowAttemptId;
  readonly attemptNumber: WorkflowAttemptNumber;
  readonly runEpoch: number;
  readonly nonce: string;
}

export type WorkflowProcessEffectiveIsolation = "process" | "in-process";
export type WorkflowProcessFallbackMode = "none" | "process_unavailable";

/** Immutable, journal-bound intent written before any pane can be created. */
export interface WorkflowProcessAttemptManifest {
  readonly schemaVersion: typeof WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION;
  readonly identity: WorkflowProcessAttemptIdentity;
  readonly launchMarker: string;
  readonly agentId: string;
  readonly paneName: string;
  readonly requestedIsolation: string;
  readonly effectiveIsolation: WorkflowProcessEffectiveIsolation;
  readonly fallbackMode: WorkflowProcessFallbackMode;
  readonly fallbackReason?: string;
}

export interface WorkflowProcessPaneAssignment {
  readonly backend: "tmux" | "zellij";
  readonly paneId: string;
  readonly windowName?: string;
  readonly muxSession?: string;
  readonly artifactDir: string;
  readonly sessionFile: string;
  readonly launchScriptFile: string;
}

export type WorkflowProcessTerminalStatus =
  "done" | "error" | "cancelled" | "process_exit";

export interface WorkflowProcessTerminalEvidence {
  readonly identity: WorkflowProcessAttemptIdentity;
  readonly status: WorkflowProcessTerminalStatus;
  readonly artifactEventId?: string;
  readonly exitCode?: number;
}

export interface WorkflowProcessChildStartedEvidence {
  readonly schemaVersion: typeof WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION;
  readonly identity: WorkflowProcessAttemptIdentity;
  readonly launchMarker: string;
}

/** Runtime bridge carried with one dispatch; identity fields are immutable. */
export interface WorkflowProcessAttemptDispatch {
  readonly mode: "launch" | "adopt";
  readonly manifest: WorkflowProcessAttemptManifest;
  readonly assignment?: WorkflowProcessPaneAssignment;
  readonly launchDispatchedPersisted: boolean;
  readonly childStartedPersisted: boolean;
  readonly terminalPersisted: boolean;
  readonly adoptedPersisted: boolean;
  paneAssigned(assignment: WorkflowProcessPaneAssignment): Promise<void>;
  launchDispatched(assignment: WorkflowProcessPaneAssignment): Promise<void>;
  childStarted(evidence: WorkflowProcessChildStartedEvidence): Promise<void>;
  terminal(evidence: WorkflowProcessTerminalEvidence): Promise<void>;
  adopted(kind: "live" | "terminal"): Promise<void>;
  fenced(
    reason:
      | "orphan_before_assignment"
      | "ambiguous_dispatch"
      | "multiple_marker_matches"
      | "stale_evidence",
    assignment: WorkflowProcessPaneAssignment | undefined,
    probeCount: number,
  ): Promise<void>;
  fallback(reason: string): Promise<void>;
}

export type WorkflowProcessPaneLiveness = "alive" | "dead" | "unknown";

export interface WorkflowProcessAttemptInspector {
  findByMarker(
    marker: string,
  ): Promise<readonly WorkflowProcessPaneAssignment[]>;
  paneLiveness(
    assignment: WorkflowProcessPaneAssignment,
  ): Promise<WorkflowProcessPaneLiveness>;
  terminalEvidence(
    manifest: WorkflowProcessAttemptManifest,
    assignment: WorkflowProcessPaneAssignment | undefined,
  ): Promise<readonly WorkflowProcessTerminalEvidence[]>;
  fence(assignment: WorkflowProcessPaneAssignment): Promise<void>;
  waitBeforeProbe?(probeNumber: number): Promise<void>;
}

export interface WorkflowProcessRecoveryState {
  readonly manifest: WorkflowProcessAttemptManifest;
  readonly assignment?: WorkflowProcessPaneAssignment;
  readonly launchDispatched: boolean;
  readonly childStarted: boolean;
  readonly terminal: boolean;
  readonly adopted: boolean;
  readonly fenced: boolean;
}

export type WorkflowProcessRecoveryResolution =
  | {
      readonly kind: "adopt_terminal";
      readonly assignment?: WorkflowProcessPaneAssignment;
      readonly evidence: WorkflowProcessTerminalEvidence;
      readonly probeCount: number;
      readonly staleEvidenceIgnored: number;
    }
  | {
      readonly kind: "adopt_live";
      readonly assignment: WorkflowProcessPaneAssignment;
      readonly probeCount: number;
      readonly staleEvidenceIgnored: number;
    }
  | {
      readonly kind: "retry";
      readonly probeCount: number;
      readonly staleEvidenceIgnored: number;
    }
  | {
      readonly kind: "fenced";
      readonly reason:
        | "orphan_before_assignment"
        | "ambiguous_dispatch"
        | "multiple_marker_matches";
      readonly assignments: readonly WorkflowProcessPaneAssignment[];
      readonly probeCount: number;
      readonly staleEvidenceIgnored: number;
    };

export interface WorkflowProcessRecoveryOptions {
  readonly maxAmbiguousProbes?: number;
}

export class WorkflowProcessAttemptFencedError extends Error {
  constructor(message = "Ambiguous workflow process attempt was fenced.") {
    super(message);
    this.name = "WorkflowProcessAttemptFencedError";
  }
}
export class WorkflowProcessAttemptFenceIncompleteError extends Error {
  constructor(
    message = "Workflow process attempt could not be safely fenced.",
  ) {
    super(message);
    this.name = "WorkflowProcessAttemptFenceIncompleteError";
  }
}

export function createWorkflowProcessAttemptManifest(
  attempt: WorkflowOperationAttempt,
  runEpoch: number,
  nonce: string,
  requestedIsolation: string,
): WorkflowProcessAttemptManifest {
  if (!Number.isSafeInteger(runEpoch) || runEpoch < 1) {
    throw new Error("Workflow process run epoch must be a positive integer.");
  }
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error("Workflow process nonce is invalid.");
  }
  if (
    typeof requestedIsolation !== "string" ||
    requestedIsolation.length === 0 ||
    requestedIsolation.length > 256
  ) {
    throw new Error("Workflow process requested isolation is invalid.");
  }
  const identity: WorkflowProcessAttemptIdentity = Object.freeze({
    runId: attempt.operation.runId,
    definitionPath: attempt.operation.definitionPath,
    operationId: attempt.operation.operationId,
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    runEpoch,
    nonce,
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return Object.freeze({
    schemaVersion: WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION,
    identity,
    launchMarker: `wfpa-${digest.slice(0, 32)}`,
    agentId: `wfpa${digest.slice(0, 16)}`,
    paneName: `wf-${digest.slice(0, 20)}`,
    requestedIsolation,
    effectiveIsolation: "process",
    fallbackMode: "none",
  });
}

export function workflowProcessAttemptIdentityMatches(
  left: WorkflowProcessAttemptIdentity,
  right: WorkflowProcessAttemptIdentity,
): boolean {
  return (
    left.runId === right.runId &&
    left.definitionPath === right.definitionPath &&
    left.operationId === right.operationId &&
    left.attemptId === right.attemptId &&
    left.attemptNumber === right.attemptNumber &&
    left.runEpoch === right.runEpoch &&
    left.nonce === right.nonce
  );
}

export function isWorkflowProcessAttemptIdentity(
  value: unknown,
): value is WorkflowProcessAttemptIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "runId",
      "definitionPath",
      "operationId",
      "attemptId",
      "attemptNumber",
      "runEpoch",
      "nonce",
    ])
  )
    return false;
  if (
    typeof value.runId !== "string" ||
    typeof value.definitionPath !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.attemptId !== "string" ||
    typeof value.nonce !== "string"
  )
    return false;
  const definitionSegments = value.definitionPath.split("/");
  return (
    value.runId.startsWith("wfr-v1-") &&
    value.runId.length <= 263 &&
    PORTABLE_IDENTIFIER_PATTERN.test(value.runId.slice("wfr-v1-".length)) &&
    value.definitionPath.length > 0 &&
    value.definitionPath.length <= 4096 &&
    definitionSegments[0] === "root" &&
    definitionSegments.length <= 33 &&
    definitionSegments.every((segment) =>
      PORTABLE_IDENTIFIER_PATTERN.test(segment),
    ) &&
    PORTABLE_IDENTIFIER_PATTERN.test(value.operationId) &&
    PORTABLE_IDENTIFIER_PATTERN.test(value.attemptId) &&
    Number.isSafeInteger(value.attemptNumber) &&
    (value.attemptNumber as number) > 0 &&
    Number.isSafeInteger(value.runEpoch) &&
    (value.runEpoch as number) > 0 &&
    NONCE_PATTERN.test(value.nonce)
  );
}

export function isWorkflowProcessAttemptManifest(
  value: unknown,
): value is WorkflowProcessAttemptManifest {
  if (!isRecord(value)) return false;
  const expected =
    value.fallbackReason === undefined
      ? [
          "schemaVersion",
          "identity",
          "launchMarker",
          "agentId",
          "paneName",
          "requestedIsolation",
          "effectiveIsolation",
          "fallbackMode",
        ]
      : [
          "schemaVersion",
          "identity",
          "launchMarker",
          "agentId",
          "paneName",
          "requestedIsolation",
          "effectiveIsolation",
          "fallbackMode",
          "fallbackReason",
        ];
  return (
    hasExactKeys(value, expected) &&
    value.schemaVersion === WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION &&
    isWorkflowProcessAttemptIdentity(value.identity) &&
    typeof value.launchMarker === "string" &&
    MARKER_PATTERN.test(value.launchMarker) &&
    typeof value.agentId === "string" &&
    AGENT_ID_PATTERN.test(value.agentId) &&
    typeof value.paneName === "string" &&
    value.paneName.length > 0 &&
    typeof value.requestedIsolation === "string" &&
    value.requestedIsolation.length > 0 &&
    (value.effectiveIsolation === "process" ||
      value.effectiveIsolation === "in-process") &&
    (value.fallbackMode === "none" ||
      value.fallbackMode === "process_unavailable") &&
    (value.fallbackReason === undefined ||
      typeof value.fallbackReason === "string") &&
    (value.fallbackMode === "none"
      ? value.effectiveIsolation === "process" &&
        value.fallbackReason === undefined
      : value.effectiveIsolation === "in-process" &&
        typeof value.fallbackReason === "string" &&
        value.fallbackReason.length > 0)
  );
}

export function isWorkflowProcessPaneAssignment(
  value: unknown,
): value is WorkflowProcessPaneAssignment {
  if (!isRecord(value)) return false;
  const expected = [
    "backend",
    "paneId",
    ...(value.windowName === undefined ? [] : ["windowName"]),
    ...(value.muxSession === undefined ? [] : ["muxSession"]),
    "artifactDir",
    "sessionFile",
    "launchScriptFile",
  ];
  return (
    hasExactKeys(value, expected) &&
    (value.backend === "tmux" || value.backend === "zellij") &&
    boundedString(value.paneId) &&
    (value.windowName === undefined || boundedString(value.windowName)) &&
    (value.muxSession === undefined || boundedString(value.muxSession)) &&
    absolutePath(value.artifactDir) &&
    absolutePath(value.sessionFile) &&
    absolutePath(value.launchScriptFile)
  );
}

export function isWorkflowProcessChildStartedEvidence(
  value: unknown,
): value is WorkflowProcessChildStartedEvidence {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "identity", "launchMarker"]) &&
    value.schemaVersion === WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION &&
    isWorkflowProcessAttemptIdentity(value.identity) &&
    typeof value.launchMarker === "string" &&
    MARKER_PATTERN.test(value.launchMarker)
  );
}

export function isWorkflowProcessTerminalEvidence(
  value: unknown,
): value is WorkflowProcessTerminalEvidence {
  if (!isRecord(value)) return false;
  const expected = [
    "identity",
    "status",
    ...(value.artifactEventId === undefined ? [] : ["artifactEventId"]),
    ...(value.exitCode === undefined ? [] : ["exitCode"]),
  ];
  return (
    hasExactKeys(value, expected) &&
    isWorkflowProcessAttemptIdentity(value.identity) &&
    ["done", "error", "cancelled", "process_exit"].includes(
      value.status as string,
    ) &&
    (value.artifactEventId === undefined ||
      boundedString(value.artifactEventId)) &&
    (value.exitCode === undefined || Number.isSafeInteger(value.exitCode))
  );
}

export function workflowProcessManifestPath(artifactDir: string): string {
  return join(artifactDir, WORKFLOW_PROCESS_ATTEMPT_MANIFEST_FILE);
}

export function workflowProcessChildStartedPath(artifactDir: string): string {
  return join(artifactDir, WORKFLOW_PROCESS_CHILD_STARTED_FILE);
}

export function writeWorkflowProcessAttemptManifest(
  artifactDir: string,
  manifest: WorkflowProcessAttemptManifest,
): string {
  if (!isWorkflowProcessAttemptManifest(manifest)) {
    throw new Error(
      "Refusing to persist an invalid workflow process manifest.",
    );
  }
  const path = workflowProcessManifestPath(artifactDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = readWorkflowProcessAttemptManifest(path);
    if (!sameManifest(existing, manifest)) {
      throw new Error("Workflow process manifest identity collision.");
    }
    return path;
  }
  atomicJsonWrite(path, manifest);
  return path;
}

export function readWorkflowProcessAttemptManifest(
  path: string,
): WorkflowProcessAttemptManifest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isWorkflowProcessAttemptManifest(value)) {
    throw new Error("Workflow process manifest is invalid.");
  }
  return Object.freeze({
    ...value,
    identity: Object.freeze({ ...value.identity }),
  });
}

/**
 * Child-side pre-provider handshake. It validates the environment against the
 * immutable manifest and persists matching started evidence before returning.
 */
export function persistWorkflowProcessChildStartedFromEnvironment():
  WorkflowProcessChildStartedEvidence | undefined {
  const manifestPath = process.env[WORKFLOW_PROCESS_MANIFEST_ENV];
  if (manifestPath === undefined) return undefined;
  const manifest = readWorkflowProcessAttemptManifest(manifestPath);
  if (
    process.env[WORKFLOW_PROCESS_MARKER_ENV] !== manifest.launchMarker ||
    process.env[WORKFLOW_PROCESS_NONCE_ENV] !== manifest.identity.nonce
  ) {
    throw new Error(
      "Workflow process launch environment is stale or mismatched.",
    );
  }
  const evidence: WorkflowProcessChildStartedEvidence = Object.freeze({
    schemaVersion: WORKFLOW_PROCESS_ATTEMPT_SCHEMA_VERSION,
    identity: manifest.identity,
    launchMarker: manifest.launchMarker,
  });
  const startedPath = workflowProcessChildStartedPath(dirname(manifestPath));
  if (existsSync(startedPath)) {
    const existing: unknown = JSON.parse(readFileSync(startedPath, "utf8"));
    if (
      !isWorkflowProcessChildStartedEvidence(existing) ||
      !workflowProcessAttemptIdentityMatches(
        existing.identity,
        evidence.identity,
      ) ||
      existing.launchMarker !== evidence.launchMarker
    ) {
      throw new Error("Workflow process child-started evidence is stale.");
    }
    return evidence;
  }
  atomicJsonWrite(startedPath, evidence);
  return evidence;
}

export function readWorkflowProcessChildStarted(
  artifactDir: string,
  manifest: WorkflowProcessAttemptManifest,
): WorkflowProcessChildStartedEvidence | undefined {
  const path = workflowProcessChildStartedPath(artifactDir);
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isWorkflowProcessChildStartedEvidence(value) ||
    value.launchMarker !== manifest.launchMarker ||
    !workflowProcessAttemptIdentityMatches(value.identity, manifest.identity)
  ) {
    return undefined;
  }
  return Object.freeze({
    ...value,
    identity: Object.freeze({ ...value.identity }),
  });
}

export async function waitForWorkflowProcessChildStarted(
  artifactDir: string,
  manifest: WorkflowProcessAttemptManifest,
  signal?: AbortSignal,
  maxWaitMs = 5_000,
): Promise<WorkflowProcessChildStartedEvidence> {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 60_000) {
    throw new Error("Workflow process child-start wait bound is invalid.");
  }
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const evidence = readWorkflowProcessChildStarted(artifactDir, manifest);
    if (evidence !== undefined) return evidence;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Workflow process child-start wait aborted.");
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Workflow process child did not persist started evidence.",
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10);
      timer.unref();
    });
  }
}

export function readWorkflowProcessTerminalEvidence(
  artifactDir: string,
  manifest: WorkflowProcessAttemptManifest,
): WorkflowProcessTerminalEvidence | undefined {
  const art = artifactPath(dirname(artifactDir), basename(artifactDir));
  const terminal = readEvents(art).findLast(
    (event) => isTurnTerminal(event) || event.type === "process_exited",
  );
  if (terminal === undefined) return undefined;
  const status =
    terminal.type === "process_exited" ? "process_exit" : terminal.status;
  return Object.freeze({
    identity: manifest.identity,
    status,
    ...("eventId" in terminal ? { artifactEventId: terminal.eventId } : {}),
    ...("exitCode" in terminal && terminal.exitCode !== undefined
      ? { exitCode: terminal.exitCode }
      : {}),
  });
}

/** Deterministic recovery decision. It never returns retry with an unknown live pane. */
export async function recoverWorkflowProcessAttempt(
  state: WorkflowProcessRecoveryState,
  inspector: WorkflowProcessAttemptInspector,
  options: WorkflowProcessRecoveryOptions = {},
): Promise<WorkflowProcessRecoveryResolution> {
  if (state.fenced) {
    return { kind: "retry", probeCount: 0, staleEvidenceIgnored: 0 };
  }
  const terminalEvidence = await inspector.terminalEvidence(
    state.manifest,
    state.assignment,
  );
  let staleEvidenceIgnored = 0;
  for (const evidence of terminalEvidence) {
    if (
      !workflowProcessAttemptIdentityMatches(
        evidence.identity,
        state.manifest.identity,
      )
    ) {
      staleEvidenceIgnored += 1;
      continue;
    }
    return {
      kind: "adopt_terminal",
      assignment: state.assignment,
      evidence,
      probeCount: 0,
      staleEvidenceIgnored,
    };
  }

  const matches = state.assignment
    ? [state.assignment]
    : [...(await inspector.findByMarker(state.manifest.launchMarker))];
  if (matches.length === 0) {
    return { kind: "retry", probeCount: 0, staleEvidenceIgnored };
  }
  if (matches.length > 1) {
    await Promise.all(matches.map((assignment) => inspector.fence(assignment)));
    return {
      kind: "fenced",
      reason: "multiple_marker_matches",
      assignments: Object.freeze(matches),
      probeCount: 0,
      staleEvidenceIgnored,
    };
  }

  const assignment = matches[0]!;
  if (!state.launchDispatched) {
    await inspector.fence(assignment);
    return {
      kind: "fenced",
      reason: "orphan_before_assignment",
      assignments: Object.freeze([assignment]),
      probeCount: 0,
      staleEvidenceIgnored,
    };
  }

  const maxProbes = options.maxAmbiguousProbes ?? 3;
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > 32) {
    throw new Error("Workflow process recovery probe bound is invalid.");
  }
  for (let probeCount = 1; probeCount <= maxProbes; probeCount += 1) {
    const liveness = await inspector.paneLiveness(assignment);
    if (liveness === "alive") {
      return {
        kind: "adopt_live",
        assignment,
        probeCount,
        staleEvidenceIgnored,
      };
    }
    if (liveness === "dead") {
      return { kind: "retry", probeCount, staleEvidenceIgnored };
    }
    if (probeCount < maxProbes) {
      await inspector.waitBeforeProbe?.(probeCount);
    }
  }
  await inspector.fence(assignment);
  return {
    kind: "fenced",
    reason: "ambiguous_dispatch",
    assignments: Object.freeze([assignment]),
    probeCount: maxProbes,
    staleEvidenceIgnored,
  };
}

function atomicJsonWrite(path: string, value: unknown): void {
  const contents = JSON.stringify(value);
  const parent = dirname(path);
  const name = basename(path);
  let collision: NodeJS.ErrnoException | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const tmp = join(parent, `.${name}.${randomBytes(16).toString("hex")}.tmp`);
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(
        tmp,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      writeFileSync(fd, contents, { encoding: "utf8" });
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
      return;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the publication error below.
        }
      }
      if (created) {
        try {
          unlinkSync(tmp);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw cleanupError;
          }
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (!created && (code === "EEXIST" || code === "ELOOP")) {
        collision = error as NodeJS.ErrnoException;
        continue;
      }
      throw error;
    }
  }
  throw collision ?? new Error("Unable to allocate an atomic JSON temp file.");
}

function sameManifest(
  left: WorkflowProcessAttemptManifest,
  right: WorkflowProcessAttemptManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function absolutePath(value: unknown): value is string {
  return boundedString(value) && value.startsWith("/");
}

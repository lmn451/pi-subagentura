import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  INTERACTIVE_ARTIFACT_OWNER_FILE,
  loadInteractiveStates,
  updateInteractiveState,
  type InteractiveSubagentPersistedStateV2,
  type PersistedLifecycleFold,
} from "./artifact";
import {
  buildPiInteractiveCommand,
  getInteractivePaneLivenessAsync,
  type InteractiveSubagentState,
  writeLaunchScript,
} from "./interactive-tmux";
import {
  DEFAULT_MAX_MANIFEST_BYTES,
  nodeManifestPath,
  readLineageManifest,
  resolveLineageStorePathsSync,
  validateLineageManifest,
  writeLineageManifestAtomicSync,
  type LineageManifest,
} from "./interactive-lineage";
import { getMux, safeSegment, type Multiplexer } from "./multiplexer";
import { sessionOwner, type SessionScope } from "./session-scope";
import {
  createDescendantSpawnTreeContext,
  LINEAGE_BOOTSTRAP_ENV,
  writeLineageBootstrap,
} from "./spawn-tree-context";

const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

declare global {
  var __piSubagenturaRecoveriesInFlight: Set<string> | undefined;
}

const recoveriesInFlight = (globalThis.__piSubagenturaRecoveriesInFlight ??=
  new Set<string>());

export interface DirectInteractiveRecoveryPlan {
  childId: string;
  piSessionId: string;
  parentSessionId: string;
  oldPaneId: string;
  sessionFile: string;
  artifactDir: string;
  childCwd: string;
  mux: "tmux" | "zellij";
  lineageRootId: string;
  fingerprint: string;
}

export interface DirectInteractiveRecoveryParams {
  state: InteractiveSubagentState;
  scope: SessionScope;
  parentCwd: string;
}

export interface RecoverDirectInteractiveParams extends DirectInteractiveRecoveryParams {
  expectedFingerprint: string;
}

interface RecoveryInspection {
  plan: DirectInteractiveRecoveryPlan;
  persisted: InteractiveSubagentPersistedStateV2;
  lineage: LineageManifest;
  lineagePath: string;
  systemPromptFile: string;
  runtime: RuntimeSnapshot;
}

interface RuntimeSnapshot {
  paneId: string;
  windowName?: string;
  muxSession?: string;
  attachCommand: string;
  focusCommand: string;
  launchScriptFile: string;
  status: InteractiveSubagentState["status"];
  exitCode?: number;
  lifecycle?: PersistedLifecycleFold;
  ownerSessionId?: string;
  lineageRootId?: string;
  lineageParentAgentId?: string;
}

interface PaneBinding {
  paneId: string;
  windowName?: string;
  muxSession?: string;
  attachCommand: string;
  focusCommand: string;
  launchScriptFile: string;
}

export async function inspectDirectInteractiveRecovery(
  params: DirectInteractiveRecoveryParams,
): Promise<DirectInteractiveRecoveryPlan> {
  return (await inspectRecovery(params)).plan;
}

export async function recoverDirectInteractiveSubagent(
  params: RecoverDirectInteractiveParams,
): Promise<InteractiveSubagentState> {
  const recoveryKey = `${params.scope.id}:${params.scope.generation}:${params.state.id}`;
  if (recoveriesInFlight.has(recoveryKey)) {
    throw new Error("interactive child recovery is already in progress");
  }
  recoveriesInFlight.add(recoveryKey);
  try {
    const inspection = await inspectRecovery(params);
    if (inspection.plan.fingerprint !== params.expectedFingerprint) {
      throw new Error("recovery state changed after confirmation");
    }
    return performRecovery(params, inspection);
  } finally {
    recoveriesInFlight.delete(recoveryKey);
  }
}

async function inspectRecovery(
  params: DirectInteractiveRecoveryParams,
): Promise<RecoveryInspection> {
  const { state, scope } = params;
  assertDirectRecoveryIdentity(params);
  const mux = getMux({ preference: state.mux });
  const liveness = await getInteractivePaneLivenessAsync(state);
  if (liveness === "alive") {
    throw new Error(`interactive child ${state.id} pane is still alive`);
  }
  if (liveness !== "dead") {
    throw new Error(`interactive child ${state.id} pane liveness is unknown`);
  }
  assertNoDuplicateRuntime(state, scope);
  const parentSessionId = currentParentSessionId(scope);
  const persisted = loadPersistedState(
    params.parentCwd,
    state,
    parentSessionId,
  );
  const artifactDir = regularDirectory(state.artifactDir, "artifactDir");
  const sessionFile = regularFile(state.sessionFile, "sessionFile");
  const artifactOwner = readBoundedText(
    join(artifactDir, INTERACTIVE_ARTIFACT_OWNER_FILE),
    2048,
    "artifact owner",
  );
  if (artifactOwner !== parentSessionId) {
    throw new Error("artifact owner does not match current parent session");
  }
  const header = readSessionHeader(sessionFile);
  const lineageInspection = await inspectLineage(
    params,
    parentSessionId,
    artifactDir,
    sessionFile,
    header.cwd,
  );
  const systemPromptFile = findSystemPromptFile(artifactDir);
  const planBase = {
    childId: state.id,
    piSessionId: header.id,
    parentSessionId,
    oldPaneId: state.paneId,
    sessionFile,
    artifactDir,
    childCwd: header.cwd,
    mux: mux.name,
    lineageRootId: lineageInspection.lineage.rootId,
  };
  return {
    plan: {
      ...planBase,
      fingerprint: recoveryFingerprint(
        planBase,
        persisted,
        lineageInspection.lineage,
      ),
    },
    persisted,
    lineage: lineageInspection.lineage,
    lineagePath: lineageInspection.lineagePath,
    systemPromptFile,
    runtime: snapshotRuntime(state),
  };
}

function assertDirectRecoveryIdentity(
  params: DirectInteractiveRecoveryParams,
): void {
  const { state, scope } = params;
  const owner = sessionOwner(scope);
  if (
    scope.lifecycle !== "started" ||
    scope.interactiveStates.get(state.id) !== state
  ) {
    throw new Error(
      "interactive child is not registered in this live parent scope",
    );
  }
  if (
    state.sessionOwner?.id !== owner.id ||
    state.sessionOwner.generation !== owner.generation
  ) {
    throw new Error(
      "interactive child runtime owner does not match parent scope",
    );
  }
  if (canonicalPath(params.parentCwd) !== canonicalPath(state.cwd)) {
    throw new Error("interactive child parent cwd does not match recovery cwd");
  }
  if (
    state.completionOwner === "workflow" ||
    state.workflowOriginId !== undefined ||
    state.workflowResultConsumed === true
  ) {
    throw new Error("workflow-origin children are not recoverable");
  }
  if (state.status === "cancelled") {
    throw new Error("cancelled interactive children cannot be recovered");
  }
  if (!scope.spawnTreeContext) {
    throw new Error("interactive child lineage authority is unavailable");
  }
}

function currentParentSessionId(scope: SessionScope): string {
  const parentSessionId = scope.sessionManager?.getSessionId?.();
  if (!parentSessionId || !SAFE_SESSION_ID.test(parentSessionId)) {
    throw new Error(
      "current parent session identity is unavailable or invalid",
    );
  }
  return parentSessionId;
}

function assertNoDuplicateRuntime(
  state: InteractiveSubagentState,
  scope: SessionScope,
): void {
  for (const candidate of scope.interactiveStates.values()) {
    if (candidate === state) continue;
    if (
      canonicalPath(candidate.sessionFile) ===
        canonicalPath(state.sessionFile) ||
      canonicalPath(candidate.artifactDir) === canonicalPath(state.artifactDir)
    ) {
      throw new Error(
        "duplicate runtime points to the same session or artifact",
      );
    }
  }
}

function loadPersistedState(
  parentCwd: string,
  state: InteractiveSubagentState,
  parentSessionId: string,
): InteractiveSubagentPersistedStateV2 {
  const payload = loadInteractiveStates(parentCwd);
  if (!payload) throw new Error("persisted direct child state is missing");
  if (payload.parent !== "pi" && payload.parent !== parentSessionId) {
    throw new Error(
      "persisted state parent does not match current parent session",
    );
  }
  const entry = payload.states[state.id];
  if (!entry) throw new Error("persisted direct child state is missing");
  if (entry.parentSessionId !== parentSessionId) {
    throw new Error(
      "persisted child owner does not match current parent session",
    );
  }
  assertMatchingField(entry.sessionFile, state.sessionFile, "sessionFile");
  assertMatchingField(entry.artifactDir, state.artifactDir, "artifactDir");
  for (const field of ["paneId", "mux", "muxSession", "windowName"] as const) {
    if (entry[field] !== state[field]) {
      throw new Error(`persisted ${field} does not match runtime state`);
    }
  }
  assertDeliveryStateMatches(state, entry);
  return structuredClone(entry);
}

function assertDeliveryStateMatches(
  state: InteractiveSubagentState,
  entry: InteractiveSubagentPersistedStateV2,
): void {
  const sessionCursor =
    state.sessionObservedByteCursor ?? state.lastDeliveredSessionByte ?? 0;
  const statePartial = state.sessionPartialLineStart ?? null;
  const persistedPartial = entry.sessionPartialLineStart ?? null;
  const mismatches: string[] = [];
  if ((state.eventByteCursor ?? 0) !== entry.eventByteCursor) {
    mismatches.push("eventByteCursor");
  }
  if (sessionCursor !== entry.sessionByteCursor) {
    mismatches.push("sessionByteCursor");
  }
  if (statePartial !== persistedPartial) mismatches.push("partialLineStart");
  if (state.activeTurnId !== entry.activeTurnId)
    mismatches.push("activeTurnId");
  if (
    !isDeepStrictEqual(state.pendingDeliveries ?? [], entry.pendingDeliveries)
  ) {
    mismatches.push("pendingDeliveries");
  }
  if (
    !isDeepStrictEqual(state.deliveryReceipts ?? [], entry.deliveryReceipts)
  ) {
    mismatches.push("deliveryReceipts");
  }
  if (!isDeepStrictEqual(state.lifecycle ?? {}, entry.lifecycle ?? {})) {
    mismatches.push("lifecycle");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `runtime delivery cursor or receipt state does not match persisted state: ${mismatches.join(", ")}`,
    );
  }
}

async function inspectLineage(
  params: DirectInteractiveRecoveryParams,
  parentSessionId: string,
  artifactDir: string,
  sessionFile: string,
  childCwd: string,
): Promise<{ lineage: LineageManifest; lineagePath: string }> {
  const context = params.scope.spawnTreeContext!;
  const paths = resolveLineageStorePathsSync(
    context.sessionRoot,
    context.rootId,
  );
  const lineagePath = nodeManifestPath(paths.nodesDir, params.state.id);
  const lineage = await readLineageManifest(lineagePath);
  if (lineage.agentId !== params.state.id) {
    throw new Error("lineage child ID does not match runtime state");
  }
  if (lineage.runtimeKind === "workflow") {
    throw new Error("workflow-origin lineage is not recoverable");
  }
  if (
    lineage.rootId !== context.rootId ||
    lineage.ownerSessionId !== parentSessionId
  ) {
    throw new Error("lineage owner does not match current parent session");
  }
  if (lineage.parentAgentId !== context.currentAgentId) {
    throw new Error("lineage parent does not match current orchestrator");
  }
  assertMatchingField(lineage.artifactDir, artifactDir, "lineage artifactDir");
  assertMatchingField(
    lineage.childSessionFile,
    sessionFile,
    "lineage sessionFile",
  );
  assertMatchingField(lineage.cwd, childCwd, "lineage cwd");
  if (
    lineage.pane.backend !== params.state.mux ||
    lineage.pane.paneId !== params.state.paneId ||
    lineage.pane.muxSession !== params.state.muxSession ||
    lineage.pane.windowName !== params.state.windowName
  ) {
    throw new Error("lineage pane pointer does not match runtime state");
  }
  return { lineage, lineagePath };
}

function performRecovery(
  params: DirectInteractiveRecoveryParams,
  inspection: RecoveryInspection,
): InteractiveSubagentState {
  const { state, scope } = params;
  const mux = getMux({ preference: inspection.plan.mux });
  const created = mux.createPane({
    name: state.name,
    cwd: inspection.plan.childCwd,
    background: true,
    windowName: safeSegment(`${state.name}-recovered`),
    id: state.id,
  });
  const binding: PaneBinding = {
    paneId: created.paneId,
    windowName: created.windowName,
    muxSession: created.session,
    attachCommand: "",
    focusCommand: "",
    launchScriptFile: join(inspection.plan.artifactDir, "recovery-launch.sh"),
  };
  let bootstrapPath: string | undefined;
  let persistedUpdated = false;
  let lineageUpdated = false;
  try {
    const attach = mux.buildAttachCommands({
      paneId: binding.paneId,
      windowName: binding.windowName,
      session: binding.muxSession,
    });
    binding.attachCommand = attach.attachCommand;
    binding.focusCommand = attach.focusCommand;
    bootstrapPath = prepareRecoveryLaunch(scope, inspection, state, binding);
    // Start the replacement before changing durable authority. The parent state
    // pointer commits last, after lineage, so a crash cannot authorize an empty
    // shell or a pane whose lineage still points at the dead runtime.
    startRecoveryProcess(mux, binding);
    assertLineageUnchanged(inspection);
    writeLineageManifestAtomicSync(
      dirname(inspection.lineagePath),
      recoveredLineage(inspection.lineage, mux, binding),
    );
    lineageUpdated = true;
    updatePersistedBinding(params.parentCwd, inspection, binding);
    persistedUpdated = true;
    applyRuntimeBinding(state, inspection, binding);
    return state;
  } catch (error) {
    const rollbackErrors = rollbackRecovery(
      params,
      inspection,
      binding,
      persistedUpdated,
      lineageUpdated,
      bootstrapPath,
      mux,
    );
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${errorText(error)}; recovery rollback incomplete: ${rollbackErrors.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function prepareRecoveryLaunch(
  scope: SessionScope,
  inspection: RecoveryInspection,
  state: InteractiveSubagentState,
  binding: PaneBinding,
): string {
  const descendant = createDescendantSpawnTreeContext(
    scope.spawnTreeContext!,
    state.id,
    inspection.plan.artifactDir,
  );
  const bootstrapPath = writeLineageBootstrap(
    inspection.plan.artifactDir,
    descendant,
  );
  const command = buildPiInteractiveCommand({
    sessionFile: inspection.plan.sessionFile,
    name: state.name,
    systemPromptFile: inspection.systemPromptFile,
    cwd: inspection.plan.childCwd,
  });
  writeLaunchScript(
    binding.launchScriptFile,
    command,
    inspection.plan.artifactDir,
    { [LINEAGE_BOOTSTRAP_ENV]: bootstrapPath },
  );
  return bootstrapPath;
}

function updatePersistedBinding(
  parentCwd: string,
  inspection: RecoveryInspection,
  binding: PaneBinding,
): void {
  updateInteractiveState(parentCwd, inspection.plan.childId, (entry) => {
    if (JSON.stringify(entry) !== JSON.stringify(inspection.persisted)) {
      throw new Error("recovery state changed after confirmation");
    }
    entry.paneId = binding.paneId;
    entry.windowName = binding.windowName;
    entry.muxSession = binding.muxSession;
    entry.lifecycle = clearProcessLifecycle(entry.lifecycle);
  });
  const updated =
    loadInteractiveStates(parentCwd)?.states[inspection.plan.childId];
  if (!updated || updated.paneId !== binding.paneId) {
    throw new Error("recovered pane binding was not persisted");
  }
}

function recoveredLineage(
  lineage: LineageManifest,
  mux: Multiplexer,
  binding: PaneBinding,
): LineageManifest {
  return {
    ...lineage,
    pane: {
      backend: mux.name,
      paneId: binding.paneId,
      ...(binding.muxSession ? { muxSession: binding.muxSession } : {}),
      ...(binding.windowName ? { windowName: binding.windowName } : {}),
    },
  };
}

function assertLineageUnchanged(inspection: RecoveryInspection): void {
  if (statSync(inspection.lineagePath).size > DEFAULT_MAX_MANIFEST_BYTES) {
    throw new Error("lineage manifest changed after confirmation");
  }
  const content = readFileSync(inspection.lineagePath, "utf8");
  if (Buffer.byteLength(content) > DEFAULT_MAX_MANIFEST_BYTES) {
    throw new Error("lineage manifest changed after confirmation");
  }
  const current = validateLineageManifest(JSON.parse(content));
  if (JSON.stringify(current) !== JSON.stringify(inspection.lineage)) {
    throw new Error("lineage manifest changed after confirmation");
  }
}

function applyRuntimeBinding(
  state: InteractiveSubagentState,
  inspection: RecoveryInspection,
  binding: PaneBinding,
): void {
  state.paneId = binding.paneId;
  state.windowName = binding.windowName;
  state.muxSession = binding.muxSession;
  state.attachCommand = binding.attachCommand;
  state.selectPaneCommand = binding.focusCommand;
  state.launchScriptFile = binding.launchScriptFile;
  // The child launch script appends `started`; the next artifact fold moves
  // this to idle without allowing a follow-up to race Pi startup.
  state.status = "unknown";
  state.exitCode = undefined;
  state.lifecycle = clearProcessLifecycle(state.lifecycle);
  state.ownerSessionId = inspection.plan.parentSessionId;
  state.lineageRootId = inspection.lineage.rootId;
  state.lineageParentAgentId = inspection.lineage.parentAgentId;
}

function startRecoveryProcess(mux: Multiplexer, binding: PaneBinding): void {
  const quoted = `'${binding.launchScriptFile.replace(/'/g, `'\\''`)}'`;
  mux.sendKeys(binding.paneId, `exec bash ${quoted}`, binding.muxSession);
  mux.sendEnter(binding.paneId, binding.muxSession);
}

function rollbackRecovery(
  params: DirectInteractiveRecoveryParams,
  inspection: RecoveryInspection,
  binding: PaneBinding,
  persistedUpdated: boolean,
  lineageUpdated: boolean,
  bootstrapPath: string | undefined,
  mux: Multiplexer,
): string[] {
  const errors: string[] = [];
  if (lineageUpdated) {
    try {
      writeLineageManifestAtomicSync(
        dirname(inspection.lineagePath),
        inspection.lineage,
      );
    } catch (error) {
      errors.push(`lineage restore failed: ${errorText(error)}`);
    }
  }
  if (persistedUpdated) {
    try {
      restorePersistedState(params.parentCwd, inspection, binding);
    } catch (error) {
      errors.push(`state restore failed: ${errorText(error)}`);
    }
  }
  restoreRuntimeState(params.state, inspection.runtime);
  if (bootstrapPath) {
    try {
      rmSync(bootstrapPath, { force: true });
    } catch (error) {
      errors.push(`bootstrap cleanup failed: ${errorText(error)}`);
    }
  }
  try {
    mux.killPane(binding.paneId, binding.muxSession);
  } catch (error) {
    errors.push(`pane cleanup failed: ${errorText(error)}`);
  }
  return errors;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restorePersistedState(
  parentCwd: string,
  inspection: RecoveryInspection,
  binding: PaneBinding,
): void {
  updateInteractiveState(parentCwd, inspection.plan.childId, (entry) => {
    if (
      entry.paneId !== binding.paneId ||
      entry.muxSession !== binding.muxSession
    ) {
      throw new Error("recovery rollback lost pane binding ownership");
    }
    const target = entry as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(inspection.persisted));
  });
}

function restoreRuntimeState(
  state: InteractiveSubagentState,
  runtime: RuntimeSnapshot,
): void {
  state.paneId = runtime.paneId;
  state.windowName = runtime.windowName;
  state.muxSession = runtime.muxSession;
  state.attachCommand = runtime.attachCommand;
  state.selectPaneCommand = runtime.focusCommand;
  state.launchScriptFile = runtime.launchScriptFile;
  state.status = runtime.status;
  state.exitCode = runtime.exitCode;
  state.lifecycle = runtime.lifecycle
    ? structuredClone(runtime.lifecycle)
    : undefined;
  state.ownerSessionId = runtime.ownerSessionId;
  state.lineageRootId = runtime.lineageRootId;
  state.lineageParentAgentId = runtime.lineageParentAgentId;
}

function snapshotRuntime(state: InteractiveSubagentState): RuntimeSnapshot {
  return {
    paneId: state.paneId,
    windowName: state.windowName,
    muxSession: state.muxSession,
    attachCommand: state.attachCommand,
    focusCommand: state.selectPaneCommand,
    launchScriptFile: state.launchScriptFile,
    status: state.status,
    exitCode: state.exitCode,
    lifecycle: state.lifecycle ? structuredClone(state.lifecycle) : undefined,
    ownerSessionId: state.ownerSessionId,
    lineageRootId: state.lineageRootId,
    lineageParentAgentId: state.lineageParentAgentId,
  };
}

function clearProcessLifecycle(
  lifecycle: PersistedLifecycleFold | undefined,
): PersistedLifecycleFold | undefined {
  if (!lifecycle) return undefined;
  const next = structuredClone(lifecycle);
  delete next.processStatus;
  delete next.processExitCode;
  return next;
}

function recoveryFingerprint(
  plan: Omit<DirectInteractiveRecoveryPlan, "fingerprint">,
  persisted: InteractiveSubagentPersistedStateV2,
  lineage: LineageManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ plan, persisted, lineage }))
    .digest("hex");
}

function readSessionHeader(sessionFile: string): { id: string; cwd: string } {
  const firstLine = readFirstLine(sessionFile, SESSION_HEADER_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new Error("child session JSONL header is malformed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("child session JSONL header is missing");
  }
  const header = parsed as Record<string, unknown>;
  if (
    header.type !== "session" ||
    typeof header.id !== "string" ||
    !SAFE_SESSION_ID.test(header.id) ||
    typeof header.cwd !== "string"
  ) {
    throw new Error("child session JSONL header identity is invalid");
  }
  return { id: header.id, cwd: regularDirectory(header.cwd, "session cwd") };
}

function readFirstLine(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) throw new Error("session header exceeds byte limit");
    return buffer.subarray(0, newline).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function findSystemPromptFile(artifactDir: string): string {
  const candidates = readdirSync(artifactDir)
    .filter((name) => name.endsWith("-system.md"))
    .map((name) => join(artifactDir, name));
  if (candidates.length !== 1) {
    throw new Error("artifact must contain exactly one child system prompt");
  }
  return regularFile(candidates[0]!, "system prompt");
}

function regularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return realpathSync(absolute);
}

function regularDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return realpathSync(absolute);
}

function readBoundedText(
  path: string,
  maxBytes: number,
  label: string,
): string {
  const file = regularFile(path, label);
  if (statSync(file).size > maxBytes) {
    throw new Error(`${label} exceeds byte limit`);
  }
  const content = readFileSync(file, "utf8");
  if (Buffer.byteLength(content) > maxBytes) {
    throw new Error(`${label} exceeds byte limit`);
  }
  return content;
}

function assertMatchingField(
  persisted: string | undefined,
  runtime: string,
  label: string,
): void {
  if (!persisted || canonicalPath(persisted) !== canonicalPath(runtime)) {
    throw new Error(`${label} does not match recorded runtime state`);
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

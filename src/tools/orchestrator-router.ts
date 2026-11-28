import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isOrchestratorV2Enabled } from "../completion-turn";
import {
  createRoutingEngine,
  isForceJevEnabled,
  isRoutingConfigured,
  isRoutingEnabled,
} from "../routing-factory";
import {
  listOrchestratorRoutingAuthorityEntries,
  loadOrchestratorAgentRegistryView,
  type OrchestratorAgentRegistryView,
  type OrchestratorAgentView,
} from "../orchestrator-routing";
import type { InteractiveSubagentState } from "../interactive-tmux";
import {
  resolveLiveSessionScope,
  resolveToolSessionScope,
  sessionOwner,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";
import { registerToolWithDefaultGuidance } from "../tool-guidance";
import type {
  RoutingCandidate,
  RoutingDecision,
  RoutingEngine,
  RoutingErrorReason,
  RoutingEvidence,
  RoutingNoMatchReason,
} from "../routing-engine";
import { isValidRoutingEvidence } from "../routing-engine";
import { isOrchestratorSplitEnabled } from "../settings";

/** Maximum task size handed to the provider adapter. */
export const MAX_ORCHESTRATOR_ROUTE_TASK_BYTES = 16 * 1024;

const MAX_ORCHESTRATOR_ROUTE_TASK_CHARS = 16 * 1024;

const ResolveOrchestratorRouteParams = Type.Object({
  part: Type.Optional(
    Type.Boolean({
      description: "Set true only for one independent part after split_needed.",
    }),
  ),
  routingDescription: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_ORCHESTRATOR_ROUTE_TASK_CHARS,
      description:
        "Minimal classifier-safe description of action, scope, deliverable, and required access for the whole request or one part. No embedded work material, secrets, private excerpts, or full request text. If a safe description is insufficient, do not call. Do not combine with task.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_ORCHESTRATOR_ROUTE_TASK_CHARS,
      description:
        "Classifier-safe description for legacy optional non-split callers only. Use routingDescription for new calls. Never supply both fields or use task for forced or split routing.",
    }),
  ),
});

interface RouteInput {
  routingDescription?: string;
  task?: string;
  part?: boolean;
}

function readRoutingDescription(
  input: RouteInput | undefined,
  legacyAllowed: boolean,
): string | undefined {
  if (!input || (input.part !== undefined && typeof input.part !== "boolean")) {
    return undefined;
  }
  if (input.task === undefined) return input.routingDescription;
  if (
    !legacyAllowed ||
    input.part !== undefined ||
    input.routingDescription !== undefined
  ) {
    return undefined;
  }
  return input.task;
}

const ROUTING_ERROR_REASONS: ReadonlySet<string> = new Set([
  "disabled",
  "invalid_config",
  "invalid_input",
  "payload_too_large",
  "planning_limit",
  "timeout",
  "unavailable",
  "invalid_response",
  "state_changed",
  "incomplete_registry",
]);
const ROUTING_NO_MATCH_REASONS: ReadonlySet<string> = new Set([
  "new_child_recommended",
  "low_confidence",
  "ambiguous",
]);

interface UserRequestIdentity {
  id: string;
}

interface CandidateSnapshot {
  candidate: RoutingCandidate;
  state: InteractiveSubagentState;
  runtime: RuntimeSnapshot;
  view: OrchestratorAgentView;
}

interface RuntimeSnapshot {
  id: string;
  paneId?: string;
  windowName?: string;
  mux: InteractiveSubagentState["mux"];
  muxSession?: string;
  muxServer?: string;
  sessionFile: string;
  cwd: string;
  workingCwd?: string;
  artifactDir: string;
  startedAt: number;
  sessionOwner?: { id: number; generation: number };
  supervisorOwner?: { id: number; generation: number };
  parentSessionId?: string;
  workflowId?: string;
  completionOwner?: "standalone" | "workflow";
}

interface RouterRegistrationOptions {
  createEngine?: () => RoutingEngine | undefined;
  modelRegistry?: unknown;
}

/**
 * Register the configured routing advisor. The registration gate is repeated
 * here because this helper is also used directly by focused tests and hosts.
 */
export function registerOrchestratorRouterTool(
  pi: ExtensionAPI,
  registrationScope?: SessionScope,
  options: RouterRegistrationOptions = {},
): boolean {
  if (!isOrchestratorV2Enabled(pi)) return false;
  const forceJev = isForceJevEnabled(pi);
  if (!isRoutingConfigured(process.env, forceJev)) return false;
  // Forced mode needs an explicit unavailable result, even on older Pi hosts.
  if (
    !forceJev &&
    !options.createEngine &&
    !isRoutingEnabled(process.env, options.modelRegistry)
  ) {
    return false;
  }

  const toolToken: SessionToolToken | undefined = registrationScope
    ? { id: registrationScope.id }
    : undefined;

  registerToolWithDefaultGuidance(pi, {
    name: "resolve_orchestrator_route",
    label: "Resolve Orchestrator Route",
    description:
      "Ask the enabled advisor to assess a classifier-safe routing description, not a worker handoff. In split mode, assess the whole description first, then use part=true for each separate part only after split_needed. The tool only advises; it never sends, spawns, attaches, or reserves a child.",
    parameters: ResolveOrchestratorRouteParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let usage: Usage | undefined;
      const forceJev = isForceJevEnabled(pi);
      const createNativeEngine = () =>
        createRoutingEngine({
          forceJev,
          modelRegistry: ctx.modelRegistry,
          onUsage: (sample) => {
            usage = sample;
          },
        });
      const result = await resolveOrchestratorRoute({
        pi,
        toolToken,
        params,
        signal,
        ctx,
        forceJev,
        createEngine: forceJev
          ? createNativeEngine
          : (options.createEngine ?? createNativeEngine),
      });
      return { ...result, ...(usage ? { usage } : {}) };
    },
  });
  return true;
}

const splitBudgets = new WeakMap<
  SessionScope,
  { owner: ReturnType<typeof sessionOwner>; requestId?: string; calls: number }
>();
async function resolveOrchestratorRoute(params: {
  pi: ExtensionAPI;
  toolToken: SessionToolToken | undefined;
  params: RouteInput;
  signal?: AbortSignal;
  ctx: unknown;
  forceJev: boolean;
  createEngine?: () => RoutingEngine | undefined;
}): Promise<RoutingAdviceResult> {
  let decision: RoutingDecision;
  if (
    !isOrchestratorV2Enabled(params.pi) ||
    !isRoutingConfigured(process.env, params.forceJev)
  ) {
    decision = errorDecision("disabled");
    return routingAdviceResult(decision);
  }
  if (params.signal?.aborted) {
    return routingAdviceResult({ kind: "cancelled" });
  }

  const scope = resolveToolSessionScope(params.toolToken);
  if (!scope) {
    return routingAdviceResult({ kind: "cancelled" });
  }

  const split = isOrchestratorSplitEnabled(params.pi);
  const description = readRoutingDescription(
    params.params,
    !params.forceJev && !split,
  );
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    Buffer.byteLength(description, "utf8") > MAX_ORCHESTRATOR_ROUTE_TASK_BYTES
  ) {
    return routingAdviceResult(errorDecision("invalid_input"));
  }
  const cwd = contextCwd(params.ctx, scope);
  if (!cwd) return routingAdviceResult(errorDecision("invalid_input"));

  const owner = sessionOwner(scope);
  const sessionId = sessionIdForScope(scope);
  const requestIdentity = latestUserRequestIdentity(params.ctx);
  const authorityEntries = parentBranchEntries(params.ctx);
  let initialAuthority: ReturnType<typeof routingAuthoritySnapshot>;
  let initialAuthorityUnchanged: boolean;
  let initialView: OrchestratorAgentRegistryView;
  try {
    initialAuthority = routingAuthoritySnapshot(cwd, authorityEntries);
    initialView = await loadOrchestratorAgentRegistryView(
      cwd,
      scope.interactiveStates,
      {
        signal: params.signal,
        authorityEntries,
      },
    );
    initialAuthorityUnchanged =
      initialAuthority.digest ===
      routingAuthoritySnapshot(cwd, parentBranchEntries(params.ctx)).digest;
  } catch {
    if (params.signal?.aborted) {
      return routingAdviceResult({ kind: "cancelled" });
    }
    if (
      !isCurrentSession(scope, owner) ||
      !sameUserRequest(requestIdentity, latestUserRequestIdentity(params.ctx))
    ) {
      return routingAdviceResult({ kind: "cancelled" });
    }
    return routingAdviceResult(errorDecision("incomplete_registry"));
  }
  if (params.signal?.aborted) {
    return routingAdviceResult({ kind: "cancelled" });
  }

  const initialCandidates = eligibleCandidates(
    initialView,
    scope,
    owner,
    sessionId,
  );
  if (
    !isCurrentSession(scope, owner) ||
    !sameUserRequest(requestIdentity, latestUserRequestIdentity(params.ctx))
  ) {
    return routingAdviceResult({ kind: "cancelled" });
  }
  if (!initialAuthorityUnchanged) {
    return routingAdviceResult(errorDecision("state_changed"));
  }
  const trustedIds = initialAuthority.childIds;
  if (
    registryIncomplete(initialView, trustedIds, scope, owner, sessionId) ||
    (initialCandidates.length === 0 &&
      hasUncertainRoutingOwner(
        initialView,
        trustedIds,
        scope,
        owner,
        sessionId,
      ))
  ) {
    return routingAdviceResult(errorDecision("incomplete_registry"));
  }
  const assessSplit = split;
  if (initialCandidates.length === 0 && !assessSplit) {
    return routingAdviceResult({
      kind: "no_match",
      reason: "new_child_recommended",
    });
  }

  const snapshots = initialCandidates.map((entry) => ({
    candidate: entry.candidate,
    state: entry.state,
    runtime: entry.runtime,
    view: entry.view,
  }));
  const input = {
    ...(assessSplit ? { assessSplit } : {}),
    task: description,
    candidates: snapshots.map(({ candidate }) => candidate),
  };

  let engineDecision: unknown;
  try {
    const engine = params.createEngine?.();
    if (!engine) return routingAdviceResult(errorDecision("unavailable"));
    if (assessSplit) {
      let budget = splitBudgets.get(scope);
      if (
        !budget ||
        budget.owner.generation !== owner.generation ||
        budget.requestId !== requestIdentity?.id
      ) {
        budget = { owner, requestId: requestIdentity?.id, calls: 0 };
        splitBudgets.set(scope, budget);
      }
      if (budget.calls >= 32)
        return routingAdviceResult(errorDecision("planning_limit"));
      budget.calls++;
    }
    engineDecision = await engine.decide(input, params.signal);
  } catch {
    if (params.signal?.aborted) {
      return routingAdviceResult({ kind: "cancelled" });
    }
    if (
      !isCurrentSession(scope, owner) ||
      !sameUserRequest(requestIdentity, latestUserRequestIdentity(params.ctx))
    ) {
      return routingAdviceResult({ kind: "cancelled" });
    }
    return routingAdviceResult(errorDecision("unavailable"));
  }
  if (params.signal?.aborted) {
    return routingAdviceResult({ kind: "cancelled" });
  }
  if (
    !isCurrentSession(scope, owner) ||
    !sameUserRequest(requestIdentity, latestUserRequestIdentity(params.ctx))
  ) {
    return routingAdviceResult({ kind: "cancelled" });
  }

  decision = sanitizeDecision(engineDecision, snapshots, assessSplit);
  if (decision.kind === "cancelled") {
    return routingAdviceResult(decision);
  }
  if (decision.kind === "error") {
    return routingAdviceResult(decision);
  }

  let currentView: OrchestratorAgentRegistryView;
  let authorityUnchanged: boolean;
  try {
    const currentAuthorityEntries = parentBranchEntries(params.ctx);
    if (
      initialAuthority.digest !==
      routingAuthoritySnapshot(cwd, currentAuthorityEntries).digest
    ) {
      return routingAdviceResult(errorDecision("state_changed"));
    }
    currentView = await loadOrchestratorAgentRegistryView(
      cwd,
      scope.interactiveStates,
      {
        signal: params.signal,
        authorityEntries: currentAuthorityEntries,
      },
    );
    // Liveness probes yield; recheck the same authority after the projection.
    authorityUnchanged =
      initialAuthority.digest ===
      routingAuthoritySnapshot(cwd, parentBranchEntries(params.ctx)).digest;
  } catch {
    if (params.signal?.aborted) {
      return routingAdviceResult({ kind: "cancelled" });
    }
    if (
      !isCurrentSession(scope, owner) ||
      !sameUserRequest(requestIdentity, latestUserRequestIdentity(params.ctx))
    ) {
      return routingAdviceResult({ kind: "cancelled" });
    }
    return routingAdviceResult(errorDecision("state_changed"));
  }
  if (params.signal?.aborted) {
    return routingAdviceResult({ kind: "cancelled" });
  }
  if (
    !isCurrentSession(scope, owner) ||
    !sameUserRequest(requestIdentity, latestUserRequestIdentity(params.ctx))
  ) {
    return routingAdviceResult({ kind: "cancelled" });
  }
  if (
    !authorityUnchanged ||
    !snapshotsMatchCurrentView(
      snapshots,
      currentView,
      trustedIds,
      scope,
      owner,
      sessionId,
    )
  ) {
    return routingAdviceResult(errorDecision("state_changed"));
  }
  if (
    decision.kind === "no_match" &&
    decision.reason === "new_child_recommended" &&
    hasUncertainRoutingOwner(currentView, trustedIds, scope, owner, sessionId)
  ) {
    return routingAdviceResult(errorDecision("incomplete_registry"));
  }

  return routingAdviceResult(decision, assessSplit);
}

function routingAuthoritySnapshot(
  cwd: string,
  authorityEntries: readonly unknown[],
): { digest: string; childIds: string[] } {
  const records = listOrchestratorRoutingAuthorityEntries(
    cwd,
    authorityEntries,
  );
  records.sort((left, right) => left.childId.localeCompare(right.childId));
  return {
    digest: JSON.stringify(records),
    childIds: records.map(({ childId }) => childId),
  };
}

function contextCwd(ctx: unknown, scope: SessionScope): string | undefined {
  if (ctx && typeof ctx === "object") {
    const cwd = (ctx as { cwd?: unknown }).cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return typeof scope.cwd === "string" && scope.cwd.length > 0
    ? scope.cwd
    : undefined;
}

function sessionIdForScope(scope: SessionScope): string | undefined {
  try {
    return scope.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function parentBranchEntries(ctx: unknown): readonly unknown[] {
  if (!ctx || typeof ctx !== "object") return [];
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!sessionManager || typeof sessionManager !== "object") return [];
  const getBranch = (sessionManager as { getBranch?: unknown }).getBranch;
  if (typeof getBranch !== "function") return [];
  try {
    const branch = getBranch.call(sessionManager);
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

function latestUserRequestIdentity(
  ctx: unknown,
): UserRequestIdentity | undefined {
  const branch = parentBranchEntries(ctx);
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; type?: unknown; message?: unknown };
    if (record.type !== "message" || typeof record.id !== "string") continue;
    if (!record.message || typeof record.message !== "object") continue;
    if ((record.message as { role?: unknown }).role !== "user") continue;
    return { id: record.id };
  }
  return undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function eligibleCandidates(
  view: OrchestratorAgentRegistryView,
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): CandidateSnapshot[] {
  const snapshots: CandidateSnapshot[] = [];
  for (const agent of view.agents) {
    if (!agent.actionable || agent.stale || agent.liveness !== "alive") {
      continue;
    }
    if (agent.status !== "running" && agent.status !== "idle") continue;
    if (
      typeof agent.description !== "string" ||
      agent.description.length === 0
    ) {
      continue;
    }
    const state = scope.interactiveStates.get(agent.childId);
    if (!state || !isStandaloneRoutingRuntime(state, owner, sessionId)) {
      continue;
    }
    const candidate: RoutingCandidate = {
      childId: agent.childId,
      description: agent.description,
      ...(agent.aliases === undefined ? {} : { aliases: [...agent.aliases] }),
      status: agent.status,
    };
    snapshots.push({
      candidate,
      state,
      runtime: snapshotRuntime(state),
      view: agent,
    });
  }
  snapshots.sort((left, right) =>
    left.candidate.childId.localeCompare(right.candidate.childId),
  );
  return snapshots;
}

function directRuntimeBelongsToScope(
  state: {
    sessionOwner?: { id: number; generation: number };
    supervisorOwner?: { id: number; generation: number };
    parentSessionId?: string;
  },
  owner: { id: number; generation: number },
  sessionId: string | undefined,
): boolean {
  const runtimeOwner = state.sessionOwner ?? state.supervisorOwner;
  if (runtimeOwner) {
    if (
      runtimeOwner.id !== owner.id ||
      runtimeOwner.generation !== owner.generation
    ) {
      return false;
    }
  } else if (sessionId === undefined || state.parentSessionId !== sessionId) {
    return false;
  }
  return (
    sessionId === undefined ||
    state.parentSessionId === undefined ||
    state.parentSessionId === sessionId
  );
}

function isStandaloneRoutingRuntime(
  state: InteractiveSubagentState,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): boolean {
  return (
    state.workflowId === undefined &&
    state.completionOwner !== "workflow" &&
    directRuntimeBelongsToScope(state, owner, sessionId)
  );
}

function registryIncomplete(
  view: OrchestratorAgentRegistryView,
  trustedIds: readonly string[],
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): boolean {
  if (view.omitted <= 0) return false;
  const represented = new Set(view.agents.map((agent) => agent.childId));
  return trustedIds.some((childId) => {
    if (represented.has(childId)) return false;
    const state = scope.interactiveStates.get(childId);
    return (
      state !== undefined && isStandaloneRoutingRuntime(state, owner, sessionId)
    );
  });
}

function hasUncertainRoutingOwner(
  view: OrchestratorAgentRegistryView,
  trustedIds: readonly string[],
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): boolean {
  const represented = new Map(
    view.agents.map((agent) => [agent.childId, agent]),
  );
  return trustedIds.some((childId) => {
    const state = scope.interactiveStates.get(childId);
    if (!state) return true;
    if (!isStandaloneRoutingRuntime(state, owner, sessionId)) return false;
    const agent = represented.get(childId);
    if (!agent || agent.stale) return true;
    return (
      agent.reason === "pane_liveness_unknown" ||
      agent.reason === "runtime_status_unknown"
    );
  });
}

function snapshotsMatchCurrentView(
  snapshots: readonly CandidateSnapshot[],
  currentView: OrchestratorAgentRegistryView,
  trustedIds: readonly string[],
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): boolean {
  if (registryIncomplete(currentView, trustedIds, scope, owner, sessionId)) {
    return false;
  }
  const current = eligibleCandidates(currentView, scope, owner, sessionId);
  if (current.length !== snapshots.length) return false;
  const currentById = new Map(
    current.map((snapshot) => [snapshot.candidate.childId, snapshot]),
  );
  for (const snapshot of snapshots) {
    const next = currentById.get(snapshot.candidate.childId);
    if (!next || next.state !== snapshot.state) return false;
    if (!sameRuntimeSnapshot(snapshot.runtime, snapshotRuntime(next.state))) {
      return false;
    }
    if (!sameRoutingView(snapshot.view, next.view)) return false;
  }
  return true;
}

function snapshotRuntime(state: InteractiveSubagentState): RuntimeSnapshot {
  return {
    id: state.id,
    ...(state.paneId === undefined ? {} : { paneId: state.paneId }),
    ...(state.windowName === undefined ? {} : { windowName: state.windowName }),
    mux: state.mux,
    ...(state.muxSession === undefined ? {} : { muxSession: state.muxSession }),
    ...(state.muxServer === undefined ? {} : { muxServer: state.muxServer }),
    sessionFile: state.sessionFile,
    cwd: state.cwd,
    ...(state.workingCwd === undefined ? {} : { workingCwd: state.workingCwd }),
    artifactDir: state.artifactDir,
    startedAt: state.startedAt,
    ...(state.sessionOwner === undefined
      ? {}
      : {
          sessionOwner: {
            id: state.sessionOwner.id,
            generation: state.sessionOwner.generation,
          },
        }),
    ...(state.supervisorOwner === undefined
      ? {}
      : {
          supervisorOwner: {
            id: state.supervisorOwner.id,
            generation: state.supervisorOwner.generation,
          },
        }),
    ...(state.parentSessionId === undefined
      ? {}
      : { parentSessionId: state.parentSessionId }),
    ...(state.workflowId === undefined ? {} : { workflowId: state.workflowId }),
    ...(state.completionOwner === undefined
      ? {}
      : { completionOwner: state.completionOwner }),
  };
}

function sameRuntimeSnapshot(
  left: RuntimeSnapshot,
  right: RuntimeSnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.paneId === right.paneId &&
    left.windowName === right.windowName &&
    left.mux === right.mux &&
    left.muxSession === right.muxSession &&
    left.muxServer === right.muxServer &&
    left.sessionFile === right.sessionFile &&
    left.cwd === right.cwd &&
    left.workingCwd === right.workingCwd &&
    left.artifactDir === right.artifactDir &&
    left.startedAt === right.startedAt &&
    sameOwnerToken(left.sessionOwner, right.sessionOwner) &&
    sameOwnerToken(left.supervisorOwner, right.supervisorOwner) &&
    left.parentSessionId === right.parentSessionId &&
    left.workflowId === right.workflowId &&
    left.completionOwner === right.completionOwner
  );
}

function sameOwnerToken(
  left: RuntimeSnapshot["sessionOwner"],
  right: RuntimeSnapshot["sessionOwner"],
): boolean {
  return left?.id === right?.id && left?.generation === right?.generation;
}

function isCurrentSession(
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
): boolean {
  return (
    scope.generation === owner.generation &&
    resolveLiveSessionScope(owner) === scope
  );
}

function sameRoutingView(
  left: OrchestratorAgentView,
  right: OrchestratorAgentView,
): boolean {
  return (
    left.childId === right.childId &&
    left.description === right.description &&
    left.provenance === right.provenance &&
    left.updatedAt === right.updatedAt &&
    sameStrings(left.aliases, right.aliases) &&
    left.status === right.status &&
    left.liveness === right.liveness &&
    left.stale === right.stale &&
    left.actionable === right.actionable
  );
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameUserRequest(
  left: UserRequestIdentity | undefined,
  right: UserRequestIdentity | undefined,
): boolean {
  return left?.id === right?.id;
}

function sanitizeDecision(
  value: unknown,
  snapshots: readonly CandidateSnapshot[],
  assessSplit: boolean,
): RoutingDecision {
  const candidateIds = new Set(
    snapshots.map(({ candidate }) => candidate.childId),
  );
  if (!value || typeof value !== "object") {
    return errorDecision("invalid_response");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "cancelled") return { kind: "cancelled" };
  const evidence = safeEvidence(raw.evidence);
  if (raw.kind === "split_needed" && assessSplit && evidence)
    return { kind: "split_needed", evidence };
  if (
    raw.kind === "split_uncertain" &&
    assessSplit &&
    evidence &&
    (raw.reason === "low_confidence" || raw.reason === "ambiguous")
  )
    return { kind: "split_uncertain", reason: raw.reason, evidence };
  if (raw.kind === "match") {
    if (
      typeof raw.childId !== "string" ||
      !candidateIds.has(raw.childId) ||
      !evidence
    ) {
      return errorDecision("invalid_response");
    }
    return { kind: "match", childId: raw.childId, evidence };
  }
  if (raw.kind === "no_match") {
    if (!isRoutingNoMatchReason(raw.reason)) {
      return errorDecision("invalid_response");
    }
    if (raw.evidence !== undefined && evidence === undefined) {
      return errorDecision("invalid_response");
    }
    return {
      kind: "no_match",
      reason: raw.reason,
      ...(evidence === undefined ? {} : { evidence }),
    };
  }
  if (raw.kind === "error" && isRoutingErrorReason(raw.reason)) {
    return { kind: "error", reason: raw.reason };
  }
  return errorDecision("invalid_response");
}

function safeEvidence(value: unknown): RoutingEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const confidence = boundedProbability(raw.confidence);
  const topProbability = boundedProbability(raw.topProbability);
  const runnerUpProbability = boundedProbability(raw.runnerUpProbability);
  const margin = boundedProbability(raw.margin);
  if (
    confidence === undefined ||
    topProbability === undefined ||
    runnerUpProbability === undefined ||
    margin === undefined
  ) {
    return undefined;
  }
  const evidence = { confidence, topProbability, runnerUpProbability, margin };
  return isValidRoutingEvidence(evidence) ? evidence : undefined;
}

function boundedProbability(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function isRoutingErrorReason(value: unknown): value is RoutingErrorReason {
  return typeof value === "string" && ROUTING_ERROR_REASONS.has(value);
}

function isRoutingNoMatchReason(value: unknown): value is RoutingNoMatchReason {
  return typeof value === "string" && ROUTING_NO_MATCH_REASONS.has(value);
}

function errorDecision(reason: RoutingErrorReason): RoutingDecision {
  return { kind: "error", reason };
}

type ReadyDecision =
  | Extract<RoutingDecision, { kind: "match" }>
  | (Extract<RoutingDecision, { kind: "no_match" }> & {
      reason: "new_child_recommended";
    });
type AdviceDetails = { status: "advice" } & (
  | { decision: ReadyDecision; readyForOneOwner: true }
  | { decision: RoutingDecision; readyForOneOwner?: never }
);
interface RoutingAdviceResult {
  content: [{ type: "text"; text: string }];
  details: AdviceDetails;
}
function isReadyDecision(decision: RoutingDecision): decision is ReadyDecision {
  return (
    decision.kind === "match" ||
    (decision.kind === "no_match" &&
      decision.reason === "new_child_recommended")
  );
}
function adviceText(decision: RoutingDecision): string {
  switch (decision.kind) {
    case "split_uncertain":
      return "Ask the user whether to split the request. Do not split, send, or create a child until the user answers.";
    case "split_needed":
      return "Separate the independent parts. Resolve each part with part=true and its own safe routingDescription. Do not dispatch intermediate tasks.";
    case "match":
      return `Routing advisor selected existing child ${decision.childId}.`;
    case "no_match":
      return decision.reason === "new_child_recommended"
        ? "Routing advisor recommends creating a new child for this task; this is advice only."
        : `Routing advisor abstained (${decision.reason}).`;
    case "cancelled":
      return "Routing advisor cancelled this routing request.";
    case "error":
      return `Routing advisor could not decide (${decision.reason}).`;
  }
}
function routingAdviceResult(
  decision: RoutingDecision,
  assessSplit = false,
): RoutingAdviceResult {
  const details: AdviceDetails =
    assessSplit && isReadyDecision(decision)
      ? { status: "advice", decision, readyForOneOwner: true }
      : { status: "advice", decision };
  return {
    content: [
      {
        type: "text",
        text: `${adviceText(decision)}\n${JSON.stringify(decision)}`,
      },
    ],
    details,
  };
}

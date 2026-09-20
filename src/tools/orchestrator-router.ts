import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  isOrchestratorV2Enabled,
  isOrchestratorV2WakeupMessage,
} from "../completion-turn";
import { createRoutingEngine, isRoutingEnabled } from "../routing-factory";
import {
  listOrchestratorRoutingEntries,
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

/** Maximum task size handed to the provider adapter. */
export const MAX_ORCHESTRATOR_ROUTE_TASK_BYTES = 16 * 1024;

const MAX_ORCHESTRATOR_ROUTE_TASK_CHARS = 16 * 1024;

const ResolveOrchestratorRouteParams = Type.Object({
  task: Type.String({
    minLength: 1,
    maxLength: MAX_ORCHESTRATOR_ROUTE_TASK_CHARS,
    description: "The original bounded user task to route to one child.",
  }),
});

const ROUTING_ERROR_REASONS: ReadonlySet<string> = new Set([
  "disabled",
  "missing_key",
  "invalid_config",
  "invalid_input",
  "payload_too_large",
  "timeout",
  "unavailable",
  "invalid_response",
  "state_changed",
  "incomplete_registry",
]);
const ROUTING_NO_MATCH_REASONS: ReadonlySet<string> = new Set([
  "none",
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
}

/**
 * Register the configured routing advisor. The registration gate is repeated
 * here because this helper is also used directly by focused tests and hosts.
 */
export function registerOrchestratorRouterTool(
  pi: ExtensionAPI,
  registrationScope?: SessionScope,
  options: RouterRegistrationOptions = {},
): void {
  if (!isOrchestratorV2Enabled(pi) || !isRoutingEnabled()) return;

  const toolToken: SessionToolToken | undefined = registrationScope
    ? { id: registrationScope.id }
    : undefined;

  registerToolWithDefaultGuidance(pi, {
    name: "resolve_orchestrator_route",
    label: "Resolve Orchestrator Route",
    description:
      "Ask the explicitly enabled routing advisor which current, confirmed Orchestratorv2 child best matches the original task. The tool only advises; it never sends, spawns, attaches, or reserves a child.",
    parameters: ResolveOrchestratorRouteParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return resolveOrchestratorRoute({
        pi,
        toolToken,
        params,
        signal,
        ctx,
        createEngine: options.createEngine,
      });
    },
  });
}

async function resolveOrchestratorRoute(params: {
  pi: ExtensionAPI;
  toolToken: SessionToolToken | undefined;
  params: { task: string };
  signal?: AbortSignal;
  ctx: unknown;
  createEngine?: () => RoutingEngine | undefined;
}): Promise<{
  content: [{ type: "text"; text: string }];
  details: { status: "advice"; decision: RoutingDecision };
}> {
  let decision: RoutingDecision;
  if (!isOrchestratorV2Enabled(params.pi) || !isRoutingEnabled()) {
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

  const task = params.params?.task;
  if (
    typeof task !== "string" ||
    task.trim().length === 0 ||
    Buffer.byteLength(task, "utf8") > MAX_ORCHESTRATOR_ROUTE_TASK_BYTES
  ) {
    return routingAdviceResult(errorDecision("invalid_input"));
  }
  const cwd = contextCwd(params.ctx, scope);
  if (!cwd) return routingAdviceResult(errorDecision("invalid_input"));

  const owner = sessionOwner(scope);
  const sessionId = sessionIdForScope(scope);
  const requestIdentity = latestUserRequestIdentity(params.ctx);
  const authorityEntries = parentBranchEntries(params.ctx);
  let initialView: OrchestratorAgentRegistryView;
  try {
    initialView = await loadOrchestratorAgentRegistryView(
      cwd,
      scope.interactiveStates,
      {
        signal: params.signal,
        authorityEntries,
      },
    );
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
  if (
    registryIncomplete(
      initialView,
      cwd,
      authorityEntries,
      scope,
      owner,
      sessionId,
    )
  ) {
    return routingAdviceResult(errorDecision("incomplete_registry"));
  }
  if (initialCandidates.length === 0) {
    return routingAdviceResult({ kind: "no_match", reason: "none" });
  }

  const snapshots = initialCandidates.map((entry) => ({
    candidate: entry.candidate,
    state: entry.state,
    runtime: entry.runtime,
    view: entry.view,
  }));
  const input = {
    task,
    candidates: snapshots.map(({ candidate }) => candidate),
  };

  let engineDecision: unknown;
  try {
    const engine = params.createEngine?.() ?? createRoutingEngine();
    if (!engine) return routingAdviceResult(errorDecision("unavailable"));
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

  decision = sanitizeDecision(engineDecision, snapshots);
  if (decision.kind === "cancelled") {
    return routingAdviceResult(decision);
  }
  if (decision.kind === "error") {
    return routingAdviceResult(decision);
  }

  let currentView: OrchestratorAgentRegistryView;
  try {
    currentView = await loadOrchestratorAgentRegistryView(
      cwd,
      scope.interactiveStates,
      {
        signal: params.signal,
        authorityEntries: parentBranchEntries(params.ctx),
      },
    );
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
    !snapshotsMatchCurrentView(
      snapshots,
      currentView,
      cwd,
      parentBranchEntries(params.ctx),
      scope,
      owner,
      sessionId,
    )
  ) {
    return routingAdviceResult(errorDecision("state_changed"));
  }

  return routingAdviceResult(decision);
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
    if (
      isOrchestratorV2WakeupMessage(
        textContent((record.message as { content?: unknown }).content),
      )
    ) {
      continue;
    }
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
    if (!state || !directRuntimeBelongsToScope(state, owner, sessionId)) {
      continue;
    }
    if (
      state.workflowId !== undefined ||
      state.completionOwner === "workflow"
    ) {
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

function registryIncomplete(
  view: OrchestratorAgentRegistryView,
  cwd: string,
  authorityEntries: readonly unknown[],
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): boolean {
  if (view.omitted <= 0) return false;
  let trustedIds: string[];
  try {
    trustedIds = listOrchestratorRoutingEntries(cwd, authorityEntries).map(
      (entry) => entry.childId,
    );
  } catch {
    return true;
  }
  const represented = new Set(view.agents.map((agent) => agent.childId));
  return trustedIds.some((childId) => {
    if (represented.has(childId)) return false;
    const state = scope.interactiveStates.get(childId);
    if (!state || !directRuntimeBelongsToScope(state, owner, sessionId)) {
      return false;
    }
    return (
      state.workflowId === undefined && state.completionOwner !== "workflow"
    );
  });
}

function snapshotsMatchCurrentView(
  snapshots: readonly CandidateSnapshot[],
  currentView: OrchestratorAgentRegistryView,
  cwd: string,
  authorityEntries: readonly unknown[],
  scope: SessionScope,
  owner: ReturnType<typeof sessionOwner>,
  sessionId: string | undefined,
): boolean {
  if (
    registryIncomplete(
      currentView,
      cwd,
      authorityEntries,
      scope,
      owner,
      sessionId,
    )
  ) {
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

function routingAdviceResult(decision: RoutingDecision): {
  content: [{ type: "text"; text: string }];
  details: { status: "advice"; decision: RoutingDecision };
} {
  const text =
    decision.kind === "match"
      ? `Routing advisor selected existing child ${decision.childId}.`
      : decision.kind === "no_match"
        ? `No existing child matches this task (${decision.reason}).`
        : decision.kind === "cancelled"
          ? "Routing advisor cancelled this routing request."
          : `Routing advisor could not decide (${decision.reason}).`;
  return {
    content: [{ type: "text", text: `${text}\n${JSON.stringify(decision)}` }],
    details: { status: "advice", decision },
  };
}

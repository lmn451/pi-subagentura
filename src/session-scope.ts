import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { JobState } from "./helpers";
import type { InteractiveSubagentState } from "./interactive-tmux";
import type { PendingJobDelivery } from "./notifications";
import type { WorkflowOwnerIdentity } from "./workflow-run-types";
import type { WorkflowRunStore } from "./workflow-run-store";
import type { DurableWorkflowController } from "./workflow-durable-plan-runner";
import type { WorkflowSessionDispatcher } from "./workflow-dispatcher";
import type { WorkflowContinuitySnapshot } from "./workflow-continuity";

const SESSION_SCOPE_REGISTRY_KEY = "__piSubagenturaSessionScopes";
const SESSION_SCOPE_ID_COUNTER_KEY = "__piSubagenturaSessionScopeIdCounter";
export const ACTIVE_SESSION_SCOPE_ID_KEY =
  "__piSubagenturaActiveSessionScopeId";
const ACTIVE_SESSION_SCOPE_GENERATION_KEY =
  "__piSubagenturaActiveSessionScopeGeneration";

export type SessionScopeLifecycle = "registered" | "started" | "shutdown";

export interface SessionScopeManager {
  getEntries?: () => unknown[];
  getSessionId?: () => string;
}

/** Mutable state owned by one extension registration and lifecycle generation. */
export interface SessionScope {
  id: number;
  generation: number;
  pi: ExtensionAPI;
  ui?: ExtensionUIContext;
  lifecycle: SessionScopeLifecycle;
  sessionManager?: SessionScopeManager;
  parentStreaming: boolean;
  inProcessJobs: Map<string, JobState>;
  pendingInProcessDeliveries: PendingJobDelivery[];
  interactiveStates: Map<string, InteractiveSubagentState>;
  durableWorkflowOwner?: WorkflowOwnerIdentity;
  durableWorkflowStore?: WorkflowRunStore;
  durableWorkflowController?: DurableWorkflowController;
  durableWorkflowDispatcher?: WorkflowSessionDispatcher;
  durableWorkflowContinuity?: WorkflowContinuitySnapshot;
}

/** External registrations may omit runtime-owned collections and streaming state. */
export interface SessionScopeRegistration {
  id: number;
  generation: number;
  pi: ExtensionAPI;
  ui?: ExtensionUIContext;
  lifecycle?: SessionScopeLifecycle;
  sessionManager?: SessionScopeManager;
  parentStreaming?: boolean;
  inProcessJobs?: Map<string, JobState>;
  pendingInProcessDeliveries?: PendingJobDelivery[];
  interactiveStates?: Map<string, InteractiveSubagentState>;
  durableWorkflowOwner?: WorkflowOwnerIdentity;
  durableWorkflowStore?: WorkflowRunStore;
  durableWorkflowController?: DurableWorkflowController;
  durableWorkflowDispatcher?: WorkflowSessionDispatcher;
  durableWorkflowContinuity?: WorkflowContinuitySnapshot;
}

export interface SessionOwnerToken {
  id: number;
  generation: number;
}

export interface SessionToolToken {
  id: number;
}

interface SessionScopeGlobalState {
  __piSubagenturaSessionScopes?: Map<number, SessionScope>;
  __piSubagenturaSessionScopeIdCounter?: number;
  __piSubagenturaActiveSessionScopeId?: number;
  __piSubagenturaActiveSessionScopeGeneration?: number;
  __piSubagenturaPiRef?: ExtensionAPI;
  __piSubagenturaUi?: ExtensionUIContext;
  __piSubagenturaSessionManager?: SessionScopeManager;
  __piSubagenturaParentStreaming?: boolean;
}

function getGlobalState(): typeof globalThis & SessionScopeGlobalState {
  return globalThis as typeof globalThis & SessionScopeGlobalState;
}

function getSessionScopeRegistry(): Map<number, SessionScope> {
  const state = getGlobalState();
  return (state[SESSION_SCOPE_REGISTRY_KEY] ??= new Map());
}

export function getSessionScopes(): SessionScope[] {
  return [...getSessionScopeRegistry().values()];
}
export function clearSessionScopes(): void {
  getSessionScopeRegistry().clear();
  const state = getGlobalState();
  state[SESSION_SCOPE_ID_COUNTER_KEY] = 0;
  setLegacyActiveSessionRefs(undefined);
}
export function getStartedSessionScopes(): SessionScope[] {
  return getSessionScopes().filter((scope) => scope.lifecycle === "started");
}

export function nextSessionScopeId(): number {
  const state = getGlobalState();
  const next = (state[SESSION_SCOPE_ID_COUNTER_KEY] ?? 0) + 1;
  state[SESSION_SCOPE_ID_COUNTER_KEY] = next;
  return next;
}

export function createSessionScope(pi: ExtensionAPI): SessionScope {
  return {
    id: nextSessionScopeId(),
    generation: 0,
    lifecycle: "registered",
    pi,
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  };
}

function isCompleteSessionScope(
  registration: SessionScopeRegistration,
): registration is SessionScope {
  return (
    (registration.lifecycle === "registered" ||
      registration.lifecycle === "started" ||
      registration.lifecycle === "shutdown") &&
    typeof registration.parentStreaming === "boolean" &&
    registration.inProcessJobs instanceof Map &&
    Array.isArray(registration.pendingInProcessDeliveries) &&
    registration.interactiveStates instanceof Map
  );
}

export function registerSessionScope(
  registration: SessionScopeRegistration,
): SessionScope {
  const state = getGlobalState();
  state[SESSION_SCOPE_ID_COUNTER_KEY] = Math.max(
    state[SESSION_SCOPE_ID_COUNTER_KEY] ?? 0,
    registration.id,
  );
  const registry = getSessionScopeRegistry();
  const existing = registry.get(registration.id);
  if (existing) {
    existing.generation = registration.generation;
    existing.pi = registration.pi;
    existing.lifecycle = registration.lifecycle ?? existing.lifecycle;
    existing.parentStreaming =
      registration.parentStreaming ?? existing.parentStreaming;
    if (registration.ui !== undefined) existing.ui = registration.ui;
    if (registration.sessionManager !== undefined) {
      existing.sessionManager = registration.sessionManager;
    }
    if (registration.inProcessJobs !== undefined) {
      existing.inProcessJobs = registration.inProcessJobs;
    }
    if (registration.pendingInProcessDeliveries !== undefined) {
      existing.pendingInProcessDeliveries =
        registration.pendingInProcessDeliveries;
    }
    if (registration.interactiveStates !== undefined) {
      existing.interactiveStates = registration.interactiveStates;
    }
    if ("durableWorkflowOwner" in registration) {
      existing.durableWorkflowOwner = registration.durableWorkflowOwner;
    }
    if (registration.durableWorkflowDispatcher !== undefined) {
      existing.durableWorkflowDispatcher =
        registration.durableWorkflowDispatcher;
    }
    if (registration.durableWorkflowContinuity !== undefined) {
      existing.durableWorkflowContinuity =
        registration.durableWorkflowContinuity;
    }
    return existing;
  }

  const scope: SessionScope = isCompleteSessionScope(registration)
    ? registration
    : {
        id: registration.id,
        generation: registration.generation,
        pi: registration.pi,
        ui: registration.ui,
        lifecycle: registration.lifecycle ?? "started",
        sessionManager: registration.sessionManager,
        parentStreaming: registration.parentStreaming ?? false,
        inProcessJobs: registration.inProcessJobs ?? new Map(),
        pendingInProcessDeliveries:
          registration.pendingInProcessDeliveries ?? [],
        interactiveStates: registration.interactiveStates ?? new Map(),
        durableWorkflowOwner: registration.durableWorkflowOwner,
        durableWorkflowDispatcher: registration.durableWorkflowDispatcher,
        durableWorkflowContinuity: registration.durableWorkflowContinuity,
      };
  registry.set(scope.id, scope);
  return scope;
}

export function findSessionScope(id: number): SessionScope | undefined {
  return getSessionScopeRegistry().get(id);
}

export function removeSessionScope(id: number): SessionScope | undefined {
  const registry = getSessionScopeRegistry();
  const removed = registry.get(id);
  if (!removed) return undefined;
  registry.delete(id);
  return removed;
}

/** Advance a generation so pending work cannot cross lifecycle boundaries. */
export function advanceSessionScopeGeneration(id: number): number {
  const scope = findSessionScope(id);
  if (!scope) return 0;
  scope.generation++;
  scope.durableWorkflowContinuity = undefined;
  const state = getGlobalState();
  if (state[ACTIVE_SESSION_SCOPE_ID_KEY] === id) {
    state[ACTIVE_SESSION_SCOPE_GENERATION_KEY] = scope.generation;
  }
  return scope.generation;
}

function sameWorkflowOwner(
  left: WorkflowOwnerIdentity | undefined,
  right: WorkflowOwnerIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.projectKey === right.projectKey &&
    left.cwd === right.cwd &&
    left.piSessionId === right.piSessionId &&
    left.ownerId === right.ownerId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.leaseToken === right.leaseToken
  );
}

export function sessionOwner(scope: SessionScope): SessionOwnerToken {
  return { id: scope.id, generation: scope.generation };
}
function sameDurableWorkflowOwner(
  left: WorkflowOwnerIdentity | undefined,
  right: WorkflowOwnerIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.projectKey === right.projectKey &&
    left.cwd === right.cwd &&
    left.piSessionId === right.piSessionId &&
    left.ownerId === right.ownerId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.leaseToken === right.leaseToken
  );
}

function clearDurableWorkflowServices(scope: SessionScope): void {
  scope.durableWorkflowStore = undefined;
  scope.durableWorkflowController = undefined;
}

export function setDurableWorkflowRootDir(
  scope: SessionScope,
  rootDir: string,
): void {
  if (scope.durableWorkflowRootDir === rootDir) return;
  clearDurableWorkflowServices(scope);
  scope.durableWorkflowRootDir = rootDir;
}

export function setDurableWorkflowOwner(
  scope: SessionScope,
  owner: WorkflowOwnerIdentity | undefined,
): void {
  if (!sameDurableWorkflowOwner(scope.durableWorkflowOwner, owner)) {
    clearDurableWorkflowServices(scope);
  }
  scope.durableWorkflowOwner = owner;
}

export async function releaseDurableWorkflowAuthority(
  scope: SessionScope,
): Promise<void> {
  const store = scope.durableWorkflowStore;
  if (!store) {
    scope.durableWorkflowController = undefined;
    return;
  }
  await store.release();
  if (scope.durableWorkflowStore === store) {
    clearDurableWorkflowServices(scope);
  }
}

export function setDurableWorkflowOwner(
  scope: SessionScope,
  owner: WorkflowOwnerIdentity | undefined,
): void {
  if (!sameWorkflowOwner(scope.durableWorkflowOwner, owner)) {
    scope.durableWorkflowStore = undefined;
    scope.durableWorkflowController = undefined;
    scope.durableWorkflowDispatcher = undefined;
    scope.durableWorkflowContinuity = undefined;
  }
  scope.durableWorkflowOwner = owner;
}

export function durableWorkflowOwner(
  scope: SessionScope,
): WorkflowOwnerIdentity | undefined {
  return scope.durableWorkflowOwner;
}

export async function releaseDurableWorkflowAuthority(
  scope: SessionScope,
): Promise<void> {
  const store = scope.durableWorkflowStore;
  if (!store) {
    scope.durableWorkflowController = undefined;
    scope.durableWorkflowDispatcher = undefined;
    scope.durableWorkflowContinuity = undefined;
    return;
  }
  await store.release();
  if (scope.durableWorkflowStore === store) {
    scope.durableWorkflowStore = undefined;
    scope.durableWorkflowController = undefined;
    scope.durableWorkflowDispatcher = undefined;
    scope.durableWorkflowContinuity = undefined;
  }
}

/** Return continuity only for a live scope belonging to this Pi instance. */
export function workflowContinuityForPi(
  pi: SessionScope["pi"],
): WorkflowContinuitySnapshot | undefined {
  const scopes = getStartedSessionScopes().filter((scope) => scope.pi === pi);
  if (scopes.length === 1) return scopes[0].durableWorkflowContinuity;
  const activeId = getActiveSessionScopeId();
  return scopes.find((scope) => scope.id === activeId)
    ?.durableWorkflowContinuity;
}

/** Resolve an exact owner only while that lifecycle generation remains live. */
export function resolveLiveSessionScope(
  owner: SessionOwnerToken | undefined,
): SessionScope | undefined {
  if (!owner) return undefined;
  const scope = findSessionScope(owner.id);
  return scope?.generation === owner.generation && scope.lifecycle === "started"
    ? scope
    : undefined;
}

/** Resolve a registration-captured tool token to its current live generation. */
export function resolveToolSessionScope(
  token: SessionToolToken | undefined,
): SessionScope | undefined {
  if (token) {
    const scope = findSessionScope(token.id);
    return scope?.lifecycle === "started" ? scope : undefined;
  }
  const started = getStartedSessionScopes();
  return started.length === 1 ? started[0] : undefined;
}

export function resolveToolSessionOwner(
  token: SessionToolToken | undefined,
): SessionOwnerToken | undefined {
  const scope = resolveToolSessionScope(token);
  return scope ? sessionOwner(scope) : undefined;
}

export function isSessionOwnerLive(
  owner: SessionOwnerToken | undefined,
): boolean {
  return !owner || resolveLiveSessionScope(owner) !== undefined;
}
export function ownerlessEntitiesVisible(): boolean {
  return getStartedSessionScopes().length === 0;
}

export function sessionIdForOwner(
  owner: SessionOwnerToken | undefined,
): string | undefined {
  if (!owner) return undefined;
  try {
    return resolveLiveSessionScope(owner)?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

export function parentSessionBelongsToOwner(
  parentSessionId: string | undefined,
  owner: SessionOwnerToken | undefined,
): boolean {
  if (!owner) return true;
  const ownerSessionId = sessionIdForOwner(owner);
  return ownerSessionId !== undefined && parentSessionId === ownerSessionId;
}

/** Keep legacy process-global refs usable only as a single-session fallback. */
export function setLegacyActiveSessionRefs(scope?: SessionScope): void {
  const state = getGlobalState();
  if (!scope) {
    state.__piSubagenturaPiRef = undefined;
    state.__piSubagenturaUi = undefined;
    state.__piSubagenturaSessionManager = undefined;
    state[ACTIVE_SESSION_SCOPE_ID_KEY] = undefined;
    state[ACTIVE_SESSION_SCOPE_GENERATION_KEY] = undefined;
    state.__piSubagenturaParentStreaming = false;
    return;
  }

  state.__piSubagenturaPiRef = scope.pi;
  state.__piSubagenturaUi = scope.ui;
  state.__piSubagenturaSessionManager = scope.sessionManager;
  state[ACTIVE_SESSION_SCOPE_ID_KEY] = scope.id;
  state[ACTIVE_SESSION_SCOPE_GENERATION_KEY] = scope.generation;
  state.__piSubagenturaParentStreaming = scope.parentStreaming;
}

export function getActiveSessionOwner(): SessionOwnerToken | undefined {
  const state = getGlobalState();
  const id = state[ACTIVE_SESSION_SCOPE_ID_KEY];
  const generation = state[ACTIVE_SESSION_SCOPE_GENERATION_KEY];
  if (typeof id !== "number" || typeof generation !== "number") {
    return undefined;
  }
  return { id, generation };
}

export function getActiveSessionScopeId(): number | undefined {
  return getGlobalState()[ACTIVE_SESSION_SCOPE_ID_KEY];
}

export function resolveStreamingFlag(owner?: SessionOwnerToken): boolean {
  if (owner) return resolveLiveSessionScope(owner)?.parentStreaming ?? false;
  return Boolean(getGlobalState().__piSubagenturaParentStreaming);
}

export interface InteractiveSessionOwnerState {
  parentSessionId?: string;
  sessionOwner?: SessionOwnerToken;
  supervisorOwner?: SessionOwnerToken;
}

export function interactiveStateBelongsToOwner(
  state: InteractiveSessionOwnerState,
  owner: SessionOwnerToken | undefined,
  sessionId?: string,
): boolean {
  const stateOwner = state.sessionOwner ?? state.supervisorOwner;
  if (stateOwner) {
    return owner
      ? stateOwner.id === owner.id && stateOwner.generation === owner.generation
      : false;
  }
  if (owner) {
    const ownerSessionId = sessionIdForOwner(owner);
    return (
      ownerSessionId !== undefined && state.parentSessionId === ownerSessionId
    );
  }
  return sessionId === undefined || state.parentSessionId === sessionId;
}

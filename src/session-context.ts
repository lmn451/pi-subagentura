import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

const SESSION_CONTEXT_STACK_KEY = "__piSubagenturaSessionContextStack";
const SESSION_CONTEXT_ID_COUNTER_KEY = "__piSubagenturaSessionContextIdCounter";
export const ACTIVE_SESSION_CONTEXT_ID_KEY =
  "__piSubagenturaActiveSessionContextId";

export type SessionContextLifecycle = "registered" | "started" | "shutdown";

export interface SessionContextRef {
  id: number;
  generation: number;
  pi: ExtensionAPI;
  ui?: ExtensionUIContext;
  lifecycle: SessionContextLifecycle;
  sessionManager?: {
    getEntries?: () => unknown[];
    getSessionId?: () => string;
  };
}

export type SessionContextRegistration = Omit<
  SessionContextRef,
  "lifecycle"
> & {
  lifecycle?: SessionContextLifecycle;
};

declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaActiveSessionContextId: number | undefined;
  // eslint-disable-next-line no-var
  var __piSubagenturaActiveSessionContextGeneration: number | undefined;
}

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

export function getSessionContextStack(): SessionContextRef[] {
  const g = getGlobalState() as any;
  if (!Array.isArray(g[SESSION_CONTEXT_STACK_KEY])) {
    g[SESSION_CONTEXT_STACK_KEY] = [];
  }
  return g[SESSION_CONTEXT_STACK_KEY] as SessionContextRef[];
}

export function nextSessionContextId(): number {
  const g = getGlobalState() as any;
  const next =
    typeof g[SESSION_CONTEXT_ID_COUNTER_KEY] === "number"
      ? g[SESSION_CONTEXT_ID_COUNTER_KEY] + 1
      : 1;
  g[SESSION_CONTEXT_ID_COUNTER_KEY] = next;
  return next;
}

export function createSessionContextRef(pi: ExtensionAPI): SessionContextRef {
  return {
    id: nextSessionContextId(),
    generation: 0,
    lifecycle: "registered",
    pi,
  };
}

export function registerSessionContext(
  context: SessionContextRegistration,
): void {
  // Existing external registrations represent active contexts; the extension's
  // own pre-start placeholder passes "registered" explicitly.
  context.lifecycle ??= "started";
  const registeredContext = context as SessionContextRef;
  const stack = getSessionContextStack();

  // Re-registration advances the existing lifecycle in place. Moving a
  // context would destroy the ancestor-before-descendant stack invariant.
  const existingIndex = stack.findIndex(
    (entry) => entry.id === registeredContext.id,
  );
  if (existingIndex >= 0) {
    stack[existingIndex] = registeredContext;
    return;
  }
  stack.push(registeredContext);
}

export function removeSessionContext(
  contextId: number,
): SessionContextRef | undefined {
  const stack = getSessionContextStack();
  const index = stack.findIndex((entry) => entry.id === contextId);
  if (index < 0) return undefined;
  const [removed] = stack.splice(index, 1);
  return removed;
}

/** Advance a context generation so pending work cannot cross its lifecycle. */
export function advanceSessionContextGeneration(contextId: number): number {
  const context = getSessionContextStack().find(
    (entry) => entry.id === contextId,
  );
  if (!context) return 0;
  context.generation++;
  const g = getGlobalState() as any;
  if (g[ACTIVE_SESSION_CONTEXT_ID_KEY] === context.id) {
    g.__piSubagenturaActiveSessionContextGeneration = context.generation;
  }
  return context.generation;
}

export function setActiveSessionRefs(context?: SessionContextRef): void {
  const g = getGlobalState() as any;
  if (!context) {
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaSessionManager = undefined;
    g[ACTIVE_SESSION_CONTEXT_ID_KEY] = undefined;
    g.__piSubagenturaActiveSessionContextGeneration = undefined;
    return;
  }

  g.__piSubagenturaPiRef = context.pi;
  g.__piSubagenturaUi = context.ui;
  g.__piSubagenturaSessionManager = context.sessionManager;
  g[ACTIVE_SESSION_CONTEXT_ID_KEY] = context.id;
  g.__piSubagenturaActiveSessionContextGeneration = context.generation;
}

export interface ActiveSessionContextToken {
  id: number;
  generation: number;
}

export function getActiveSessionContextId(): number | undefined {
  const g = getGlobalState() as any;
  return g[ACTIVE_SESSION_CONTEXT_ID_KEY];
}

export function getActiveSessionContextToken():
  ActiveSessionContextToken | undefined {
  const g = getGlobalState() as any;
  const id = g[ACTIVE_SESSION_CONTEXT_ID_KEY];
  const generation = g.__piSubagenturaActiveSessionContextGeneration;
  if (typeof id !== "number" || typeof generation !== "number")
    return undefined;
  return { id, generation };
}

/** Resolve a captured context only while its original lifecycle is still live. */
export function resolveLiveSessionContext(
  token: ActiveSessionContextToken | undefined,
): SessionContextRef | undefined {
  if (!token) return undefined;
  const context = getSessionContextStack().find(
    (entry) => entry.id === token.id,
  );
  return context?.generation === token.generation &&
    context.lifecycle === "started"
    ? context
    : undefined;
}

/** Whether a captured context still belongs to the same live lifecycle. */
export function isSessionContextTokenLive(
  token: ActiveSessionContextToken | undefined,
): boolean {
  return !token || resolveLiveSessionContext(token) !== undefined;
}

export function sessionIdForContextToken(
  token: ActiveSessionContextToken | undefined,
): string | undefined {
  if (!token) return undefined;
  try {
    return resolveLiveSessionContext(token)?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

export function parentSessionBelongsToOwner(
  parentSessionId: string | undefined,
  owner: ActiveSessionContextToken | undefined,
): boolean {
  if (!owner) return true;
  const ownerSessionId = sessionIdForContextToken(owner);
  return ownerSessionId !== undefined && parentSessionId === ownerSessionId;
}

export interface InteractiveSupervisorOwnerState {
  parentSessionId?: string;
  supervisorOwner?: ActiveSessionContextToken;
}

export function interactiveStateBelongsToOwner(
  state: InteractiveSupervisorOwnerState,
  owner: ActiveSessionContextToken | undefined,
  sessionId?: string,
): boolean {
  if (state.supervisorOwner) {
    return owner
      ? state.supervisorOwner.id === owner.id &&
          state.supervisorOwner.generation === owner.generation
      : sessionId === undefined;
  }
  if (owner) return parentSessionBelongsToOwner(state.parentSessionId, owner);
  return sessionId === undefined || state.parentSessionId === sessionId;
}

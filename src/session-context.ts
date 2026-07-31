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
  /** Per-context streaming flag (agent loop active). Scoped to this context
   *  so another session's streaming cannot suppress our deliveries. */
  parentStreaming: boolean;
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
    parentStreaming: false,
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

/**
 * Fail closed for owner-less legacy entities when multiple live sessions
 * exist. When only one started context is alive, legacy entities remain
 * visible to preserve single-session pi CLI behaviour.
 */
export function ownerlessEntitiesVisible(): boolean {
  const started = getSessionContextStack().filter(
    (ctx) => ctx.lifecycle === "started",
  );
  return started.length <= 1;
}

/**
 * Resolve a toolToken (id-only, captured at registration) into a full
 * ActiveSessionContextToken with the live generation.
 *
 * Returns undefined when the owning context is no longer live.
 */
export function resolveOwnerToken(
  toolToken: { id: number } | undefined,
): ActiveSessionContextToken | undefined {
  if (!toolToken) return undefined;
  const ctx = getSessionContextStack().find(
    (entry) => entry.id === toolToken.id,
  );
  if (!ctx || ctx.lifecycle !== "started") return undefined;
  return { id: ctx.id, generation: ctx.generation };
}

/**
 * Resolve the per-context streaming flag for the given owner token.
 *
 * When `ownerToken` is provided the owner context's `parentStreaming`
 * field is checked.  The process-global flag is kept as a fallback for
 * legacy code paths that set it directly.
 *
 * TODO(lmn451): Remove the `|| globalStreaming` fallback when no test
 *       writes `__piSubagenturaParentStreaming` directly outside
 *       `session-handlers.ts`.  Search for the global to confirm before
 *       deleting this line and the deprecated mirror assignments in
 *       `session-handlers.ts` (L:agent_start, L:agent_settled).
 */
export function resolveStreamingFlag(
  ownerToken?: ActiveSessionContextToken,
): boolean {
  const g = globalThis as any;
  const globalStreaming = Boolean(g.__piSubagenturaParentStreaming);
  return ownerToken
    ? (resolveLiveSessionContext(ownerToken)?.parentStreaming ?? false) ||
        globalStreaming
    : globalStreaming;
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

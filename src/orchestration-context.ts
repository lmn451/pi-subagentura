/**
 * Orchestration ownership + depth context.
 *
 * In-process sub-agents run in the SAME process as the parent (they share the
 * global `jobRegistry`), but a spawned child session has no idea it is a child
 * — its tool `execute()` callbacks cannot see who launched them. That blind
 * spot is why nested orchestration was unbounded and why cancellation could
 * not be made transitive.
 *
 * We close it with an AsyncLocalStorage. When a job runs its `session.prompt()`
 * we wrap the call in `withOrchestrationContext({ ownerJobId, depth, ... })`.
 * Because Pi's agent loop awaits tool execution inside that same async call
 * stack, any nested `subagent_isolated` / `subagent_with_context` call can read
 * `getOrchestrationContext()` to learn its owner job id and its depth in the
 * orchestration tree. This is race-free across concurrent spawns (unlike a
 * process-global env var) because each prompt gets its own async context.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface OrchestrationContext {
  /** Job id of the sub-agent whose prompt is currently executing. */
  ownerJobId: string;
  /** Orchestration depth of the CURRENT agent. Root parent = 0. */
  depth: number;
  /** Session id of the top-level parent, propagated for observability. */
  rootSessionId?: string;
}

export const DEFAULT_MAX_ORCHESTRATION_DEPTH = 3;

/**
 * Maximum orchestration depth. A spawn is refused when the would-be child's
 * depth would exceed this. Root parent spawns children at depth 1, so the
 * default of 3 permits parent → child → grandchild and stops great-grandchild
 * fan-out. Override with SUBAGENTURA_MAX_ORCHESTRATION_DEPTH.
 */
export function maxOrchestrationDepth(): number {
  const raw = process.env.SUBAGENTURA_MAX_ORCHESTRATION_DEPTH;
  if (!raw) return DEFAULT_MAX_ORCHESTRATION_DEPTH;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
    return DEFAULT_MAX_ORCHESTRATION_DEPTH;
  }
  return parsed;
}

// Persist on the global so jiti module reloads don't fork the storage and
// silently lose the active context mid-run (same pattern as jobRegistry).
const g = typeof global !== "undefined" ? global : globalThis;
declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaOrchestrationStore:
    | AsyncLocalStorage<OrchestrationContext>
    | undefined;
}
if (!g.__piSubagenturaOrchestrationStore) {
  g.__piSubagenturaOrchestrationStore =
    new AsyncLocalStorage<OrchestrationContext>();
}

const store =
  g.__piSubagenturaOrchestrationStore as AsyncLocalStorage<OrchestrationContext>;

/** Read the orchestration context of the currently executing agent, if any. */
export function getOrchestrationContext(): OrchestrationContext | undefined {
  return store.getStore();
}

/** Run `fn` with the given orchestration context bound for its async subtree. */
export function withOrchestrationContext<T>(
  ctx: OrchestrationContext,
  fn: () => T,
): T {
  return store.run(ctx, fn);
}

export interface SpawnDepthDecision {
  /** Depth the child would occupy (parent depth + 1). */
  childDepth: number;
  /** Owner job id of the spawning parent, if this spawn is itself nested. */
  parentJobId?: string;
  rootSessionId?: string;
  /** True when the spawn must be refused because it exceeds the depth cap. */
  exceedsLimit: boolean;
  limit: number;
}

/**
 * Resolve the depth a new child would occupy and whether it is allowed.
 * Reads the ambient orchestration context (undefined at the root parent).
 */
export function resolveSpawnDepth(): SpawnDepthDecision {
  const parent = getOrchestrationContext();
  const parentDepth = parent?.depth ?? 0;
  const childDepth = parentDepth + 1;
  const limit = maxOrchestrationDepth();
  return {
    childDepth,
    parentJobId: parent?.ownerJobId,
    rootSessionId: parent?.rootSessionId,
    exceedsLimit: childDepth > limit,
    limit,
  };
}

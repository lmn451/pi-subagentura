/**
 * Shared helpers for pi-subagentura
 *
 * Exported so both subagent.ts and test files can import them.
 * Keeps helper logic in one place — single source of truth.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getModel, getProviders } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";

import type {
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionOptions,
  copyProviderConfig,
  createCompatibleSessionRuntime,
} from "./pi-sdk-compat";
import {
  createWorkflowStructuredOutputTool,
  type WorkflowStructuredOutputCapture,
} from "./workflow-structured-output";
import {
  snapshotInProcessSession,
  type CancellationSnapshotReceipt,
  type CancellationSnapshotSource,
} from "./cancellation-snapshots";
import { withOrchestrationContext } from "./orchestration-context";
import type { InteractiveSubagentState } from "./interactive-tmux";
import {
  findSessionScope,
  ownerlessEntitiesVisible,
  type SessionOwnerToken,
} from "./session-scope";
// ── Debug Logging ─────────────────────────────────────────────────

const DEBUG_LOG_DIR = process.env.SUBAGENT_DEBUG_LOG_DIR
  ? resolve(process.env.SUBAGENT_DEBUG_LOG_DIR)
  : undefined;

export function debugLog(
  level: string,
  event: string,
  data: Record<string, unknown> = {},
) {
  if (!DEBUG_LOG_DIR) return;
  try {
    if (!existsSync(DEBUG_LOG_DIR)) {
      mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    }
    const entry =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...data,
      }) + "\n";
    const fileName = resolve(
      DEBUG_LOG_DIR,
      `debug-${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    appendFileSync(fileName, entry);
  } catch {
    // Silently fail to avoid polluting output
  }
}

export function extractTextFromContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          c.type === "text" &&
          typeof c.text === "string",
      )
      .map((c) => c.text)
      .join("\n");
  }
  if (typeof content === "string") {
    return content;
  }
  debugLog("warn", "unexpected_content_type", {
    contentType: typeof content,
    content: String(String(content).slice(0, 200)),
  });
  return "";
}

// ── Constants ────────────────────────────────────────────────────────

/**
 * Milliseconds to wait before showing activeTool in the live status preview.
 * Prevents UI flicker for fast tool executions that start and end within this window.
 *
 * Note: If Pi adds new model providers, update KNOWN_PROVIDERS below.
 */
export const ACTIVE_TOOL_DEBOUNCE_MS = 150;

// Note: If Pi adds new providers, getProviders() from @earendil-works/pi-ai will
// return them automatically. We no longer maintain a hardcoded list.

// ── Types ───────────────────────────────────────────────────────────

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Pricing provenance; "mixed" is used only for aggregated samples. */
  costSource?: "provider" | "estimated" | "unavailable" | "mixed";
  turns: number;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function normalizeUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  const cacheRead = usageNumber(usage.cacheRead);
  const cacheWrite = usageNumber(usage.cacheWrite);
  const cost = usageNumber(usage.cost);
  const hasAccounting =
    input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || cost > 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    ...(hasAccounting && usage.costSource
      ? { costSource: usage.costSource }
      : {}),
    turns: usageNumber(usage.turns),
  };
}

type AssistantCostSource = Exclude<NonNullable<Usage["costSource"]>, "mixed">;

function mergeUsageCostSource(
  existing: Usage["costSource"],
  next: Usage["costSource"],
): Usage["costSource"] {
  if (!next) return existing;
  if (!existing) return next;
  if (existing === next) return existing;
  return "mixed";
}

function addUsageSamples(total: Usage, next: Usage): Usage {
  const costSource = mergeUsageCostSource(total.costSource, next.costSource);
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
    ...(costSource ? { costSource } : {}),
    turns: total.turns + next.turns,
  };
}

/** Extract one assistant-message usage record without mutating it. */
export function usageFromAssistantMessage(
  message: unknown,
  turns = 1,
): Usage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { role?: unknown; usage?: unknown };
  if (
    candidate.role !== "assistant" ||
    !candidate.usage ||
    typeof candidate.usage !== "object"
  ) {
    return undefined;
  }
  const raw = candidate.usage as Record<string, unknown>;
  const rawCost = raw.cost;
  const cost =
    typeof rawCost === "number"
      ? usageNumber(rawCost)
      : rawCost && typeof rawCost === "object"
        ? usageNumber((rawCost as Record<string, unknown>).total)
        : 0;
  const input = usageNumber(raw.input);
  const output = usageNumber(raw.output);
  const cacheRead = usageNumber(raw.cacheRead);
  const cacheWrite = usageNumber(raw.cacheWrite);
  const rawCostSource = raw.costSource;
  const explicitSource: AssistantCostSource | undefined =
    rawCostSource === "provider" ||
    rawCostSource === "estimated" ||
    rawCostSource === "unavailable"
      ? rawCostSource
      : undefined;
  const hasAccounting =
    input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || cost > 0;
  const costSource = hasAccounting
    ? (explicitSource ?? (cost > 0 ? "estimated" : "unavailable"))
    : undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    ...(costSource ? { costSource } : {}),
    turns: Math.max(0, turns),
  };
}

/** Aggregate assistant usage from a session, falling back to the live sample. */
export function usageFromAssistantMessages(
  messages: readonly unknown[],
  fallback: Usage,
): Usage {
  const total = zeroUsageShape();
  let found = false;
  let costSource: Usage["costSource"];
  for (const message of messages) {
    const usage = usageFromAssistantMessage(message);
    if (!usage) continue;
    found = true;
    costSource = mergeUsageCostSource(costSource, usage.costSource);
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.cost += usage.cost;
    total.turns += usage.turns;
  }
  if (!found) return { ...fallback };
  if (costSource) total.costSource = costSource;
  return total;
}

function zeroUsageShape(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export type SubagentResult =
  | {
      isError: false;
      output: string;
      usage: Usage;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      /** Set when the sub-agent was aborted before producing a final answer. */
      cancelled?: boolean;
      workflowStructuredOutput?: WorkflowStructuredOutputCapture;
    }
  | {
      isError: true;
      output: string;
      usage: Usage;
      model?: undefined;
      thinkingLevel?: ThinkingLevel;
      /** Never set on the error branch; present so the union can be probed. */
      cancelled?: undefined;
      errorMessage: string;
      workflowStructuredOutput?: WorkflowStructuredOutputCapture;
    };

export interface SubagentLiveStatus {
  turn: number;
  activeTool?: { name: string; args: Record<string, unknown> };
  output: string;
  usage: Usage;
  /** Effective level after Pi's model-capability clamping. */
  thinkingLevel?: ThinkingLevel;
}

// ── Async Job Types ─────────────────────────────────────────────────

export type JobStatus = "running" | "done" | "error" | "cancelled";

/** Notification delivery mode for async subagent completion */
export type NotifyOnComplete = "notify" | "inject";

export interface JobDeliveryOwner {
  /** Pi API identity captured when the async job was spawned. */
  pi: ExtensionAPI;
  sessionId?: string;
  sessionScopeId?: number;
  sessionScopeGeneration?: number;
}

export interface JobState {
  id: string;
  status: JobStatus;
  liveStatus: SubagentLiveStatus;
  result?: SubagentResult;
  session: AgentSession;
  startedAt: number;
  cwd?: string;
  promise: Promise<SubagentResult>;
  modelLabel?: string;
  /** Effective level after Pi's model-capability clamping. */
  thinkingLevel?: ThinkingLevel;
  /** Notification mode requested by spawner's notifyOnComplete param */
  notifyOnComplete?: NotifyOnComplete;
  /** Delivery owner captured at async spawn time. */
  deliveryOwner?: JobDeliveryOwner;
  /** Whether completion notifications should trigger a parent LLM turn. */
  triggerTurnOnComplete?: boolean;
  /** At-most-once delivery guard */
  notificationDelivered?: boolean;
  /** Set true by get_subagent_result to suppress redundant notification */
  resultRetrieved?: boolean;
  /** Active get_subagent_result waits suppress settlement notifications. */
  activeResultWaits?: number;
  /** Optional TTL in ms for completed job retention */
  maxAge?: number;
  /** Most recent cancellation snapshot receipt, when snapshots are enabled. */
  cancellationSnapshot?: CancellationSnapshotReceipt;
  /**
   * Controller wired to this job's session (async jobs only). Aborting it
   * cancels the session AND cascades to any descendants this job owns.
   */
  abort?: AbortController;
  /** Job id of the owning parent sub-agent (undefined for root-parent spawns). */
  parentJobId?: string;
  /** Orchestration depth of this job. Root parent's direct children are 1. */
  depth?: number;
  /** Workflow owner for live supervisor presentation. */
  workflowId?: string;
  /** Workflow-managed jobs never independently notify the parent. */
  completionOwner?: "standalone" | "workflow";
  /** Recorded when a cancel path fires, for observability and result shaping. */
  cancellation?: CancellationInfo & { at: number };
}

/** Who/why a cancellation happened — threaded to logs and snapshots. */
export interface CancellationInfo {
  source: CancellationSnapshotSource;
  /** Session id, tool-call id, or symbolic origin (e.g. "user_escape"). */
  initiator?: string;
  /** Human-readable reason preserved in logs and the snapshot. */
  reason?: string;
}

// ── Job Registry ────────────────────────────────────────────────────

/**
 * Persisted job registry using global to survive module reloads (jiti).
 *
 * Lifecycle:
 *   - Jobs added on async subagent spawn
 *   - Completed/error jobs persist indefinitely (no TTL)
 *   - Cancelled jobs removed immediately
 *   - All jobs lost on Pi restart (in-memory only)
 */

// Use 'global' for Node.js global, fall back to globalThis
const g = typeof global !== "undefined" ? global : globalThis;

// Create or reuse the registry on the global object
if (!g.__piSubagenturaRegistry) {
  g.__piSubagenturaRegistry = new Map<string, JobState>();
}

export const jobRegistry = g.__piSubagenturaRegistry as Map<string, JobState>;

export function inProcessJobBelongsToOwner(
  job: JobState,
  owner: SessionOwnerToken | undefined,
): boolean {
  if (!owner) return true;
  return (
    job.deliveryOwner?.sessionScopeId === owner.id &&
    job.deliveryOwner?.sessionScopeGeneration === owner.generation
  );
}

export function inProcessJobOwner(
  job: JobState,
): SessionOwnerToken | undefined {
  const id = job.deliveryOwner?.sessionScopeId;
  const generation = job.deliveryOwner?.sessionScopeGeneration;
  return id === undefined || generation === undefined
    ? undefined
    : { id, generation };
}

const EMPTY_IN_PROCESS_JOBS: ReadonlyMap<string, JobState> = new Map();

function exactSessionJobRegistry(
  owner: SessionOwnerToken,
): Map<string, JobState> | undefined {
  const scope = findSessionScope(owner.id);
  return scope?.generation === owner.generation
    ? scope.inProcessJobs
    : undefined;
}

/** Authoritative registry for one owner, or the legacy aggregate with no live scopes. */
export function inProcessJobsForOwner(
  owner?: SessionOwnerToken,
): ReadonlyMap<string, JobState> {
  if (owner) return exactSessionJobRegistry(owner) ?? EMPTY_IN_PROCESS_JOBS;
  return ownerlessEntitiesVisible() ? jobRegistry : EMPTY_IN_PROCESS_JOBS;
}

export function getInProcessJob(
  jobId: string,
  owner?: SessionOwnerToken,
): JobState | undefined {
  if (owner) return exactSessionJobRegistry(owner)?.get(jobId);
  return ownerlessEntitiesVisible() ? jobRegistry.get(jobId) : undefined;
}

/** Add a job to its authoritative scope and the process-wide compatibility index. */
export function registerInProcessJob(
  job: JobState,
  owner?: SessionOwnerToken,
): boolean {
  const embeddedOwner = inProcessJobOwner(job);
  if (
    owner &&
    embeddedOwner &&
    (owner.id !== embeddedOwner.id ||
      owner.generation !== embeddedOwner.generation)
  ) {
    return false;
  }
  const effectiveOwner = owner ?? embeddedOwner;
  if (!effectiveOwner && !ownerlessEntitiesVisible()) return false;
  if (effectiveOwner) {
    const registry = exactSessionJobRegistry(effectiveOwner);
    if (!registry) return false;
    registry.set(job.id, job);
  }
  jobRegistry.set(job.id, job);
  return true;
}

/** Remove a job without allowing one scope to delete another scope's row. */
export function removeInProcessJob(
  jobId: string,
  owner?: SessionOwnerToken,
): boolean {
  if (!owner && !ownerlessEntitiesVisible()) return false;
  if (!owner) {
    const indexedJob = jobRegistry.get(jobId);
    const indexedOwner = indexedJob ? inProcessJobOwner(indexedJob) : undefined;
    return indexedOwner
      ? removeInProcessJob(jobId, indexedOwner)
      : jobRegistry.delete(jobId);
  }
  const registry = exactSessionJobRegistry(owner);
  if (!registry) {
    const aggregateJob = jobRegistry.get(jobId);
    return aggregateJob && inProcessJobBelongsToOwner(aggregateJob, owner)
      ? jobRegistry.delete(jobId)
      : false;
  }
  const ownedJob = registry.get(jobId);
  if (!ownedJob) {
    const aggregateJob = jobRegistry.get(jobId);
    return aggregateJob && inProcessJobBelongsToOwner(aggregateJob, owner)
      ? jobRegistry.delete(jobId)
      : false;
  }
  registry.delete(jobId);
  if (jobRegistry.get(jobId) === ownedJob) jobRegistry.delete(jobId);
  return true;
}

declare global {
  var __piSubagenturaRegistry: Map<string, JobState> | undefined;
  var __piSubagenturaInteractiveRegistry:
    Map<string, InteractiveSubagentState> | undefined;
  var __piSubagenturaPiRef: ExtensionAPI | undefined;
  var __piSubagenturaUi: ExtensionUIContext | undefined;
  var __piSubagenturaSessionManager:
    { getEntries?: () => unknown[]; getSessionId?: () => string } | undefined;
  var __piSubagenturaInjectCount: number | undefined;
  var __piSubagenturaInteractivePollerHandle:
    ReturnType<typeof setInterval> | undefined;
}

// Initialize the global pi ref
if (!g.__piSubagenturaPiRef) {
  g.__piSubagenturaPiRef = undefined;
}

/** Jobs persist indefinitely — no automatic expiration */
export const JOB_CLEANUP_TTL_MS = 0;

/** Maximum number of jobs to retain in the registry */
export const MAX_REGISTRY_SIZE = 100;

/** Remove the oldest completed or error job from the registry */
export function pruneOldestJob(owner?: SessionOwnerToken): boolean {
  for (const [jobId, job] of inProcessJobsForOwner(owner)) {
    if (job.status !== "done" && job.status !== "error") continue;
    if (removeInProcessJob(jobId, owner ?? inProcessJobOwner(job))) return true;
  }
  return false;
}

/** Remove all completed and error jobs from one owner registry. Returns count removed. */
export function pruneCompletedJobs(owner?: SessionOwnerToken): number {
  let removed = 0;
  for (const [jobId, job] of inProcessJobsForOwner(owner)) {
    if (job.status === "done" || job.status === "error") {
      if (removeInProcessJob(jobId, owner ?? inProcessJobOwner(job))) removed++;
    }
  }
  return removed;
}

/**
 * Recover a structured {@link CancellationInfo} from an AbortSignal.
 *
 * Our own cancel paths call `controller.abort(info)`, so `signal.reason` is the
 * CancellationInfo object. When Pi core aborts a parent turn (e.g. the user
 * pressed Escape) the reason is a DOMException/Error/string — we surface its
 * message and fall back to the given source.
 */
export function readCancellationInfo(
  signal: AbortSignal | undefined,
  fallbackSource: CancellationSnapshotSource,
): CancellationInfo {
  const reason = signal?.reason;
  if (
    reason &&
    typeof reason === "object" &&
    "source" in (reason as Record<string, unknown>)
  ) {
    return reason as CancellationInfo;
  }
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : undefined;
  return { source: fallbackSource, reason: message };
}

/**
 * Abort every running async job the given owner spawned, recursively.
 *
 * Each async job's controller fires its own abort handler (snapshot →
 * session.abort → cascade), so aborting a controller propagates the cancel
 * through the whole ownership subtree. Sync jobs are not registered here; their
 * descendants are reached from the sync job's own abort handler via {@link cascadeChildAborts}.
 * Returns the ids that were signalled.
 */
export function cascadeChildAborts(
  ownerJobId: string,
  info: CancellationInfo,
  owner?: SessionOwnerToken,
): string[] {
  const signalled: string[] = [];
  for (const [childId, child] of inProcessJobsForOwner(owner)) {
    if (child.parentJobId !== ownerJobId) continue;
    if (child.status !== "running") continue;
    child.cancellation = { ...info, at: Date.now() };
    // Mark cancelled up front so late settlement cannot flip it to done/error
    // and no completion notification fires for an aborted child.
    child.status = "cancelled";
    scheduleJobCleanup(childId, true, undefined, owner);
    signalled.push(childId);
    if (child.abort) {
      try {
        child.abort.abort(info);
      } catch {
        /* controller may already be aborted */
      }
    } else {
      child.session.abort().catch(() => {});
      signalled.push(...cascadeChildAborts(childId, info, owner));
    }
  }
  return signalled;
}

/**
 * Cancel a specific async job and its owned descendants. Records the
 * cancellation metadata, then aborts the job's controller (which snapshots and
 * tears down the session) and cascades to children.
 */
export function abortJobTree(
  jobId: string,
  info: CancellationInfo,
  owner?: SessionOwnerToken,
): string[] {
  const job = getInProcessJob(jobId, owner);
  if (!job || job.status !== "running") return [];
  job.cancellation = { ...info, at: Date.now() };
  const cascaded = cascadeChildAborts(jobId, info, owner);
  if (job.abort) {
    try {
      job.abort.abort(info);
    } catch {
      /* already aborted */
    }
  } else {
    job.session.abort().catch(() => {});
  }
  return [jobId, ...cascaded];
}

export function scheduleJobCleanup(
  jobId: string,
  immediate = false,
  maxAge?: number,
  owner?: SessionOwnerToken,
): void {
  if (!immediate) {
    if (maxAge && maxAge > 0) {
      setTimeout(() => {
        removeInProcessJob(jobId, owner);
      }, maxAge);
    }
    return; // persist indefinitely unless maxAge specified
  }
  setTimeout(() => {
    removeInProcessJob(jobId, owner);
  }, 0);
}

/** Generate a unique job ID (16 hex chars from crypto.randomBytes) */
export function generateJobId(): string {
  // Uses randomBytes for Node 18 compatibility (randomUUID needs Node 19+)
  return randomBytes(8).toString("hex");
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a model from a string identifier and an optional default.
 *
 * The caller (LLM agent) is responsible for providing the correct model id.
 * This function does NOT guess — it only does exact lookups:
 *   1. undefined → defaultModel
 *   2. Use parent modelRegistry (has extension-added models like minimax)
 *   3. "provider/id" format → exact getModel lookup (global static registry)
 *   4. Bare id → exact getModel scan across all providers (global static registry)
 *   5. Falls back to defaultModel when nothing matches
 */
export function resolveModel(
  modelId: string | undefined,
  defaultModel: Model<any> | undefined,
  parentModelRegistry?: ModelRegistry,
) {
  if (!modelId) return defaultModel;

  // Only exact matching — no fuzzy/substring guessing.
  // The AI should call list_available_models and pick from the list.
  if (parentModelRegistry) {
    if (modelId.includes("/")) {
      const [provider, id] = modelId.split("/", 2);
      const exact = parentModelRegistry.find(provider, id);
      if (exact) return exact as any;
    } else {
      // Bare id — search all models in parent registry
      for (const m of parentModelRegistry.getAll()) {
        if (m.id === modelId) return m as any;
      }
    }
  }

  // Fall back to global static registry (built-in models only)
  if (modelId.includes("/")) {
    const [provider, id] = modelId.split("/", 2);
    return getModel(provider as any, id) ?? defaultModel;
  }

  // Bare id — exact match across all providers
  for (const provider of getProviders()) {
    const found = getModel(provider as any, modelId);
    if (found) return found;
  }

  return defaultModel;
}
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(u: Usage, model?: string): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function buildLiveUpdate(
  status: SubagentLiveStatus,
  model?: string,
): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: status.output }],
    details: {
      status: "running",
      subagentStatus: status,
      model,
      thinkingLevel: status.thinkingLevel,
    },
  };
}

// ── startSubagentJob ────────────────────────────────────────────────

export interface StartSubagentJobParams {
  task: string;
  persona: string | undefined;
  modelOverride: string | undefined;
  cwd: string;
  contextText: string | null;
  signal: AbortSignal | undefined;
  onUpdate: ((partial: AgentToolResult<any>) => void) | undefined;
  defaultModel: Model<any> | undefined;
  maxAge?: number;
  /** Parent session's model registry for resolving extension-added models (e.g. minimax) */
  parentModelRegistry?: ModelRegistry;
  /** Optional JSON Schema delivered via a workflow structured-output tool in in-process mode. */
  workflowStructuredOutputSchema?: unknown;
  /** Restrict the child to the structured-output custom tool. */
  structuredOutputOnly?: boolean;
  onCancellationSnapshot?: (receipt: CancellationSnapshotReceipt) => void;
  cancellationSource?: CancellationSnapshotSource;
  /** Thinking/reasoning level. Pass through to createAgentSession. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Orchestration depth of THIS job (root parent's direct child = 1). Bound
   * into the async context so nested spawns can see their own depth.
   */
  depth?: number;
  /** Top-level parent session id, propagated for observability. */
  rootSessionId?: string;
  /** Exact parent lifecycle owning registry capacity for this prepared job. */
  owner?: SessionOwnerToken;
}

export interface StartSubagentJobResult {
  jobId: string;
  jobPromise: Promise<SubagentResult>;
  session: AgentSession;
  liveStatus: SubagentLiveStatus;
  /** Begin prompt execution after the caller validates and registers the job. */
  start: () => void;
  /** Settle and dispose a prepared session without ever starting its prompt. */
  disposeBeforeStart: () => void;
  modelLabel?: string;
  /** Effective session level after model-capability clamping. */
  thinkingLevel?: ThinkingLevel;
  /** Warning when modelOverride was specified but not found — lists available models */
  modelWarning?: string;
}

/**
 * Prepare a subagent session for prompt execution.
 *
 * The caller must invoke `start()` after validating and registering the job.
 * `disposeBeforeStart()` settles and cleans up without invoking the prompt.
 * The liveStatus object is mutated in real-time by the event subscriber.
 *
 * This is the shared core used by both sync (runSubagent) and async paths.
 */
export async function startSubagentJob(
  params: StartSubagentJobParams,
): Promise<StartSubagentJobResult> {
  const {
    task,
    persona,
    modelOverride,
    cwd,
    contextText,
    signal,
    onUpdate,
    defaultModel,
    parentModelRegistry,
    workflowStructuredOutputSchema,
    structuredOutputOnly,
    onCancellationSnapshot,
    cancellationSource,
    thinkingLevel,
    depth,
    rootSessionId,
    owner,
  } = params;
  if (structuredOutputOnly && workflowStructuredOutputSchema === undefined) {
    throw new Error(
      "structuredOutputOnly requires workflowStructuredOutputSchema",
    );
  }

  // Enforce the cap within this exact scope; peer sessions never evict each other.
  while (inProcessJobsForOwner(owner).size >= MAX_REGISTRY_SIZE) {
    if (!pruneOldestJob(owner)) break; // no old jobs to evict, allow slight overcap
  }

  const jobId = generateJobId();
  const sessionRuntime = await createCompatibleSessionRuntime();

  // Resolve model: exact match only, fallback to default
  // Uses parent's modelRegistry to find extension-added models (e.g. minimax)
  const targetModel = resolveModel(
    modelOverride,
    defaultModel,
    parentModelRegistry,
  );
  if (targetModel) {
    copyProviderConfig(
      sessionRuntime,
      parentModelRegistry,
      targetModel.provider,
    );
  }
  const modelLabel = targetModel
    ? `${targetModel.provider}/${targetModel.id}`
    : undefined;

  // Build model warning when override was specified (helps AI discover valid models)
  let modelWarning: string | undefined;
  if (modelOverride && parentModelRegistry) {
    const available = parentModelRegistry.getAvailable();
    const modelList = available
      .map((m) => `  ${m.provider}/${m.id}${m.name ? ` (${m.name})` : ""}`)
      .join("\n");
    modelWarning =
      `Requested model "${modelOverride}" resolved to ${modelLabel ?? "none"}. ` +
      `Available models:\n${modelList || "  (none)"}\n` +
      `Use list_available_models to discover more.`;
  }

  let handleAbort: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const liveStatus: SubagentLiveStatus = {
    turn: 0,
    output: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
  };

  // Debounce activeTool updates to prevent flickering on fast tool calls.
  // When onUpdate is undefined (async path), skip the debounce entirely —
  // no rendering to flicker, and the timer overhead is wasted.
  let activeToolTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActiveTool: SubagentLiveStatus["activeTool"] = undefined;

  function setActiveToolDebounced(tool: SubagentLiveStatus["activeTool"]) {
    pendingActiveTool = tool;
    if (activeToolTimer) {
      clearTimeout(activeToolTimer);
      activeToolTimer = undefined;
    }
    if (tool) {
      if (!onUpdate) {
        // Async path: no rendering, apply immediately
        liveStatus.activeTool = tool;
        return;
      }
      activeToolTimer = setTimeout(() => {
        activeToolTimer = undefined;
        liveStatus.activeTool = pendingActiveTool;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
      }, ACTIVE_TOOL_DEBOUNCE_MS);
    } else {
      if (liveStatus.activeTool) {
        liveStatus.activeTool = undefined;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
      }
    }
  }

  // Create session
  debugLog("info", "session_creating", {
    jobId,
    model: modelLabel ?? "default",
    cwd,
  });
  const {
    tool: workflowStructuredOutputTool,
    capture: workflowStructuredOutput,
  } =
    workflowStructuredOutputSchema === undefined
      ? { tool: undefined, capture: undefined }
      : createWorkflowStructuredOutputTool(workflowStructuredOutputSchema);

  const sessionOptions = buildSessionOptions(sessionRuntime, {
    sessionManager: SessionManager.inMemory(),
    model: targetModel,
    cwd,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(structuredOutputOnly && workflowStructuredOutputTool
      ? { tools: [workflowStructuredOutputTool.name] }
      : {}),
    ...(workflowStructuredOutputTool
      ? { customTools: [workflowStructuredOutputTool] }
      : {}),
  });
  const session = (
    await createAgentSession(
      sessionOptions as unknown as Parameters<typeof createAgentSession>[0],
    )
  ).session;
  const effectiveThinkingLevel =
    thinkingLevel === undefined ? undefined : session.thinkingLevel;
  liveStatus.thinkingLevel = effectiveThinkingLevel;
  debugLog("info", "session_created", {
    jobId,
    sessionModel: session.model
      ? `${session.model.provider}/${session.model.id}`
      : null,
  });

  // Wire abort signal
  if (signal) {
    handleAbort = () => {
      const info = readCancellationInfo(signal, cancellationSource ?? "signal");
      debugLog("warn", "job_abort", {
        jobId,
        source: info.source,
        initiator: info.initiator ?? null,
        reason: info.reason ?? null,
        depth: depth ?? null,
        rootSessionId: rootSessionId ?? null,
      });
      // Only take a snapshot when a receiver was wired (workflow path). The
      // in-process cancel sites snapshot before aborting to capture pre-abort
      // state, so snapshotting again here would be redundant.
      if (onCancellationSnapshot) {
        onCancellationSnapshot(
          snapshotInProcessSession({
            kind: "in-process",
            jobId,
            session,
            cwd,
            model: modelLabel,
            activeTool: liveStatus.activeTool,
            partialOutput: liveStatus.output,
            source: info.source,
            initiator: info.initiator,
            reason: info.reason,
          }),
        );
      }
      session.abort().catch(() => {});
      // Cancellation is transitive: tear down every descendant this job owns.
      cascadeChildAborts(jobId, info, owner);
    };
    if (signal.aborted) {
      handleAbort();
    } else {
      signal.addEventListener("abort", handleAbort);
    }
  }

  let completedLiveUsage = zeroUsageShape();
  let observedUsageEvent = false;
  const updateLiveUsageFromMessage = (message: unknown): void => {
    const currentTurnUsage = usageFromAssistantMessage(message);
    if (!currentTurnUsage) return;
    observedUsageEvent = true;
    liveStatus.usage = addUsageSamples(completedLiveUsage, currentTurnUsage);
  };

  // Wire session events
  unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "turn_start": {
        liveStatus.turn++;
        liveStatus.usage = {
          ...completedLiveUsage,
          turns: liveStatus.turn,
        };
        liveStatus.output = "";
        debugLog("info", "turn_start", { jobId, turn: liveStatus.turn });
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        break;
      }
      case "tool_execution_start": {
        debugLog("info", "tool_start", {
          jobId,
          toolName: event.toolName,
          args: event.args,
        });
        setActiveToolDebounced({
          name: event.toolName,
          args: event.args,
        });
        break;
      }
      case "tool_execution_end": {
        debugLog("info", "tool_end", {
          jobId,
          toolName: liveStatus.activeTool?.name,
        });
        setActiveToolDebounced(undefined);
        break;
      }
      case "turn_end": {
        updateLiveUsageFromMessage(
          "message" in event ? event.message : undefined,
        );
        completedLiveUsage = { ...liveStatus.usage };
        debugLog("info", "turn_end", {
          jobId,
          turn: liveStatus.turn,
          outputLength: liveStatus.output.length,
          activeTool: liveStatus.activeTool?.name ?? null,
        });
        if (activeToolTimer) {
          clearTimeout(activeToolTimer);
          activeToolTimer = undefined;
        }
        liveStatus.activeTool = undefined;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        break;
      }
      case "message_update": {
        const evt = event.assistantMessageEvent;
        debugLog("info", "message_update", {
          jobId,
          updateType: evt.type,
          ...(evt.type === "text_delta" && {
            delta: evt.delta.slice(0, 200),
            outputLength: liveStatus.output.length,
          }),
          ...(evt.type === "thinking_delta" && {
            delta: evt.delta.slice(0, 200),
          }),
          ...(evt.type === "toolcall_delta" && {
            partial: String(evt.partial).slice(0, 200),
          }),
          ...(evt.type === "toolcall_end" && { toolCallId: evt.toolCall?.id }),
        });
        updateLiveUsageFromMessage(
          "message" in event ? event.message : undefined,
        );
        if (evt.type === "text_delta") {
          liveStatus.output += evt.delta;
          onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        }
        break;
      }
    }
  });

  // Build prompt text
  const personaPrefix = persona ? `${persona}\n\n` : "";
  const finalPrompt = contextText
    ? `${personaPrefix}You are a SEPARATE background sub-agent. Your ONLY job is the task below.\nThe conversation history above is CONTEXT ONLY — do NOT comment on it, do NOT role-play as the main assistant, do NOT describe the spawning process. Execute ONLY the task and return ONLY the result.\n\n## Conversation History (context only — do not respond to this)\n${contextText}\n\n## Your Task (respond ONLY to this)\n${task}`
    : `${personaPrefix}Task: ${task}`;

  debugLog("info", "prompt_built", {
    jobId,
    hasContext: !!contextText,
    contextLength: contextText?.length ?? 0,
    taskLength: task.length,
    persona: persona ?? null,
    promptPreview: finalPrompt.slice(0, 500),
  });

  const attachWorkflowStructuredOutput = <T extends SubagentResult>(
    result: T,
  ): T =>
    workflowStructuredOutput === undefined
      ? result
      : ({ ...result, workflowStructuredOutput } as T);

  // Prompt execution is gated so async callers can validate ownership and
  // register the job before any model or tool side effects are possible.
  let startGateResolve!: () => void;
  let started = false;
  let disposedBeforeStart = false;
  const startGate = new Promise<void>((resolve) => {
    startGateResolve = resolve;
  });
  const start = (): void => {
    if (started || disposedBeforeStart) return;
    started = true;
    startGateResolve();
  };
  const disposePreparedSession = (): void => {
    if (started || disposedBeforeStart) return;
    disposedBeforeStart = true;
    startGateResolve();
  };
  let result: SubagentResult = {
    isError: true,
    output: "(no output)",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    model: undefined,
    thinkingLevel: effectiveThinkingLevel,
    errorMessage: "No subagent result captured.",
  };
  const currentSessionUsage = (): Usage =>
    observedUsageEvent
      ? { ...liveStatus.usage }
      : usageFromAssistantMessages(
          session.agent.state.messages as readonly unknown[],
          liveStatus.usage,
        );
  const jobPromise = (async (): Promise<SubagentResult> => {
    try {
      await startGate;
      if (disposedBeforeStart || signal?.aborted) {
        const info = readCancellationInfo(
          signal,
          cancellationSource ?? "signal",
        );
        result = {
          isError: false,
          cancelled: true,
          output: `Sub-agent cancelled before start${info.reason ? `: ${info.reason}` : ""}.`,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
          },
          model: session.model
            ? `${session.model.provider}/${session.model.id}`
            : undefined,
          thinkingLevel: effectiveThinkingLevel,
        };
        return result;
      }
      debugLog("info", "prompt_start", { jobId });
      // Bind ownership + depth so any nested sub-agent spawned during this
      // prompt can discover its owner (for cascade) and its depth (for the cap).
      await withOrchestrationContext(
        { ownerJobId: jobId, depth: depth ?? 0, rootSessionId },
        () => session.prompt(finalPrompt),
      );
      debugLog("info", "prompt_complete", { jobId });

      // Aborted before completion → return an explicit cancelled result rather
      // than a false empty success. Pi resolves prompt() on abort (it does not
      // throw), so without this check an aborted job looks like `done` output.
      if (signal?.aborted) {
        const info = readCancellationInfo(
          signal,
          cancellationSource ?? "signal",
        );
        result = {
          isError: false,
          cancelled: true,
          output: `Sub-agent cancelled before completion${info.reason ? `: ${info.reason}` : ""}.`,
          usage: currentSessionUsage(),
          model: session.model
            ? `${session.model.provider}/${session.model.id}`
            : undefined,
          thinkingLevel: effectiveThinkingLevel,
        };
        return result;
      }

      // Extract final assistant output
      const messages = session.agent.state.messages;
      debugLog("info", "messages_extracted", {
        jobId,
        messageCount: messages.length,
        messageRoles: messages.map((m) => m.role),
        lastMessageContentType: typeof (messages[messages.length - 1] as any)
          ?.content,
        lastMessageContentIsArray: Array.isArray(
          (messages[messages.length - 1] as any)?.content,
        ),
      });

      let finalOutput = liveStatus.output;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        debugLog("info", "message_check", {
          jobId,
          index: i,
          role: msg.role,
          contentType: typeof (msg as any).content,
          contentIsArray: Array.isArray((msg as any).content),
        });
        if (msg.role === "assistant") {
          const textParts = extractTextFromContent(msg.content);
          if (textParts) {
            finalOutput = textParts;
            break;
          }
        }
      }

      const usage = currentSessionUsage();

      if (session.agent.state.errorMessage) {
        result = attachWorkflowStructuredOutput({
          isError: true,
          output: finalOutput || "(no output)",
          usage,
          model: undefined,
          thinkingLevel: effectiveThinkingLevel,
          errorMessage: session.agent.state.errorMessage,
        });
      } else {
        result = attachWorkflowStructuredOutput({
          isError: false,
          output: finalOutput || "(no output)",
          usage,
          model: session.model
            ? `${session.model.provider}/${session.model.id}`
            : undefined,
          thinkingLevel: effectiveThinkingLevel,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      debugLog("error", "subagent_error", {
        jobId,
        error: msg,
        stack: stack ?? null,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      result = attachWorkflowStructuredOutput({
        output: `Sub-agent crashed: ${msg}`,
        usage: currentSessionUsage(),
        model: undefined,
        thinkingLevel: effectiveThinkingLevel,
        isError: true,
        errorMessage: msg,
      });
    } finally {
      debugLog("info", "job_complete", {
        jobId,
        outputLength: result.output.length,
        output: result.output.slice(0, 200),
        isError: result.isError,
        errorMessage: "errorMessage" in result ? result.errorMessage : null,
        usage: result.usage,
      });
      if (activeToolTimer) {
        clearTimeout(activeToolTimer);
        activeToolTimer = undefined;
      }
      if (signal && handleAbort)
        signal.removeEventListener("abort", handleAbort);
      if (unsubscribe) unsubscribe();
      session?.dispose();
      debugLog("info", "session_disposed", { jobId });
    }
    return result;
  })();

  return {
    jobId,
    jobPromise,
    session,
    liveStatus,
    start,
    disposeBeforeStart: disposePreparedSession,
    modelLabel,
    thinkingLevel: effectiveThinkingLevel,
    modelWarning,
  };
}

import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { abortableWait } from "../abortable-wait";
import { updateRunningSubagentFooter } from "../artifact-poller";
import { cleanupOldArtifacts, type CleanupResult } from "../artifact";
import {
  abortJobTree,
  buildLiveUpdate,
  debugLog,
  formatUsage,
  getInProcessJob,
  MAX_REGISTRY_SIZE,
  removeInProcessJob,
  inProcessJobOwner,
  inProcessJobsForOwner,
  pruneCompletedJobs,
  registerInProcessJob,
  scheduleJobCleanup,
  spawnFailureStage,
  startSubagentJob,
  type InProcessSpawnFailureStage,
  type JobDeliveryOwner,
  type JobState,
  type JobStatus,
  type SubagentLiveStatus,
  type SubagentResult,
  type Usage,
} from "../helpers";
import { resolveSpawnDepth } from "../orchestration-context";
import {
  getStartedSessionScopes,
  findSessionScope,
  resolveLiveSessionScope,
  resolveToolSessionScope,
  sessionOwner,
  type SessionOwnerToken,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";
import { snapshotInProcessSession } from "../cancellation-snapshots";
import {
  assertCompletionGroupOpen,
  reserveCompletionGroup,
  releaseCompletionGroup,
  consumeCompletionSource,
  publishCompletion,
  registerCompletionMember,
  resolveCompletionPolicy,
  type ResolvedCompletionPolicy,
  type CompletionGroupReservation,
} from "../completion-coordinator";
import {
  completionTriggersTurn,
  deliverNotification,
  formatCompletionDeliveryBehavior,
  notifyInProcessCompletionWithoutDelivery,
} from "../notifications";
import { interactiveSubagentRegistry } from "../interactive-tmux";
import { renderSubagentCall, renderSubagentResult } from "../rendering";
import { registerToolWithDefaultGuidance } from "../tool-guidance";
import {
  BaseParams,
  CancelParams,
  ResultParams,
  StatusParams,
} from "../schemas";
import {
  captureTelemetry,
  telemetryDepth,
  telemetryDepthBucket,
  type AgentTelemetryContext,
  type TelemetryCompletionPolicy,
  type TelemetryInvocationSource,
} from "../telemetry";
interface RunningFooterContext {
  cwd?: string;
  ui: {
    setStatus(key: string, value?: string): void;
  };
}

type InProcessSubagentDetails =
  | { status: "started"; jobId: string; contextMessages: number }
  | {
      status: "running";
      subagentStatus: SubagentLiveStatus;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      thinkingLevel?: ThinkingLevel;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found"; jobId?: string };

function updateRunningFooter(
  ctx: RunningFooterContext,
  owner?: SessionOwnerToken,
): void {
  updateRunningSubagentFooter(ctx.ui, owner);
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

interface SpawnContext {
  sessionManager?: { getSessionId?: () => string };
}

/** Resolve depth/ownership for a new spawn, plus the root session id for logs. */
function resolveSpawn(ctx: SpawnContext) {
  const spawn = resolveSpawnDepth();
  let rootSessionId = spawn.rootSessionId;
  if (!rootSessionId) {
    try {
      rootSessionId = ctx.sessionManager?.getSessionId?.();
    } catch {
      rootSessionId = undefined;
    }
  }
  return { ...spawn, rootSessionId };
}

function resolveExecutionOwner(
  token: SessionToolToken | undefined,
): { owner?: SessionOwnerToken } | undefined {
  const scope = resolveToolSessionScope(token);
  if (scope) return { owner: sessionOwner(scope) };
  // A supplied token must never fall back to whichever peer registered last.
  if (token || getStartedSessionScopes().length > 0) return undefined;
  return {};
}

function telemetryForAgent(
  owner: SessionOwnerToken | undefined,
  invocationSource: TelemetryInvocationSource,
  async: boolean,
  depth: number | undefined,
  completion: ResolvedCompletionPolicy,
): AgentTelemetryContext | undefined {
  const session = owner ? resolveLiveSessionScope(owner)?.telemetry : undefined;
  if (!session) return undefined;
  const completionPolicy: TelemetryCompletionPolicy = async
    ? completion.legacy
      ? "legacy"
      : (completion.policy ?? "each")
    : "inline";
  return {
    session,
    invocationSource,
    async,
    depth,
    completionPolicy,
  };
}

function telemetryForSpawnFailure(
  token: SessionToolToken | undefined,
  owner: SessionOwnerToken | undefined,
  invocationSource: TelemetryInvocationSource,
  async: boolean,
  depth: number | undefined,
  completion?: ResolvedCompletionPolicy,
): AgentTelemetryContext | undefined {
  const scope = owner
    ? resolveLiveSessionScope(owner)
    : token
      ? findSessionScope(token.id)
      : undefined;
  const session = scope?.telemetry;
  if (!session) return undefined;
  return {
    session,
    invocationSource,
    async,
    depth,
    completionPolicy: async
      ? completion?.legacy
        ? "legacy"
        : (completion?.policy ?? "each")
      : "inline",
  };
}

function captureSpawnFailure(
  telemetry: AgentTelemetryContext | undefined,
  failureStage: InProcessSpawnFailureStage,
  spawnRequestedAt: number | undefined,
): void {
  captureTelemetry(
    telemetry?.session,
    {
      event: "agent_spawn_failed",
      execution: "in-process",
      mux: "none",
      invocation_source: telemetry?.invocationSource ?? "isolated",
      model: undefined,
      async: telemetry?.async ?? false,
      depth: telemetryDepth(telemetry?.depth),
      depth_bucket: telemetryDepthBucket(telemetry?.depth),
      completion_policy:
        telemetry?.completionPolicy ?? (telemetry?.async ? "each" : "inline"),
      failure_stage: failureStage,
      spawn_duration_ms:
        spawnRequestedAt === undefined
          ? undefined
          : Date.now() - spawnRequestedAt,
    },
    { allowInactive: true },
  );
}

type InProcessResultReadOutcome =
  | "consumed"
  | "already_consumed"
  | "empty"
  | "running"
  | "error"
  | "cancelled"
  | "wait_timeout"
  | "wait_cancelled"
  | "unavailable";

function captureInProcessResultRead(
  job: JobState | undefined,
  owner: SessionOwnerToken | undefined,
  outcome: InProcessResultReadOutcome,
): void {
  const session =
    job?.telemetry?.session ??
    (owner ? resolveLiveSessionScope(owner)?.telemetry : undefined);
  captureTelemetry(
    session,
    {
      event: "result_read",
      source: "in-process",
      outcome,
      read_latency_ms:
        job?.completedAt === undefined
          ? undefined
          : Date.now() - job.completedAt,
    },
    { allowInactive: true },
  );
}

function resultReadOutcome(
  result: SubagentResult,
  firstResultRead: boolean,
): InProcessResultReadOutcome {
  if (result.cancelled) return "cancelled";
  if (result.isError) return "error";
  if (!firstResultRead) return "already_consumed";
  if (!result.output || result.output === "(no output)") return "empty";
  return "consumed";
}

/**
 * A synchronous spawn hands its output straight back to the caller, so that
 * return path is the result read for telemetry purposes.
 */
function captureSyncResultRead(
  telemetry: AgentTelemetryContext | undefined,
  result: SubagentResult,
): void {
  captureTelemetry(
    telemetry?.session,
    {
      event: "result_read",
      source: "in-process",
      outcome: resultReadOutcome(result, true),
    },
    { allowInactive: true },
  );
}

function captureDeliveryOwner(
  pi: ExtensionAPI,
  ctx: SpawnContext,
  owner: SessionOwnerToken | undefined,
): JobDeliveryOwner {
  let sessionId: string | undefined;
  try {
    sessionId = ctx.sessionManager?.getSessionId?.();
  } catch {
    /* A stale parent context has no reliable session identity. */
  }
  return {
    pi,
    sessionId,
    sessionScopeId: owner?.id,
    sessionScopeGeneration: owner?.generation,
  };
}

function discardAsyncSpawn(
  abort: AbortController,
  session: { abort: () => Promise<unknown> },
  disposeBeforeStart?: () => void,
): void {
  disposeBeforeStart?.();
  const reason = {
    source: "session_shutdown" as const,
    reason: "parent session shut down before async spawn registration",
  };
  try {
    abort.abort(reason);
  } catch {
    /* controller may already be aborted */
  }
  try {
    void Promise.resolve(session.abort()).catch(() => {
      /* child session may already be disposed */
    });
  } catch {
    /* child session may already be disposed */
  }
}

function cancelledAsyncSpawnResult(): AgentToolResult<InProcessSubagentDetails> {
  return {
    content: [
      {
        type: "text",
        text: "Async sub-agent spawn cancelled during session shutdown.",
      },
    ],
    details: { status: "cancelled" },
    isError: true,
  } as AgentToolResult<InProcessSubagentDetails>;
}
function unavailableSessionResult(): AgentToolResult<InProcessSubagentDetails> {
  return {
    content: [
      {
        type: "text",
        text: "This tool registration's parent session is no longer active.",
      },
    ],
    details: { status: "not_found" },
    isError: true,
  } as AgentToolResult<InProcessSubagentDetails>;
}

function inProcessCapacityResult(): AgentToolResult<InProcessSubagentDetails> {
  return {
    content: [
      {
        type: "text",
        text: `${MAX_REGISTRY_SIZE} in-process sub-agent jobs are retained or running. Collect a terminal result with get_subagent_result, or cancel a running job, before starting another.`,
      },
    ],
    details: { status: "error", usage: ZERO_USAGE },
    isError: true,
  } as AgentToolResult<InProcessSubagentDetails>;
}

/** Tool result returned when a spawn would exceed the orchestration depth cap. */
function depthLimitResult(
  limit: number,
): AgentToolResult<InProcessSubagentDetails> {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Orchestration depth limit reached (max ${limit}). ` +
          `You are a leaf worker — complete this task directly instead of ` +
          `delegating to another sub-agent.`,
      },
    ],
    details: { status: "error", usage: ZERO_USAGE },
    isError: true,
  } as AgentToolResult<InProcessSubagentDetails>;
}

function createAsyncJobErrorResult(error: unknown): SubagentResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `Sub-agent crashed: ${message}`,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    model: undefined,
    isError: true,
    errorMessage: message,
  };
}

function completionPolicyErrorResult(
  error: unknown,
): AgentToolResult<InProcessSubagentDetails> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Sub-agent not started: ${message}` }],
    details: { status: "error", usage: ZERO_USAGE },
    isError: true,
  } as AgentToolResult<InProcessSubagentDetails>;
}

function resolveAsyncCompletionPolicy(
  params: Record<string, unknown>,
  runAsync: boolean,
  owner?: SessionOwnerToken,
): ResolvedCompletionPolicy {
  if (!runAsync) {
    if (
      params.completionPolicy !== undefined ||
      params.completionGroupId !== undefined
    ) {
      throw new Error(
        "completionPolicy or completionGroupId is available only for background sub-agents",
      );
    }
    return { legacy: false };
  }
  // A registration without a live session scope is the pre-coordinator
  // compatibility path. Keep its historical direct notification behavior
  // instead of creating completion records that have nowhere to be owned.
  if (!owner) {
    if (
      params.completionPolicy !== undefined ||
      params.completionGroupId !== undefined
    ) {
      throw new Error(
        "completionPolicy or completionGroupId requires an active parent session",
      );
    }
    return { legacy: true };
  }
  return resolveCompletionPolicy(params);
}

function formatResolvedCompletionBehavior(
  completion: ResolvedCompletionPolicy,
  jobState: JobState,
): string {
  if (completion.legacy) {
    return formatCompletionDeliveryBehavior(
      jobState.notifyOnComplete ?? "inject",
      completionTriggersTurn(
        jobState.notifyOnComplete ?? "inject",
        jobState.triggerTurnOnComplete,
      ),
      "planned",
    );
  }
  return completion.policy === "group"
    ? `Completion will notify the user immediately and resume the parent once group ${completion.groupId} is sealed at parent settlement and all registered members finish.`
    : "Completion will notify the user immediately and resume the parent with a compact result reference when safely idle.";
}

function publishInProcessCompletion(
  jobState: JobState,
  result: SubagentResult,
  owner?: SessionOwnerToken,
): void {
  if (!jobState.completionPolicy || jobState.completionOwner === "workflow") {
    return;
  }
  if (jobState.completionPublished) return;
  publishCompletion(
    {
      schemaVersion: 1,
      completionId: `job:${jobState.id}`,
      source: "in-process",
      sourceId: jobState.id,
      label: `Job ${jobState.id}`,
      status: result.cancelled
        ? "cancelled"
        : result.isError
          ? "error"
          : "done",
      policy: jobState.completionPolicy,
      ...(jobState.completionGroupId
        ? { groupId: jobState.completionGroupId }
        : {}),
      references: result.cancelled
        ? [{ label: "status", value: "cancelled; no result retained" }]
        : [
            {
              label: "result",
              value: `call get_subagent_result with jobId ${JSON.stringify(jobState.id)}`,
            },
          ],
      completedAt: jobState.completedAt ?? Date.now(),
    },
    owner,
  );
  jobState.completionPublished = true;
}

function settleAsyncJob(
  jobId: string,
  jobState: JobState,
  result: SubagentResult,
  ctx: RunningFooterContext | undefined,
): void {
  jobState.completedAt ??= Date.now();
  const owner = inProcessJobOwner(jobState);
  if (jobState.status === "cancelled") {
    publishInProcessCompletion(
      jobState,
      result.cancelled
        ? result
        : {
            output: "",
            usage: ZERO_USAGE,
            isError: false,
            cancelled: true,
          },
      owner,
    );
    return;
  }
  if (result.cancelled) {
    jobState.status = "cancelled";
    jobState.result = result;
    publishInProcessCompletion(jobState, result, owner);
    scheduleJobCleanup(jobId, true, undefined, owner);
    if (ctx) updateRunningFooter(ctx, owner);
    return;
  }
  jobState.status = result.isError ? "error" : "done";
  jobState.result = result;
  scheduleJobCleanup(jobId, false, jobState.maxAge, owner);

  publishInProcessCompletion(jobState, result, owner);
  // A workflow aggregate consumes its children's results itself; the child must
  // never independently notify or inject into the parent session.
  const shouldDeliver =
    !jobState.completionPolicy &&
    jobState.completionOwner !== "workflow" &&
    jobState.notifyOnComplete &&
    !jobState.notificationDelivered &&
    !jobState.resultRetrieved &&
    (jobState.activeResultWaits ?? 0) === 0;
  if (shouldDeliver) {
    deliverNotification(jobState, result);
  } else if (
    !jobState.completionPolicy &&
    jobState.completionOwner !== "workflow" &&
    jobState.notifyOnComplete &&
    !jobState.notificationDelivered
  ) {
    notifyInProcessCompletionWithoutDelivery(jobState, result);
  }

  if (ctx) updateRunningFooter(ctx, owner);
}

/**
 * Write the terminal status/result onto an async job when its promise settles.
 *
 * `ctx` is optional so non-tool spawn paths (workflow children) can reuse the
 * same settlement without owning a footer surface — the poller repaints anyway.
 */
export function attachAsyncJobSettlement(
  jobId: string,
  jobState: JobState,
  ctx?: RunningFooterContext,
): void {
  const settledPromise = jobState.promise.catch(createAsyncJobErrorResult);
  jobState.promise = settledPromise;
  void settledPromise.then((result) => {
    settleAsyncJob(jobId, jobState, result, ctx);
  });
}

async function runSubagent(
  task: string,
  persona: string | undefined,
  modelOverride: string | undefined,
  cwd: string,
  contextText: string | null,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<any>) => void) | undefined,
  defaultModel: Model<any> | undefined,
  parentModelRegistry: ModelRegistry | undefined,
  thinkingLevel?: ThinkingLevel,
  depth?: number,
  rootSessionId?: string,
  owner?: SessionOwnerToken,
  telemetry?: AgentTelemetryContext,
  spawnRequestedAt?: number,
): Promise<SubagentResult> {
  let started = false;
  try {
    const { jobPromise, modelWarning, start } = await startSubagentJob({
      task,
      persona,
      modelOverride,
      cwd,
      contextText,
      signal,
      onUpdate,
      defaultModel,
      parentModelRegistry,
      thinkingLevel,
      depth,
      rootSessionId,
      owner,
      telemetry,
      spawnRequestedAt,
    });
    start?.();
    started = typeof start === "function";
    const result = await jobPromise;
    if (modelWarning && !result.isError) {
      result.output = `${modelWarning}\n---\n${result.output}`;
    }
    return result;
  } catch (err) {
    if (!started) {
      captureSpawnFailure(
        telemetry,
        spawnFailureStage(err) ?? "unknown",
        spawnRequestedAt,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: `Sub-agent crashed: ${msg}`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      model: undefined,
      isError: true,
      errorMessage: msg,
    };
  }
}

function registerSubagentWithContextTool(
  pi: ExtensionAPI,
  toolToken?: SessionToolToken,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "subagent_with_context",
    label: "Sub-Agent (with context)",
    description: [
      "Spawn an in-process sub-agent that inherits the full conversation history.",
      "WARNING: Each call serializes the entire conversation into memory. Spawning many",
      "subagents with context in parallel can cause heap exhaustion (OOM).",
      "",
      "MEMORY-SAVING ALTERNATIVES:",
      "1. Use subagent_isolated for tasks that don't need full history",
      "2. Run few parallel subagents (1-3 at a time) instead of batching many",
      "3. Consider summarizing the context before passing to subagent",
      "",
      "The sub-agent sees everything discussed so far plus the new task.",
      "Model is inherited by default. Use the model param to override (e.g. 'minimax/MiniMax-M2.7').",
      "Use list_available_models to see which models have configured auth before setting model.",
      "Use thinkingLevel to control reasoning depth (off|minimal|low|medium|high|xhigh|max). Higher levels use more tokens.",
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Review this PR for security issues", persona: "You are a senior security auditor"',
      '  - task: "Review one module", completionPolicy: "each"',
      '  - task: "Review one shard", completionPolicy: "group", completionGroupId: "review"',
      "",
      "Runs async (background) BY DEFAULT so the parent turn stays responsive — pass async: false only for a single short sub-agent whose result you need inline.",
      "Async completionPolicy defaults to each: the user gets one TUI-only notice, and safely-idle ready results are coalesced into one compact parent manifest.",
      "Use completionPolicy=group with a shared completionGroupId for related jobs; the parent resumes once its settled-turn group is sealed and every member is terminal.",
      "Human input takes priority, and successful get_subagent_result collection consumes the pending automatic delivery.",
      "Deprecated notifyOnComplete and triggerTurnOnComplete inputs map to coordinated each delivery and cannot be combined with completionPolicy or completionGroupId.",
      "Nested orchestration depth is capped (SUBAGENTURA_MAX_ORCHESTRATION_DEPTH, default 3); over-deep spawns are refused and the sub-agent should do the work itself.",
      "Use get_subagent_status for live inspection and get_subagent_result only when explicit collection is needed.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spawnRequestedAt = Date.now();
      const execution = resolveExecutionOwner(toolToken);
      if (!execution) {
        const staleScope = toolToken
          ? findSessionScope(toolToken.id)
          : undefined;
        captureSpawnFailure(
          telemetryForSpawnFailure(
            toolToken,
            undefined,
            "with_context",
            params.async ?? true,
            undefined,
          ),
          staleScope?.lifecycle === "shutdown"
            ? "parent_shutdown"
            : "session_creation",
          spawnRequestedAt,
        );
        return unavailableSessionResult();
      }
      const { owner } = execution;
      const runAsync = params.async ?? true;
      let completion: ResolvedCompletionPolicy;
      try {
        completion = resolveAsyncCompletionPolicy(params, runAsync, owner);
        assertCompletionGroupOpen(completion.policy, completion.groupId, owner);
      } catch (error) {
        captureSpawnFailure(
          telemetryForSpawnFailure(
            toolToken,
            owner,
            "with_context",
            runAsync,
            undefined,
          ),
          "registration",
          spawnRequestedAt,
        );
        return completionPolicyErrorResult(error);
      }
      debugLog("info", "tool_call", {
        toolName: "subagent_with_context",
        toolCallId: _toolCallId,
        async: runAsync,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: completion.legacy
          ? (params.notifyOnComplete ?? "inject")
          : null,
        triggerTurnOnComplete: completion.legacy
          ? (params.triggerTurnOnComplete ?? null)
          : null,
        completionPolicy:
          completion.policy ?? (completion.legacy ? "legacy" : null),
        completionGroupId: completion.groupId ?? null,
        maxAge: params.maxAge ?? null,
      });

      const spawn = resolveSpawn(ctx);
      const telemetry = telemetryForAgent(
        owner,
        "with_context",
        runAsync,
        spawn.childDepth,
        completion,
      );
      if (spawn.exceedsLimit) {
        captureSpawnFailure(telemetry, "depth_limit", spawnRequestedAt);
        return depthLimitResult(spawn.limit);
      }

      const branchResult = (() => {
        try {
          return { ok: true as const, value: ctx.sessionManager.getBranch() };
        } catch (error) {
          return { ok: false as const, error };
        }
      })();
      if (!branchResult.ok) {
        captureSpawnFailure(telemetry, "context", spawnRequestedAt);
        return completionPolicyErrorResult(branchResult.error);
      }
      const messages = branchResult.value
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

      const deliveryOwner = captureDeliveryOwner(pi, ctx, owner);
      if (runAsync) {
        if (messages.length === 0) {
          captureSpawnFailure(telemetry, "context", spawnRequestedAt);
          return {
            content: [
              { type: "text", text: "No conversation history to inherit." },
            ],
            details: {},
          };
        }

        let conversationText: string;
        try {
          const llmMessages = convertToLlm(messages);
          conversationText = serializeConversation(llmMessages);
        } catch (error) {
          captureSpawnFailure(telemetry, "context", spawnRequestedAt);
          return completionPolicyErrorResult(error);
        }
        const targetCwd = params.cwd ?? ctx.cwd;

        let completionReservation: CompletionGroupReservation | undefined;
        try {
          completionReservation = reserveCompletionGroup(
            completion.policy,
            completion.groupId,
            owner,
          );
        } catch (error) {
          captureSpawnFailure(telemetry, "registration", spawnRequestedAt);
          return completionPolicyErrorResult(error);
        }
        const abort = new AbortController();
        const startResult = await startSubagentJob({
          task: params.task,
          persona: params.persona,
          modelOverride: params.model,
          cwd: targetCwd,
          contextText: conversationText,
          signal: abort.signal,
          onUpdate: undefined,
          defaultModel: ctx.model,
          maxAge: params.maxAge,
          parentModelRegistry: ctx.modelRegistry,
          thinkingLevel: params.thinkingLevel,
          depth: spawn.childDepth,
          rootSessionId: spawn.rootSessionId,
          owner,
          telemetry,
          spawnRequestedAt,
        }).catch((error) => {
          releaseCompletionGroup(completionReservation);
          captureSpawnFailure(
            telemetry,
            spawnFailureStage(error) ?? "unknown",
            spawnRequestedAt,
          );
          throw error;
        });
        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
          thinkingLevel,
          start,
          disposeBeforeStart,
        } = startResult;
        if (owner && !resolveLiveSessionScope(owner)) {
          captureSpawnFailure(telemetry, "parent_shutdown", spawnRequestedAt);
          releaseCompletionGroup(completionReservation);
          discardAsyncSpawn(abort, session, disposeBeforeStart);
          return cancelledAsyncSpawnResult();
        }
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          cwd: targetCwd,
          promise: jobPromise,
          modelLabel,
          thinkingLevel,
          telemetry,
          abort,
          parentJobId: spawn.parentJobId,
          depth: spawn.childDepth,
          notifyOnComplete: completion.legacy
            ? params.notifyOnComplete === "notify"
              ? "notify"
              : "inject"
            : undefined,
          triggerTurnOnComplete: params.triggerTurnOnComplete,
          completionPolicy: completion.policy,
          completionGroupId: completion.groupId,
          deliveryOwner,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        let registered = false;
        try {
          registered = registerInProcessJob(jobState, owner);
        } catch (error) {
          captureSpawnFailure(telemetry, "registration", spawnRequestedAt);
          releaseCompletionGroup(completionReservation);
          discardAsyncSpawn(abort, session, disposeBeforeStart);
          return completionPolicyErrorResult(error);
        }
        if (!registered) {
          const ownerLive =
            !owner || resolveLiveSessionScope(owner) !== undefined;
          const failureStage: InProcessSpawnFailureStage = !ownerLive
            ? "parent_shutdown"
            : inProcessJobsForOwner(owner).size >= MAX_REGISTRY_SIZE
              ? "capacity"
              : "registration";
          captureSpawnFailure(telemetry, failureStage, spawnRequestedAt);
          releaseCompletionGroup(completionReservation);
          discardAsyncSpawn(abort, session, disposeBeforeStart);
          return owner && !ownerLive
            ? cancelledAsyncSpawnResult()
            : inProcessCapacityResult();
        }
        if (completion.policy) {
          try {
            registerCompletionMember(
              "in-process",
              jobId,
              completion.policy,
              completion.groupId,
              owner,
              completionReservation,
            );
          } catch (error) {
            captureSpawnFailure(telemetry, "registration", spawnRequestedAt);
            removeInProcessJob(jobId, owner);
            releaseCompletionGroup(completionReservation);
            discardAsyncSpawn(abort, session, disposeBeforeStart);
            return completionPolicyErrorResult(error);
          }
        }
        updateRunningFooter(ctx, owner);

        attachAsyncJobSettlement(jobId, jobState, ctx);
        start?.();

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.\n\n` +
                formatResolvedCompletionBehavior(completion, jobState) +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: {
            jobId,
            status: "started",
            contextMessages: messages.length,
            thinkingLevel,
          },
        };
      }

      if (messages.length === 0) {
        captureSpawnFailure(telemetry, "context", spawnRequestedAt);
        return {
          content: [
            { type: "text", text: "No conversation history to inherit." },
          ],
          details: {},
        };
      }

      let conversationText: string;
      try {
        const llmMessages = convertToLlm(messages);
        conversationText = serializeConversation(llmMessages);
      } catch (error) {
        captureSpawnFailure(telemetry, "context", spawnRequestedAt);
        return completionPolicyErrorResult(error);
      }
      const targetCwd = params.cwd ?? ctx.cwd;
      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        conversationText,
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
        params.thinkingLevel,
        spawn.childDepth,
        spawn.rootSessionId,
        owner,
        telemetry,
        spawnRequestedAt,
      );

      captureSyncResultRead(telemetry, result);
      if (result.cancelled) {
        return {
          content: [{ type: "text", text: result.output }],
          details: { status: "cancelled" },
        };
      }

      const usageStr = formatUsage(result.usage, result.model);
      const details: InProcessSubagentDetails = {
        status: result.isError ? "error" : "done",
        contextMessages: messages.length,
        usage: result.usage,
        model: result.model,
        thinkingLevel: result.thinkingLevel,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme, "subagent_with_context");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });
}

function registerSubagentIsolatedTool(
  pi: ExtensionAPI,
  toolToken?: SessionToolToken,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "subagent_isolated",
    label: "Sub-Agent (isolated)",
    description: [
      "Spawn an in-process sub-agent with a fresh, empty context window.",
      "Only receives the task and optional persona. No conversation history.",
      "Model is inherited by default. Use the model param to override (e.g. 'minimax/MiniMax-M2.7').",
      "Use list_available_models to see which models have configured auth before setting model.",
      "Use thinkingLevel to control reasoning depth (off|minimal|low|medium|high|xhigh|max). Higher levels use more tokens.",
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Propose a README outline for this repo", persona: "You are a technical writer"',
      '  - task: "Review one module", completionPolicy: "each"',
      '  - task: "Review one shard", completionPolicy: "group", completionGroupId: "review"',
      "",
      "Runs async (background) BY DEFAULT so the parent turn stays responsive — pass async: false only for a single short sub-agent whose result you need inline.",
      "Async completionPolicy defaults to each: the user gets one TUI-only notice, and safely-idle ready results are coalesced into one compact parent manifest.",
      "Use completionPolicy=group with a shared completionGroupId for related jobs; the parent resumes once its settled-turn group is sealed and every member is terminal.",
      "Human input takes priority, and successful get_subagent_result collection consumes the pending automatic delivery.",
      "Deprecated notifyOnComplete and triggerTurnOnComplete inputs map to coordinated each delivery and cannot be combined with completionPolicy or completionGroupId.",
      "Nested orchestration depth is capped (SUBAGENTURA_MAX_ORCHESTRATION_DEPTH, default 3); over-deep spawns are refused and the sub-agent should do the work itself.",
      "Use get_subagent_status for live inspection and get_subagent_result only when explicit collection is needed.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spawnRequestedAt = Date.now();
      const execution = resolveExecutionOwner(toolToken);
      if (!execution) {
        const staleScope = toolToken
          ? findSessionScope(toolToken.id)
          : undefined;
        captureSpawnFailure(
          telemetryForSpawnFailure(
            toolToken,
            undefined,
            "isolated",
            params.async ?? true,
            undefined,
          ),
          staleScope?.lifecycle === "shutdown"
            ? "parent_shutdown"
            : "session_creation",
          spawnRequestedAt,
        );
        return unavailableSessionResult();
      }
      const { owner } = execution;
      const runAsync = params.async ?? true;
      let completion: ResolvedCompletionPolicy;
      try {
        completion = resolveAsyncCompletionPolicy(params, runAsync, owner);
        assertCompletionGroupOpen(completion.policy, completion.groupId, owner);
      } catch (error) {
        captureSpawnFailure(
          telemetryForSpawnFailure(
            toolToken,
            owner,
            "isolated",
            runAsync,
            undefined,
          ),
          "registration",
          spawnRequestedAt,
        );
        return completionPolicyErrorResult(error);
      }
      debugLog("info", "tool_call", {
        toolName: "subagent_isolated",
        toolCallId: _toolCallId,
        async: runAsync,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: completion.legacy
          ? (params.notifyOnComplete ?? "inject")
          : null,
        triggerTurnOnComplete: completion.legacy
          ? (params.triggerTurnOnComplete ?? null)
          : null,
        completionPolicy:
          completion.policy ?? (completion.legacy ? "legacy" : null),
        completionGroupId: completion.groupId ?? null,
        maxAge: params.maxAge ?? null,
      });

      const spawn = resolveSpawn(ctx);
      const telemetry = telemetryForAgent(
        owner,
        "isolated",
        runAsync,
        spawn.childDepth,
        completion,
      );
      if (spawn.exceedsLimit) {
        captureSpawnFailure(telemetry, "depth_limit", spawnRequestedAt);
        return depthLimitResult(spawn.limit);
      }

      const deliveryOwner = captureDeliveryOwner(pi, ctx, owner);
      const targetCwd = params.cwd ?? ctx.cwd;
      if (runAsync) {
        let completionReservation: CompletionGroupReservation | undefined;
        try {
          completionReservation = reserveCompletionGroup(
            completion.policy,
            completion.groupId,
            owner,
          );
        } catch (error) {
          captureSpawnFailure(telemetry, "registration", spawnRequestedAt);
          return completionPolicyErrorResult(error);
        }
        // Own the child's session so any ancestor abort cascades to it.
        const abort = new AbortController();
        const startResult = await startSubagentJob({
          task: params.task,
          persona: params.persona,
          modelOverride: params.model,
          cwd: targetCwd,
          contextText: null,
          signal: abort.signal,
          onUpdate: undefined,
          defaultModel: ctx.model,
          maxAge: params.maxAge,
          parentModelRegistry: ctx.modelRegistry,
          thinkingLevel: params.thinkingLevel,
          depth: spawn.childDepth,
          rootSessionId: spawn.rootSessionId,
          owner,
          telemetry,
          spawnRequestedAt,
        }).catch((error) => {
          releaseCompletionGroup(completionReservation);
          captureSpawnFailure(
            telemetry,
            spawnFailureStage(error) ?? "unknown",
            spawnRequestedAt,
          );
          throw error;
        });
        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
          thinkingLevel,
          start,
          disposeBeforeStart,
        } = startResult;
        if (owner && !resolveLiveSessionScope(owner)) {
          captureSpawnFailure(telemetry, "parent_shutdown", spawnRequestedAt);
          releaseCompletionGroup(completionReservation);
          discardAsyncSpawn(abort, session, disposeBeforeStart);
          return cancelledAsyncSpawnResult();
        }
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          cwd: targetCwd,
          promise: jobPromise,
          modelLabel,
          thinkingLevel,
          telemetry,
          abort,
          parentJobId: spawn.parentJobId,
          depth: spawn.childDepth,
          notifyOnComplete: completion.legacy
            ? params.notifyOnComplete === "notify"
              ? "notify"
              : "inject"
            : undefined,
          triggerTurnOnComplete: params.triggerTurnOnComplete,
          completionPolicy: completion.policy,
          completionGroupId: completion.groupId,
          deliveryOwner,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        let registered = false;
        try {
          registered = registerInProcessJob(jobState, owner);
        } catch (error) {
          captureSpawnFailure(telemetry, "registration", spawnRequestedAt);
          releaseCompletionGroup(completionReservation);
          discardAsyncSpawn(abort, session, disposeBeforeStart);
          return completionPolicyErrorResult(error);
        }
        if (!registered) {
          const ownerLive =
            !owner || resolveLiveSessionScope(owner) !== undefined;
          const failureStage: InProcessSpawnFailureStage = !ownerLive
            ? "parent_shutdown"
            : inProcessJobsForOwner(owner).size >= MAX_REGISTRY_SIZE
              ? "capacity"
              : "registration";
          captureSpawnFailure(telemetry, failureStage, spawnRequestedAt);
          releaseCompletionGroup(completionReservation);
          discardAsyncSpawn(abort, session, disposeBeforeStart);
          return owner && !ownerLive
            ? cancelledAsyncSpawnResult()
            : inProcessCapacityResult();
        }
        if (completion.policy) {
          try {
            registerCompletionMember(
              "in-process",
              jobId,
              completion.policy,
              completion.groupId,
              owner,
              completionReservation,
            );
          } catch (error) {
            captureSpawnFailure(telemetry, "registration", spawnRequestedAt);
            removeInProcessJob(jobId, owner);
            releaseCompletionGroup(completionReservation);
            discardAsyncSpawn(abort, session, disposeBeforeStart);
            return completionPolicyErrorResult(error);
          }
        }
        updateRunningFooter(ctx, owner);

        attachAsyncJobSettlement(jobId, jobState, ctx);
        start?.();

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.\n\n` +
                formatResolvedCompletionBehavior(completion, jobState) +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: {
            jobId,
            status: "started",
            contextMessages: 0,
            thinkingLevel,
          },
        };
      }

      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        params.cwd ?? ctx.cwd,
        null,
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
        params.thinkingLevel,
        spawn.childDepth,
        spawn.rootSessionId,
        owner,
        telemetry,
        spawnRequestedAt,
      );

      captureSyncResultRead(telemetry, result);
      if (result.cancelled) {
        return {
          content: [{ type: "text", text: result.output }],
          details: { status: "cancelled" },
        };
      }

      const usageStr = formatUsage(result.usage, result.model);
      const details: InProcessSubagentDetails = {
        status: result.isError ? "error" : "done",
        contextMessages: 0,
        usage: result.usage,
        model: result.model,
        thinkingLevel: result.thinkingLevel,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme, "subagent_isolated");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });
}

function registerGetSubagentStatusTool(
  pi: ExtensionAPI,
  toolToken?: SessionToolToken,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description:
      "Poll an async subagent job by jobId. Returns live preview of the subagent's current turn, active tool, and output.",
    parameters: StatusParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const execution = resolveExecutionOwner(toolToken);
      if (!execution) return unavailableSessionResult();
      debugLog("info", "tool_call", {
        toolName: "get_subagent_status",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      const job = getInProcessJob(params.jobId, execution.owner);

      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} not found. It may have been cancelled.`,
            },
          ],
          details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }

      if (job.status === "done" || job.status === "error") {
        const result = job.result!;
        const usageStr = formatUsage(result.usage, result.model);
        return {
          content: [{ type: "text", text: result.output }],
          details: {
            status: job.status,
            usage: result.usage,
            model: result.model,
            usageSummary: usageStr,
            thinkingLevel: result.thinkingLevel,
          },
          isError: result.isError,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            { type: "text", text: `Job ${params.jobId} was cancelled.` },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      return buildLiveUpdate(job.liveStatus, job.modelLabel);
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("get_subagent_status ")) +
        theme.fg("accent", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const details = result.details as InProcessSubagentDetails | undefined;
      if (details?.status === "running") {
        return renderSubagentResult(
          result,
          { ...options, isPartial: true },
          theme,
          context,
        );
      }
      return renderSubagentResult(result, options, theme, context);
    },
  });
}

function registerGetSubagentResultTool(
  pi: ExtensionAPI,
  toolToken?: SessionToolToken,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description: [
      "Retrieve an async subagent job's current or final result and usage summary.",
      "A running job returns immediately with live status unless waiting is explicit. Pass wait: true to wait up to timeoutMs.",
      "ONLY call this tool when the user explicitly asks you to wait for or collect a specific async result.",
      "Do not call it immediately after spawning async sub-agents; coordinated completion notices and compact manifests handle normal background fan-out. Successful terminal collection consumes the matching pending automatic delivery.",
    ].join("\n"),
    parameters: ResultParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const execution = resolveExecutionOwner(toolToken);
      if (!execution) return unavailableSessionResult();
      const job = getInProcessJob(params.jobId, execution.owner);
      debugLog("info", "tool_call", {
        toolName: "get_subagent_result",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      if (!job) {
        captureInProcessResultRead(undefined, execution.owner, "unavailable");
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} not found. It may have been cancelled.`,
            },
          ],
          details: { jobId: params.jobId },
          isError: true,
        };
      }

      if (job.status === "cancelled") {
        captureInProcessResultRead(job, execution.owner, "cancelled");
        consumeCompletionSource(
          pi,
          { source: "in-process", sourceId: job.id },
          execution.owner,
        );
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was cancelled before completion.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      // If signal is already aborted, return immediately without setting resultRetrieved
      if (signal?.aborted) {
        captureInProcessResultRead(job, execution.owner, "wait_cancelled");
        return {
          content: [
            {
              type: "text",
              text: `Wait for job ${params.jobId} cancelled.`,
            },
          ],
          details: { jobId: params.jobId, status: "wait_cancelled" },
          isError: true,
        };
      }

      if (job.status === "running" && params.wait !== true) {
        captureInProcessResultRead(job, execution.owner, "running");
        const currentText = job.liveStatus.output.trim();
        const live = buildLiveUpdate(job.liveStatus, job.modelLabel);
        return {
          ...live,
          content: [
            {
              type: "text",
              text: currentText
                ? `${currentText}\n\nJob ${params.jobId} continues in the background.`
                : `Job ${params.jobId} continues in the background.`,
            },
          ],
          details: {
            ...(live.details as Record<string, unknown>),
            jobId: params.jobId,
          },
        };
      }

      // Active waits suppress settlement notifications while they are running,
      // without treating an aborted wait as a retrieved result.
      job.activeResultWaits = (job.activeResultWaits ?? 0) + 1;
      let timedOut = false;
      let waitResult: Awaited<ReturnType<typeof abortableWait<SubagentResult>>>;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let parentAbortHandler: (() => void) | undefined;
      const waitTimeoutMs = Math.min(
        Math.max(params.timeoutMs ?? 30_000, 1),
        300_000,
      );
      let waitActive = true;
      const releaseActiveResultWait = (): void => {
        if (!waitActive) return;
        waitActive = false;
        job.activeResultWaits = Math.max(0, (job.activeResultWaits ?? 1) - 1);
      };
      const waitController = new AbortController();
      const cleanup = (): void => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (signal && parentAbortHandler) {
          signal.removeEventListener("abort", parentAbortHandler);
        }
        releaseActiveResultWait();
      };
      parentAbortHandler = () => {
        releaseActiveResultWait();
        waitController.abort(signal?.reason);
      };
      if (signal) {
        signal.addEventListener("abort", parentAbortHandler);
      }
      if (job.status === "running") {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          releaseActiveResultWait();
          waitController.abort("timeout");
        }, waitTimeoutMs);
      }
      try {
        waitResult = await abortableWait(job.promise, waitController.signal);
      } finally {
        cleanup();
      }
      if (waitResult.aborted) {
        if (timedOut) {
          captureInProcessResultRead(job, execution.owner, "wait_timeout");
          return {
            content: [
              {
                type: "text",
                text: `Timed out while waiting for job ${params.jobId} after ${waitTimeoutMs}ms.`,
              },
            ],
            details: {
              jobId: params.jobId,
              status: "wait_timeout",
              timeoutMs: waitTimeoutMs,
            },
            isError: true,
          };
        }
        captureInProcessResultRead(job, execution.owner, "wait_cancelled");
        return {
          content: [
            { type: "text", text: `Wait for job ${params.jobId} cancelled.` },
          ],
          details: { jobId: params.jobId, status: "wait_cancelled" },
          isError: true,
        };
      }
      if (execution.owner && !resolveLiveSessionScope(execution.owner)) {
        captureInProcessResultRead(job, execution.owner, "unavailable");
        return unavailableSessionResult();
      }
      const result = waitResult.value!;
      // Only set resultRetrieved after successful completion (not on abort)
      const firstResultRead = !job.resultRetrieved;
      job.resultRetrieved = true;
      const outcome =
        (job.status as JobStatus) === "cancelled"
          ? "cancelled"
          : resultReadOutcome(result, firstResultRead);
      captureInProcessResultRead(job, execution.owner, outcome);
      consumeCompletionSource(
        pi,
        { source: "in-process", sourceId: job.id },
        execution.owner,
      );
      if (job.cleanupAfterCollection) {
        job.cleanupAfterCollection = false;
        scheduleJobCleanup(job.id, true, undefined, execution.owner);
      }

      if ((job.status as JobStatus) === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was cancelled before completion.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }
      const usageStr = formatUsage(result.usage, result.model);
      const details: InProcessSubagentDetails = {
        status: result.isError ? "error" : "done",
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
        thinkingLevel: result.thinkingLevel,
      };
      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("get_subagent_result ")) +
        theme.fg("accent", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });
}

function registerCancelSubagentTool(
  pi: ExtensionAPI,
  toolToken?: SessionToolToken,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "cancel_subagent",
    label: "Cancel Subagent",
    description: "Abort a running async subagent job by jobId.",
    parameters: CancelParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const execution = resolveExecutionOwner(toolToken);
      if (!execution) return unavailableSessionResult();
      const job = getInProcessJob(params.jobId, execution.owner);
      debugLog("info", "tool_call", {
        toolName: "cancel_subagent",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      if (!job) {
        return {
          content: [{ type: "text", text: `Job ${params.jobId} not found.` }],
          details: { jobId: params.jobId },
          isError: true,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was already cancelled.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
        };
      }

      if (job.status === "done" || job.status === "error") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} already completed — cannot cancel.`,
            },
          ],
          details: { jobId: params.jobId, status: job.status },
          isError: true,
        };
      }

      let initiator: string | undefined;
      try {
        initiator = (
          ctx as { sessionManager?: { getSessionId?: () => string } }
        ).sessionManager?.getSessionId?.();
      } catch {
        initiator = undefined;
      }
      const info = {
        source: "cancel_subagent" as const,
        initiator,
        reason: `cancel_subagent tool cancelled job ${params.jobId}`,
      };
      job.cancellation = { ...info, at: Date.now() };
      job.cancellationSnapshot = snapshotInProcessSession({
        kind: "in-process",
        jobId: job.id,
        session: job.session,
        cwd: ctx.cwd ?? process.cwd(),
        model: job.modelLabel,
        activeTool: job.liveStatus.activeTool,
        partialOutput: job.liveStatus.output,
        source: "cancel_subagent",
        initiator: info.initiator,
        reason: info.reason,
      });
      try {
        // Aborts this job AND cascades to every descendant it owns.
        abortJobTree(params.jobId, info, execution.owner);
      } catch {
        /* Session may already be disposed; abort is best-effort */
      }
      job.status = "cancelled";
      job.completedAt ??= Date.now();
      publishInProcessCompletion(
        job,
        job.result ?? {
          output: "",
          usage: ZERO_USAGE,
          isError: false,
          cancelled: true,
        },
        execution.owner,
      );
      scheduleJobCleanup(params.jobId, true, undefined, execution.owner);
      updateRunningFooter(ctx, execution.owner);

      return {
        content: [{ type: "text", text: `Job ${params.jobId} cancelled.` }],
        details: {
          jobId: params.jobId,
          status: "cancelled",
          snapshot: job.cancellationSnapshot,
        },
      };
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("cancel_subagent ")) +
        theme.fg("error", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as
        (InProcessSubagentDetails & { jobId?: string }) | undefined;
      const jobId = String(details?.jobId ?? "unknown");
      const cancelled = details?.status === "cancelled";
      const firstContent = result.content?.[0];
      const message =
        firstContent?.type === "text"
          ? firstContent.text
          : `Job ${jobId} not found`;
      const text = cancelled
        ? theme.fg("error", `✕ Job ${jobId} cancelled`)
        : theme.fg("error", message);
      return new Text(text, 0, 0);
    },
  });
}

function registerListAvailableModelsTool(pi: ExtensionAPI): void {
  registerToolWithDefaultGuidance(pi, {
    name: "list_available_models",
    label: "List Available Models",
    description: [
      "List all available AI models that can be used with subagent_with_context or subagent_isolated.",
      "Returns provider/model IDs and auth status. Use this to validate model identifiers before passing",
      "them to subagent tools — prevents silent fallback to the parent session model.",
    ].join("\n"),
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description:
            "Optional substring filter for provider or model name (case-insensitive)",
        }),
      ),
      authOnly: Type.Optional(
        Type.Boolean({
          description:
            "If true, only return models with configured auth (default: true). Set false to see all known models.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const modelRegistry = ctx.modelRegistry;
      debugLog("info", "tool_call", {
        toolName: "list_available_models",
        toolCallId: _toolCallId,
        authOnly: params.authOnly ?? true,
        filter: params.filter ?? null,
      });

      const models =
        params.authOnly !== false
          ? modelRegistry.getAvailable()
          : modelRegistry.getAll();

      let filtered = models;
      if (params.filter) {
        const f = params.filter.toLowerCase();
        filtered = models.filter(
          (m) =>
            m.provider.toLowerCase().includes(f) ||
            m.id.toLowerCase().includes(f) ||
            m.name?.toLowerCase().includes(f),
        );
      }

      const lines = filtered.map(
        (m) =>
          `${m.provider}/${m.id}` +
          (m.name && m.name !== m.id ? `  (${m.name})` : ""),
      );

      const summary =
        params.authOnly !== false
          ? `${filtered.length} model${filtered.length === 1 ? "" : "s"} with auth configured`
          : `${filtered.length} model${filtered.length === 1 ? "" : "s"} total`;
      const headerLines = [summary];
      if (params.filter) {
        headerLines.push(`Search pattern: ${params.filter}`);
      }

      return {
        content: [
          {
            type: "text",
            text:
              `${headerLines.join("\n")}\n\n` +
              lines.map((l) => `  ${l}`).join("\n") +
              (filtered.length === 0 ? "\n(no models match)" : ""),
          },
        ],
        details: {
          count: filtered.length,
          models: filtered.map((m) => ({
            provider: m.provider,
            id: m.id,
            name: m.name,
          })),
        },
      };
    },
  });
}

function registerPruneSubagentJobsTool(
  pi: ExtensionAPI,
  toolToken?: SessionToolToken,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "prune_subagent_jobs",
    label: "Prune Subagent Jobs",
    description: [
      "Remove all completed and failed subagent jobs from the registry.",
      "Running and cancelled jobs are preserved.",
      "Returns the number of jobs removed.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute(): Promise<any> {
      const execution = resolveExecutionOwner(toolToken);
      if (!execution) return unavailableSessionResult();
      const registry = inProcessJobsForOwner(execution.owner);
      const before = registry.size;
      debugLog("info", "tool_call", {
        toolName: "prune_subagent_jobs",
      });

      const removed = pruneCompletedJobs(execution.owner);
      const after = registry.size;

      return {
        content: [
          {
            type: "text",
            text: `Removed ${removed} completed job${removed === 1 ? "" : "s"}. Registry: ${before} → ${after} jobs.`,
          },
        ],
        details: { removed, before, after },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("prune_subagent_jobs")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as { removed?: number } | undefined;
      const removed = Number(details?.removed ?? 0);
      const text =
        removed > 0
          ? theme.fg(
              "success",
              `✓ Pruned ${removed} job${removed === 1 ? "" : "s"}`,
            )
          : theme.fg("dim", "No completed jobs to prune");
      return new Text(text, 0, 0);
    },
  });
}

function registerCleanupArtifactsTool(
  pi: ExtensionAPI,
  registrationScope?: SessionScope,
): void {
  const toolToken: SessionToolToken | undefined = registrationScope
    ? { id: registrationScope.id }
    : undefined;
  registerToolWithDefaultGuidance(pi, {
    name: "cleanup_subagent_artifacts",
    label: "Cleanup Subagent Artifacts",
    description: [
      "Delete old interactive sub-agent artifact directories past a TTL threshold.",
      "Preserves directories whose sub-agent is still tracked in the live registry",
      "or whose last activity (dir mtime or latest event timestamp) is within the TTL window.",
      "",
      "Path-safety: validates every directory is inside the artifact root and blocks",
      "path-traversal attempts. Dry-run mode reports what would be deleted without",
      "actually deleting.",
    ].join("\n"),
    parameters: Type.Object({
      ttlMs: Type.Number({
        description:
          "Age threshold in milliseconds. Directories with no activity more recent than this are candidates for deletion.",
        minimum: 60_000,
      }),
      rootDir: Type.Optional(
        Type.String({
          description: [
            "Artifact root directory to scan. Defaults to the session root:",
            "$PI_CODING_AGENT_SESSION_DIR/subagentura/ (if env var is set) or",
            "~/.pi/agent/sessions/subagentura/.",
            "The cleanup pass traverses each <cwdLabel>/artifacts subtree.",
          ].join("\n"),
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "If true, report what would be deleted without actually deleting. Defaults to true for safety.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      const scope = resolveToolSessionScope(toolToken);
      if (
        !scope &&
        (toolToken !== undefined || getStartedSessionScopes().length > 0)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "This cleanup tool registration is no longer attached to a live session.",
            },
          ],
          details: { status: "session_unavailable" },
          isError: true,
        };
      }
      let parentSessionId: string | undefined;
      try {
        parentSessionId =
          scope?.sessionManager?.getSessionId?.() ??
          ctx?.sessionManager?.getSessionId?.();
      } catch {
        /* Missing ownership evidence fails closed below. */
      }
      if (
        !parentSessionId &&
        (scope !== undefined || getStartedSessionScopes().length > 0)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Cannot clean artifacts without current parent-session ownership evidence.",
            },
          ],
          details: { status: "session_unavailable" },
          isError: true,
        };
      }
      const activeIds = new Set<string>();
      const states =
        scope?.interactiveStates ??
        (getStartedSessionScopes().length === 0
          ? interactiveSubagentRegistry
          : new Map());
      for (const state of states.values()) activeIds.add(state.id);

      const dryRun = params.dryRun !== false; // default true for safety
      const ttlMs = params.ttlMs;

      const rootDir =
        params.rootDir ??
        (() => {
          const sessionDir =
            process.env.PI_CODING_AGENT_SESSION_DIR ??
            join(homedir(), ".pi", "agent", "sessions");
          return join(sessionDir, "subagentura");
        })();

      const result: CleanupResult = cleanupOldArtifacts(rootDir, ttlMs, {
        activeIds,
        ownerSessionId: parentSessionId,
        dryRun,
      });

      const lines = [
        `Cleanup ${dryRun ? "(dry run) " : ""}— ${result.removed} removed, ${result.skipped} skipped, ${result.errors.length} errors`,
      ];
      for (const err of result.errors) {
        lines.push(`  error: ${err}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...result },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("cleanup_subagent_artifacts")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as Partial<CleanupResult> | undefined;
      const removed = details?.removed ?? 0;
      const skipped = details?.skipped ?? 0;
      const errors = details?.errors?.length ?? 0;
      const dryRun = details?.dryRun ?? false;
      if (dryRun) {
        return new Text(
          removed > 0 || errors > 0
            ? theme.fg(
                "warning",
                `~ Cleanup: ${removed} would be removed, ${skipped} skipped, ${errors} errors`,
              )
            : theme.fg(
                "dim",
                `~ No old artifacts found (${skipped} active/skipped)`,
              ),
          0,
          0,
        );
      }
      return new Text(
        removed > 0
          ? theme.fg(
              "success",
              `✓ Cleaned ${removed} artifact dirs, ${skipped} skipped, ${errors} errors`,
            )
          : theme.fg(
              "dim",
              `No old artifacts to clean (${skipped} active/skipped)`,
            ),
        0,
        0,
      );
    },
  });
}

export function registerInProcessSubagentTools(
  pi: ExtensionAPI,
  scope?: SessionScope,
): void {
  const toolToken: SessionToolToken | undefined = scope
    ? { id: scope.id }
    : undefined;
  registerSubagentWithContextTool(pi, toolToken);
  registerSubagentIsolatedTool(pi, toolToken);
  registerGetSubagentStatusTool(pi, toolToken);
  registerGetSubagentResultTool(pi, toolToken);
  registerCancelSubagentTool(pi, toolToken);
}

export function registerInProcessMaintenanceTools(
  pi: ExtensionAPI,
  scope?: SessionScope,
): void {
  registerListAvailableModelsTool(pi);
  registerPruneSubagentJobsTool(pi, scope ? { id: scope.id } : undefined);
  registerCleanupArtifactsTool(pi, scope);
}

export function registerSubagentModelListTool(pi: ExtensionAPI): void {
  registerListAvailableModelsTool(pi);
}
export function registerSubagentArtifactsCleanupTool(
  pi: ExtensionAPI,
  scope?: SessionScope,
): void {
  registerCleanupArtifactsTool(pi, scope);
}

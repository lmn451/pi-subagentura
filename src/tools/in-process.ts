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
import { updateRunningSubagentFooter } from "../artifact-poller";
import { cleanupOldArtifacts, type CleanupResult } from "../artifact";
import {
  abortJobTree,
  buildLiveUpdate,
  debugLog,
  formatUsage,
  jobRegistry,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobDeliveryOwner,
  type JobState,
  type JobStatus,
  type SubagentLiveStatus,
  type SubagentResult,
  type Usage,
} from "../helpers";
import { resolveSpawnDepth } from "../orchestration-context";
import {
  getActiveSessionContextToken,
  isSessionContextTokenLive,
} from "../session-context";
import { abortableWait } from "../abortable-wait";
import { snapshotInProcessSession } from "../cancellation-snapshots";
import {
  completionTriggersTurn,
  deliverNotification,
  formatCompletionDeliveryBehavior,
  notifyInProcessCompletionWithoutDelivery,
} from "../notifications";
import { interactiveSubagentRegistry } from "../interactive-tmux";
import { renderSubagentCall, renderSubagentResult } from "../rendering";
import {
  BaseParams,
  CancelParams,
  ResultParams,
  StatusParams,
} from "../schemas";

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

function updateRunningFooter(ctx: RunningFooterContext): void {
  updateRunningSubagentFooter(ctx.ui, getActiveSessionContextToken());
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

function captureDeliveryOwner(
  pi: ExtensionAPI,
  ctx: SpawnContext,
  token: ReturnType<typeof getActiveSessionContextToken>,
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
    sessionContextId: token?.id,
    sessionContextGeneration: token?.generation,
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

function settleAsyncJob(
  jobId: string,
  jobState: JobState,
  result: SubagentResult,
  ctx: RunningFooterContext | undefined,
): void {
  if (jobState.status === "cancelled") return;
  if (result.cancelled) {
    jobState.status = "cancelled";
    jobState.result = result;
    scheduleJobCleanup(jobId, true);
    if (ctx) updateRunningFooter(ctx);
    return;
  }
  jobState.status = result.isError ? "error" : "done";
  jobState.result = result;
  scheduleJobCleanup(jobId, false, jobState.maxAge);

  // A workflow aggregate consumes its children's results itself; the child must
  // never independently notify or inject into the parent session.
  const shouldDeliver =
    jobState.completionOwner !== "workflow" &&
    jobState.notifyOnComplete &&
    !jobState.notificationDelivered &&
    !jobState.resultRetrieved &&
    (jobState.activeResultWaits ?? 0) === 0;
  if (shouldDeliver) {
    deliverNotification(jobState, result);
  } else if (
    jobState.completionOwner !== "workflow" &&
    jobState.notifyOnComplete &&
    !jobState.notificationDelivered
  ) {
    notifyInProcessCompletionWithoutDelivery(jobState, result);
  }

  if (ctx) updateRunningFooter(ctx);
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
): Promise<SubagentResult> {
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
    });
    start?.();
    const result = await jobPromise;
    if (modelWarning && !result.isError) {
      result.output = `${modelWarning}\n---\n${result.output}`;
    }
    return result;
  } catch (err) {
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

function registerSubagentWithContextTool(pi: ExtensionAPI): void {
  pi.registerTool({
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
      '  - task: "Continue debugging while we plan next steps", async: true, notifyOnComplete: "notify"',
      '  - task: "Summarize the key decisions made in this conversation", model: "anthropic/claude-sonnet-4-5"',
      "",
      "Runs async (background) BY DEFAULT so the parent turn stays responsive — pass async: false only for a single short sub-agent whose result you need inline.",
      "When fanning out multiple sub-agents (e.g. one per PR/file), leave async at its default so they run concurrently without blocking the parent.",
      'The main agent continues immediately; async jobs inject their result by default when complete. Pass notifyOnComplete: "notify" to persist a pointer-only completion in parent context without injecting the full output.',
      "Nested orchestration depth is capped (SUBAGENTURA_MAX_ORCHESTRATION_DEPTH, default 3); over-deep spawns are refused and the sub-agent should do the work itself.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
      "Both modes show the user a completion notification.",
      "notifyOnComplete controls the LLM payload; triggerTurnOnComplete independently controls whether a new parent turn starts.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runAsync = params.async ?? true;
      debugLog("info", "tool_call", {
        toolName: "subagent_with_context",
        toolCallId: _toolCallId,
        async: runAsync,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        triggerTurnOnComplete: params.triggerTurnOnComplete ?? false,
        maxAge: params.maxAge ?? null,
      });

      const spawn = resolveSpawn(ctx);
      if (spawn.exceedsLimit) return depthLimitResult(spawn.limit);

      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

      const spawnContextToken = getActiveSessionContextToken();
      const deliveryOwner = captureDeliveryOwner(pi, ctx, spawnContextToken);
      if (runAsync) {
        if (messages.length === 0) {
          return {
            content: [
              { type: "text", text: "No conversation history to inherit." },
            ],
            details: {},
          };
        }

        const llmMessages = convertToLlm(messages);
        const conversationText = serializeConversation(llmMessages);
        const targetCwd = params.cwd ?? ctx.cwd;

        // Own the child's session so any ancestor abort cascades to it.
        const abort = new AbortController();
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
        } = await startSubagentJob({
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
        });
        if (!isSessionContextTokenLive(spawnContextToken)) {
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
          abort,
          parentJobId: spawn.parentJobId,
          depth: spawn.childDepth,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : "inject",
          triggerTurnOnComplete: params.triggerTurnOnComplete,
          deliveryOwner,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        jobRegistry.set(jobId, jobState);
        updateRunningFooter(ctx);

        attachAsyncJobSettlement(jobId, jobState, ctx);
        start?.();

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.\n\n` +
                formatCompletionDeliveryBehavior(
                  jobState.notifyOnComplete ?? "inject",
                  completionTriggersTurn(
                    jobState.notifyOnComplete ?? "inject",
                    jobState.triggerTurnOnComplete,
                  ),
                  "planned",
                ) +
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
        return {
          content: [
            { type: "text", text: "No conversation history to inherit." },
          ],
          details: {},
        };
      }

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
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
      );

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

function registerSubagentIsolatedTool(pi: ExtensionAPI): void {
  pi.registerTool({
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
      '  - task: "Give me a second opinion on this approach", model: "anthropic/claude-sonnet-4-5"',
      '  - task: "Analyze this code without context contamination", async: true, notifyOnComplete: "inject"',
      "",
      "Runs async (background) BY DEFAULT so the parent turn stays responsive — pass async: false only for a single short sub-agent whose result you need inline.",
      "When fanning out multiple sub-agents (e.g. one per PR/file), leave async at its default so they run concurrently without blocking the parent.",
      "The main agent continues immediately. Use get_subagent_status to poll progress and get_subagent_result to collect output.",
      "Nested orchestration depth is capped (SUBAGENTURA_MAX_ORCHESTRATION_DEPTH, default 3); over-deep spawns are refused and the sub-agent should do the work itself.",
      "Both modes show the user a completion notification.",
      "notifyOnComplete controls the LLM payload; triggerTurnOnComplete independently controls whether a new parent turn starts.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runAsync = params.async ?? true;
      debugLog("info", "tool_call", {
        toolName: "subagent_isolated",
        toolCallId: _toolCallId,
        async: runAsync,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        triggerTurnOnComplete: params.triggerTurnOnComplete ?? false,
        maxAge: params.maxAge ?? null,
      });

      const spawn = resolveSpawn(ctx);
      if (spawn.exceedsLimit) return depthLimitResult(spawn.limit);

      const spawnContextToken = getActiveSessionContextToken();
      const deliveryOwner = captureDeliveryOwner(pi, ctx, spawnContextToken);
      if (runAsync) {
        const targetCwd = params.cwd ?? ctx.cwd;
        // Own the child's session so any ancestor abort cascades to it.
        const abort = new AbortController();
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
        } = await startSubagentJob({
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
        });
        if (!isSessionContextTokenLive(spawnContextToken)) {
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
          abort,
          parentJobId: spawn.parentJobId,
          depth: spawn.childDepth,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : "inject",
          triggerTurnOnComplete: params.triggerTurnOnComplete,
          deliveryOwner,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        jobRegistry.set(jobId, jobState);
        updateRunningFooter(ctx);

        attachAsyncJobSettlement(jobId, jobState, ctx);
        start?.();

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.\n\n` +
                formatCompletionDeliveryBehavior(
                  jobState.notifyOnComplete ?? "inject",
                  completionTriggersTurn(
                    jobState.notifyOnComplete ?? "inject",
                    jobState.triggerTurnOnComplete,
                  ),
                  "planned",
                ) +
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
      );

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

function registerGetSubagentStatusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description:
      "Poll an async subagent job by jobId. Returns live preview of the subagent's current turn, active tool, and output.",
    parameters: StatusParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      debugLog("info", "tool_call", {
        toolName: "get_subagent_status",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      const job = jobRegistry.get(params.jobId);

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

function registerGetSubagentResultTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description: [
      "Retrieve an async subagent job's current or final result and usage summary.",
      "A running job returns immediately with live status unless waiting is explicit. Pass wait: true to wait up to timeoutMs.",
      "ONLY call this tool when the user explicitly asks you to wait for or collect a specific async result.",
      "Do not call it immediately after spawning async sub-agents; completion injection handles normal background fan-out.",
    ].join("\n"),
    parameters: ResultParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const job = jobRegistry.get(params.jobId);
      debugLog("info", "tool_call", {
        toolName: "get_subagent_result",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      if (!job) {
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
        const live = buildLiveUpdate(job.liveStatus, job.modelLabel);
        const currentText =
          (live.content?.[0] as { type: "text"; text: string } | undefined)
            ?.text || "";
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
        return {
          content: [
            { type: "text", text: `Wait for job ${params.jobId} cancelled.` },
          ],
          details: { jobId: params.jobId, status: "wait_cancelled" },
          isError: true,
        };
      }
      const result = waitResult.value!;
      // Only set resultRetrieved after successful completion (not on abort)
      job.resultRetrieved = true;

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

function registerCancelSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cancel_subagent",
    label: "Cancel Subagent",
    description: "Abort a running async subagent job by jobId.",
    parameters: CancelParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = jobRegistry.get(params.jobId);
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
        abortJobTree(params.jobId, info);
      } catch {
        /* Session may already be disposed; abort is best-effort */
      }
      job.status = "cancelled";
      scheduleJobCleanup(params.jobId, true);
      updateRunningFooter(ctx);

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
  pi.registerTool({
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

function registerPruneSubagentJobsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prune_subagent_jobs",
    label: "Prune Subagent Jobs",
    description: [
      "Remove all completed and failed subagent jobs from the registry.",
      "Running and cancelled jobs are preserved.",
      "Returns the number of jobs removed.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute() {
      const before = jobRegistry.size;
      debugLog("info", "tool_call", {
        toolName: "prune_subagent_jobs",
      });

      const removed = pruneCompletedJobs();
      const after = jobRegistry.size;

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

function registerCleanupArtifactsTool(pi: ExtensionAPI): void {
  pi.registerTool({
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

    async execute(_toolCallId, params): Promise<any> {
      const activeIds = new Set<string>();
      for (const state of interactiveSubagentRegistry.values()) {
        activeIds.add(state.id);
      }

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

export function registerInProcessSubagentTools(pi: ExtensionAPI): void {
  registerSubagentWithContextTool(pi);
  registerSubagentIsolatedTool(pi);
  registerGetSubagentStatusTool(pi);
  registerGetSubagentResultTool(pi);
  registerCancelSubagentTool(pi);
}

export function registerInProcessMaintenanceTools(pi: ExtensionAPI): void {
  registerListAvailableModelsTool(pi);
  registerPruneSubagentJobsTool(pi);
  registerCleanupArtifactsTool(pi);
}

export function registerSubagentModelListTool(pi: ExtensionAPI): void {
  registerListAvailableModelsTool(pi);
}
export function registerSubagentArtifactsCleanupTool(pi: ExtensionAPI): void {
  registerCleanupArtifactsTool(pi);
}

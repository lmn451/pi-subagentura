import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { FOOTER_KEY } from "../artifact-poller";
import { cleanupOldArtifacts, type CleanupResult } from "../artifact";
import {
  buildLiveUpdate,
  debugLog,
  formatUsage,
  jobRegistry,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type SubagentLiveStatus,
  type SubagentResult,
  type Usage,
} from "../helpers";
import { deliverNotification } from "../notifications";
import { interactiveSubagentRegistry } from "../interactive-tmux";
import { renderSubagentCall, renderSubagentResult } from "../rendering";
import {
  BaseParams,
  CancelParams,
  ResultParams,
  StatusParams,
} from "../schemas";

interface RunningFooterContext {
  ui: {
    setStatus(key: string, value?: string): void;
  };
}

type InProcessSubagentDetails =
  | { status: "started"; jobId: string; contextMessages: number }
  | { status: "running"; subagentStatus: SubagentLiveStatus; model?: string }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found"; jobId?: string };

function getRunningJobCount(): number {
  return [...jobRegistry.values()].filter((job) => job.status === "running")
    .length;
}

function updateRunningFooter(ctx: RunningFooterContext): void {
  const runningCount = getRunningJobCount();
  try {
    ctx.ui.setStatus(
      FOOTER_KEY,
      runningCount > 0
        ? `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`
        : undefined,
    );
  } catch {
    /* ctx stale */
  }
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
): Promise<SubagentResult> {
  try {
    const { jobPromise, modelWarning } = await startSubagentJob({
      task,
      persona,
      modelOverride,
      cwd,
      contextText,
      signal,
      onUpdate,
      defaultModel,
      parentModelRegistry,
    });
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
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Review this PR for security issues", persona: "You are a senior security auditor"',
      '  - task: "Continue debugging while we plan next steps", async: true, notifyOnComplete: "notify"',
      '  - task: "Summarize the key decisions made in this conversation", model: "anthropic/claude-sonnet-4-5"',
      "",
      "For async (background) execution, the main agent continues immediately.",
      "Use async only if user asked to do so or is willing to continue the conversation.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_with_context",
        toolCallId: _toolCallId,
        async: params.async ?? false,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        maxAge: params.maxAge ?? null,
      });

      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

      if (params.async === true) {
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

        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
        } = await startSubagentJob({
          task: params.task,
          persona: params.persona,
          modelOverride: params.model,
          cwd: targetCwd,
          contextText: conversationText,
          signal: undefined,
          onUpdate: undefined,
          defaultModel: ctx.model,
          maxAge: params.maxAge,
          parentModelRegistry: ctx.modelRegistry,
        });
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          promise: jobPromise,
          modelLabel,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : undefined,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        jobRegistry.set(jobId, jobState);
        updateRunningFooter(ctx);

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            updateRunningFooter(ctx);
          },
          (error) => {
            if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, {
                output: `Sub-agent crashed: ${error instanceof Error ? error.message : String(error)}`,
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
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: {
            jobId,
            status: "started",
            contextMessages: messages.length,
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
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: InProcessSubagentDetails = {
        status: result.isError ? "error" : "done",
        contextMessages: messages.length,
        usage: result.usage,
        model: result.model,
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
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Propose a README outline for this repo", persona: "You are a technical writer"',
      '  - task: "Give me a second opinion on this approach", model: "anthropic/claude-sonnet-4-5"',
      '  - task: "Analyze this code without context contamination", async: true, notifyOnComplete: "inject"',
      "",
      "For async (background) execution, the main agent continues immediately.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_isolated",
        toolCallId: _toolCallId,
        async: params.async ?? false,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        maxAge: params.maxAge ?? null,
      });

      if (params.async === true) {
        const targetCwd = params.cwd ?? ctx.cwd;
        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
        } = await startSubagentJob({
          task: params.task,
          persona: params.persona,
          modelOverride: params.model,
          cwd: targetCwd,
          contextText: null,
          signal: undefined,
          onUpdate: undefined,
          defaultModel: ctx.model,
          maxAge: params.maxAge,
          parentModelRegistry: ctx.modelRegistry,
        });
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          promise: jobPromise,
          modelLabel,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : undefined,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        jobRegistry.set(jobId, jobState);
        updateRunningFooter(ctx);

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            updateRunningFooter(ctx);
          },
          (error) => {
            if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, {
                output: `Sub-agent crashed: ${error instanceof Error ? error.message : String(error)}`,
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
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: {
            jobId,
            status: "started",
            contextMessages: 0,
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
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: InProcessSubagentDetails = {
        status: result.isError ? "error" : "done",
        contextMessages: 0,
        usage: result.usage,
        model: result.model,
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
    description:
      "Block until an async subagent job completes, then return the final output and usage summary.",
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

      job.resultRetrieved = true;
      const result = await job.promise;

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

      try {
        await job.session.abort();
      } catch {
        /* Session may already be disposed; abort is best-effort */
      }

      job.status = "cancelled";
      scheduleJobCleanup(params.jobId, true);
      updateRunningFooter(ctx);

      return {
        content: [{ type: "text", text: `Job ${params.jobId} cancelled.` }],
        details: { jobId: params.jobId, status: "cancelled" },
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
        | (InProcessSubagentDetails & { jobId?: string })
        | undefined;
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

      return {
        content: [
          {
            type: "text",
            text:
              `${summary}\n\n` +
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

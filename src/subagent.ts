/**
 * Sub-Engine Extension - Spawn in-process sub-agents via the SDK
 *
 * Tools:
 *   - subagent_with_context: Inherits full conversation history + task + persona
 *   - subagent_isolated: Fresh context window, task + optional persona only
 *   - get_subagent_status: Poll async subagent job for live preview
 *   - get_subagent_result: Block until async job completes, return final output
 *   - cancel_subagent: Abort a running async job
 *   - prune_subagent_jobs: Remove all completed and failed jobs from the registry
 *   - subagent_interactive: Spawn a separate tmux-backed Pi session users can attach to
 *   - get_interactive_subagent_status / cancel_interactive_subagent: Inspect or stop tmux-backed sessions
 *   - send_interactive_subagent_message: Send a follow-up prompt into a live interactive sub-agent's REPL
 *   - list_available_models: List all known models with auth status for model validation
 *
 * Both spawn tools support optional `async` param for background execution.
 * When async: true, the job starts and the main agent continues immediately -
 * it does NOT block waiting for the sub-agent. Use get_subagent_status to poll
 * for progress and get_subagent_result when ready to collect output.
 *
 * Runs in the same process — no subprocess overhead.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
  convertToLlm,
  serializeConversation,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  ACTIVE_TOOL_DEBOUNCE_MS,
  buildLiveUpdate,
  formatUsage,
  SubagentLiveStatus,
  SubagentResult,
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  debugLog,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
import {
  buildAttachCommandsForState,
  cancelInteractiveSubagent,
  cancelInteractiveSubagentByState,
  deriveInteractiveSubagentStatus,
  formatInteractiveState,
  interactiveSubagentRegistry,
  isPaneAlive,
  launchInteractiveSubagent,
  sendCommandToPane,
  pruneDeadInteractiveSubagents,
  tmuxSetupHint,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import {
  appendEvent,
  artifactPath,
  deleteInteractiveStatesFile,
  lastEvent,
  listOutputTurns,
  loadInteractiveStates,
  readEvents,
  readOutput,
  readOutputForTurn,
  removeInteractiveState,
  snapshotOutput,
  type SubagentArtifact,
  type SubagentEvent,
} from "./artifact";

import type { Usage } from "./helpers";
import { registerWorkflowTool } from "./workflow";

import { readdirSync, realpathSync, statSync } from "node:fs";

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { FOOTER_KEY, pollArtifactChanges } from "./artifact-poller";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  BaseParams,
  StatusParams,
  ResultParams,
  CancelParams,
  InteractiveParams,
} from "./schemas";

import { renderSubagentCall, renderSubagentResult } from "./rendering";

import { deliverNotification } from "./notifications";
export type SubagentDetails =
  | { status: "started"; jobId: string; contextMessages: number }
  | { status: "running"; subagentStatus: SubagentLiveStatus; model?: string }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found" }
  | { status: "invalid_id"; id: string };

// ── Helpers ──────────────────────────────────────────────────────────
// Shared helpers are imported from ./helpers (SubagentResult, SubagentLiveStatus,
// formatUsage, buildLiveUpdate, ACTIVE_TOOL_DEBOUNCE_MS, jobRegistry, MAX_REGISTRY_SIZE,
// pruneOldestJob, pruneCompletedJobs, scheduleJobCleanup, startSubagentJob, JobState)

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
    // Surface model resolution info so the AI sees what model was used
    if (modelWarning && !result.isError) {
      result.output = `${modelWarning}\n---\n${result.output}`;
    }
    return result;
  } catch (err) {
    // Preserve original error formatting: if startSubagentJob throws
    // (e.g., createAgentSession auth failure), return clean SubagentResult
    // instead of letting raw error propagate to Pi's agent loop.
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

/**
 * Find an artifact dir for an id that isn't in the current registry. We can't use the
 * registry (it's lost across process restarts) so we ask the file system. We scan the
 * default artifacts root (PI_CODING_AGENT_SESSION_DIR or ~/.pi/agent/sessions/subagentura).
 * For v1 this is a best-effort lookup; a future iteration can track all artifact roots.
 */
import isPathInside from "is-path-inside";

export function findArtifactById(id: string): SubagentArtifact | null {
  // Sub-agent ids are randomBytes(4).toString("hex") at spawn time, i.e. 8 hex
  // chars. Validate the id before joining it into a path so that an
  // LLM-supplied id like "../../../etc" can't escape the artifact root
  // (path.join normalises "..", so a malicious id would otherwise resolve
  // to a sibling directory and get exfiltrated to the parent LLM via
  // read_subagent_artifact).
  if (!/^[a-f0-9]{8}$/.test(id)) return null;

  const root =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    join(homedir(), ".pi", "agent", "sessions");
  // Resolve the root once, with symlinks followed, so the containment check below
  // is anchored on the real on-disk location. realpathSync throws if root doesn't
  // exist; in that case there's nothing for us to find.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  let topLevel: string[];
  try {
    topLevel = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of topLevel) {
    const candidate = join(root, entry, "artifacts", id);
    try {
      if (statSync(candidate).isDirectory()) {
        // statSync follows symlinks, so a symlink at
        // <root>/<cwd>/artifacts/<id> pointing outside the artifact root
        // would otherwise be returned as a valid artifact. Resolve the
        // candidate with realpath and verify it is still inside the
        // resolved root. realpathSync is safe here because statSync
        // above already confirmed candidate exists as a directory.
        let realCandidate: string;
        try {
          realCandidate = realpathSync(candidate);
        } catch {
          continue;
        }
        if (!isPathInside(realCandidate, realRoot)) continue;
        return artifactPath(join(root, entry, "artifacts"), id);
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Rehydrate orphan interactive sub-agents from the on-disk state file.
 *
 * Reads <cwd>/.pi/subagentura-state.json, reconstructs each
 * InteractiveSubagentState, sets its status via the existing
 * deriveInteractiveSubagentStatus matrix (lastEvent + isPaneAlive), registers
 * it, and resets runtime cursors so the existing poller backlog-catch-up path
 * replays any events that landed during downtime.
 *
 * Idempotent — skips ids already in the registry. Designed to be called from
 * the session_start handler. The first poll tick after this returns sees
 * the rehydrated states and replays any backlog.
 */
export function rehydrateInteractiveSubagents(
  cwd: string,
  currentSessionId?: string,
): {
  total: number;
  alive: number;
  terminal: number;
} {
  const payload = loadInteractiveStates(cwd);
  if (!payload) return { total: 0, alive: 0, terminal: 0 };
  let alive = 0;
  let terminal = 0;
  for (const entry of Object.values(payload.states) as Array<
    import("./artifact").InteractiveSubagentPersistedStateV1
  >) {
    if (currentSessionId && entry.parentSessionId !== currentSessionId) {
      continue;
    }
    if (interactiveSubagentRegistry.has(entry.id)) continue;
    // ── Recover display fields from on-disk files ──
    // Recovery is best-effort and must never throw; on missing files we
    // fall back to placeholder values (entry.id for name, 0 for startedAt).
    const art = artifactPath(
      dirname(entry.artifactDir),
      basename(entry.artifactDir),
    );

    let recoveredName: string;
    try {
      const files = readdirSync(entry.artifactDir);
      const promptFile = files.find((f) => f.endsWith("-prompt.md"));
      recoveredName = promptFile
        ? promptFile.slice(0, -"-prompt.md".length)
        : entry.id;
    } catch {
      recoveredName = entry.id;
    }

    let startedAt: number;
    try {
      const events = readEvents(art);
      startedAt = events.length > 0 ? events[0].ts : 0;
    } catch {
      startedAt = 0;
    }

    const attach = (() => {
      try {
        return buildAttachCommandsForState(entry);
      } catch {
        return { attachCommand: "", focusCommand: "" };
      }
    })();

    const rehydrated: InteractiveSubagentState = {
      id: entry.id,
      name: recoveredName,
      task: "",
      paneId: entry.paneId,
      windowName: entry.windowName,
      mux: entry.mux,
      muxSession: entry.muxSession,
      sessionFile: entry.sessionFile,
      cwd,
      startedAt,
      status: "running",
      attachCommand: attach.attachCommand,
      selectPaneCommand: attach.focusCommand,
      launchScriptFile: "",
      artifactDir: entry.artifactDir,
      notifyOnComplete: entry.notifyOnComplete,
      parentSessionId: entry.parentSessionId ?? "pi",
      // All runtime cursors reset (replay-all semantics).
      lastDeliveredEventTs: 0,
      lastDeliveredSessionByte: 0,
      lastInjectedEventTs: undefined,
      lastSnapshotEventTs: undefined,
      injected: undefined,
      autoDoneForTurnAt: undefined,
      lastStopReason: undefined,
      lastStopReasonAt: undefined,
      lastStopText: undefined,
    };
    const last = lastEvent(art);
    const paneAlive = isPaneAlive(rehydrated);
    const next = deriveInteractiveSubagentStatus(last, paneAlive);
    rehydrated.status = next;
    // Deliberately do NOT suppress re-injection here. The inject-mode path
    // fires on every NEW `done` event (line 682, `lastInjectedEventTs !== last.ts`).
    // On rehydrate, cursors are reset to 0 and lastInjectedEventTs starts as undefined,
    // so the first poll will re-inject the latest terminal event for inject-mode orphans.
    // This means exactly one extra inject per sub-agent on parent reload, which is
    // acceptable — it's better than silently dropping a result that completed during
    // the reload downtime (the pre-fix behavior).
    if (next === "exited" || next === "cancelled") terminal++;
    else if (next === "running" || next === "idle") alive++;
    interactiveSubagentRegistry.set(entry.id, rehydrated);
  }
  return { total: Object.keys(payload.states).length, alive, terminal };
}

export default function (pi: ExtensionAPI) {
  // Persist pi ref for async notification delivery (survives module reload)
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaInjectCount = 0;

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation; the last one wins,
  // which is the same pi the poller uses via __piSubagenturaPiRef.
  pi.on("session_start", (event, ctx) => {
    g2.__piSubagenturaUi = ctx.ui;
    // Rehydrate on startup (resumed session after quit), reload, and resume.
    // The session ID filter ensures only subagents created in this specific session
    // are rehydrated. On 'new' and 'fork' we skip — those are explicit fresh starts.
    const shouldRehydrate =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    if (shouldRehydrate) {
      try {
        rehydrateInteractiveSubagents(
          ctx.cwd,
          ctx.sessionManager?.getSessionId?.(),
        );
      } catch {
        /* best effort — rehydrate is a recovery path; failures fall back to empty registry */
      }
    }
  });

  pi.on("session_shutdown", () => {
    // Don't null the ui ref here — the poller may still fire one last tick on shutdown,
    // and stale ctx errors are already caught at the call sites.
  });

  // Register notification renderer before any tools
  // One global interval for the whole session. Each tick walks the artifact dir of
  // every running interactive sub-agent and fires pointer notifications for new events.
  // The poller survives parent restarts (artifacts on disk + per-state lastDeliveredEventTs).
  if (!g2.__piSubagenturaInteractivePollerHandle) {
    const handle = setInterval(() => pollArtifactChanges(pi), 5000);
    // Don't pin the event loop on a long-lived parent. unref() lets the process exit
    // cleanly when nothing else is keeping it alive (no other ref'd handles).
    handle.unref?.();
    g2.__piSubagenturaInteractivePollerHandle = handle;
  }
  // ── Tool: workflow — deterministic JS orchestration of isolated sub-agents ──
  registerWorkflowTool(pi);

  // ── Tool 1: inherits conversation history ────────────────────────
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

      // Gather conversation history
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

      // ── Async path ──
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
          signal: undefined, // async: don't inherit parent signal (would abort subagent when tool returns)
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

        // Update footer
        const runningCount = [...jobRegistry.values()].filter(
          (j) => j.status === "running",
        ).length;
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            // Deliver notification if requested
            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            const remaining = [...jobRegistry.values()].filter(
              (j) => j.status === "running",
            ).length;
            if (remaining > 0) {
              try {
                ctx.ui.setStatus(
                  FOOTER_KEY,
                  `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
                );
              } catch {
                /* ctx stale */
              }
            } else {
              try {
                ctx.ui.setStatus(FOOTER_KEY, undefined);
              } catch {
                /* ctx stale */
              }
            }
          },
          (error) => {
            // Promise rejection handler — deliver failure notification
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

      // ── Sync path ──
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
      const details: SubagentDetails = {
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

  // ── Tool 2: isolated, no conversation history ────────────────────
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

      // ── Async path ──
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
          contextText: null, // isolated — no context
          signal: undefined, // async: don't inherit parent signal (would abort subagent when tool returns)
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

        // Register job FIRST, then wire completion handler with cancellation guard.
        // Note: jobPromise never rejects (internal catch handles all errors).
        jobRegistry.set(jobId, jobState);

        // Update footer to show running subagents
        const runningCount = [...jobRegistry.values()].filter(
          (j) => j.status === "running",
        ).length;
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            // Deliver notification if requested
            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            // Update or clear footer status
            const remaining = [...jobRegistry.values()].filter(
              (j) => j.status === "running",
            ).length;
            if (remaining > 0) {
              try {
                ctx.ui.setStatus(
                  FOOTER_KEY,
                  `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
                );
              } catch {
                /* ctx stale */
              }
            } else {
              try {
                ctx.ui.setStatus(FOOTER_KEY, undefined);
              } catch {
                /* ctx stale */
              }
            }
          },
          (error) => {
            // Promise rejection handler — deliver failure notification
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
          details: { jobId, status: "started" },
        };
      }

      // ── Sync path ──
      const targetCwd = params.cwd ?? ctx.cwd;

      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        null, // no context
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: SubagentDetails = {
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
      return renderSubagentCall(args, theme, "subagent_isolated");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 3: poll async job status ────────────────────────────────
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

      // Job is running — return live preview
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
      const details = result.details as SubagentDetails | undefined;
      if (details?.status === "running") {
        // Force isPartial to get the live preview rendering
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

  // ── Tool 4: block until async job completes ──────────────────────
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

      // Await the job promise. If already settled, resolves immediately.
      // If still running, blocks until completion.
      // Set resultRetrieved BEFORE await to suppress redundant notification
      // (microtask ordering ensures .then() checks this before delivering)
      job.resultRetrieved = true;
      const result = await job.promise;

      // Re-check status: if cancelled during await, return cancelled message
      // rather than the AbortError from the promise chain.
      // TypeScript narrows job.status after the earlier check, but cancellation
      // can happen during the await, so we cast back to the full union.
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
      const details: SubagentDetails = {
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

  // ── Tool 5: cancel a running async job ───────────────────────────
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

      // Abort the session
      try {
        await job.session.abort();
      } catch {
        // Session may already be disposed; abort is best-effort
      }

      // Mark cancelled and remove immediately
      job.status = "cancelled";
      scheduleJobCleanup(params.jobId, true); // immediate removal

      // Update footer status
      const remaining = [...jobRegistry.values()].filter(
        (j) => j.status === "running",
      ).length;
      if (remaining > 0) {
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }
      } else {
        try {
          ctx.ui.setStatus(FOOTER_KEY, undefined);
        } catch {
          /* ctx stale */
        }
      }

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
        | (SubagentDetails & { jobId?: string })
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

  // ── Tool 6: spawn an attachable mux-backed Pi session ──────────────
  pi.registerTool({
    name: "subagent_interactive",
    label: "Interactive Subagent",
    description: [
      "Spawn a separate Pi process in a tmux/zellij pane and return immediately.",
      "Use this when the user wants to attach to the sub-agent session and continue follow-ups there.",
      "Works inside tmux or zellij. The tool returns attach/focus commands and the child session file.",
      "This is intentionally separate from SDK subagents: it favors observability and attachability over in-process execution.",
    ].join("\n"),
    parameters: InteractiveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_interactive",
        toolCallId: _toolCallId,
        taskLength: params.task?.length ?? 0,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        includeContext: params.includeContext ?? false,
      });

      let contextText: string | null = null;
      if (params.includeContext === true) {
        const branch = ctx.sessionManager.getBranch();
        const messages = branch
          .filter(
            (e): e is typeof e & { type: "message" } => e.type === "message",
          )
          .map((e) => e.message);
        contextText = serializeConversation(convertToLlm(messages));
      }

      const taskPreview = params.task.replace(/\s+/g, " ").slice(0, 48);
      const name = params.name ?? `Subagent: ${taskPreview || "interactive"}`;
      const targetCwd = params.cwd ?? ctx.cwd;

      try {
        const state = launchInteractiveSubagent({
          name,
          task: params.task,
          persona: params.persona,
          model: params.model,
          cwd: targetCwd,
          contextText,
          background: params.background, // defaults to true (hidden) inside the helper
          notifyOnComplete: params.notifyOnComplete ?? "inject",
          muxPreference: params.mux, // pass through user's mux preference
          parentCwd: ctx.cwd,
          parentSessionId: ctx.sessionManager.getSessionId(),
        });

        const displayMode = state.windowName
          ? "background (new window/tab)"
          : "visible split";
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${state.id} started (${displayMode}) in ${state.mux} pane ${state.paneId}.\n\nArtifact: ${state.artifactDir}\nAttach: ${state.attachCommand}\nFocus: ${state.selectPaneCommand}\nSession: ${state.sessionFile}`,
            },
          ],
          details: { ...state, status: "started" },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to start interactive sub-agent: ${msg}\n${tmuxSetupHint()}`,
            },
          ],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const task = String(args.task ?? "");
      const preview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent_interactive ")) +
          theme.fg("accent", String(args.name ?? preview)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | Partial<InteractiveSubagentState>
        | undefined;
      if ((result as any).isError) {
        const first = result.content?.[0];
        const text =
          first?.type === "text"
            ? first.text
            : "Failed to start interactive sub-agent";
        return new Text(theme.fg("error", text), 0, 0);
      }
      const id = details?.id ?? "unknown";
      const paneId = details?.paneId ?? "unknown";
      return new Text(
        theme.fg("accent", "⚡ ") +
          theme.fg("toolTitle", `Interactive sub-agent ${id}`) +
          theme.fg("dim", ` — pane ${paneId}`),
        0,
        0,
      );
    },
  });

  // ── Tool 7: inspect attachable tmux-backed sessions ────────────────
  pi.registerTool({
    name: "get_interactive_subagent_status",
    label: "Get Interactive Subagent Status",
    description:
      "Inspect tmux-backed interactive subagents. Omit jobId to list all tracked sessions. Returns attach/select commands and session paths without capturing pane output.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({
          description:
            "Interactive sub-agent ID returned by subagent_interactive",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<any> {
      pruneDeadInteractiveSubagents();
      const states = params.jobId
        ? [interactiveSubagentRegistry.get(params.jobId)].filter(
            (s): s is InteractiveSubagentState => Boolean(s),
          )
        : [...interactiveSubagentRegistry.values()];

      if (states.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.jobId
                ? `Interactive sub-agent ${params.jobId} not found.`
                : "No interactive sub-agents are tracked.",
            },
          ],
          details: { status: "not_found", jobId: params.jobId },
          isError: Boolean(params.jobId),
        };
      }

      const sections = states.map((state) => {
        return formatInteractiveState(state);
      });

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: {
          count: states.length,
          subagents: states.map((state) => ({ ...state })),
        },
      };
    },
  });

  // ── Tool 8: cancel an attachable tmux-backed session ───────────────
  pi.registerTool({
    name: "cancel_interactive_subagent",
    label: "Cancel Interactive Subagent",
    description: "Kill the tmux pane for an interactive sub-agent by ID.",
    parameters: Type.Object({
      jobId: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
    }),

    async execute(_toolCallId, params): Promise<any> {
      const state = cancelInteractiveSubagent(params.jobId);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.jobId} not found.`,
            },
          ],
          details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Interactive sub-agent ${params.jobId} cancelled.`,
          },
        ],
        details: { ...state },
      };
    },
  });

  // ── Tool: send a follow-up message to a live interactive sub-agent ──────
  // The child REPL stays open after `done` (see buildChildSubagentProtocol in
  // interactive-tmux.ts), so the parent can push a new prompt into the same
  // session via tmux send-keys. Model context is preserved across messages —
  // this is a true follow-up turn, not a fresh spawn.
  //
  // Caps: the message must be non-empty (an empty Enter in the REPL would submit a
  // blank prompt) and at most MAX_FOLLOWUP_BYTES UTF-8 bytes (symmetric with
  // MAX_PERSONA_BYTES in interactive-tmux.ts — 64 KiB is well above any realistic
  // follow-up prompt; larger values are rejected up-front with a structured error).
  const MAX_FOLLOWUP_BYTES = 64 * 1024;
  pi.registerTool({
    name: "send_interactive_subagent_message",
    label: "Send Interactive Subagent Message",
    description: [
      "Send a follow-up prompt to a live interactive sub-agent. The message is delivered into the",
      "child's existing REPL via tmux send-keys, so the child's model context is preserved — this",
      "is a true follow-up turn, not a fresh spawn. The child will run the new turn and (per its",
      "system prompt) call '$ARTIFACT_DIR/cli.mjs done 0' again when it finishes. Use",
      "get_interactive_subagent_status to check the pane state first if you're not sure it's still alive.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
      message: Type.String({
        description:
          "The follow-up prompt text to send into the child's REPL (must be non-empty; max 64 KiB)",
      }),
    }),

    async execute(_toolCallId, params): Promise<any> {
      // Validate the id shape first for a precise error.
      if (!/^[a-f0-9]{8}$/.test(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 8 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      // Content validation (no registry I/O): fail fast on empty / oversized messages.
      // An empty message would submit a blank Enter in the child REPL; an oversized message
      // is more than the child can usefully consume and risks blowing the REPL history.
      if (params.message.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Message is empty; send a non-empty follow-up prompt.",
            },
          ],
          details: { id: params.id, status: "empty_message", messageLength: 0 },
          isError: true,
        };
      }
      const messageBytes = Buffer.byteLength(params.message, "utf8");
      if (messageBytes > MAX_FOLLOWUP_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `Message too large: ${messageBytes} bytes (max ${MAX_FOLLOWUP_BYTES}). Shorten the prompt and try again.`,
            },
          ],
          details: {
            id: params.id,
            status: "message_too_large",
            messageLength: messageBytes,
            maxBytes: MAX_FOLLOWUP_BYTES,
          },
          isError: true,
        };
      }
      const state = interactiveSubagentRegistry.get(params.id);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} not found.`,
            },
          ],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      // Accept both "running" (mid-turn) and "idle" (REPL open, between turns) — that's the whole
      // point of follow-up support. Mid-turn sends are safe: tmux send-keys just queues keystrokes
      // in the REPL input buffer, which submits when the current turn finishes.
      if (state.status !== "running" && state.status !== "idle") {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} is ${state.status}; follow-up messages can only be sent to running or idle sub-agents. Spawn a new one if needed.`,
            },
          ],
          details: { id: params.id, status: state.status },
          isError: true,
        };
      }
      // sendCommandToPane uses send-keys + Enter; it throws synchronously if the
      // pane is gone (e.g. the child exited between the status check and now).
      // Wrap so the parent gets a structured error instead of an exception trace.
      try {
        sendCommandToPane(state, params.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message to interactive sub-agent ${params.id}: ${msg}`,
            },
          ],
          details: {
            id: params.id,
            status: "send_failed",
            paneId: state.paneId,
            error: msg,
          },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent follow-up to interactive sub-agent ${params.id} (${params.message.length} chars) in pane ${state.paneId}.`,
          },
        ],
        details: {
          id: params.id,
          paneId: state.paneId,
          messageLength: params.message.length,
          status: "sent",
        },
      };
    },
  });

  // ── Tool: read an interactive sub-agent's artifact ───────────────
  // The artifact (events.ndjson + output.md) is the source of truth for what the
  // sub-agent did. The main agent calls this when it wants to know more than the pointer.
  // The artifact (events.ndjson + output.md + output-N.md snapshots) is the source of truth for what
  // the sub-agent did. The main agent calls this when it wants to know more than the pointer.
  pi.registerTool({
    name: "read_subagent_artifact",
    label: "Read Subagent Artifact",
    description: [
      "Read an interactive sub-agent's artifact on disk. Returns the lifecycle events and,",
      "if present, the sub-agent's output.md (the latest turn's content) or a specific turn's snapshot.",
      "Use `since` (unix ms) to fetch only events newer than your last read. Use `turn` to read a",
      "specific historical turn's output-N.md instead of the latest output.md.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
      since: Type.Optional(
        Type.Number({
          description: "Only return events with ts >= this unix-ms timestamp",
        }),
      ),
      includeOutput: Type.Optional(
        Type.Boolean({
          description:
            "Include the output (default true). Set false to fetch only events.",
        }),
      ),
      turn: Type.Optional(
        Type.Number({
          description:
            "Read a specific turn's output-N.md snapshot. Omit to read the latest output.md.",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<any> {
      // Validate the id shape FIRST so a malformed id gets a precise error
      // instead of being collapsed into the generic "not found" message.
      if (!/^[a-f0-9]{8}$/.test(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 8 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      const state = interactiveSubagentRegistry.get(params.id);
      const art = state
        ? artifactPath(dirname(state.artifactDir), basename(state.artifactDir))
        : findArtifactById(params.id);
      if (!art) {
        return {
          content: [
            {
              type: "text",
              text: `No artifact found for sub-agent ${params.id}.`,
            },
          ],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      const events = readEvents(art, params.since);
      // `turn` reads a specific output-N.md snapshot; otherwise read the latest output.md. The turn
      // param implies includeOutput (you can't read a turn without wanting its content).
      const wantsOutput =
        params.includeOutput !== false || params.turn !== undefined;
      const output = wantsOutput
        ? params.turn !== undefined
          ? readOutputForTurn(art, params.turn)
          : readOutput(art)
        : null;
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      // Distinguish three cases when output is missing/empty so the caller
      // doesn't see a misleading "not written yet" after the sub-agent has
      // already exited (the common case: model finished without writing).
      let outputText: string;
      if (output === null) {
        if (params.turn !== undefined) {
          outputText = `(no snapshot for turn ${params.turn} — the poller may not have run yet, or this turn number is past the history)`;
        } else {
          const exited =
            lastEvent &&
            (lastEvent.type === "done" ||
              lastEvent.type === "error" ||
              lastEvent.type === "cancelled");
          outputText = exited
            ? `(sub-agent exited without writing output.md — last event: ${lastEvent.type} @ ${lastEvent.ts})`
            : `(${events.length} events, last: ${lastEvent ? `${lastEvent.type} @ ${lastEvent.ts}` : "(none)"} — output.md not written yet)`;
        }
      } else if (output.length === 0) {
        outputText = "(empty — 0 chars)";
      } else {
        outputText = `${output.length} chars`;
      }
      // Available turns summary so the caller knows what history exists.
      const availableTurns = listOutputTurns(art);
      const turnsLine =
        availableTurns.length > 0
          ? `Available turns: [${availableTurns.join(", ")}]\n`
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Artifact for ${params.id} (${events.length} event${events.length === 1 ? "" : "s"}${params.since ? ` since ${params.since}` : ""}).\n` +
              `Last event: ${lastEvent ? `${lastEvent.type} @ ${lastEvent.ts}` : "(none)"}\n` +
              (params.turn !== undefined
                ? `Reading turn: ${params.turn}\n`
                : "") +
              turnsLine +
              `Output: ${outputText}`,
          },
        ],
        details: {
          id: params.id,
          artifactDir: art.dir,
          events,
          output,
          lastEvent,
          availableTurns,
        },
      };
    },
  });

  // ── Tool: list known interactive sub-agent artifacts ─────────────
  pi.registerTool({
    name: "list_subagent_artifacts",
    label: "List Subagent Artifacts",
    description: [
      "List all known interactive sub-agents (in this session and from past sessions whose",
      "artifacts are still on disk). Returns id, name, status, and last-update time. Use",
      "read_subagent_artifact to fetch a specific one.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute(): Promise<any> {
      pruneDeadInteractiveSubagents();
      const states = [...interactiveSubagentRegistry.values()];
      const summary = states.map((s) => {
        const art = artifactPath(
          dirname(s.artifactDir),
          basename(s.artifactDir),
        );
        const last = lastEvent(art);
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          lastEvent: last,
          lastUpdate: last?.ts,
          artifactDir: s.artifactDir,
        };
      });
      if (summary.length === 0) {
        return {
          content: [
            { type: "text", text: "No interactive sub-agents are tracked." },
          ],
          details: { count: 0, subagents: [] },
        };
      }
      const lines = summary.map((s) => {
        const ev = s.lastEvent;
        const evStr = ev
          ? `last: ${ev.type}${ev.message ? ` (${ev.message.slice(0, 60)})` : ""}`
          : "no events yet";
        return `${s.id}  ${s.name}  ${s.status}  ${evStr}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: summary.length, subagents: summary },
      };
    },
  });

  // ── Tool 6: list available models ────────────────────────────────
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

  // ── Tool 7: prune completed jobs ─────────────────────────────────
  // ── Tool 6: prune completed jobs ─────────────────────────────────
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

  // ── Session shutdown: abort all jobs, kill tmux panes, stop the poller ─
  (pi as any).on?.(
    "session_shutdown",
    (
      event: { reason?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      const g2 = typeof global !== "undefined" ? global : globalThis;

      // Stop the global poller so it doesn't fire after we're gone. Without
      // clearInterval the handle would keep the event loop alive across restarts.
      if (g2.__piSubagenturaInteractivePollerHandle) {
        try {
          clearInterval(g2.__piSubagenturaInteractivePollerHandle);
        } catch {
          /* defensive */
        }
        g2.__piSubagenturaInteractivePollerHandle = undefined;
      }
      // Snapshot running state objects BEFORE clearing. On /new and quit we
      // kill their panes after the registry is empty. On reload/resume we
      // intentionally preserve panes so the next session_start can rehydrate
      // them from the state file.
      const runningStates: InteractiveSubagentState[] = [];
      for (const state of interactiveSubagentRegistry.values()) {
        if (state.status === "running") runningStates.push(state);
      }

      // Drop in-memory state FIRST. An in-flight poll tick (dequeued from
      // setInterval before clearInterval ran) finds an empty registry and its
      // for-loop iterates over zero entries — no work, no notification delivery.
      try {
        interactiveSubagentRegistry.clear();
      } catch {
        /* best effort */
      }

      const preserveInteractivePanes =
        event?.reason === "reload" ||
        event?.reason === "resume" ||
        event?.reason === "quit";
      if (!preserveInteractivePanes) {
        // Kill the panes using the already-snapshotted states.
        // cancelInteractiveSubagentByState is used (not the id-based variant)
        // because the registry was already cleared above.
        for (const state of runningStates) {
          try {
            cancelInteractiveSubagentByState(state);
          } catch {
            /* best effort */
          }
        }
      }
      // Abort all running subagent sessions before clearing
      for (const job of jobRegistry.values()) {
        if (job.status === "running") {
          try {
            job.session.abort().catch(() => {});
          } catch {
            /* session may already be disposed */
          }
        }
      }
      jobRegistry.clear();
      g2.__piSubagenturaPiRef = undefined;
      g2.__piSubagenturaInjectCount = 0;
      // Clean-slate the state file on /new. On quit/reload/resume we KEEP the file so the
      // next session_start can rehydrate the sub-agents (their panes survive).
      if (event?.reason === "new" && ctx?.cwd) {
        try {
          deleteInteractiveStatesFile(ctx.cwd);
        } catch {
          /* best effort */
        }
      }
    },
  );
}

// ── Re-exports ───────────────────────────────────────────────────────
// Re-export helpers so external consumers (e.g. tests importing from subagent.ts)
// don't need to know about the internal helpers.ts split.
export {
  formatUsage,
  SubagentResult,
  SubagentLiveStatus,
  ACTIVE_TOOL_DEBOUNCE_MS,
  // ── Async exports ──
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
export { interactiveSubagentRegistry } from "./interactive-tmux";
export { getInjectCount, MAX_INJECT } from "./notifications";
export { pollArtifactChanges } from "./artifact-poller";

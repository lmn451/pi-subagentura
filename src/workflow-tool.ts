import { Type } from "typebox";
import { abortableWait } from "./abortable-wait";
import {
  debugLog,
  MAX_REGISTRY_SIZE,
  registerInProcessJob,
  removeInProcessJob,
  startSubagentJob,
  type JobState,
} from "./helpers";
import {
  disposeWorkflowInteractiveSubagent,
  launchInteractiveSubagent,
  registerInteractiveSubagentState,
} from "./interactive-tmux";
import {
  MAX_ITEMS_PER_CALL,
  INTERACTIVE_POLL_MS,
  MAX_TOTAL_AGENTS,
  listSavedWorkflows,
  loadWorkflowScript,
  parseWorkflow,
  saveWorkflowScript,
  deleteWorkflowScript,
  type WorkflowAgentRunner,
  WorkflowExecutionError,
  type WorkflowMeta,
  type WorkflowProgress,
  type WorkflowRunResult,
  type WorkflowUsage,
  formatWorkflowUsage,
  presentWorkflowUsage,
  workflowUsageFromUsage,
} from "./workflow-core";
import {
  discardWorkflowJob,
  getWorkflowCompletionPresentation,
  getWorkflowJobForOwner,
  invokeWorkflowCompletionHook,
  normalizeCancelledWorkflowState,
  startWorkflowJob,
  workflowJobsForOwner,
  type WorkflowJobState,
} from "./workflow-jobs";
import { renderProgress } from "./workflow-ui";
import { awaitInteractiveResult, stringify } from "./workflow-worker";
import { sanitizeOutput } from "./notifications";
import {
  completionDisplayLabel,
  formatCompletionMessage,
} from "./completion-presentation";
import { showWorkflowTree } from "./workflow-tree-ui";
import {
  WorkflowPickerComponent,
  type WorkflowPickerAction,
  type WorkflowPickerChoice,
} from "./workflow-picker-ui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { cancellationSnapshotsEnabled } from "./cancellation-snapshots";
import { getOrchestrationContext } from "./orchestration-context";
import {
  getActiveSessionOwner,
  isSessionOwnerLive,
  resolveActualStreamingFlag,
  resolveLiveSessionScope,
  sessionOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import { isOrchestratorV2Enabled, sendCompletionTurn } from "./completion-turn";
import { attachAsyncJobSettlement } from "./tools/in-process";
import { registerToolWithDefaultGuidance } from "./tool-guidance";
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
} from "./completion-coordinator";

const WORKFLOW_SESSION_SCOPE_MESSAGE =
  "Workflow jobs are scoped to the current parent session and do not survive reload/resume/new/quit.";
export const WORKFLOW_CHILD_REUSE_TTL_MS = 30 * 60 * 1000;
export const MAX_REUSABLE_WORKFLOW_CHILDREN = 32;

function workflowNotFoundMessage(workflowId: string): string {
  return (
    `Workflow ${workflowId} not found in the current parent session. ` +
    "It may have been created in another session or removed by reload/resume/new/quit."
  );
}

const CANCELLATION_RECEIPT_GRACE_MS = INTERACTIVE_POLL_MS + 250;

/** Tear down a prepared workflow child that must never be started. */
function discardWorkflowChildSpawn(
  abort: AbortController,
  prepared: {
    session: { abort: () => Promise<unknown> };
    disposeBeforeStart?: () => void;
  },
): void {
  prepared.disposeBeforeStart?.();
  try {
    abort.abort({
      source: "session_shutdown" as const,
      reason: "parent session shut down before workflow child registration",
    });
  } catch {
    /* controller may already be aborted */
  }
  try {
    void Promise.resolve(prepared.session.abort()).catch(() => {
      /* child session may already be disposed */
    });
  } catch {
    /* child session may already be disposed */
  }
}

async function waitForCancellationReceipts(
  state: WorkflowJobState,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pendingRuns = [...(state.activeAgentRuns ?? [])];
  if (pendingRuns.length === 0) return;

  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCELLATION_RECEIPT_GRACE_MS);
  });
  try {
    await Promise.race([Promise.all(pendingRuns).then(() => undefined), grace]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workflowErrorUsage(error: unknown): WorkflowUsage | undefined {
  return error instanceof WorkflowExecutionError
    ? presentWorkflowUsage(error.usage)
    : undefined;
}

export function formatWorkflowNotificationSummary(
  job: WorkflowJobState,
): string {
  const run = job.result;
  if (run) {
    const usage = presentWorkflowUsage(run.usage);
    const usageSummary = usage
      ? `, ${formatWorkflowUsage(usage, {
          outputBudget: job.snapshot.budgetTotal,
        })}`
      : "";
    return `${run.agentsSpawned} agent(s), ${run.errorCount} error(s)${usageSummary}.`;
  }
  const usage = presentWorkflowUsage(job.snapshot.usage);
  return `${job.error ?? "Workflow did not produce a result."}${
    usage
      ? ` (${formatWorkflowUsage(usage, {
          outputBudget: job.snapshot.budgetTotal,
        })})`
      : ""
  }`;
}

export function registerWorkflowTool(
  pi: ExtensionAPI,
  sessionScope?: SessionScope,
): void {
  debugLog("info", "workflow_registered", {});
  const owner = (): SessionOwnerToken | undefined =>
    sessionScope
      ? { id: sessionScope.id, generation: sessionScope.generation }
      : getActiveSessionOwner();
  // Build the real spawn function from the tool ctx. Switches backend on `isolation`.
  function makeRunAgent(
    ctx: any,
    ownedWorkflowId: string,
    workflowName: string,
    supervisorOwner: SessionOwnerToken | undefined,
  ): WorkflowAgentRunner {
    return async ({
      prompt,
      persona,
      model,
      signal,
      isolation,
      label,
      schema,
      thinkingLevel,
      reusable,
      onProgress,
      onCancellationSnapshot,
    }) => {
      if (supervisorOwner && !isSessionOwnerLive(supervisorOwner)) {
        throw new Error(
          "Workflow agent cancelled: its parent session is no longer live.",
        );
      }

      let lastUpdateTs = 0;
      const THROTTLE_MS = 2000;

      const maybeEmitUpdate = (msg: string, liveUsage?: WorkflowUsage) => {
        const now = Date.now();
        if (now - lastUpdateTs >= THROTTLE_MS) {
          lastUpdateTs = now;
          onProgress?.({ kind: "log", message: msg, label, liveUsage });
        }
      };

      const tryProcess = isolation !== "in-process";
      const childScope = resolveLiveSessionScope(supervisorOwner);
      const reusableChildCount = childScope
        ? [...childScope.interactiveStates.values()].filter(
            (state) =>
              state.workflowReusable === true &&
              state.completionOwner === "workflow",
          ).length
        : 0;
      if (reusable && !tryProcess) {
        throw new Error(
          "Reusable workflow children require process isolation.",
        );
      }
      if (reusable && !childScope) {
        throw new Error(
          "Reusable workflow children require a live parent session owner.",
        );
      }
      if (reusable && reusableChildCount >= MAX_REUSABLE_WORKFLOW_CHILDREN) {
        throw new Error(
          `At most ${MAX_REUSABLE_WORKFLOW_CHILDREN} reusable workflow children may be retained per parent session. Promote or dispose an existing child first.`,
        );
      }
      if (tryProcess) {
        let state: ReturnType<typeof launchInteractiveSubagent> | undefined;
        try {
          state = launchInteractiveSubagent({
            name: (label || "wf-agent").slice(0, 40),
            task: prompt,
            persona,
            model,
            cwd: ctx.cwd,
            contextText: null,
            background: true,
            thinkingLevel,
            supervisorOwner,
            sessionScope: childScope,
            spawnTreeContext: childScope?.spawnTreeContext,
            workflowId: ownedWorkflowId,
            workflowName,
            workflowReusable: reusable === true,
            completionOwner: "workflow",
            completionPolicy: "each",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (reusable) {
            throw new Error(`Reusable workflow child could not launch: ${msg}`);
          }
          debugLog("warn", "isolation_process_fallback", { reason: msg });
          onProgress?.({
            kind: "log",
            message: `⚠ isolation:process unavailable — ${msg}. Falling back to in-process.`,
            label,
          });
        }
        if (state) {
          // launchInteractiveSubagent performs this registration itself. Repeating
          // the idempotent synchronization here keeps alternate launch adapters and
          // test doubles on the same production contract: the owner scope is the
          // authoritative index, while the process-global registry is compatibility.
          registerInteractiveSubagentState(state, childScope);
          const result = await awaitInteractiveResult(
            state,
            signal,
            undefined,
            onCancellationSnapshot,
          );
          state.workflowResultConsumed = true;
          if (reusable && !result.isError && !result.cancelled) {
            state.workflowReuseExpiresAt =
              Date.now() + WORKFLOW_CHILD_REUSE_TTL_MS;
          } else {
            disposeWorkflowInteractiveSubagent(state);
          }
          return result;
        }
      }

      // A child whose deliveryOwner carries no session-scope identity matches
      // no owner-scoped sweep: it is invisible in the supervisor and the footer,
      // and session shutdown skips it outright. Prefer the live owner, and leave
      // the child unregistered rather than create an unreachable registry row.
      const childOwner = supervisorOwner ?? getActiveSessionOwner();

      // Own the child session so its parent abort cascades to it and exact-scope
      // shutdown can drain it from the authoritative job map.
      const abort = new AbortController();
      const forwardAbort = () => abort.abort(signal?.reason);
      if (signal?.aborted) abort.abort(signal.reason);
      else signal?.addEventListener("abort", forwardAbort, { once: true });
      const prepared = await startSubagentJob({
        task: prompt,
        persona,
        modelOverride: model,
        cwd: ctx.cwd,
        contextText: null,
        signal: abort.signal,
        onUpdate: (partial) => {
          const liveUsage = workflowUsageFromUsage(
            partial.details?.subagentStatus?.usage,
          );
          const status = partial.details?.subagentStatus;
          if (status?.activeTool) {
            maybeEmitUpdate(`⚙ ${status.activeTool.name}`, liveUsage);
          } else if (status?.output) {
            const preview = (status.output || "")
              .slice(0, 60)
              .replace(/\s+/g, " ")
              .trim();
            if (preview) maybeEmitUpdate(`💭 ${preview}`, liveUsage);
          } else if (liveUsage) maybeEmitUpdate("↻ usage", liveUsage);
        },
        defaultModel: ctx.model,
        parentModelRegistry: ctx.modelRegistry,
        onCancellationSnapshot,
        cancellationSource: "workflow",
        thinkingLevel,
        owner: childOwner,
        ...(isolation === "in-process" && schema !== undefined
          ? { workflowStructuredOutputSchema: schema }
          : {}),
      });
      // The parent session can shut down while startSubagentJob is awaited above.
      // session_shutdown drains jobRegistry, so registering now would re-insert
      // into an already-drained registry and start a model turn that no abort path
      // can reach (the PR #59 shutdown-escape hole).
      if (childOwner && !isSessionOwnerLive(childOwner)) {
        signal?.removeEventListener("abort", forwardAbort);
        discardWorkflowChildSpawn(abort, prepared);
        throw new Error(
          "Workflow agent cancelled: parent session shut down before the child was registered.",
        );
      }

      const childJob: JobState = {
        id: prepared.jobId,
        status: "running",
        liveStatus: prepared.liveStatus,
        session: prepared.session,
        startedAt: Date.now(),
        cwd: ctx.cwd,
        promise: prepared.jobPromise,
        modelLabel: prepared.modelLabel,
        thinkingLevel: prepared.thinkingLevel,
        abort,
        workflowId: ownedWorkflowId,
        completionOwner: "workflow",
        deliveryOwner: {
          pi,
          sessionScopeId: childOwner?.id,
          sessionScopeGeneration: childOwner?.generation,
        },
      };
      if (childOwner) {
        if (!registerInProcessJob(childJob, childOwner)) {
          signal?.removeEventListener("abort", forwardAbort);
          discardWorkflowChildSpawn(abort, prepared);
          throw new Error(
            `Workflow agent could not start: ${MAX_REGISTRY_SIZE} in-process sub-agent jobs are retained or running.`,
          );
        }
        // Without settlement the row would stay "running" forever: cancellable in
        // the supervisor after it finished, double-counted against its own
        // workflow in the footer, and given a false cancellation record on quit.
        attachAsyncJobSettlement(childJob.id, childJob);
      } else {
        debugLog("warn", "workflow_child_unregistered", {
          jobId: childJob.id,
          workflowId: ownedWorkflowId,
          reason: "no live session scope to own the child",
        });
      }
      prepared.start?.();
      try {
        return await prepared.jobPromise;
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
        if (childOwner) removeInProcessJob(childJob.id, childOwner);
      }
    };
  }

  const MAX_WORKFLOW_NOTIFICATION_CHARS = 20_000;
  const WORKFLOW_TRUNCATION_MARKER = "\n\n[Content truncated.]";

  function truncateWorkflowNotification(text: string): string {
    if (text.length <= MAX_WORKFLOW_NOTIFICATION_CHARS) return text;
    const end =
      MAX_WORKFLOW_NOTIFICATION_CHARS - WORKFLOW_TRUNCATION_MARKER.length;
    return text.slice(0, Math.max(0, end)) + WORKFLOW_TRUNCATION_MARKER;
  }

  function configureWorkflowCompletion(
    job: WorkflowJobState,
    completion: ResolvedCompletionPolicy,
    workflowOwner: SessionOwnerToken | undefined,
    reservation?: CompletionGroupReservation,
  ): void {
    job.completionPolicy = completion.policy;
    job.completionGroupId = completion.groupId;
    if (completion.policy) {
      registerCompletionMember(
        "workflow",
        job.id,
        completion.policy,
        completion.groupId,
        workflowOwner,
        reservation,
      );
    }
  }

  function workflowCompletionLabel(job: WorkflowJobState): string {
    return completionDisplayLabel(job.name, "workflow");
  }

  function notifyWorkflowCompletion(job: WorkflowJobState): boolean {
    const run = job.result;
    const errorCount = run?.errorCount ?? job.snapshot.errorCount;
    const presentation = getWorkflowCompletionPresentation(
      job.status,
      errorCount,
    );
    if (job.completionPolicy) {
      publishCompletion(
        {
          schemaVersion: 1,
          completionId: `workflow:${job.id}`,
          source: "workflow",
          sourceId: job.id,
          label: workflowCompletionLabel(job),
          status:
            job.status === "cancelled"
              ? "cancelled"
              : job.status === "error" ||
                  presentation.label === "completed with errors"
                ? "error"
                : "done",
          policy: job.completionPolicy,
          ...(job.completionGroupId ? { groupId: job.completionGroupId } : {}),
          references:
            job.status === "cancelled"
              ? [{ label: "status", value: "cancelled; no result retained" }]
              : [
                  {
                    label: "result",
                    value: `call get_workflow_result with workflowId ${JSON.stringify(job.id)}`,
                  },
                ],
          completedAt: Date.now(),
        },
        job.parentSessionOwner,
      );
      return true;
    }
    const icon = presentation.icon || (job.status === "done" ? "✅" : "❌");
    const rawSummary = formatWorkflowNotificationSummary(job);
    const summary = truncateWorkflowNotification(sanitizeOutput(rawSummary));
    let content = formatCompletionMessage(
      completionDisplayLabel(job.name, "workflow"),
      `${icon} ${presentation.label} — ${summary}`,
      "workflow",
    );
    if (run) {
      content += isOrchestratorV2Enabled(pi)
        ? "\n\nThis completion came from the separate workflow compatibility mode. Surface its status without calling workflow tools in Orchestratorv2 mode."
        : `\n\nCall get_workflow_result with workflowId "${job.id}" to retrieve the result.`;
    }
    try {
      const owner =
        job.parentSessionOwner ??
        (sessionScope ? sessionOwner(sessionScope) : undefined);
      sendCompletionTurn(
        pi,
        {
          customType: "workflow-notify",
          content,
          display: true,
          details: {
            workflowId: job.id,
            status: job.status,
            presentationStatus: presentation.label,
            usage: run?.usage ?? job.snapshot.usage,
            budgetTotal: job.snapshot.budgetTotal,
          },
        },
        {
          deliverAs: "followUp",
          triggerTurn: true,
          parentStreaming: resolveActualStreamingFlag(owner),
        },
      );
      return true;
    } catch (err) {
      debugLog("warn", "workflow_completion_notification_failed", {
        workflowId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  registerToolWithDefaultGuidance(pi, {
    name: "workflow",
    label: "Workflow",
    description: [
      "Run an agent-authored JavaScript workflow that deterministically orchestrates ISOLATED",
      "sub-agents. Intermediate results live in script variables, not your context window — fan out",
      "dozens of sub-agents (review pipelines, research sweeps, migrations) without context pressure.",
      "Workflow scripts are trusted agent-authored code, not arbitrary user input;",
      "the VM sandbox limits accidental Node globals but is not a security boundary.",
      "Do not run untrusted/user-supplied JavaScript as a workflow.",
      "In-process sub-agents cannot invoke this tool; this topology is unsupported",
      "until cross-registry cancellation is implemented (GitHub issue #62).",
      "",
      "Script shape:",
      "  export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] };",
      "  phase('Scan');",
      "  const out = await parallel([() => agent('task A'), () => agent('task B')]);",
      "  return out;",
      "",
      "Injected helpers/globals:",
      "  agent(prompt, opts?)   -> spawn one isolated sub-agent. opts: { schema?, label?, phase?,",
      "                            model?, persona?, isolation?, agentType?, reusable?, thinkingLevel? (off|minimal|low|medium|high|xhigh|max) }. Without schema returns the final text;",
      "                            with schema returns a value validated against the supported JSON Schema",
      "                            subset (type, enum, required/properties, additionalProperties, items,",
      "                            minItems, maxItems), or null after retries. Returns null on error",
      "                            (filter with Boolean).",
      "                            Defaults to tmux/zellij process isolation (attachable);",
      "                            falls back to in-process if no multiplexer is available. reusable: true",
      "                            keeps a successful process child for a bounded same-session explicit",
      "                            child-ID follow-up; it never enables automatic routing or rehydration.",
      "                            Do not combine reusable with schema validation.",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  workflow(name, args?)  -> run a saved workflow inline (one level deep).",
      "  phase(title) / log(msg)-> progress UI only. args -> your `args`; cwd -> immutable parent working directory; budget -> soft completed-output-token target; parallel in-flight calls may overshoot.",
      "",
      "Default: run in the background and return a workflowId immediately (async). Use async: false for synchronous execution.",
      "Poll with get_workflow_status / get_workflow_result. Up to 100 jobs; cancel with cancel_workflow.",
      "Background completionPolicy defaults to each: the user gets one TUI-only notice and the parent resumes with a compact get_workflow_result reference.",
      "Use completionPolicy=group with a shared safe 1–128 character completionGroupId when related background workflows must reach one all-terminal barrier before the parent resumes (max 32 members per group, 512 groups per parent session).",
      "Constraints: Date.now()/Math.random()/argless new Date() throw; concurrency capped automatically;",
      `>${MAX_TOTAL_AGENTS} agents or >${MAX_ITEMS_PER_CALL} items per call throws. meta MUST be a pure literal.`,
    ].join("\n"),
    promptSnippet:
      "Orchestrate decomposable multi-agent work with trusted raw JavaScript workflows.",
    promptGuidelines: [
      "Use workflows only for decomposable multi-agent work; handle simple or sequential tasks directly.",
      "Omit async for the default background behavior; use async: false only when synchronous execution is required.",
      "Pass raw JavaScript with no markdown fences. Include a top-level pure-literal `export const meta = { name, description, phases? }`.",
      "Do not use TypeScript, imports, require, fs, or other Node APIs. Date.now(), Math.random(), and argless new Date() are unavailable.",
      "Available globals are agent, parallel, pipeline, workflow, phase, log, args, immutable cwd, budget, console, guarded Date, and guarded Math.",
      "Call phase(title) at real work-group transitions. Agent phase defaults to the current phase; an explicit agent phase overrides it.",
      "parallel() takes thunks such as `() => agent(...)`; pipeline() streams each item through every stage independently, with no barrier between stages.",
      "Give agent calls unique short labels, include enough task context and relevant paths, and treat failed agents or stages as null.",
      "Use only the documented plain JSON Schema subset for schema outputs; in-process agents use native structured output while process agents use validated textual JSON fallback.",
      "Filter or handle null results, then use a final synthesis agent when the workflow needs one coherent answer.",
    ],
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          description:
            "The workflow script (export const meta + top-level body). Omit if using `name`.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Name of a saved workflow to run (instead of `script`).",
        }),
      ),
      args: Type.Optional(
        Type.Unknown({
          description: "JSON value exposed to the script as `args`.",
        }),
      ),
      budget: Type.Optional(
        Type.Number({
          description:
            "Optional soft completed-output-token target; in-flight calls may overshoot it, especially in parallel.",
        }),
      ),
      async: Type.Optional(
        Type.Boolean({
          description:
            "Run in the background and return a workflowId immediately.",
        }),
      ),
      completionPolicy: Type.Optional(
        Type.Union([Type.Literal("each"), Type.Literal("group")], {
          description:
            'Completion coordination policy for this background workflow. Defaults to "each"; "group" waits with other workflows/jobs sharing completionGroupId until parent settlement seals the group and every member is terminal.',
        }),
      ),
      completionGroupId: Type.Optional(
        Type.String({
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
          description:
            'Required with completionPolicy="group". Safe 1–128 character identifier shared by related background work; at most 32 members per group and 512 groups per parent session.',
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ): Promise<any> {
      const orchestrationContext = getOrchestrationContext();
      if (orchestrationContext) {
        const error =
          "Workflow tool unavailable inside an in-process sub-agent orchestration context; " +
          "this topology is unsupported until cross-registry cancellation is implemented " +
          "(GitHub issue #62).";
        return {
          content: [{ type: "text", text: `Workflow not run: ${error}` }],
          details: { status: "error", error },
          isError: true,
        };
      }
      const workflowOwner = owner();
      if (
        sessionScope &&
        (!workflowOwner || !isSessionOwnerLive(workflowOwner))
      ) {
        const error =
          "Workflow tool registration is no longer attached to a live session.";
        return {
          content: [{ type: "text", text: `Workflow not run: ${error}` }],
          details: { status: "session_unavailable", error },
          isError: true,
        };
      }

      let completion: ResolvedCompletionPolicy;
      try {
        completion =
          params.async === false
            ? { legacy: false }
            : sessionScope
              ? resolveCompletionPolicy(params)
              : (() => {
                  if (
                    params.completionPolicy !== undefined ||
                    params.completionGroupId !== undefined
                  ) {
                    throw new Error(
                      "completionPolicy or completionGroupId requires an active parent session",
                    );
                  }
                  return { legacy: true };
                })();
        if (
          params.async === false &&
          (params.completionPolicy !== undefined ||
            params.completionGroupId !== undefined)
        ) {
          throw new Error(
            "completionPolicy is available only for background workflows",
          );
        }
        assertCompletionGroupOpen(
          completion.policy,
          completion.groupId,
          workflowOwner,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Workflow not run: ${message}` }],
          details: { status: "error", error: message },
          isError: true,
        };
      }
      const script: string | null =
        typeof params.script === "string" && params.script.trim()
          ? params.script
          : params.name
            ? loadWorkflowScript(params.name)
            : null;
      if (!script) {
        const why = params.name
          ? `no saved workflow named "${params.name}"`
          : "provide `script` or `name`";
        return {
          content: [{ type: "text", text: `Workflow not run: ${why}.` }],
          details: { status: "error", error: why },
          isError: true,
        };
      }

      const baseOpts = (workflowId: string, workflowName: string) => ({
        args: params.args,
        cwd: ctx.cwd,
        budgetTotal: params.budget ?? null,
        runAgent: makeRunAgent(ctx, workflowId, workflowName, workflowOwner),
        loadWorkflow: (n: string) => loadWorkflowScript(n),
      });

      // ── Async (background) path — default ──
      if (params.async !== false) {
        let meta: WorkflowMeta;
        try {
          meta = parseWorkflow(script).meta;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        let completionReservation: CompletionGroupReservation | undefined;
        try {
          completionReservation = reserveCompletionGroup(
            completion.policy,
            completion.groupId,
            workflowOwner,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        const jobStartedAt = Date.now();
        let job: WorkflowJobState;
        try {
          job = startWorkflowJob(
            meta.name,
            script,
            (workflowId) => baseOpts(workflowId, meta.name),
            jobStartedAt,
            notifyWorkflowCompletion,
            workflowOwner,
            "async",
          );
        } catch (err) {
          releaseCompletionGroup(completionReservation);
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        try {
          configureWorkflowCompletion(
            job,
            completion,
            workflowOwner,
            completionReservation,
          );
        } catch (error) {
          discardWorkflowJob(job);
          releaseCompletionGroup(completionReservation);
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${meta.name}" started in background as ${job.id}. ` +
                `Completion coordination will notify the user and resume the parent with a compact result reference; use get_workflow_status / get_workflow_result only for explicit inspection. ${WORKFLOW_SESSION_SCOPE_MESSAGE}`,
            },
          ],
          details: { status: "started", workflowId: job.id, name: meta.name },
        };
      }

      // ── Synchronous (block-and-stream) path ──
      try {
        const meta = parseWorkflow(script).meta;
        const syncProgress = (p: WorkflowProgress) => {
          try {
            onUpdate?.({
              content: [{ type: "text", text: renderProgress(p) }],
              details: {
                status: "running",
                agentsSpawned: p.agentsSpawned,
                runningCount: p.runningCount,
                errorCount: p.errorCount,
                tokensSpent: p.tokensSpent,
                usage: p.usage,
                budgetTotal: p.budgetTotal,
              },
            });
          } catch {
            /* onUpdate is best-effort */
          }
        };
        const job = startWorkflowJob(
          meta.name,
          script,
          (workflowId) => ({
            ...baseOpts(workflowId, meta.name),
            signal,
            onProgress: syncProgress,
          }),
          Date.now(),
          undefined,
          workflowOwner,
          "sync",
        );
        const run = await job.promise;
        const resultText =
          typeof run.result === "string" ? run.result : stringify(run.result);
        const presentation = getWorkflowCompletionPresentation(
          "done",
          run.errorCount,
        );
        const completionPrefix = presentation.icon
          ? `${presentation.icon} `
          : "";
        const completionLabel = presentation.icon
          ? presentation.label
          : "complete";
        const usage = presentWorkflowUsage(run.usage);
        const summary =
          `${completionPrefix}Workflow "${run.meta.name}" ${completionLabel} — ` +
          `${run.agentsSpawned} agent(s), ${run.errorCount} error(s)${
            usage
              ? `, ${formatWorkflowUsage(usage, {
                  outputBudget: job.snapshot.budgetTotal,
                })}`
              : ""
          }.`;
        return {
          content: [{ type: "text", text: `${summary}\n\n${resultText}` }],
          details: {
            status: "done",
            presentationStatus: presentation.label,
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            usage: run.usage,
            budgetTotal: job.snapshot.budgetTotal,
            phases: run.phases,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const usage = workflowErrorUsage(err);
        const usageDetails = usage ? { usage } : {};
        const budgetTotal = params.budget ?? null;
        return {
          content: [
            {
              type: "text",
              text: `Workflow failed: ${msg}${
                usage
                  ? ` (${formatWorkflowUsage(usage, {
                      outputBudget: budgetTotal,
                    })})`
                  : ""
              }`,
            },
          ],
          details: {
            status: "error",
            error: msg,
            budgetTotal,
            ...usageDetails,
          },
          isError: true,
        };
      }
    },
  });

  // ── get_workflow_status ──
  registerToolWithDefaultGuidance(pi, {
    name: "get_workflow_status",
    label: "Workflow Status",
    description:
      "Poll a background workflow's live progress (agents, errors, canonical usage, output budget, and current phase). Usage icons: ↑ input, ↓ output, R/W cache, $ cost.",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = getWorkflowJobForOwner(params.workflowId, owner());
      if (!st) {
        return {
          content: [
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      const errorCount = st.result?.errorCount ?? st.snapshot.errorCount;
      const presentation = getWorkflowCompletionPresentation(
        st.status,
        errorCount,
      );
      const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
      const usage = presentWorkflowUsage(st.snapshot.usage);
      const liveUsage = presentWorkflowUsage(st.snapshot.liveUsage);
      return {
        content: [
          {
            type: "text",
            text:
              `${statusPrefix}Workflow "${st.name}" [${presentation.label}] — ${st.snapshot.agentsSpawned} agent(s)` +
              (st.snapshot.runningCount && st.snapshot.runningCount > 0
                ? `, ${st.snapshot.runningCount} running`
                : "") +
              `, ${errorCount} error(s)` +
              (usage
                ? `, ${formatWorkflowUsage(usage, { outputBudget: st.snapshot.budgetTotal })}`
                : "") +
              (liveUsage ? `, live ${formatWorkflowUsage(liveUsage)}` : "") +
              (st.snapshot.currentPhase
                ? `, phase: ${st.snapshot.currentPhase}`
                : "") +
              (st.error ? `\nerror: ${st.error}` : ""),
          },
        ],
        details: {
          status: st.status,
          presentationStatus: presentation.label,
          workflowId: st.id,
          name: st.name,
          elapsedMs: Date.now() - st.startedAt,
          ...st.snapshot,
        },
      };
    },
  });

  // ── get_workflow_result ──
  registerToolWithDefaultGuidance(pi, {
    name: "get_workflow_result",
    label: "Workflow Result",
    description:
      "Block until a background workflow finishes and return its final result. Successful terminal collection consumes the matching pending coordinated delivery so it is not sent again automatically.",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(
      _id: string,
      params: any,
      signal?: AbortSignal,
    ): Promise<any> {
      const workflowOwner = owner();
      const st = getWorkflowJobForOwner(params.workflowId, workflowOwner);
      if (!st) {
        return {
          content: [
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }

      // If signal is already aborted, return immediately
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text: `Wait for workflow ${st.id} cancelled.`,
            },
          ],
          details: { status: "wait_cancelled", workflowId: st.id },
          isError: true,
        };
      }

      // Race st.promise against the abort signal
      let run: WorkflowRunResult;
      try {
        const waitResult = await abortableWait(st.promise, signal);
        if (waitResult.aborted) {
          return {
            content: [
              {
                type: "text",
                text: `Wait for workflow ${st.id} cancelled.`,
              },
            ],
            details: { status: "wait_cancelled", workflowId: st.id },
            isError: true,
          };
        }
        run = waitResult.value!;
      } catch (err) {
        // Non-abort errors preserve the original structured handling
        const msg = err instanceof Error ? err.message : String(err);
        const usage = presentWorkflowUsage(st.snapshot?.usage);
        const outputBudget = st.snapshot?.budgetTotal;
        const usageDetails = usage ? { usage } : {};
        st.resultRetrieved = true;
        consumeCompletionSource(
          pi,
          { source: "workflow", sourceId: st.id },
          workflowOwner,
        );
        return {
          content: [
            {
              type: "text",
              text: `Workflow ${st.id} ${st.status}: ${msg}${
                usage
                  ? ` (${formatWorkflowUsage(usage, {
                      outputBudget,
                    })})`
                  : ""
              }`,
            },
          ],
          details: {
            status: st.status,
            workflowId: st.id,
            error: msg,
            ...(outputBudget == null ? {} : { budgetTotal: outputBudget }),
            ...usageDetails,
          },
          isError: true,
        };
      }

      const resultText =
        typeof run.result === "string" ? run.result : stringify(run.result);
      const presentation = getWorkflowCompletionPresentation(
        "done",
        run.errorCount,
      );
      const usage = presentWorkflowUsage(run.usage);
      st.resultRetrieved = true;
      consumeCompletionSource(
        pi,
        { source: "workflow", sourceId: st.id },
        workflowOwner,
      );
      return {
        content: [
          {
            type: "text",
            text: (() => {
              const prefix = presentation.icon ? `${presentation.icon} ` : "";
              const label = presentation.icon ? presentation.label : "complete";
              return (
                `${prefix}Workflow "${run.meta.name}" ${label} — ` +
                `${run.agentsSpawned} agent(s), ${run.errorCount} error(s)${
                  usage
                    ? `, ${formatWorkflowUsage(usage, {
                        outputBudget: st.snapshot.budgetTotal,
                      })}`
                    : ""
                }.\n\n${resultText}`
              );
            })(),
          },
        ],
        details: {
          status: "done",
          presentationStatus: presentation.label,
          workflowId: st.id,
          name: run.meta.name,
          agentsSpawned: run.agentsSpawned,
          errorCount: run.errorCount,
          tokensSpent: run.tokensSpent,
          usage: run.usage,
          budgetTotal: st.snapshot.budgetTotal,
          phases: run.phases,
        },
      };
    },
  });

  // ── cancel_workflow ──
  registerToolWithDefaultGuidance(pi, {
    name: "cancel_workflow",
    label: "Cancel Workflow",
    description:
      "Abort a running background workflow (stops scheduling new agents; in-flight agents are signalled).",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = getWorkflowJobForOwner(params.workflowId, owner());
      if (!st) {
        return {
          content: [
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      if (st.status === "cancelled") {
        if (cancellationSnapshotsEnabled()) {
          await waitForCancellationReceipts(st);
          normalizeCancelledWorkflowState(st);
        }
        return {
          content: [
            { type: "text", text: `Workflow ${st.id} is already cancelled.` },
          ],
          details: {
            status: "cancelled",
            workflowId: st.id,
            cancelled: true,
            snapshots: [...(st.cancellationSnapshots ?? [])],
          },
        };
      }
      if (st.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Workflow ${st.id} is already ${st.status}; nothing was cancelled.`,
            },
          ],
          details: {
            status: st.status,
            workflowId: st.id,
            cancelled: false,
          },
        };
      }
      st.abort.abort();
      st.status = "cancelled";
      normalizeCancelledWorkflowState(st);
      invokeWorkflowCompletionHook(st);
      if (cancellationSnapshotsEnabled()) {
        await waitForCancellationReceipts(st);
        normalizeCancelledWorkflowState(st);
      }
      return {
        content: [{ type: "text", text: `Workflow ${st.id} cancelled.` }],
        details: {
          status: "cancelled",
          workflowId: st.id,
          cancelled: true,
          snapshots: [...(st.cancellationSnapshots ?? [])],
        },
      };
    },
  });

  // ── save_workflow ──
  registerToolWithDefaultGuidance(pi, {
    name: "save_workflow",
    label: "Save Workflow",
    description:
      "Persist a workflow script under a name so it can be run later by `name` or composed via workflow(name).",
    parameters: Type.Object({
      name: Type.String({
        description: "Slug name (lowercase letters, digits, hyphens; max 64).",
      }),
      script: Type.String({
        description: "The workflow script to save (validated before writing).",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const file = saveWorkflowScript(params.name, params.script);
        return {
          content: [
            {
              type: "text",
              text: `Saved workflow "${params.name}" to ${file}.`,
            },
          ],
          details: { status: "saved", name: params.name, file },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Could not save workflow: ${msg}` }],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── list_workflows ──
  registerToolWithDefaultGuidance(pi, {
    name: "list_workflows",
    label: "List Workflows",
    description: "List saved workflows (name + description).",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      const items = listSavedWorkflows();
      const text = items.length
        ? items.map((w) => `- ${w.name}: ${w.description}`).join("\n")
        : "(no saved workflows)";
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", workflows: items },
      };
    },
  });

  // ── delete_workflow ──
  registerToolWithDefaultGuidance(pi, {
    name: "delete_workflow",
    label: "Delete Workflow",
    description: "Delete a saved workflow by name.",
    parameters: Type.Object({
      name: Type.String({
        description: "Name of the saved workflow to delete.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const existed = deleteWorkflowScript(params.name);
        return {
          content: [
            {
              type: "text",
              text: existed
                ? `Deleted workflow "${params.name}".`
                : `No saved workflow named "${params.name}".`,
            },
          ],
          details: {
            status: existed ? "deleted" : "not_found",
            name: params.name,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Could not delete workflow: ${msg}` },
          ],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── Workflow user commands (guarded) ──
  if (typeof pi.registerCommand === "function") {
    const sendCommandMessage = (text: string) => {
      const sendMessage = (pi as any).sendMessage;
      if (typeof sendMessage === "function") {
        sendMessage.call(
          pi,
          {
            customType: "workflow-command",
            content: text,
            display: true,
          },
          { deliverAs: "followUp" },
        );
        return;
      }
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    };

    const sendWorkflowCreationPrompt = async (
      ctx: ExtensionCommandContext,
      task: string,
    ) => {
      const prompt = buildWorkflowCreationPrompt(task);
      const sendUserMessage = (ctx as any).sendUserMessage;
      if (typeof sendUserMessage === "function") {
        await sendUserMessage.call(ctx, prompt, { deliverAs: "followUp" });
        return;
      }
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    };

    const startSavedWorkflowFromCommand = (
      name: string,
      argsValue: unknown,
      ctx: ExtensionCommandContext,
    ) => {
      const script = loadWorkflowScript(name);
      if (!script) throw new Error(`No saved workflow named "${name}".`);
      const meta = parseWorkflow(script).meta;
      const workflowOwner = owner();
      if (
        sessionScope &&
        (!workflowOwner || !isSessionOwnerLive(workflowOwner))
      ) {
        throw new Error(
          "Workflow command registration is no longer attached to a live session.",
        );
      }
      const job = startWorkflowJob(
        meta.name,
        script,
        (workflowId) => ({
          args: argsValue,
          cwd: ctx.cwd,
          budgetTotal: null,
          runAgent: makeRunAgent(ctx, workflowId, meta.name, workflowOwner),
          loadWorkflow: (n: string) => loadWorkflowScript(n),
        }),
        Date.now(),
        notifyWorkflowCompletion,
        workflowOwner,
      );
      configureWorkflowCompletion(
        job,
        sessionScope ? { policy: "each", legacy: false } : { legacy: true },
        workflowOwner,
      );
      return { job, meta };
    };

    const selectSavedWorkflow = async (
      ui: ExtensionCommandContext["ui"],
      choices: WorkflowPickerChoice[],
    ): Promise<WorkflowPickerAction | undefined> => {
      const custom = (ui as any).custom;
      if (typeof custom === "function") {
        return custom.call(
          ui,
          (
            _tui: unknown,
            theme: unknown,
            _kb: unknown,
            done: (action: WorkflowPickerAction) => void,
          ) => new WorkflowPickerComponent(choices, theme as any, done),
        ) as Promise<WorkflowPickerAction | undefined>;
      }
      const deleteLabel = "🗑  Delete a workflow…";
      const labels = choices.map(
        (choice) =>
          `${choice.name} — ${choice.description || "(no description)"}`,
      );
      const selected = await ui.select("Select workflow:", [
        ...labels,
        "──────────────",
        deleteLabel,
      ]);
      if (!selected) return undefined;
      if (selected === deleteLabel) {
        const toDelete = await ui.select("Select workflow to delete:", labels);
        if (!toDelete) return undefined;
        const choice = choices.find(
          (candidate) =>
            `${candidate.name} — ${candidate.description || "(no description)"}` ===
            toDelete,
        );
        return choice ? { kind: "delete", name: choice.name } : undefined;
      }
      const choice = choices.find(
        (candidate) =>
          `${candidate.name} — ${candidate.description || "(no description)"}` ===
          selected,
      );
      return choice ? { kind: "run", name: choice.name } : undefined;
    };

    const runSavedWorkflowCommand = async (
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ) => {
      const items = listSavedWorkflows();
      const parsed = parseWorkflowCommandArgs(rawArgs);

      const choices = items.map((w) => ({
        name: w.name,
        description: w.description || "(no description)",
      }));

      if (items.length === 0) {
        const text =
          "No saved workflows. Use `/workflow <task>` to create one.";
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return;
      }

      // If name was provided inline, try run it directly
      const inlineName = parsed.name;
      if (inlineName) {
        await runNamedWorkflow(inlineName, parsed, ctx);
        return;
      }

      const action = await selectSavedWorkflow(ctx.ui, choices);
      if (!action || action.kind === "cancel") return;
      if (action.kind === "delete") {
        deleteWorkflowScript(action.name);
        const text = `Deleted workflow "${action.name}".`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return;
      }

      await runNamedWorkflow(action.name, parsed, ctx);
    };

    async function runNamedWorkflow(
      name: string,
      parsed: { name: string | null; argsJson: string | null },
      ctx: ExtensionCommandContext,
    ) {
      const items = listSavedWorkflows();
      const known = items.some((w) => w.name === name);
      if (!known) {
        const text = `No saved workflow named "${name}".`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return;
      }
      try {
        const argsValue = parsed.argsJson
          ? parseArgsJson(parsed.argsJson)
          : await promptForWorkflowArgs(ctx);
        if (argsValue === CANCELLED_ARGS_PROMPT) return;
        const { job, meta } = startSavedWorkflowFromCommand(
          name,
          argsValue,
          ctx,
        );
        const text =
          `Workflow "${meta.name}" started in background as ${job.id}. ` +
          `${WORKFLOW_SESSION_SCOPE_MESSAGE} Use /workflow-status to inspect running jobs.`;
        ctx.ui.notify(`Started workflow ${meta.name}.`);
        sendCommandMessage(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const text = `Workflow not started: ${msg}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    }

    pi.registerCommand("workflow", {
      description:
        "Create a reusable workflow from a task, save it, and run it immediately.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const inlineTask = args.trim();
        const editor = (ctx.ui as any).editor;
        const input = (ctx.ui as any).input;
        const promptedTask =
          !inlineTask && typeof editor === "function"
            ? await editor.call(ctx.ui, "Workflow task:", "")
            : !inlineTask && typeof input === "function"
              ? await input.call(ctx.ui, "Workflow task:", "")
              : "";
        const task =
          inlineTask || (promptedTask == null ? "" : String(promptedTask));
        if (!task.trim()) {
          ctx.ui.notify("Workflow task is required.");
          return;
        }
        ctx.ui.notify("Creating workflow from task.");
        await sendWorkflowCreationPrompt(ctx, task.trim());
      },
    });

    pi.registerCommand("workflows", {
      description: "List saved workflows, select one, and run it.",
      handler: runSavedWorkflowCommand,
    });

    pi.registerCommand("list-workflows", {
      description: "Alias for /workflows.",
      handler: runSavedWorkflowCommand,
    });

    pi.registerCommand("workflow-status", {
      description:
        "List running and completed workflow jobs with status, agent counts, canonical usage, output budget, and elapsed time.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const text = renderWorkflowJobs(owner());
        ctx.ui.notify("📋 Workflow status listed.");
        sendCommandMessage(text);
      },
    });

    pi.registerCommand("workflow-tree", {
      description:
        "Open an interactive workflow tree with expand/collapse and cancel controls.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const action = await showWorkflowTree(ctx.ui, owner());
        if (action.kind === "cancel") {
          sendCommandMessage(`Workflow ${action.workflowId} cancelled.`);
        }
      },
    });

    pi.registerCommand("delete-workflow", {
      description:
        "Delete a saved workflow by name (interactive picker if no name given).",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const items = listSavedWorkflows();
        if (items.length === 0) {
          const text = "No saved workflows to delete.";
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        const choices = items.map((w) => ({
          name: w.name,
          label: `${w.name} — ${w.description || "(no description)"}`,
        }));
        let name = args.trim();
        if (!name) {
          const selected = await ctx.ui.select(
            "Select workflow to delete:",
            choices.map((c) => c.label),
          );
          const choice = choices.find((c) => c.label === selected);
          if (!choice) return;
          name = choice.name;
        }
        const known = items.some((w) => w.name === name);
        if (!known) {
          const text = `No saved workflow named "${name}".`;
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        deleteWorkflowScript(name);
        const text = `Deleted workflow "${name}".`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      },
    });
  }
  const CANCELLED_ARGS_PROMPT = Symbol("cancelled-workflow-args");

  function parseWorkflowCommandArgs(raw: string): {
    name: string | null;
    argsJson: string | null;
  } {
    const trimmed = raw.trim();
    const firstSpace = trimmed.search(/\s/);
    if (!trimmed) return { name: null, argsJson: null };
    if (firstSpace === -1) return { name: trimmed, argsJson: null };
    return {
      name: trimmed.slice(0, firstSpace),
      argsJson: trimmed.slice(firstSpace).trim() || null,
    };
  }

  function parseArgsJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Workflow args must be valid JSON: ${msg}`);
    }
  }

  async function promptForWorkflowArgs(
    ctx: ExtensionCommandContext,
  ): Promise<unknown | typeof CANCELLED_ARGS_PROMPT> {
    const editor = (ctx.ui as any).editor;
    const input = (ctx.ui as any).input;
    const raw =
      typeof editor === "function"
        ? await editor.call(ctx.ui, "Workflow args JSON (optional):", "{}")
        : typeof input === "function"
          ? await input.call(ctx.ui, "Workflow args JSON (optional):", "{}")
          : "{}";
    if (raw == null) return CANCELLED_ARGS_PROMPT;
    const trimmed = String(raw).trim();
    return trimmed ? parseArgsJson(trimmed) : undefined;
  }

  function buildWorkflowCreationPrompt(task: string): string {
    return [
      "You are handling the `/workflow <task>` command.",
      "",
      "Create a reusable JavaScript workflow for the user's task, save it, and run it immediately.",
      "",
      "Requirements:",
      "1. Design a bounded workflow script with `export const meta = { name, description, phases }`.",
      "2. The workflow should accept its task/config through `args` so it can be reused later.",
      "3. Save the script with `save_workflow` using a lowercase slug name.",
      "4. Immediately start it with the `workflow` tool by saved `name` and suitable `args`.",
      "5. Do not use Node APIs inside the workflow script; file I/O must happen inside sub-agents via tools.",
      "6. Do not set `isolation` unless the workflow explicitly needs to opt out; workflow agents default to tmux/zellij process isolation and fall back to in-process automatically.",
      "7. Report the saved workflow name and returned workflowId.",
      "",
      "User task:",
      task,
    ].join("\n");
  }

  function renderWorkflowJobs(owner: SessionOwnerToken | undefined): string {
    const lines: string[] = [];
    const now = Date.now();
    let count = 0;
    for (const st of workflowJobsForOwner(owner)) {
      count++;
      const elapsed = formatElapsed(now - st.startedAt);
      const s = st.snapshot;
      const errorCount = st.result?.errorCount ?? s.errorCount;
      const presentation = getWorkflowCompletionPresentation(
        st.status,
        errorCount,
      );
      const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
      const parts: string[] = [
        `**${st.name}** (${st.id}) [${statusPrefix}${presentation.label}]`,
        `${s.agentsSpawned} agent(s)`,
      ];
      if (s.runningCount && s.runningCount > 0) {
        parts.push(`⚡ ${s.runningCount} running`);
      }
      if (errorCount > 0) parts.push(`⚠ ${errorCount} error(s)`);
      const usage = presentWorkflowUsage(s.usage);
      if (usage) {
        parts.push(formatWorkflowUsage(usage, { outputBudget: s.budgetTotal }));
      }
      parts.push(elapsed);
      if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
      if (st.error) parts.push(`error: ${st.error}`);
      lines.push(`- ${parts.join(" · ")}`);
      if (s.lastMessage && count <= 20) lines.push(`  last: ${s.lastMessage}`);
    }
    return count === 0
      ? "No workflow jobs."
      : `**Workflow jobs (${count})**\n` + lines.join("\n");
  }

  function formatElapsed(ms: number): string {
    if (ms < 0) return "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
}

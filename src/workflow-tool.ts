import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { abortableWait } from "./abortable-wait";
import {
  debugLog,
  registerInProcessJob,
  removeInProcessJob,
  startSubagentJob,
  type JobState,
} from "./helpers";
import {
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
import { createWorkflowDispatcher } from "./workflow-dispatcher";
import {
  createDurableWorkflowRunId,
  getDurableWorkflowLiveJobForOwner,
  getWorkflowCompletionPresentation,
  getWorkflowJobForOwner,
  normalizeCancelledWorkflowState,
  registerDurableWorkflowLiveJob,
  startWorkflowJob,
  startWorkflowPlanJob,
  workflowJobsForOwner,
  type DurableWorkflowLiveJob,
  type WorkflowJobState,
} from "./workflow-jobs";
import { renderProgress, renderWorkflowPlanProgress } from "./workflow-ui";
import { awaitInteractiveResult, stringify } from "./workflow-worker";
import { sanitizeOutput } from "./notifications";
import { showWorkflowTree } from "./workflow-tree-ui";
import {
  WorkflowPickerComponent,
  type WorkflowPickerAction,
  type WorkflowPickerChoice,
} from "./workflow-picker-ui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { cancellationSnapshotsEnabled } from "./cancellation-snapshots";
import { getOrchestrationContext } from "./orchestration-context";
import {
  getActiveSessionOwner,
  isSessionOwnerLive,
  resolveLiveSessionScope,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import { attachAsyncJobSettlement } from "./tools/in-process";
import {
  durableWorkflowControllerForSession,
  durableWorkflowStoreForSession,
  dispatchTerminalDeliveryForSession,
  resumeDurableWorkflowForSession,
  runDurableWorkflowForSession,
} from "./workflow-owner";
import { workflowDeliveryId } from "./workflow-durable-plan-runner";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import type { WorkflowPlanState } from "./workflow-plan-state";
import {
  decideWorkflowRouting,
  parseWorkflowEagerMode,
} from "./workflow-routing";
import {
  workflowContinuitySnapshot,
  type WorkflowContinuitySnapshot,
} from "./workflow-continuity";
import type { WorkflowProjection } from "./workflow-projection-repository";

function publishWorkflowContinuity(
  projection: WorkflowProjection,
  scope?: SessionScope,
): WorkflowContinuitySnapshot | undefined {
  if (!scope) return undefined;
  const snapshot = workflowContinuitySnapshot(projection);
  scope.durableWorkflowContinuity = snapshot;
  return snapshot;
}

const WORKFLOW_SESSION_SCOPE_MESSAGE =
  "Workflow jobs are scoped to the current parent session and do not survive reload/resume/new/quit.";

const WORKFLOW_RUN_ID_PATTERN = "^[A-Za-z][A-Za-z0-9._-]{0,127}$";
const WORKFLOW_RUN_ID = new RegExp(WORKFLOW_RUN_ID_PATTERN);
const WORKFLOW_PLAN_ID_PATTERN = "^[A-Za-z][A-Za-z0-9._-]{0,63}$";
const workflowPlanParameterSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    name: Type.String({ pattern: WORKFLOW_PLAN_ID_PATTERN }),
    phases: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: WORKFLOW_PLAN_ID_PATTERN }),
          mode: Type.Literal("sequential"),
          tasks: Type.Array(
            Type.Object(
              {
                id: Type.String({ pattern: WORKFLOW_PLAN_ID_PATTERN }),
                prompt: Type.String({ minLength: 1, maxLength: 262_144 }),
                label: Type.Optional(Type.String({ maxLength: 262_144 })),
                isolation: Type.Optional(Type.Literal("in-process")),
                input: Type.Optional(Type.Unknown()),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: MAX_TOTAL_AGENTS },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

function workflowNotFoundMessage(workflowId: string): string {
  return (
    `Workflow ${workflowId} not found in the current parent session. ` +
    "It may have been created in another session or removed by reload/resume/new/quit."
  );
}

const CANCELLATION_RECEIPT_GRACE_MS = INTERACTIVE_POLL_MS + 250;
const DURABLE_CANCELLATION_DRAIN_MS = CANCELLATION_RECEIPT_GRACE_MS;

interface WorkflowCancellationInvocation {
  sessionOwner?: SessionOwnerToken;
  durableOwner?: SessionScope["durableWorkflowOwner"];
  controller?: SessionScope["durableWorkflowController"];
  canonicalCwd?: string;
}

interface WorkflowCancellationContext {
  cwd?: string;
}

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
async function interruptAndDrainDurableWorkflowJob(
  job: DurableWorkflowLiveJob,
): Promise<void> {
  job.abort.abort(new Error("Durable workflow cancellation requested"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DURABLE_CANCELLATION_DRAIN_MS);
  });
  try {
    await Promise.race([
      job.promise.then(
        () => undefined,
        () => undefined,
      ),
      grace,
    ]);
  } finally {
    clearTimeout(timer);
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

function durableWorkflowRootForScope(
  scope: SessionScope | undefined,
): string | undefined {
  return scope?.durableWorkflowOwner?.cwd;
}

function durableControllerForScope(scope?: SessionScope) {
  const root = durableWorkflowRootForScope(scope);
  return root && scope
    ? durableWorkflowControllerForSession(root, scope)
    : undefined;
}

function durableStoreForScope(scope?: SessionScope) {
  const root = durableWorkflowRootForScope(scope);
  return root && scope
    ? durableWorkflowStoreForSession(root, scope)
    : undefined;
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

  pi.registerTool({
    name: "get_durable_workflow_status",
    label: "Durable Workflow Status",
    description: "Read the owner-scoped durable workflow projection.",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_id: string, params: { workflowId: string }): Promise<any> {
      const controller = durableControllerForScope(sessionScope);
      if (!controller) {
        return {
          content: [
            { type: "text", text: "Durable workflow storage is unavailable." },
          ],
          details: { status: "unavailable" },
          isError: true,
        };
      }
      const projection = await controller.getStatus(params.workflowId);
      if (!projection) {
        return {
          content: [
            {
              type: "text",
              text: `Durable workflow ${params.workflowId} was not found.`,
            },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      publishWorkflowContinuity(projection, sessionScope);
      return {
        content: [
          {
            type: "text",
            text: `Durable workflow ${projection.runId}: ${projection.status}`,
          },
        ],
        details: projection,
      };
    },
  });
  pi.registerTool({
    name: "get_durable_workflow_result",
    label: "Durable Workflow Result",
    description: "Read a persisted terminal durable workflow result.",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_id: string, params: { workflowId: string }): Promise<any> {
      const controller = durableControllerForScope(sessionScope);
      if (!controller) {
        return {
          content: [
            { type: "text", text: "Durable workflow storage is unavailable." },
          ],
          details: { status: "unavailable" },
          isError: true,
        };
      }
      const projection = await controller.getStatus(params.workflowId);
      if (!projection) {
        return {
          content: [
            {
              type: "text",
              text: `Durable workflow ${params.workflowId} was not found.`,
            },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      if (!projection.terminal) {
        return {
          content: [
            {
              type: "text",
              text: `Durable workflow ${projection.runId} is not terminal.`,
            },
          ],
          details: { status: projection.status, workflowId: projection.runId },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(projection.terminal) }],
        details: {
          status: "terminal",
          workflowId: projection.runId,
          result: projection.terminal,
        },
      };
    },
  });
  // Build the real spawn function from the tool ctx. Switches backend on `isolation`.
  function makeRunAgent(
    ctx: any,
    ownedWorkflowId: string,
    supervisorOwner: SessionOwnerToken | undefined,
  ): WorkflowAgentRunner {
    const runRawAgent: WorkflowAgentRunner = async ({
      prompt,
      persona,
      model,
      signal,
      isolation,
      label,
      schema,
      thinkingLevel,
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
      if (tryProcess) {
        let state: ReturnType<typeof launchInteractiveSubagent> | undefined;
        const childScope = resolveLiveSessionScope(supervisorOwner);
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
            workflowId: ownedWorkflowId,
            completionOwner: "workflow",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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
            "Workflow agent cancelled: parent session shut down before the child was registered.",
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
    return (request) => workflowDispatcher.run(request, runRawAgent);
  }

  const MAX_WORKFLOW_NOTIFICATION_CHARS = 20_000;
  const WORKFLOW_TRUNCATION_MARKER = "\n\n[Content truncated.]";

  function truncateWorkflowNotification(text: string): string {
    if (text.length <= MAX_WORKFLOW_NOTIFICATION_CHARS) return text;
    const end =
      MAX_WORKFLOW_NOTIFICATION_CHARS - WORKFLOW_TRUNCATION_MARKER.length;
    return text.slice(0, Math.max(0, end)) + WORKFLOW_TRUNCATION_MARKER;
  }

  function notifyWorkflowCompletion(job: WorkflowJobState): boolean {
    const run = job.result;
    const errorCount = run?.errorCount ?? job.snapshot.errorCount;
    const presentation = getWorkflowCompletionPresentation(
      job.status,
      errorCount,
    );
    const icon = presentation.icon || (job.status === "done" ? "✅" : "❌");
    const rawSummary = formatWorkflowNotificationSummary(job);
    const summary = truncateWorkflowNotification(sanitizeOutput(rawSummary));
    let content = `${icon} Workflow "${job.name}" (${job.id}) ${presentation.label} — ${summary}`;
    if (run) {
      content += `\n\nCall get_workflow_result with workflowId "${job.id}" to retrieve the result.`;
    }
    try {
      pi.sendMessage!(
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
        { deliverAs: "followUp", triggerTurn: true },
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

  async function getDurableWorkflowProjection(
    workflowId: string,
  ): Promise<WorkflowProjection | undefined> {
    if (!sessionScope) return undefined;
    const projection =
      await durableWorkflowControllerForSession(sessionScope)?.getStatus(
        workflowId,
      );
    const live = getDurableWorkflowLiveJobForOwner(workflowId, owner());
    if (
      !projection ||
      projection.terminal ||
      !live ||
      live.runEpoch !== projection.runEpoch
    ) {
      return projection;
    }
    const tasks = Object.fromEntries(
      Object.entries(projection.tasks).map(([taskId, task]) => [
        taskId,
        task.status === "interrupted" ? { ...task, status: "running" } : task,
      ]),
    ) as WorkflowProjection["tasks"];
    return { ...projection, status: "running", tasks };
  }

  async function listDurableWorkflowProjections(): Promise<
    readonly WorkflowProjection[]
  > {
    const store = sessionScope
      ? durableWorkflowStoreForSession(sessionScope)
      : undefined;
    const durableOwner = sessionScope?.durableWorkflowOwner;
    if (!store || !durableOwner) return [];
    const projections = await new DurableWorkflowProjectionRepository(
      store,
      durableOwner,
    ).list();
    return Promise.all(
      projections.map(async (projection) => {
        return (
          (await getDurableWorkflowProjection(projection.runId)) ?? projection
        );
      }),
    );
  }

  async function durableProjectionDetails(
    projection: WorkflowProjection,
    committedEpoch?: number,
  ) {
    const tasks = Object.values(projection.tasks);
    const liveSessionOwner = owner();
    const durableOwner = sessionScope?.durableWorkflowOwner;
    if (
      !sessionScope ||
      !liveSessionOwner ||
      !isSessionOwnerLive(liveSessionOwner) ||
      !durableOwner
    ) {
      throw new Error(
        "Durable workflow details are available only in the live parent session",
      );
    }
    if (
      projection.owner.projectKey !== durableOwner.projectKey ||
      projection.owner.cwd !== durableOwner.cwd ||
      projection.owner.piSessionId !== durableOwner.piSessionId
    ) {
      throw new Error("Durable workflow projection owner namespace is stale");
    }
    const store = durableWorkflowStoreForSession(sessionScope);
    if (!store) throw new Error("Durable workflow storage is unavailable");
    const leaseEpoch = committedEpoch ?? (await store.getLeaseEpoch());
    return {
      status: projection.status,
      workflowId: projection.runId,
      durable: true,
      resumePolicy: "manual",
      revision: projection.revision,
      runEpoch: projection.runEpoch,
      ownerGeneration: durableOwner.ownerGeneration,
      leaseEpoch,
      currentPhase: projection.currentPhase,
      agentsSpawned: tasks.filter((task) => task.status !== "pending").length,
      runningCount: tasks.filter((task) => task.status === "running").length,
      errorCount: tasks.filter((task) => task.status === "failed").length,
      tasks: projection.tasks,
      usage: projection.usage,
      usageLowerBound: projection.usageLowerBound,
      terminal: projection.terminal,
    };
  }

  pi.registerTool({
    name: "start_durable_workflow",
    label: "Start Durable Workflow",
    description:
      "Create and execute a validated sequential or parallel durable plan.",
    parameters: Type.Object({
      runId: Type.String(),
      plan: Type.Any(),
    }),
    async execute(
      _id: string,
      params: any,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: any,
    ): Promise<any> {
      const durableRoot = durableWorkflowRootForScope(sessionScope);
      if (!sessionScope || !durableRoot) {
        return {
          content: [
            { type: "text", text: "Durable workflow storage is unavailable." },
          ],
          isError: true,
        };
      }
      const plan = params.plan as WorkflowPlan;
      validateWorkflowPlan(plan);
      const result = await runDurableWorkflowForSession(
        durableRoot,
        sessionScope,
        {
          runId: params.runId,
          plan,
          signal,
          runAgent: makeRunAgent(ctx, params.runId, owner()),
        },
      );
      if (
        result.terminal &&
        (result.delivery?.status === "pending" ||
          result.delivery?.status === "dispatched")
      ) {
        const deliveryId =
          result.delivery?.deliveryId ?? workflowDeliveryId(result.runId);
        try {
          const controller = durableWorkflowControllerForSession(
            process.cwd(),
            sessionScope,
          );
          await controller?.dispatchDelivery(result.runId, deliveryId);
        } catch (error) {
          debugLog("warn", "durable_workflow_delivery_failed", {
            workflowId: result.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Durable workflow ${result.runId}: ${result.status}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
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
      "Alternatively, pass a validated sequential declarative `plan`; preview tasks run",
      "in-process only. `plan` + `durable: true` opts into the restart-safe sequential preview.",
      "",
      "Script shape:",
      "  export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] };",
      "  phase('Scan');",
      "  const out = await parallel([() => agent('task A'), () => agent('task B')]);",
      "  return out;",
      "",
      "Injected helpers/globals:",
      "  agent(prompt, opts?)   -> spawn one isolated sub-agent. opts: { schema?, label?, phase?,",
      "                            model?, persona?, isolation?, agentType?, thinkingLevel? (off|minimal|low|medium|high|xhigh|max) }. Without schema returns the final text;",
      "                            with schema returns a value validated against the supported JSON Schema",
      "                            subset (type, enum, required/properties, additionalProperties, items,",
      "                            minItems, maxItems), or null after retries. Returns null on error",
      "                            (filter with Boolean).",
      "                            Defaults to tmux/zellij process isolation (attachable);",
      "                            falls back to in-process if no multiplexer is available.",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  workflow(name, args?)  -> run a saved workflow inline (one level deep).",
      "  phase(title) / log(msg)-> progress UI only. args -> your `args`; cwd -> immutable parent working directory; budget -> soft completed-output-token target; parallel in-flight calls may overshoot.",
      "",
      "Default: run in the background and return a workflowId immediately (async). Use async: false for synchronous execution.",
      "Poll with get_workflow_status / get_workflow_result. Up to 100 jobs; cancel with cancel_workflow.",
      "Constraints: Date.now()/Math.random()/argless new Date() throw; concurrency capped automatically;",
      `>${MAX_TOTAL_AGENTS} agents or >${MAX_ITEMS_PER_CALL} items per call throws. meta MUST be a pure literal.`,
    ].join("\n"),
    promptSnippet:
      "Orchestrate decomposable multi-agent work with trusted raw JavaScript workflows.",
    promptGuidelines: [
      "Use workflows only for decomposable multi-agent work; handle simple or sequential tasks directly.",
      "Omit async for the default background behavior; use async: false only when synchronous execution is required.",
      "Use `plan` + `durable: true` only for explicit stable task IDs, sequential phases, in-process isolation, and trusted manual resume; durable plans are always asynchronous.",
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
            "The workflow script (export const meta + top-level body). Omit if using `name` or `plan`.",
        }),
      ),
      plan: Type.Optional(
        Type.Unknown({
          description:
            "Declarative non-durable preview plan (mutually exclusive with script and name).",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Name of a saved workflow to run (instead of `script` or `plan`).",
        }),
      ),
      plan: Type.Optional(workflowPlanParameterSchema),
      durable: Type.Optional(
        Type.Boolean({
          description:
            "Persist and run a sequential in-process plan. Durable script/name execution is unavailable.",
        }),
      ),
      resumePolicy: Type.Optional(
        Type.Literal("manual", {
          description:
            "Durable plans require trusted manual resume after interruption.",
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
      durable: Type.Optional(
        Type.Boolean({
          description:
            "Durable JavaScript replay is not supported by the legacy workflow tool.",
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
      if (params.durable === true) {
        return {
          content: [
            {
              type: "text",
              text: "Durable JavaScript workflows are not supported; use start_durable_workflow with a declarative plan.",
            },
          ],
          details: { status: "unsupported_durable" },
          isError: true,
        };
      }
      const hasScript =
        typeof params.script === "string" && params.script.trim().length > 0;
      const hasName =
        typeof params.name === "string" && params.name.trim().length > 0;
      const hasPlan = params.plan !== undefined;
      const selectorCount =
        Number(hasScript) + Number(hasName) + Number(hasPlan);
      if (selectorCount > 1) {
        const error =
          "Workflow inputs `script`, `name`, and `plan` are mutually exclusive.";
        return {
          content: [{ type: "text", text: `Workflow not run: ${error}` }],
          details: { status: "conflicting_inputs", error },
          isError: true,
        };
      }
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
      if (plan !== undefined) {
        if (durable) {
          if (
            !sessionScope ||
            !workflowOwner ||
            !sessionScope.durableWorkflowOwner
          ) {
            const error =
              "durable workflow storage is unavailable outside a live parent session";
            return {
              content: [
                { type: "text", text: `Workflow plan not started: ${error}.` },
              ],
              details: { status: "error", error },
              isError: true,
            };
          }
          let executionCwd: string;
          try {
            executionCwd = realpathSync.native(ctx?.cwd);
          } catch {
            executionCwd = "";
          }
          if (executionCwd !== sessionScope.durableWorkflowOwner.cwd) {
            const error =
              "durable workflow cwd does not match the live session owner";
            return {
              content: [
                { type: "text", text: `Workflow plan not started: ${error}.` },
              ],
              details: { status: "error", error },
              isError: true,
            };
          }
          if (signal?.aborted) {
            const error =
              "durable workflow start was cancelled before run creation";
            return {
              content: [
                { type: "text", text: `Workflow plan not started: ${error}.` },
              ],
              details: { status: "error", error },
              isError: true,
            };
          }
          const controller = durableWorkflowControllerForSession(sessionScope);
          const store = durableWorkflowStoreForSession(sessionScope);
          if (!controller || !store) {
            const error = "durable workflow storage is unavailable";
            return {
              content: [
                { type: "text", text: `Workflow plan not started: ${error}.` },
              ],
              details: { status: "error", error },
              isError: true,
            };
          }

          const runId = createDurableWorkflowRunId();
          const abort = new AbortController();
          const forwardAbort = () => abort.abort(signal?.reason);
          signal?.addEventListener("abort", forwardAbort, { once: true });
          try {
            const started = await controller.create({
              runId,
              plan,
              resumePolicy: "manual",
              runAgent: makeRunAgent(ctx, runId, workflowOwner),
              signal: abort.signal,
            });
            signal?.removeEventListener("abort", forwardAbort);
            const liveJob: DurableWorkflowLiveJob = {
              id: runId,
              name: plan.name,
              startedAt: Date.now(),
              runEpoch: started.projection.runEpoch,
              promise: started.completion,
              abort,
              parentSessionOwner: workflowOwner,
            };
            registerDurableWorkflowLiveJob(liveJob);
            void started.completion.then(undefined, (error) => {
              debugLog("warn", "durable_workflow_execution_failed", {
                workflowId: runId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Durable workflow plan "${plan.name}" started in background as ${runId}. ` +
                    "Poll get_workflow_status / get_workflow_result. Interrupted runs require trusted /workflow-resume.",
                },
              ],
              details: {
                status: "started",
                workflowId: runId,
                name: plan.name,
                durable: true,
                resumePolicy: "manual",
                revision: started.projection.revision,
                runEpoch: started.projection.runEpoch,
                ownerGeneration: started.projection.owner.ownerGeneration,
                leaseEpoch: started.projection.runEpoch,
              },
            };
          } catch (error) {
            signal?.removeEventListener("abort", forwardAbort);
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Workflow plan not started: ${message}`,
                },
              ],
              details: { status: "error", error: message },
              isError: true,
            };
          }
        }
        const planOpts = (workflowId: string) => ({
          budgetTotal: params.budget ?? null,
          runAgent: makeRunAgent(ctx, workflowId, workflowOwner),
        });

        if (params.async !== false) {
          let job: WorkflowJobState;
          try {
            job = startWorkflowPlanJob(
              plan,
              planOpts,
              Date.now(),
              notifyWorkflowCompletion,
              workflowOwner,
              "async",
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text",
                  text: `Workflow plan not started: ${msg}`,
                },
              ],
              details: { status: "error", error: msg },
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `Workflow "${plan.name}" started in background as ${job.id}. ` +
                  `Poll get_workflow_status / get_workflow_result. ${WORKFLOW_SESSION_SCOPE_MESSAGE}`,
              },
            ],
            details: {
              status: "started",
              workflowId: job.id,
              name: plan.name,
            },
          };
        }

        try {
          const syncPlanState = (planState: WorkflowPlanState) => {
            try {
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `Workflow plan "${plan.name}" [${planState.status}]`,
                  },
                ],
                details: { status: "running", planState },
              });
            } catch {
              /* onUpdate is best-effort */
            }
          };
          const job = startWorkflowPlanJob(
            plan,
            (workflowId) => ({
              ...planOpts(workflowId),
              signal,
              onState: syncPlanState,
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
              planState: job.snapshot.planState,
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
      }

      if (hasPlan) {
        if (params.durable === true) {
          const error =
            "Durable declarative workflows are not available through the legacy workflow tool; use start_durable_workflow.";
          return {
            content: [{ type: "text", text: `Workflow not run: ${error}` }],
            details: { status: "unsupported_durable", error },
            isError: true,
          };
        }
        const plan = params.plan as WorkflowPlan;
        const planOpts = (workflowId: string) => ({
          budgetTotal: params.budget ?? null,
          runAgent: makeRunAgent(ctx, workflowId, workflowOwner),
          concurrency: 4,
        });
        if (params.async !== false) {
          try {
            const job = startWorkflowPlanJob(
              plan,
              planOpts,
              Date.now(),
              notifyWorkflowCompletion,
              workflowOwner,
              "async",
            );
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Workflow "${plan.name}" started in background as ${job.id}. ` +
                    `Poll get_workflow_status / get_workflow_result. ${WORKFLOW_SESSION_SCOPE_MESSAGE}`,
                },
              ],
              details: {
                status: "started",
                workflowId: job.id,
                name: plan.name,
                plan: true,
              },
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: "text", text: `Workflow not started: ${message}` },
              ],
              details: { status: "error", error: message, plan: true },
              isError: true,
            };
          }
        }
        try {
          const job = startWorkflowPlanJob(
            plan,
            {
              ...planOpts("sync"),
              signal,
              onState: (state: WorkflowPlanState) => {
                try {
                  onUpdate?.({
                    content: [
                      { type: "text", text: renderWorkflowPlanProgress(state) },
                    ],
                    details: {
                      status: state.status,
                      planState: state,
                    },
                  });
                } catch {
                  /* progress updates are best-effort */
                }
              },
            },
            Date.now(),
            undefined,
            workflowOwner,
            "sync",
          );
          const run = await job.promise;
          const resultText =
            typeof run.result === "string" ? run.result : stringify(run.result);
          const usage = presentWorkflowUsage(run.usage);
          const summary =
            `Workflow "${run.meta.name}" complete — ` +
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
              name: run.meta.name,
              workflowId: job.id,
              agentsSpawned: run.agentsSpawned,
              errorCount: run.errorCount,
              tokensSpent: run.tokensSpent,
              usage: run.usage,
              budgetTotal: job.snapshot.budgetTotal,
              phases: run.phases,
              plan: true,
            },
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const usage = workflowErrorUsage(error);
          return {
            content: [{ type: "text", text: `Workflow failed: ${message}` }],
            details: {
              status: "error",
              error: message,
              ...(usage ? { usage } : {}),
              plan: true,
            },
            isError: true,
          };
        }
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

      const baseOpts = (workflowId: string) => ({
        args: params.args,
        cwd: ctx.cwd,
        budgetTotal: params.budget ?? null,
        runAgent: makeRunAgent(ctx, workflowId, workflowOwner),
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
        const jobStartedAt = Date.now();
        let job: WorkflowJobState;
        try {
          job = startWorkflowJob(
            meta.name,
            script,
            baseOpts,
            jobStartedAt,
            notifyWorkflowCompletion,
            workflowOwner,
            "async",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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
                `Poll get_workflow_status / get_workflow_result. ${WORKFLOW_SESSION_SCOPE_MESSAGE}`,
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
            ...baseOpts(workflowId),
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
  pi.registerTool({
    name: "get_workflow_status",
    label: "Workflow Status",
    description:
      "Poll a live workflow or restart-safe durable projection (tasks, errors, canonical usage, authority revision, and current phase). Usage icons: ↑ input, ↓ output, R/W cache, $ cost.",
    parameters: Type.Object({
      workflowId: Type.String({
        pattern: WORKFLOW_RUN_ID_PATTERN,
        maxLength: 128,
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const durableController = durableControllerForScope(sessionScope);
      const durableProjection = durableController
        ? await durableController.getStatus(params.workflowId)
        : undefined;
      if (durableProjection) {
        const tasks = Object.values(durableProjection.tasks);
        const running = tasks.filter(
          (task) => task.status === "running",
        ).length;
        const failed = tasks.filter((task) => task.status === "failed").length;
        return {
          content: [
            {
              type: "text",
              text:
                `Durable workflow ${durableProjection.runId} [${durableProjection.status}] — ` +
                `${tasks.length} task(s)` +
                (running > 0 ? `, ${running} running` : "") +
                (failed > 0 ? `, ${failed} failed` : ""),
            },
          ],
          details: {
            ...durableProjection,
            status: durableProjection.status,
            workflowId: durableProjection.runId,
            durable: true,
          },
        };
      }
      const st = getWorkflowJobForOwner(params.workflowId, owner());
      if (!st) {
        try {
          const projection = await getDurableWorkflowProjection(
            params.workflowId,
          );
          if (projection) {
            const details = await durableProjectionDetails(projection);
            const usage = presentWorkflowUsage(projection.usage);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Durable workflow ${projection.runId} [${projection.status}] — ` +
                    `${details.agentsSpawned} task(s), ${details.runningCount} running, ` +
                    `${details.errorCount} error(s)` +
                    (usage ? `, ${formatWorkflowUsage(usage)}` : "") +
                    (projection.currentPhase
                      ? `, phase: ${projection.currentPhase}`
                      : ""),
                },
              ],
              details,
            };
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `Workflow status unavailable: ${message}`,
              },
            ],
            details: {
              status: "error",
              workflowId: params.workflowId,
              error: message,
            },
            isError: true,
          };
        }
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
  pi.registerTool({
    name: "get_workflow_result",
    label: "Workflow Result",
    description:
      "Wait for a live background workflow, or return the committed durable result/projection after restart.",
    parameters: Type.Object({
      workflowId: Type.String({
        pattern: WORKFLOW_RUN_ID_PATTERN,
        maxLength: 128,
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(
      _id: string,
      params: any,
      signal?: AbortSignal,
    ): Promise<any> {
      // Query durable authority first. A stale live Promise must never mask a
      // terminal projection recovered after registry loss.
      const durableProjection = sessionScope
        ? await durableControllerForScope(sessionScope)?.getStatus(
            params.workflowId,
          )
        : undefined;
      const st = durableProjection
        ? undefined
        : getWorkflowJobForOwner(params.workflowId, owner());
      if (!st) {
        const controller = durableControllerForScope(sessionScope);
        if (controller) {
          const projection = await controller.getStatus(params.workflowId);
          if (projection) {
            const terminal = projection.terminal;
            if (terminal) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Durable workflow ${projection.runId} ${projection.status}.`,
                  },
                ],
                details: {
                  status: projection.status,
                  workflowId: projection.runId,
                  result: terminal.result,
                  error: terminal.error,
                  usage: projection.usage,
                  durable: true,
                },
                isError: terminal.status === "error",
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Durable workflow ${projection.runId} is still ${projection.status}.`,
                },
              ],
              details: {
                status: projection.status,
                workflowId: projection.runId,
                durable: true,
              },
              isError: true,
            };
          }
        }
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
  pi.registerTool({
    name: "cancel_workflow",
    label: "Cancel Workflow",
    description:
      "Cancel a live background workflow or idempotently commit cancellation to a durable projection.",
    parameters: Type.Object({
      workflowId: Type.String({
        pattern: WORKFLOW_RUN_ID_PATTERN,
        maxLength: 128,
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const durableController = durableControllerForScope(sessionScope);
      const durableProjection = durableController
        ? await durableController.getStatus(params.workflowId)
        : undefined;
      if (durableProjection) {
        const updated = await durableController?.cancel(params.workflowId);
        const status = updated?.status ?? durableProjection.status;
        return {
          content: [
            {
              type: "text",
              text: `Durable workflow ${params.workflowId} ${status}.`,
            },
          ],
          details: {
            ...(updated ?? durableProjection),
            status,
            workflowId: params.workflowId,
            durable: true,
            cancelled: status === "cancelled",
          },
        };
      }
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

        const controller = invocation.controller;
        if (!controller) {
          if (sessionScope) {
            throw new Error("durable workflow storage is unavailable");
          }
          return {
            content: [
              {
                type: "text",
                text: workflowNotFoundMessage(params.workflowId),
              },
            ],
            details: { status: "not_found", workflowId: params.workflowId },
            isError: true,
          };
        }
        const projection = await controller.getStatus(params.workflowId);
        if (!projection) {
          return {
            content: [
              {
                type: "text",
                text: workflowNotFoundMessage(params.workflowId),
              },
            ],
            details: { status: "not_found", workflowId: params.workflowId },
            isError: true,
          };
        }
        if (projection.terminal) {
          const alreadyCancelled = projection.terminal.status === "cancelled";
          return {
            content: [
              {
                type: "text",
                text: alreadyCancelled
                  ? `Workflow ${projection.runId} is already cancelled.`
                  : `Workflow ${projection.runId} is already ${projection.terminal.status}; nothing was cancelled.`,
              },
            ],
            details: {
              ...(await durableProjectionDetails(
                projection,
                projection.runEpoch,
              )),
              cancelled: alreadyCancelled,
            },
          };
        }

        assertWorkflowCancellationAuthority(invocation, ctx);
        const cancelled = await controller.cancel(
          projection.runId,
          undefined,
          async () => {
            const live = getDurableWorkflowLiveJobForOwner(
              projection.runId,
              invocation.sessionOwner,
            );
            if (live) await interruptAndDrainDurableWorkflowJob(live);
          },
          () => assertWorkflowCancellationAuthority(invocation, ctx),
        );
        if (!cancelled) {
          throw new Error("durable workflow disappeared during cancellation");
        }
        const cancellationCommitted =
          cancelled.terminal?.status === "cancelled";
        if (!cancelled.terminal) {
          throw new Error("durable workflow cancellation did not terminalize");
        }
        return {
          content: [
            {
              type: "text",
              text: cancellationCommitted
                ? `Workflow ${cancelled.runId} cancelled.`
                : `Workflow ${cancelled.runId} is already ${cancelled.terminal.status}; nothing was cancelled.`,
            },
          ],
          details: {
            ...(await durableProjectionDetails(cancelled, cancelled.runEpoch)),
            cancelled: cancellationCommitted,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Workflow cancellation failed: ${message}`,
            },
          ],
          details: {
            status: "error",
            workflowId: params.workflowId,
            error: message,
          },
          isError: true,
        };
      }
    },
  });

  // ── save_workflow ──
  pi.registerTool({
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
  pi.registerTool({
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
  pi.registerTool({
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
          runAgent: makeRunAgent(ctx, workflowId, workflowOwner),
          loadWorkflow: (n: string) => loadWorkflowScript(n),
        }),
        Date.now(),
        notifyWorkflowCompletion,
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

    const durableOperatorScope = (
      ctx: ExtensionCommandContext,
    ): SessionScope | undefined => {
      const workflowOwner = owner();
      if (
        !sessionScope ||
        !workflowOwner ||
        !isSessionOwnerLive(workflowOwner)
      ) {
        const text =
          "Durable workflow commands are available only in the live parent session.";
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return undefined;
      }
      return sessionScope;
    };

    const parseDurableAuthority = (
      raw: string,
      expectedLength: { min: number; max: number },
      usage: string,
    ): {
      runId: string;
      expectedRevision: number;
      ownerGeneration: number;
      leaseEpoch: number;
      sessionGeneration: number;
      rest: string[];
    } => {
      const parts = raw.trim().split(/\s+/);
      if (
        parts.length < expectedLength.min ||
        parts.length > expectedLength.max
      ) {
        throw new Error(`Usage: ${usage}`);
      }
      const [
        runId,
        revisionText,
        ownerGenerationText,
        leaseEpochText,
        sessionGenerationText,
        ...rest
      ] = parts;
      const values = [
        revisionText,
        ownerGenerationText,
        leaseEpochText,
        sessionGenerationText,
      ].map(Number);
      if (
        !runId ||
        values.some((value) => !Number.isSafeInteger(value) || value < 0)
      ) {
        throw new Error(`Usage: ${usage}`);
      }
      return {
        runId,
        expectedRevision: values[0],
        ownerGeneration: values[1],
        leaseEpoch: values[2],
        sessionGeneration: values[3],
        rest,
      };
    };

    const assertDurableAuthority = async (
      scope: SessionScope,
      envelope: ReturnType<typeof parseDurableAuthority>,
      expectedRevision?: number,
    ): Promise<{ controller: any; projection: any }> => {
      const workflowOwner = owner();
      const controller = durableWorkflowControllerForSession(
        process.cwd(),
        scope,
      );
      if (!workflowOwner || !controller) {
        throw new Error("Durable workflow storage is unavailable.");
      }
      const store = durableWorkflowStoreForSession(process.cwd(), scope);
      if (!store) throw new Error("Durable workflow storage is unavailable.");
      const currentEpoch = await store.getLeaseEpoch();
      if (
        envelope.ownerGeneration !== workflowOwner.generation ||
        envelope.leaseEpoch !== currentEpoch ||
        envelope.sessionGeneration !== scope.generation
      ) {
        throw new Error("Durable workflow authority envelope is stale.");
      }
      const projection = await controller.getStatus(envelope.runId);
      if (!projection) throw new Error("Durable workflow run was not found.");
      if (
        expectedRevision !== undefined &&
        projection.revision !== expectedRevision
      ) {
        throw new Error(
          `Workflow plan revision is stale: expected ${expectedRevision}, current ${projection.revision}`,
        );
      }
      return { controller, projection } as any;
    };

    const handleDurableWorkflowResume = async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const scope = durableOperatorScope(ctx);
      if (!scope) return;
      const usage =
        "/workflow-resume <runId> <expectedRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration>";
      try {
        const envelope = parseDurableAuthority(args, { min: 5, max: 5 }, usage);
        const { controller } = await assertDurableAuthority(
          scope,
          envelope,
          envelope.expectedRevision,
        );
        const result = await resumeDurableWorkflowForSession(
          process.cwd(),
          scope,
          {
            runId: envelope.runId,
            runAgent: makeRunAgent(ctx, envelope.runId, owner()),
          },
        );
        if (
          result.terminal &&
          (result.delivery?.status === "pending" ||
            result.delivery?.status === "dispatched")
        ) {
          await controller.dispatchDelivery(
            result.runId,
            result.delivery.deliveryId,
          );
        }
        const text = `Resumed durable workflow ${result.runId}: ${result.status}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = `Durable workflow resume failed: ${message}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    };

    const handleDurableWorkflowCancel = async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const scope = durableOperatorScope(ctx);
      if (!scope) return;
      const usage =
        "/workflow-cancel <runId> <expectedRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration> [reason]";
      try {
        const envelope = parseDurableAuthority(args, { min: 5, max: 6 }, usage);
        const { controller } = await assertDurableAuthority(
          scope,
          envelope,
          envelope.expectedRevision,
        );
        const result = await controller.cancel(envelope.runId, randomUUID());
        const delivered = result
          ? await dispatchTerminalDeliveryForSession(
              process.cwd(),
              scope,
              result,
            )
          : result;
        const text = delivered
          ? `Cancelled durable workflow ${envelope.runId}: ${delivered.status}`
          : `Durable workflow ${envelope.runId} was not found.`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = `Durable workflow cancellation failed: ${message}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    };

    const handleDurableWorkflowApproval = async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const scope = durableOperatorScope(ctx);
      if (!scope) return;
      const usage =
        "/workflow-approval <runId> <requestId> <approve|reject> <policyHash> <planRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration> <version> [reason]";
      try {
        const parts = args.trim().split(/\s+/);
        if (parts.length < 9 || parts.length > 10)
          throw new Error(`Usage: ${usage}`);
        const [
          runId,
          requestId,
          operation,
          policyHash,
          planRevisionText,
          ownerGenerationText,
          leaseEpochText,
          sessionGenerationText,
          versionText,
          ...reasonParts
        ] = parts;
        if (!runId || !requestId || !["approve", "reject"].includes(operation))
          throw new Error(`Usage: ${usage}`);
        const numbers = [
          planRevisionText,
          ownerGenerationText,
          leaseEpochText,
          sessionGenerationText,
          versionText,
        ].map(Number);
        if (
          !policyHash ||
          numbers.some((value) => !Number.isSafeInteger(value) || value < 0)
        )
          throw new Error(`Usage: ${usage}`);
        const [
          planRevision,
          ownerGeneration,
          leaseEpoch,
          sessionGeneration,
          version,
        ] = numbers;
        const authority = {
          runId,
          expectedRevision: planRevision,
          ownerGeneration,
          leaseEpoch,
          sessionGeneration,
          rest: [],
        };
        const { controller, projection } = await assertDurableAuthority(
          scope,
          authority,
        );
        const binding = projection.approval?.request;
        if (
          !binding ||
          binding.requestId !== requestId ||
          binding.policyHash !== policyHash ||
          binding.planRevision !== planRevision ||
          binding.ownerGeneration !== ownerGeneration ||
          binding.leaseEpoch !== leaseEpoch ||
          binding.version !== version
        ) {
          throw new Error("Workflow approval authority envelope is stale.");
        }
        const updated = await controller.decideApproval(runId, requestId, {
          requestId,
          status: operation === "approve" ? "approved" : "rejected",
          decidedBy: String(owner()?.id ?? "operator"),
          policyHash,
          planRevision,
          ownerGeneration,
          leaseEpoch,
          version,
          ...(reasonParts.length > 0 ? { reason: reasonParts.join(" ") } : {}),
        });
        const text = `${operation === "approve" ? "Approved" : "Rejected"} durable workflow approval ${requestId} for ${runId} (status ${updated?.approval?.status ?? "unknown"}).`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = `Durable workflow approval failed: ${message}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    };

    const handleDurablePlanAppend = async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const scope = durableOperatorScope(ctx);
      if (!scope) return;
      const usage =
        "/workflow-plan-append <runId> <expectedRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration> <taskId> <phaseId> <prompt>";
      try {
        const envelope = parseDurableAuthority(
          args,
          { min: 8, max: 512 },
          usage,
        );
        if (envelope.rest.length < 3) throw new Error(`Usage: ${usage}`);
        const { controller, projection } = await assertDurableAuthority(
          scope,
          envelope,
          envelope.expectedRevision,
        );
        const [taskId, phaseId, ...promptParts] = envelope.rest;
        const updated = await controller.mutateTask(envelope.runId, {
          type: "append",
          taskId,
          phaseId,
          prompt: promptParts.join(" "),
          expectedRevision: envelope.expectedRevision,
        });
        const text = `Appended ${taskId} to durable workflow ${envelope.runId} (revision ${updated?.revision ?? projection.revision}).`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = `Durable workflow append failed: ${message}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    };

    const handleDurablePlanMutate = async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const scope = durableOperatorScope(ctx);
      if (!scope) return;
      const usage =
        "/workflow-plan-mutate <runId> <expectedRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration> <block|unblock|skip> <taskId>";
      try {
        const envelope = parseDurableAuthority(args, { min: 7, max: 7 }, usage);
        const [operation, taskId] = envelope.rest;
        if (
          !operation ||
          !taskId ||
          !["block", "unblock", "skip"].includes(operation)
        ) {
          throw new Error(`Usage: ${usage}`);
        }
        const { controller, projection } = await assertDurableAuthority(
          scope,
          envelope,
          envelope.expectedRevision,
        );
        const updated = await controller.mutateTask(envelope.runId, {
          type: operation as "block" | "unblock" | "skip",
          taskId,
          expectedRevision: envelope.expectedRevision,
        });
        const text = `${operation}d ${taskId} in durable workflow ${envelope.runId} (revision ${updated?.revision ?? projection.revision}).`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = `Durable workflow mutation failed: ${message}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    };

    const handleDurablePlanEdit = async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const scope = durableOperatorScope(ctx);
      if (!scope) return;
      const usage =
        "/workflow-plan-edit <runId> <expectedRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration> <append <taskId> <phaseId> <prompt>|block|unblock|skip <taskId>>";
      try {
        const envelope = parseDurableAuthority(
          args,
          { min: 7, max: 512 },
          usage,
        );
        const [operation, taskId, phaseId, ...promptParts] = envelope.rest;
        const isAppend = operation === "append";
        const valid = isAppend
          ? Boolean(taskId && phaseId && promptParts.length > 0)
          : Boolean(
              taskId &&
              envelope.rest.length === 2 &&
              ["block", "unblock", "skip"].includes(operation),
            );
        if (!valid) throw new Error(`Usage: ${usage}`);
        const { controller, projection } = await assertDurableAuthority(
          scope,
          envelope,
          envelope.expectedRevision,
        );
        const mutation = isAppend
          ? {
              type: "append" as const,
              taskId,
              phaseId,
              prompt: promptParts.join(" "),
              expectedRevision: envelope.expectedRevision,
            }
          : {
              type: operation as "block" | "unblock" | "skip",
              taskId,
              expectedRevision: envelope.expectedRevision,
            };
        const updated = await controller.mutateTask(envelope.runId, mutation);
        const text = `${operation}d ${taskId} in durable workflow ${envelope.runId} (revision ${updated?.revision ?? projection.revision}).`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = `Durable workflow edit failed: ${message}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    };

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
        "List live and restart-safe durable workflow jobs with status, task/agent counts, usage, and resume authority.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const text = await renderWorkflowJobs(owner(), sessionScope);
        ctx.ui.notify("📋 Workflow status listed.");
        sendCommandMessage(text);
      },
    });

    pi.registerCommand("workflow-resume", {
      description:
        "Resume a durable workflow from its persisted declarative plan using an authority envelope.",
      handler: handleDurableWorkflowResume,
    });

    pi.registerCommand("workflow-cancel", {
      description:
        "Request authoritative cancellation of a durable workflow using an authority envelope.",
      handler: handleDurableWorkflowCancel,
    });

    pi.registerCommand("workflow-approval", {
      description:
        "Approve or reject a pending durable workflow request using an authority envelope.",
      handler: handleDurableWorkflowApproval,
    });

    pi.registerCommand("workflow-plan", {
      description: "Create or view a durable workflow projection.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const input = args.trim();
        if (input.startsWith("create ")) {
          const task = input.slice("create ".length).trim();
          const runId = `durable-${randomUUID()}`;
          if (!task) {
            ctx.ui.notify("Usage: /workflow-plan create <task>");
            return;
          }
          const durableRoot = durableWorkflowRootForScope(sessionScope);
          if (!sessionScope || !durableRoot) {
            ctx.ui.notify("Durable workflow storage is unavailable.");
            return;
          }
          try {
            const result = await runDurableWorkflowForSession(
              durableRoot,
              sessionScope,
              {
                runId,
                plan: {
                  schemaVersion: 1,
                  name: "host-plan",
                  phases: [
                    {
                      id: "phase-1",
                      mode: "sequential",
                      tasks: [
                        {
                          id: "task-1",
                          prompt: task,
                          isolation: "in-process",
                        },
                      ],
                    },
                  ],
                },
                runAgent: makeRunAgent(ctx, runId, owner()),
              },
            );
            const text = `Created durable workflow ${result.runId}: ${result.status}`;
            ctx.ui.notify(text);
            sendCommandMessage(text);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            const text = `Durable workflow not started: ${message}`;
            ctx.ui.notify(text);
            sendCommandMessage(text);
          }
          return;
        }
        const runId = input;
        const controller = durableControllerForScope(sessionScope);
        if (!controller || !runId) {
          const text = !runId
            ? "Usage: /workflow-plan <runId>"
            : "Durable workflow storage is unavailable.";
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        const projection = await controller.getStatus(runId);
        const text = projection
          ? [
              `Durable workflow ${runId}: ${projection.status} (revision ${projection.revision})`,
              `Phase: ${projection.currentPhase ?? "none"}`,
              `Tasks: ${Object.values(projection.tasks)
                .map((task) => `${task.id}=${task.status}`)
                .join(", ")}`,
              projection.terminal
                ? `Terminal: ${JSON.stringify(projection.terminal)}`
                : "Terminal: none",
            ].join("\n")
          : `Durable workflow ${runId} was not found.`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      },
    });

    pi.registerCommand("workflow-plan-append", {
      description:
        "Append one future task to a durable workflow using an authority envelope.",
      handler: handleDurablePlanAppend,
    });

    pi.registerCommand("workflow-plan-mutate", {
      description:
        "Block, unblock, or skip future durable workflow work using an authority envelope.",
      handler: handleDurablePlanMutate,
    });

    pi.registerCommand("workflow-plan-edit", {
      description:
        "Edit future durable workflow work using an authority envelope and revision fence.",
      handler: handleDurablePlanEdit,
    });

    pi.registerCommand("workflow-plan-export", {
      description: "Export a durable workflow projection as JSON.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const runId = args.trim();
        const controller = durableControllerForScope(sessionScope);
        if (!controller || !runId) {
          const text = !runId
            ? "Usage: /workflow-plan-export <runId>"
            : "Durable workflow storage is unavailable.";
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        const projection = await controller.getStatus(runId);
        const text = projection
          ? JSON.stringify(projection, null, 2)
          : `Durable workflow ${runId} was not found.`;
        ctx.ui.notify(
          projection ? `Exported durable workflow ${runId}.` : text,
        );
        sendCommandMessage(text);
      },
    });

    pi.registerCommand("workflow-budget", {
      description:
        "Pause or resume a durable workflow budget gate using an authority envelope.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const scope = durableOperatorScope(ctx);
        if (!scope) return;
        const usage =
          "/workflow-budget <runId> <pause|resume> <expectedRevision> <ownerGeneration> <leaseEpoch> <sessionGeneration> [reason]";
        try {
          const parts = args.trim().split(/\s+/);
          if (parts.length < 6 || parts.length > 7)
            throw new Error(`Usage: ${usage}`);
          const [
            runId,
            operation,
            revisionText,
            ownerText,
            epochText,
            sessionText,
            ...reasonParts
          ] = parts;
          const numbers = [revisionText, ownerText, epochText, sessionText].map(
            Number,
          );
          if (
            !runId ||
            !["pause", "resume"].includes(operation) ||
            numbers.some((value) => !Number.isSafeInteger(value) || value < 0)
          ) {
            throw new Error(`Usage: ${usage}`);
          }
          const envelope = {
            runId,
            expectedRevision: numbers[0],
            ownerGeneration: numbers[1],
            leaseEpoch: numbers[2],
            sessionGeneration: numbers[3],
            rest: reasonParts,
          };
          const { controller } = await assertDurableAuthority(
            scope,
            envelope,
            envelope.expectedRevision,
          );
          const updated =
            operation === "pause"
              ? await controller.pauseForBudget(
                  runId,
                  reasonParts.length > 0 ? reasonParts.join(" ") : undefined,
                )
              : await controller.resumeFromBudget(runId);
          const text = `Durable workflow ${runId} budget ${operation}d (status ${updated?.status ?? "unknown"}).`;
          ctx.ui.notify(text);
          sendCommandMessage(text);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const text = `Durable workflow budget update failed: ${message}`;
          ctx.ui.notify(text);
          sendCommandMessage(text);
        }
      },
    });

    pi.registerCommand("workflow-retention", {
      description: "Prune old terminal durable workflow runs.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const [olderThanText, maxRunsText] = args.trim().split(/\s+/);
        const olderThanMs = Number(olderThanText);
        const maxRuns =
          maxRunsText === undefined ? undefined : Number(maxRunsText);
        const store = durableStoreForScope(sessionScope);
        if (
          !store ||
          !Number.isSafeInteger(olderThanMs) ||
          olderThanMs < 0 ||
          (maxRuns !== undefined &&
            (!Number.isSafeInteger(maxRuns) || maxRuns < 0))
        ) {
          const text = "Usage: /workflow-retention <olderThanMs> [maxRuns]";
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        const result = await store.pruneTerminalRuns({
          olderThanMs,
          maxRuns,
        });
        const text = `Pruned ${result.length} terminal durable workflow run(s).`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      },
    });

    pi.registerCommand("workflow-route", {
      description: "Evaluate opt-in complex-task workflow routing.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const [modeText, ...taskParts] = args.trim().split(/\s+/);
        try {
          const mode = parseWorkflowEagerMode(modeText);
          const task = taskParts.join(" ");
          const decision = decideWorkflowRouting({ mode, text: task });
          const observation =
            decision.kind === "durable_plan"
              ? " routing_unconfirmed: inspection does not start a run."
              : "";
          const text = `Routing decision: ${decision.kind} (${decision.reason}).${observation}`;
          ctx.ui.notify(text);
          sendCommandMessage(text);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(text);
          sendCommandMessage(text);
        }
      },
    });

    pi.registerCommand("workflow-tree", {
      description:
        "Open an interactive workflow tree with expand/collapse and cancel controls.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const controller = durableControllerForScope(sessionScope);
        const store = durableStoreForScope(sessionScope);
        const action = await showWorkflowTree(ctx.ui, owner(), {
          listDurable: async () => {
            if (!controller || !store) return [];
            const ids = await store.listRunIds();
            const projections = await Promise.all(
              ids.map((runId) => controller.getStatus(runId)),
            );
            return projections.filter(
              (projection): projection is WorkflowProjection =>
                projection !== undefined,
            );
          },
          cancelDurable: (workflowId) =>
            controller?.cancel(workflowId) ?? Promise.resolve(undefined),
        });
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

  async function renderWorkflowJobs(
    owner: SessionOwnerToken | undefined,
    scope?: SessionScope,
  ): Promise<string> {
    const lines: string[] = [];
    const now = Date.now();
    let count = 0;
    const durableController = durableControllerForScope(scope);
    const durableStore = durableStoreForScope(scope);
    const durableProjections: WorkflowProjection[] = [];
    if (durableController && durableStore) {
      const ids = await durableStore.listRunIds();
      const projections = await Promise.all(
        ids.map((runId) => durableController.getStatus(runId)),
      );
      for (const projection of projections) {
        if (projection) durableProjections.push(projection);
      }
    }
    const durableIds = new Set(
      durableProjections.map((projection) => projection.runId),
    );
    for (const st of workflowJobsForOwner(owner)) {
      if (durableIds.has(st.id)) continue;
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
    for (const projection of durableProjections) {
      count++;
      const tasks = Object.values(projection.tasks);
      const running = tasks.filter((task) => task.status === "running").length;
      const failed = tasks.filter((task) => task.status === "failed").length;
      const parts = [
        `**${projection.runId}** (${projection.runId}) [durable:${projection.status}]`,
        `${tasks.length} task(s)`,
      ];
      if (running > 0) parts.push(`⚡ ${running} running`);
      if (failed > 0) parts.push(`⚠ ${failed} failed`);
      if (projection.currentPhase)
        parts.push(`phase: ${projection.currentPhase}`);
      if (projection.terminal?.error)
        parts.push(`error: ${projection.terminal.error.message}`);
      lines.push(`- ${parts.join(" · ")}`);
    }
    return count === 0
      ? "No workflow jobs."
      : `**Workflow jobs (${count})**\n` + lines.join("\n");
  }

  function renderDurableWorkflowJobs(
    projections: readonly WorkflowProjection[],
    leaseEpoch: number | undefined,
  ): string {
    if (projections.length === 0) return "";
    const lines = projections.map((projection) => {
      const tasks = Object.values(projection.tasks);
      const parts = [
        `**durable** (${projection.runId}) [${projection.status}]`,
        `${tasks.length} task(s)`,
        `revision ${projection.revision}`,
        `epoch ${projection.runEpoch}`,
      ];
      const running = tasks.filter((task) => task.status === "running").length;
      const failed = tasks.filter((task) => task.status === "failed").length;
      if (running > 0) parts.push(`⚡ ${running} running`);
      if (failed > 0) parts.push(`⚠ ${failed} error(s)`);
      if (projection.currentPhase) {
        parts.push(`phase: ${projection.currentPhase}`);
      }
      const ownerGeneration =
        sessionScope?.durableWorkflowOwner?.ownerGeneration;
      if (
        projection.status === "interrupted" &&
        leaseEpoch !== undefined &&
        ownerGeneration !== undefined
      ) {
        parts.push(
          `resume: /workflow-resume ${projection.runId} ${projection.revision} ${ownerGeneration} ${leaseEpoch}`,
        );
      }
      return `- ${parts.join(" · ")}`;
    });
    return `**Durable workflow jobs (${projections.length})**\n${lines.join("\n")}`;
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

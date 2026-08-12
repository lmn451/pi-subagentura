import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { abortableWait } from "./abortable-wait";
import {
  debugLog,
  registerInProcessJob,
  resolveModel,
  removeInProcessJob,
  startSubagentJob,
  type JobState,
} from "./helpers";
import {
  adoptWorkflowProcessSubagent,
  dispatchPreparedInteractiveSubagent,
  fenceWorkflowProcessPaneAssignment,
  getWorkflowProcessPaneLiveness,
  launchInteractiveSubagent,
  recoverWorkflowProcessPaneAssignment,
  registerInteractiveSubagentState,
  workflowProcessPaneAssignmentForState,
  type InteractiveSubagentState,
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
  type WorkflowRunResultWithUsage,
  type WorkflowUsage,
  formatWorkflowUsage,
  presentWorkflowUsage,
  workflowUsageFromUsage,
} from "./workflow-core";
import {
  getWorkflowCompletionPresentation,
  getWorkflowJobForOwner,
  normalizeCancelledWorkflowState,
  startDurableWorkflowPlanJob,
  startDurableWorkflowScriptJob,
  startWorkflowJob,
  startWorkflowPlanJob,
  workflowJobsForOwner,
  type WorkflowJobState,
  type WorkflowPlanJobState,
} from "./workflow-jobs";
import {
  getDurableWorkflowPlanController,
  registerDurableWorkflowRunAgentFactory,
} from "./workflow-durable-runtime";
import type { DurableWorkflowPlanController } from "./workflow-durable-plan";
import type { DurableWorkflowProjection } from "./workflow-projection-repository";
import type { WorkflowPlanRunResult } from "./workflow-plan-runner";
import {
  isDurableWorkflowRunId,
  type DurableWorkflowRunId,
} from "./workflow-run-types";
import { pendingWorkflowApproval } from "./workflow-approvals";
import {
  readWorkflowProcessTerminalEvidence,
  waitForWorkflowProcessChildStarted,
  WorkflowProcessAttemptFenceIncompleteError,
  WorkflowProcessAttemptFencedError,
} from "./workflow-process-attempt";
import { renderProgress } from "./workflow-ui";
import {
  formatWorkflowPlanRows,
  formatWorkflowPlanSummary,
  sanitizeTerminalText,
  type WorkflowPlanRow,
} from "./workflow-plan-ui";
import { awaitInteractiveResult, stringify } from "./workflow-worker";
import { sanitizeOutput } from "./notifications";
import { registerWorkflowPlanMutationTool } from "./workflow-plan-tool";
import {
  showWorkflowTree,
  type WorkflowTrustedResumeSnapshot,
} from "./workflow-tree-ui";
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
  resolveLiveSessionScope,
  sessionIdForOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import { attachAsyncJobSettlement } from "./tools/in-process";

const WORKFLOW_SESSION_SCOPE_MESSAGE =
  "Workflow jobs are scoped to the current parent session and do not survive reload/resume/new/quit.";
const DURABLE_WORKFLOW_MESSAGE =
  "This durable sequential plan remains queryable after reload or resume.";
const MAX_DURABLE_PLAN_ROWS = 512;

function workflowNotFoundMessage(workflowId: string): string {
  if (!isDurableWorkflowRunId(workflowId)) {
    return (
      `Workflow ${workflowId} not found in the current parent session. ` +
      "It may have been created in another session or removed by reload/resume/new/quit."
    );
  }
  return (
    `Workflow ${workflowId} not found for the current durable owner. ` +
    "It may belong to another cwd/session or may never have existed."
  );
}

const CANCELLATION_RECEIPT_GRACE_MS = INTERACTIVE_POLL_MS + 250;

const WORKFLOW_PLAN_AGENT_SCHEMA = Type.Object(
  {
    schema: Type.Optional(Type.Unknown()),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    phase: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    persona: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    isolation: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    agentType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
  },
  { additionalProperties: false },
);

const WORKFLOW_PLAN_SCHEMA = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    description: Type.String({ minLength: 1, maxLength: 4096 }),
    phases: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 256 }),
          name: Type.String({ minLength: 1, maxLength: 256 }),
          mode: Type.Union([
            Type.Literal("sequence"),
            Type.Literal("parallel"),
          ]),
          tasks: Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: 256 }),
                content: Type.String({ minLength: 1, maxLength: 256 }),
                instruction: Type.String({
                  minLength: 1,
                  maxLength: 16_384,
                }),
                agent: Type.Optional(WORKFLOW_PLAN_AGENT_SCHEMA),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 256 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

interface BoundedWorkflowPlanProjection {
  summary: string;
  rows: WorkflowPlanRow[];
}

function boundedWorkflowPlanProjection(
  job: WorkflowJobState,
): BoundedWorkflowPlanProjection | undefined {
  if (!job.planProjection) return undefined;
  return {
    summary: formatWorkflowPlanSummary(job.planProjection),
    rows: formatWorkflowPlanRows(job.planProjection),
  };
}

function boundedDurablePlanProjection(
  projection: DurableWorkflowProjection,
): BoundedWorkflowPlanProjection {
  const statusCounts = {
    pending: 0,
    running: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const task of projection.tasks) statusCounts[task.status]++;
  const completed = projection.tasks.filter((task) =>
    ["succeeded", "failed", "skipped", "cancelled"].includes(task.status),
  ).length;
  const counts = Object.entries(statusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  const visible = projection.tasks.slice(0, MAX_DURABLE_PLAN_ROWS);
  const rows: WorkflowPlanRow[] = visible.map((task) => ({
    depth: 1,
    text: `- ${task.taskId} [${task.status}]`,
    taskId: task.taskId,
    status: task.status,
  }));
  if (visible.length !== projection.tasks.length) {
    rows.push({
      depth: 0,
      text: `… ${projection.tasks.length - visible.length} task row(s) omitted`,
    });
  }
  return {
    summary:
      `durable plan status: ${projection.status}; ` +
      `${completed}/${projection.tasks.length} complete` +
      (counts.length === 0 ? "" : `; ${counts}`),
    rows,
  };
}
function durableWorkflowAction(
  status: DurableWorkflowProjection["status"],
): string | undefined {
  if (status === "interrupted") {
    return "Use the trusted Resume action to continue from committed evidence.";
  }
  if (status === "blocked") {
    return "Resolve the blocked task, then use the trusted workflow action to continue.";
  }
  if (status === "awaiting_budget") {
    return "Approve or deny the pending budget request from a trusted workflow action.";
  }
  return undefined;
}

interface DurableWorkflowLookup {
  readonly controller: DurableWorkflowPlanController;
  readonly projection: DurableWorkflowProjection;
  readonly runId: DurableWorkflowRunId;
}

async function findDurableWorkflow(
  sessionScope: SessionScope | undefined,
  workflowId: string,
): Promise<DurableWorkflowLookup | undefined> {
  if (sessionScope === undefined || !isDurableWorkflowRunId(workflowId)) {
    return undefined;
  }
  const controller = getDurableWorkflowPlanController(sessionScope);
  if (controller === undefined) return undefined;
  const projection = await controller.getProjection(workflowId);
  return projection === undefined
    ? undefined
    : { controller, projection, runId: workflowId };
}

function requiredDurableController(
  sessionScope: SessionScope | undefined,
): DurableWorkflowPlanController {
  if (sessionScope === undefined) {
    throw new Error(
      "Durable workflow execution requires a live session scope.",
    );
  }
  const controller = getDurableWorkflowPlanController(sessionScope);
  if (controller === undefined) {
    throw new Error(
      "Durable workflow session is not initialized for this cwd/session.",
    );
  }
  return controller;
}

function isWorkflowPlanRunResult(
  value: unknown,
): value is WorkflowPlanRunResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "meta" in value &&
    typeof value.meta === "object" &&
    value.meta !== null &&
    "status" in value &&
    ["done", "error", "cancelled", "blocked", "running"].includes(
      String(value.status),
    ) &&
    "result" in value &&
    Array.isArray(value.result) &&
    "usage" in value &&
    typeof value.usage === "object" &&
    value.usage !== null &&
    "agentsSpawned" in value &&
    Number.isSafeInteger(value.agentsSpawned) &&
    "errorCount" in value &&
    Number.isSafeInteger(value.errorCount)
  );
}

function isWorkflowRunResultWithUsage(
  value: unknown,
): value is WorkflowRunResultWithUsage {
  return (
    typeof value === "object" &&
    value !== null &&
    "meta" in value &&
    typeof value.meta === "object" &&
    value.meta !== null &&
    "result" in value &&
    "usage" in value &&
    typeof value.usage === "object" &&
    value.usage !== null &&
    "phases" in value &&
    Array.isArray(value.phases) &&
    "agentsSpawned" in value &&
    Number.isSafeInteger(value.agentsSpawned) &&
    "errorCount" in value &&
    Number.isSafeInteger(value.errorCount) &&
    "tokensSpent" in value &&
    Number.isSafeInteger(value.tokensSpent)
  );
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
  registerWorkflowPlanMutationTool(pi, sessionScope);
  const owner = (): SessionOwnerToken | undefined =>
    sessionScope
      ? { id: sessionScope.id, generation: sessionScope.generation }
      : getActiveSessionOwner();
  if (sessionScope) {
    registerDurableWorkflowRunAgentFactory(
      sessionScope,
      (runId, context) =>
        makeRunAgent(context, runId, {
          id: sessionScope.id,
          generation: sessionScope.generation,
        }),
      {
        delivery: {
          dispatch: (message) => {
            pi.sendMessage!(message, {
              deliverAs: "followUp",
              triggerTurn: true,
            });
          },
        },
      },
    );
  }
  // Build the real spawn function from the tool ctx. Switches backend on `isolation`.
  function makeRunAgent(
    ctx: any,
    ownedWorkflowId: string,
    supervisorOwner: SessionOwnerToken | undefined,
  ): WorkflowAgentRunner {
    const runner: WorkflowAgentRunner = async ({
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
      workflowProcessAttempt,
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
        let state: InteractiveSubagentState | undefined;
        const childScope = resolveLiveSessionScope(supervisorOwner);
        const parentSessionId = sessionIdForOwner(supervisorOwner);
        let durableAssignment = workflowProcessAttempt?.assignment;
        let durableTerminalPersisted =
          workflowProcessAttempt?.terminalPersisted ?? false;
        let durableChildStartedPersisted =
          workflowProcessAttempt?.childStartedPersisted ?? false;
        try {
          if (workflowProcessAttempt?.mode === "adopt") {
            durableAssignment = recoverWorkflowProcessPaneAssignment(
              workflowProcessAttempt.manifest,
              ctx.cwd,
              durableAssignment,
            );
            if (durableAssignment === undefined) {
              await workflowProcessAttempt.fenced(
                "orphan_before_assignment",
                undefined,
                0,
              );
              throw new WorkflowProcessAttemptFencedError(
                "Prepared workflow process pane was absent during recovery.",
              );
            }
            if (!workflowProcessAttempt.launchDispatchedPersisted) {
              fenceWorkflowProcessPaneAssignment(durableAssignment);
              await workflowProcessAttempt.fenced(
                "orphan_before_assignment",
                durableAssignment,
                0,
              );
              throw new WorkflowProcessAttemptFencedError(
                "Undispatched workflow process pane was fenced.",
              );
            }
            if (!durableChildStartedPersisted) {
              try {
                const started = await waitForWorkflowProcessChildStarted(
                  durableAssignment.artifactDir,
                  workflowProcessAttempt.manifest,
                  signal,
                  250,
                );
                await workflowProcessAttempt.childStarted(started);
                durableChildStartedPersisted = true;
              } catch {
                fenceWorkflowProcessPaneAssignment(durableAssignment);
                await workflowProcessAttempt.fenced(
                  "ambiguous_dispatch",
                  durableAssignment,
                  3,
                );
                throw new WorkflowProcessAttemptFencedError(
                  "Dispatched workflow process lacked matching child-started evidence.",
                );
              }
            }
            const recoveredTerminal = readWorkflowProcessTerminalEvidence(
              durableAssignment.artifactDir,
              workflowProcessAttempt.manifest,
            );
            if (
              recoveredTerminal !== undefined &&
              recoveredTerminal.status !== "process_exit"
            ) {
              if (!workflowProcessAttempt.terminalPersisted) {
                await workflowProcessAttempt.terminal(recoveredTerminal);
                durableTerminalPersisted = true;
              }
              if (!workflowProcessAttempt.adoptedPersisted) {
                await workflowProcessAttempt.adopted("terminal");
              }
            } else {
              let liveness: "alive" | "dead" | "unknown" = "unknown";
              let probeCount = 0;
              while (probeCount < 3 && liveness === "unknown") {
                probeCount += 1;
                liveness =
                  await getWorkflowProcessPaneLiveness(durableAssignment);
                if (liveness === "unknown" && probeCount < 3) {
                  await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, 25);
                    timer.unref();
                  });
                }
              }
              if (liveness !== "alive") {
                fenceWorkflowProcessPaneAssignment(durableAssignment);
                await workflowProcessAttempt.fenced(
                  "ambiguous_dispatch",
                  durableAssignment,
                  probeCount,
                );
                throw new WorkflowProcessAttemptFencedError();
              }
              if (!workflowProcessAttempt.adoptedPersisted) {
                await workflowProcessAttempt.adopted("live");
              }
            }
            state = adoptWorkflowProcessSubagent({
              manifest: workflowProcessAttempt.manifest,
              assignment: durableAssignment,
              task: prompt,
              model,
              cwd: ctx.cwd,
              parentSessionId,
              supervisorOwner,
              workflowId: ownedWorkflowId,
              sessionScope: childScope,
            });
          } else {
            state = launchInteractiveSubagent({
              name: (label || "wf-agent").slice(0, 40),
              task: prompt,
              persona,
              model,
              cwd: ctx.cwd,
              contextText: null,
              background: true,
              thinkingLevel,
              parentSessionId,
              parentCwd: ctx.cwd,
              supervisorOwner,
              sessionScope: childScope,
              workflowId: ownedWorkflowId,
              completionOwner: "workflow",
              ...(workflowProcessAttempt === undefined
                ? {}
                : {
                    workflowProcessAttempt: workflowProcessAttempt.manifest,
                    deferDispatch: true,
                  }),
            });
            if (workflowProcessAttempt !== undefined) {
              durableAssignment = workflowProcessPaneAssignmentForState(state);
              await workflowProcessAttempt.paneAssigned(durableAssignment);
              await workflowProcessAttempt.launchDispatched(durableAssignment);
              dispatchPreparedInteractiveSubagent(state, childScope);
            }
          }
        } catch (err) {
          if (
            err instanceof WorkflowProcessAttemptFencedError ||
            err instanceof WorkflowProcessAttemptFenceIncompleteError ||
            workflowProcessAttempt?.mode === "adopt"
          ) {
            throw err;
          }
          if (
            workflowProcessAttempt !== undefined &&
            state !== undefined &&
            durableAssignment !== undefined
          ) {
            fenceWorkflowProcessPaneAssignment(durableAssignment);
            await workflowProcessAttempt.fenced(
              "ambiguous_dispatch",
              durableAssignment,
              0,
            );
            throw new WorkflowProcessAttemptFencedError(
              "Workflow process launch failed after pane creation.",
            );
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (workflowProcessAttempt !== undefined) {
            await workflowProcessAttempt.fallback(msg);
          }
          debugLog("warn", "isolation_process_fallback", { reason: msg });
          onProgress?.({
            kind: "log",
            message: `⚠ isolation:process unavailable — ${msg}. Falling back to in-process.`,
            label,
          });
        }
        if (state) {
          registerInteractiveSubagentState(state, childScope);
          if (
            workflowProcessAttempt !== undefined &&
            !durableChildStartedPersisted &&
            !durableTerminalPersisted
          ) {
            try {
              const started = await waitForWorkflowProcessChildStarted(
                state.artifactDir,
                workflowProcessAttempt.manifest,
                signal,
              );
              await workflowProcessAttempt.childStarted(started);
              durableChildStartedPersisted = true;
            } catch {
              if (durableAssignment !== undefined) {
                fenceWorkflowProcessPaneAssignment(durableAssignment);
              }
              await workflowProcessAttempt.fenced(
                "ambiguous_dispatch",
                durableAssignment,
                3,
              );
              throw new WorkflowProcessAttemptFencedError(
                "Workflow child failed its persisted start handshake.",
              );
            }
          }
          const result = await awaitInteractiveResult(
            state,
            signal,
            undefined,
            onCancellationSnapshot,
          );
          if (
            workflowProcessAttempt !== undefined &&
            !durableTerminalPersisted
          ) {
            const terminal = readWorkflowProcessTerminalEvidence(
              state.artifactDir,
              workflowProcessAttempt.manifest,
            );
            if (terminal === undefined || terminal.status === "process_exit") {
              throw new Error(
                "Workflow process completed without terminal artifact evidence.",
              );
            }
            await workflowProcessAttempt.terminal(terminal);
          }
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
    runner.resolveModel = (requested) => {
      const resolved = resolveModel(requested, ctx.model, ctx.modelRegistry);
      return resolved === undefined
        ? undefined
        : `${resolved.provider}/${resolved.id}`;
    };
    return runner;
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
      "",
      "Script shape:",
      "  export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] };",
      "  phase('Scan');",
      "  const out = await parallel([() => agent('task A'), () => agent('task B')]);",
      "  return out;",
      "",
      "Injected helpers/globals:",
      "  agent(prompt, opts?)   -> spawn one isolated sub-agent. opts: { id?, schema?, label?, phase?,",
      "                            model?, persona?, isolation?, agentType?, thinkingLevel? (off|minimal|low|medium|high|xhigh|max) }. Without schema returns the final text;",
      "                            with schema returns a value validated against the supported JSON Schema",
      "                            subset (type, enum, required/properties, additionalProperties, items,",
      "                            minItems, maxItems), or null after retries. Returns null on error",
      "                            (filter with Boolean).",
      "                            Defaults to tmux/zellij process isolation (attachable);",
      "                            falls back to in-process if no multiplexer is available.",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  workflow(name, args?, opts?) -> run a saved workflow inline (maximum depth 8; durable calls require opts.id).",
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
      "Pass raw JavaScript with no markdown fences. Include a top-level pure-literal `export const meta = { name, description, phases? }`.",
      "Do not use TypeScript, imports, require, fs, or other Node APIs. Date.now(), Math.random(), and argless new Date() are unavailable.",
      "Available globals are agent, parallel, pipeline, workflow, phase, log, args, immutable cwd, budget, console, guarded Date, and guarded Math.",
      "Call phase(title) at real work-group transitions. Agent phase defaults to the current phase; an explicit agent phase overrides it.",
      "parallel() takes thunks such as `() => agent(...)`; pipeline() streams each item through every stage independently, with no barrier between stages.",
      "Give agent calls unique short labels, include enough task context and relevant paths, and treat failed agents or stages as null.",
      "Use only the documented plain JSON Schema subset for schema outputs; in-process agents use native structured output while process agents use validated textual JSON fallback.",
      "Filter or handle null results, then use a final synthesis agent when the workflow needs one coherent answer.",
    ],
    parameters: Type.Object(
      {
        script: Type.Optional(
          Type.String({
            description:
              "The workflow script (export const meta + top-level body). Omit if using `name` or `plan`.",
          }),
        ),
        name: Type.Optional(
          Type.String({
            description:
              "Name of a saved workflow to run (instead of `script` or `plan`).",
          }),
        ),
        plan: Type.Optional(WORKFLOW_PLAN_SCHEMA),
        args: Type.Optional(
          Type.Unknown({
            description: "JSON value exposed to a script as `args`.",
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
              "Use the parent-owned durable ledger. Declarative plans are durable directly; scripts and saved names require explicit stable `{ id }` options on every agent()/workflow() boundary. Loop callsites may derive unique runtime IDs from their input items.",
          }),
        ),
      },
      { additionalProperties: false },
    ),

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

      const hasScript =
        typeof params.script === "string" && params.script.trim().length > 0;
      const hasName =
        typeof params.name === "string" && params.name.trim().length > 0;
      const hasPlan = params.plan !== undefined;
      const inputCount = Number(hasScript) + Number(hasName) + Number(hasPlan);
      if (inputCount !== 1) {
        const error = "provide exactly one of `script`, `name`, or `plan`";
        return {
          content: [{ type: "text", text: `Workflow not run: ${error}.` }],
          details: { status: "error", error },
          isError: true,
        };
      }

      if (hasPlan) {
        const basePlanOpts = (workflowId: string) => ({
          budgetTotal: params.budget ?? null,
          runAgent: makeRunAgent(ctx, workflowId, workflowOwner),
        });
        const startPlan = async (
          executionMode: "async" | "sync",
          completionNotification:
            ((job: WorkflowJobState) => boolean | void) | undefined,
          startSignal?: AbortSignal,
          onProgress?: (progress: WorkflowProgress) => void,
        ): Promise<WorkflowPlanJobState> => {
          if (params.durable === true) {
            if (!sessionScope) {
              throw new Error(
                "Durable workflow execution requires a live session scope.",
              );
            }
            const controller = getDurableWorkflowPlanController(sessionScope);
            if (controller === undefined) {
              throw new Error(
                "Durable workflow session is not initialized for this cwd/session.",
              );
            }
            return startDurableWorkflowPlanJob(
              params.plan,
              controller,
              {
                budgetTotal: params.budget ?? null,
                signal: startSignal,
                onProgress,
              },
              Date.now(),
              undefined,
              workflowOwner,
              executionMode,
            );
          }
          return startWorkflowPlanJob(
            params.plan,
            (workflowId) => ({
              ...basePlanOpts(workflowId),
              signal: startSignal,
              onProgress,
            }),
            Date.now(),
            completionNotification,
            workflowOwner,
            executionMode,
          );
        };

        if (params.async !== false) {
          let job: WorkflowPlanJobState;
          try {
            job = await startPlan("async", notifyWorkflowCompletion);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Workflow not started: ${msg}` }],
              details: { status: "error", kind: "plan", error: msg },
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `Workflow "${job.name}" started in background as ${job.id}. ` +
                  `Poll get_workflow_status / get_workflow_result. ${
                    job.durable
                      ? DURABLE_WORKFLOW_MESSAGE
                      : WORKFLOW_SESSION_SCOPE_MESSAGE
                  }`,
              },
            ],
            details: {
              status: "started",
              kind: "plan",
              workflowId: job.id,
              name: job.name,
              ...(job.durable ? { durable: true } : {}),
            },
          };
        }

        let job: WorkflowPlanJobState | undefined;
        try {
          const syncProgress = (progress: WorkflowProgress) => {
            try {
              onUpdate?.({
                content: [{ type: "text", text: renderProgress(progress) }],
                details: {
                  status: "running",
                  kind: "plan",
                  agentsSpawned: progress.agentsSpawned,
                  runningCount: progress.runningCount,
                  errorCount: progress.errorCount,
                  tokensSpent: progress.tokensSpent,
                  usage: progress.usage,
                  budgetTotal: progress.budgetTotal,
                },
              });
            } catch {
              /* onUpdate is best-effort */
            }
          };
          job = await startPlan("sync", undefined, signal, syncProgress);
          const run = await job.promise;
          const resultText = stringify(run.result);
          const presentation = getWorkflowCompletionPresentation(
            job.status,
            run.errorCount,
          );
          const usage = presentWorkflowUsage(run.usage);
          const summary =
            `Workflow "${run.meta.name}" ${presentation.label} — ` +
            `${run.agentsSpawned} agent(s), ${run.errorCount} error(s)${
              usage
                ? `, ${formatWorkflowUsage(usage, {
                    outputBudget: job.snapshot.budgetTotal,
                  })}`
                : ""
            }.`;
          const planProjection = boundedWorkflowPlanProjection(job);
          return {
            content: [{ type: "text", text: `${summary}\n\n${resultText}` }],
            details: {
              status: run.status,
              kind: "plan",
              presentationStatus: presentation.label,
              name: run.meta.name,
              agentsSpawned: run.agentsSpawned,
              errorCount: run.errorCount,
              tokensSpent: run.tokensSpent,
              usage: run.usage,
              budgetTotal: job.snapshot.budgetTotal,
              phases: run.phases,
              ...(job.durable ? { durable: true } : {}),
              ...(planProjection === undefined ? {} : { planProjection }),
            },
            ...(run.status === "done" ? {} : { isError: true }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const usage = workflowErrorUsage(err);
          const usageDetails = usage ? { usage } : {};
          const budgetTotal = params.budget ?? null;
          const planProjection = job
            ? boundedWorkflowPlanProjection(job)
            : undefined;
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
              kind: "plan",
              error: msg,
              budgetTotal,
              ...usageDetails,
              ...(planProjection === undefined ? {} : { planProjection }),
            },
            isError: true,
          };
        }
      }

      const script: string | null = hasScript
        ? params.script
        : loadWorkflowScript(params.name);
      if (!script) {
        const why = `no saved workflow named "${params.name}"`;
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
          job =
            params.durable === true
              ? await startDurableWorkflowScriptJob(
                  script,
                  requiredDurableController(sessionScope),
                  {
                    args: params.args,
                    cwd: ctx.cwd,
                    budgetTotal: params.budget ?? null,
                    loadWorkflow: (name) => loadWorkflowScript(name),
                  },
                  jobStartedAt,
                  undefined,
                  workflowOwner,
                  "async",
                )
              : startWorkflowJob(
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
                `Poll get_workflow_status / get_workflow_result. ${
                  job.durable
                    ? DURABLE_WORKFLOW_MESSAGE
                    : WORKFLOW_SESSION_SCOPE_MESSAGE
                }`,
            },
          ],
          details: {
            status: "started",
            workflowId: job.id,
            name: meta.name,
            ...(job.durable ? { durable: true } : {}),
          },
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
        const job =
          params.durable === true
            ? await startDurableWorkflowScriptJob(
                script,
                requiredDurableController(sessionScope),
                {
                  args: params.args,
                  cwd: ctx.cwd,
                  budgetTotal: params.budget ?? null,
                  loadWorkflow: (name) => loadWorkflowScript(name),
                  signal,
                  onProgress: syncProgress,
                },
                Date.now(),
                undefined,
                workflowOwner,
                "sync",
              )
            : startWorkflowJob(
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
            ...(job.durable ? { durable: true } : {}),
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

  // Model-safe by construction: this tool can request or inspect, never decide.
  pi.registerTool({
    name: "workflow_approval",
    label: "Workflow Approval Request",
    description:
      "Inspect a durable workflow approval or request a human plan gate. This tool cannot approve or deny requests.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("inspect"), Type.Literal("request")]),
        workflowId: Type.String({
          description: "Durable workflow ID.",
        }),
        reason: Type.Optional(
          Type.String({
            description:
              "Why human approval is needed. Required only for request.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _id,
      params,
    ): Promise<
      AgentToolResult<Record<string, unknown>> & { readonly isError?: boolean }
    > {
      const durable = await findDurableWorkflow(
        sessionScope,
        params.workflowId,
      );
      if (durable === undefined) {
        return {
          content: [
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      try {
        if (params.action === "request") {
          const description =
            typeof params.reason === "string" ? params.reason.trim() : "";
          if (description.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Approval not requested: `reason` is required.",
                },
              ],
              details: {
                status: "error",
                workflowId: durable.runId,
                error: "reason is required",
              },
              isError: true,
            };
          }
          await durable.controller.requestApproval(durable.runId, {
            approvalKind: "plan_gate",
            description,
            denialPolicy: "stop",
            expectedOwner: durable.projection.owner,
            expectedOwnerGeneration: durable.projection.ownerGeneration,
            expectedRunEpoch: durable.projection.runEpoch,
          });
        }
        const request = await durable.controller.inspectApproval(durable.runId);
        if (request === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `Durable workflow ${durable.runId} has no pending approval.`,
              },
            ],
            details: {
              status: "none",
              workflowId: durable.runId,
              pending: false,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Approval ${request.requestId} is pending for durable workflow ` +
                `${durable.runId}: ${request.description}`,
            },
          ],
          details: {
            status: "pending",
            workflowId: durable.runId,
            pending: true,
            request,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Approval request failed: ${message}`,
            },
          ],
          details: {
            status: "error",
            workflowId: durable.runId,
            error: message,
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
      "Poll a background workflow's live progress (agents, errors, canonical usage, output budget, and current phase). Usage icons: ↑ input, ↓ output, R/W cache, $ cost.",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = getWorkflowJobForOwner(params.workflowId, owner());
      const durable = await findDurableWorkflow(
        sessionScope,
        params.workflowId,
      );
      if (durable !== undefined) {
        const executionKind = durable.projection.executionKind;
        const planProjection =
          executionKind === "plan"
            ? boundedDurablePlanProjection(durable.projection)
            : undefined;
        const usage = presentWorkflowUsage(durable.projection.accounting.usage);
        const action = durableWorkflowAction(durable.projection.status);
        return {
          content: [
            {
              type: "text",
              text:
                `Durable ${executionKind} workflow ${durable.runId} [${durable.projection.status}]` +
                (usage ? ` — ${formatWorkflowUsage(usage)}` : "") +
                (planProjection === undefined
                  ? ""
                  : `\n${planProjection.summary}`) +
                (action === undefined ? "" : `\n${action}`),
            },
          ],
          details: {
            status: durable.projection.status,
            kind: executionKind,
            durable: true,
            workflowId: durable.runId,
            runEpoch: durable.projection.runEpoch,
            usage: durable.projection.accounting.usage,
            accountingCompleteness: durable.projection.accounting.completeness,
            ...(planProjection === undefined ? {} : { planProjection }),
            ...(action === undefined ? {} : { action }),
          },
        };
      }
      if (!st) {
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
      const errorCount = st.result?.errorCount ?? st.snapshot.errorCount;
      const presentation = getWorkflowCompletionPresentation(
        st.status,
        errorCount,
      );
      const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
      const usage = presentWorkflowUsage(st.snapshot.usage);
      const liveUsage = presentWorkflowUsage(st.snapshot.liveUsage);
      const planProjection = boundedWorkflowPlanProjection(st);
      return {
        content: [
          {
            type: "text",
            text:
              `${statusPrefix}Workflow "${st.name}" [${st.durableStatus ?? presentation.label}] — ${st.snapshot.agentsSpawned} agent(s)` +
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
              (st.error ? `\nerror: ${st.error}` : "") +
              (planProjection ? `\n${planProjection.summary}` : ""),
          },
        ],
        details: {
          status: st.status,
          kind: st.kind,
          presentationStatus: presentation.label,
          workflowId: st.id,
          name: st.name,
          elapsedMs: Date.now() - st.startedAt,
          ...st.snapshot,
          ...(st.durable ? { durable: true } : {}),
          ...(st.durableStatus === undefined
            ? {}
            : { durableStatus: st.durableStatus }),
          ...(st.recoveryFailure === undefined
            ? {}
            : { recoveryFailure: st.recoveryFailure }),
          ...(planProjection === undefined ? {} : { planProjection }),
        },
      };
    },
  });

  // ── get_workflow_result ──
  pi.registerTool({
    name: "get_workflow_result",
    label: "Workflow Result",
    description:
      "Return a durable workflow projection/result immediately; legacy live workflows wait for completion.",
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
      const st = getWorkflowJobForOwner(params.workflowId, owner());
      const durable = await findDurableWorkflow(
        sessionScope,
        params.workflowId,
      );
      if (durable !== undefined) {
        const executionKind = durable.projection.executionKind;
        const planProjection =
          executionKind === "plan"
            ? boundedDurablePlanProjection(durable.projection)
            : undefined;
        const terminal = durable.projection.terminal;
        if (terminal === undefined) {
          const action = durableWorkflowAction(durable.projection.status);
          return {
            content: [
              {
                type: "text",
                text:
                  `Durable workflow ${durable.runId} is ${durable.projection.status}; ` +
                  "no terminal result is available yet." +
                  (action === undefined ? "" : `\n${action}`),
              },
            ],
            details: {
              status: durable.projection.status,
              kind: executionKind,
              durable: true,
              workflowId: durable.runId,
              runEpoch: durable.projection.runEpoch,
              usage: durable.projection.accounting.usage,
              accountingCompleteness:
                durable.projection.accounting.completeness,
              ...(planProjection === undefined ? {} : { planProjection }),
              ...(action === undefined ? {} : { action }),
            },
            isError: true,
          };
        }
        let stored: unknown;
        try {
          stored = await durable.controller.getResult(durable.runId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `Durable workflow ${durable.runId} result unavailable: ${message}`,
              },
            ],
            details: {
              status: "error",
              kind: executionKind,
              durable: true,
              workflowId: durable.runId,
              error: message,
              ...(planProjection === undefined ? {} : { planProjection }),
            },
            isError: true,
          };
        }
        const validResult =
          executionKind === "plan"
            ? isWorkflowPlanRunResult(stored)
            : isWorkflowRunResultWithUsage(stored);
        if (!validResult) {
          const error = `Persisted durable ${executionKind} workflow result is invalid.`;
          return {
            content: [{ type: "text", text: error }],
            details: {
              status: "error",
              kind: executionKind,
              durable: true,
              workflowId: durable.runId,
              error,
              ...(planProjection === undefined ? {} : { planProjection }),
            },
            isError: true,
          };
        }
        const run = stored as
          WorkflowPlanRunResult | WorkflowRunResultWithUsage;
        const presentation = getWorkflowCompletionPresentation(
          terminal.status,
          run.errorCount,
        );
        const usage = presentWorkflowUsage(run.usage);
        const resultText = stringify(run.result);
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${run.meta.name}" ${presentation.label} — ` +
                `${run.agentsSpawned} agent(s), ${run.errorCount} error(s)` +
                (usage ? `, ${formatWorkflowUsage(usage)}` : "") +
                `.\n\n${resultText}`,
            },
          ],
          details: {
            status: terminal.status,
            kind: executionKind,
            durable: true,
            presentationStatus: presentation.label,
            workflowId: durable.runId,
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            usage: run.usage,
            phases: run.phases,
            accountingCompleteness: durable.projection.accounting.completeness,
            ...(planProjection === undefined ? {} : { planProjection }),
          },
          ...(terminal.status === "done" ? {} : { isError: true }),
        };
      }
      if (!st) {
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

      // If signal is already aborted, return immediately
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text: `Wait for workflow ${st.id} cancelled.`,
            },
          ],
          details: {
            status: "wait_cancelled",
            kind: st.kind,
            workflowId: st.id,
          },
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
            details: {
              status: "wait_cancelled",
              kind: st.kind,
              workflowId: st.id,
            },
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
        const planProjection = boundedWorkflowPlanProjection(st);
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
            kind: st.kind,
            workflowId: st.id,
            ...(st.durable ? { durable: true } : {}),
            error: msg,
            ...(outputBudget == null ? {} : { budgetTotal: outputBudget }),
            ...usageDetails,
            ...(planProjection === undefined ? {} : { planProjection }),
          },
          isError: true,
        };
      }

      const resultText =
        typeof run.result === "string" ? run.result : stringify(run.result);
      const presentation = getWorkflowCompletionPresentation(
        st.kind === "plan" ? st.status : "done",
        run.errorCount,
      );
      const usage = presentWorkflowUsage(run.usage);
      const planProjection = boundedWorkflowPlanProjection(st);
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
          status: st.kind === "plan" ? st.status : "done",
          kind: st.kind,
          presentationStatus: presentation.label,
          ...(st.durable ? { durable: true } : {}),
          workflowId: st.id,
          name: run.meta.name,
          agentsSpawned: run.agentsSpawned,
          errorCount: run.errorCount,
          tokensSpent: run.tokensSpent,
          usage: run.usage,
          budgetTotal: st.snapshot.budgetTotal,
          phases: run.phases,
          ...(planProjection === undefined ? {} : { planProjection }),
        },
        ...(st.kind === "plan" && st.status !== "done"
          ? { isError: true }
          : {}),
      };
    },
  });

  // ── cancel_workflow ──
  pi.registerTool({
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
      const durable = await findDurableWorkflow(
        sessionScope,
        params.workflowId,
      );
      if (durable !== undefined) {
        const terminalStatus = durable.projection.terminal?.status;
        if (terminalStatus !== undefined) {
          const cancelled = terminalStatus === "cancelled";
          return {
            content: [
              {
                type: "text",
                text: cancelled
                  ? `Workflow ${durable.runId} is already cancelled.`
                  : `Workflow ${durable.runId} is already ${terminalStatus}; nothing was cancelled.`,
              },
            ],
            details: {
              status: terminalStatus,
              workflowId: durable.runId,
              durable: true,
              cancelled,
            },
          };
        }
        try {
          await durable.controller.trustedCancel(durable.runId, {
            reason: "cancel_workflow requested terminal cancellation",
            trustedActorId: "workflow-tool",
            expectedOwner: durable.controller.owner,
            expectedRunEpoch: durable.projection.runEpoch,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `Workflow ${durable.runId} cancellation failed: ${message}`,
              },
            ],
            details: {
              status: "error",
              workflowId: durable.runId,
              durable: true,
              cancelled: false,
              error: message,
            },
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: `Workflow ${durable.runId} cancelled.` },
          ],
          details: {
            status: "cancelled",
            workflowId: durable.runId,
            durable: true,
            cancelled: true,
            snapshots: [],
          },
        };
      }
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
        "Open an interactive workflow tree with expand/collapse, trusted approval/resume, and cancel controls.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const controller =
          sessionScope === undefined
            ? undefined
            : getDurableWorkflowPlanController(sessionScope);
        const durableRuns =
          controller === undefined
            ? []
            : await controller.repository.list(controller.owner);
        const approvals = durableRuns
          .map(pendingWorkflowApproval)
          .filter((request) => request !== undefined);
        const resumes: WorkflowTrustedResumeSnapshot[] = durableRuns.flatMap(
          (projection) =>
            projection.status === "interrupted" &&
            projection.resumePolicy !== "never"
              ? [
                  Object.freeze({
                    runId: projection.runId,
                    executionKind: projection.executionKind,
                    expectedOwner: projection.owner,
                    expectedRunEpoch: projection.runEpoch,
                  }),
                ]
              : [],
        );
        const action = await showWorkflowTree(
          ctx.ui,
          owner(),
          approvals,
          resumes,
        );
        if (action.kind === "cancel") {
          sendCommandMessage(`Workflow ${action.workflowId} cancelled.`);
          return;
        }
        if (action.kind === "resume") {
          if (controller === undefined) return;
          const resume = action.resume;
          try {
            const execution = await controller.trustedResume(resume.runId, {
              trustedActorId: "workflow-tree",
              expectedOwner: resume.expectedOwner,
              expectedRunEpoch: resume.expectedRunEpoch,
            });
            ctx.ui.notify(
              `Workflow ${resume.runId} resumed from interrupted epoch ${resume.expectedRunEpoch}.`,
            );
            void execution.completion.catch((error) => {
              const message = sanitizeTerminalText(
                error instanceof Error ? error.message : String(error),
              );
              ctx.ui.notify(
                `Workflow ${resume.runId} stopped after resume: ${message}`,
              );
            });
          } catch (error) {
            const message = sanitizeTerminalText(
              error instanceof Error ? error.message : String(error),
            );
            ctx.ui.notify(
              `Workflow ${resume.runId} was not resumed: ${message}`,
            );
          }
          return;
        }
        if (action.kind !== "approval" || controller === undefined) return;
        const request = action.request;
        const outcome = await controller.trustedDecideApproval(request.runId, {
          requestId: request.requestId,
          requestEventId: request.requestEventId,
          policyHash: request.policyHash,
          planRevision: request.planRevision,
          expectedOwner: request.owner,
          expectedOwnerGeneration: request.ownerGeneration,
          expectedRunEpoch: request.runEpoch,
          version: request.version,
          decision: action.decision,
          trustedActorId: "workflow-tree",
        });
        ctx.ui.notify(
          outcome.status === "accepted"
            ? `Workflow approval ${request.requestId} ${action.decision}.`
            : `Workflow approval ${request.requestId} was stale (${outcome.reason}); no change was made.`,
        );
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
        `**${st.name}** (${st.id}) [${statusPrefix}${st.durableStatus ?? presentation.label}]`,
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

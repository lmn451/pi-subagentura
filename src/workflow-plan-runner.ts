import type { SubagentResult, Usage } from "./helpers";
import {
  MAX_TOTAL_AGENTS,
  WorkflowExecutionError,
  addWorkflowUsage,
  defaultConcurrency,
  type WorkflowAgentProgress,
  type WorkflowAgentRunner,
  type WorkflowMeta,
  type WorkflowProgress,
  type WorkflowRunResultWithUsage,
  type WorkflowUsage,
  workflowUsageFromUsage,
  zeroWorkflowUsage,
} from "./workflow-core";
import {
  WorkflowAgentDispatcher,
  type WorkflowAgentDispatchOptions,
} from "./workflow-dispatcher";
import type { WorkflowPlanDefinition } from "./workflow-plan";
import {
  applyPlanEvent,
  createPlanProjection,
  selectReadyTasks,
  workflowPlanStatus,
  type WorkflowPlanEvent,
  type WorkflowPlanProjection,
  type WorkflowPlanStatus,
  type WorkflowPlanTaskProjection,
  type WorkflowPlanTaskStatus,
} from "./workflow-plan-state";

export interface WorkflowPlanTaskDispatch {
  readonly task: WorkflowPlanTaskProjection;
  readonly request: Parameters<WorkflowAgentRunner>[0];
  readonly dispatch: (
    request?: Parameters<WorkflowAgentRunner>[0],
    beforeStart?: WorkflowAgentDispatchOptions["beforeStart"],
  ) => Promise<SubagentResult>;
}

export type WorkflowPlanTaskDispatcher = (
  input: WorkflowPlanTaskDispatch,
) => Promise<SubagentResult>;

export interface WorkflowPlanRefresh {
  readonly definition: WorkflowPlanDefinition;
  readonly taskStatuses: Readonly<Record<string, WorkflowPlanTaskStatus>>;
}

export interface RunWorkflowPlanOptions {
  runAgent: WorkflowAgentRunner;
  dispatcher?: WorkflowAgentDispatcher;
  dispatchTask?: WorkflowPlanTaskDispatcher;
  signal?: AbortSignal;
  concurrency?: number;
  processConcurrency?: number;
  appendEvent?: (event: WorkflowPlanEvent) => void | Promise<void>;
  skipTask?: (task: WorkflowPlanTaskProjection) => string | undefined;
  initialTaskStatuses?: Readonly<Record<string, WorkflowPlanTaskStatus>>;
  onProgress?: (progress: WorkflowProgress) => void;
  refreshPlan?: () => Promise<WorkflowPlanRefresh>;
}

export interface WorkflowPlanTaskResult {
  readonly id: string;
  readonly phaseId: string;
  readonly content: string;
  readonly status: WorkflowPlanTaskStatus;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly reason?: string;
}

export interface WorkflowPlanRunResult extends WorkflowRunResultWithUsage {
  readonly status: WorkflowPlanStatus;
  readonly result: readonly WorkflowPlanTaskResult[];
  readonly projection: WorkflowPlanProjection;
}

interface PlanCounters {
  agentsSpawned: number;
  errorCount: number;
  tokensSpent: number;
  runningCount: number;
}

interface TaskRunContext {
  readonly task: WorkflowPlanTaskProjection;
  readonly label: string;
  readonly phase: string;
  readonly model?: string;
  agentId?: number;
  runnerStarted: boolean;
  liveUsage?: WorkflowUsage;
}

type TaskRunOutcome =
  | {
      readonly kind: "result";
      readonly context: TaskRunContext;
      readonly result: SubagentResult;
    }
  | {
      readonly kind: "throw";
      readonly context: TaskRunContext;
      readonly error: unknown;
    };

/** Execute a validated declarative plan without making any durability claim. */
export async function runWorkflowPlan(
  definition: WorkflowPlanDefinition,
  options: RunWorkflowPlanOptions,
): Promise<WorkflowPlanRunResult> {
  const concurrency = options.concurrency ?? defaultConcurrency();
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive safe integer.");
  }

  const dispatcher =
    options.dispatcher ??
    new WorkflowAgentDispatcher({
      concurrency,
      processConcurrency: options.processConcurrency,
    });
  const ownsDispatcher = options.dispatcher === undefined;
  const runnerAbort = new AbortController();
  const queueAbort = new AbortController();
  let cancellationRequested = options.signal?.aborted ?? false;
  const forwardAbort = () => {
    cancellationRequested = true;
    if (!runnerAbort.signal.aborted) runnerAbort.abort(options.signal?.reason);
    if (!queueAbort.signal.aborted) queueAbort.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    forwardAbort();
  } else {
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  let projection = createPlanProjection(definition);
  let currentDefinition = definition;
  if (options.initialTaskStatuses !== undefined) {
    for (const phase of projection.phases) {
      for (const task of phase.tasks) {
        const status = options.initialTaskStatuses[task.definition.id];
        if (status === "blocked") {
          projection = applyPlanEvent(projection, {
            type: "task_blocked",
            taskId: task.definition.id,
            reason: "Restored from the durable workflow plan.",
          });
        } else if (status === "skipped") {
          projection = applyPlanEvent(projection, {
            type: "task_skipped",
            taskId: task.definition.id,
            reason: "Restored from the durable workflow plan.",
          });
        } else if (status === "succeeded") {
          projection = applyPlanEvent(projection, {
            type: "task_started",
            taskId: task.definition.id,
          });
          projection = applyPlanEvent(projection, {
            type: "task_succeeded",
            taskId: task.definition.id,
            result: undefined,
          });
        }
      }
    }
  }
  let usage = zeroWorkflowUsage();
  const counters: PlanCounters = {
    agentsSpawned: 0,
    errorCount: 0,
    tokensSpent: 0,
    runningCount: 0,
  };
  let nextAgentId = 0;
  let failureObserved = false;
  const startedPhases = new Set<string>();
  const phases: string[] = [];
  const active = new Map<string, Promise<TaskRunOutcome>>();

  const emit = (progress: WorkflowProgress): void => {
    options.onProgress?.(progress);
  };
  const progressFields = () => ({
    agentsSpawned: counters.agentsSpawned,
    errorCount: counters.errorCount,
    tokensSpent: counters.tokensSpent,
    budgetTotal: null,
    usage: { ...usage },
    runningCount: counters.runningCount,
  });
  const appendAndApply = async (event: WorkflowPlanEvent): Promise<void> => {
    await options.appendEvent?.(event);
    projection = applyPlanEvent(projection, event);
  };
  const accountUsage = (next: Usage | undefined): WorkflowUsage | undefined => {
    const agentUsage = workflowUsageFromUsage(next);
    usage = addWorkflowUsage(usage, next);
    counters.tokensSpent = usage.output;
    return agentUsage;
  };
  const emitAgentProgress = (
    context: TaskRunContext,
    event: WorkflowAgentProgress,
  ): void => {
    if (event.liveUsage) context.liveUsage = { ...event.liveUsage };
    if (event.kind === "phase") {
      emit({
        kind: "phase",
        phase: context.phase,
        message: event.message,
        label: context.label,
        agentId: context.agentId,
        model: context.model,
        liveUsage: event.liveUsage,
        ...progressFields(),
      });
      return;
    }
    emit({
      kind: "log",
      phase: context.phase,
      message: event.message,
      label: context.label,
      agentId: context.agentId,
      model: context.model,
      liveUsage: event.liveUsage,
      ...progressFields(),
    });
  };
  const launchTask = (task: WorkflowPlanTaskProjection): void => {
    const agent = task.definition.agent;
    const context: TaskRunContext = {
      task,
      label: task.definition.content,
      phase: task.phaseId,
      model: agent?.model,
      runnerStarted: false,
    };
    const request: Parameters<WorkflowAgentRunner>[0] = {
      prompt: task.definition.instruction,
      persona: agent?.persona,
      model: agent?.model,
      signal: runnerAbort.signal,
      isolation: agent?.isolation ?? "process",
      label: context.label,
      schema: agent?.schema,
      thinkingLevel: agent?.thinkingLevel,
      onProgress: (event) => emitAgentProgress(context, event),
    };
    const dispatch = (
      nextDispatchRequest: Parameters<WorkflowAgentRunner>[0] = request,
      beforeStart?: WorkflowAgentDispatchOptions["beforeStart"],
    ) =>
      dispatcher.run(
        nextDispatchRequest,
        async (nextRequest) => {
          if (counters.agentsSpawned >= MAX_TOTAL_AGENTS) {
            throw new Error(
              `Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent lifetime cap.`,
            );
          }
          context.agentId = ++nextAgentId;
          context.runnerStarted = true;
          counters.agentsSpawned++;
          counters.runningCount++;
          emit({
            kind: "agent_start",
            phase: context.phase,
            label: context.label,
            model: context.model,
            agentId: context.agentId,
            ...progressFields(),
          });
          try {
            const result = await options.runAgent(nextRequest);
            if (result.cancelled) {
              cancellationRequested = true;
              if (!runnerAbort.signal.aborted) {
                runnerAbort.abort("Workflow cancelled.");
              }
              if (!queueAbort.signal.aborted) {
                queueAbort.abort("Workflow cancelled.");
              }
            } else if (result.isError && !cancellationRequested) {
              failureObserved = true;
              if (!queueAbort.signal.aborted) {
                queueAbort.abort(
                  new Error(
                    `Workflow task "${context.task.definition.id}" failed.`,
                  ),
                );
              }
            }
            return result;
          } catch (error) {
            if (!runnerAbort.signal.aborted) {
              failureObserved = true;
              if (!queueAbort.signal.aborted) queueAbort.abort(error);
            }
            throw error;
          } finally {
            counters.runningCount--;
          }
        },
        { signal: queueAbort.signal, beforeStart },
      );
    const promise = (
      options.dispatchTask === undefined
        ? dispatch()
        : options.dispatchTask({ task, request, dispatch })
    ).then<TaskRunOutcome, TaskRunOutcome>(
      (result) => ({ kind: "result", context, result }),
      (error: unknown) => ({ kind: "throw", context, error }),
    );
    active.set(task.definition.id, promise);
  };

  try {
    for (;;) {
      if (options.refreshPlan !== undefined) {
        const refreshed = await options.refreshPlan();
        projection = mergePlanProjection(
          projection,
          refreshed.definition,
          refreshed.taskStatuses,
        );
        currentDefinition = refreshed.definition;
      }
      if (!failureObserved && !cancellationRequested) {
        const readyTasks = selectReadyTasks(projection, concurrency);
        for (const task of readyTasks) {
          if (failureObserved || cancellationRequested) break;
          const skipReason = options.skipTask?.(task);
          if (skipReason !== undefined) {
            await appendAndApply({
              type: "task_skipped",
              taskId: task.definition.id,
              reason: skipReason,
            });
            continue;
          }
          if (!startedPhases.has(task.phaseId)) {
            startedPhases.add(task.phaseId);
            phases.push(task.phaseId);
            const phase = currentDefinition.phases.find(
              (candidate) => candidate.id === task.phaseId,
            );
            emit({
              kind: "phase",
              phase: task.phaseId,
              message: phase?.name,
              ...progressFields(),
            });
          }
          await appendAndApply({
            type: "task_started",
            taskId: task.definition.id,
          });
          launchTask(task);
        }
      }

      if (active.size === 0) {
        if (cancellationRequested) {
          const currentStatus = workflowPlanStatus(projection);
          if (currentStatus === "running" || currentStatus === "blocked") {
            await appendAndApply({
              type: "run_cancelled",
              ...(options.signal?.reason === undefined
                ? {}
                : { reason: String(options.signal.reason) }),
            });
          }
        }
        break;
      }

      const outcome = await Promise.race(active.values());
      active.delete(outcome.context.task.definition.id);
      let agentUsage: WorkflowUsage | undefined;
      let agentStatus: "done" | "error" = "done";

      if (outcome.kind === "result") {
        agentUsage = accountUsage(outcome.result.usage);
        if (cancellationRequested || outcome.result.cancelled) {
          cancellationRequested = true;
          agentStatus = "error";
          if (!runnerAbort.signal.aborted)
            runnerAbort.abort("Workflow cancelled.");
          if (!queueAbort.signal.aborted)
            queueAbort.abort("Workflow cancelled.");
        } else if (outcome.result.isError) {
          agentStatus = "error";
          counters.errorCount++;
          await appendAndApply({
            type: "task_failed",
            taskId: outcome.context.task.definition.id,
            error: outcome.result.errorMessage,
          });
          failureObserved = true;
          if (!queueAbort.signal.aborted) {
            queueAbort.abort(
              new Error(
                `Workflow task "${outcome.context.task.definition.id}" failed.`,
              ),
            );
          }
        } else {
          await appendAndApply({
            type: "task_succeeded",
            taskId: outcome.context.task.definition.id,
            result: outcome.result.output,
          });
        }
      } else {
        const errorUsage = (outcome.error as { usage?: Usage } | null)?.usage;
        const terminalUsage = workflowUsageFromUsage(errorUsage);
        const observedUsage =
          terminalUsage !== undefined
            ? errorUsage
            : outcome.context.liveUsage
              ? workflowUsageAsUsage(outcome.context.liveUsage)
              : undefined;
        agentUsage = accountUsage(observedUsage);
        agentStatus = "error";
        if (!cancellationRequested) {
          if (
            failureObserved &&
            queueAbort.signal.aborted &&
            !outcome.context.runnerStarted
          ) {
            await appendAndApply({
              type: "task_cancelled",
              taskId: outcome.context.task.definition.id,
              reason: "Stopped after task failure.",
            });
          } else {
            counters.errorCount++;
            await appendAndApply({
              type: "task_failed",
              taskId: outcome.context.task.definition.id,
              error: errorMessage(outcome.error),
            });
            failureObserved = true;
            if (!queueAbort.signal.aborted) queueAbort.abort(outcome.error);
          }
        }
      }

      if (outcome.context.runnerStarted) {
        emit({
          kind: "agent_done",
          phase: outcome.context.phase,
          label: outcome.context.label,
          model:
            outcome.kind === "result"
              ? (outcome.result.model ?? outcome.context.model)
              : outcome.context.model,
          status: agentStatus,
          agentId: outcome.context.agentId,
          agentUsage,
          ...progressFields(),
        });
      }
    }
  } catch (error) {
    if (!runnerAbort.signal.aborted) runnerAbort.abort(error);
    if (!queueAbort.signal.aborted) queueAbort.abort(error);
    await Promise.all(active.values());
    if (error instanceof WorkflowExecutionError && error.usage) throw error;
    throw new WorkflowExecutionError(
      errorMessage(error),
      hasUsage(usage) ? { ...usage } : undefined,
      error,
    );
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    if (ownsDispatcher) {
      dispatcher.close();
      await dispatcher.drain();
    }
  }

  const status = workflowPlanStatus(projection);
  const taskResults = projection.phases.flatMap((phase) =>
    phase.tasks.map((task): WorkflowPlanTaskResult => ({
      id: task.definition.id,
      phaseId: task.phaseId,
      content: task.definition.content,
      status: task.status,
      ...(task.status === "succeeded" ? { output: task.result } : {}),
      ...(task.status === "failed" ? { error: task.error } : {}),
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    })),
  );
  const meta: WorkflowMeta = {
    name: currentDefinition.name,
    description: currentDefinition.description,
    phases: currentDefinition.phases.map((phase) => ({
      title: phase.name,
      detail: phase.id,
    })),
  };
  return {
    meta,
    status,
    result: taskResults,
    projection,
    agentsSpawned: counters.agentsSpawned,
    errorCount: counters.errorCount,
    tokensSpent: counters.tokensSpent,
    usage: { ...usage },
    phases,
  };
}

function mergePlanProjection(
  current: WorkflowPlanProjection,
  definition: WorkflowPlanDefinition,
  taskStatuses: Readonly<Record<string, WorkflowPlanTaskStatus>>,
): WorkflowPlanProjection {
  const existing = new Map(
    current.phases.flatMap((phase) =>
      phase.tasks.map((task) => [task.definition.id, task] as const),
    ),
  );
  const definedTaskIds = new Set(
    definition.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
  );
  for (const taskId of existing.keys()) {
    if (!definedTaskIds.has(taskId)) {
      throw new Error(`Refreshed workflow plan removed task "${taskId}"`);
    }
  }
  return {
    definition,
    phases: definition.phases.map((phase) => ({
      definition: phase,
      tasks: phase.tasks.map((task) => {
        const prior = existing.get(task.id);
        const status = refreshedTaskStatus(
          prior?.status,
          taskStatuses[task.id],
        );
        return {
          definition: task,
          phaseId: phase.id,
          status,
          ...(prior?.status === status && prior.result !== undefined
            ? { result: prior.result }
            : {}),
          ...(prior?.status === status && prior.error !== undefined
            ? { error: prior.error }
            : {}),
          ...(prior?.status === status && prior.reason !== undefined
            ? { reason: prior.reason }
            : {}),
        };
      }),
    })),
  };
}

function refreshedTaskStatus(
  current: WorkflowPlanTaskStatus | undefined,
  durable: WorkflowPlanTaskStatus | undefined,
): WorkflowPlanTaskStatus {
  if (current === undefined) return durable ?? "pending";
  // A recovered committed/running operation must still pass through the
  // operation gate so replay reconstructs its output and accounting.
  if (
    current === "pending" &&
    (durable === "running" || durable === "succeeded")
  ) {
    return current;
  }
  return durable ?? current;
}

function workflowUsageAsUsage(usage: WorkflowUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.costUsd,
    ...(usage.costSource ? { costSource: usage.costSource } : {}),
    turns: usage.turns,
  };
}

function hasUsage(usage: WorkflowUsage): boolean {
  return (
    usage.totalTokens !== 0 ||
    usage.costUsd !== 0 ||
    usage.turns !== 0 ||
    usage.costSource !== undefined
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

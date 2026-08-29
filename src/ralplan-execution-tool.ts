import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startSubagentJob } from "./helpers";
import { registerToolWithDefaultGuidance } from "./tool-guidance";
import {
  sessionOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import { getRalplanRunById } from "./ralplan-state";
import {
  approveExecutionPreview,
  cancelExecutionRecord,
  createExecutionPreview,
  getExecutionRecord,
  interruptExecutionsForOwner,
  listExecutionRecords,
  resolveUnknownExecutionOperation,
  resumeExecutionRecord,
  type DurableExecutionRecord,
} from "./workflow-run-store";
import {
  digestExecutionOutput,
  runDurableExecution,
  type ExecutionTaskContext,
  type ExecutionTaskResult,
} from "./workflow-plan-runner";

interface ExecutionJob {
  executionId: string;
  owner: SessionOwnerToken;
  abort: AbortController;
  promise: Promise<DurableExecutionRecord>;
}

const executionJobs = new Map<string, ExecutionJob>();

export function executionJobsForTests(): Map<string, ExecutionJob> {
  return executionJobs;
}

function parentSessionId(scope: SessionScope): string | undefined {
  try {
    return scope.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function context(scope: SessionScope) {
  if (scope.lifecycle !== "started" || !scope.cwd) {
    throw new Error("Durable RALPLAN execution requires a live parent session");
  }
  return {
    cwd: scope.cwd,
    owner: sessionOwner(scope),
    parentSessionId: parentSessionId(scope),
  };
}

function errorResult(error: unknown, id?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `RALPLAN execution action failed: ${message}`,
      },
    ],
    details: {
      status: "error",
      error: message,
      ...(id ? { executionId: id } : {}),
    },
    isError: true,
  };
}

function summarize(record: DurableExecutionRecord): string {
  const committed = record.taskStates.filter(
    (state) => state.status === "committed" || state.status === "skipped",
  ).length;
  const unknown = record.taskStates.filter(
    (state) => state.status === "unknown",
  ).length;
  return `${record.executionId} [${record.status}] revision=${record.revision} tasks=${committed}/${record.tasks.length} unknown=${unknown}`;
}

async function runTaskWithSubagent(
  taskContext: ExecutionTaskContext,
  toolContext: any,
  cwd: string,
  owner: SessionOwnerToken,
): Promise<ExecutionTaskResult> {
  const prompt = `Execute exactly one approved declarative RALPLAN task.

EXECUTION ID: ${taskContext.executionId}
OPERATION ID: ${taskContext.operationId}
TASK ID: ${taskContext.task.id}
PHASE: ${taskContext.task.phase}
TITLE: ${taskContext.task.title}

APPROVED TASK:
${taskContext.task.prompt}

Stay within this task. Do not expand scope, approve other work, commit, push, or
publish. Run relevant verification. Your final response must summarize concrete
changes and checks. Side effects are not exactly-once: the host persists the
operation before this call and will require manual resolution if interrupted.`;
  const prepared = await startSubagentJob({
    task: prompt,
    persona: undefined,
    modelOverride: undefined,
    cwd,
    contextText: null,
    signal: taskContext.signal,
    onUpdate: undefined,
    defaultModel: toolContext.model,
    parentModelRegistry: toolContext.modelRegistry,
    cancellationSource: "workflow",
    owner,
  });
  prepared.start?.();
  const result = await prepared.jobPromise;
  if (result.isError) throw new Error(result.errorMessage || "executor failed");
  const output = result.output || "";
  return {
    summary: output.slice(0, 4096) || `${taskContext.task.id} completed`,
    outputDigest: digestExecutionOutput(output),
  };
}

export function interruptRalplanExecutionJobs(input: {
  cwd: string;
  owner: SessionOwnerToken;
  lifecycleReason: string;
}): DurableExecutionRecord[] {
  for (const [executionId, job] of executionJobs) {
    if (
      job.owner.id !== input.owner.id ||
      job.owner.generation !== input.owner.generation
    ) {
      continue;
    }
    job.abort.abort(new Error(`session ${input.lifecycleReason}`));
    executionJobs.delete(executionId);
  }
  return interruptExecutionsForOwner(input);
}

export interface RalplanExecutionToolOptions {
  runTask?: (context: ExecutionTaskContext) => Promise<ExecutionTaskResult>;
}

export function registerRalplanExecutionTools(
  pi: ExtensionAPI,
  scope: SessionScope,
  options: RalplanExecutionToolOptions = {},
): void {
  const taskSchema = Type.Object({
    id: Type.String({ maxLength: 64 }),
    phase: Type.String({ maxLength: 128 }),
    title: Type.String({ maxLength: 256 }),
    prompt: Type.String({ maxLength: 20_000 }),
    dependsOn: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
  });

  registerToolWithDefaultGuidance(pi, {
    name: "preview_ralplan_execution",
    label: "Preview RALPLAN Execution",
    description:
      "Create a bounded declarative sequential preview from an approved RALPLAN handoff. Preview is visibly pending and starts no execution.",
    parameters: Type.Object({
      runId: Type.String(),
      planDigest: Type.String(),
      tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 32 }),
    }),
    async execute(
      _id: string,
      params: { runId: string; planDigest: string; tasks: unknown[] },
    ): Promise<any> {
      try {
        const current = context(scope);
        const ralplan = getRalplanRunById(current.cwd, params.runId);
        if (!ralplan) throw new Error("Approved RALPLAN run not found");
        const record = createExecutionPreview({
          ...current,
          ralplan,
          planDigest: params.planDigest,
          tasks: params.tasks,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `${summarize(record)}\nPreview pending explicit execution approval. ` +
                "No task was started.",
            },
          ],
          details: {
            status: record.status,
            executionId: record.executionId,
            revision: record.revision,
            planDigest: record.planDigest,
            tasks: record.tasks,
            executionStarted: false,
            exactlyOnce: false,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "approve_ralplan_execution",
    label: "Approve RALPLAN Execution",
    description:
      "Approve an exact declarative preview by execution id, revision, and plan digest. Approval does not start tasks.",
    parameters: Type.Object({
      executionId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 1 }),
      planDigest: Type.String(),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const current = context(scope);
        const record = approveExecutionPreview({ ...current, ...params });
        return {
          content: [
            {
              type: "text",
              text: `${summarize(record)}\nApproved, but execution has not started.`,
            },
          ],
          details: {
            status: record.status,
            executionId: record.executionId,
            revision: record.revision,
            executionStarted: false,
            exactlyOnce: false,
          },
        };
      } catch (error) {
        return errorResult(error, params.executionId);
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "run_ralplan_execution",
    label: "Run RALPLAN Execution",
    description:
      "Start a separately approved declarative execution in the background. Tasks run sequentially; committed outcomes are durable. Side effects are explicitly not exactly-once.",
    parameters: Type.Object({
      executionId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 1 }),
    }),
    async execute(
      _id: string,
      params: { executionId: string; expectedRevision: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      toolContext: any,
    ): Promise<any> {
      try {
        const current = context(scope);
        if (executionJobs.has(params.executionId)) {
          throw new Error("Execution already has a live runner");
        }
        const abort = new AbortController();
        const runTask =
          options.runTask ??
          ((taskContext: ExecutionTaskContext) =>
            runTaskWithSubagent(
              taskContext,
              toolContext,
              current.cwd,
              current.owner,
            ));
        const promise = runDurableExecution({
          ...current,
          ...params,
          runTask,
          signal: abort.signal,
        });
        const job: ExecutionJob = {
          executionId: params.executionId,
          owner: current.owner,
          abort,
          promise,
        };
        executionJobs.set(params.executionId, job);
        void promise
          .finally(() => executionJobs.delete(params.executionId))
          .catch(() => {});
        const record = getExecutionRecord(current.cwd, params.executionId)!;
        return {
          content: [
            {
              type: "text",
              text:
                `${summarize(record)}\nSequential execution started. ` +
                "Use get_ralplan_execution_status for durable status.",
            },
          ],
          details: {
            status: record.status,
            executionId: record.executionId,
            revision: record.revision,
            exactlyOnce: false,
          },
        };
      } catch (error) {
        return errorResult(error, params.executionId);
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "get_ralplan_execution_status",
    label: "RALPLAN Execution Status",
    description:
      "Read durable execution projections from disk, including after restart. This is status only and never resumes work.",
    parameters: Type.Object({
      executionId: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: { executionId?: string }): Promise<any> {
      try {
        const current = context(scope);
        const records = listExecutionRecords(current.cwd, current).filter(
          (record) =>
            !params.executionId || record.executionId === params.executionId,
        );
        if (params.executionId && records.length === 0) {
          throw new Error("Execution not found in this parent session");
        }
        return {
          content: [
            {
              type: "text",
              text: records.length
                ? records.map(summarize).join("\n")
                : "No durable RALPLAN executions are visible.",
            },
          ],
          details: { status: "ok", records },
        };
      } catch (error) {
        return errorResult(error, params.executionId);
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "cancel_ralplan_execution",
    label: "Cancel RALPLAN Execution",
    description:
      "Cancel an exact active declarative execution. In-flight side effects become unknown and are never silently retried.",
    parameters: Type.Object({
      executionId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 1 }),
      reason: Type.String(),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const current = context(scope);
        executionJobs
          .get(params.executionId)
          ?.abort.abort(new Error(params.reason));
        executionJobs.delete(params.executionId);
        const record = cancelExecutionRecord({ ...current, ...params });
        return {
          content: [{ type: "text", text: `${summarize(record)}\nCancelled.` }],
          details: {
            status: record.status,
            executionId: record.executionId,
            revision: record.revision,
          },
        };
      } catch (error) {
        return errorResult(error, params.executionId);
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "resolve_ralplan_operation",
    label: "Resolve RALPLAN Operation",
    description:
      "Manually resolve an interrupted operation with unknown side effects as retry, accept, or fail. Requires bounded evidence; retry is never automatic.",
    parameters: Type.Object({
      executionId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 1 }),
      operationId: Type.String(),
      resolution: Type.Union([
        Type.Literal("retry"),
        Type.Literal("accept"),
        Type.Literal("fail"),
      ]),
      evidence: Type.String({ maxLength: 4096 }),
      outputDigest: Type.Optional(Type.String({ maxLength: 4096 })),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const current = context(scope);
        const record = resolveUnknownExecutionOperation({
          cwd: current.cwd,
          parentSessionId: current.parentSessionId,
          owner: current.owner,
          ...params,
        });
        return {
          content: [{ type: "text", text: summarize(record) }],
          details: {
            status: record.status,
            executionId: record.executionId,
            revision: record.revision,
          },
        };
      } catch (error) {
        return errorResult(error, params.executionId);
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "resume_ralplan_execution",
    label: "Resume RALPLAN Execution",
    description:
      "Explicitly rebind an interrupted execution to the current owner after all unknown operations are resolved. Does not start tasks; call run separately.",
    parameters: Type.Object({
      executionId: Type.String(),
      expectedRevision: Type.Integer({ minimum: 1 }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const current = context(scope);
        const record = resumeExecutionRecord({ ...current, ...params });
        return {
          content: [
            {
              type: "text",
              text: `${summarize(record)}\nRebound only; execution has not started.`,
            },
          ],
          details: {
            status: record.status,
            executionId: record.executionId,
            revision: record.revision,
            executionStarted: false,
          },
        };
      } catch (error) {
        return errorResult(error, params.executionId);
      }
    },
  });
}

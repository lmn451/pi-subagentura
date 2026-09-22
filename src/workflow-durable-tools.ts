import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DurableWorkflow } from "./workflow-durable";
import {
  WorkflowRunStore,
  encodeRunValue,
  decodeRunValue,
  type RunScope,
  type RunEvent,
} from "./workflow-run-store";
import { stopDurableProcessAttempts } from "./workflow-durable-process";
import {
  DEFAULT_WORKFLOW_OUTPUT_BUDGET,
  WORKFLOW_WALL_TIMEOUT_MS,
  defaultConcurrency,
  defaultProcessConcurrency,
  loadWorkflowScript,
  parseWorkflow,
  type WorkflowAgentRunner,
  type WorkflowRunResult,
} from "./workflow-core";
import {
  startWorkflowJob,
  type WorkflowJobState,
  getWorkflowJobForOwner,
} from "./workflow-jobs";
import {
  resolveLiveSessionScope,
  isSessionOwnerLive,
  type SessionOwnerToken,
} from "./session-scope";
import {
  resolveCompletionPolicy,
  registerCompletionMember,
  reserveCompletionGroup,
  releaseCompletionGroup,
  consumeCompletionSource,
  restoreDurableCompletionGroups,
  publishCompletion,
  type ResolvedCompletionPolicy,
} from "./completion-coordinator";
import { registerToolWithDefaultGuidance } from "./tool-guidance";
import { getOrchestrationContext } from "./orchestration-context";
import { renderProgress } from "./workflow-ui";
import { stringify } from "./workflow-worker";
import { completionDisplayLabel } from "./completion-presentation";

function terminal(events: RunEvent[]) {
  return (
    events.findLast((e) => e.kind === "cancelled") ??
    events.findLast((e) => e.kind === "terminal")
  );
}

export function durableRunSummary(id: string, events: RunEvent[]) {
  const end = terminal(events);
  const interrupted = events.findLast(
    (e) => e.kind === "interrupted" && e.data.error,
  );
  const progress = events.findLast((e) => e.kind === "progress")?.data;
  const result = end?.data.result
    ? decodeRunValue<WorkflowRunResult>(end.data.result)
    : undefined;
  return {
    workflowId: id,
    name: parseWorkflow(events[0].data.script).meta.name,
    durable: true,
    status: end?.data.status ?? "interrupted",
    createdAt: events[0].data.createdAt,
    completedAt: end?.data.completedAt,
    operations: events.filter((e) => e.kind === "request").length,
    committedResponses: events.filter((e) => e.kind === "response").length,
    agentsSpawned:
      result?.agentsSpawned ??
      Math.max(
        events.filter((e) => e.kind === "dispatch").length,
        events.filter((e) => e.kind === "attempt").length,
      ),
    usage: result?.usage ?? end?.data.usage ?? interrupted?.data.usage,
    usageAccuracy: events.some((e) => e.kind === "interrupted")
      ? "lower_bound"
      : "recorded",
    currentPhase: progress?.phase,
    error: end ? end.data.error : interrupted?.data.error,
    cancellationRequested:
      end?.kind === "cancelled" || end?.data.status === "cancelled",
  };
}

export function registerDurableWorkflowTools(
  pi: ExtensionAPI,
  owner: () => SessionOwnerToken | undefined,
  makeRunAgent: (
    ctx: any,
    id: string,
    runAsync: boolean,
    completion: ResolvedCompletionPolicy,
  ) => WorkflowAgentRunner,
  notify: (job: WorkflowJobState) => boolean,
  /** Private fixture root; production callers use the user-owned run store. */
  storeRoot?: string,
) {
  function scope(ctx?: any): RunScope {
    const live = resolveLiveSessionScope(owner());
    const cwd = ctx?.cwd ?? live?.cwd;
    const sessionId =
      ctx?.sessionManager?.getSessionId?.() ??
      live?.sessionManager?.getSessionId?.();
    if (!live || !cwd || !sessionId)
      throw new Error(
        "Durable workflows require a live parent Pi session and working directory.",
      );
    return { cwd, sessionId, root: storeRoot };
  }

  async function inspect(
    id: string,
    ctx?: any,
    result = false,
  ): Promise<any | undefined> {
    if (!id.startsWith("wfd_")) return undefined;
    try {
      const events = await WorkflowRunStore.inspect(scope(ctx), id);
      if (!events) return undefined;
      const details = durableRunSummary(id, events);
      const end = terminal(events);
      if (result && end) {
        consumeCompletionSource(
          pi,
          { source: "workflow", sourceId: id },
          owner(),
        );
      }
      const run =
        result && end?.data.result
          ? decodeRunValue<WorkflowRunResult>(end.data.result)
          : undefined;
      return {
        content: [
          {
            type: "text",
            text: run
              ? stringify(run.result)
              : `Workflow ${id}: ${details.status}.${details.error ? ` ${details.error}` : ""}${end ? "" : " Use resume_workflow to continue the recorded program; no controller is running in this parent session."}`,
          },
        ],
        details,
        ...(result && details.status !== "done" ? { isError: true } : {}),
      };
    } catch (error) {
      return failure(error);
    }
  }

  function failure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Workflow not run: ${message}` }],
      details: { status: "error", error: message },
      isError: true,
    };
  }

  async function run(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
    invocation: "tool" | "saved_command" = "tool",
  ): Promise<any> {
    let store: WorkflowRunStore | undefined;
    let accepted = false;
    let reservation: ReturnType<typeof reserveCompletionGroup>;
    try {
      if (getOrchestrationContext())
        throw new Error(
          "Durable workflows cannot run inside an in-process sub-agent.",
        );
      const runScope = scope(ctx);
      const workflowOwner = owner();
      if (signal?.aborted) throw new Error("Workflow start was cancelled.");
      const runAsync = params.async !== false;
      let completion: ResolvedCompletionPolicy;
      if (params.workflowId) {
        if (
          getWorkflowJobForOwner(params.workflowId, workflowOwner)?.status ===
          "running"
        )
          throw new Error("Workflow is already running.");
        store = await WorkflowRunStore.resume(runScope, params.workflowId);
        if (terminal(store.events))
          throw new Error(
            "Workflow is already terminal. Inspect its result or start a new run.",
          );
        if (!store.events.some((event) => event.kind === "accepted"))
          throw new Error(
            "Workflow start was interrupted before acceptance. Start a new run.",
          );
        completion =
          store.events.findLast((event) => event.kind === "delivery")?.data
            .completion ?? store.events[0].data.completion;
        if (runAsync && !completion.policy)
          completion = { legacy: false, policy: "each" };
      } else {
        if (
          !runAsync &&
          (params.completionPolicy !== undefined ||
            params.completionGroupId !== undefined)
        )
          throw new Error(
            "Completion groups apply only to background workflows.",
          );
        completion = runAsync
          ? resolveCompletionPolicy(params)
          : { legacy: false };
        const script =
          params.script ??
          (params.name ? loadWorkflowScript(params.name) : null);
        if (!script)
          throw new Error("Provide a workflow script or saved name.");
        parseWorkflow(script);
        const budgetTotal = params.budget ?? DEFAULT_WORKFLOW_OUTPUT_BUDGET;
        if (!Number.isFinite(budgetTotal) || budgetTotal <= 0)
          throw new Error(
            "Durable workflow budget must be positive and finite.",
          );
        store = await WorkflowRunStore.create(runScope, {
          script,
          args: encodeRunValue(params.args),
          budgetTotal,
          completion,
          concurrency: defaultConcurrency(),
          processConcurrency: defaultProcessConcurrency(),
          workflowTimeoutMs: WORKFLOW_WALL_TIMEOUT_MS,
          defaultModel: ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : undefined,
        });
      }
      if (!isSessionOwnerLive(workflowOwner) || signal?.aborted)
        throw new Error("Parent session changed before workflow acceptance.");
      const durable = new DurableWorkflow(store);
      const definition = durable.definition;
      reservation = params.workflowId
        ? undefined
        : reserveCompletionGroup(
            completion.policy,
            completion.groupId,
            workflowOwner,
          );
      registerCompletionMember(
        "workflow",
        store.id,
        completion.policy ?? "each",
        completion.groupId,
        workflowOwner,
        reservation,
      );
      if (!params.workflowId) await store.append("accepted", {});
      else
        await store.append("interrupted", {
          status: "resuming",
          resumedAt: Date.now(),
        });
      await store.append("delivery", { completion });
      const baseRunner = makeRunAgent(ctx, store.id, runAsync, completion);
      const job = startWorkflowJob(
        parseWorkflow(definition.script).meta.name,
        definition.script,
        {
          args: decodeRunValue(definition.args),
          cwd: definition.cwd,
          durable,
          budgetTotal: definition.budgetTotal,
          concurrency: definition.concurrency,
          processConcurrency: definition.processConcurrency,
          workflowTimeoutMs: Math.max(
            1,
            definition.workflowTimeoutMs - (Date.now() - definition.createdAt),
          ),
          runAgent: (request) =>
            baseRunner({
              ...request,
              model: request.model ?? definition.defaultModel,
            }),
          loadWorkflow: loadWorkflowScript,
          signal: runAsync ? undefined : signal,
          onProgress: (progress) => {
            if (progress.kind === "phase") {
              void store!
                .append("progress", { phase: progress.phase.slice(0, 1024) })
                .catch((error) => job.abort.abort(error));
            }
            onUpdate?.({
              content: [{ type: "text", text: renderProgress(progress) }],
              details: { status: "running", workflowId: store!.id },
            });
          },
        },
        definition.createdAt,
        runAsync
          ? notify
          : completion.policy
            ? (job) => {
                consumeCompletionSource(
                  pi,
                  { source: "workflow", sourceId: job.id },
                  workflowOwner,
                );
                return notify(job);
              }
            : undefined,
        workflowOwner,
        runAsync ? "async" : "sync",
        {
          invocation,
          async: runAsync,
          completionPolicy: runAsync ? (completion.policy ?? "each") : "inline",
        },
        store.id,
      );
      job.completionPolicy =
        completion.policy ?? (runAsync ? "each" : undefined);
      job.completionGroupId = completion.groupId;
      accepted = true;
      if (runAsync)
        return {
          content: [
            {
              type: "text",
              text: `Durable workflow started as ${store.id}. The current Pi process drives it; after interruption use resume_workflow in this same Pi session and cwd. Agent side effects are not exactly-once.`,
            },
          ],
          details: { status: "started", workflowId: store.id, durable: true },
        };
      const result = await job.promise;
      if (completion.policy)
        consumeCompletionSource(
          pi,
          { source: "workflow", sourceId: job.id },
          workflowOwner,
        );
      return {
        content: [{ type: "text", text: stringify(result.result) }],
        details: {
          status: "done",
          workflowId: job.id,
          durable: true,
          usage: result.usage,
        },
      };
    } catch (error) {
      return failure(error);
    } finally {
      if (!accepted) {
        releaseCompletionGroup(reservation);
        await store?.close();
      }
    }
  }

  async function cancel(id: string, ctx?: any): Promise<any | undefined> {
    if (!id.startsWith("wfd_")) return undefined;
    let store;
    try {
      store = await WorkflowRunStore.resume(scope(ctx), id);
      if (terminal(store.events)) return await inspect(id, ctx);
      await store.append("cancelled", {
        status: "cancelled",
        completedAt: Date.now(),
      });
      // A persistent cancel request is consumed by each exact attempt supervisor;
      // never kill a potentially recycled mux pane ID recovered from old disk state.
      await stopDurableProcessAttempts(store.directory);
      return {
        content: [
          {
            type: "text",
            text: `Workflow ${id}: cancellation requested. Already-performed external effects cannot be undone.`,
          },
        ],
        details: {
          status: "cancelled",
          workflowId: id,
          cancellationRequested: true,
        },
      };
    } catch (error) {
      return failure(error);
    } finally {
      await store?.close();
    }
  }

  registerToolWithDefaultGuidance(pi, {
    name: "resume_workflow",
    label: "Resume Workflow",
    description:
      "Explicitly resume an interrupted durable code workflow in the same host, cwd, and Pi session. Replays recorded outcomes; interrupted uncommitted agent work may repeat side effects. No daemon or exactly-once guarantee.",
    parameters: Type.Object({
      workflowId: Type.String(),
      async: Type.Optional(Type.Boolean()),
    }),
    execute: (
      _id: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) => run(params, signal, onUpdate, ctx),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "list_workflow_runs",
    label: "Workflow Runs",
    description:
      "List persisted durable runs belonging to this exact Pi session and working directory. Does not resume work.",
    parameters: Type.Object({}),
    async execute(
      _id: string,
      _params: any,
      _signal: any,
      _update: any,
      ctx: any,
    ): Promise<any> {
      try {
        const runScope = scope(ctx);
        const ids = await WorkflowRunStore.list(runScope);
        const runs = [];
        for (const id of ids) {
          const events = await WorkflowRunStore.inspect(runScope, id);
          if (events)
            runs.push({
              ...durableRunSummary(id, events),
              ...(getWorkflowJobForOwner(id, owner())?.status === "running"
                ? { status: "running" }
                : {}),
            });
        }
        return {
          content: [
            {
              type: "text",
              text: runs.length
                ? runs
                    .map((r) => `${r.workflowId} ${r.name}: ${r.status}`)
                    .join("\n")
                : "No durable workflow runs in this Pi session.",
            },
          ],
          details: { runs },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
  registerToolWithDefaultGuidance(pi, {
    name: "inspect_workflow",
    label: "Inspect Workflow",
    description:
      "Read and parse a saved workflow's source without executing agents. Saving a definition alone does not enable durability.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const source = loadWorkflowScript(params.name);
        if (!source) throw new Error("Saved workflow not found.");
        const { meta } = parseWorkflow(source);
        return {
          content: [{ type: "text", text: source }],
          details: { name: params.name, meta, valid: true },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
  return { run, inspect, cancel };
}

export async function restoreDurableWorkflowRuns(
  pi: ExtensionAPI,
  currentOwner: SessionOwnerToken,
  ctx: any,
): Promise<void> {
  try {
    await restoreDurableCompletionGroups(currentOwner);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId || !ctx.cwd) return;
    const runScope = { sessionId, cwd: ctx.cwd };
    for (const id of await WorkflowRunStore.list(runScope)) {
      if (!isSessionOwnerLive(currentOwner)) return;
      const events = await WorkflowRunStore.inspect(runScope, id);
      if (!events) continue;
      const end = terminal(events);
      const completion =
        events.findLast((event) => event.kind === "delivery")?.data
          .completion ?? events[0].data.completion;
      if (!end || !completion?.policy) continue;
      publishCompletion(
        {
          schemaVersion: 1,
          completionId: `workflow:${id}`,
          source: "workflow",
          sourceId: id,
          label: completionDisplayLabel(
            parseWorkflow(events[0].data.script).meta.name,
            "workflow",
          ),
          status:
            end.data.status === "done"
              ? end.data.result &&
                decodeRunValue<WorkflowRunResult>(end.data.result).errorCount >
                  0
                ? "error"
                : "done"
              : end.data.status === "cancelled"
                ? "cancelled"
                : "error",
          policy: completion.policy,
          ...(completion.groupId ? { groupId: completion.groupId } : {}),
          references: [
            {
              label: "result",
              value: `call get_workflow_result with workflowId ${JSON.stringify(id)}`,
            },
          ],
          completedAt: end.data.completedAt,
        },
        currentOwner,
      );
    }
  } catch (error) {
    ctx.ui?.notify?.(
      `Durable workflow recovery needs attention: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }
}

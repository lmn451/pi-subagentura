import { homedir } from "node:os";
import {
  DurableWorkflowDeliveryEvidencePendingError,
  dispatchDurableWorkflowDeliveryAwaitingEvidence,
  durableWorkflowDeliveryIdsFromEntries,
  type DurableWorkflowDeliverySender,
} from "./workflow-delivery";
import type { WorkflowAgentRunner } from "./workflow-core";
import {
  DurableWorkflowPlanController,
  type DurableWorkflowPlanInterruptionReason,
  type DurableWorkflowPlanOpenResult,
} from "./workflow-durable-plan";
import { restoreRecoveredDurableWorkflowJobs } from "./workflow-jobs";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowRunStoreOptions,
} from "./workflow-run-store";
import type { DurableWorkflowRunId } from "./workflow-run-types";
import type { SessionScope } from "./session-scope";

export type DurableWorkflowRunAgentFactory = (
  runId: DurableWorkflowRunId,
  context: DurableWorkflowSessionContext,
) => WorkflowAgentRunner;

export interface DurableWorkflowRuntimeOptions {
  readonly homeDir?: string;
  readonly storeOptions?: Omit<WorkflowRunStoreOptions, "homeDir">;
  readonly resolveRealPath?: (path: string) => Promise<string>;
  readonly delivery?: DurableWorkflowDeliverySender;
  /** Namespace-wide cap for durable in-process agent dispatches. */
  readonly concurrency?: number;
  /** Namespace-wide cap for durable process-backed agent dispatches. */
  readonly processConcurrency?: number;
}

export interface DurableWorkflowSessionContext {
  readonly cwd?: string;
  readonly sessionManager?: {
    getSessionId?: () => string;
    getEntries?: () => readonly unknown[];
  };
}

interface DurableWorkflowRegistration {
  readonly factory: DurableWorkflowRunAgentFactory;
  readonly options: DurableWorkflowRuntimeOptions;
}

interface DurableWorkflowRuntime {
  readonly controller: DurableWorkflowPlanController;
  readonly generation: number;
  readonly delivery?: DurableWorkflowDeliverySender;
  deliveryEnabled: boolean;
  deliveryDirty: boolean;
  openResult?: DurableWorkflowPlanOpenResult;
  flushing?: Promise<void>;
  stopping?: Promise<void>;
}

const registrations = new WeakMap<SessionScope, DurableWorkflowRegistration>();
const runtimes = new WeakMap<SessionScope, DurableWorkflowRuntime>();

export function registerDurableWorkflowRunAgentFactory(
  scope: SessionScope,
  factory: DurableWorkflowRunAgentFactory,
  options: DurableWorkflowRuntimeOptions = {},
): void {
  registrations.set(scope, { factory, options });
}

export function getDurableWorkflowPlanController(
  scope: SessionScope,
): DurableWorkflowPlanController | undefined {
  return runtimes.get(scope)?.controller;
}

export async function startDurableWorkflowSession(
  scope: SessionScope,
  eventReason: string,
  ctx: DurableWorkflowSessionContext,
): Promise<DurableWorkflowPlanOpenResult | undefined> {
  if (runtimes.has(scope)) {
    await stopDurableWorkflowSession(scope, "owner_replaced");
  }

  const registration = registrations.get(scope);
  const cwd = ctx.cwd;
  const piSessionId = sessionId(ctx);
  if (
    registration === undefined ||
    cwd === undefined ||
    piSessionId === undefined
  ) {
    return undefined;
  }

  let owner;
  try {
    owner = await deriveDurableWorkflowOwner(
      cwd,
      piSessionId,
      registration.options.resolveRealPath,
    );
  } catch {
    return undefined;
  }

  const store = new WorkflowRunStore({
    ...registration.options.storeOptions,
    retention: registration.options.storeOptions?.retention ?? {},
    homeDir: registration.options.homeDir ?? homedir(),
  });
  let runtime: DurableWorkflowRuntime | undefined;
  const controller = await DurableWorkflowPlanController.acquire({
    store,
    owner,
    scopeId: scope.id,
    generation: scope.generation,
    concurrency: registration.options.concurrency,
    processConcurrency: registration.options.processConcurrency,
    runAgentForRun: (runId) => registration.factory(runId, ctx),
    onDeliveryReady: () =>
      runtime === undefined
        ? undefined
        : flushDurableWorkflowRuntime(scope, runtime),
    onPlanMutationWake: (runId) => {
      if (runtime === undefined) return;
      void runtime.controller.wakePlan(runId).catch((error) => {
        console.error("[subagentura] durable workflow wake failed", error);
      });
    },
  });
  runtime = {
    controller,
    generation: scope.generation,
    deliveryEnabled: true,
    deliveryDirty: false,
    ...(registration.options.delivery === undefined
      ? {}
      : {
          delivery: {
            dispatch: registration.options.delivery.dispatch,
            existingEntries: () =>
              registration.options.delivery?.existingEntries?.() ??
              ctx.sessionManager?.getEntries?.() ??
              [],
          },
        }),
  };
  runtimes.set(scope, runtime);

  if (!isRecoveryReason(eventReason)) return undefined;

  try {
    const openResult = await controller.open(eventReason);
    runtime.openResult = openResult;
    const recoveredRuns = await Promise.all(
      openResult.recovery.runs.map(async (recovered) => {
        const projection = await controller.getProjection(recovered.runId);
        return projection === undefined
          ? recovered
          : Object.freeze({ ...recovered, projection });
      }),
    );
    restoreRecoveredDurableWorkflowJobs(recoveredRuns, openResult.completions, {
      id: scope.id,
      generation: scope.generation,
    });
    try {
      await flushDurableWorkflowRuntime(scope, runtime);
    } catch (error) {
      // Delivery intent is already durable. Keep the recovered controller live
      // so a later session trigger can retry instead of stranding the outbox
      // until another restart.
      console.error("[subagentura] durable workflow delivery failed", error);
    }
    for (const execution of openResult.completions) {
      void execution.completion.catch(() => undefined);
    }
    return openResult;
  } catch (error) {
    runtime.deliveryEnabled = false;
    if (runtimes.get(scope) === runtime) runtimes.delete(scope);
    await controller.release().catch(() => undefined);
    throw error;
  }
}
export function flushDurableWorkflowDeliveries(
  scope: SessionScope,
): Promise<void> {
  const runtime = runtimes.get(scope);
  return runtime === undefined
    ? Promise.resolve()
    : flushDurableWorkflowRuntime(scope, runtime);
}

export async function stopDurableWorkflowSession(
  scope: SessionScope,
  reason: string | undefined,
): Promise<void> {
  const runtime = runtimes.get(scope);
  if (runtime === undefined) return;
  if (runtime.stopping !== undefined) return runtime.stopping;
  runtime.deliveryEnabled = false;

  const stopping = (async () => {
    await runtime.flushing?.catch(() => undefined);
    let interruptionError: unknown;
    try {
      await runtime.controller.interrupt(interruptionReason(reason));
    } catch (error) {
      interruptionError = error;
    }

    try {
      await runtime.controller.release();
    } finally {
      if (runtimes.get(scope) === runtime) runtimes.delete(scope);
    }

    if (interruptionError !== undefined) throw interruptionError;
  })();
  runtime.stopping = stopping;
  return stopping;
}

async function flushDurableWorkflowRuntime(
  scope: SessionScope,
  runtime: DurableWorkflowRuntime,
): Promise<void> {
  if (!durableWorkflowRuntimeIsLive(scope, runtime)) return;
  if (runtime.flushing !== undefined) {
    runtime.deliveryDirty = true;
    return runtime.flushing;
  }

  const flushing = (async () => {
    do {
      runtime.deliveryDirty = false;
      await reconcileDurableWorkflowDeliveryEvidence(scope, runtime);
    } while (
      runtime.deliveryDirty &&
      durableWorkflowRuntimeIsLive(scope, runtime)
    );
  })();
  runtime.flushing = flushing;
  try {
    await flushing;
  } finally {
    if (runtime.flushing === flushing) runtime.flushing = undefined;
  }
}

async function reconcileDurableWorkflowDeliveryEvidence(
  scope: SessionScope,
  runtime: DurableWorkflowRuntime,
): Promise<void> {
  const sender = runtime.delivery;
  if (sender === undefined) {
    await runtime.controller.reconcileDeliveries();
    return;
  }

  while (durableWorkflowRuntimeIsLive(scope, runtime)) {
    try {
      await runtime.controller.reconcileDeliveries({
        existingEntries: sender.existingEntries,
        dispatch: (message) => {
          if (!durableWorkflowRuntimeIsLive(scope, runtime)) {
            throw new Error(
              "Durable workflow delivery belongs to a stale session generation.",
            );
          }
          dispatchDurableWorkflowDeliveryAwaitingEvidence(sender, message);
        },
      });
      return;
    } catch (error) {
      if (!(error instanceof DurableWorkflowDeliveryEvidencePendingError)) {
        throw error;
      }
      const observed = durableWorkflowDeliveryIdsFromEntries(
        sender.existingEntries?.() ?? [],
      );
      if (!error.deliveryIds.every((deliveryId) => observed.has(deliveryId))) {
        return;
      }
      // The next serialized reconciliation sees the custom entry in its
      // initial snapshot and records a pi-session-entry receipt without
      // dispatching the deterministic delivery again.
    }
  }
}

function durableWorkflowRuntimeIsLive(
  scope: SessionScope,
  runtime: DurableWorkflowRuntime,
): boolean {
  return (
    runtime.deliveryEnabled &&
    runtime.generation === scope.generation &&
    runtimes.get(scope) === runtime
  );
}

function sessionId(ctx: DurableWorkflowSessionContext): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionId?.();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecoveryReason(
  reason: string,
): reason is "startup" | "reload" | "resume" {
  return reason === "startup" || reason === "reload" || reason === "resume";
}

function interruptionReason(
  reason: string | undefined,
): DurableWorkflowPlanInterruptionReason {
  if (reason === "reload" || reason === "resume") return "reload";
  if (reason === "quit") return "quit";
  if (reason === "owner_replaced" || reason === "new" || reason === "fork") {
    return "owner_replaced";
  }
  return "process_crash";
}

import type { WorkflowOwnerIdentity } from "./workflow-run-types";
import { WorkflowRunStore } from "./workflow-run-store";
import {
  DurableWorkflowController,
  runDurableWorkflowPlan,
  type DurableWorkflowPlanOptions,
} from "./workflow-durable-plan-runner";
import type {
  DurableWorkflowDeliveryMessage,
  WorkflowDeliveryTransport,
} from "./workflow-durable-delivery";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import type { SessionScope } from "./session-scope";
import { WorkflowSessionDispatcher } from "./workflow-dispatcher";
import { workflowContinuitySnapshot } from "./workflow-continuity";
import type { WorkflowProjection } from "./workflow-projection-repository";

export interface WorkflowOwnerIdentityInput {
  projectKey: string;
  cwd: string;
  piSessionId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseToken: string;
}

/** Construct the complete durable owner fence from host-provided identity. */
export function createWorkflowOwnerIdentity(
  input: WorkflowOwnerIdentityInput,
): WorkflowOwnerIdentity {
  for (const [label, value] of Object.entries(input)) {
    if (label === "ownerGeneration") continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      throw new Error(`Invalid workflow owner ${label}`);
    }
  }
  if (
    !Number.isSafeInteger(input.ownerGeneration) ||
    input.ownerGeneration < 0
  ) {
    throw new Error("Invalid workflow owner generation");
  }
  return { ...input };
}

export function createWorkflowRunStore(
  rootDir: string,
  input: WorkflowOwnerIdentityInput,
): WorkflowRunStore {
  if (!rootDir || rootDir.length > 500) {
    throw new Error("Invalid workflow store root directory");
  }
  return new WorkflowRunStore({
    rootDir,
    owner: createWorkflowOwnerIdentity(input),
  });
}

export function createDurableWorkflowController(
  rootDir: string,
  input: WorkflowOwnerIdentityInput,
): DurableWorkflowController {
  const owner = createWorkflowOwnerIdentity(input);
  return new DurableWorkflowController({
    store: new WorkflowRunStore({ rootDir, owner }),
    owner,
  });
}

export function durableWorkflowDispatcherForSession(
  scope: SessionScope,
  maxConcurrent?: number,
): WorkflowSessionDispatcher {
  if (!scope.durableWorkflowDispatcher) {
    scope.durableWorkflowDispatcher = new WorkflowSessionDispatcher({
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    });
  }
  return scope.durableWorkflowDispatcher;
}

function sessionScopeDurableStore(
  rootDir: string,
  scope: SessionScope,
): WorkflowRunStore | undefined {
  const owner = scope.durableWorkflowOwner;
  if (!owner) return undefined;
  if (!scope.durableWorkflowStore) {
    scope.durableWorkflowStore = new WorkflowRunStore({ rootDir, owner });
  }
  return scope.durableWorkflowStore;
}

export function durableWorkflowControllerForSession(
  rootDir: string,
  scope: SessionScope,
): DurableWorkflowController | undefined {
  const owner = scope.durableWorkflowOwner;
  if (!owner) return undefined;
  if (!scope.durableWorkflowController) {
    const store = sessionScopeDurableStore(rootDir, scope);
    if (!store) return undefined;
    scope.durableWorkflowController = new DurableWorkflowController({
      store,
      owner,
      deliveryTransport: sessionWorkflowDeliveryTransport(scope),
    });
  }
  return scope.durableWorkflowController;
}

function sessionWorkflowDeliveryTransport(
  scope: SessionScope,
): WorkflowDeliveryTransport {
  return {
    send: async (
      delivery: DurableWorkflowDeliveryMessage,
      idempotencyKey: string,
    ): Promise<void> => {
      const sendMessage = scope.pi.sendMessage;
      if (typeof sendMessage !== "function") {
        throw new Error("Parent-session workflow delivery is unavailable.");
      }
      await Promise.resolve(
        sendMessage.call(
          scope.pi,
          {
            customType: "workflow-notify",
            content: delivery.message,
            display: true,
            details: {
              workflowId: delivery.runId,
              status: delivery.status,
              durable: true,
              deliveryId: delivery.deliveryId,
              idempotencyKey,
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        ),
      );
    },
    getPersistedEntries: () => scope.sessionManager?.getEntries?.() ?? [],
  };
}

export async function dispatchTerminalDeliveryForSession(
  rootDir: string,
  scope: SessionScope,
  projection: WorkflowProjection,
): Promise<WorkflowProjection> {
  if (
    !projection.terminal ||
    !projection.delivery ||
    projection.delivery.status === "delivered"
  ) {
    return projection;
  }
  const controller = durableWorkflowControllerForSession(rootDir, scope);
  if (!controller) return projection;
  return (
    (await controller.dispatchDelivery(
      projection.runId,
      projection.delivery.deliveryId,
    )) ?? projection
  );
}

export function durableWorkflowStoreForSession(
  rootDir: string,
  scope: SessionScope,
): WorkflowRunStore | undefined {
  return sessionScopeDurableStore(rootDir, scope);
}

export function runDurableWorkflowForSession(
  rootDir: string,
  scope: SessionScope,
  options: Omit<DurableWorkflowPlanOptions, "store" | "owner">,
): Promise<Awaited<ReturnType<typeof runDurableWorkflowPlan>>> {
  const owner = scope.durableWorkflowOwner;
  if (!owner) throw new Error("Durable workflow storage is unavailable.");
  const store = sessionScopeDurableStore(rootDir, scope);
  if (!store) throw new Error("Durable workflow storage is unavailable.");
  const onProjection = (projection: WorkflowProjection): void => {
    scope.durableWorkflowContinuity = workflowContinuitySnapshot(
      projection,
      options.plan,
    );
    options.onProjection?.(projection);
  };
  return runDurableWorkflowPlan({
    ...options,
    onProjection,
    store,
    owner,
    dispatcher: durableWorkflowDispatcherForSession(scope),
  }).then(async (projection) => {
    try {
      return await dispatchTerminalDeliveryForSession(
        rootDir,
        scope,
        projection,
      );
    } catch {
      return projection;
    }
  });
}

export interface DurableWorkflowResumeOptions {
  runId: string;
  runAgent: DurableWorkflowPlanOptions["runAgent"];
  signal?: AbortSignal;
  onProjection?: DurableWorkflowPlanOptions["onProjection"];
}

/** Resume a run using only the declarative plan persisted in run_created. */
export async function resumeDurableWorkflowForSession(
  rootDir: string,
  scope: SessionScope,
  options: DurableWorkflowResumeOptions,
): Promise<Awaited<ReturnType<typeof runDurableWorkflowPlan>>> {
  const owner = scope.durableWorkflowOwner;
  if (!owner) throw new Error("Durable workflow storage is unavailable.");
  const store = sessionScopeDurableStore(rootDir, scope);
  if (!store) throw new Error("Durable workflow storage is unavailable.");
  const record = await store.readRun(options.runId);
  const created = record.events.find((event) => event.type === "run_created");
  const payload = created?.payload;
  if (!payload || typeof payload !== "object" || !("plan" in payload)) {
    throw new Error("Durable workflow run has no persisted declarative plan.");
  }
  const plan = (payload as { plan?: unknown }).plan;
  validateWorkflowPlan(plan as WorkflowPlan);
  const onProjection = (projection: WorkflowProjection): void => {
    scope.durableWorkflowContinuity = workflowContinuitySnapshot(
      projection,
      plan as WorkflowPlan,
    );
    options.onProjection?.(projection);
  };
  return runDurableWorkflowPlan({
    runId: options.runId,
    plan: plan as WorkflowPlan,
    runAgent: options.runAgent,
    signal: options.signal,
    onProjection,
    resume: true,
    store,
    owner,
    dispatcher: durableWorkflowDispatcherForSession(scope),
  }).then(async (projection) => {
    try {
      return await dispatchTerminalDeliveryForSession(
        rootDir,
        scope,
        projection,
      );
    } catch {
      return projection;
    }
  });
}

export const resumeDurableWorkflowFromPersistedPlan =
  resumeDurableWorkflowForSession;

export function workflowOwnerFromSessionContext(input: {
  projectKey: string;
  cwd: string;
  sessionId: string;
  ownerId: string;
  generation: number;
  leaseToken: string;
}): WorkflowOwnerIdentity {
  return createWorkflowOwnerIdentity({
    projectKey: input.projectKey,
    cwd: input.cwd,
    piSessionId: input.sessionId,
    ownerId: input.ownerId,
    ownerGeneration: input.generation,
    leaseToken: input.leaseToken,
  });
}

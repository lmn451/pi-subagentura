import type {
  WorkflowEventEnvelope,
  WorkflowRunLaunch,
  WorkflowRunStatus,
  WorkflowTerminalResult,
  WorkflowDeliveryIntent,
  WorkflowDeliveryClaim,
  WorkflowApprovalRequest,
  WorkflowApprovalDecision,
  WorkflowCancellationRequest,
} from "./workflow-run-types";
import {
  verifyMutationPayload,
  type WorkflowTaskClaim,
} from "./workflow-mutation";

export type { WorkflowTaskClaim } from "./workflow-mutation";

export interface WorkflowProjectionTask {
  id: string;
  status:
    "pending" | "blocked" | "running" | "succeeded" | "failed" | "skipped";
  attempt: number;
  phaseId?: string;
  prompt?: string;
  label?: string;
  approval?: { policyHash: string; denial: "stop" | "skip" };
  result?: unknown;
  error?: string;
  claim?: WorkflowTaskClaim;
}
export interface WorkflowProjectionBlockers {
  budget?: { reason?: string };
  approval?: {
    requestId?: string;
    reason?: string;
    source: "approval";
  };
  runtime?: { reason: string };
  tasks: Record<string, { reason?: string }>;
  claims: Record<string, WorkflowTaskClaim>;
}

export interface WorkflowProjection {
  runId: string;
  planRevision: number;
  owner: WorkflowRunLaunch["owner"];
  status: WorkflowRunStatus;
  revision: number;
  currentPhase?: string;
  tasks: Record<string, WorkflowProjectionTask>;
  blockers: WorkflowProjectionBlockers;
  terminal?: WorkflowTerminalResult;
  usage: { input: number; output: number };
  usageLowerBound?: boolean;
  lastEventOrdinal: number;
  delivery?: WorkflowDeliveryIntent;
  cancellation?: WorkflowCancellationRequest;
  approval?: {
    request: WorkflowApprovalRequest;
    status: "pending" | "approved" | "rejected";
    decision?: WorkflowApprovalDecision;
  };
  runBlock?: { reason: string; source: "approval" | "runtime" };
  cancellationRequested?: boolean;
  mutationHash?: string;
}

/** Read-only authority used by status, result, and tree projections. */
export interface WorkflowProjectionRepository {
  get(runId: string): Promise<WorkflowProjection | undefined>;
  list(): Promise<readonly WorkflowProjection[]>;
}

type Event = WorkflowEventEnvelope<string, any>;

export function projectWorkflowRun(
  launch: WorkflowRunLaunch,
  events: readonly Event[],
): WorkflowProjection {
  const projection: WorkflowProjection = {
    runId: launch.runId,
    planRevision: launch.planRevision,
    owner: launch.owner,
    status: "created",
    revision: 0,
    tasks: Object.create(null) as Record<string, WorkflowProjectionTask>,
    blockers: { tasks: {}, claims: {} },
    usage: { input: 0, output: 0 },
    lastEventOrdinal: -1,
  };

  const appliedEventIds = new Set<string>();
  const usageKeys = new Set<string>();
  let mutationHash = "";
  let currentRunEpoch = 0;

  for (const [ordinal, event] of events.entries()) {
    const eventEpoch = Number.isSafeInteger(event.runEpoch)
      ? event.runEpoch
      : 0;
    if (eventEpoch < currentRunEpoch) continue;
    if (eventEpoch > currentRunEpoch) currentRunEpoch = eventEpoch;
    if (appliedEventIds.has(event.eventId)) continue;
    const baseRevision = projection.revision;
    const baseOrdinal = projection.lastEventOrdinal;
    projection.lastEventOrdinal = ordinal;
    if (isMutationEvent(event.type)) {
      const verification = verifyMutationPayload(
        event,
        launch.owner,
        baseRevision,
        baseOrdinal,
        mutationHash,
      );
      if (!verification.valid) continue;
      const payload = event.payload;
      if (isRecord(payload) && typeof payload.mutationHash === "string") {
        mutationHash = verification.hash;
        projection.mutationHash = verification.hash;
      }
    }
    appliedEventIds.add(event.eventId);
    projection.revision++;
    applyEvent(projection, event, usageKeys);
  }
  projection.tasks = Object.fromEntries(
    Object.entries(projection.tasks).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return projection;
}

function isMutationEvent(type: string): boolean {
  return [
    "task_blocked",
    "task_unblocked",
    "task_skipped",
    "task_appended",
  ].includes(type);
}

function applyEvent(
  projection: WorkflowProjection,
  event: Event,
  usageKeys: Set<string>,
): void {
  const payload = event.payload ?? {};
  // A task failure moves the projection to `error` before the coordinator
  // appends the richer terminal result. Keep that follow-up event applicable,
  // otherwise failed runs lose their durable error envelope during recovery.
  if (
    isTerminal(projection.status) &&
    event.type !== "run_result" &&
    event.type !== "run_terminal" &&
    event.type !== "delivery_intent" &&
    event.type !== "delivery_dispatched" &&
    event.type !== "delivery_receipt" &&
    event.type !== "run_cancelled"
  )
    return;
  switch (event.type) {
    case "run_created":
      projection.status = "created";
      for (const task of creationTasks(payload)) {
        const id = String(task.id);
        if (!projection.tasks[id]) {
          projection.tasks[id] = {
            id,
            status: "pending",
            attempt: 0,
            phaseId: String(task.phaseId),
            prompt: String(task.prompt),
            ...(task.label === undefined ? {} : { label: String(task.label) }),
            ...(isApprovalGate(task.approval)
              ? { approval: task.approval }
              : {}),
          };
        }
      }
      break;
    case "run_started":
      projection.status = "running";
      delete projection.blockers.runtime;
      refreshStatus(projection);
      break;
    case "run_awaiting_budget":
      projection.blockers.budget = {
        ...(payload.reason === undefined
          ? {}
          : { reason: String(payload.reason) }),
      };
      projection.status = "awaiting_budget";
      break;
    case "run_budget_resumed":
      delete projection.blockers.budget;
      refreshStatus(projection);
      break;
    case "approval_requested": {
      const request = payload.request as WorkflowApprovalRequest;
      projection.approval = { request, status: "pending" };
      projection.blockers.approval = {
        requestId: String(request.requestId),
        source: "approval",
      };
      if (!isTerminal(projection.status)) projection.status = "blocked";
      break;
    }
    case "approval_decided":
      if (!projection.approval) return;
      projection.approval.status = payload.status;
      projection.approval.decision = payload as WorkflowApprovalDecision;
      if (payload.status === "rejected") {
        if (projection.approval.request.denial === "skip") {
          delete projection.blockers.approval;
          refreshStatus(projection);
          break;
        }
        projection.blockers.approval = {
          requestId: projection.approval.request.requestId,
          source: "approval",
          ...(payload.reason === undefined
            ? {}
            : { reason: String(payload.reason) }),
        };
        projection.status = "blocked";
      } else {
        delete projection.blockers.approval;
        refreshStatus(projection);
      }
      break;
    case "run_cancel_requested":
      if (!projection.cancellation) {
        projection.cancellation = payload as WorkflowCancellationRequest;
      }
      break;
    case "run_cancel_requested":
    case "run_cancellation_requested":
    case "run_admission_closed":
      projection.cancellationRequested = true;
      break;
    case "task_started": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? (previous?.attempt ?? 0) + 1);
      const parsedClaim =
        payload.claim === undefined
          ? undefined
          : parseClaim(payload.claim, projection.runId, id, attempt);
      if (payload.claim !== undefined && !parsedClaim) return;
      if (previous && isTerminalTask(previous.status)) return;
      if (previous?.status === "blocked") return;
      if (previous && attempt < previous.attempt) return;
      if (
        previous?.claim &&
        attempt === previous.attempt &&
        (!parsedClaim || !sameClaim(previous.claim, parsedClaim))
      )
        return;
      projection.tasks[id] = {
        id,
        status: "running",
        attempt,
        ...definitionFields(previous),
        ...(parsedClaim === undefined ? {} : { claim: parsedClaim }),
      };
      if (parsedClaim) projection.blockers.claims[id] = parsedClaim;
      else delete projection.blockers.claims[id];
      projection.status = "running";
      projection.currentPhase = payload.phaseId ?? projection.currentPhase;
      break;
    }
    case "task_succeeded":
    case "task_done": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? previous?.attempt ?? 1);
      if (previous && attempt < previous.attempt) return;
      if (previous?.status === "succeeded") return;
      if (!settlementMatches(previous, payload.claim, attempt)) return;
      projection.tasks[id] = {
        id,
        status: "succeeded",
        attempt,
        ...definitionFields(previous),
        ...(payload.result === undefined ? {} : { result: payload.result }),
      };
      delete projection.blockers.claims[id];
      break;
    }
    case "task_failed": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? previous?.attempt ?? 1);
      if (previous && attempt < previous.attempt) return;
      if (previous && isTerminalTask(previous.status)) return;
      if (!settlementMatches(previous, payload.claim, attempt)) return;
      projection.tasks[id] = {
        id,
        status: "failed",
        attempt,
        ...definitionFields(previous),
        error: String(payload.error ?? payload.message ?? "Task failed"),
      };
      delete projection.blockers.claims[id];
      projection.status = "error";
      break;
    }
    case "task_blocked":
    case "task_unblocked":
    case "task_skipped": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      if (previous && isTerminalTask(previous.status)) return;
      const status =
        event.type === "task_blocked"
          ? "blocked"
          : event.type === "task_skipped"
            ? "skipped"
            : "pending";
      projection.tasks[id] = {
        id,
        status,
        attempt: previous?.attempt ?? 0,
        ...definitionFields(previous),
      };
      delete projection.blockers.claims[id];
      if (event.type === "task_blocked") {
        projection.blockers.tasks[id] = {
          ...(payload.reason === undefined
            ? {}
            : { reason: String(payload.reason) }),
        };
        projection.status = "blocked";
      } else {
        delete projection.blockers.tasks[id];
        refreshStatus(projection);
      }
      break;
    }
    case "task_appended": {
      const id = String(payload.taskId);
      if (projection.tasks[id]) return;
      projection.tasks[id] = {
        id,
        status: "pending",
        attempt: 0,
        phaseId: String(payload.phaseId),
        prompt: String(payload.prompt),
        ...(payload.label === undefined
          ? {}
          : { label: String(payload.label) }),
        ...(payload.input === undefined ? {} : { input: payload.input }),
      };
      break;
    }
    case "usage_observed": {
      const taskId = payload.taskId;
      const attempt = payload.attempt;
      const task =
        taskId === undefined ? undefined : projection.tasks[String(taskId)];
      if (payload.claim !== undefined) {
        const parsedClaim =
          task === undefined ||
          !task.claim ||
          !sameClaim(task.claim, payload.claim)
            ? undefined
            : parseClaim(
                payload.claim,
                projection.runId,
                String(taskId),
                Number(attempt),
              );
        if (!parsedClaim) return;
      } else if (task?.claim) return;
      const key =
        taskId === undefined || attempt === undefined
          ? event.eventId
          : `${String(taskId)}:${String(attempt)}`;
      if (usageKeys.has(key)) return;
      usageKeys.add(key);
      projection.usage.input += finite(payload.input);
      projection.usage.output += finite(payload.output);
      break;
    }
    case "run_interrupted":
      projection.status = "interrupted";
      projection.usageLowerBound = true;
      for (const [id, task] of Object.entries(projection.tasks)) {
        if (!task.claim) continue;
        const { claim: _claim, ...withoutClaim } = task;
        projection.tasks[id] = withoutClaim;
        delete projection.blockers.claims[id];
      }
      break;
    case "run_blocked": {
      const source = payload.source === "approval" ? "approval" : "runtime";
      const reason = String(payload.reason ?? "Workflow blocked");
      projection.status = "blocked";
      projection.runBlock = { reason, source };
      if (source === "approval") {
        projection.blockers.approval = {
          ...(projection.approval?.request.requestId === undefined
            ? {}
            : { requestId: projection.approval.request.requestId }),
          source: "approval",
          reason,
        };
      } else {
        projection.blockers.runtime = { reason };
      }
      break;
    }
    case "run_cancelled":
      if (!projection.terminal) {
        projection.status = "cancelled";
        projection.terminal = { status: "cancelled" };
      }
      projection.blockers.claims = {};
      break;
    case "run_result":
    case "run_terminal": {
      // Terminal state is append-only. A late or stale terminal event must not
      // replace the result already committed by the coordinator.
      if (projection.terminal) return;
      const terminal = (payload.result ?? payload) as WorkflowTerminalResult;
      projection.terminal = terminal;
      projection.status = terminal.status;
      projection.blockers.claims = {};
      break;
    }
    case "delivery_intent":
      if (!projection.delivery) {
        projection.delivery = {
          deliveryId: String(payload.deliveryId),
          kind: "terminal",
          status: "pending",
          message: String(payload.message ?? ""),
        };
      }
      break;
    case "delivery_dispatched":
      if (
        projection.delivery?.deliveryId === String(payload.deliveryId) &&
        projection.delivery.status !== "delivered"
      ) {
        projection.delivery.status = "dispatched";
        const claim = parseDeliveryClaim(payload);
        if (claim) projection.delivery.claim = claim;
      }
      break;
    case "delivery_receipt":
      if (projection.delivery?.deliveryId === String(payload.deliveryId))
        projection.delivery.status = "delivered";
      break;
  }
}

function creationTasks(
  payload: Record<string, any>,
): readonly Record<string, any>[] {
  if (payload.plan && Array.isArray(payload.plan.phases)) {
    return payload.plan.phases.flatMap((phase: Record<string, any>) =>
      (Array.isArray(phase.tasks) ? phase.tasks : []).map(
        (task: Record<string, any>) => ({
          id: task.id,
          phaseId: phase.id,
          prompt: task.prompt,
          ...(task.label === undefined ? {} : { label: task.label }),
          ...(isApprovalGate(task.approval) ? { approval: task.approval } : {}),
        }),
      ),
    );
  }
  return Array.isArray(payload.tasks) ? payload.tasks : [];
}

function isApprovalGate(
  value: unknown,
): value is { policyHash: string; denial: "stop" | "skip" } {
  if (!isRecord(value)) return false;
  return (
    typeof value.policyHash === "string" &&
    value.policyHash.length > 0 &&
    (value.denial === "stop" || value.denial === "skip")
  );
}

function parseDeliveryClaim(value: unknown): WorkflowDeliveryClaim | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.ownerId !== "string" ||
    value.ownerId.length === 0 ||
    !Number.isSafeInteger(value.ownerGeneration) ||
    value.ownerGeneration < 0 ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    value.leaseEpoch < 0
  )
    return undefined;
  return {
    ownerId: value.ownerId,
    ownerGeneration: value.ownerGeneration,
    leaseEpoch: value.leaseEpoch,
  };
}

function parseClaim(
  value: unknown,
  runId: string,
  taskId: string,
  attempt: number,
): WorkflowTaskClaim | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.runId !== runId ||
    value.taskId !== taskId ||
    value.attempt !== attempt ||
    typeof value.ownerId !== "string" ||
    !Number.isSafeInteger(value.ownerGeneration) ||
    value.ownerGeneration < 0 ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    value.leaseEpoch < 0 ||
    typeof value.token !== "string" ||
    value.token.length === 0
  )
    return undefined;
  return value as unknown as WorkflowTaskClaim;
}

function settlementMatches(
  previous: WorkflowProjectionTask | undefined,
  candidate: unknown,
  attempt: number,
): boolean {
  if (!previous?.claim) return candidate === undefined;
  const parsed = parseClaim(
    candidate,
    previous.claim.runId,
    previous.claim.taskId,
    attempt,
  );
  return parsed !== undefined && sameClaim(previous.claim, parsed);
}

function sameClaim(left: WorkflowTaskClaim, right: unknown): boolean {
  if (!isRecord(right)) return false;
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.attempt === right.attempt &&
    left.ownerId === right.ownerId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.leaseEpoch === right.leaseEpoch &&
    left.token === right.token
  );
}

function refreshStatus(projection: WorkflowProjection): void {
  if (isTerminal(projection.status)) return;
  if (projection.blockers.budget) {
    projection.status = "awaiting_budget";
    return;
  }
  if (
    projection.blockers.runtime ||
    Object.keys(projection.blockers.tasks).length > 0
  ) {
    projection.status = "blocked";
    return;
  }
  if (projection.status === "blocked" && projection.blockers.approval) return;
  if (
    ["blocked", "awaiting_budget", "interrupted", "created"].includes(
      projection.status,
    )
  )
    projection.status = "running";
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function definitionFields(
  previous: WorkflowProjectionTask | undefined,
): Pick<WorkflowProjectionTask, "phaseId" | "prompt" | "label" | "approval"> {
  return {
    ...(previous?.phaseId === undefined ? {} : { phaseId: previous.phaseId }),
    ...(previous?.prompt === undefined ? {} : { prompt: previous.prompt }),
    ...(previous?.label === undefined ? {} : { label: previous.label }),
    ...(previous?.approval === undefined
      ? {}
      : { approval: previous.approval }),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(status: WorkflowRunStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isTerminalTask(status: WorkflowProjectionTask["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

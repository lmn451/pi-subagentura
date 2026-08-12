import { randomUUID } from "node:crypto";
import {
  createWorkflowProcessAttemptManifest,
  WorkflowProcessAttemptFencedError,
  type WorkflowProcessAttemptDispatch,
  type WorkflowProcessAttemptIdentity,
  type WorkflowProcessChildStartedEvidence,
  type WorkflowProcessPaneAssignment,
  type WorkflowProcessTerminalEvidence,
} from "./workflow-process-attempt";
import type { DurableWorkflowProcessAttemptProjection } from "./workflow-projection-repository";

import type { SubagentResult, Usage } from "./helpers";
import type { WorkflowAgentRunner, WorkflowUsage } from "./workflow-core";
import type { WorkflowAgentDispatcher } from "./workflow-dispatcher";
import type { EncodedDurableValue } from "./workflow-durable-value";
import {
  isWorkflowAttemptId,
  isWorkflowEventReceipt,
  isWorkflowRunEvent,
  workflowOperationIdentityEquals,
  workflowOperationRequestMatches,
  workflowRunEpochFenceEquals,
  type DurableWorkflowUsage,
  type WorkflowAttemptInterruptedEvent,
  type WorkflowBlobReference,
  type WorkflowEventReceipt,
  type WorkflowOperationAttempt,
  type WorkflowOperationDispatchedEvent,
  type WorkflowOperationOutcome,
  type WorkflowOperationIdentity,
  type WorkflowOperationPreparedEvent,
  type WorkflowOperationReplayedEvent,
  type WorkflowOperationRequest,
  type WorkflowOperationSettledEvent,
  type WorkflowResponseOrdinal,
  type WorkflowResponseReadyEvent,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
  type WorkflowAttemptStartedEvent,
  type WorkflowAttemptSettledEvent,
  type WorkflowAttemptUsageObservedEvent,
  type WorkflowUsageAccounting,
  type WorkflowProcessAdoptedEvent,
  type WorkflowProcessChildStartedEvent,
  type WorkflowProcessFencedEvent,
  type WorkflowProcessIsolationResolvedEvent,
  type WorkflowProcessLaunchDispatchedEvent,
  type WorkflowProcessLaunchPreparedEvent,
  type WorkflowProcessPaneAssignedEvent,
  type WorkflowProcessTerminalEvent,
} from "./workflow-run-types";

export type WorkflowAgentDispatchRequest = Parameters<WorkflowAgentRunner>[0];
export type WorkflowOperationDispatchResult = SubagentResult | null;

export type WorkflowOperationGateEvent =
  | WorkflowOperationPreparedEvent
  | WorkflowOperationDispatchedEvent
  | WorkflowOperationSettledEvent
  | WorkflowAttemptInterruptedEvent
  | WorkflowOperationReplayedEvent
  | WorkflowAttemptStartedEvent
  | WorkflowAttemptUsageObservedEvent
  | WorkflowAttemptSettledEvent
  | WorkflowResponseReadyEvent
  | WorkflowProcessLaunchPreparedEvent
  | WorkflowProcessPaneAssignedEvent
  | WorkflowProcessLaunchDispatchedEvent
  | WorkflowProcessChildStartedEvent
  | WorkflowProcessTerminalEvent
  | WorkflowProcessAdoptedEvent
  | WorkflowProcessFencedEvent
  | WorkflowProcessIsolationResolvedEvent;

export type WorkflowOperationEventDraft<
  Event extends WorkflowOperationGateEvent = WorkflowOperationGateEvent,
> = Event extends WorkflowOperationGateEvent
  ? Readonly<Pick<Event, "type" | "payload">>
  : never;

export interface WorkflowOperationAttemptSettlement {
  readonly eventId: string;
  readonly outcome: WorkflowOperationOutcome;
  readonly accounting: WorkflowUsageAccounting;
}

/** One folded attempt. observedUsage is a cumulative, not delta, sample. */
export interface WorkflowOperationAttemptState {
  readonly attempt: WorkflowOperationAttempt;
  readonly dispatched: boolean;
  readonly observedUsage?: DurableWorkflowUsage;
  readonly settlement?: WorkflowOperationAttemptSettlement;
  readonly status?: "started" | "settled" | "interrupted" | "cancelled";
  readonly process?: DurableWorkflowProcessAttemptProjection;
}

export interface WorkflowOperationSettlementState {
  readonly eventId: string;
  readonly attempt: WorkflowOperationAttempt;
  readonly outcome: WorkflowOperationOutcome;
  readonly accounting: WorkflowUsageAccounting;
  readonly responseOrdinal?: WorkflowResponseOrdinal;
}

/** Disposable projection of the authoritative complete-line event prefix. */
export interface WorkflowOperationJournalState {
  readonly request?: WorkflowOperationRequest;
  readonly attempts: readonly WorkflowOperationAttemptState[];
  readonly settlement?: WorkflowOperationSettlementState;
}

/**
 * Event IDs and sequence numbers are allocated and durably appended by the
 * journal implementation in one critical section. The gate never receives
 * paths or constructs persisted event metadata.
 */
export interface WorkflowOperationEventAppend {
  readonly event: WorkflowOperationGateEvent;
  readonly receipt: WorkflowEventReceipt;
}

export interface WorkflowOperationEventSink {
  revalidateFence(fence: WorkflowRunEpochFence): Promise<void>;
  appendEvent(
    fence: WorkflowRunEpochFence,
    draft: WorkflowOperationEventDraft,
  ): Promise<WorkflowOperationEventAppend>;
}

/**
 * Filesystem-independent authority used by the parent-owned operation gate.
 * Implementations fold physical event order and fence every allocation,
 * publication, and blob access.
 */
export interface WorkflowOperationJournal extends WorkflowOperationEventSink {
  readOperation(
    fence: WorkflowRunEpochFence,
    operation: WorkflowOperationIdentity,
  ): Promise<WorkflowOperationJournalState>;
  allocateAttempt(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
  ): Promise<WorkflowOperationAttempt>;
  allocateResponseOrdinal(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
  ): Promise<WorkflowResponseOrdinal>;
  commitResponse<T>(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    responseOrdinal: WorkflowResponseOrdinal,
    commit: () => Promise<T>,
  ): Promise<T>;
  abandonResponse(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    responseOrdinal: WorkflowResponseOrdinal,
    reason: unknown,
  ): Promise<void>;
  putOutcomeBlob(
    fence: WorkflowRunEpochFence,
    value: EncodedDurableValue,
  ): Promise<WorkflowBlobReference>;
  readOutcomeBlob(
    fence: WorkflowRunEpochFence,
    reference: WorkflowBlobReference,
  ): Promise<string | Uint8Array>;
}

export interface WorkflowOperationBlobCodec {
  encode(value: unknown): EncodedDurableValue;
  decode(value: string | Uint8Array): unknown;
}

export interface WorkflowOperationGateOptions {
  readonly journal: WorkflowOperationJournal;
  readonly blobCodec: WorkflowOperationBlobCodec;
  readonly dispatcher: Pick<WorkflowAgentDispatcher, "run">;
  readonly generateProcessNonce?: () => string;
}

export type WorkflowOperationGateErrorCode =
  "duplicate_operation_id" | "replay_diverged" | "journal_state_invalid";

export class WorkflowOperationGateError extends Error {
  readonly code: WorkflowOperationGateErrorCode;

  constructor(code: WorkflowOperationGateErrorCode, message: string) {
    super(message);
    this.name = "WorkflowOperationGateError";
    this.code = code;
  }
}

export class WorkflowOperationInterruptedError extends Error {
  readonly reason: WorkflowAttemptInterruptedEvent["payload"]["reason"];
  readonly usage?: Usage;

  constructor(
    reason: WorkflowAttemptInterruptedEvent["payload"]["reason"],
    message = "Durable workflow operation interrupted.",
    usage?: Usage,
  ) {
    super(message);
    this.name = "WorkflowOperationInterruptedError";
    this.reason = reason;
    this.usage = usage;
  }
}

interface InFlightOperation {
  readonly fence: WorkflowRunEpochFence;
  readonly request: WorkflowOperationRequest;
  readonly promise: Promise<WorkflowOperationDispatchResult>;
}

interface OperationDecision {
  readonly promise: Promise<WorkflowOperationDispatchResult>;
}

interface DecodedDelivery {
  readonly kind: "return" | "throw";
  readonly value: unknown;
}

interface PersistedDispatch {
  readonly outcome: WorkflowOperationOutcome;
  readonly accounting: WorkflowUsageAccounting;
}

interface SerializedThrownError {
  readonly kind: "thrown_error";
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

interface ProcessDispatchAuthority {
  readonly dispatch: WorkflowProcessAttemptDispatch;
  readonly priorAttempts: readonly WorkflowOperationAttemptState[];
}
const RESOLVED = Promise.resolve();
const MAX_PROCESS_FENCE_REDISPATCHES = 3;

/** Parent-owned durable replay and commit-before-return boundary. */
export class WorkflowOperationGate {
  readonly #journal: WorkflowOperationJournal;
  readonly #blobCodec: WorkflowOperationBlobCodec;
  readonly #dispatcher: Pick<WorkflowAgentDispatcher, "run">;
  readonly #mutexTails = new Map<string, Promise<void>>();
  readonly #generateProcessNonce: () => string;
  readonly #inFlight = new Map<string, InFlightOperation>();

  constructor(options: WorkflowOperationGateOptions) {
    this.#journal = options.journal;
    this.#blobCodec = options.blobCodec;
    this.#dispatcher = options.dispatcher;
    this.#generateProcessNonce = options.generateProcessNonce ?? randomUUID;
  }

  execute(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    dispatchRequest: WorkflowAgentDispatchRequest,
  ): Promise<WorkflowOperationDispatchResult> {
    const key = operationKey(fence, request);
    return this.#decide(key, fence, request, dispatchRequest).then(
      (decision) => decision.promise,
    );
  }

  async #decide(
    key: string,
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    dispatchRequest: WorkflowAgentDispatchRequest,
  ): Promise<OperationDecision> {
    return this.#withOperationMutex(key, async () => {
      await this.#journal.revalidateFence(fence);
      const state = await this.#journal.readOperation(fence, request.identity);
      this.#validateState(state, request);

      const active = this.#inFlight.get(key);
      if (
        active !== undefined &&
        workflowRunEpochFenceEquals(active.fence, fence)
      ) {
        if (!workflowOperationRequestMatches(active.request, request)) {
          throw conflictError(
            request,
            state.settlement !== undefined ||
              state.attempts.some(({ settlement }) => settlement !== undefined),
          );
        }
        return { promise: active.promise };
      }
      if (state.settlement?.responseOrdinal !== undefined) {
        return {
          promise: this.#replayCommitted(fence, request, state.settlement),
        };
      }

      let promise: Promise<WorkflowOperationDispatchResult>;
      const settledAttempt = onlySettledAttempt(state);
      if (state.settlement !== undefined) {
        promise = this.#finishCommittedSettlement(
          fence,
          request,
          state.settlement,
        );
      } else if (settledAttempt !== undefined) {
        promise = this.#commitSettledAttempt(
          fence,
          request,
          settledAttempt.attempt,
          settledAttempt.settlement,
        );
      } else {
        promise = this.#dispatchFresh(fence, request, dispatchRequest, state);
      }

      const activeOperation: InFlightOperation = {
        fence,
        request,
        promise,
      };
      this.#inFlight.set(key, activeOperation);
      void promise.then(
        () => this.#clearInFlight(key, activeOperation),
        () => this.#clearInFlight(key, activeOperation),
      );
      return { promise };
    });
  }

  #clearInFlight(key: string, operation: InFlightOperation): void {
    if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
  }

  async #dispatchFresh(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    dispatchRequest: WorkflowAgentDispatchRequest,
    state: WorkflowOperationJournalState,
  ): Promise<WorkflowOperationDispatchResult> {
    if (state.request === undefined) {
      await this.#append(fence, {
        type: "operation_prepared",
        payload: { request },
      });
    }

    let activeProcessAttempt = state.attempts.at(-1);
    if (
      activeProcessAttempt?.status === "started" &&
      activeProcessAttempt.settlement === undefined &&
      activeProcessAttempt.process?.fencedEventId !== undefined
    ) {
      await this.#append(fence, {
        type: "attempt_interrupted",
        payload: { attempt: activeProcessAttempt.attempt, reason: "recovery" },
      });
      state = await this.#journal.readOperation(fence, request.identity);
      activeProcessAttempt = state.attempts.at(-1);
    }
    let attempt: WorkflowOperationAttempt;
    let processAuthority: ProcessDispatchAuthority | undefined;
    let recoveredPriorAttempts:
      readonly WorkflowOperationAttemptState[] | undefined;
    if (
      activeProcessAttempt?.status === "started" &&
      activeProcessAttempt.settlement === undefined &&
      activeProcessAttempt.process !== undefined &&
      activeProcessAttempt.process.effectiveIsolation === "process" &&
      activeProcessAttempt.process.fencedEventId === undefined
    ) {
      attempt = activeProcessAttempt.attempt;
      processAuthority = this.#processDispatchAuthority(
        fence,
        activeProcessAttempt.process,
        "adopt",
        state.attempts.slice(0, -1),
      );
    } else {
      const recoverableAttempt =
        activeProcessAttempt?.status === "started" &&
        activeProcessAttempt.settlement === undefined &&
        !activeProcessAttempt.dispatched &&
        activeProcessAttempt.process === undefined
          ? activeProcessAttempt
          : undefined;
      if (recoverableAttempt !== undefined) {
        attempt = recoverableAttempt.attempt;
        recoveredPriorAttempts = state.attempts.slice(0, -1);
      } else {
        attempt = await this.#journal.allocateAttempt(fence, request);
        this.#validateAllocatedAttempt(attempt, request, state.attempts);
        await this.#append(fence, {
          type: "attempt_started",
          payload: { attempt },
        });
      }
      if (dispatchRequest.isolation !== "in-process") {
        const manifest = createWorkflowProcessAttemptManifest(
          attempt,
          fence.runEpoch,
          this.#generateProcessNonce(),
          dispatchRequest.isolation ?? "process",
        );
        await this.#append(fence, {
          type: "process_launch_prepared",
          payload: { manifest },
        });
        processAuthority = this.#processDispatchAuthority(
          fence,
          {
            manifest,
            stage: "prepared",
            launchPreparedEventId: "",
            effectiveIsolation: "process",
            fallbackMode: "none",
          },
          "launch",
          recoveredPriorAttempts ?? state.attempts,
        );
      }
      await this.#append(fence, {
        type: "operation_dispatched",
        payload: { attempt },
      });
    }

    let observedUsage: WorkflowUsage | undefined;
    const originalProgress = dispatchRequest.onProgress;
    const requestWithUsageEvidence: WorkflowAgentDispatchRequest = {
      ...dispatchRequest,
      ...(processAuthority === undefined
        ? {}
        : { workflowProcessAttempt: processAuthority.dispatch }),
      onProgress: (event) => {
        if (event.liveUsage !== undefined) observedUsage = event.liveUsage;
        originalProgress?.(event);
      },
    };

    let returned: WorkflowOperationDispatchResult | undefined;
    let thrown: unknown;
    let didThrow = false;
    try {
      returned = (await this.#dispatcher.run(
        requestWithUsageEvidence,
      )) as WorkflowOperationDispatchResult;
    } catch (error) {
      didThrow = true;
      thrown = error;
    }

    if (thrown instanceof WorkflowProcessAttemptFencedError) {
      const fencedUsage = durableUsageFromUnknown(thrown, observedUsage);
      if (dispatchRequest.signal?.aborted) {
        returned = cancelledResult(
          abortSignalReason(dispatchRequest.signal),
          fencedUsage,
        );
        thrown = undefined;
        didThrow = false;
      } else if (
        state.attempts.filter(
          ({ process, settlement }) =>
            settlement === undefined && process?.fencedEventId !== undefined,
        ).length < MAX_PROCESS_FENCE_REDISPATCHES
      ) {
        await this.#append(fence, {
          type: "attempt_usage_observed",
          payload: { attempt, usageDelta: fencedUsage },
        });
        await this.#append(fence, {
          type: "attempt_interrupted",
          payload: { attempt, reason: "recovery" },
        });
        const refreshed = await this.#journal.readOperation(
          fence,
          request.identity,
        );
        return this.#dispatchFresh(fence, request, dispatchRequest, refreshed);
      }
    }
    if (thrown instanceof WorkflowOperationInterruptedError) {
      const currentUsage = durableUsageFromUnknown(thrown, observedUsage);
      await this.#append(fence, {
        type: "attempt_usage_observed",
        payload: { attempt, usageDelta: currentUsage },
      });
      await this.#append(fence, {
        type: "attempt_interrupted",
        payload: { attempt, reason: thrown.reason },
      });
      await this.#journal.revalidateFence(fence);
      throw thrown;
    }

    const currentUsage = didThrow
      ? durableUsageFromUnknown(thrown, observedUsage)
      : durableUsageFromUnknown(returned, observedUsage);
    const priorAttempts =
      processAuthority?.priorAttempts ??
      recoveredPriorAttempts ??
      state.attempts;
    const accounting = accountingForAttempt(priorAttempts, currentUsage);
    await this.#commitResponse(fence, request, async (responseOrdinal) => {
      const persisted = await this.#persistDispatch(
        fence,
        returned,
        thrown,
        didThrow,
        accounting,
      );
      await this.#append(fence, {
        type: "attempt_usage_observed",
        payload: { attempt, usageDelta: currentUsage },
      });
      await this.#append(fence, {
        type: "attempt_settled",
        payload: {
          attempt,
          outcome: persisted.outcome,
          accounting: persisted.accounting,
        },
      });
      const operationSettlement = await this.#append(fence, {
        type: "operation_settled",
        payload: {
          attempt,
          outcome: persisted.outcome,
          accounting: persisted.accounting,
        },
      });
      await this.#appendResponseReady(
        fence,
        attempt,
        responseOrdinal,
        operationSettlement.eventId,
      );
      await this.#journal.revalidateFence(fence);
    });

    if (didThrow) throw thrown;
    return returned as WorkflowOperationDispatchResult;
  }

  #processDispatchAuthority(
    fence: WorkflowRunEpochFence,
    process: DurableWorkflowProcessAttemptProjection,
    mode: "launch" | "adopt",
    priorAttempts: readonly WorkflowOperationAttemptState[],
  ): ProcessDispatchAuthority {
    const { manifest } = process;
    const appendIdentityEvent = async (
      identity: WorkflowProcessAttemptIdentity,
      draft: WorkflowOperationEventDraft,
    ): Promise<void> => {
      if (
        identity.runId !== manifest.identity.runId ||
        identity.definitionPath !== manifest.identity.definitionPath ||
        identity.operationId !== manifest.identity.operationId ||
        identity.attemptId !== manifest.identity.attemptId ||
        identity.attemptNumber !== manifest.identity.attemptNumber ||
        identity.runEpoch !== manifest.identity.runEpoch ||
        identity.nonce !== manifest.identity.nonce
      ) {
        throw invalidState("runner reported stale workflow process evidence");
      }
      await this.#append(fence, draft);
    };
    const dispatch: WorkflowProcessAttemptDispatch = Object.freeze({
      mode,
      manifest,
      ...(process.assignment === undefined
        ? {}
        : { assignment: process.assignment }),
      launchDispatchedPersisted: process.launchDispatchedEventId !== undefined,
      childStartedPersisted: process.childStartedEventId !== undefined,
      terminalPersisted: process.terminalEventId !== undefined,
      adoptedPersisted: process.adoptedEventId !== undefined,
      paneAssigned: (assignment: WorkflowProcessPaneAssignment) =>
        appendIdentityEvent(manifest.identity, {
          type: "process_pane_assigned",
          payload: { identity: manifest.identity, assignment },
        }),
      launchDispatched: (assignment: WorkflowProcessPaneAssignment) =>
        appendIdentityEvent(manifest.identity, {
          type: "process_launch_dispatched",
          payload: { identity: manifest.identity, assignment },
        }),
      childStarted: (evidence: WorkflowProcessChildStartedEvidence) =>
        appendIdentityEvent(evidence.identity, {
          type: "process_child_started",
          payload: { evidence },
        }),
      terminal: (evidence: WorkflowProcessTerminalEvidence) =>
        appendIdentityEvent(evidence.identity, {
          type: "process_terminal",
          payload: { evidence },
        }),
      adopted: (evidence: "live" | "terminal") =>
        appendIdentityEvent(manifest.identity, {
          type: "process_adopted",
          payload: { identity: manifest.identity, evidence },
        }),
      fenced: (
        reason:
          | "orphan_before_assignment"
          | "ambiguous_dispatch"
          | "multiple_marker_matches"
          | "stale_evidence",
        assignment: WorkflowProcessPaneAssignment | undefined,
        probeCount: number,
      ) =>
        appendIdentityEvent(manifest.identity, {
          type: "process_fenced",
          payload: {
            identity: manifest.identity,
            reason,
            ...(assignment === undefined ? {} : { assignment }),
            probeCount,
          },
        }),
      fallback: (fallbackReason: string) =>
        appendIdentityEvent(manifest.identity, {
          type: "process_isolation_resolved",
          payload: {
            identity: manifest.identity,
            effectiveIsolation: "in-process",
            fallbackMode: "process_unavailable",
            fallbackReason,
          },
        }),
    });
    return { dispatch, priorAttempts };
  }

  async #persistDispatch(
    fence: WorkflowRunEpochFence,
    returned: WorkflowOperationDispatchResult | undefined,
    thrown: unknown,
    didThrow: boolean,
    accounting: WorkflowUsageAccounting,
  ): Promise<PersistedDispatch> {
    if (didThrow) {
      const error = await this.#putBlob(fence, serializeThrownError(thrown));
      return {
        outcome: { status: "thrown_error", error },
        accounting,
      };
    }
    if (isReturnedCancellation(returned)) {
      return {
        outcome: { status: "cancelled", reason: returned.output },
        accounting,
      };
    }
    const blob = await this.#putBlob(fence, returned);
    if (isReturnedError(returned)) {
      return {
        outcome: { status: "returned_error", error: blob },
        accounting,
      };
    }
    return {
      outcome: { status: "succeeded", value: blob },
      accounting,
    };
  }

  async #putBlob(
    fence: WorkflowRunEpochFence,
    value: unknown,
  ): Promise<WorkflowBlobReference> {
    const encoded = this.#blobCodec.encode(value);
    const reference = await this.#journal.putOutcomeBlob(fence, encoded);
    if (
      reference.sha256 !== encoded.sha256 ||
      reference.sizeBytes !== encoded.bytes
    ) {
      throw invalidState(
        "journal published a mismatched outcome blob reference",
      );
    }
    return reference;
  }

  async #commitSettledAttempt(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    attempt: WorkflowOperationAttempt,
    settlement: WorkflowOperationAttemptSettlement,
  ): Promise<WorkflowOperationDispatchResult> {
    const delivery = await this.#decodeOutcome(
      fence,
      settlement.outcome,
      settlement.accounting,
    );
    await this.#commitResponse(fence, request, async (responseOrdinal) => {
      const operationSettlement = await this.#append(fence, {
        type: "operation_settled",
        payload: {
          attempt,
          outcome: settlement.outcome,
          accounting: settlement.accounting,
        },
      });
      await this.#appendResponseReady(
        fence,
        attempt,
        responseOrdinal,
        operationSettlement.eventId,
      );
      await this.#journal.revalidateFence(fence);
    });
    return deliver(delivery);
  }

  async #finishCommittedSettlement(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    settlement: WorkflowOperationSettlementState,
  ): Promise<WorkflowOperationDispatchResult> {
    const delivery = await this.#decodeOutcome(
      fence,
      settlement.outcome,
      settlement.accounting,
    );
    await this.#commitResponse(fence, request, async (responseOrdinal) => {
      await this.#appendResponseReady(
        fence,
        settlement.attempt,
        responseOrdinal,
        settlement.eventId,
      );
      await this.#journal.revalidateFence(fence);
    });
    return deliver(delivery);
  }

  async #replayCommitted(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    settlement: WorkflowOperationSettlementState,
  ): Promise<WorkflowOperationDispatchResult> {
    const responseOrdinal = settlement.responseOrdinal;
    if (responseOrdinal === undefined) {
      throw invalidState("committed replay has no response ordinal");
    }
    const delivery = await this.#decodeOutcome(
      fence,
      settlement.outcome,
      settlement.accounting,
    );
    await this.#append(fence, {
      type: "operation_replayed",
      payload: {
        request,
        settledEventId: settlement.eventId,
        responseOrdinal,
      },
    });
    await this.#journal.revalidateFence(fence);
    return deliver(delivery);
  }

  async #decodeOutcome(
    fence: WorkflowRunEpochFence,
    outcome: WorkflowOperationOutcome,
    accounting: WorkflowUsageAccounting,
  ): Promise<DecodedDelivery> {
    if (outcome.status === "cancelled") {
      return {
        kind: "return",
        value: cancelledResult(outcome.reason, accounting.usage),
      };
    }
    const reference =
      outcome.status === "succeeded" ? outcome.value : outcome.error;
    const bytes = await this.#journal.readOutcomeBlob(fence, reference);
    const decoded = this.#blobCodec.decode(bytes);
    if (
      outcome.status === "thrown_error" ||
      outcome.status === "schema_retry_exhausted"
    ) {
      return { kind: "throw", value: deserializeThrownError(decoded) };
    }
    return { kind: "return", value: decoded };
  }

  async #commitResponse<T>(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    commit: (responseOrdinal: WorkflowResponseOrdinal) => Promise<T>,
  ): Promise<T> {
    const responseOrdinal = await this.#journal.allocateResponseOrdinal(
      fence,
      request,
    );
    try {
      return await this.#journal.commitResponse(
        fence,
        request,
        responseOrdinal,
        () => commit(responseOrdinal),
      );
    } catch (error) {
      await this.#journal
        .abandonResponse(fence, request, responseOrdinal, error)
        .catch(() => undefined);
      throw error;
    }
  }

  async #appendResponseReady(
    fence: WorkflowRunEpochFence,
    attempt: WorkflowOperationAttempt,
    responseOrdinal: WorkflowResponseOrdinal,
    settlementEventId: string,
  ): Promise<void> {
    await this.#append(fence, {
      type: "response_ready",
      payload: {
        operation: attempt.operation,
        dispatchOrdinal: attempt.dispatchOrdinal,
        responseOrdinal,
        settlementEventId,
      },
    });
  }

  async #append(
    fence: WorkflowRunEpochFence,
    draft: WorkflowOperationEventDraft,
  ): Promise<WorkflowOperationGateEvent> {
    const { event, receipt } = await this.#journal.appendEvent(fence, draft);
    if (
      !isWorkflowRunEvent(event) ||
      !isGateEvent(event) ||
      event.type !== draft.type ||
      event.runId !== fence.runId ||
      event.runEpoch !== fence.runEpoch
    ) {
      throw invalidState("journal appended an invalid operation event");
    }
    this.#validateReceipt(receipt, event, fence);
    return event;
  }

  #validateReceipt(
    receipt: WorkflowEventReceipt,
    event: WorkflowRunEvent,
    fence: WorkflowRunEpochFence,
  ): void {
    if (
      !isWorkflowEventReceipt(receipt) ||
      receipt.runId !== fence.runId ||
      receipt.runEpoch !== fence.runEpoch ||
      receipt.eventId !== event.eventId
    ) {
      throw invalidState("journal returned an invalid append receipt");
    }
  }

  #validateState(
    state: WorkflowOperationJournalState,
    request: WorkflowOperationRequest,
  ): void {
    if (state.request !== undefined) {
      if (
        !workflowOperationIdentityEquals(
          state.request.identity,
          request.identity,
        )
      ) {
        throw invalidState("journal returned another operation identity");
      }
      if (!workflowOperationRequestMatches(state.request, request)) {
        throw conflictError(
          request,
          state.settlement !== undefined ||
            state.attempts.some(({ settlement }) => settlement !== undefined),
        );
      }
    } else if (state.attempts.length > 0 || state.settlement !== undefined) {
      throw invalidState("operation history has no preparation event");
    }

    const attemptIds = new Set<string>();
    const attemptNumbers = new Set<number>();
    for (const attemptState of state.attempts) {
      const { attempt } = attemptState;
      if (!attemptMatchesRequest(attempt, request)) {
        throw invalidState("operation attempt does not match its request");
      }
      if (
        attemptIds.has(attempt.attemptId) ||
        attemptNumbers.has(attempt.attemptNumber)
      ) {
        throw invalidState("operation history contains a duplicate attempt");
      }
      attemptIds.add(attempt.attemptId);
      attemptNumbers.add(attempt.attemptNumber);
    }

    if (state.settlement !== undefined) {
      if (!attemptMatchesRequest(state.settlement.attempt, request)) {
        throw invalidState("operation settlement does not match its request");
      }
      const matchingAttempt = state.attempts.find(
        ({ attempt }) =>
          attempt.attemptId === state.settlement?.attempt.attemptId &&
          attempt.attemptNumber === state.settlement?.attempt.attemptNumber,
      );
      if (matchingAttempt?.settlement === undefined) {
        throw invalidState(
          "operation settlement has no settled attempt evidence",
        );
      }
      if (
        matchingAttempt.settlement.outcome.status !==
        state.settlement.outcome.status
      ) {
        throw invalidState("attempt and operation settlements disagree");
      }
    }
  }

  #validateAllocatedAttempt(
    attempt: WorkflowOperationAttempt,
    request: WorkflowOperationRequest,
    priorAttempts: readonly WorkflowOperationAttemptState[],
  ): void {
    const expectedNumber =
      priorAttempts.reduce(
        (maximum, prior) => Math.max(maximum, prior.attempt.attemptNumber),
        0,
      ) + 1;
    if (
      !attemptMatchesRequest(attempt, request) ||
      !isWorkflowAttemptId(attempt.attemptId) ||
      attempt.attemptNumber !== expectedNumber ||
      !Number.isSafeInteger(attempt.attemptNumber)
    ) {
      throw invalidState("journal allocated an invalid workflow attempt");
    }
  }

  async #withOperationMutex<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#mutexTails.get(key) ?? RESOLVED;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.#mutexTails.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.#mutexTails.get(key) === tail) this.#mutexTails.delete(key);
    }
  }
}

function operationKey(
  fence: WorkflowRunEpochFence,
  request: WorkflowOperationRequest,
): string {
  return JSON.stringify([
    fence.durableOwner.projectKey,
    fence.durableOwner.piSessionKey,
    request.identity.runId,
    request.identity.definitionPath,
    request.identity.operationId,
  ]);
}

function abortSignalReason(signal: AbortSignal): string {
  const { reason } = signal;
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Workflow operation aborted.";
}

function isGateEvent(
  event: WorkflowRunEvent,
): event is WorkflowOperationGateEvent {
  return (
    event.type === "operation_prepared" ||
    event.type === "operation_dispatched" ||
    event.type === "operation_settled" ||
    event.type === "attempt_interrupted" ||
    event.type === "operation_replayed" ||
    event.type === "attempt_started" ||
    event.type === "attempt_usage_observed" ||
    event.type === "attempt_settled" ||
    event.type === "response_ready" ||
    event.type === "process_launch_prepared" ||
    event.type === "process_pane_assigned" ||
    event.type === "process_launch_dispatched" ||
    event.type === "process_child_started" ||
    event.type === "process_terminal" ||
    event.type === "process_adopted" ||
    event.type === "process_fenced" ||
    event.type === "process_isolation_resolved"
  );
}

function onlySettledAttempt(state: WorkflowOperationJournalState):
  | (WorkflowOperationAttemptState & {
      readonly settlement: WorkflowOperationAttemptSettlement;
    })
  | undefined {
  const settled = state.attempts.filter(
    (
      attempt,
    ): attempt is WorkflowOperationAttemptState & {
      readonly settlement: WorkflowOperationAttemptSettlement;
    } => attempt.settlement !== undefined,
  );
  if (settled.length > 1 && state.settlement === undefined) {
    throw invalidState("uncommitted operation has multiple settled attempts");
  }
  return settled.at(-1);
}

function attemptMatchesRequest(
  attempt: WorkflowOperationAttempt,
  request: WorkflowOperationRequest,
): boolean {
  return (
    workflowOperationIdentityEquals(attempt.operation, request.identity) &&
    attempt.requestDigest === request.requestDigest &&
    attempt.definitionDigest === request.definitionDigest &&
    attempt.dispatchOrdinal === request.dispatchOrdinal
  );
}

function conflictError(
  request: WorkflowOperationRequest,
  againstCommittedHistory: boolean,
): WorkflowOperationGateError {
  const code = againstCommittedHistory
    ? "replay_diverged"
    : "duplicate_operation_id";
  return new WorkflowOperationGateError(
    code,
    `${code}: operation ${request.identity.operationId} was requested with conflicting durable input`,
  );
}

function invalidState(message: string): WorkflowOperationGateError {
  return new WorkflowOperationGateError("journal_state_invalid", message);
}

function isReturnedError(
  value: WorkflowOperationDispatchResult | undefined,
): value is Extract<SubagentResult, { isError: true }> {
  return Boolean(value && value.isError === true);
}

function isReturnedCancellation(
  value: WorkflowOperationDispatchResult | undefined,
): value is Extract<SubagentResult, { isError: false }> & { cancelled: true } {
  return Boolean(value && value.isError === false && value.cancelled === true);
}

function durableUsageFromUnknown(
  value: unknown,
  fallback: WorkflowUsage | undefined,
): DurableWorkflowUsage {
  if (
    value &&
    typeof value === "object" &&
    "usage" in value &&
    value.usage &&
    typeof value.usage === "object"
  ) {
    const candidate = value.usage;
    const input = "input" in candidate ? candidate.input : undefined;
    const output = "output" in candidate ? candidate.output : undefined;
    const cacheRead =
      "cacheRead" in candidate ? candidate.cacheRead : undefined;
    const cacheWrite =
      "cacheWrite" in candidate ? candidate.cacheWrite : undefined;
    const totalTokens =
      "totalTokens" in candidate
        ? candidate.totalTokens
        : numberOrZero(input) +
          numberOrZero(output) +
          numberOrZero(cacheRead) +
          numberOrZero(cacheWrite);
    const costUsd =
      "costUsd" in candidate
        ? candidate.costUsd
        : "cost" in candidate
          ? candidate.cost
          : undefined;
    const turns = "turns" in candidate ? candidate.turns : undefined;
    const costSource =
      "costSource" in candidate ? candidate.costSource : undefined;
    if (
      costSource !== undefined &&
      costSource !== "provider" &&
      costSource !== "estimated" &&
      costSource !== "unavailable" &&
      costSource !== "mixed"
    ) {
      throw invalidState("dispatcher returned invalid costSource usage");
    }
    return checkedUsage({
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      costUsd,
      turns,
      costSource,
    });
  }
  return checkedUsage(fallback ?? zeroDurableUsage());
}

function checkedUsage(usage: {
  readonly [Key in keyof DurableWorkflowUsage]?: unknown;
}): DurableWorkflowUsage {
  const input = checkedUsageNumber(usage.input, "input");
  const output = checkedUsageNumber(usage.output, "output");
  const cacheRead = checkedUsageNumber(usage.cacheRead, "cacheRead");
  const cacheWrite = checkedUsageNumber(usage.cacheWrite, "cacheWrite");
  const totalTokens = checkedUsageNumber(usage.totalTokens, "totalTokens");
  const costUsd = checkedUsageNumber(usage.costUsd, "costUsd", false);
  const turns = checkedUsageNumber(usage.turns, "turns");
  const costSource = usage.costSource;
  if (
    costSource !== undefined &&
    costSource !== "provider" &&
    costSource !== "estimated" &&
    costSource !== "unavailable" &&
    costSource !== "mixed"
  ) {
    throw invalidState("dispatcher returned invalid costSource usage");
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costUsd,
    turns,
    ...(costSource === undefined ? {} : { costSource }),
  };
}

function checkedUsageNumber(
  value: unknown,
  field: string,
  requireInteger = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (requireInteger && !Number.isSafeInteger(value)) ||
    value < 0
  ) {
    throw invalidState(`dispatcher returned invalid ${field} usage`);
  }
  return value;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function zeroDurableUsage(): DurableWorkflowUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

function accountingForAttempt(
  priorAttempts: readonly WorkflowOperationAttemptState[],
  currentUsage: DurableWorkflowUsage,
): WorkflowUsageAccounting {
  let usage = zeroDurableUsage();
  let hasAmbiguousDispatch = false;
  for (const prior of priorAttempts) {
    if (!prior.dispatched || prior.settlement !== undefined) continue;
    hasAmbiguousDispatch = true;
    if (prior.observedUsage !== undefined) {
      usage = addDurableUsage(usage, checkedUsage(prior.observedUsage));
    }
  }
  usage = addDurableUsage(usage, currentUsage);
  return hasAmbiguousDispatch
    ? {
        completeness: "lower_bound",
        usage,
        reason: "ambiguous_dispatch",
      }
    : { completeness: "exact", usage };
}

function addDurableUsage(
  left: DurableWorkflowUsage,
  right: DurableWorkflowUsage,
): DurableWorkflowUsage {
  const costSource = mergeCostSource(left.costSource, right.costSource);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    turns: left.turns + right.turns,
    ...(costSource === undefined ? {} : { costSource }),
  };
}

function mergeCostSource(
  left: DurableWorkflowUsage["costSource"],
  right: DurableWorkflowUsage["costSource"],
): DurableWorkflowUsage["costSource"] {
  if (left === undefined) return right;
  if (right === undefined || left === right) return left;
  return "mixed";
}

function serializeThrownError(error: unknown): SerializedThrownError {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      kind: "thrown_error",
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ||
      (typeof code === "number" && Number.isSafeInteger(code))
        ? { code }
        : {}),
    };
  }
  return {
    kind: "thrown_error",
    name: "Error",
    message: String(error),
  };
}

function deserializeThrownError(value: unknown): Error {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<SerializedThrownError>).kind !== "thrown_error" ||
    typeof (value as Partial<SerializedThrownError>).name !== "string" ||
    typeof (value as Partial<SerializedThrownError>).message !== "string"
  ) {
    throw invalidState("persisted thrown-error envelope is invalid");
  }
  const envelope = value as SerializedThrownError;
  const error = new Error(envelope.message);
  error.name = envelope.name;
  if (envelope.code !== undefined) {
    Object.defineProperty(error, "code", {
      configurable: true,
      enumerable: true,
      value: envelope.code,
      writable: true,
    });
  }
  return error;
}

function cancelledResult(
  reason: string,
  usage: DurableWorkflowUsage,
): SubagentResult {
  return {
    isError: false,
    output: reason,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.costUsd,
      ...(usage.costSource === undefined
        ? {}
        : { costSource: usage.costSource }),
      turns: usage.turns,
    },
    cancelled: true,
  };
}

function deliver(delivery: DecodedDelivery): WorkflowOperationDispatchResult {
  if (delivery.kind === "throw") throw delivery.value;
  return delivery.value as WorkflowOperationDispatchResult;
}

import { randomUUID } from "node:crypto";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
  type EncodedDurableValue,
} from "./workflow-durable-value";
import type {
  WorkflowOperationBlobCodec,
  WorkflowOperationJournal,
  WorkflowOperationJournalState,
} from "./workflow-operation-gate";
import {
  WorkflowProjectionFoldError,
  foldWorkflowRunEvents,
  type DurableWorkflowOperationProjection,
  type DurableWorkflowProjection,
} from "./workflow-projection-repository";
import type {
  WorkflowBlobVerificationRequest,
  WorkflowBlobVerificationResult,
  WorkflowRecoveryBlobResolver,
} from "./workflow-recovery";
import {
  WorkflowRunStoreError,
  type WorkflowRunJournal,
  type WorkflowRunStore,
} from "./workflow-run-store";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDispatchOrdinal,
  createWorkflowResponseOrdinal,
  durableWorkflowOwnerEquals,
  isWorkflowIdentifier,
  isWorkflowRunEvent,
  workflowOperationIdentityEquals,
  workflowOperationRequestMatches,
  workflowRunEpochFenceEquals,
  type WorkflowBlobReference,
  type WorkflowEventReceipt,
  type WorkflowOperationAttempt,
  type WorkflowOperationIdentity,
  type WorkflowOperationRequest,
  type WorkflowResponseOrdinal,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
} from "./workflow-run-types";

export type WorkflowOperationJournalIdGenerator = () => string;

export type WorkflowRunEventDraft<
  Type extends WorkflowRunEvent["type"] = WorkflowRunEvent["type"],
> = Type extends WorkflowRunEvent["type"]
  ? Readonly<
      Pick<Extract<WorkflowRunEvent, { type: Type }>, "type" | "payload">
    >
  : never;

export interface WorkflowRunEventAppend<
  Type extends WorkflowRunEvent["type"] = WorkflowRunEvent["type"],
> {
  readonly event: Extract<WorkflowRunEvent, { type: Type }>;
  readonly receipt: WorkflowEventReceipt;
}

interface CoordinatorResponseReservation {
  readonly request: WorkflowOperationRequest;
  readonly responseOrdinal: WorkflowResponseOrdinal;
  readonly generation: number;
  readonly previous: Promise<void>;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  state: "reserved" | "committing" | "committed" | "abandoned";
}

interface JournalCoordinator {
  tail: Promise<void>;
  readonly nextAttemptNumbers: Map<string, number>;
  readonly attemptReservations: Map<
    string,
    Map<number, WorkflowOperationAttempt>
  >;
  readonly attemptRebaseFrom: Map<string, number>;
  readonly nextResponseOrdinals: Map<string, number>;
  readonly reservedAttemptIds: Set<string>;
  readonly responseCommitTails: Map<string, Promise<void>>;
  readonly responseLaneFailures: Map<string, unknown>;
  readonly responseLaneGenerations: Map<string, number>;
  readonly responseReservations: Map<
    string,
    Map<number, CoordinatorResponseReservation>
  >;
}

interface FoldedJournal {
  readonly events: readonly WorkflowRunEvent[];
  readonly projection: DurableWorkflowProjection;
}

const journalCoordinators = new WeakMap<
  WorkflowRunJournal,
  JournalCoordinator
>();

export const durableWorkflowOperationBlobCodec: WorkflowOperationBlobCodec =
  Object.freeze({
    encode: encodeDurableValue,
    decode: decodeDurableValue,
  });

/**
 * Durable operation-gate adapter over one current, leased run journal.
 * Complete physical event order is authoritative. Event envelopes are
 * allocated and appended inside the shared journal critical section.
 */
export class WorkflowRunOperationJournal implements WorkflowOperationJournal {
  readonly #journal: WorkflowRunJournal;
  readonly #generateId: WorkflowOperationJournalIdGenerator;
  readonly #coordinator: JournalCoordinator;

  constructor(
    journal: WorkflowRunJournal,
    generateId: WorkflowOperationJournalIdGenerator = randomUUID,
  ) {
    this.#journal = journal;
    this.#generateId = generateId;
    this.#coordinator = coordinatorFor(journal);
  }

  revalidateFence(fence: WorkflowRunEpochFence): Promise<void> {
    return this.#serialized(() => this.#assertFence(fence));
  }

  readOperation(
    fence: WorkflowRunEpochFence,
    operation: WorkflowOperationIdentity,
  ): Promise<WorkflowOperationJournalState> {
    return this.#serialized(async () => {
      if (operation.runId !== this.#journal.runId) {
        throw new WorkflowRunStoreError(
          "event_mismatch",
          "Workflow operation belongs to a different run.",
        );
      }
      const { projection } = await this.#fold(fence);
      const folded = projection.operations.find((candidate) =>
        workflowOperationIdentityEquals(candidate.identity, operation),
      );
      return folded === undefined ? { attempts: [] } : operationState(folded);
    });
  }

  prepareOperation(
    fence: WorkflowRunEpochFence,
    preparation: Omit<WorkflowOperationRequest, "dispatchOrdinal">,
  ): Promise<WorkflowOperationRequest> {
    return this.#serialized(async () => {
      const { projection } = await this.#fold(fence);
      const existing = projection.operations.find((candidate) =>
        workflowOperationIdentityEquals(
          candidate.identity,
          preparation.identity,
        ),
      );
      if (existing !== undefined) {
        const expected = {
          ...preparation,
          dispatchOrdinal: existing.request.dispatchOrdinal,
        };
        if (!workflowOperationRequestMatches(existing.request, expected)) {
          throw new WorkflowRunStoreError(
            "immutable_conflict",
            `Workflow operation ${preparation.identity.operationId} was reused with another request.`,
          );
        }
        return existing.request;
      }
      const allocation = projection.ordinalAllocations.find(
        (candidate) =>
          candidate.definitionPath === preparation.identity.definitionPath,
      );
      const request: WorkflowOperationRequest = {
        ...preparation,
        dispatchOrdinal: createWorkflowDispatchOrdinal(
          allocation?.nextDispatchOrdinal ?? 1,
        ),
      };
      await this.#appendUnlocked(fence, {
        type: "operation_prepared",
        payload: { request },
      });
      return request;
    });
  }

  allocateAttempt(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
  ): Promise<WorkflowOperationAttempt> {
    return this.#serialized(async () => {
      const { projection } = await this.#fold(fence);
      const operation = preparedOperation(projection, request);
      const key = attemptLaneKey(request.identity);
      const rebaseFrom = this.#coordinator.attemptRebaseFrom.get(key);
      if (rebaseFrom !== undefined) {
        this.#rebaseAttemptLane(key, rebaseFrom, operation);
      }
      const nextNumber = Math.max(
        operation.nextAttemptNumber,
        this.#coordinator.nextAttemptNumbers.get(key) ?? 1,
      );
      const attemptId = createWorkflowAttemptId(this.#nextId("attempt"));
      if (
        this.#coordinator.reservedAttemptIds.has(attemptId) ||
        projection.operations.some((candidate) =>
          candidate.attempts.some(
            ({ attempt }) => attempt.attemptId === attemptId,
          ),
        )
      ) {
        throw new TypeError(
          `Workflow attempt ID ${attemptId} is already allocated.`,
        );
      }
      const attempt: WorkflowOperationAttempt = {
        operation: request.identity,
        requestDigest: request.requestDigest,
        definitionDigest: request.definitionDigest,
        dispatchOrdinal: request.dispatchOrdinal,
        attemptId,
        attemptNumber: createWorkflowAttemptNumber(nextNumber),
      };
      this.#coordinator.nextAttemptNumbers.set(key, nextNumber + 1);
      this.#coordinator.reservedAttemptIds.add(attemptId);
      const reservations =
        this.#coordinator.attemptReservations.get(key) ?? new Map();
      reservations.set(nextNumber, attempt);
      this.#coordinator.attemptReservations.set(key, reservations);
      return attempt;
    });
  }

  allocateResponseOrdinal(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
  ): Promise<WorkflowResponseOrdinal> {
    return this.#serialized(async () => {
      const { projection } = await this.#fold(fence);
      preparedOperation(projection, request);
      const definitionPath = request.identity.definitionPath;
      const key = responseLaneKey(fence, definitionPath);
      const foldedNext =
        projection.ordinalAllocations.find(
          (allocation) => allocation.definitionPath === definitionPath,
        )?.nextResponseOrdinal ?? 1;
      if (this.#coordinator.responseLaneFailures.has(key)) {
        this.#rebuildResponseLane(key, foldedNext);
      }
      const nextOrdinal = Math.max(
        foldedNext,
        this.#coordinator.nextResponseOrdinals.get(key) ?? 1,
      );
      const responseOrdinal = createWorkflowResponseOrdinal(nextOrdinal);
      const reservations =
        this.#coordinator.responseReservations.get(key) ?? new Map();
      if (reservations.has(responseOrdinal)) {
        throw new TypeError(
          `Workflow response ordinal ${responseOrdinal} is already reserved.`,
        );
      }
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const completion = new Promise<void>((complete, fail) => {
        resolve = complete;
        reject = fail;
      });
      void completion.catch(() => undefined);
      reservations.set(responseOrdinal, {
        request,
        generation: this.#coordinator.responseLaneGenerations.get(key) ?? 0,
        responseOrdinal,
        previous:
          this.#coordinator.responseCommitTails.get(key) ?? Promise.resolve(),
        completion,
        resolve,
        reject,
        state: "reserved",
      });
      this.#coordinator.responseReservations.set(key, reservations);
      this.#coordinator.responseCommitTails.set(key, completion);
      this.#coordinator.nextResponseOrdinals.set(key, nextOrdinal + 1);
      return responseOrdinal;
    });
  }

  async commitResponse<T>(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    responseOrdinal: WorkflowResponseOrdinal,
    commit: () => Promise<T>,
  ): Promise<T> {
    const key = responseLaneKey(fence, request.identity.definitionPath);
    const reservation = this.#coordinator.responseReservations
      .get(key)
      ?.get(responseOrdinal);
    if (
      reservation === undefined ||
      !workflowOperationRequestMatches(reservation.request, request)
    ) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow response commit does not match its reservation.",
      );
    }
    if (this.#coordinator.responseLaneFailures.has(key)) {
      throw this.#coordinator.responseLaneFailures.get(key);
    }
    if (reservation.state !== "reserved") {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        `Workflow response ordinal ${responseOrdinal} was committed more than once.`,
      );
    }
    reservation.state = "committing";
    try {
      await reservation.previous;
      await this.revalidateFence(fence);
      const result = await commit();
      reservation.state = "committed";
      reservation.resolve();
      this.#coordinator.responseReservations.get(key)?.delete(responseOrdinal);
      return result;
    } catch (error) {
      this.#closeResponseLane(
        key,
        responseOrdinal,
        error,
        reservation.generation,
      );
      throw error;
    }
  }

  async abandonResponse(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
    responseOrdinal: WorkflowResponseOrdinal,
    reason: unknown,
  ): Promise<void> {
    const key = responseLaneKey(fence, request.identity.definitionPath);
    const reservation = this.#coordinator.responseReservations
      .get(key)
      ?.get(responseOrdinal);
    if (reservation === undefined) {
      if (this.#coordinator.responseLaneFailures.has(key)) return;
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow response abandonment has no matching reservation.",
      );
    }
    if (!workflowOperationRequestMatches(reservation.request, request)) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow response abandonment does not match its reservation.",
      );
    }
    await this.revalidateFence(fence);
    this.#closeResponseLane(
      key,
      responseOrdinal,
      reason,
      reservation.generation,
    );
  }

  appendEvent<Type extends WorkflowRunEvent["type"]>(
    fence: WorkflowRunEpochFence,
    draft: WorkflowRunEventDraft<Type>,
  ): Promise<WorkflowRunEventAppend<Type>> {
    if (draft.type === "response_ready") {
      this.#validateResponseCommit(
        fence,
        draft as WorkflowRunEventDraft<"response_ready">,
      );
    }
    return this.#serialized(async () => {
      if (draft.type === "attempt_started") {
        this.#validateAttemptStart(
          (draft as WorkflowRunEventDraft<"attempt_started">).payload.attempt,
        );
      }
      try {
        const appended = await this.#appendUnlocked(fence, draft);
        if (draft.type === "attempt_started") {
          this.#observeAttemptStarted(
            (draft as WorkflowRunEventDraft<"attempt_started">).payload.attempt,
          );
        }
        return appended;
      } catch (error) {
        if (draft.type === "attempt_started") {
          this.#markAttemptLaneForRebase(
            (draft as WorkflowRunEventDraft<"attempt_started">).payload.attempt,
          );
        }
        throw error;
      }
    });
  }

  async #appendUnlocked<Type extends WorkflowRunEvent["type"]>(
    fence: WorkflowRunEpochFence,
    draft: WorkflowRunEventDraft<Type>,
  ): Promise<WorkflowRunEventAppend<Type>> {
    await this.#assertFence(fence);
    const { events } = await this.#journal.readEventLog();
    const created = events[0];
    if (created === undefined && draft.type !== "run_created") {
      throw new WorkflowProjectionFoldError(
        "invalid_sequence",
        "The first workflow event must create the run.",
      );
    }
    if (
      created !== undefined &&
      (created.type !== "run_created" ||
        created.runId !== this.#journal.runId ||
        !durableWorkflowOwnerEquals(
          created.payload.durableOwner,
          this.#journal.owner,
        ))
    ) {
      throw new WorkflowProjectionFoldError(
        "wrong_run",
        "Workflow event prefix does not belong to the fenced journal.",
      );
    }
    if (created !== undefined && draft.type === "run_created") {
      throw new WorkflowProjectionFoldError(
        "duplicate_event",
        "A workflow run can only be created once.",
      );
    }
    const eventId = this.#nextId("event");
    if (events.some((event) => event.eventId === eventId)) {
      throw new TypeError(`Workflow event ID ${eventId} is already allocated.`);
    }
    const event = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId,
      runId: fence.runId,
      runEpoch: fence.runEpoch,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      type: draft.type,
      payload: draft.payload,
    } as Extract<WorkflowRunEvent, { type: Type }>;
    if (!isWorkflowRunEvent(event) || event.type !== draft.type) {
      throw new TypeError("Workflow event draft is invalid.");
    }
    const receipt = await this.#journal.append(event);
    return { event, receipt };
  }

  putOutcomeBlob(
    fence: WorkflowRunEpochFence,
    value: EncodedDurableValue,
  ): Promise<WorkflowBlobReference> {
    return this.#serialized(async () => {
      await this.#assertFence(fence);
      const decoded = decodeCanonicalEncoding(value);
      const reference = await this.#journal.writeOutput(decoded);
      if (
        reference.sha256 !== value.sha256 ||
        reference.sizeBytes !== value.bytes
      ) {
        throw new WorkflowRunStoreError(
          "immutable_conflict",
          "Workflow output reference does not match its canonical value.",
        );
      }
      return reference;
    });
  }

  readOutcomeBlob(
    fence: WorkflowRunEpochFence,
    reference: WorkflowBlobReference,
  ): Promise<string | Uint8Array> {
    return this.#serialized(async () => {
      await this.#assertFence(fence);
      const value = await this.#journal.readOutput(reference);
      await this.#journal.revalidateFence();
      return encodeDurableValue(value).json;
    });
  }

  #validateAttemptStart(attempt: WorkflowOperationAttempt): void {
    const reservation = this.#coordinator.attemptReservations
      .get(attemptLaneKey(attempt.operation))
      ?.get(attempt.attemptNumber);
    if (reservation?.attemptId !== attempt.attemptId) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow attempt-start append does not match its reservation.",
      );
    }
  }

  #observeAttemptStarted(attempt: WorkflowOperationAttempt): void {
    const key = attemptLaneKey(attempt.operation);
    const reservations = this.#coordinator.attemptReservations.get(key);
    if (
      reservations?.get(attempt.attemptNumber)?.attemptId === attempt.attemptId
    ) {
      reservations.delete(attempt.attemptNumber);
      if (reservations.size === 0) {
        this.#coordinator.attemptReservations.delete(key);
      }
    }
    this.#coordinator.reservedAttemptIds.delete(attempt.attemptId);
  }

  #markAttemptLaneForRebase(attempt: WorkflowOperationAttempt): void {
    const key = attemptLaneKey(attempt.operation);
    const current = this.#coordinator.attemptRebaseFrom.get(key);
    this.#coordinator.attemptRebaseFrom.set(
      key,
      Math.min(current ?? attempt.attemptNumber, attempt.attemptNumber),
    );
  }

  #rebaseAttemptLane(
    key: string,
    fromNumber: number,
    operation: DurableWorkflowOperationProjection,
  ): void {
    const reservations = this.#coordinator.attemptReservations.get(key);
    let highestReserved = 0;
    if (reservations !== undefined) {
      for (const [attemptNumber, attempt] of reservations) {
        const observed = operation.attempts.some(
          ({ attempt: durable }) => durable.attemptId === attempt.attemptId,
        );
        if (observed || attemptNumber >= fromNumber) {
          reservations.delete(attemptNumber);
          this.#coordinator.reservedAttemptIds.delete(attempt.attemptId);
        } else {
          highestReserved = Math.max(highestReserved, attemptNumber);
        }
      }
      if (reservations.size === 0) {
        this.#coordinator.attemptReservations.delete(key);
      }
    }
    this.#coordinator.nextAttemptNumbers.set(
      key,
      Math.max(operation.nextAttemptNumber, highestReserved + 1),
    );
    this.#coordinator.attemptRebaseFrom.delete(key);
  }

  #rebuildResponseLane(key: string, foldedNext: number): void {
    const failure = this.#coordinator.responseLaneFailures.get(key);
    const reservations = this.#coordinator.responseReservations.get(key);
    if (failure !== undefined && reservations !== undefined) {
      for (const reservation of reservations.values()) {
        if (reservation.state === "committed") continue;
        reservation.state = "abandoned";
        reservation.reject(failure);
      }
    }
    this.#coordinator.responseReservations.delete(key);
    this.#coordinator.responseLaneFailures.delete(key);
    this.#coordinator.responseCommitTails.set(key, Promise.resolve());
    this.#coordinator.nextResponseOrdinals.set(key, foldedNext);
    this.#coordinator.responseLaneGenerations.set(
      key,
      (this.#coordinator.responseLaneGenerations.get(key) ?? 0) + 1,
    );
  }

  #closeResponseLane(
    key: string,
    fromOrdinal: WorkflowResponseOrdinal,
    reason: unknown,
    generation: number,
  ): void {
    if (
      generation !== (this.#coordinator.responseLaneGenerations.get(key) ?? 0)
    ) {
      return;
    }
    const existingFailure = this.#coordinator.responseLaneFailures.get(key);
    const failure =
      existingFailure ??
      (reason instanceof Error
        ? reason
        : new Error(`Workflow response lane abandoned: ${String(reason)}`));
    this.#coordinator.responseLaneFailures.set(key, failure);
    const reservations = this.#coordinator.responseReservations.get(key);
    if (reservations === undefined) return;
    for (const [ordinal, reservation] of reservations) {
      if (ordinal < fromOrdinal || reservation.state === "committed") continue;
      reservation.state = "abandoned";
      reservation.reject(failure);
    }
  }

  #validateResponseCommit(
    fence: WorkflowRunEpochFence,
    draft: WorkflowRunEventDraft<"response_ready">,
  ): void {
    const { operation, dispatchOrdinal, responseOrdinal } = draft.payload;
    const key = responseLaneKey(fence, operation.definitionPath);
    const reservation = this.#coordinator.responseReservations
      .get(key)
      ?.get(responseOrdinal);
    if (
      reservation === undefined ||
      reservation.state !== "committing" ||
      reservation.generation !==
        (this.#coordinator.responseLaneGenerations.get(key) ?? 0) ||
      reservation.request.dispatchOrdinal !== dispatchOrdinal ||
      !workflowOperationIdentityEquals(reservation.request.identity, operation)
    ) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow response-ready append is outside its ordered commit.",
      );
    }
  }

  #serialized<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#coordinator.tail.then(action);
    this.#coordinator.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #assertFence(fence: WorkflowRunEpochFence): Promise<void> {
    const journalFence = this.#journal.fence;
    if (
      journalFence === undefined ||
      !workflowRunEpochFenceEquals(journalFence, fence)
    ) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "Workflow operation journal fence is no longer current.",
      );
    }
    await this.#journal.revalidateFence();
  }

  async #fold(fence: WorkflowRunEpochFence): Promise<FoldedJournal> {
    await this.#assertFence(fence);
    const { events } = await this.#journal.readEventLog();
    const projection = foldWorkflowRunEvents(events);
    if (
      projection.runId !== this.#journal.runId ||
      !durableWorkflowOwnerEquals(projection.owner, this.#journal.owner) ||
      projection.runEpoch !== fence.runEpoch
    ) {
      throw new WorkflowProjectionFoldError(
        "wrong_run",
        "Workflow event prefix does not belong to the fenced journal.",
      );
    }
    return { events, projection };
  }

  #nextId(purpose: "attempt" | "event"): string {
    const id = this.#generateId();
    if (!isWorkflowIdentifier(id)) {
      throw new TypeError(`Generated workflow ${purpose} ID is invalid.`);
    }
    return id;
  }
}

/** Safe recovery verifier which derives every blob location through openRun. */
export class WorkflowRunBlobResolver implements WorkflowRecoveryBlobResolver {
  readonly #store: Pick<WorkflowRunStore, "openRun">;

  constructor(store: Pick<WorkflowRunStore, "openRun">) {
    this.#store = store;
  }

  async verifyBlob(
    request: WorkflowBlobVerificationRequest,
  ): Promise<WorkflowBlobVerificationResult> {
    try {
      const journal = await this.#store.openRun(request.owner, request.runId);
      if (
        request.purpose === "definition" ||
        request.purpose === "plan_definition"
      ) {
        await journal.readDefinition(request.reference);
      } else {
        await journal.readOutput(request.reference);
      }
      return { ok: true };
    } catch (error) {
      return mapBlobVerificationFailure(error);
    }
  }
}

function responseLaneKey(
  fence: WorkflowRunEpochFence,
  definitionPath: string,
): string {
  return JSON.stringify([
    fence.durableOwner.projectKey,
    fence.durableOwner.piSessionKey,
    fence.runId,
    fence.runEpoch,
    fence.scopeId,
    fence.generation,
    fence.leaseToken,
    definitionPath,
  ]);
}

function attemptLaneKey(operation: WorkflowOperationIdentity): string {
  return `${operation.definitionPath}\u0000${operation.operationId}`;
}

function coordinatorFor(journal: WorkflowRunJournal): JournalCoordinator {
  const existing = journalCoordinators.get(journal);
  if (existing !== undefined) return existing;
  const coordinator: JournalCoordinator = {
    tail: Promise.resolve(),
    nextAttemptNumbers: new Map(),
    attemptReservations: new Map(),
    attemptRebaseFrom: new Map(),
    nextResponseOrdinals: new Map(),
    reservedAttemptIds: new Set(),
    responseCommitTails: new Map(),
    responseLaneFailures: new Map(),
    responseLaneGenerations: new Map(),
    responseReservations: new Map(),
  };
  journalCoordinators.set(journal, coordinator);
  return coordinator;
}

function preparedOperation(
  projection: DurableWorkflowProjection,
  request: WorkflowOperationRequest,
): DurableWorkflowOperationProjection {
  const operation = projection.operations.find((candidate) =>
    workflowOperationIdentityEquals(candidate.identity, request.identity),
  );
  if (operation === undefined) {
    throw new WorkflowProjectionFoldError(
      "identity_conflict",
      "Workflow operation must be prepared before ordinal allocation.",
    );
  }
  if (!workflowOperationRequestMatches(operation.request, request)) {
    throw new WorkflowProjectionFoldError(
      "identity_conflict",
      "Workflow operation request conflicts with its prepared request.",
    );
  }
  return operation;
}

function operationState(
  operation: DurableWorkflowOperationProjection,
): WorkflowOperationJournalState {
  const settlement = operation.settlement;
  const response =
    settlement === undefined
      ? undefined
      : operation.responses.find(
          (candidate) => candidate.settlementEventId === settlement.eventId,
        );
  return {
    request: operation.request,
    attempts: operation.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      dispatched: attempt.dispatchedEventId !== undefined,
      status: attempt.status,
      ...(attempt.process === undefined ? {} : { process: attempt.process }),
      ...(attempt.usageEventIds.length === 0
        ? {}
        : { observedUsage: attempt.usageObserved }),
      ...(attempt.settlementEventId === undefined ||
      attempt.outcome === undefined ||
      attempt.accounting === undefined
        ? {}
        : {
            settlement: {
              eventId: attempt.settlementEventId,
              outcome: attempt.outcome,
              accounting: attempt.accounting,
            },
          }),
    })),
    ...(settlement === undefined
      ? {}
      : {
          settlement: {
            eventId: settlement.eventId,
            attempt: settlement.attempt,
            outcome: settlement.outcome,
            accounting: settlement.accounting,
            ...(response === undefined
              ? {}
              : { responseOrdinal: response.responseOrdinal }),
          },
        }),
  };
}

function decodeCanonicalEncoding(value: EncodedDurableValue): DurableValue {
  const decoded = decodeDurableValue(value.json);
  const canonical = encodeDurableValue(decoded);
  if (
    canonical.json !== value.json ||
    canonical.bytes !== value.bytes ||
    canonical.sha256 !== value.sha256
  ) {
    throw new TypeError("Encoded durable workflow value metadata is invalid.");
  }
  return decoded;
}

function mapBlobVerificationFailure(
  error: unknown,
): WorkflowBlobVerificationResult {
  if (error instanceof WorkflowRunStoreError) {
    if (error.code === "hash_mismatch" || error.code === "size_mismatch") {
      return { ok: false, code: error.code, diagnostic: error.message };
    }
    if (
      error.code === "path_mismatch" ||
      error.code === "symlink_rejected" ||
      error.code === "run_not_found" ||
      error.code === "invalid_owner" ||
      error.code === "invalid_run_id"
    ) {
      return {
        ok: false,
        code: "path_mismatch",
        diagnostic:
          "Workflow blob could not be resolved through its run namespace.",
      };
    }
  }
  if (isFilesystemPathFailure(error)) {
    return {
      ok: false,
      code: "path_mismatch",
      diagnostic: "Workflow blob path is absent or is not a regular file.",
    };
  }
  throw error;
}

function isFilesystemPathFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"].includes(
    String((error as { readonly code: unknown }).code),
  );
}

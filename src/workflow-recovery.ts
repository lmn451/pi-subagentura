import {
  assertWorkflowQuota,
  resolveWorkflowQuotaLimits,
  type WorkflowQuotaLimits,
} from "./workflow-quotas";
import {
  durableWorkflowOwnerEquals,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowBlobReference,
  type WorkflowRunEvent,
} from "./workflow-run-types";
import {
  WorkflowProjectionFoldError,
  foldWorkflowRunEvents,
  type DurableWorkflowFailureProjection,
  type DurableWorkflowProjection,
  type WorkflowProjectionRepository,
} from "./workflow-projection-repository";

export type WorkflowRecoveryReason = "startup" | "reload" | "resume";

export type WorkflowRecoveryLimits = Pick<
  WorkflowQuotaLimits,
  "maxStartupRuns" | "maxStartupEvents" | "maxStartupBytes"
>;

export interface WorkflowRecoveryOptions {
  readonly limits?: Partial<WorkflowRecoveryLimits>;
}

export interface WorkflowRecoveryEventLogRead {
  readonly events: readonly WorkflowRunEvent[];
  readonly completeBytes: number;
  /** Incomplete final-line bytes, supplied separately from authoritative events. */
  readonly tornTailBytes: number;
}

export interface WorkflowRecoveryRunJournalReader {
  readEventLog(): Promise<WorkflowRecoveryEventLogRead>;
}

/** Structurally implemented by WorkflowRunStore without coupling recovery to paths. */
export interface WorkflowRecoveryStoreReader {
  listRunIds(
    owner: DurableWorkflowOwner,
    maxResults: number,
  ): Promise<readonly DurableWorkflowRunId[]>;
  openRun(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowRecoveryRunJournalReader>;
}

export type WorkflowBlobPurpose =
  | "definition"
  | "plan_definition"
  | "operation_value"
  | "operation_error"
  | "run_result"
  | "delivery_payload";

export interface WorkflowBlobVerificationRequest {
  readonly owner: DurableWorkflowOwner;
  readonly runId: DurableWorkflowRunId;
  readonly eventId: string;
  readonly purpose: WorkflowBlobPurpose;
  readonly reference: WorkflowBlobReference;
}

export type WorkflowBlobVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "hash_mismatch" | "size_mismatch" | "path_mismatch";
      readonly diagnostic: string;
    };

/** Implementations derive their own safe path; callers never supply a raw path. */
export interface WorkflowRecoveryBlobResolver {
  verifyBlob(
    request: WorkflowBlobVerificationRequest,
  ): Promise<WorkflowBlobVerificationResult>;
}

export interface WorkflowRecoveryFailure {
  readonly code:
    | "malformed_complete_line"
    | "hash_mismatch"
    | "size_mismatch"
    | "path_mismatch";
  readonly diagnostic: string;
  readonly eventId?: string;
  readonly byteOffset?: number;
}

export interface WorkflowRecoveredRun {
  readonly kind: "recovered" | "recovery_failed";
  readonly runId: DurableWorkflowRunId;
  readonly projection?: DurableWorkflowProjection;
  readonly failure?: WorkflowRecoveryFailure;
  readonly interrupted: boolean;
  readonly trustedResumeEligible: boolean;
  readonly trustedResumeRequired: boolean;
  readonly automaticResumeEligible: boolean;
  readonly ignoredIncompleteTailBytes: number;
}

export interface WorkflowOwnerRecovery {
  readonly owner: DurableWorkflowOwner;
  readonly reason: WorkflowRecoveryReason;
  readonly runs: readonly WorkflowRecoveredRun[];
  readonly interrupted: readonly DurableWorkflowProjection[];
}

const MAX_RECOVERY_DIAGNOSTIC_LENGTH = 1024;

function boundedDiagnostic(diagnostic: string): string {
  return diagnostic.length <= MAX_RECOVERY_DIAGNOSTIC_LENGTH
    ? diagnostic
    : diagnostic.slice(0, MAX_RECOVERY_DIAGNOSTIC_LENGTH);
}

function referencedBlobs(
  owner: DurableWorkflowOwner,
  runId: DurableWorkflowRunId,
  events: readonly WorkflowRunEvent[],
): readonly WorkflowBlobVerificationRequest[] {
  const references: WorkflowBlobVerificationRequest[] = [];
  const seen = new Set<string>();
  const add = (
    eventId: string,
    purpose: WorkflowBlobPurpose,
    reference: WorkflowBlobReference,
  ): void => {
    const key = `${purpose}\u0000${reference.sha256}\u0000${reference.sizeBytes}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ owner, runId, eventId, purpose, reference });
  };

  for (const event of events) {
    switch (event.type) {
      case "definition_captured":
        add(event.eventId, "definition", event.payload.definition);
        break;
      case "plan_defined":
      case "plan_revised":
        add(event.eventId, "plan_definition", event.payload.definition);
        break;
      case "attempt_settled":
      case "operation_settled":
        if (event.payload.outcome.status === "succeeded") {
          add(event.eventId, "operation_value", event.payload.outcome.value);
        } else if (event.payload.outcome.status !== "cancelled") {
          add(event.eventId, "operation_error", event.payload.outcome.error);
        }
        break;
      case "run_result_recorded":
        add(event.eventId, "run_result", event.payload.result);
        break;
      case "delivery_intent_recorded":
        add(event.eventId, "delivery_payload", event.payload.payload);
        break;
    }
  }
  return references;
}

function asInterrupted(
  projection: DurableWorkflowProjection,
): DurableWorkflowProjection {
  if (
    projection.terminal !== undefined ||
    projection.status === "interrupted"
  ) {
    return projection;
  }
  if (projection.status !== "running") {
    return projection;
  }
  return Object.freeze({ ...projection, status: "interrupted" });
}

function withBlobFailure(
  projection: DurableWorkflowProjection,
  failure: WorkflowRecoveryFailure,
): DurableWorkflowProjection {
  const projectedFailure: DurableWorkflowFailureProjection = Object.freeze({
    source: "blob_verification",
    code: failure.code,
    diagnostic: failure.diagnostic,
  });
  return Object.freeze({
    ...projection,
    status: projection.terminal === undefined ? "error" : projection.status,
    recoveryFailures: Object.freeze([
      ...projection.recoveryFailures,
      projectedFailure,
    ]),
  });
}

function eligibility(
  projection: DurableWorkflowProjection,
  reason: WorkflowRecoveryReason,
): Pick<
  WorkflowRecoveredRun,
  | "interrupted"
  | "trustedResumeEligible"
  | "trustedResumeRequired"
  | "automaticResumeEligible"
> {
  const interrupted = projection.status === "interrupted";
  const trustedResumeEligible =
    interrupted && projection.resumePolicy !== "never";
  const automaticResumeEligible =
    interrupted &&
    reason !== "startup" &&
    projection.resumePolicy === "automatic_on_reload_or_resume";
  const trustedResumeRequired =
    trustedResumeEligible &&
    !automaticResumeEligible &&
    (reason === "startup" || projection.resumePolicy === "trusted_resume");
  return {
    interrupted,
    trustedResumeEligible,
    trustedResumeRequired,
    automaticResumeEligible,
  };
}

export class WorkflowRecoveryService {
  readonly #reader: WorkflowRecoveryStoreReader;
  readonly #repository: WorkflowProjectionRepository;
  readonly #blobResolver: WorkflowRecoveryBlobResolver;
  readonly #limits: WorkflowQuotaLimits;

  constructor(
    reader: WorkflowRecoveryStoreReader,
    repository: WorkflowProjectionRepository,
    blobResolver: WorkflowRecoveryBlobResolver,
    options: WorkflowRecoveryOptions = {},
  ) {
    this.#reader = reader;
    this.#repository = repository;
    this.#blobResolver = blobResolver;
    this.#limits = resolveWorkflowQuotaLimits(options.limits);
  }

  async recoverOwner(
    owner: DurableWorkflowOwner,
    reason: WorkflowRecoveryReason = "startup",
  ): Promise<WorkflowOwnerRecovery> {
    const runIds = await this.#reader.listRunIds(
      owner,
      this.#limits.maxStartupRuns,
    );
    assertWorkflowQuota("maxStartupRuns", runIds.length, this.#limits);
    let scannedEvents = 0;
    let scannedBytes = 0;
    const seenRuns = new Set<DurableWorkflowRunId>();
    const results: WorkflowRecoveredRun[] = [];
    const rebuilt: DurableWorkflowProjection[] = [];

    for (const runId of runIds) {
      if (seenRuns.has(runId)) {
        results.push({
          kind: "recovery_failed",
          runId,
          failure: {
            code: "malformed_complete_line",
            diagnostic: "store returned the same run more than once",
          },
          interrupted: false,
          trustedResumeEligible: false,
          trustedResumeRequired: false,
          automaticResumeEligible: false,
          ignoredIncompleteTailBytes: 0,
        });
        continue;
      }
      seenRuns.add(runId);

      let read: WorkflowRecoveryEventLogRead;
      try {
        const journal = await this.#reader.openRun(owner, runId);
        read = await journal.readEventLog();
      } catch (error) {
        const byteOffset =
          typeof error === "object" &&
          error !== null &&
          "byteOffset" in error &&
          Number.isSafeInteger(error.byteOffset) &&
          (error.byteOffset as number) >= 0
            ? (error.byteOffset as number)
            : undefined;
        results.push({
          kind: "recovery_failed",
          runId,
          failure: {
            code: "malformed_complete_line",
            diagnostic: boundedDiagnostic(
              error instanceof Error ? error.message : String(error),
            ),
            ...(byteOffset === undefined ? {} : { byteOffset }),
          },
          interrupted: false,
          trustedResumeEligible: false,
          trustedResumeRequired: false,
          automaticResumeEligible: false,
          ignoredIncompleteTailBytes: 0,
        });
        continue;
      }
      if (
        !Number.isSafeInteger(read.completeBytes) ||
        !Number.isSafeInteger(read.tornTailBytes) ||
        read.completeBytes < 0 ||
        read.tornTailBytes < 0
      ) {
        results.push({
          kind: "recovery_failed",
          runId,
          failure: {
            code: "malformed_complete_line",
            diagnostic: "store returned invalid bounded journal byte counts",
          },
          interrupted: false,
          trustedResumeEligible: false,
          trustedResumeRequired: false,
          automaticResumeEligible: false,
          ignoredIncompleteTailBytes: 0,
        });
        continue;
      }
      scannedEvents += read.events.length;
      scannedBytes += read.completeBytes + read.tornTailBytes;
      assertWorkflowQuota("maxStartupEvents", scannedEvents, this.#limits);
      assertWorkflowQuota("maxStartupBytes", scannedBytes, this.#limits);
      const tailBytes = read.tornTailBytes;
      let folded: DurableWorkflowProjection;
      try {
        folded = foldWorkflowRunEvents(read.events);
        if (
          folded.runId !== runId ||
          !durableWorkflowOwnerEquals(folded.owner, owner)
        ) {
          throw new WorkflowProjectionFoldError(
            "wrong_run",
            "store reader returned a run outside the requested owner namespace",
          );
        }
      } catch (error) {
        const diagnostic = boundedDiagnostic(
          error instanceof Error ? error.message : String(error),
        );
        results.push({
          kind: "recovery_failed",
          runId,
          failure: { code: "malformed_complete_line", diagnostic },
          interrupted: false,
          trustedResumeEligible: false,
          trustedResumeRequired: false,
          automaticResumeEligible: false,
          ignoredIncompleteTailBytes: tailBytes,
        });
        continue;
      }

      let mismatch: WorkflowRecoveryFailure | undefined;
      for (const reference of referencedBlobs(owner, runId, read.events)) {
        let verification: WorkflowBlobVerificationResult;
        try {
          verification = await this.#blobResolver.verifyBlob(reference);
        } catch (error) {
          verification = {
            ok: false,
            code: "path_mismatch",
            diagnostic: error instanceof Error ? error.message : String(error),
          };
        }
        if (!verification.ok) {
          mismatch = {
            code: verification.code,
            diagnostic: boundedDiagnostic(verification.diagnostic),
            eventId: reference.eventId,
          };
          break;
        }
      }

      if (mismatch !== undefined) {
        const failedProjection = withBlobFailure(folded, mismatch);
        rebuilt.push(failedProjection);
        results.push({
          kind: "recovery_failed",
          runId,
          projection: failedProjection,
          failure: mismatch,
          interrupted: false,
          trustedResumeEligible: false,
          trustedResumeRequired: false,
          automaticResumeEligible: false,
          ignoredIncompleteTailBytes: tailBytes,
        });
        continue;
      }

      const projection = asInterrupted(folded);
      const resume = eligibility(projection, reason);
      rebuilt.push(projection);
      results.push({
        kind: "recovered",
        runId,
        projection,
        ...resume,
        ignoredIncompleteTailBytes: tailBytes,
      });
    }

    // One replacement makes stale state disposable and prevents it from winning.
    await this.#repository.replaceAll(owner, rebuilt);
    const interrupted = rebuilt.filter(
      (projection) => projection.status === "interrupted",
    );
    return Object.freeze({
      owner,
      reason,
      runs: Object.freeze(results),
      interrupted: Object.freeze(interrupted),
    });
  }
}

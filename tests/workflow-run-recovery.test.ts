import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowRunEpochFence,
  createWorkflowSha256Digest,
  type DurableWorkflowOwner,
  type DurableWorkflowResumePolicy,
  type DurableWorkflowRunId,
  type WorkflowRunEvent,
} from "../src/workflow-run-types";
import {
  InMemoryWorkflowProjectionRepository,
  foldWorkflowRunEvents,
} from "../src/workflow-projection-repository";
import {
  WorkflowRecoveryService,
  type WorkflowBlobVerificationRequest,
  type WorkflowBlobVerificationResult,
  type WorkflowRecoveryStoreReader,
} from "../src/workflow-recovery";

const owner: DurableWorkflowOwner = {
  projectKey: "1".repeat(64),
  piSessionKey: "recovery-session",
};
const runId = createDurableWorkflowRunId("recovery-run");
const rootPath = createWorkflowDefinitionPath("root");
const definitionDigest = createWorkflowDefinitionDigest("2".repeat(64));
const resultDigest = createWorkflowSha256Digest("3".repeat(64));
const zeroAccounting = {
  completeness: "exact" as const,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
  },
};

type EventOf<Type extends WorkflowRunEvent["type"]> = Extract<
  WorkflowRunEvent,
  { type: Type }
>;

function event<Type extends WorkflowRunEvent["type"]>(
  type: Type,
  sequence: number,
  payload: EventOf<Type>["payload"],
): EventOf<Type> {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId: `recovery-event-${sequence}`,
    runId,
    runEpoch: 1,
    sequence,
    type,
    payload,
  } as unknown as EventOf<Type>;
}

function runningEvents(
  resumePolicy: DurableWorkflowResumePolicy = "trusted_resume",
): WorkflowRunEvent[] {
  return [
    event("run_created", 1, {
      durableOwner: owner,
      executionKind: "plan",
      rootDefinitionPath: rootPath,
      rootDefinitionDigest: definitionDigest,
      resumePolicy,
    }),
    event("run_epoch_acquired", 2, {
      fence: createWorkflowRunEpochFence(
        owner,
        {
          scopeId: 4,
          generation: 2,
          leaseToken: "recovery_lease_token_0123456789",
          runEpoch: 1,
        },
        runId,
      ),
      previousRunEpoch: null,
      reason: "created",
    }),
    event("definition_captured", 3, {
      captureKind: "root",
      definitionPath: rootPath,
      definitionDigest,
      definition: { sha256: definitionDigest, sizeBytes: 80 },
    }),
  ];
}

function terminalEvents(): WorkflowRunEvent[] {
  return [
    ...runningEvents(),
    event("run_result_recorded", 4, {
      result: { sha256: resultDigest, sizeBytes: 20 },
      accounting: zeroAccounting,
    }),
    event("run_terminal", 5, {
      status: "done",
      accounting: zeroAccounting,
      resultEventId: "recovery-event-4",
    }),
  ];
}

function storeReader(
  events: readonly WorkflowRunEvent[],
  tornTailBytes = 0,
): WorkflowRecoveryStoreReader {
  return {
    listRunIds: vi.fn(async () => [runId]),
    openRun: vi.fn(
      async (_owner: DurableWorkflowOwner, requested: DurableWorkflowRunId) => {
        expect(requested).toBe(runId);
        return {
          readEventLog: async () => ({
            events,
            completeBytes: 500,
            tornTailBytes,
          }),
        };
      },
    ),
  };
}

function acceptingResolver(seen: WorkflowBlobVerificationRequest[] = []): {
  verifyBlob(
    request: WorkflowBlobVerificationRequest,
  ): Promise<WorkflowBlobVerificationResult>;
} {
  return {
    async verifyBlob(request) {
      seen.push(request);
      return { ok: true };
    },
  };
}

describe("WorkflowRecoveryService", () => {
  it("exposes stale current-owner running state as interrupted at startup", async () => {
    const repository = new InMemoryWorkflowProjectionRepository();
    const service = new WorkflowRecoveryService(
      storeReader(runningEvents()),
      repository,
      acceptingResolver(),
    );

    const recovery = await service.recoverOwner(owner, "startup");
    const recovered = recovery.runs[0]!;

    expect(recovered).toMatchObject({
      kind: "recovered",
      interrupted: true,
      trustedResumeEligible: true,
      trustedResumeRequired: true,
      automaticResumeEligible: false,
    });
    expect(recovered.projection).toMatchObject({
      journalStatus: "running",
      status: "interrupted",
    });
    expect(recovery.interrupted).toEqual([recovered.projection]);
    expect((await repository.get(owner, runId))?.status).toBe("interrupted");
  });

  it("does not auto-run trusted resume policy and only reports automatic eligibility", async () => {
    const trusted = new WorkflowRecoveryService(
      storeReader(runningEvents("trusted_resume")),
      new InMemoryWorkflowProjectionRepository(),
      acceptingResolver(),
    );
    expect((await trusted.recoverOwner(owner, "reload")).runs[0]).toMatchObject(
      {
        interrupted: true,
        trustedResumeRequired: true,
        automaticResumeEligible: false,
      },
    );

    const automatic = new WorkflowRecoveryService(
      storeReader(runningEvents("automatic_on_reload_or_resume")),
      new InMemoryWorkflowProjectionRepository(),
      acceptingResolver(),
    );
    expect(
      (await automatic.recoverOwner(owner, "reload")).runs[0],
    ).toMatchObject({
      interrupted: true,
      trustedResumeRequired: false,
      automaticResumeEligible: true,
    });
  });

  it("rebuilds stale disposable snapshots from the authoritative event prefix", async () => {
    const repository = new InMemoryWorkflowProjectionRepository();
    const staleTerminal = foldWorkflowRunEvents(terminalEvents());
    await repository.replace(owner, staleTerminal);
    const service = new WorkflowRecoveryService(
      storeReader(runningEvents()),
      repository,
      acceptingResolver(),
    );

    await service.recoverOwner(owner, "startup");

    const rebuilt = await repository.get(owner, runId);
    expect(rebuilt?.terminal).toBeUndefined();
    expect(rebuilt?.sequence).toBe(3);
    expect(rebuilt?.status).toBe("interrupted");
  });

  it("ignores a separately supplied torn tail without parsing it as authority", async () => {
    const repository = new InMemoryWorkflowProjectionRepository();
    const service = new WorkflowRecoveryService(
      storeReader(runningEvents(), 37),
      repository,
      acceptingResolver(),
    );

    const recovered = (await service.recoverOwner(owner)).runs[0]!;

    expect(recovered.kind).toBe("recovered");
    expect(recovered.ignoredIncompleteTailBytes).toBe(37);
    expect(recovered.projection?.lastEventId).toBe("recovery-event-3");
  });

  it("verifies every distinct referenced blob through the path-free resolver", async () => {
    const seen: WorkflowBlobVerificationRequest[] = [];
    const service = new WorkflowRecoveryService(
      storeReader(terminalEvents()),
      new InMemoryWorkflowProjectionRepository(),
      acceptingResolver(seen),
    );

    const recovered = (await service.recoverOwner(owner)).runs[0]!;

    expect(recovered.kind).toBe("recovered");
    expect(seen.map(({ purpose }) => purpose)).toEqual([
      "definition",
      "run_result",
    ]);
    expect(seen.every((entry) => !("path" in entry))).toBe(true);
    expect(recovered.projection?.status).toBe("done");
  });

  it("fails closed with recovery_failed state when blob verification mismatches", async () => {
    const repository = new InMemoryWorkflowProjectionRepository();
    const service = new WorkflowRecoveryService(
      storeReader(runningEvents()),
      repository,
      {
        async verifyBlob() {
          return {
            ok: false,
            code: "hash_mismatch",
            diagnostic:
              "definition content hash does not match journal reference",
          };
        },
      },
    );

    const recovered = (await service.recoverOwner(owner)).runs[0]!;

    expect(recovered).toMatchObject({
      kind: "recovery_failed",
      failure: { code: "hash_mismatch", eventId: "recovery-event-3" },
      interrupted: false,
      trustedResumeEligible: false,
      trustedResumeRequired: false,
    });
    expect(recovered.projection).toMatchObject({
      journalStatus: "running",
      status: "error",
      recoveryFailures: [
        {
          source: "blob_verification",
          code: "hash_mismatch",
        },
      ],
    });
    expect((await repository.get(owner, runId))?.status).toBe("error");
  });

  it("treats malformed complete authoritative events as recovery failure", async () => {
    const malformed = runningEvents();
    malformed[2] = { ...malformed[2]!, sequence: 99 } as WorkflowRunEvent;
    const repository = new InMemoryWorkflowProjectionRepository();
    await repository.replace(owner, foldWorkflowRunEvents(terminalEvents()));
    const service = new WorkflowRecoveryService(
      storeReader(malformed),
      repository,
      acceptingResolver(),
    );

    const recovered = (await service.recoverOwner(owner)).runs[0]!;

    expect(recovered).toMatchObject({
      kind: "recovery_failed",
      failure: { code: "malformed_complete_line" },
    });
    expect(await repository.get(owner, runId)).toBeUndefined();
  });
});

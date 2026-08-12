import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  createWorkflowResponseOrdinal,
  createWorkflowRunEpochFence,
  createWorkflowSha256Digest,
  type DurableWorkflowOwner,
  type DurableWorkflowUsage,
  type WorkflowOperationAttempt,
  type WorkflowOperationRequest,
  type WorkflowRunEvent,
  type WorkflowUsageAccounting,
} from "../src/workflow-run-types";
import { createWorkflowProcessAttemptManifest } from "../src/workflow-process-attempt";
import {
  InMemoryWorkflowProjectionRepository,
  WorkflowProjectionFoldError,
  foldWorkflowRunEvents,
} from "../src/workflow-projection-repository";

const owner: DurableWorkflowOwner = {
  projectKey: "a".repeat(64),
  piSessionKey: "projection-session",
};
const otherOwner: DurableWorkflowOwner = {
  projectKey: "b".repeat(64),
  piSessionKey: "projection-session",
};
const runId = createDurableWorkflowRunId("projection-run");
const rootPath = createWorkflowDefinitionPath("root");
const definitionDigest = createWorkflowDefinitionDigest("c".repeat(64));
const resultDigest = createWorkflowSha256Digest("d".repeat(64));
const outputDigest = createWorkflowSha256Digest("e".repeat(64));
const requestDigest = createWorkflowRequestDigest("f".repeat(64));
const otherRequestDigest = createWorkflowRequestDigest("0".repeat(64));
const identity = createWorkflowOperationIdentity(
  runId,
  rootPath,
  "task-a-call",
);
const usage: DurableWorkflowUsage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  costUsd: 0.02,
  turns: 1,
  costSource: "provider",
};
const exact: WorkflowUsageAccounting = { completeness: "exact", usage };
const zero: WorkflowUsageAccounting = {
  completeness: "exact",
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
const request: WorkflowOperationRequest = {
  schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
  identity,
  requestDigest,
  definitionDigest,
  dispatchOrdinal: createWorkflowDispatchOrdinal(1),
};
const attempt: WorkflowOperationAttempt = {
  operation: identity,
  requestDigest,
  definitionDigest,
  dispatchOrdinal: createWorkflowDispatchOrdinal(1),
  attemptId: createWorkflowAttemptId("attempt-1"),
  attemptNumber: createWorkflowAttemptNumber(1),
};

type EventOf<Type extends WorkflowRunEvent["type"]> = Extract<
  WorkflowRunEvent,
  { type: Type }
>;

function event<Type extends WorkflowRunEvent["type"]>(
  type: Type,
  sequence: number,
  payload: EventOf<Type>["payload"],
  extra: Record<string, unknown> = {},
): EventOf<Type> {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    runId,
    runEpoch: 1,
    sequence,
    type,
    payload,
    ...extra,
  } as unknown as EventOf<Type>;
}

function prefix(): WorkflowRunEvent[] {
  return [
    event("run_created", 1, {
      durableOwner: owner,
      executionKind: "plan",
      rootDefinitionPath: rootPath,
      rootDefinitionDigest: definitionDigest,
      resumePolicy: "trusted_resume",
    }),
    event("run_epoch_acquired", 2, {
      fence: createWorkflowRunEpochFence(
        owner,
        {
          scopeId: 7,
          generation: 2,
          leaseToken: "lease_token_0123456789abcdef",
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
      definition: { sha256: definitionDigest, sizeBytes: 100 },
    }),
    event("plan_defined", 4, {
      revision: 1,
      definitionDigest,
      definition: { sha256: definitionDigest, sizeBytes: 100 },
    }),
  ];
}

function committedRun(): WorkflowRunEvent[] {
  return [
    ...prefix(),
    event("task_transitioned", 5, {
      definitionPath: rootPath,
      taskId: "task-a",
      planRevision: 1,
      from: "pending",
      to: "running",
    }),
    event("operation_prepared", 6, { request }),
    event("attempt_started", 7, { attempt }),
    event("operation_dispatched", 8, { attempt }),
    event("attempt_settled", 9, {
      attempt,
      outcome: {
        status: "succeeded",
        value: { sha256: outputDigest, sizeBytes: 50 },
      },
      accounting: exact,
    }),
    event("operation_settled", 10, {
      attempt,
      outcome: {
        status: "succeeded",
        value: { sha256: outputDigest, sizeBytes: 50 },
      },
      accounting: exact,
    }),
    event("response_ready", 11, {
      operation: identity,
      dispatchOrdinal: createWorkflowDispatchOrdinal(1),
      responseOrdinal: createWorkflowResponseOrdinal(1),
      settlementEventId: "event-10",
    }),
    event("task_transitioned", 12, {
      definitionPath: rootPath,
      taskId: "task-a",
      planRevision: 1,
      from: "running",
      to: "succeeded",
    }),
    event("operation_replayed", 13, {
      request,
      settledEventId: "event-10",
      responseOrdinal: createWorkflowResponseOrdinal(1),
    }),
    event("run_result_recorded", 14, {
      result: { sha256: resultDigest, sizeBytes: 25 },
      accounting: exact,
    }),
    event("run_terminal", 15, {
      status: "done",
      accounting: exact,
      resultEventId: "event-14",
    }),
  ];
}

function expectFoldCode(
  events: readonly WorkflowRunEvent[],
  code: string,
): void {
  try {
    foldWorkflowRunEvents(events);
    throw new Error("fold unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowProjectionFoldError);
    expect(error).toMatchObject({ code });
  }
}

describe("foldWorkflowRunEvents", () => {
  it("uses physical complete-line order rather than timestamp-like event IDs", () => {
    const events = prefix().map((entry, index) => ({
      ...entry,
      eventId: `timestamp-${2030 - index}`,
    })) as WorkflowRunEvent[];

    const projection = foldWorkflowRunEvents(events);

    expect(projection.sequence).toBe(4);
    expect(projection.lastEventId).toBe("timestamp-2027");
    expect(projection.plan).toMatchObject({
      revision: 1,
      eventId: "timestamp-2027",
    });
  });

  it("fails closed for malformed schema, duplicate IDs, and physical sequence gaps", () => {
    const malformed = prefix();
    malformed[0] = {
      ...malformed[0]!,
      schemaVersion: 2,
    } as unknown as WorkflowRunEvent;
    expectFoldCode(malformed, "invalid_event_schema");

    const duplicate = prefix();
    duplicate[1] = { ...duplicate[1]!, eventId: "event-1" } as WorkflowRunEvent;
    expectFoldCode(duplicate, "duplicate_event");

    const gap = prefix();
    gap[2] = { ...gap[2]!, sequence: 9 } as WorkflowRunEvent;
    expectFoldCode(gap, "invalid_sequence");
  });

  it("rejects non-monotonic epochs and operation digest conflicts", () => {
    const badEpoch = prefix();
    badEpoch.push(
      event(
        "run_epoch_acquired",
        5,
        {
          fence: createWorkflowRunEpochFence(
            owner,
            {
              scopeId: 7,
              generation: 3,
              leaseToken: "replacement_token_0123456789abcdef",
              runEpoch: 3,
            },
            runId,
          ),
          previousRunEpoch: 1,
          reason: "stale_takeover",
        },
        { runEpoch: 3 },
      ),
    );
    expectFoldCode(badEpoch, "invalid_epoch");

    const conflicting = [
      ...prefix(),
      event("operation_prepared", 5, { request }),
      event("operation_prepared", 6, {
        request: { ...request, requestDigest: otherRequestDigest },
      }),
    ];
    expectFoldCode(conflicting, "identity_conflict");
  });

  it("enforces terminal task and run immutability", () => {
    const illegalTask = [
      ...prefix(),
      event("task_transitioned", 5, {
        definitionPath: rootPath,
        taskId: "task-a",
        planRevision: 1,
        from: "pending",
        to: "running",
      }),
      event("task_transitioned", 6, {
        definitionPath: rootPath,
        taskId: "task-a",
        planRevision: 1,
        from: "running",
        to: "succeeded",
      }),
      event("task_transitioned", 7, {
        definitionPath: rootPath,
        taskId: "task-a",
        planRevision: 1,
        from: "succeeded",
        to: "running",
      }),
    ];
    expectFoldCode(illegalTask, "illegal_transition");

    const afterTerminal = [
      ...committedRun(),
      event("run_interrupted", 16, { reason: "process_crash" }),
    ];
    expectFoldCode(afterTerminal, "terminal_immutable");

    const duplicateTerminal = [
      ...committedRun(),
      event("run_terminal", 16, {
        status: "done",
        accounting: exact,
        resultEventId: "event-14",
      }),
    ];
    expectFoldCode(duplicateTerminal, "terminal_immutable");

    const mismatchedResult = committedRun();
    mismatchedResult[14] = event("run_terminal", 15, {
      status: "done",
      accounting: exact,
      resultEventId: "unknown-result-event",
    });
    expectFoldCode(mismatchedResult, "result_mismatch");
  });

  it("persists coordinator-authoritative blocked run state", () => {
    const projection = foldWorkflowRunEvents([
      ...prefix(),
      event("task_transitioned", 5, {
        definitionPath: rootPath,
        taskId: "task-a",
        planRevision: 1,
        from: "pending",
        to: "blocked",
      }),
      event("run_blocked", 6, { blockedTaskIds: ["task-a"] }),
    ]);

    expect(projection.status).toBe("blocked");
    expect(projection.taskStates["task-a"]).toMatchObject({
      status: "blocked",
    });
  });

  it("retains committed replay data, task state, plan state, and allocation counters", () => {
    const projection = foldWorkflowRunEvents(committedRun());
    const operation = projection.operations[0]!;

    expect(operation.settlement).toMatchObject({
      eventId: "event-10",
      outcome: { status: "succeeded" },
    });
    expect(operation.replays).toEqual([
      {
        eventId: "event-13",
        settledEventId: "event-10",
        responseOrdinal: 1,
      },
    ]);
    expect(operation.nextAttemptNumber).toBe(2);
    expect(projection.taskStates["task-a"]).toMatchObject({
      status: "succeeded",
      transitionEventIds: ["event-5", "event-12"],
    });
    expect(projection.plan).toMatchObject({
      revision: 1,
      definition: { sha256: definitionDigest, sizeBytes: 100 },
    });
    expect(projection.ordinalAllocations).toEqual([
      {
        definitionPath: rootPath,
        nextDispatchOrdinal: 2,
        nextResponseOrdinal: 2,
      },
    ]);
    expect(projection.nextSequence).toBe(16);
    expect(projection.result?.eventId).toBe("event-14");
    expect(projection.terminal?.eventId).toBe("event-15");
  });

  it("keeps exact and lower-bound accounting explicit without double counting settlement", () => {
    const exactProjection = foldWorkflowRunEvents(committedRun());
    expect(exactProjection.accounting).toEqual(exact);

    const ambiguous = [
      ...prefix(),
      event("operation_prepared", 5, { request }),
      event("attempt_started", 6, { attempt }),
      event("operation_dispatched", 7, { attempt }),
      event("attempt_usage_observed", 8, {
        attempt,
        usageDelta: { ...usage, input: 2, totalTokens: 10 },
      }),
    ];
    expect(foldWorkflowRunEvents(ambiguous).accounting).toEqual({
      completeness: "lower_bound",
      reason: "ambiguous_dispatch",
      usage: { ...usage, input: 2, totalTokens: 10 },
    });
  });

  it("counts cumulative retry settlement accounting only once", () => {
    const priorUsage: DurableWorkflowUsage = {
      ...usage,
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      costUsd: 0.003,
    };
    const cumulativeUsage: DurableWorkflowUsage = {
      ...usage,
      input: 7,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      costUsd: 0.012,
      turns: 2,
    };
    const cumulativeAccounting: WorkflowUsageAccounting = {
      completeness: "lower_bound",
      reason: "ambiguous_dispatch",
      usage: cumulativeUsage,
    };
    const retryAttempt: WorkflowOperationAttempt = {
      ...attempt,
      attemptId: createWorkflowAttemptId("attempt-2"),
      attemptNumber: createWorkflowAttemptNumber(2),
    };
    const outcome = {
      status: "succeeded" as const,
      value: { sha256: outputDigest, sizeBytes: 50 },
    };

    const events = [
      ...prefix(),
      event("operation_prepared", 5, { request }),
      event("attempt_started", 6, { attempt }),
      event("operation_dispatched", 7, { attempt }),
      event("attempt_usage_observed", 8, {
        attempt,
        usageDelta: priorUsage,
      }),
      event("attempt_interrupted", 9, {
        attempt,
        reason: "process_exit",
      }),
      event("attempt_started", 10, { attempt: retryAttempt }),
      event("operation_dispatched", 11, { attempt: retryAttempt }),
      event("attempt_settled", 12, {
        attempt: retryAttempt,
        outcome,
        accounting: cumulativeAccounting,
      }),
      event("operation_settled", 13, {
        attempt: retryAttempt,
        outcome,
        accounting: cumulativeAccounting,
      }),
    ];

    expect(foldWorkflowRunEvents(events).accounting).toEqual(
      cumulativeAccounting,
    );
    expect(foldWorkflowRunEvents(events.slice(0, -1)).accounting).toEqual(
      cumulativeAccounting,
    );
  });

  it("projects interruption and only resumes through a legal journal transition", () => {
    const interrupted = [
      ...prefix(),
      event("run_interrupted", 5, { reason: "process_crash" }),
    ];
    expect(foldWorkflowRunEvents(interrupted).status).toBe("interrupted");

    expectFoldCode(
      [...interrupted, event("operation_prepared", 6, { request })],
      "illegal_transition",
    );

    const resumed = [
      ...interrupted,
      event("run_resumed", 6, {
        reason: "trusted_resume",
        trustedActorId: "operator-1",
      }),
    ];
    expect(foldWorkflowRunEvents(resumed).status).toBe("running");
  });
  it("surfaces the persisted effective isolation fallback on the attempt", () => {
    const manifest = createWorkflowProcessAttemptManifest(
      attempt,
      1,
      "nonce_1234567890abcdef",
      "process",
    );
    const projection = foldWorkflowRunEvents([
      ...prefix(),
      event("operation_prepared", 5, { request }),
      event("attempt_started", 6, { attempt }),
      event("process_launch_prepared", 7, { manifest }),
      event("operation_dispatched", 8, { attempt }),
      event("process_isolation_resolved", 9, {
        identity: manifest.identity,
        effectiveIsolation: "in-process",
        fallbackMode: "process_unavailable",
        fallbackReason: "no deterministic multiplexer lookup",
      }),
    ]);

    expect(projection.operations[0]?.attempts[0]?.process).toMatchObject({
      stage: "fallback",
      effectiveIsolation: "in-process",
      fallbackMode: "process_unavailable",
      fallbackReason: "no deterministic multiplexer lookup",
    });
  });
});

describe("InMemoryWorkflowProjectionRepository", () => {
  it("replaces disposable owner snapshots while durable folded state wins", async () => {
    const repository = new InMemoryWorkflowProjectionRepository();
    const stale = foldWorkflowRunEvents(prefix());
    const durable = foldWorkflowRunEvents(committedRun());
    await repository.replace(owner, stale);
    await repository.replaceAll(owner, [durable]);

    expect(await repository.get(owner, runId)).toBe(durable);
    expect(await repository.list(owner)).toEqual([durable]);
    expect(await repository.list(otherOwner)).toEqual([]);
    await expect(repository.replace(otherOwner, durable)).rejects.toThrow(
      "projection owner does not match",
    );
  });

  it("preserves zero exact accounting for a run with no attempts", () => {
    expect(foldWorkflowRunEvents(prefix()).accounting).toEqual(zero);
  });
});

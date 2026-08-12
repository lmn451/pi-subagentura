import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DURABLE_WORKFLOW_RUN_ID_PREFIX,
  MAX_WORKFLOW_DEFINITION_DEPTH,
  ROOT_WORKFLOW_DEFINITION_PATH,
  WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION,
  WORKFLOW_OUTBOX_SCHEMA_VERSION,
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  appendWorkflowDefinitionPath,
  createDurableWorkflowRunId,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowDispatchOrdinalIdentity,
  createWorkflowNamespaceLeaseFence,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  createWorkflowResponseOrdinal,
  createWorkflowResponseOrdinalIdentity,
  createWorkflowRunEpochFence,
  createWorkflowSha256Digest,
  durableWorkflowOwnerEquals,
  isWorkflowAttemptId,
  isDurableWorkflowOwner,
  isDurableWorkflowRunId,
  isExactWorkflowAccounting,
  isLiveWorkflowOwner,
  isWorkflowDefinitionPath,
  isWorkflowEventReceipt,
  isWorkflowRunEvent,
  isWorkflowIdentifier,
  isWorkflowOperationIdentity,
  liveWorkflowOwnerEquals,
  workflowDispatchOrdinalIdentityEquals,
  workflowNamespaceLeaseFenceEquals,
  workflowOperationIdentityEquals,
  workflowOperationRequestDigestMatches,
  workflowOperationRequestMatches,
  workflowResponseOrdinalIdentityEquals,
  workflowRunEpochFenceEquals,
  type DurableWorkflowOwner,
  type LiveWorkflowOwner,
  type WorkflowDefinitionDigest,
  type WorkflowEventReceipt,
  type WorkflowOperationAttempt,
  type WorkflowOperationRequest,
  type WorkflowRequestDigest,
  type WorkflowRunEvent,
  type WorkflowRunTerminalEvent,
  type WorkflowTerminalStatus,
  type WorkflowUsageAccounting,
} from "../src/workflow-run-types";

const PROJECT_KEY = "a".repeat(64);
const OTHER_PROJECT_KEY = "b".repeat(64);
const REQUEST_DIGEST = "c".repeat(64);
const OTHER_REQUEST_DIGEST = "d".repeat(64);
const DEFINITION_DIGEST = "e".repeat(64);
const OTHER_DEFINITION_DIGEST = "0".repeat(64);
const LINE_DIGEST = "f".repeat(64);

function durableOwner(
  overrides: Partial<DurableWorkflowOwner> = {},
): DurableWorkflowOwner {
  return {
    projectKey: PROJECT_KEY,
    piSessionKey: "pi-session-01",
    ...overrides,
  };
}

function liveOwner(
  overrides: Partial<LiveWorkflowOwner> = {},
): LiveWorkflowOwner {
  return {
    scopeId: 7,
    generation: 3,
    leaseToken: "lease_token_0123456789abcdef",
    runEpoch: 4,
    ...overrides,
  };
}

describe("durable workflow identifiers", () => {
  it("embeds the durable schema version in run IDs", () => {
    const runId = createDurableWorkflowRunId("01J4SAFE_RUN-9");

    expect(runId).toBe(`${DURABLE_WORKFLOW_RUN_ID_PREFIX}01J4SAFE_RUN-9`);
    expect(isDurableWorkflowRunId(runId)).toBe(true);
    expect(isDurableWorkflowRunId("wfr-v2-01J4SAFE_RUN-9")).toBe(false);
    expect(WORKFLOW_RUN_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "a..b",
    "/absolute",
    "nested/id",
    "nested\\id",
    ".hidden",
    "trailing.",
    "has space",
    "line\nbreak",
    "nul\0byte",
  ])("rejects unsafe portable identifier %j", (identifier) => {
    expect(isWorkflowIdentifier(identifier)).toBe(false);
    expect(() => createDurableWorkflowRunId(identifier)).toThrow(
      "invalid durable workflow run identifier",
    );
  });

  it("rejects overlong identifiers", () => {
    expect(isWorkflowIdentifier("a".repeat(257))).toBe(false);
    expect(() => createDurableWorkflowRunId("a".repeat(257))).toThrow();
  });

  it("validates canonical, bounded definition paths", () => {
    const root = createWorkflowDefinitionPath(ROOT_WORKFLOW_DEFINITION_PATH);
    const child = appendWorkflowDefinitionPath(root, "review-1");
    const grandchild = appendWorkflowDefinitionPath(child, "summarize_2");

    expect(child).toBe("root/review-1");
    expect(grandchild).toBe("root/review-1/summarize_2");
    expect(isWorkflowDefinitionPath("root//child")).toBe(false);
    expect(isWorkflowDefinitionPath("root/../child")).toBe(false);
    expect(isWorkflowDefinitionPath("other/child")).toBe(false);
    expect(isWorkflowDefinitionPath("root\\child")).toBe(false);
  });

  it("bounds nested definition depth", () => {
    let path = createWorkflowDefinitionPath(ROOT_WORKFLOW_DEFINITION_PATH);
    for (let depth = 0; depth < MAX_WORKFLOW_DEFINITION_DEPTH; depth++) {
      path = appendWorkflowDefinitionPath(path, `child-${depth}`);
    }

    expect(isWorkflowDefinitionPath(path)).toBe(true);
    expect(() => appendWorkflowDefinitionPath(path, "too-deep")).toThrow(
      "invalid canonical workflow definition path",
    );
  });
});

describe("durable and live workflow ownership", () => {
  it("validates the exact durable owner shape", () => {
    expect(isDurableWorkflowOwner(durableOwner())).toBe(true);
    expect(
      isDurableWorkflowOwner({
        ...durableOwner(),
        path: "/tmp/unsafe-authority",
      }),
    ).toBe(false);
    expect(
      isDurableWorkflowOwner(
        durableOwner({ projectKey: PROJECT_KEY.toUpperCase() }),
      ),
    ).toBe(false);
    expect(
      isDurableWorkflowOwner(durableOwner({ piSessionKey: "../../session" })),
    ).toBe(false);
  });

  it("validates the exact live owner shape and fence values", () => {
    expect(isLiveWorkflowOwner(liveOwner())).toBe(true);
    expect(isLiveWorkflowOwner(liveOwner({ generation: 0 }))).toBe(false);
    expect(isLiveWorkflowOwner(liveOwner({ runEpoch: -1 }))).toBe(false);
    expect(isLiveWorkflowOwner(liveOwner({ leaseToken: "predictable" }))).toBe(
      false,
    );
    expect(isLiveWorkflowOwner({ ...liveOwner(), pid: 42 })).toBe(false);
  });

  it("keeps durable namespace equality separate from live callback equality", () => {
    const durable = durableOwner();
    const live = liveOwner();

    expect(durableWorkflowOwnerEquals(durable, { ...durable })).toBe(true);
    expect(
      durableWorkflowOwnerEquals(durable, {
        ...durable,
        piSessionKey: "another-session",
      }),
    ).toBe(false);
    expect(liveWorkflowOwnerEquals(live, { ...live })).toBe(true);
    expect(liveWorkflowOwnerEquals(live, { ...live, generation: 4 })).toBe(
      false,
    );
    expect(
      liveWorkflowOwnerEquals(live, {
        ...live,
        leaseToken: "replacement_0123456789abcdef",
      }),
    ).toBe(false);
    expect(liveWorkflowOwnerEquals(live, { ...live, runEpoch: 5 })).toBe(false);
  });

  it("uses one namespace lease fence while fencing each run by epoch", () => {
    const durable = durableOwner();
    const runId = createDurableWorkflowRunId("run-a");
    const current = liveOwner({ runEpoch: 4 });
    const replacementEpoch = liveOwner({ runEpoch: 5 });
    const namespaceFence = createWorkflowNamespaceLeaseFence(durable, current);
    const replacementNamespaceFence = createWorkflowNamespaceLeaseFence(
      durable,
      replacementEpoch,
    );
    const runFence = createWorkflowRunEpochFence(durable, current, runId);
    const replacementRunFence = createWorkflowRunEpochFence(
      durable,
      replacementEpoch,
      runId,
    );

    expect(
      workflowNamespaceLeaseFenceEquals(
        namespaceFence,
        replacementNamespaceFence,
      ),
    ).toBe(true);
    expect(workflowRunEpochFenceEquals(runFence, replacementRunFence)).toBe(
      false,
    );
    expect(
      workflowRunEpochFenceEquals(runFence, {
        ...runFence,
        runId: createDurableWorkflowRunId("run-b"),
      }),
    ).toBe(false);
    expect(
      workflowNamespaceLeaseFenceEquals(namespaceFence, {
        ...namespaceFence,
        durableOwner: durableOwner({ projectKey: OTHER_PROJECT_KEY }),
      }),
    ).toBe(false);
    expect(
      workflowNamespaceLeaseFenceEquals(namespaceFence, {
        ...namespaceFence,
        leaseToken: "stale_lease_token_0123456789abcdef",
      }),
    ).toBe(false);
  });
});

describe("operation, attempt, and ordinal identity", () => {
  const runId = createDurableWorkflowRunId("identity-run");
  const otherRunId = createDurableWorkflowRunId("other-run");
  const definitionPath = createWorkflowDefinitionPath("root/child-1");
  const requestDigest = createWorkflowRequestDigest(REQUEST_DIGEST);
  const otherRequestDigest = createWorkflowRequestDigest(OTHER_REQUEST_DIGEST);
  const definitionDigest = createWorkflowDefinitionDigest(DEFINITION_DIGEST);
  const otherDefinitionDigest = createWorkflowDefinitionDigest(
    OTHER_DEFINITION_DIGEST,
  );
  const dispatchOrdinal = createWorkflowDispatchOrdinal(2);

  it("uses exactly run ID, definition path, and explicit operation ID", () => {
    const identity = createWorkflowOperationIdentity(
      runId,
      definitionPath,
      "review-item-42",
    );

    expect(Object.keys(identity)).toEqual([
      "runId",
      "definitionPath",
      "operationId",
    ]);
    expect(
      workflowOperationIdentityEquals(identity, {
        ...identity,
      }),
    ).toBe(true);
    expect(
      workflowOperationIdentityEquals(identity, {
        ...identity,
        runId: otherRunId,
      }),
    ).toBe(false);
    expect(
      workflowOperationIdentityEquals(identity, {
        ...identity,
        operationId: "review-item-43",
      }),
    ).toBe(false);
  });

  it("rejects inferred or unsafe operation identity components", () => {
    expect(() =>
      createWorkflowOperationIdentity(runId, definitionPath, "../review"),
    ).toThrow("invalid workflow operation identity");
    expect(isWorkflowAttemptId("../attempt")).toBe(false);
    expect(
      isWorkflowOperationIdentity({
        runId,
        definitionPath,
        operationId: "review",
        occurrence: 1,
      }),
    ).toBe(false);
  });

  it("separates the identity key, canonical request digest, and ordinal", () => {
    const identity = createWorkflowOperationIdentity(
      runId,
      definitionPath,
      "review",
    );
    const first: WorkflowOperationRequest = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      identity,
      requestDigest,
      definitionDigest,
      dispatchOrdinal,
    };
    const replay = { ...first };

    expect(workflowOperationRequestDigestMatches(first, replay)).toBe(true);
    expect(workflowOperationRequestMatches(first, replay)).toBe(true);
    expect(
      workflowOperationRequestDigestMatches(first, {
        ...replay,
        requestDigest: otherRequestDigest,
      }),
    ).toBe(false);
    expect(
      workflowOperationRequestDigestMatches(first, {
        ...replay,
        definitionDigest: otherDefinitionDigest,
      }),
    ).toBe(false);
    expect(
      workflowOperationRequestMatches(first, {
        ...replay,
        dispatchOrdinal: createWorkflowDispatchOrdinal(3),
      }),
    ).toBe(false);
  });

  it("keeps dispatch and response ordinal identities independent of worker epoch", () => {
    const dispatch = createWorkflowDispatchOrdinalIdentity(
      runId,
      definitionPath,
      dispatchOrdinal,
    );
    const response = createWorkflowResponseOrdinalIdentity(
      runId,
      definitionPath,
      createWorkflowResponseOrdinal(1),
    );

    expect(Object.keys(dispatch)).toEqual([
      "runId",
      "definitionPath",
      "dispatchOrdinal",
    ]);
    expect(Object.keys(response)).toEqual([
      "runId",
      "definitionPath",
      "responseOrdinal",
    ]);
    expect(
      workflowDispatchOrdinalIdentityEquals(dispatch, { ...dispatch }),
    ).toBe(true);
    expect(
      workflowResponseOrdinalIdentityEquals(response, { ...response }),
    ).toBe(true);
    expect(
      workflowResponseOrdinalIdentityEquals(response, {
        ...response,
        responseOrdinal: createWorkflowResponseOrdinal(2),
      }),
    ).toBe(false);
  });

  it("retains logical identity and dispatch position across attempts", () => {
    const operation = createWorkflowOperationIdentity(
      runId,
      definitionPath,
      "retryable",
    );
    const firstAttempt: WorkflowOperationAttempt = {
      operation,
      requestDigest,
      definitionDigest,
      dispatchOrdinal,
      attemptId: createWorkflowAttemptId("attempt-1"),
      attemptNumber: createWorkflowAttemptNumber(1),
    };
    const retry: WorkflowOperationAttempt = {
      ...firstAttempt,
      attemptId: createWorkflowAttemptId("attempt-2"),
      attemptNumber: createWorkflowAttemptNumber(2),
    };

    expect(retry.operation).toBe(firstAttempt.operation);
    expect(retry.dispatchOrdinal).toBe(firstAttempt.dispatchOrdinal);
    expect(retry.attemptNumber).not.toBe(firstAttempt.attemptNumber);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid ordinal %s",
    (value) => {
      expect(() => createWorkflowDispatchOrdinal(value)).toThrow();
      expect(() => createWorkflowResponseOrdinal(value)).toThrow();
      expect(() => createWorkflowAttemptNumber(value)).toThrow();
    },
  );
});

describe("accounting, receipts, and event contracts", () => {
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 18,
    costUsd: 0.03,
    turns: 1,
  };

  it("distinguishes exact usage from a durable lower bound", () => {
    const exact: WorkflowUsageAccounting = {
      completeness: "exact",
      usage,
    };
    const lowerBound: WorkflowUsageAccounting = {
      completeness: "lower_bound",
      usage,
      reason: "provider_work_not_settled",
    };

    expect(isExactWorkflowAccounting(exact)).toBe(true);
    expect(isExactWorkflowAccounting(lowerBound)).toBe(false);
    expect(lowerBound).toMatchObject({
      completeness: "lower_bound",
      reason: "provider_work_not_settled",
    });
  });

  it("accepts append receipts only for a complete positive byte range", () => {
    const receipt: WorkflowEventReceipt = {
      schemaVersion: WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION,
      runId: createDurableWorkflowRunId("receipt-run"),
      eventId: "event-1",
      runEpoch: 2,
      byteStart: 128,
      byteEndExclusive: 256,
      lineDigest: createWorkflowSha256Digest(LINE_DIGEST),
    };

    expect(isWorkflowEventReceipt(receipt)).toBe(true);
    expect(
      isWorkflowEventReceipt({
        ...receipt,
        byteEndExclusive: receipt.byteStart,
      }),
    ).toBe(false);
    expect(isWorkflowEventReceipt({ ...receipt, runEpoch: 0 })).toBe(false);
    expect(isWorkflowEventReceipt({ ...receipt, eventId: "../event" })).toBe(
      false,
    );
    expect(isWorkflowEventReceipt({ ...receipt, schemaVersion: 2 })).toBe(
      false,
    );
  });

  it("tags events by family and exposes deeply readonly payloads", () => {
    const event: WorkflowRunEvent = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: "terminal-1",
      runId: createDurableWorkflowRunId("terminal-run"),
      runEpoch: 3,
      sequence: 12,
      type: "run_terminal",
      payload: {
        status: "done",
        accounting: {
          completeness: "exact",
          usage,
        },
        resultEventId: "result-1",
      },
    };

    expect(event.type).toBe("run_terminal");
    expect(event.payload.status).toBe("done");
    expectTypeOf(event.payload.status).toMatchTypeOf<WorkflowTerminalStatus>();
    expect(WORKFLOW_OUTBOX_SCHEMA_VERSION).toBe(1);
  });

  it("validates exact complete event shapes and rejects nested extras", () => {
    const event: WorkflowRunTerminalEvent = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: "terminal-exact",
      runId: createDurableWorkflowRunId("exact-event"),
      runEpoch: 1,
      sequence: 1,
      type: "run_terminal",
      payload: {
        status: "done",
        accounting: {
          completeness: "exact",
          usage,
        },
      },
    };

    expect(isWorkflowRunEvent(event)).toBe(true);
    expect(isWorkflowRunEvent({ ...event, path: "/tmp/not-authority" })).toBe(
      false,
    );
    expect(
      isWorkflowRunEvent({
        ...event,
        payload: { ...event.payload, unexpected: true },
      }),
    ).toBe(false);
    expect(isWorkflowRunEvent({ ...event, sequence: 0 })).toBe(false);
    expect(isWorkflowRunEvent({ ...event, type: "unknown_event" })).toBe(false);
  });
});

function typecheckReadonlyPayload(event: WorkflowRunTerminalEvent): void {
  if (false) {
    // @ts-expect-error durable event payload fields are immutable
    event.payload.status = "error";
    // @ts-expect-error nested accounting payload fields are immutable
    event.payload.accounting.usage.totalTokens = 0;
  }
}

function typecheckDigestRoles(
  requestDigest: WorkflowRequestDigest,
  definitionDigest: WorkflowDefinitionDigest,
): void {
  if (false) {
    // @ts-expect-error request and definition digests have distinct roles
    const invalidRequestDigest: WorkflowRequestDigest = definitionDigest;
    // @ts-expect-error request and definition digests have distinct roles
    const invalidDefinitionDigest: WorkflowDefinitionDigest = requestDigest;
    void invalidRequestDigest;
    void invalidDefinitionDigest;
  }
}

void typecheckReadonlyPayload;
void typecheckDigestRoles;

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDurableValue } from "../src/workflow-durable-value";
import type {
  WorkflowOperationEventDraft,
  WorkflowOperationGateEvent,
} from "../src/workflow-operation-gate";
import {
  WorkflowRunBlobResolver,
  WorkflowRunOperationJournal,
  durableWorkflowOperationBlobCodec,
} from "../src/workflow-operation-journal";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowRunJournal,
  type WorkflowRunLease,
} from "../src/workflow-run-store";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  createWorkflowSha256Digest,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type DurableWorkflowUsage,
  type WorkflowOperationRequest,
  type WorkflowRunEpochFence,
} from "../src/workflow-run-types";

const ROOT_DIGEST = createWorkflowDefinitionDigest("a".repeat(64));
const ROOT_PATH = createWorkflowDefinitionPath("root");
const USAGE: DurableWorkflowUsage = {
  input: 8,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 16,
  costUsd: 0.25,
  costSource: "provider",
  turns: 1,
};
const ACCOUNTING = { completeness: "exact", usage: USAGE } as const;

function requestFor(
  runId: DurableWorkflowRunId,
  operationId: string,
  dispatchOrdinal: number,
): WorkflowOperationRequest {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    identity: createWorkflowOperationIdentity(runId, ROOT_PATH, operationId),
    requestDigest: createWorkflowRequestDigest(
      operationId.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
    ),
    definitionDigest: ROOT_DIGEST,
    dispatchOrdinal: createWorkflowDispatchOrdinal(dispatchOrdinal),
  };
}

async function appendDraft(
  adapter: WorkflowRunOperationJournal,
  fence: WorkflowRunEpochFence,
  draft: WorkflowOperationEventDraft,
): Promise<WorkflowOperationGateEvent> {
  return (await adapter.appendEvent(fence, draft)).event;
}

async function settleRequest(
  adapter: WorkflowRunOperationJournal,
  fence: WorkflowRunEpochFence,
  request: WorkflowOperationRequest,
): Promise<string> {
  const attempt = await adapter.allocateAttempt(fence, request);
  await appendDraft(adapter, fence, {
    type: "attempt_started",
    payload: { attempt },
  });
  await appendDraft(adapter, fence, {
    type: "operation_dispatched",
    payload: { attempt },
  });
  const outcome = {
    status: "cancelled",
    reason: "test completion",
  } as const;
  await appendDraft(adapter, fence, {
    type: "attempt_settled",
    payload: { attempt, outcome, accounting: ACCOUNTING },
  });
  return (
    await appendDraft(adapter, fence, {
      type: "operation_settled",
      payload: { attempt, outcome, accounting: ACCOUNTING },
    })
  ).eventId;
}

function outputPath(
  home: string,
  owner: DurableWorkflowOwner,
  runId: DurableWorkflowRunId,
  sha256: string,
): string {
  return join(
    home,
    ".pi-subagentura",
    "workflow-runs",
    "v1",
    owner.projectKey,
    owner.piSessionKey,
    "runs",
    runId,
    "outputs",
    `${sha256}.json`,
  );
}

describe("WorkflowRunOperationJournal", () => {
  let home: string;
  let owner: DurableWorkflowOwner;
  let store: WorkflowRunStore;
  let lease: WorkflowRunLease;
  let journal: WorkflowRunJournal;
  let fence: WorkflowRunEpochFence;
  let runId: DurableWorkflowRunId;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-operation-journal-"));
    const cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-session");
    store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 701, processStartIdentity: "journal-tests" },
    });
    lease = await store.acquireLease(owner, { scopeId: 4, generation: 2 });
    runId = createDurableWorkflowRunId("operation-journal");
    journal = await lease.createRun({ runId, launch: { kind: "plan" } });
    if (journal.fence === undefined) throw new Error("leased journal expected");
    fence = journal.fence;
    await journal.append({
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: "run-created",
      runId,
      runEpoch: fence.runEpoch,
      sequence: 1,
      type: "run_created",
      payload: {
        durableOwner: owner,
        executionKind: "plan",
        rootDefinitionPath: ROOT_PATH,
        rootDefinitionDigest: ROOT_DIGEST,
        resumePolicy: "trusted_resume",
      },
    });
    await journal.append({
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: "epoch-acquired",
      runId,
      runEpoch: fence.runEpoch,
      sequence: 2,
      type: "run_epoch_acquired",
      payload: {
        fence,
        previousRunEpoch: null,
        reason: "created",
      },
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("maps the folded operation, attempt, settlement, and response state", async () => {
    let id = 0;
    const adapter = new WorkflowRunOperationJournal(
      journal,
      () => `allocated-${++id}`,
    );
    const request = requestFor(runId, "a", 1);
    await appendDraft(adapter, fence, {
      type: "operation_prepared",
      payload: { request },
    });
    const attempt = await adapter.allocateAttempt(fence, request);
    await appendDraft(adapter, fence, {
      type: "attempt_started",
      payload: { attempt },
    });
    await appendDraft(adapter, fence, {
      type: "operation_dispatched",
      payload: { attempt },
    });
    await appendDraft(adapter, fence, {
      type: "attempt_usage_observed",
      payload: { attempt, usageDelta: USAGE },
    });
    const value = await adapter.putOutcomeBlob(
      fence,
      encodeDurableValue({ isError: false, output: "complete" }),
    );
    const outcome = { status: "succeeded", value } as const;
    const attemptSettled = await appendDraft(adapter, fence, {
      type: "attempt_settled",
      payload: { attempt, outcome, accounting: ACCOUNTING },
    });
    const operationSettled = await appendDraft(adapter, fence, {
      type: "operation_settled",
      payload: { attempt, outcome, accounting: ACCOUNTING },
    });
    const responseOrdinal = await adapter.allocateResponseOrdinal(
      fence,
      request,
    );
    await adapter.commitResponse(fence, request, responseOrdinal, async () => {
      await appendDraft(adapter, fence, {
        type: "response_ready",
        payload: {
          operation: request.identity,
          dispatchOrdinal: request.dispatchOrdinal,
          responseOrdinal,
          settlementEventId: operationSettled.eventId,
        },
      });
    });

    const state = await adapter.readOperation(fence, request.identity);
    expect(state.request).toEqual(request);
    expect(state.attempts).toEqual([
      {
        attempt,
        dispatched: true,
        status: "settled",
        observedUsage: USAGE,
        settlement: {
          eventId: attemptSettled.eventId,
          outcome,
          accounting: ACCOUNTING,
        },
      },
    ]);
    expect(state.settlement).toEqual({
      eventId: operationSettled.eventId,
      attempt,
      outcome,
      accounting: ACCOUNTING,
      responseOrdinal: 1,
    });
  });

  it("allocates monotonic attempts and definition-scoped responses independently", async () => {
    const adapter = new WorkflowRunOperationJournal(journal);
    const firstDispatch = requestFor(runId, "a", 1);
    const secondDispatch = requestFor(runId, "b", 2);
    await appendDraft(adapter, fence, {
      type: "operation_prepared",
      payload: { request: firstDispatch },
    });
    await appendDraft(adapter, fence, {
      type: "operation_prepared",
      payload: { request: secondDispatch },
    });

    const attempts = await Promise.all([
      adapter.allocateAttempt(fence, firstDispatch),
      adapter.allocateAttempt(fence, firstDispatch),
    ]);
    expect(attempts.map(({ attemptNumber }) => attemptNumber)).toEqual([1, 2]);
    expect(attempts.map(({ dispatchOrdinal }) => dispatchOrdinal)).toEqual([
      1, 1,
    ]);

    const responses = await Promise.all([
      adapter.allocateResponseOrdinal(fence, firstDispatch),
      adapter.allocateResponseOrdinal(fence, secondDispatch),
      adapter.allocateResponseOrdinal(fence, firstDispatch),
    ]);
    expect(responses).toEqual([1, 2, 3]);
  });

  it.each([
    { failurePoint: "before append", persisted: false, expectedAttempt: 1 },
    { failurePoint: "after append", persisted: true, expectedAttempt: 2 },
  ])(
    "rebases attempt reservations from durable events after failure $failurePoint",
    async ({ persisted, expectedAttempt }) => {
      let id = 0;
      const nextId = () => `attempt-rebase-${++id}`;
      const adapter = new WorkflowRunOperationJournal(journal, nextId);
      const request = requestFor(runId, "a", 1);
      await appendDraft(adapter, fence, {
        type: "operation_prepared",
        payload: { request },
      });
      const failedAttempt = await adapter.allocateAttempt(fence, request);
      const append = journal.append.bind(journal);
      const failure = new Error("injected attempt append failure");
      vi.spyOn(journal, "append").mockImplementationOnce(async (event) => {
        if (persisted) await append(event);
        throw failure;
      });

      await expect(
        appendDraft(adapter, fence, {
          type: "attempt_started",
          payload: { attempt: failedAttempt },
        }),
      ).rejects.toBe(failure);
      if (persisted) {
        expect(
          (await adapter.readOperation(fence, request.identity)).attempts.at(-1)
            ?.status,
        ).toBe("started");
        await appendDraft(adapter, fence, {
          type: "attempt_interrupted",
          payload: { attempt: failedAttempt, reason: "owner_replaced" },
        });
      }

      const resumed = new WorkflowRunOperationJournal(journal, nextId);
      const retry = await resumed.allocateAttempt(fence, request);
      expect(retry.attemptNumber).toBe(expectedAttempt);
      await appendDraft(resumed, fence, {
        type: "attempt_started",
        payload: { attempt: retry },
      });
      expect(
        (await resumed.readOperation(fence, request.identity)).attempts.map(
          ({ attempt }) => attempt.attemptNumber,
        ),
      ).toEqual(persisted ? [1, 2] : [1]);
    },
  );

  it("commits reserved responses in completion order across adapters", async () => {
    const firstAdapter = new WorkflowRunOperationJournal(journal);
    const secondAdapter = new WorkflowRunOperationJournal(journal);
    const firstRequest = requestFor(runId, "a", 1);
    const secondRequest = requestFor(runId, "b", 2);
    const settlementIds = new Map<string, string>();
    for (const [adapter, request] of [
      [firstAdapter, firstRequest],
      [secondAdapter, secondRequest],
    ] as const) {
      await appendDraft(adapter, fence, {
        type: "operation_prepared",
        payload: { request },
      });
      const attempt = await adapter.allocateAttempt(fence, request);
      await appendDraft(adapter, fence, {
        type: "attempt_started",
        payload: { attempt },
      });
      await appendDraft(adapter, fence, {
        type: "operation_dispatched",
        payload: { attempt },
      });
      const outcome = {
        status: "cancelled",
        reason: "test completion",
      } as const;
      await appendDraft(adapter, fence, {
        type: "attempt_settled",
        payload: { attempt, outcome, accounting: ACCOUNTING },
      });
      const settlement = await appendDraft(adapter, fence, {
        type: "operation_settled",
        payload: { attempt, outcome, accounting: ACCOUNTING },
      });
      settlementIds.set(request.identity.operationId, settlement.eventId);
    }
    const firstOrdinal = await firstAdapter.allocateResponseOrdinal(
      fence,
      firstRequest,
    );
    const secondOrdinal = await secondAdapter.allocateResponseOrdinal(
      fence,
      secondRequest,
    );
    let secondCommitEntered = false;
    const secondCommit = secondAdapter.commitResponse(
      fence,
      secondRequest,
      secondOrdinal,
      async () => {
        secondCommitEntered = true;
        await appendDraft(secondAdapter, fence, {
          type: "response_ready",
          payload: {
            operation: secondRequest.identity,
            dispatchOrdinal: secondRequest.dispatchOrdinal,
            responseOrdinal: secondOrdinal,
            settlementEventId: settlementIds.get("b")!,
          },
        });
      },
    );
    await Promise.resolve();
    expect(secondCommitEntered).toBe(false);

    const firstCommit = firstAdapter.commitResponse(
      fence,
      firstRequest,
      firstOrdinal,
      async () => {
        await appendDraft(firstAdapter, fence, {
          type: "response_ready",
          payload: {
            operation: firstRequest.identity,
            dispatchOrdinal: firstRequest.dispatchOrdinal,
            responseOrdinal: firstOrdinal,
            settlementEventId: settlementIds.get("a")!,
          },
        });
      },
    );
    await Promise.all([firstCommit, secondCommit]);

    expect(
      (await firstAdapter.readOperation(fence, firstRequest.identity))
        .settlement?.responseOrdinal,
    ).toBe(1);
    expect(
      (await secondAdapter.readOperation(fence, secondRequest.identity))
        .settlement?.responseOrdinal,
    ).toBe(2);
  });

  it.each([
    { failurePoint: "before response append", persisted: false },
    { failurePoint: "after response append", persisted: true },
  ])(
    "rebuilds a failed response lane from durable events $failurePoint",
    async ({ persisted }) => {
      const adapter = new WorkflowRunOperationJournal(journal);
      const firstRequest = requestFor(runId, "a", 1);
      const secondRequest = requestFor(runId, "b", 2);
      const settlementIds: Record<string, string> = {};
      for (const request of [firstRequest, secondRequest]) {
        await appendDraft(adapter, fence, {
          type: "operation_prepared",
          payload: { request },
        });
        settlementIds[request.identity.operationId] = await settleRequest(
          adapter,
          fence,
          request,
        );
      }
      const failedOrdinal = await adapter.allocateResponseOrdinal(
        fence,
        firstRequest,
      );
      const staleLaterOrdinal = await adapter.allocateResponseOrdinal(
        fence,
        secondRequest,
      );
      const failure = new Error("injected response persistence failure");

      await expect(
        adapter.commitResponse(fence, firstRequest, failedOrdinal, async () => {
          if (persisted) {
            await appendDraft(adapter, fence, {
              type: "response_ready",
              payload: {
                operation: firstRequest.identity,
                dispatchOrdinal: firstRequest.dispatchOrdinal,
                responseOrdinal: failedOrdinal,
                settlementEventId: settlementIds.a,
              },
            });
          }
          throw failure;
        }),
      ).rejects.toBe(failure);
      let staleCommitEntered = false;
      await expect(
        adapter.commitResponse(
          fence,
          secondRequest,
          staleLaterOrdinal,
          async () => {
            staleCommitEntered = true;
          },
        ),
      ).rejects.toBe(failure);
      expect(staleCommitEntered).toBe(false);

      const resumed = new WorkflowRunOperationJournal(journal);
      if (!persisted) {
        const firstOrdinal = await resumed.allocateResponseOrdinal(
          fence,
          firstRequest,
        );
        expect(firstOrdinal).toBe(1);
        await resumed.commitResponse(
          fence,
          firstRequest,
          firstOrdinal,
          async () => {
            await appendDraft(resumed, fence, {
              type: "response_ready",
              payload: {
                operation: firstRequest.identity,
                dispatchOrdinal: firstRequest.dispatchOrdinal,
                responseOrdinal: firstOrdinal,
                settlementEventId: settlementIds.a,
              },
            });
          },
        );
      }
      const secondOrdinal = await resumed.allocateResponseOrdinal(
        fence,
        secondRequest,
      );
      expect(secondOrdinal).toBe(2);
      await resumed.commitResponse(
        fence,
        secondRequest,
        secondOrdinal,
        async () => {
          await appendDraft(resumed, fence, {
            type: "response_ready",
            payload: {
              operation: secondRequest.identity,
              dispatchOrdinal: secondRequest.dispatchOrdinal,
              responseOrdinal: secondOrdinal,
              settlementEventId: settlementIds.b,
            },
          });
        },
      );

      expect(
        (await journal.readEventLog()).events.flatMap((event) =>
          event.type === "response_ready"
            ? [event.payload.responseOrdinal]
            : [],
        ),
      ).toEqual([1, 2]);
    },
  );

  it("abandons pending response reservations until the lane is rebuilt", async () => {
    const firstAdapter = new WorkflowRunOperationJournal(journal);
    const secondAdapter = new WorkflowRunOperationJournal(journal);
    const firstRequest = requestFor(runId, "a", 1);
    const secondRequest = requestFor(runId, "b", 2);
    await appendDraft(firstAdapter, fence, {
      type: "operation_prepared",
      payload: { request: firstRequest },
    });
    await appendDraft(secondAdapter, fence, {
      type: "operation_prepared",
      payload: { request: secondRequest },
    });
    const firstOrdinal = await firstAdapter.allocateResponseOrdinal(
      fence,
      firstRequest,
    );
    const secondOrdinal = await secondAdapter.allocateResponseOrdinal(
      fence,
      secondRequest,
    );
    const failure = new Error("first completion could not persist");
    await firstAdapter.abandonResponse(
      fence,
      firstRequest,
      firstOrdinal,
      failure,
    );
    let laterCommitEntered = false;

    await expect(
      secondAdapter.commitResponse(
        fence,
        secondRequest,
        secondOrdinal,
        async () => {
          laterCommitEntered = true;
        },
      ),
    ).rejects.toBe(failure);
    expect(laterCommitEntered).toBe(false);
    await expect(
      secondAdapter.allocateResponseOrdinal(fence, secondRequest),
    ).resolves.toBe(1);
  });

  it("serializes concurrent event appends without sequence collisions", async () => {
    const adapter = new WorkflowRunOperationJournal(journal);
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        adapter.appendEvent(fence, {
          type: "operation_prepared",
          payload: {
            request: requestFor(
              runId,
              String.fromCharCode("a".charCodeAt(0) + index),
              index + 1,
            ),
          },
        }),
      ),
    );
    const events = appended.map(({ event }) => event);
    const sequences = events.map(({ sequence }) => sequence);
    expect(new Set(sequences).size).toBe(events.length);
    expect(sequences).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 3),
    );
  });

  it("round-trips canonical durable output blobs", async () => {
    const adapter = new WorkflowRunOperationJournal(journal);
    const value = {
      result: ["one", { nested: true }],
      usage: { input: 3, output: 2 },
    };
    const encoded = durableWorkflowOperationBlobCodec.encode(value);
    const reference = await adapter.putOutcomeBlob(fence, encoded);
    const persisted = await adapter.readOutcomeBlob(fence, reference);

    expect(reference).toEqual({
      sha256: encoded.sha256,
      sizeBytes: encoded.bytes,
    });
    expect(durableWorkflowOperationBlobCodec.decode(persisted)).toEqual(value);
  });

  it("rejects work after the namespace fence is lost", async () => {
    const adapter = new WorkflowRunOperationJournal(journal);
    await lease.release();
    await store.acquireLease(owner, { scopeId: 5, generation: 3 });

    await expect(adapter.revalidateFence(fence)).rejects.toMatchObject({
      code: "fence_lost",
    });
    await expect(
      adapter.putOutcomeBlob(fence, encodeDurableValue("stale")),
    ).rejects.toMatchObject({ code: "fence_lost" });
  });

  it("verifies recovery blobs by purpose and maps hash, size, and path mismatches", async () => {
    const definition = await journal.writeDefinition(
      "export default { tasks: [] };\n",
    );
    const output = await journal.writeOutput({ done: true });
    const resolver = new WorkflowRunBlobResolver(store);
    const base = { owner, runId, eventId: "referencing-event" } as const;

    await expect(
      resolver.verifyBlob({
        ...base,
        purpose: "plan_definition",
        reference: definition,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      resolver.verifyBlob({
        ...base,
        purpose: "delivery_payload",
        reference: output,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      resolver.verifyBlob({
        ...base,
        purpose: "run_result",
        reference: { ...output, sizeBytes: output.sizeBytes + 1 },
      }),
    ).resolves.toMatchObject({ ok: false, code: "size_mismatch" });

    const persistedPath = outputPath(home, owner, runId, output.sha256);
    const corrupted = readFileSync(persistedPath);
    corrupted[0] = corrupted[0] === 0x7b ? 0x5b : 0x7b;
    writeFileSync(persistedPath, corrupted);
    await expect(
      resolver.verifyBlob({
        ...base,
        purpose: "operation_value",
        reference: output,
      }),
    ).resolves.toMatchObject({ ok: false, code: "hash_mismatch" });

    await expect(
      resolver.verifyBlob({
        ...base,
        purpose: "operation_error",
        reference: {
          sha256: createWorkflowSha256Digest("f".repeat(64)),
          sizeBytes: 1,
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "path_mismatch" });
  });
});

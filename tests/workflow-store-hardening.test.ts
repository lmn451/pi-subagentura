import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeDurableValue } from "../src/workflow-durable-value";
import { WorkflowOperationGate } from "../src/workflow-operation-gate";
import {
  WorkflowRunOperationJournal,
  durableWorkflowOperationBlobCodec,
} from "../src/workflow-operation-journal";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type PersistedWorkflowNamespaceLease,
  type WorkflowRunJournal,
  type WorkflowRunStoreWriteBoundary,
} from "../src/workflow-run-store";
import {
  DEFAULT_WORKFLOW_QUOTA_LIMITS,
  WorkflowQuotaError,
} from "../src/workflow-quotas";
import { InMemoryWorkflowProjectionRepository } from "../src/workflow-projection-repository";
import { WorkflowRecoveryService } from "../src/workflow-recovery";
import {
  WORKFLOW_OUTBOX_SCHEMA_VERSION,
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowSha256Digest,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowOperationRequest,
  type WorkflowRunEvent,
} from "../src/workflow-run-types";

const ROOT_DEFINITION_DIGEST = createWorkflowDefinitionDigest("a".repeat(64));
const ROOT_DEFINITION_PATH = createWorkflowDefinitionPath("root");
const ZERO_ACCOUNTING = {
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
  { readonly type: Type }
>;

function runDirectory(
  home: string,
  owner: DurableWorkflowOwner,
  runId: DurableWorkflowRunId,
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
  );
}

function leasePath(home: string, owner: DurableWorkflowOwner): string {
  return join(
    home,
    ".pi-subagentura",
    "workflow-runs",
    "v1",
    owner.projectKey,
    owner.piSessionKey,
    "owner-lease.json",
  );
}

function event<Type extends WorkflowRunEvent["type"]>(
  journal: WorkflowRunJournal,
  type: Type,
  sequence: number,
  payload: EventOf<Type>["payload"],
  eventId = `${type}-${sequence}`,
): EventOf<Type> {
  if (journal.runEpoch === undefined) {
    throw new Error("test event requires a leased journal");
  }
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    runId: journal.runId,
    runEpoch: journal.runEpoch,
    sequence,
    type,
    payload,
  } as EventOf<Type>;
}

function createdEvent(
  journal: WorkflowRunJournal,
  owner: DurableWorkflowOwner,
  sequence = 1,
): EventOf<"run_created"> {
  return event(journal, "run_created", sequence, {
    durableOwner: owner,
    executionKind: "plan",
    rootDefinitionPath: ROOT_DEFINITION_PATH,
    rootDefinitionDigest: ROOT_DEFINITION_DIGEST,
    resumePolicy: "trusted_resume",
  });
}

async function appendTerminalEvidence(
  journal: WorkflowRunJournal,
  options: {
    readonly deliver: boolean;
    readonly storageFailure?: boolean;
    readonly recoveryFailure?: boolean;
  },
): Promise<void> {
  let sequence = 2;
  await journal.append(
    event(journal, "run_epoch_acquired", sequence++, {
      fence: journal.fence!,
      previousRunEpoch: null,
      reason: "created",
    }),
  );
  if (options.storageFailure) {
    await journal.append(
      event(journal, "storage_failure", sequence++, {
        code: "append_failed",
        diagnostic: "bounded injected storage failure",
      }),
    );
  }
  if (options.recoveryFailure) {
    await journal.append(
      event(journal, "recovery_failed", sequence++, {
        code: "path_mismatch",
        diagnostic: "bounded injected recovery failure",
      }),
    );
  }
  const result = await journal.writeOutput({ answer: 42 });
  const resultEvent = event(journal, "run_result_recorded", sequence++, {
    result,
    accounting: ZERO_ACCOUNTING,
  });
  await journal.append(resultEvent);
  const terminal = event(journal, "run_terminal", sequence++, {
    status: "done",
    accounting: ZERO_ACCOUNTING,
    resultEventId: resultEvent.eventId,
  });
  const terminalReceipt = await journal.append(terminal);
  await journal.writeResult({
    terminalEventId: terminal.eventId,
    baseEventByteEndExclusive: terminalReceipt.byteEndExclusive,
    result,
  });
  if (!options.deliver) return;
  const intent = event(journal, "delivery_intent_recorded", sequence++, {
    outboxSchemaVersion: WORKFLOW_OUTBOX_SCHEMA_VERSION,
    deliveryId: `delivery-${journal.runId}`,
    terminalEventId: terminal.eventId,
    payload: result,
  });
  await journal.append(intent);
  await journal.append(
    event(journal, "delivery_receipt_recorded", sequence, {
      outboxSchemaVersion: WORKFLOW_OUTBOX_SCHEMA_VERSION,
      deliveryId: intent.payload.deliveryId,
      intentEventId: intent.eventId,
      deliveredBy: "trusted-parent",
    }),
  );
}

function enospc(message: string): Error & { readonly code: "ENOSPC" } {
  return Object.assign(new Error(message), { code: "ENOSPC" as const });
}

describe("durable workflow store hardening", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-store-hardening-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "hardening-session");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("publishes conservative finite defaults for every durable quota dimension", () => {
    for (const limit of Object.values(DEFAULT_WORKFLOW_QUOTA_LIMITS)) {
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
    expect(DEFAULT_WORKFLOW_QUOTA_LIMITS.maxEventBytes).toBeLessThanOrEqual(
      DEFAULT_WORKFLOW_QUOTA_LIMITS.maxBytesPerRun,
    );
    expect(DEFAULT_WORKFLOW_QUOTA_LIMITS.maxBytesPerRun).toBeLessThanOrEqual(
      DEFAULT_WORKFLOW_QUOTA_LIMITS.maxBytesPerOwner,
    );
    expect(DEFAULT_WORKFLOW_QUOTA_LIMITS.maxStartupRuns).toBeLessThanOrEqual(
      DEFAULT_WORKFLOW_QUOTA_LIMITS.maxRunsPerOwner,
    );
  });

  it("rejects one oversized string before constructing an oversized value", () => {
    expect(() =>
      encodeDurableValue("éé", {
        maxStringBytes: 3,
        maxBytes: 32,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "max_string_bytes",
        limit: 3,
        actual: 4,
      }),
    );
  });

  it("closes the operation gate before model dispatch when the event quota is full", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 101, processStartIdentity: "quota-gate" },
      quotas: { maxEventsPerRun: 2 },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const journal = await lease.createRun({
      runId: createDurableWorkflowRunId("quota-gate"),
      launch: {},
    });
    await journal.append(createdEvent(journal, owner));
    await journal.append(
      event(journal, "run_epoch_acquired", 2, {
        fence: journal.fence!,
        previousRunEpoch: null,
        reason: "created",
      }),
    );
    const operationJournal = new WorkflowRunOperationJournal(
      journal,
      () => "quota-event-id",
    );
    const runModel = vi.fn(async () => ({
      isError: false as const,
      output: "must not run",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    }));
    const gate = new WorkflowOperationGate({
      journal: operationJournal,
      blobCodec: durableWorkflowOperationBlobCodec,
      dispatcher: { run: runModel },
    });
    const request: WorkflowOperationRequest = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      identity: createWorkflowOperationIdentity(
        journal.runId,
        ROOT_DEFINITION_PATH,
        "quota-operation",
      ),
      requestDigest: createWorkflowRequestDigest("b".repeat(64)),
      definitionDigest: ROOT_DEFINITION_DIGEST,
      dispatchOrdinal: createWorkflowDispatchOrdinal(1),
    };

    await expect(
      gate.execute(journal.fence!, request, {
        prompt: "must not dispatch",
        isolation: "in-process",
      }),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      dimension: "maxEventsPerRun",
    });
    expect(runModel).not.toHaveBeenCalled();
    expect((await journal.readEvents()).map(({ type }) => type)).toEqual([
      "run_created",
      "run_epoch_acquired",
    ]);
  });

  it("rejects owner growth before creating a second run", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 102, processStartIdentity: "owner-quota" },
      quotas: { maxRunsPerOwner: 1, maxStartupRuns: 1 },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    await lease.createRun({
      runId: createDurableWorkflowRunId("first"),
      launch: {},
    });
    const rejectedId = createDurableWorkflowRunId("second");

    await expect(
      lease.createRun({ runId: rejectedId, launch: {} }),
    ).rejects.toBeInstanceOf(WorkflowQuotaError);
    expect(existsSync(runDirectory(home, owner, rejectedId))).toBe(false);
  });

  it("bounds startup before opening any run", async () => {
    const openRun = vi.fn();
    const recovery = new WorkflowRecoveryService(
      {
        listRunIds: async () => [
          createDurableWorkflowRunId("startup-a"),
          createDurableWorkflowRunId("startup-b"),
        ],
        openRun,
      },
      new InMemoryWorkflowProjectionRepository(),
      { verifyBlob: async () => ({ ok: true }) },
      { limits: { maxStartupRuns: 1 } },
    );

    await expect(recovery.recoverOwner(owner)).rejects.toMatchObject({
      code: "quota_exceeded",
      dimension: "maxStartupRuns",
    });
    expect(openRun).not.toHaveBeenCalled();
  });

  it("never returns a blob reference when publish or directory sync hits ENOSPC", async () => {
    let failingBoundary: WorkflowRunStoreWriteBoundary | undefined;
    let failDirectorySync = false;
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 103, processStartIdentity: "publish-enospc" },
      io: {
        before: (boundary, purpose) => {
          if (boundary === failingBoundary && purpose === "output") {
            throw enospc(`injected ${boundary} ENOSPC`);
          }
        },
      },
      sync: {
        directory: async (handle, purpose) => {
          await handle.sync();
          if (failDirectorySync && purpose === "output") {
            throw enospc("injected directory sync ENOSPC");
          }
        },
      },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("publish-enospc");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(createdEvent(journal, owner));
    const eventsBefore = readFileSync(
      join(runDirectory(home, owner, runId), "events.ndjson"),
    );
    let acknowledgedReference: unknown;

    failingBoundary = "publish";
    await expect(
      journal.writeOutput({ never: "acknowledged" }).then((reference) => {
        acknowledgedReference = reference;
      }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(acknowledgedReference).toBeUndefined();
    expect(
      readdirSync(join(runDirectory(home, owner, runId), "outputs")),
    ).toEqual([]);
    expect(
      readFileSync(join(runDirectory(home, owner, runId), "events.ndjson")),
    ).toEqual(eventsBefore);

    failingBoundary = undefined;
    failDirectorySync = true;
    await expect(
      journal.writeOutput({ published: "but not acknowledged" }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(acknowledgedReference).toBeUndefined();
    failDirectorySync = false;
    await expect(
      journal.writeOutput({ published: "but not acknowledged" }),
    ).resolves.toMatchObject({ sizeBytes: expect.any(Number) });
  });

  it("preserves the prior event prefix and returns no receipt on append and sync ENOSPC", async () => {
    let failAppend = false;
    let failEventSync = false;
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 104, processStartIdentity: "append-enospc" },
      io: {
        before: (boundary, purpose) => {
          if (failAppend && boundary === "append" && purpose === "events") {
            throw enospc("injected append ENOSPC");
          }
        },
      },
      sync: {
        file: async (handle, purpose) => {
          await handle.sync();
          if (failEventSync && purpose === "events") {
            throw enospc("injected event sync ENOSPC");
          }
        },
      },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("append-enospc");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(createdEvent(journal, owner));
    const path = join(runDirectory(home, owner, runId), "events.ndjson");
    const prior = readFileSync(path);
    let receipt: unknown;

    failAppend = true;
    await expect(
      journal
        .append(
          event(journal, "run_interrupted", 2, {
            reason: "process_crash",
          }),
        )
        .then((value) => {
          receipt = value;
        }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(receipt).toBeUndefined();
    expect(readFileSync(path)).toEqual(prior);

    failAppend = false;
    failEventSync = true;
    await expect(
      journal
        .append(
          event(journal, "run_interrupted", 2, {
            reason: "process_crash",
          }),
        )
        .then((value) => {
          receipt = value;
        }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(receipt).toBeUndefined();
    expect(readFileSync(path).subarray(0, prior.length)).toEqual(prior);
  });

  it("distinguishes a torn tail from complete corruption and repairs only under the current owner", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 105, processStartIdentity: "tail-owner" },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("tail-corruption");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(createdEvent(journal, owner));
    const path = join(runDirectory(home, owner, runId), "events.ndjson");
    const prefix = readFileSync(path);
    appendFileSync(path, '{"torn":true');
    const unleased = await store.openRun(owner, runId);

    await expect(unleased.repairTornTail()).rejects.toMatchObject({
      code: "fence_lost",
    });
    await expect(journal.repairTornTail()).resolves.toBeGreaterThan(0);
    expect(readFileSync(path)).toEqual(prefix);

    appendFileSync(path, "{}\n");
    const corrupt = readFileSync(path);
    await expect(journal.readEvents()).rejects.toMatchObject({
      code: "malformed_complete_line",
    });
    await expect(journal.repairTornTail()).rejects.toMatchObject({
      code: "malformed_complete_line",
    });
    expect(readFileSync(path)).toEqual(corrupt);
  });

  it("rejects hardlinks, insecure modes, symlinks, and rename substitution", async () => {
    let substituteOnSync = false;
    let eventsPath = "";
    const movedPath = join(home, "moved-authoritative-events");
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 106, processStartIdentity: "path-defense" },
      sync: {
        file: async (handle, purpose) => {
          await handle.sync();
          if (substituteOnSync && purpose === "events") {
            renameSync(eventsPath, movedPath);
            writeFileSync(eventsPath, "", { mode: 0o600 });
          }
        },
      },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });

    const hardlinkRun = createDurableWorkflowRunId("hardlink");
    const hardlinkJournal = await lease.createRun({
      runId: hardlinkRun,
      launch: {},
    });
    await hardlinkJournal.append(createdEvent(hardlinkJournal, owner));
    const hardlinkEvents = join(
      runDirectory(home, owner, hardlinkRun),
      "events.ndjson",
    );
    const alias = join(home, "events-hardlink");
    linkSync(hardlinkEvents, alias);
    await expect(hardlinkJournal.readEvents()).rejects.toMatchObject({
      code: "path_mismatch",
    });
    rmSync(alias);
    chmodSync(hardlinkEvents, 0o644);
    await expect(hardlinkJournal.readEvents()).rejects.toMatchObject({
      code: "path_mismatch",
    });
    chmodSync(hardlinkEvents, 0o600);

    const symlinkRun = createDurableWorkflowRunId("symlink-file");
    const symlinkJournal = await lease.createRun({
      runId: symlinkRun,
      launch: {},
    });
    const symlinkEvents = join(
      runDirectory(home, owner, symlinkRun),
      "events.ndjson",
    );
    const outside = join(home, "outside-events");
    writeFileSync(outside, "", { mode: 0o600 });
    rmSync(symlinkEvents);
    symlinkSync(outside, symlinkEvents);
    await expect(symlinkJournal.readEvents()).rejects.toMatchObject({
      code: "symlink_rejected",
    });
    rmSync(symlinkEvents);
    writeFileSync(symlinkEvents, "", { mode: 0o600 });

    const renameRun = createDurableWorkflowRunId("rename-substitution");
    const renameJournal = await lease.createRun({
      runId: renameRun,
      launch: {},
    });
    await renameJournal.append(createdEvent(renameJournal, owner));
    eventsPath = join(runDirectory(home, owner, renameRun), "events.ndjson");
    const prior = readFileSync(eventsPath);
    substituteOnSync = true;
    await expect(
      renameJournal.append(
        event(renameJournal, "run_interrupted", 2, {
          reason: "process_crash",
        }),
      ),
    ).rejects.toMatchObject({ code: "path_mismatch" });
    expect(readFileSync(movedPath).subarray(0, prior.length)).toEqual(prior);
  });

  it("retains every protected state and classifies only delivered durable terminal evidence", async () => {
    const futureNow = Date.now() + 60_000;
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 107, processStartIdentity: "retention-policy" },
      now: () => futureNow,
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const nonterminalId = createDurableWorkflowRunId("protected-running");
    const nonterminal = await lease.createRun({
      runId: nonterminalId,
      launch: {},
    });
    await nonterminal.append(createdEvent(nonterminal, owner));
    await nonterminal.append(
      event(nonterminal, "run_epoch_acquired", 2, {
        fence: nonterminal.fence!,
        previousRunEpoch: null,
        reason: "created",
      }),
    );

    const interruptedId = createDurableWorkflowRunId("protected-interrupted");
    const interrupted = await lease.createRun({
      runId: interruptedId,
      launch: {},
    });
    await interrupted.append(createdEvent(interrupted, owner));
    await interrupted.append(
      event(interrupted, "run_epoch_acquired", 2, {
        fence: interrupted.fence!,
        previousRunEpoch: null,
        reason: "created",
      }),
    );
    await interrupted.append(
      event(interrupted, "run_interrupted", 3, {
        reason: "process_crash",
      }),
    );

    const awaitingId = createDurableWorkflowRunId("protected-awaiting-budget");
    const awaiting = await lease.createRun({ runId: awaitingId, launch: {} });
    await awaiting.append(createdEvent(awaiting, owner));
    await awaiting.append(
      event(awaiting, "run_epoch_acquired", 2, {
        fence: awaiting.fence!,
        previousRunEpoch: null,
        reason: "created",
      }),
    );
    const planDefinition = await awaiting.writeOutput({ tasks: [] });
    await awaiting.append(
      event(awaiting, "plan_defined", 3, {
        revision: 1,
        definitionDigest: createWorkflowDefinitionDigest(planDefinition.sha256),
        definition: planDefinition,
      }),
    );
    await awaiting.append(
      event(awaiting, "budget_requested", 4, {
        budgetRequestId: "budget-request",
        approvalKind: "budget",
        reason: "agent_limit",
        description: "trusted continuation required",
        accounting: ZERO_ACCOUNTING,
        policyHash: createWorkflowSha256Digest("c".repeat(64)),
        planRevision: 1,
        ownerGeneration: awaiting.fence!.generation,
        runEpoch: awaiting.fence!.runEpoch,
        version: 1,
        denialPolicy: "stop",
        subjectTaskId: null,
      }),
    );

    const undeliveredId = createDurableWorkflowRunId("protected-undelivered");
    const undelivered = await lease.createRun({
      runId: undeliveredId,
      launch: {},
    });
    await undelivered.append(createdEvent(undelivered, owner));
    await appendTerminalEvidence(undelivered, { deliver: false });

    const failedId = createDurableWorkflowRunId("protected-storage-failure");
    const failed = await lease.createRun({ runId: failedId, launch: {} });
    await failed.append(createdEvent(failed, owner));
    await appendTerminalEvidence(failed, {
      deliver: true,
      storageFailure: true,
    });

    const recoveryFailedId = createDurableWorkflowRunId(
      "protected-recovery-failure",
    );
    const recoveryFailed = await lease.createRun({
      runId: recoveryFailedId,
      launch: {},
    });
    await recoveryFailed.append(createdEvent(recoveryFailed, owner));
    await appendTerminalEvidence(recoveryFailed, {
      deliver: true,
      recoveryFailure: true,
    });

    const classifications = await lease.listRetentionCandidates({
      minimumAgeMs: 0,
      minimumRunsPerOwner: 0,
      maxPrunesPerPass: 10,
    });
    const reasons = new Map(
      classifications.map((classification) => [
        classification.runId,
        classification.eligible ? "eligible" : classification.reason,
      ]),
    );
    expect(reasons.get(nonterminalId)).toBe("nonterminal");
    expect(reasons.get(interruptedId)).toBe("nonterminal");
    expect(reasons.get(awaitingId)).toBe("nonterminal");
    expect(reasons.get(undeliveredId)).toBe("undelivered");
    expect(reasons.get(failedId)).toBe("storage_failure");
    expect(reasons.get(recoveryFailedId)).toBe("recovery_failure");
    for (const runId of [
      nonterminalId,
      interruptedId,
      awaitingId,
      undeliveredId,
      failedId,
      recoveryFailedId,
    ]) {
      expect(existsSync(runDirectory(home, owner, runId))).toBe(true);
    }
  });

  it("prunes eligible delivery only under the current lease fence", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 108, processStartIdentity: "retention-fence" },
      now: () => Date.now() + 60_000,
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 5,
      generation: 1,
    });
    const staleId = createDurableWorkflowRunId("stale-retention");
    const staleJournal = await lease.createRun({ runId: staleId, launch: {} });
    await staleJournal.append(createdEvent(staleJournal, owner));
    await appendTerminalEvidence(staleJournal, { deliver: true });
    const staleCandidate = (
      await lease.listRetentionCandidates({
        minimumAgeMs: 0,
        minimumRunsPerOwner: 0,
        maxPrunesPerPass: 10,
      })
    ).find((classification) => classification.eligible);
    if (staleCandidate === undefined || !staleCandidate.eligible) {
      throw new Error("expected eligible stale-fence candidate");
    }
    const replacementLease: PersistedWorkflowNamespaceLease = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      durableOwner: owner,
      scopeId: 5,
      generation: 2,
      leaseToken: "replacement-lease-token",
      pid: 999,
      processStartIdentity: "replacement-owner",
    };
    writeFileSync(
      leasePath(home, owner),
      encodeDurableValue(replacementLease).json,
      { mode: 0o600 },
    );
    chmodSync(leasePath(home, owner), 0o600);

    await expect(
      lease.pruneRetentionCandidate(staleCandidate),
    ).rejects.toMatchObject({ code: "fence_lost" });
    expect(existsSync(runDirectory(home, owner, staleId))).toBe(true);

    const currentOwner = await deriveDurableWorkflowOwner(
      cwd,
      "current-retention-session",
    );
    const currentLease = await store.acquireLease(currentOwner, {
      scopeId: 6,
      generation: 1,
    });
    const currentId = createDurableWorkflowRunId("current-retention");
    const currentJournal = await currentLease.createRun({
      runId: currentId,
      launch: {},
    });
    await currentJournal.append(createdEvent(currentJournal, currentOwner));
    await appendTerminalEvidence(currentJournal, { deliver: true });
    const currentCandidate = (
      await currentLease.listRetentionCandidates({
        minimumAgeMs: 0,
        minimumRunsPerOwner: 0,
        maxPrunesPerPass: 10,
      })
    ).find((classification) => classification.eligible);
    if (currentCandidate === undefined || !currentCandidate.eligible) {
      throw new Error("expected eligible current-fence candidate");
    }

    await currentLease.pruneRetentionCandidate(currentCandidate);
    expect(existsSync(runDirectory(home, currentOwner, currentId))).toBe(false);
  });

  it("recovers an immutable blob whose published hard link survived a crash", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 109, processStartIdentity: "publish-recovery" },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 7,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("publish-link-recovery");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(createdEvent(journal, owner));
    const definition = "export const recovered = true;\n";
    const reference = await journal.writeDefinition(definition);
    const definitionPath = join(
      runDirectory(home, owner, runId),
      "definitions",
      `${reference.sha256}.js`,
    );
    const temporary = join(
      dirname(definitionPath),
      `.publish-${lease.fence.leaseToken}.tmp`,
    );
    linkSync(definitionPath, temporary);
    await expect(journal.readDefinition(reference)).rejects.toMatchObject({
      code: "path_mismatch",
    });
    await lease.release();

    const recoveredLease = await store.acquireLease(owner, {
      scopeId: 7,
      generation: 2,
    });
    const recovered = await recoveredLease.openRun(runId);
    expect(await recovered.readDefinition(reference)).toBe(definition);
    expect(existsSync(temporary)).toBe(false);
    await recoveredLease.release();
  });

  it("atomically retires a visible run before crashable prune cleanup", async () => {
    let pruneBoundaries = 0;
    let crashCleanup = true;
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 110, processStartIdentity: "atomic-prune" },
      now: () => Date.now() + 60_000,
      io: {
        before: (boundary) => {
          if (boundary !== "prune") return;
          pruneBoundaries += 1;
          if (crashCleanup && pruneBoundaries === 2) {
            throw new Error("injected crash after atomic retirement");
          }
        },
      },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 8,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("atomic-prune");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(createdEvent(journal, owner));
    await appendTerminalEvidence(journal, { deliver: true });
    const candidate = (
      await lease.listRetentionCandidates({
        minimumAgeMs: 0,
        minimumRunsPerOwner: 0,
        maxPrunesPerPass: 10,
      })
    ).find((classification) => classification.eligible);
    if (candidate === undefined || !candidate.eligible) {
      throw new Error("expected atomic-prune retention candidate");
    }

    await expect(lease.pruneRetentionCandidate(candidate)).rejects.toThrow(
      "injected crash after atomic retirement",
    );
    expect(await store.listRunIds(owner)).toEqual([]);
    await expect(store.openRun(owner, runId)).rejects.toMatchObject({
      code: "run_not_found",
    });
    const namespace = dirname(leasePath(home, owner));
    expect(
      readdirSync(namespace).some((name) => name.startsWith(".prune-")),
    ).toBe(true);

    crashCleanup = false;
    await lease.release();
    const recoveredLease = await store.acquireLease(owner, {
      scopeId: 8,
      generation: 2,
    });
    expect(
      readdirSync(namespace).some((name) => name.startsWith(".prune-")),
    ).toBe(false);
    await recoveredLease.release();
  });

  it("automatically frees quota only from eligible terminal history", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: 111,
        processStartIdentity: "automatic-retention",
      },
      quotas: { maxRunsPerOwner: 1 },
      retention: {
        minimumAgeMs: 0,
        minimumRunsPerOwner: 0,
        maxPrunesPerPass: 10,
      },
    });
    const lease = await store.acquireLease(owner, {
      scopeId: 9,
      generation: 1,
    });
    const terminalId = createDurableWorkflowRunId("terminal-at-quota");
    const terminal = await lease.createRun({ runId: terminalId, launch: {} });
    await terminal.append(createdEvent(terminal, owner));
    await appendTerminalEvidence(terminal, { deliver: true });
    await lease.release();
    const retainedLease = await store.acquireLease(owner, {
      scopeId: 9,
      generation: 2,
    });

    const activeId = createDurableWorkflowRunId("active-after-retention");
    const active = await retainedLease.createRun({
      runId: activeId,
      launch: {},
    });
    await active.append(createdEvent(active, owner));
    expect(existsSync(runDirectory(home, owner, terminalId))).toBe(false);
    expect(existsSync(runDirectory(home, owner, activeId))).toBe(true);

    await expect(
      retainedLease.createRun({
        runId: createDurableWorkflowRunId("blocked-by-active"),
        launch: {},
      }),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      dimension: "maxRunsPerOwner",
    });
    expect(existsSync(runDirectory(home, owner, activeId))).toBe(true);
    await retainedLease.release();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowLeaseLiveness,
  type WorkflowRunJournal,
} from "../src/workflow-run-store";
import { foldWorkflowRunEvents } from "../src/workflow-projection-repository";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowRunCreatedEvent,
  type WorkflowRunInterruptedEvent,
} from "../src/workflow-run-types";

const DEFINITION_DIGEST = createWorkflowDefinitionDigest("b".repeat(64));

function leasedEpoch(journal: WorkflowRunJournal): number {
  if (journal.runEpoch === undefined)
    throw new Error("leased journal required");
  return journal.runEpoch;
}

function created(
  journal: WorkflowRunJournal,
  owner: DurableWorkflowOwner,
): WorkflowRunCreatedEvent {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId: "created",
    runId: journal.runId,
    runEpoch: leasedEpoch(journal),
    sequence: 1,
    type: "run_created",
    payload: {
      durableOwner: owner,
      executionKind: "plan",
      rootDefinitionPath: createWorkflowDefinitionPath("root"),
      rootDefinitionDigest: DEFINITION_DIGEST,
      resumePolicy: "trusted_resume",
    },
  };
}

function interrupted(
  journal: WorkflowRunJournal,
  eventId: string,
  sequence: number,
): WorkflowRunInterruptedEvent {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    runId: journal.runId,
    runEpoch: leasedEpoch(journal),
    sequence,
    type: "run_interrupted",
    payload: { reason: "owner_replaced" },
  };
}

function eventsPath(
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
    "events.ndjson",
  );
}

function contender(
  home: string,
  status: WorkflowLeaseLiveness,
  pid: number,
): WorkflowRunStore {
  return new WorkflowRunStore({
    homeDir: home,
    processIdentity: {
      pid,
      processStartIdentity: `process-${pid}`,
    },
    resolveLeaseLiveness: () => status,
  });
}

describe("workflow owner namespace leases", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let firstStore: WorkflowRunStore;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-run-lease-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "lease-session");
    firstStore = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 301, processStartIdentity: "process-301" },
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses to displace a provably live lease", async () => {
    const first = await firstStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const secondStore = contender(home, "live", 302);

    await expect(
      secondStore.acquireLease(owner, { scopeId: 2, generation: 2 }),
    ).rejects.toMatchObject({ code: "lease_live" });
    expect(first.fence.leaseToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it("fails closed when PID/process-start liveness is ambiguous", async () => {
    await firstStore.acquireLease(owner, { scopeId: 1, generation: 1 });
    const secondStore = contender(home, "ambiguous", 302);

    await expect(
      secondStore.acquireLease(owner, { scopeId: 2, generation: 2 }),
    ).rejects.toMatchObject({ code: "lease_ambiguous" });
  });

  it("permits only a verified stale takeover and rejects the old token fence", async () => {
    const first = await firstStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("stale-fence");
    const oldJournal = await first.createRun({ runId, launch: {} });
    await oldJournal.append(created(oldJournal, owner));

    const replacementStore = contender(home, "stale", 302);
    const replacement = await replacementStore.acquireLease(owner, {
      scopeId: 2,
      generation: 2,
    });
    const replacementJournal = await replacement.acquireRun(runId);

    expect(replacement.fence.leaseToken).not.toBe(first.fence.leaseToken);
    expect(replacementJournal.runEpoch).toBe(2);
    await expect(replacementJournal.revalidateFence()).resolves.toBeUndefined();
    await expect(oldJournal.revalidateFence()).rejects.toMatchObject({
      code: "fence_lost",
    });
    await expect(
      oldJournal.append(interrupted(oldJournal, "stale-write", 2)),
    ).rejects.toMatchObject({ code: "fence_lost" });
  });

  it("increments each acquired run epoch exactly once per namespace lease", async () => {
    const first = await firstStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("one-increment");
    const original = await first.createRun({ runId, launch: {} });
    await original.append(created(original, owner));

    const secondStore = contender(home, "stale", 302);
    const second = await secondStore.acquireLease(owner, {
      scopeId: 2,
      generation: 2,
    });
    const acquired = await second.acquireRun(runId);
    const acquiredAgain = await second.acquireRun(runId);
    const events = await acquired.readEvents();

    expect(acquired.runEpoch).toBe(2);
    expect(acquiredAgain).toBe(acquired);
    expect(events.map((event) => [event.type, event.runEpoch])).toEqual([
      ["run_created", 1],
      ["run_epoch_acquired", 2],
    ]);

    const thirdStore = contender(home, "stale", 303);
    const third = await thirdStore.acquireLease(owner, {
      scopeId: 3,
      generation: 3,
    });
    const thirdJournal = await third.acquireRun(runId);
    expect(thirdJournal.runEpoch).toBe(3);
    expect(
      (await thirdJournal.readEvents()).filter(
        (event) => event.type === "run_epoch_acquired",
      ),
    ).toHaveLength(2);
  });

  it("repairs a torn tail during current acquisition but rejects stale repair", async () => {
    const first = await firstStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("fenced-repair");
    const oldJournal = await first.createRun({ runId, launch: {} });
    await oldJournal.append(created(oldJournal, owner));
    appendFileSync(eventsPath(home, owner, runId), '{"torn"');

    const secondStore = contender(home, "stale", 302);
    const second = await secondStore.acquireLease(owner, {
      scopeId: 2,
      generation: 2,
    });
    await expect(oldJournal.repairTornTail()).rejects.toMatchObject({
      code: "fence_lost",
    });
    const current = await second.acquireRun(runId);
    expect((await current.readEventLog()).tornTailBytes).toBe(0);
    expect(current.runEpoch).toBe(2);
  });

  it("allows multiple independent runs under one namespace writer lease", async () => {
    const lease = await firstStore.acquireLease(owner, {
      scopeId: 7,
      generation: 4,
    });
    const firstRun = await lease.createRun({
      runId: createDurableWorkflowRunId("multi-a"),
      launch: { label: "a" },
    });
    const secondRun = await lease.createRun({
      runId: createDurableWorkflowRunId("multi-b"),
      launch: { label: "b" },
    });
    await Promise.all([
      firstRun.append(created(firstRun, owner)),
      secondRun.append(created(secondRun, owner)),
    ]);

    expect(firstRun.runEpoch).toBe(1);
    expect(secondRun.runEpoch).toBe(1);
    expect((await firstRun.readEvents()).map((event) => event.eventId)).toEqual(
      ["created"],
    );
    expect(
      (await secondRun.readEvents()).map((event) => event.eventId),
    ).toEqual(["created"]);
    expect(await firstStore.listRunIds(owner)).toEqual([
      createDurableWorkflowRunId("multi-a"),
      createDurableWorkflowRunId("multi-b"),
    ]);
  });

  it("release removes writer authority and a successor acquires a new epoch", async () => {
    const first = await firstStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("released");
    const oldJournal = await first.createRun({ runId, launch: {} });
    await oldJournal.append(created(oldJournal, owner));
    await first.release();

    await expect(
      oldJournal.append(interrupted(oldJournal, "after-release", 2)),
    ).rejects.toMatchObject({ code: "fence_lost" });
    const nextStore = contender(home, "ambiguous", 302);
    const nextLease = await nextStore.acquireLease(owner, {
      scopeId: 2,
      generation: 2,
    });
    const nextJournal = await nextLease.acquireRun(runId, "startup");
    expect(nextJournal.runEpoch).toBe(2);
  });

  it("drains an in-flight epoch append before releasing the lease to its successor", async () => {
    let blockNextEventAppend = false;
    let markAppendEntered!: () => void;
    const appendEntered = new Promise<void>((resolve) => {
      markAppendEntered = resolve;
    });
    let resumeAppend!: () => void;
    const appendMayWrite = new Promise<void>((resolve) => {
      resumeAppend = resolve;
    });
    firstStore = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 301, processStartIdentity: "process-301" },
      io: {
        before: async (boundary, purpose) => {
          if (
            blockNextEventAppend &&
            boundary === "append" &&
            purpose === "events"
          ) {
            blockNextEventAppend = false;
            markAppendEntered();
            await appendMayWrite;
          }
        },
      },
    });
    const first = await firstStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("release-drains-append");
    const epochOne = await first.createRun({ runId, launch: {} });
    await epochOne.append(created(epochOne, owner));
    const epochOneFence = epochOne.fence;
    if (epochOneFence === undefined) throw new Error("leased journal required");
    await epochOne.append({
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: "epoch-one-acquired",
      runId,
      runEpoch: leasedEpoch(epochOne),
      sequence: 2,
      type: "run_epoch_acquired",
      payload: {
        fence: epochOneFence,
        previousRunEpoch: null,
        reason: "created",
      },
    });

    blockNextEventAppend = true;
    const epochOneAppend = epochOne.append(
      interrupted(epochOne, "epoch-one-in-flight", 3),
    );
    await appendEntered;

    const namespaceFenceChecks = vi.spyOn(firstStore, "_assertNamespaceFence");
    const checksBeforeRelease = namespaceFenceChecks.mock.calls.length;
    const release = first.release();
    const releaseEnteredBeforeAppendDrained =
      namespaceFenceChecks.mock.calls.length > checksBeforeRelease;
    const successorStore = contender(home, "ambiguous", 302);
    const successorJournal = release.then(async () => {
      const successor = await successorStore.acquireLease(owner, {
        scopeId: 2,
        generation: 2,
      });
      return successor.acquireRun(runId, "startup");
    });

    let successorAcquiredBeforeAppendDrained = false;
    if (releaseEnteredBeforeAppendDrained) {
      await successorJournal;
      successorAcquiredBeforeAppendDrained = true;
    }
    resumeAppend();
    const epochOneAppendOutcome = await epochOneAppend.then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    const epochTwo = await successorJournal;
    const afterTakeover = await epochTwo.readEventLog();
    const epochTwoReceipt = await epochTwo.append({
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: "epoch-two-after-release",
      runId,
      runEpoch: leasedEpoch(epochTwo),
      sequence: 5,
      type: "run_resumed",
      payload: {
        reason: "trusted_resume",
        trustedActorId: "lease-handoff-test",
      },
    });
    const finalLog = await epochTwo.readEventLog();

    expect(releaseEnteredBeforeAppendDrained).toBe(false);
    expect(successorAcquiredBeforeAppendDrained).toBe(false);
    expect(epochOneAppendOutcome).toBe("fulfilled");
    expect(afterTakeover.tornTailBytes).toBe(0);
    expect(() => foldWorkflowRunEvents(afterTakeover.events)).not.toThrow();
    expect(epochTwoReceipt).toMatchObject({
      eventId: "epoch-two-after-release",
      runEpoch: 2,
    });
    expect(finalLog.events.map((event) => event.type)).toEqual([
      "run_created",
      "run_epoch_acquired",
      "run_interrupted",
      "run_epoch_acquired",
      "run_resumed",
    ]);
    expect(finalLog.tornTailBytes).toBe(0);
    expect(() => foldWorkflowRunEvents(finalLog.events)).not.toThrow();
  });

  it("does not consult liveness for a corrupt complete lease record", async () => {
    const namespace = join(
      home,
      ".pi-subagentura",
      "workflow-runs",
      "v1",
      owner.projectKey,
      owner.piSessionKey,
    );
    mkdirSync(join(namespace, "runs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(namespace, "owner-lease.json"), "{}", { mode: 0o600 });
    let consulted = false;
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 302, processStartIdentity: "process-302" },
      resolveLeaseLiveness: () => {
        consulted = true;
        return "stale";
      },
    });

    await expect(
      store.acquireLease(owner, { scopeId: 2, generation: 2 }),
    ).rejects.toMatchObject({ code: "lease_corrupt" });
    expect(consulted).toBe(false);
  });
});

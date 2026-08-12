import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { runDurableWorkflowPlan } from "../src/workflow-durable-plan-runner";
import {
  WorkflowRunCorruptionError,
  WorkflowRunQuotaError,
  WorkflowRunStore,
  workflowRunPath,
} from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import type { WorkflowPlan } from "../src/workflow-plan";

const roots: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};
const success = (): SubagentResult => ({
  isError: false,
  output: "must not dispatch",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
});

function plan(name: string): WorkflowPlan {
  return {
    schemaVersion: 1,
    name,
    phases: [
      {
        id: "phase",
        mode: "sequential",
        tasks: [{ id: "task", prompt: "task" }],
      },
    ],
  };
}

async function installCreationWriteFault(
  root: string,
  runId: string,
  fault: "launch-write" | "launch-fsync" | "event-write" | "event-fsync",
): Promise<void> {
  const probe = await open(join(root, "creation-write-probe"), "w+");
  const prototype = Object.getPrototypeOf(probe) as {
    write: (...args: any[]) => Promise<any>;
    sync: (...args: any[]) => Promise<void>;
  };
  await probe.close();
  const originalWrite = prototype.write;
  const originalSync = prototype.sync;
  const launchHandles = new WeakSet<object>();
  const eventHandles = new WeakSet<object>();
  let injected = false;
  vi.spyOn(prototype, "write").mockImplementation(async function (
    this: object,
    ...args: any[]
  ) {
    if (Buffer.isBuffer(args[0])) {
      const text = args[0].toString("utf8");
      const matchesRun = text.includes(`"runId":"${runId}"`);
      const isLaunch = matchesRun && !text.includes('"eventId"');
      const isEvent = matchesRun && text.includes('"eventId"');
      if (isLaunch) {
        if (fault === "launch-write" && !injected) {
          injected = true;
          throw new Error("injected launch write crash");
        }
        launchHandles.add(this);
      }
      if (isEvent) {
        if (fault === "event-write" && !injected) {
          injected = true;
          throw new Error("injected event write crash");
        }
        eventHandles.add(this);
      }
    }
    return originalWrite.apply(this, args);
  });
  if (fault === "launch-fsync" || fault === "event-fsync") {
    vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: object,
      ...args: any[]
    ) {
      if (fault === "launch-fsync" && launchHandles.has(this) && !injected) {
        injected = true;
        throw new Error("injected launch fsync crash");
      }
      if (fault === "event-fsync" && eventHandles.has(this) && !injected) {
        injected = true;
        throw new Error("injected event fsync crash");
      }
      return originalSync.apply(this, args);
    });
  }
}

async function installCreationDirectorySyncFault(
  root: string,
  runId: string,
  boundary: "private-directory" | "parent-directory",
): Promise<void> {
  const probe = await open(join(root, "creation-sync-probe"), "w+");
  const prototype = Object.getPrototypeOf(probe) as {
    write: (...args: any[]) => Promise<any>;
    sync: (...args: any[]) => Promise<void>;
  };
  await probe.close();
  const originalWrite = prototype.write;
  const originalSync = prototype.sync;
  const eventHandles = new WeakSet<object>();
  let eventSynced = false;
  let unassociatedSyncs = 0;
  vi.spyOn(prototype, "write").mockImplementation(async function (
    this: object,
    ...args: any[]
  ) {
    if (Buffer.isBuffer(args[0])) {
      const text = args[0].toString("utf8");
      if (text.includes(`"runId":"${runId}"`) && text.includes('"eventId"'))
        eventHandles.add(this);
    }
    return originalWrite.apply(this, args);
  });
  vi.spyOn(prototype, "sync").mockImplementation(async function (
    this: object,
    ...args: any[]
  ) {
    if (eventHandles.has(this)) eventSynced = true;
    else if (eventSynced) {
      unassociatedSyncs++;
      const target = boundary === "private-directory" ? 1 : 2;
      if (unassociatedSyncs === target)
        throw new Error(`injected ${boundary} fsync crash`);
    }
    return originalSync.apply(this, args);
  });
}

async function installJournalEventSyncFault(
  root: string,
  runId: string,
  eventType: string,
): Promise<void> {
  const probe = await open(join(root, "journal-sync-probe"), "w+");
  const prototype = Object.getPrototypeOf(probe) as {
    write: (...args: any[]) => Promise<any>;
    sync: (...args: any[]) => Promise<void>;
  };
  await probe.close();
  const originalWrite = prototype.write;
  const originalSync = prototype.sync;
  const targetHandles = new WeakSet<object>();
  let injected = false;
  vi.spyOn(prototype, "write").mockImplementation(async function (
    this: object,
    ...args: any[]
  ) {
    if (Buffer.isBuffer(args[0])) {
      const text = args[0].toString("utf8");
      if (
        text.includes(`"runId":"${runId}"`) &&
        text.includes(`"type":"${eventType}"`)
      )
        targetHandles.add(this);
    }
    return originalWrite.apply(this, args);
  });
  vi.spyOn(prototype, "sync").mockImplementation(async function (
    this: object,
    ...args: any[]
  ) {
    if (targetHandles.has(this) && !injected) {
      injected = true;
      throw new Error("injected event fsync crash");
    }
    return originalSync.apply(this, args);
  });
}

async function readEventsPath(root: string, runId: string): Promise<string> {
  return join(workflowRunPath(root, owner, runId), "events.ndjson");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("frozen durable storage crash and restart evidence", () => {
  it.each([
    "launch-write",
    "launch-fsync",
    "event-write",
    "event-fsync",
  ] as const)(
    "F01 leaves no dispatchable run after %s failure and reconstructed storage finds no run",
    async (fault) => {
      const root = await mkdtemp(join(tmpdir(), "workflow-storage-crash-"));
      roots.push(root);
      const runId = `creation-${fault}`;
      const store = new WorkflowRunStore({ rootDir: root, owner });
      await installCreationWriteFault(root, runId, fault);
      const runAgent = vi.fn(async () => success());

      await expect(
        runDurableWorkflowPlan({
          store,
          owner,
          runId,
          plan: plan(runId),
          runAgent,
        }),
      ).rejects.toThrow(
        `injected ${fault.startsWith("launch") ? "launch" : "event"} ${fault.endsWith("write") ? "write" : "fsync"} crash`,
      );
      expect(runAgent).not.toHaveBeenCalled();
      await store.release();
      const restarted = new WorkflowRunStore({ rootDir: root, owner });
      await expect(restarted.listRunIds()).resolves.toEqual([]);
      await expect(restarted.readRun(runId)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["private-directory", "parent-directory"] as const)(
    "F01 records the %s publication prefix and restart does not dispatch it",
    async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), "workflow-storage-crash-"));
      roots.push(root);
      const runId = `creation-${boundary}`;
      const store = new WorkflowRunStore({ rootDir: root, owner });
      await installCreationDirectorySyncFault(root, runId, boundary);
      const runAgent = vi.fn(async () => success());

      await expect(
        runDurableWorkflowPlan({
          store,
          owner,
          runId,
          plan: plan(runId),
          runAgent,
        }),
      ).rejects.toThrow(`injected ${boundary} fsync crash`);
      expect(runAgent).not.toHaveBeenCalled();
      await store.release();
      const restarted = new WorkflowRunStore({ rootDir: root, owner });
      if (boundary === "private-directory") {
        await expect(restarted.listRunIds()).resolves.toEqual([]);
      } else {
        await expect(restarted.readRun(runId)).resolves.toMatchObject({
          events: [{ type: "run_created", eventOrdinal: 0 }],
        });
      }
    },
  );

  it("F01 treats a caller-return crash as a committed creation prefix without dispatch on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-storage-crash-"));
    roots.push(root);
    const runId = "caller-return";
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const originalCreate = store.createRunWithInitialEvent.bind(store);
    vi.spyOn(store, "createRunWithInitialEvent").mockImplementation(
      async (...args: any[]) => {
        await (originalCreate as (...input: any[]) => Promise<unknown>)(
          ...args,
        );
        throw new Error("injected caller-return crash");
      },
    );
    const runAgent = vi.fn(async () => success());

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId,
        plan: plan(runId),
        runAgent,
      }),
    ).rejects.toThrow("caller-return crash");
    expect(runAgent).not.toHaveBeenCalled();
    await store.release();
    const restarted = new WorkflowRunStore({ rootDir: root, owner });
    await expect(restarted.readRun(runId)).resolves.toMatchObject({
      events: [{ type: "run_created", eventOrdinal: 0 }],
    });
  });

  it("F06 rolls back a journal suffix when its own fsync fails and preserves the restart prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-storage-crash-"));
    roots.push(root);
    const runId = "journal-fsync";
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId,
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    const eventsPath = await readEventsPath(root, runId);
    await store.append(runId, "committed", {});
    const prefix = await readFile(eventsPath);
    await installJournalEventSyncFault(root, runId, "must_not_commit");

    await expect(store.append(runId, "must_not_commit", {})).rejects.toThrow(
      "event fsync crash",
    );
    await expect(readFile(eventsPath)).resolves.toEqual(prefix);
    await store.release();
    const restarted = new WorkflowRunStore({ rootDir: root, owner });
    await expect(restarted.readRun(runId)).resolves.toMatchObject({
      events: [{ type: "committed", eventOrdinal: 0 }],
    });
  });

  it("F06 preserves a quota prefix across reconstruction and rejects corrupted complete evidence without dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-storage-crash-"));
    roots.push(root);
    const runId = "quota-and-corruption";
    const store = new WorkflowRunStore({
      rootDir: root,
      owner,
      maxEventBytes: 1,
    });
    await store.createRun({
      runId,
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await expect(store.append(runId, "over-quota", {})).rejects.toBeInstanceOf(
      WorkflowRunQuotaError,
    );
    await store.release();
    const restarted = new WorkflowRunStore({ rootDir: root, owner });
    await expect(restarted.readRun(runId)).resolves.toMatchObject({
      events: [],
    });

    const corruptionRunId = "corrupted-restart";
    const corruptionStore = new WorkflowRunStore({ rootDir: root, owner });
    await corruptionStore.createRunWithInitialEvent(
      {
        runId: corruptionRunId,
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      },
      { type: "run_created", payload: { plan: plan(corruptionRunId) } },
    );
    const corruptionPath = await readEventsPath(root, corruptionRunId);
    const committed = await readFile(corruptionPath);
    await writeFile(
      corruptionPath,
      Buffer.concat([committed, Buffer.from('{"complete":true}\n')]),
    );
    await corruptionStore.release();
    const reconstructed = new WorkflowRunStore({ rootDir: root, owner });
    await expect(reconstructed.readRun(corruptionRunId)).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
    const runAgent = vi.fn(async () => success());
    await expect(
      runDurableWorkflowPlan({
        store: reconstructed,
        owner,
        runId: corruptionRunId,
        plan: plan(corruptionRunId),
        runAgent,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunCorruptionError);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

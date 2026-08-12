import { mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowDeliveryId } from "../src/workflow-durable-plan-runner";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowRunCorruptionError,
  WorkflowRunStorageError,
  WorkflowRunStore,
} from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const dirs: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("WorkflowRunStore", () => {
  it("exposes a stable storage-exhaustion error envelope", () => {
    const error = new WorkflowRunStorageError("run", {
      code: "ENOSPC",
    });
    expect(error.code).toBe("ENOSPC");
    expect(error.runId).toBe("run");
    expect(error.message).toContain("could not be persisted");
  });

  it("surfaces malformed committed event data as corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "corrupt",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await appendFile(
      join(
        root,
        owner.projectKey,
        owner.piSessionId,
        "runs",
        "corrupt",
        "events.ndjson",
      ),
      "{not-json}\n",
    );

    await expect(store.readRun("corrupt")).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it("prunes only bounded terminal runs and retains active runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "old-terminal",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("old-terminal", "run_terminal", {
      result: { status: "done" },
    });
    await store.append("old-terminal", "delivery_intent", {
      deliveryId: workflowDeliveryId("old-terminal"),
      kind: "terminal",
      message: "Workflow old-terminal done",
    });
    await store.append("old-terminal", "delivery_dispatched", {
      deliveryId: workflowDeliveryId("old-terminal"),
    });
    await store.append("old-terminal", "delivery_receipt", {
      deliveryId: workflowDeliveryId("old-terminal"),
    });
    await store.createRun({
      runId: "active",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.createRun({
      runId: "undelivered-terminal",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("undelivered-terminal", "run_terminal", {
      result: { status: "done" },
    });
    for (const [runId, event] of [
      ["blocked", "run_blocked"],
      ["approval-pending", "approval_requested"],
      ["interrupted", "run_interrupted"],
    ] as const) {
      await store.createRun({
        runId,
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      });
      await store.append(runId, event, {});
    }

    await expect(
      store.pruneTerminalRuns({ olderThanMs: 0, maxRuns: 1 }),
    ).resolves.toEqual(["old-terminal"]);
    await expect(store.readRun("old-terminal")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.readRun("active")).resolves.toBeDefined();
    await expect(store.readRun("undelivered-terminal")).resolves.toBeDefined();
    await expect(store.readRun("blocked")).resolves.toBeDefined();
    await expect(store.readRun("approval-pending")).resolves.toBeDefined();
    await expect(store.readRun("interrupted")).resolves.toBeDefined();
  });

  it("uses byte offsets and complete-line ordinals for unicode events", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    const first = await store.append("run", "task_started", { prompt: "é" });
    const second = await store.append("run", "task_done", { ok: true });
    expect(first.eventOrdinal).toBe(0);
    expect(second.eventOrdinal).toBe(1);
    expect(second.startByte).toBe(first.endByte);
    expect(second.startByte).toBeGreaterThan(
      JSON.stringify({ prompt: "é" }).length,
    );
  });

  it("ignores an incomplete final line during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "task_done", { ok: true });
    await appendFile(
      join(root, "project", "session", "runs", "run", "events.ndjson"),
      '{"torn":',
    );

    const record = await store.readRun("run");
    expect(record.events).toHaveLength(1);
  });

  it("enumerates runs safely and reports a torn tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "z-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.createRun({
      runId: "a-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("a-run", "task_done", { ok: true });
    await appendFile(
      join(root, "project", "session", "runs", "a-run", "events.ndjson"),
      "torn",
    );

    expect(await store.listRunIds()).toEqual(["a-run", "z-run"]);
    const log = await store.readEventLog("a-run");
    expect(log.events).toHaveLength(1);
    expect(log.tornTailBytes).toBe(4);
    expect(log.completeBytes + log.tornTailBytes).toBeGreaterThan(0);
  });

  it("truncates a torn tail before appending the next event", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    const first = await store.append("run", "task_done", { ok: true });
    await appendFile(
      join(root, "project", "session", "runs", "run", "events.ndjson"),
      '{"torn":',
    );

    const second = await store.append("run", "run_done", { ok: true });
    expect(second.startByte).toBe(first.endByte);
    expect(second.eventOrdinal).toBe(1);
    expect((await store.readRun("run")).events).toHaveLength(2);
    expect((await store.readEventLog("run")).tornTailBytes).toBe(0);
  });

  it("rejects stale epochs while allowing repeated events in the current epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    await store.append("run", "run_started", {}, 2);
    await store.append("run", "task_started", {}, 2);
    await expect(store.append("run", "stale", {}, 1)).rejects.toThrow(
      "stale run epoch",
    );
    await store.append("run", "run_resumed", {}, 3);
    await expect(store.append("run", "stale", {}, 2)).rejects.toThrow(
      "stale run epoch",
    );
  });

  it("rejects appends from a different live owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    const staleStore = new WorkflowRunStore({
      rootDir: root,
      owner: { ...owner, leaseToken: "stale-lease" },
    });

    await expect(staleStore.append("run", "run_started", {})).rejects.toThrow(
      "different owner",
    );
    expect((await store.readRun("run")).events).toHaveLength(0);
  });

  it("rejects invalid durable run IDs before creating storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await expect(
      store.createRun({
        runId: "1-invalid",
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      }),
    ).rejects.toThrow("Invalid durable workflow run ID");
  });

  it("rejects appends that exceed the configured event quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({
      rootDir: root,
      owner,
      maxEventBytes: 10,
    });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await expect(store.append("run", "event", {})).rejects.toThrow(
      "event quota",
    );
  });

  it("rejects appends that exceed the configured run byte quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({
      rootDir: root,
      owner,
      maxRunBytes: 10,
    });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await expect(store.append("run", "event", {})).rejects.toThrow(
      "run byte quota",
    );
  });

  it("rejects creating runs beyond the configured count quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner, maxRuns: 1 });
    await store.createRun({
      runId: "first",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await expect(
      store.createRun({
        runId: "second",
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      }),
    ).rejects.toThrow("run count quota");
  });

  it("rejects appends beyond the aggregate owner byte quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({
      rootDir: root,
      owner,
      maxOwnerBytes: 10,
    });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await expect(store.append("run", "event", {})).rejects.toThrow(
      "owner byte quota",
    );
  });

  it("serializes appendIfCurrent across multiple store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);

    const first = new WorkflowRunStore({ rootDir: root, owner });
    const second = new WorkflowRunStore({ rootDir: root, owner });

    await first.createRun({
      runId: "shared-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    const results = await Promise.all([
      first.appendIfCurrent("shared-run", -1, "task_started", {
        phase: "first",
      }),
      second.appendIfCurrent("shared-run", -1, "task_started", {
        phase: "second",
      }),
    ]);

    const appended = results.filter(
      (result) => result.status === "appended",
    ).length;
    const conflicted = results.filter(
      (result) => result.status === "conflict",
    ).length;

    expect(appended).toBe(1);
    expect(conflicted).toBe(1);

    const runRecord = await first.readRun("shared-run");
    expect(runRecord.events).toHaveLength(1);
  });
});

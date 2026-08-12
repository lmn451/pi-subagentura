import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowRunStore,
  WorkflowRunStoreError,
  deriveDurableWorkflowOwner,
  type WorkflowRunJournal,
} from "../src/workflow-run-store";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowRunCreatedEvent,
  type WorkflowRunInterruptedEvent,
  type WorkflowRunTerminalEvent,
} from "../src/workflow-run-types";

const ROOT_DIGEST = createWorkflowDefinitionDigest("a".repeat(64));
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costUsd: 0,
  turns: 0,
} as const;

function eventEpoch(journal: WorkflowRunJournal): number {
  if (journal.runEpoch === undefined) {
    throw new Error("test requires a leased journal");
  }
  return journal.runEpoch;
}

function runCreatedEvent(
  journal: WorkflowRunJournal,
  owner: DurableWorkflowOwner,
  eventId = "created",
  sequence = 1,
): WorkflowRunCreatedEvent {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    runId: journal.runId,
    runEpoch: eventEpoch(journal),
    sequence,
    type: "run_created",
    payload: {
      durableOwner: owner,
      executionKind: "plan",
      rootDefinitionPath: createWorkflowDefinitionPath("root"),
      rootDefinitionDigest: ROOT_DIGEST,
      resumePolicy: "trusted_resume",
    },
  };
}

function interruptedEvent(
  journal: WorkflowRunJournal,
  eventId: string,
  sequence: number,
  reason:
    "reload" | "quit" | "process_crash" | "owner_replaced" = "process_crash",
): WorkflowRunInterruptedEvent {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId,
    runId: journal.runId,
    runEpoch: eventEpoch(journal),
    sequence,
    type: "run_interrupted",
    payload: { reason },
  };
}

function terminalEvent(
  journal: WorkflowRunJournal,
  sequence: number,
): WorkflowRunTerminalEvent {
  return {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId: "terminal",
    runId: journal.runId,
    runEpoch: eventEpoch(journal),
    sequence,
    type: "run_terminal",
    payload: {
      status: "done",
      accounting: { completeness: "exact", usage: ZERO_USAGE },
    },
  };
}

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

describe("WorkflowRunStore", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let store: WorkflowRunStore;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-run-store-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-session-a");
    store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 101, processStartIdentity: "process-a" },
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("derives canonical owner keys and hashes unsafe session IDs", async () => {
    const canonical = await deriveDurableWorkflowOwner(cwd, "portable-session");
    const unsafe = await deriveDurableWorkflowOwner(cwd, "../../not/a/path");
    const otherProject = join(home, "other-project");
    mkdirSync(otherProject);
    const other = await deriveDurableWorkflowOwner(
      otherProject,
      "portable-session",
    );

    expect(canonical.projectKey).toMatch(/^[a-f0-9]{64}$/);
    expect(canonical.piSessionKey).toBe("portable-session");
    expect(unsafe.piSessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(unsafe.piSessionKey).not.toContain("..");
    expect(other.projectKey).not.toBe(canonical.projectKey);
  });

  it("hashes valid session IDs that exceed a portable path component", async () => {
    const rawSessionId = "s".repeat(256);
    const portable = await deriveDurableWorkflowOwner(cwd, rawSessionId);

    expect(portable.piSessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(
      Buffer.byteLength(portable.piSessionKey, "utf8"),
    ).toBeLessThanOrEqual(255);
    const lease = await store.acquireLease(portable, {
      scopeId: 2,
      generation: 1,
    });
    expect(
      existsSync(
        join(store.rootDirectory, portable.projectKey, portable.piSessionKey),
      ),
    ).toBe(true);
    await lease.release();
  });

  it("creates the owner layout with private modes and no-replace runs", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 2,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("layout");
    const journal = await lease.createRun({
      runId,
      launch: { plan: "layout" },
    });
    await journal.append(runCreatedEvent(journal, owner));

    const directory = runDirectory(home, owner, runId);
    const directories = [
      join(home, ".pi-subagentura"),
      join(home, ".pi-subagentura", "workflow-runs"),
      store.rootDirectory,
      join(store.rootDirectory, owner.projectKey),
      join(store.rootDirectory, owner.projectKey, owner.piSessionKey),
      join(store.rootDirectory, owner.projectKey, owner.piSessionKey, "runs"),
      directory,
      join(directory, "definitions"),
      join(directory, "outputs"),
    ];
    for (const path of directories) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    for (const path of [
      join(
        store.rootDirectory,
        owner.projectKey,
        owner.piSessionKey,
        "owner-lease.json",
      ),
      join(directory, "launch.json"),
      join(directory, "events.ndjson"),
    ]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    await expect(
      lease.createRun({ runId, launch: { replacement: true } }),
    ).rejects.toMatchObject({ code: "run_exists" });
    expect(
      JSON.parse(readFileSync(join(directory, "launch.json"), "utf8")),
    ).toMatchObject({
      launch: { plan: "layout" },
    });
  });

  it("isolates projects and Pi sessions while allowing the same run ID", async () => {
    const sameRunId = createDurableWorkflowRunId("isolated");
    const secondOwner = await store.deriveOwner(cwd, "pi-session-b");
    const firstLease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const secondLease = await store.acquireLease(secondOwner, {
      scopeId: 1,
      generation: 1,
    });
    await firstLease.createRun({ runId: sameRunId, launch: { owner: "a" } });
    await secondLease.createRun({ runId: sameRunId, launch: { owner: "b" } });

    expect(runDirectory(home, owner, sameRunId)).not.toBe(
      runDirectory(home, secondOwner, sameRunId),
    );
    expect(existsSync(runDirectory(home, owner, sameRunId))).toBe(true);
    expect(existsSync(runDirectory(home, secondOwner, sameRunId))).toBe(true);
  });

  it("rejects traversal IDs and never follows a run-directory symlink", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    await expect(
      lease.createRun({
        runId: "wfr-v1-../../escape" as DurableWorkflowRunId,
        launch: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_run_id" });

    const linkedRunId = createDurableWorkflowRunId("linked");
    const outside = join(home, "outside");
    mkdirSync(outside);
    const linkedPath = runDirectory(home, owner, linkedRunId);
    symlinkSync(outside, linkedPath, "dir");
    await expect(
      lease.createRun({ runId: linkedRunId, launch: { unsafe: true } }),
    ).rejects.toBeInstanceOf(WorkflowRunStoreError);
    expect(existsSync(join(outside, "launch.json"))).toBe(false);
  });

  it("returns complete-line byte receipts and preserves physical append order", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("receipts");
    const journal = await lease.createRun({ runId, launch: {} });
    const first = await journal.append(runCreatedEvent(journal, owner));
    const second = await journal.append(
      interruptedEvent(journal, "second", 2, "reload"),
    );
    const third = await journal.append(
      interruptedEvent(journal, "third", 3, "quit"),
    );

    expect(first.byteStart).toBe(0);
    expect(first.byteEndExclusive).toBe(second.byteStart);
    expect(second.byteEndExclusive).toBe(third.byteStart);
    expect(first.lineDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await journal.readEvents()).map((event) => event.eventId)).toEqual([
      "created",
      "second",
      "third",
    ]);
    expect(statSync(runDirectory(home, owner, runId)).isDirectory()).toBe(true);
  });

  it("ignores a torn tail and repairs it only while appending under the fence", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("torn-tail");
    const journal = await lease.createRun({ runId, launch: {} });
    const first = await journal.append(runCreatedEvent(journal, owner));
    const eventsPath = join(runDirectory(home, owner, runId), "events.ndjson");
    appendFileSync(eventsPath, '{"partial":true');

    const before = await journal.readEventLog();
    expect(before.events).toHaveLength(1);
    expect(before.completeBytes).toBe(first.byteEndExclusive);
    expect(before.tornTailBytes).toBeGreaterThan(0);

    const receipt = await journal.append(
      interruptedEvent(journal, "after-tail", 2),
    );
    expect(receipt.byteStart).toBe(first.byteEndExclusive);
    expect((await journal.readEventLog()).tornTailBytes).toBe(0);
    expect(readFileSync(eventsPath, "utf8")).not.toContain("partial");
  });

  it("fails closed on malformed complete authoritative lines", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("malformed");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(runCreatedEvent(journal, owner));
    appendFileSync(
      join(runDirectory(home, owner, runId), "events.ndjson"),
      "{}\n",
    );

    await expect(journal.readEvents()).rejects.toMatchObject({
      code: "malformed_complete_line",
    });
    await expect(
      journal.append(interruptedEvent(journal, "not-appended", 2)),
    ).rejects.toMatchObject({ code: "malformed_complete_line" });
  });

  it("writes immutable canonical blobs and detects size and hash mismatches", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("blobs");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(runCreatedEvent(journal, owner));

    const definition = await journal.writeDefinition("export default 42;\n");
    expect(await journal.readDefinition(definition)).toBe(
      "export default 42;\n",
    );
    const output = await journal.writeOutput({ z: 2, a: 1 });
    expect(await journal.readOutput(output)).toEqual({ a: 1, z: 2 });
    const outputPath = join(
      runDirectory(home, owner, runId),
      "outputs",
      `${output.sha256}.json`,
    );
    expect(readFileSync(outputPath, "utf8")).toBe('{"a":1,"z":2}');
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);

    writeFileSync(outputPath, Buffer.alloc(output.sizeBytes, 0x20));
    await expect(journal.readOutput(output)).rejects.toMatchObject({
      code: "hash_mismatch",
    });
    await expect(
      journal.readOutput({ ...output, sizeBytes: output.sizeBytes + 1 }),
    ).rejects.toMatchObject({ code: "size_mismatch" });
  });

  it("atomically replaces disposable state and publishes one immutable bound result", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("result");
    const journal = await lease.createRun({ runId, launch: {} });
    await journal.append(runCreatedEvent(journal, owner));
    await journal.writeState({ revision: 1 });
    await journal.writeState({ revision: 2 });
    expect(await journal.readState()).toEqual({ revision: 2 });

    const resultBlob = await journal.writeOutput({ answer: 42 });
    const terminalReceipt = await journal.append(terminalEvent(journal, 2));
    const result = await journal.writeResult({
      terminalEventId: "terminal",
      baseEventByteEndExclusive: terminalReceipt.byteEndExclusive,
      result: resultBlob,
    });
    expect(await journal.readResult()).toEqual(result);
    await expect(
      journal.writeResult({
        terminalEventId: "terminal",
        baseEventByteEndExclusive: terminalReceipt.byteEndExclusive,
        result: resultBlob,
      }),
    ).rejects.toMatchObject({ code: "result_exists" });
  });

  it("does not acknowledge an append whose file sync fails", async () => {
    let failEventSync = false;
    const failingStore = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 201, processStartIdentity: "sync-process" },
      sync: {
        file: async (handle, purpose) => {
          await handle.sync();
          if (failEventSync && purpose === "events") {
            throw new Error("injected event fsync failure");
          }
        },
      },
    });
    const syncOwner = await failingStore.deriveOwner(cwd, "sync-session");
    const lease = await failingStore.acquireLease(syncOwner, {
      scopeId: 1,
      generation: 1,
    });
    const journal = await lease.createRun({
      runId: createDurableWorkflowRunId("sync-failure"),
      launch: {},
    });
    failEventSync = true;

    await expect(
      journal.append(runCreatedEvent(journal, syncOwner)),
    ).rejects.toThrow("injected event fsync failure");
  });

  it("rejects insecure persisted file substitutions", async () => {
    const lease = await store.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const runId = createDurableWorkflowRunId("file-symlink");
    const journal = await lease.createRun({ runId, launch: {} });
    const eventsPath = join(runDirectory(home, owner, runId), "events.ndjson");
    const outside = join(home, "outside-events");
    writeFileSync(outside, "");
    rmSync(eventsPath);
    symlinkSync(outside, eventsPath);
    chmodSync(outside, 0o600);

    await expect(journal.readEvents()).rejects.toMatchObject({
      code: "symlink_rejected",
    });
  });
});

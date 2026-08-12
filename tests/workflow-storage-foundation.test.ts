import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  runDurableWorkflowPlan,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import {
  WorkflowRunCorruptionError,
  WorkflowRunQuotaError,
  WorkflowRunStorageError,
  WorkflowRunStore,
  workflowRunPath,
} from "../src/workflow-run-store";
import { WorkflowNamespaceLease } from "../src/workflow-lease";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

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
  output: "done",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
});

async function makeStore(runId = "run"): Promise<{
  root: string;
  store: WorkflowRunStore;
  eventsPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
  roots.push(root);
  const store = new WorkflowRunStore({ rootDir: root, owner });
  await store.createRun({
    runId,
    planRevision: 1,
    resumePolicy: "manual",
    owner,
  });
  return {
    root,
    store,
    eventsPath: join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      runId,
      "events.ndjson",
    ),
  };
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workflow storage foundation", () => {
  it("F01 leaves no dispatchable run when creation fails before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const runAgent = vi.fn(async () => success());
    const originalAssert = (store as any).assertRegularDirectory.bind(store);
    vi.spyOn(store as any, "assertRegularDirectory").mockImplementation(
      async (...args: unknown[]) => {
        const path = String(args[0]);
        if (path.includes(".creating-"))
          throw new Error("injected creation failure before publication");
        return originalAssert(path);
      },
    );

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "before-publication",
        plan: {
          schemaVersion: 1,
          name: "before-publication",
          phases: [
            {
              id: "phase",
              mode: "sequential",
              tasks: [{ id: "task", prompt: "prompt" }],
            },
          ],
        },
        runAgent,
      }),
    ).rejects.toThrow("before publication");

    expect(runAgent).not.toHaveBeenCalled();
    await expect(store.listRunIds()).resolves.toEqual([]);
  });

  it("F01 keeps a complete immutable prefix when publication fails after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const runAgent = vi.fn(async () => success());
    const originalAssert = (store as any).assertRegularDirectory.bind(store);
    let injected = false;
    vi.spyOn(store as any, "assertRegularDirectory").mockImplementation(
      async (...args: unknown[]) => {
        const path = String(args[0]);
        if (!injected && path.endsWith(join("runs", "after-publication"))) {
          injected = true;
          throw new Error("injected post-publication failure");
        }
        return originalAssert(path);
      },
    );
    const plan = {
      schemaVersion: 1 as const,
      name: "after-publication",
      phases: [
        {
          id: "phase",
          mode: "sequential" as const,
          tasks: [{ id: "task", prompt: "prompt" }],
        },
      ],
    };

    await expect(
      store.createRunWithInitialEvent(
        {
          runId: "after-publication",
          planRevision: plan.schemaVersion,
          resumePolicy: "manual",
          owner,
        },
        { type: "run_created", payload: { plan } },
      ),
    ).rejects.toThrow("post-publication");

    vi.restoreAllMocks();
    const published = await store.readRun("after-publication");
    expect(published.events).toHaveLength(1);
    expect(published.events[0]).toMatchObject({
      type: "run_created",
      eventOrdinal: 0,
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("F01 publishes run_created before run_started and dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const runAgent = vi.fn(async () => success());
    const originalAppend = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation(async (...args: any[]) => {
      if (args[1] === "run_started")
        throw new Error("injected failure before run_started");
      return (originalAppend as any)(...args);
    });

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "before-run-started",
        plan: {
          schemaVersion: 1,
          name: "before-run-started",
          phases: [
            {
              id: "phase",
              mode: "sequential",
              tasks: [{ id: "task", prompt: "prompt" }],
            },
          ],
        },
        runAgent,
      }),
    ).rejects.toThrow("before run_started");

    expect(runAgent).not.toHaveBeenCalled();
    await expect(store.readRun("before-run-started")).resolves.toMatchObject({
      events: [{ type: "run_created", eventOrdinal: 0 }],
    });
  });

  it("F01 removes a private prefix when event publication fails before rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const originalAssert = (store as any).assertRegularDirectory.bind(store);
    vi.spyOn(store as any, "assertRegularDirectory").mockImplementation(
      async (...args: unknown[]) => {
        const path = String(args[0]);
        if (path === join(root, owner.projectKey, owner.piSessionId, "runs"))
          throw new Error("injected failure after event publication");
        return originalAssert(path);
      },
    );

    await expect(
      store.createRunWithInitialEvent(
        {
          runId: "before-rename",
          planRevision: 1,
          resumePolicy: "manual",
          owner,
        },
        { type: "run_created", payload: { plan: { schemaVersion: 1 } } },
      ),
    ).rejects.toThrow("after event publication");
    await expect(store.listRunIds()).resolves.toEqual([]);
  });

  it("publishes launch and run_created as one durable creation prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const createRun = vi.spyOn(store, "createRun");

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "atomic-run",
      plan: {
        schemaVersion: 1,
        name: "atomic",
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [
              {
                id: "task",
                prompt: "prompt",
                label: "label",
                isolation: "in-process",
                input: { count: 1, values: ["a", true] },
              },
            ],
          },
        ],
      },
      runAgent: async () => success(),
    });

    expect(createRun).not.toHaveBeenCalled();
    const record = await store.readRun("atomic-run");
    expect(record.events[0]).toMatchObject({
      runId: "atomic-run",
      type: "run_created",
    });
    expect(record.events[0].payload).toEqual({
      plan: {
        schemaVersion: 1,
        name: "atomic",
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [
              {
                id: "task",
                prompt: "prompt",
                label: "label",
                isolation: "in-process",
                input: { count: 1, values: ["a", true] },
              },
            ],
          },
        ],
      },
    });
    expect(
      (
        await readFile(
          join(
            root,
            owner.projectKey,
            owner.piSessionId,
            "runs",
            "atomic-run",
            "events.ndjson",
          ),
          "utf8",
        )
      ).startsWith("{"),
    ).toBe(true);
  });

  it("rejects executable values in a creation plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const unsafePlan = {
      schemaVersion: 1,
      name: "unsafe",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: [
            {
              id: "task",
              prompt: (() => "not declarative") as unknown as string,
            },
          ],
        },
      ],
    };

    await expect(
      store.createRunWithInitialEvent(
        {
          runId: "unsafe-run",
          planRevision: 1,
          resumePolicy: "manual",
          owner,
        },
        { type: "run_created", payload: { plan: unsafePlan } },
      ),
    ).rejects.toThrow();
    await expect(store.listRunIds()).resolves.toEqual([]);
  });

  it.each([
    [
      "wrong run ID",
      (lines: Record<string, unknown>[]) => {
        lines[0].runId = "other";
      },
    ],
    [
      "duplicate event ID",
      (lines: Record<string, unknown>[]) => {
        lines[1].eventId = lines[0].eventId;
      },
    ],
    [
      "non-monotonic event ordinal",
      (lines: Record<string, unknown>[]) => {
        lines[1].eventOrdinal = lines[0].eventOrdinal;
      },
    ],
  ])("rejects %s in a committed journal", async (_label, mutate) => {
    const { store, eventsPath } = await makeStore();
    await store.append("run", "first", {});
    await store.append("run", "second", {});
    const lines = await readLines(eventsPath);
    mutate(lines);
    await writeFile(
      eventsPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    await expect(store.readRun("run")).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it("rejects a blank interior journal record", async () => {
    const { store, eventsPath } = await makeStore();
    await store.append("run", "first", {});
    await store.append("run", "second", {});
    const lines = await readFile(eventsPath, "utf8");
    const [first, second] = lines.trimEnd().split("\n");
    await writeFile(eventsPath, `${first}\n\n${second}\n`);

    await expect(store.readRun("run")).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it("rejects a symlinked final journal target", async () => {
    const { store, root, eventsPath } = await makeStore();
    const outside = join(root, "outside-events.ndjson");
    await writeFile(outside, "");
    await rm(eventsPath);
    await symlink(outside, eventsPath);

    await expect(store.append("run", "blocked", {})).rejects.toThrow(
      "not regular",
    );
    await expect(readFile(outside, "utf8")).resolves.toBe("");
  });

  it("F05 rejects a symlinked final launch target", async () => {
    const { store, root } = await makeStore("symlink-launch");
    const launchPath = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "symlink-launch",
      "launch.json",
    );
    const outside = join(root, "outside-launch.json");
    const launch = await readFile(launchPath);
    await writeFile(outside, launch);
    await rm(launchPath);
    await symlink(outside, launchPath);

    await expect(store.readRun("symlink-launch")).rejects.toThrow("corrupt");
    await expect(readFile(outside)).resolves.toEqual(launch);
  });

  it("F05 rejects lexical run-id escapes before constructing final targets", async () => {
    for (const runId of ["../escape", "nested/run", "nested\\run"]) {
      expect(() => workflowRunPath("/tmp/workflows", owner, runId)).toThrow(
        "Invalid durable workflow run ID",
      );
    }
  });

  it.each(["launch.json", "events.ndjson"])(
    "F05 rejects hardlinked final target %s without changing its outside inode",
    async (fileName) => {
      const runId = `hardlink-${fileName === "launch.json" ? "launch" : "events"}`;
      const { store, root, eventsPath } = await makeStore(runId);
      const target = join(dirname(eventsPath), fileName);
      const outside = join(root, `outside-${fileName}`);
      const original = await readFile(target);
      await writeFile(outside, original);
      await rm(target);
      await link(outside, target);

      const operation =
        fileName === "launch.json"
          ? store.readRun(runId)
          : store.append(runId, "blocked", {});
      await expect(operation).rejects.toThrow(
        fileName === "launch.json" ? "corrupt" : "not regular",
      );
      await expect(readFile(outside)).resolves.toEqual(original);
    },
  );

  it.each(["launch.json", "events.ndjson"])(
    "F05 rejects non-regular final target %s",
    async (fileName) => {
      const runId = `nonregular-${fileName === "launch.json" ? "launch" : "events"}`;
      const { store, eventsPath } = await makeStore(runId);
      const target = join(dirname(eventsPath), fileName);
      await rm(target);
      await mkdir(target);

      const operation =
        fileName === "launch.json"
          ? store.readRun(runId)
          : store.append(runId, "blocked", {});
      await expect(operation).rejects.toThrow(
        fileName === "launch.json" ? "corrupt" : "not regular",
      );
    },
  );

  it("F05 rejects an inode replacement after opening the final journal", async () => {
    const { store, root, eventsPath } = await makeStore("inode-replacement");
    const committed = await readFile(eventsPath);
    const replacement = join(root, "replacement-events.ndjson");
    const originalAssert = (store as any).assertOpenFileTarget.bind(store);
    let checks = 0;
    vi.spyOn(store as any, "assertOpenFileTarget").mockImplementation(
      async (...args: unknown[]) => {
        const file = args[0];
        const path = String(args[1]);
        checks++;
        if (checks === 2) {
          await rename(eventsPath, replacement);
          await writeFile(eventsPath, "replacement\n");
        }
        return originalAssert(file, path);
      },
    );

    await expect(
      store.append("inode-replacement", "blocked", {}),
    ).rejects.toThrow("target changed");
    await expect(readFile(replacement)).resolves.toEqual(committed);
    await expect(readFile(eventsPath, "utf8")).resolves.toBe("replacement\n");
  });

  it("repairs one torn suffix while holding storage authority", async () => {
    const { store, eventsPath } = await makeStore();
    await store.append("run", "first", {});
    await writeFile(eventsPath, `${await readFile(eventsPath, "utf8")}torn`);

    await expect(store.readRun("run")).resolves.toMatchObject({
      events: [{ type: "first" }],
    });
    await expect(readFile(eventsPath, "utf8")).resolves.not.toContain("torn");
  });

  it("does not prune a terminal run for an unrelated delivery receipt", async () => {
    const { store, root } = await makeStore("terminal-run");
    const launchPath = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "terminal-run",
      "launch.json",
    );
    const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
      createdAt: number;
    };
    launch.createdAt = 0;
    await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
    await store.append("terminal-run", "run_terminal", {
      result: { status: "done", result: "ok" },
    });
    await store.append("terminal-run", "delivery_receipt", {
      deliveryId: "not-the-terminal-delivery",
    });

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).resolves.toEqual(
      [],
    );
    await expect(store.readRun("terminal-run")).resolves.toBeDefined();
  });

  it("does not prune a terminal run with an interrupted post-terminal prefix", async () => {
    const { store, root } = await makeStore("interrupted-run");
    const launchPath = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "interrupted-run",
      "launch.json",
    );
    const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
      createdAt: number;
    };
    launch.createdAt = 0;
    await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
    await store.append("interrupted-run", "run_terminal", {
      result: { status: "done", result: "ok" },
    });
    await store.append("interrupted-run", "run_interrupted", {});
    await store.append("interrupted-run", "delivery_receipt", {
      deliveryId: workflowDeliveryId("interrupted-run"),
    });

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).resolves.toEqual(
      [],
    );
  });

  it("does not prune a blocked non-terminal run", async () => {
    const { store, root } = await makeStore("blocked-run");
    const launchPath = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "blocked-run",
      "launch.json",
    );
    const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
      createdAt: number;
    };
    launch.createdAt = 0;
    await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
    await store.append("blocked-run", "run_started", {});
    await store.append("blocked-run", "task_blocked", {
      taskId: "task",
      reason: "approval",
    });

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).resolves.toEqual(
      [],
    );
  });

  it("requires the matching intent and dispatch prefix before deleting a receipt", async () => {
    const { store, root } = await makeStore("prefix-run");
    const launchPath = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "prefix-run",
      "launch.json",
    );
    const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
      createdAt: number;
    };
    launch.createdAt = 0;
    await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
    await store.append("prefix-run", "run_terminal", {
      result: { status: "done", result: "ok" },
    });
    await store.append("prefix-run", "delivery_receipt", {
      deliveryId: workflowDeliveryId("prefix-run"),
    });

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).resolves.toEqual(
      [],
    );
  });

  it("requires the deterministic terminal delivery receipt before pruning", async () => {
    const { store, root } = await makeStore("delivered-run");
    const launchPath = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "delivered-run",
      "launch.json",
    );
    const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
      createdAt: number;
    };
    launch.createdAt = 0;
    await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
    await store.append("delivered-run", "run_terminal", {
      result: { status: "done", result: "ok" },
    });
    await store.append("delivered-run", "delivery_intent", {
      deliveryId: workflowDeliveryId("delivered-run"),
      kind: "terminal",
      message: "Workflow delivered-run done",
    });
    await store.append("delivered-run", "delivery_dispatched", {
      deliveryId: workflowDeliveryId("delivered-run"),
    });
    await store.append("delivered-run", "delivery_receipt", {
      deliveryId: workflowDeliveryId("delivered-run"),
    });

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).resolves.toEqual([
      "delivered-run",
    ]);
    await expect(store.readRun("delivered-run")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a run-directory symlink before opening its journal", async () => {
    const { store, root, eventsPath } = await makeStore();
    const runDir = join(
      root,
      owner.projectKey,
      owner.piSessionId,
      "runs",
      "run",
    );
    const outside = join(root, "outside-run");
    await mkdir(outside);
    await writeFile(
      join(outside, "launch.json"),
      await readFile(join(runDir, "launch.json")),
    );
    await writeFile(join(outside, "events.ndjson"), "");
    await rm(runDir, { recursive: true });
    await symlink(outside, runDir);

    await expect(store.append("run", "blocked", {})).rejects.toThrow(
      "not a directory",
    );
    await expect(
      readFile(join(outside, "events.ndjson"), "utf8"),
    ).resolves.toBe("");
  });

  it("repairs an invalid-UTF-8 final suffix as a torn tail", async () => {
    const { store, eventsPath } = await makeStore();
    await store.append("run", "first", {});
    const committed = await readFile(eventsPath);
    await writeFile(
      eventsPath,
      Buffer.concat([committed, Buffer.from([0xff, 0xfe])]),
    );

    await expect(store.readRun("run")).resolves.toMatchObject({
      events: [{ type: "first" }],
    });
    await expect(readFile(eventsPath)).resolves.toEqual(committed);
  });

  it("rejects invalid UTF-8 in a committed journal record", async () => {
    const { store, eventsPath } = await makeStore();
    await store.append("run", "first", {});
    const committed = await readFile(eventsPath);
    const newline = committed.indexOf(0x0a);
    const corrupted = Buffer.concat([
      committed.subarray(0, newline),
      Buffer.from([0xff]),
      committed.subarray(newline),
    ]);
    await writeFile(eventsPath, corrupted);

    await expect(store.readRun("run")).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it.each(["task_started", "run_blocked", "run_interrupted"])(
    "does not prune a run with post-terminal %s activity",
    async (type) => {
      const { store, root } = await makeStore("post-terminal-run");
      const launchPath = join(
        root,
        owner.projectKey,
        owner.piSessionId,
        "runs",
        "post-terminal-run",
        "launch.json",
      );
      const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
        createdAt: number;
      };
      launch.createdAt = 0;
      await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
      await store.append("post-terminal-run", "run_terminal", {
        result: { status: "done", result: "ok" },
      });
      await store.append("post-terminal-run", "delivery_receipt", {
        deliveryId: workflowDeliveryId("post-terminal-run"),
      });
      await store.append("post-terminal-run", type, {
        taskId: "late-task",
      });

      await expect(
        store.pruneTerminalRuns({ olderThanMs: 0 }),
      ).resolves.toEqual([]);
      await expect(store.readRun("post-terminal-run")).resolves.toBeDefined();
    },
  );

  it("sweeps only old, well-formed creation directories during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    const runsDir = join(root, owner.projectKey, owner.piSessionId, "runs");
    await mkdir(runsDir, { recursive: true });
    const stale = join(
      runsDir,
      ".creating-stale-run-550e8400-e29b-41d4-a716-446655440000",
    );
    const recent = join(
      runsDir,
      ".creating-recent-run-550e8400-e29b-41d4-a716-446655440001",
    );
    const malformed = join(runsDir, ".creating-not-a-run");
    await Promise.all([mkdir(stale), mkdir(recent), mkdir(malformed)]);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);

    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "fresh-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    const names = await readdir(runsDir);
    expect(names).not.toContain(
      ".creating-stale-run-550e8400-e29b-41d4-a716-446655440000",
    );
    expect(names).toContain(
      ".creating-recent-run-550e8400-e29b-41d4-a716-446655440001",
    );
    expect(names).toContain(".creating-not-a-run");
  });

  it("holds the lease interlock across a mutation and preserves replacement ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
    roots.push(root);
    let now = 0;
    const oldLease = new WorkflowNamespaceLease({
      rootDir: root,
      namespace: "namespace",
      ownerId: "old-owner",
      leaseToken: "old-token",
      staleAfterMs: 10,
      now: () => now,
      processId: 999999,
    });
    const newLease = new WorkflowNamespaceLease({
      rootDir: root,
      namespace: "namespace",
      ownerId: "new-owner",
      leaseToken: "new-token",
      staleAfterMs: 10,
      now: () => now,
      processId: process.pid,
      processStartTime: Math.floor(Date.now() - process.uptime() * 1000),
    });
    await oldLease.acquire();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const finishPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mutation = oldLease.withAuthority(async () => {
      entered();
      await finishPromise;
    });
    await enteredPromise;
    now = 100;
    await expect(newLease.acquire()).rejects.toThrow("interlock");
    finish();
    await mutation;

    await expect(newLease.acquire()).resolves.toMatchObject({
      ownerId: "new-owner",
      epoch: 2,
    });
    await oldLease.release();
    await expect(newLease.assertHeld()).resolves.toBeUndefined();
  });

  it("continues after short file-handle writes", async () => {
    const { store, root } = await makeStore();
    const probe = await (
      await import("node:fs/promises")
    ).open(join(root, "short-write-probe"), "w+");
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...args: any[]) => Promise<any>;
    };
    await probe.close();
    const originalWrite = prototype.write;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: unknown,
      ...args: any[]
    ) {
      if (Buffer.isBuffer(args[0]) && typeof args[1] === "number") {
        const length = Math.max(1, Math.min(3, args[2]));
        return originalWrite.call(this, args[0], args[1], length, args[3]);
      }
      return originalWrite.apply(this, args);
    });

    await expect(
      store.append("run", "short_write", { value: "x" }),
    ).resolves.toBeDefined();
    await expect(store.readRun("run")).resolves.toMatchObject({
      events: [{ type: "short_write", payload: { value: "x" } }],
    });
  });

  it("F06 preserves the valid prefix across ENOSPC and quota failures", async () => {
    const { store, eventsPath, root } = await makeStore("storage-faults");
    const prefix = await readFile(eventsPath);
    const probe = await (
      await import("node:fs/promises")
    ).open(join(root, "enospc-probe"), "w+");
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...args: any[]) => Promise<any>;
    };
    await probe.close();
    const originalWrite = prototype.write;
    let injected = true;
    vi.spyOn(prototype, "write").mockImplementation(async function (
      this: unknown,
      ...args: any[]
    ) {
      if (injected && Buffer.isBuffer(args[0]) && typeof args[1] === "number") {
        injected = false;
        const error = new Error("simulated ENOSPC") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
      return originalWrite.apply(this, args);
    });

    await expect(
      store.append("storage-faults", "enospc", {}),
    ).rejects.toBeInstanceOf(WorkflowRunStorageError);
    await expect(readFile(eventsPath)).resolves.toEqual(prefix);

    vi.restoreAllMocks();
    for (const quota of ["event", "run byte", "owner byte"] as const) {
      const quotaRoot = await mkdtemp(join(tmpdir(), "workflow-foundation-"));
      roots.push(quotaRoot);
      const quotaStore = new WorkflowRunStore({
        rootDir: quotaRoot,
        owner,
        ...(quota === "event" ? { maxEventBytes: 1 } : {}),
        ...(quota === "run byte" ? { maxRunBytes: 1 } : {}),
        ...(quota === "owner byte" ? { maxOwnerBytes: 1 } : {}),
      });
      const quotaRunId = `quota-${quota.replace(" ", "-")}`;
      await quotaStore.createRun({
        runId: quotaRunId,
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      });
      await expect(
        quotaStore.append(quotaRunId, "quota", {}),
      ).rejects.toMatchObject({ code: "QUOTA", quota });
      await expect(quotaStore.readRun(quotaRunId)).resolves.toMatchObject({
        events: [],
      });
      await quotaStore.release();
    }
  });

  it("F06 preserves the committed prefix when event fsync fails", async () => {
    const { store, eventsPath, root } = await makeStore("fsync-fault");
    const prefix = await readFile(eventsPath);
    const probe = await (
      await import("node:fs/promises")
    ).open(join(root, "fsync-probe"), "w+");
    const prototype = Object.getPrototypeOf(probe) as {
      sync: (...args: any[]) => Promise<void>;
    };
    await probe.close();
    const originalSync = prototype.sync;
    let injected = true;
    vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: unknown,
      ...args: any[]
    ) {
      if (injected) {
        injected = false;
        throw new Error("simulated fsync failure");
      }
      return originalSync.apply(this, args);
    });

    await expect(
      store.append("fsync-fault", "must_not_commit", {}),
    ).rejects.toThrow("fsync failure");
    await expect(readFile(eventsPath)).resolves.toEqual(prefix);
  });

  it("F06 rejects complete records with schema, unknown-field, and UTF-8 faults", async () => {
    const { store, eventsPath } = await makeStore("record-faults");
    const valid = {
      schemaVersion: 1,
      eventId: "event-0",
      eventOrdinal: 0,
      runId: "record-faults",
      runEpoch: 0,
      type: "run_started",
      payload: {},
    };
    const cases = [
      Buffer.from(`${JSON.stringify({ ...valid, schemaVersion: 2 })}\n`),
      Buffer.from(`${JSON.stringify({ ...valid, unexpected: true })}\n`),
      Buffer.concat([
        Buffer.from(
          '{"schemaVersion":1,"eventId":"event-0","eventOrdinal":0,"runId":"record-faults","runEpoch":0,"type":"run_started","payload":"',
        ),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    ];
    for (const bytes of cases) {
      await writeFile(eventsPath, bytes);
      await expect(store.readRun("record-faults")).rejects.toBeInstanceOf(
        WorkflowRunCorruptionError,
      );
    }
  });

  it("fails closed when the run directory descriptor is replaced before prune", async () => {
    const { store, root } = await makeStore("descriptor-run");
    const runsDir = join(root, owner.projectKey, owner.piSessionId, "runs");
    const runDir = join(runsDir, "descriptor-run");
    const replacement = join(root, "replacement-run");
    await mkdir(replacement);
    await writeFile(join(replacement, "sentinel"), "keep");
    const launchPath = join(runDir, "launch.json");
    const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
      createdAt: number;
    };
    launch.createdAt = 0;
    await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
    await store.append("descriptor-run", "run_terminal", {
      result: { status: "done", result: "ok" },
    });
    await store.append("descriptor-run", "delivery_intent", {
      deliveryId: workflowDeliveryId("descriptor-run"),
      kind: "terminal",
      message: "Workflow descriptor-run done",
    });
    await store.append("descriptor-run", "delivery_dispatched", {
      deliveryId: workflowDeliveryId("descriptor-run"),
    });
    await store.append("descriptor-run", "delivery_receipt", {
      deliveryId: workflowDeliveryId("descriptor-run"),
    });

    const originalAssert = (store as any).assertNamespaceLease.bind(store);
    let calls = 0;
    vi.spyOn(store as any, "assertNamespaceLease").mockImplementation(
      async () => {
        const lease = await originalAssert();
        calls++;
        if (calls === 4) {
          const backup = join(root, "original-run");
          await rename(runDir, backup);
          await rename(replacement, runDir);
        }
        return lease;
      },
    );

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).rejects.toThrow(
      "descriptor changed",
    );
    await expect(
      readFile(join(runsDir, ".tombstone-descriptor-run", "sentinel"), "utf8"),
    ).resolves.toBe("keep");
  });
});

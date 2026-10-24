import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  access,
  mkdir,
  appendFile,
  writeFile,
  readFile,
} from "node:fs/promises";
import { sessionLedgerPath } from "../src/completion-ledger";
import { prepareDurableProcess } from "../src/workflow-durable-process";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  registerDurableWorkflowTools,
  restoreDurableWorkflowRuns,
} from "../src/workflow-durable-tools";
import {
  registerSessionScope,
  sessionOwner,
  clearSessionScopes,
} from "../src/session-scope";
import {
  cleanupWorkflowJobsForOwner,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import {
  registerCompletionCoordinator,
  registerCompletionMember,
  registerRecoveredCompletionMember,
  sealCompletionGroups,
  clearCompletionCoordinator,
  restoreDurableCompletionGroups,
  restoreDurableCompletionGroupsSync,
  publishCompletion,
  prepareCompletionManifest,
} from "../src/completion-coordinator";
import { writeCompletionGroup } from "../src/completion-group-store";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import {
  decodeRunValue,
  encodeRunValue,
  WorkflowRunStore,
} from "../src/workflow-run-store";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "durable-tools-"));
});
afterEach(async () => {
  for (const job of workflowJobRegistry.values()) job.abort.abort();
  await Promise.allSettled(
    [...workflowJobRegistry.values()].map((job) => job.promise),
  );
  workflowJobRegistry.clear();
  clearSessionScopes();
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const entries: any[] = [];
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: vi.fn(),
  };
  const sessionManager = {
    getSessionId: () => "same-parent",
    getSessionDir: () => root,
    getEntries: () => entries,
  };
  const scope = registerSessionScope({
    id: 1,
    generation: 1,
    lifecycle: "started",
    pi,
    cwd: root,
    sessionManager,
  });
  registerCompletionCoordinator(pi, scope);
  const ctx = { cwd: root, sessionManager: scope.sessionManager };
  return { pi, scope, ctx, tools, entries, sessionManager };
}

describe("durable public tools", () => {
  it("commits inherited synchronous cancellation before aborting provider work", async () => {
    const { pi, scope, ctx } = setup();
    const inherited = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let finishProvider!: () => void;
    const providerResult = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const updates: any[] = [];
    let reportCancellationFailure!: () => void;
    const cancellationFailureReported = new Promise<void>((resolve) => {
      reportCancellationFailure = resolve;
    });
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => async ({ signal }) => {
        providerSignal = signal;
        releaseProvider();
        await providerResult;
        if (signal?.aborted) throw new Error("provider aborted");
        return { isError: false, output: "done", usage: zeroUsage() };
      },
      () => true,
      root,
    );
    const execution = api.run(
      {
        script:
          'export const meta={name:"inherited-cancel",description:"d"}; return await agent("wait");',
        async: false,
      },
      inherited.signal,
      (update) => {
        updates.push(update);
        if (JSON.stringify(update).includes("could not be saved"))
          reportCancellationFailure();
      },
      ctx,
    );
    await providerStarted;
    const job = [...workflowJobRegistry.values()].at(-1)!;
    const originalAppend = WorkflowRunStore.prototype.append;
    const append = vi.spyOn(WorkflowRunStore.prototype, "append");
    append.mockImplementation(async function (kind: any, ...args: any[]) {
      if (kind === "cancelled") throw new Error("private append failure");
      return originalAppend.call(this, kind, ...args);
    });
    inherited.abort();
    await cancellationFailureReported;
    expect(providerSignal?.aborted).toBe(false);
    expect(job.status).toBe("running");
    expect(JSON.stringify(updates)).not.toContain("private append failure");
    append.mockRestore();
    finishProvider();
    await expect(execution).resolves.toMatchObject({
      details: { status: "done" },
    });
  });

  it("does not cancel a committed synchronous result after a late inherited abort", async () => {
    const { pi, scope, ctx } = setup();
    const inherited = new AbortController();
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => vi.fn(),
      () => true,
      root,
    );
    const originalAppend = WorkflowRunStore.prototype.append;
    const append = vi.spyOn(WorkflowRunStore.prototype, "append");
    append.mockImplementation(async function (kind: any, ...args: any[]) {
      const result = await originalAppend.call(this, kind, ...args);
      if (kind === "terminal") inherited.abort();
      return result;
    });
    try {
      const result = await api.run(
        {
          script:
            'export const meta={name:"late-abort",description:"d"}; return "committed";',
          async: false,
        },
        inherited.signal,
        undefined,
        ctx,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const events = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "same-parent", root },
        result.details.workflowId,
      );
      expect(result.details.status).toBe("done");
      expect(result.content[0].text).toBe('"committed"');
      expect(events?.map((event) => event.kind)).toContain("terminal");
      expect(events?.map((event) => event.kind)).not.toContain("cancelled");
      expect(
        (await api.inspect(result.details.workflowId, ctx, true)).content[0]
          .text,
      ).toBe('"committed"');
    } finally {
      append.mockRestore();
    }
  });

  it("keeps synchronous durable input active when inherited cancellation persistence fails", async () => {
    const { pi, scope, ctx } = setup();
    const inherited = new AbortController();
    let inputSignal: AbortSignal | undefined;
    let reportCancellationFailure!: () => void;
    const cancellationFailureReported = new Promise<void>((resolve) => {
      reportCancellationFailure = resolve;
    });
    let startInput!: () => void;
    const inputStarted = new Promise<void>((resolve) => {
      startInput = resolve;
    });
    const runCtx = {
      ...ctx,
      hasUI: true,
      ui: {
        confirm: vi.fn(
          (
            _title: string,
            _summary: string,
            options: { signal?: AbortSignal },
          ) => {
            inputSignal = options.signal;
            startInput();
            return new Promise<boolean>((_resolve, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => reject(new Error("input aborted")),
                { once: true },
              );
            });
          },
        ),
      },
    };
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => vi.fn(),
      () => true,
      root,
    );
    const execution = api.run(
      {
        script: `import { defineWorkflow } from "pi-subagentura/workflow";
          export default defineWorkflow({
            name: "input-cancel", version: 1,
            run: async (ctx) => await ctx.gate("approval", { title: "Approve?" }),
          });`,
        async: false,
      },
      inherited.signal,
      (update) => {
        if (JSON.stringify(update).includes("could not be saved"))
          reportCancellationFailure();
      },
      runCtx,
    );
    await inputStarted;
    const originalAppend = WorkflowRunStore.prototype.append;
    const append = vi.spyOn(WorkflowRunStore.prototype, "append");
    append.mockImplementation(async function (kind: any, ...args: any[]) {
      if (kind === "cancelled") throw new Error("private append failure");
      return originalAppend.call(this, kind, ...args);
    });
    let job: WorkflowJobState | undefined;
    try {
      inherited.abort();
      await cancellationFailureReported;
      expect(inputSignal?.aborted).toBe(false);
      job = [...workflowJobRegistry.values()].at(-1)!;
      expect(job.status).toBe("running");
      append.mockRestore();
      await api.cancel(job.id, runCtx);
      await expect(execution).resolves.toMatchObject({ isError: true });
    } finally {
      append.mockRestore();
      if (job?.status === "running") job.abort.abort();
    }
  });

  it("keeps independent completions deliverable after group recovery fails while holding groups closed", async () => {
    const { scope } = setup();
    const owner = sessionOwner(scope);
    const directory =
      sessionLedgerPath(root, "same-parent", "subagentura-completion-groups") +
      ".groups";
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "a".repeat(64) + ".json"), "broken");
    await expect(restoreDurableCompletionGroups(owner)).rejects.toThrow();
    expect(() =>
      registerCompletionMember(
        "workflow",
        "wfd_group",
        "group",
        "uncertain",
        owner,
      ),
    ).toThrow("Completion group recovery is unavailable");
    sealCompletionGroups(owner);
    const record = (id: string) => ({
      schemaVersion: 1 as const,
      completionId: "workflow:" + id,
      source: "workflow" as const,
      sourceId: id,
      label: id,
      status: "done" as const,
      policy: "each" as const,
      references: [{ label: "result", value: "result" }],
      completedAt: 1,
    });
    publishCompletion(record("independent"), owner);
    const manifest = prepareCompletionManifest(owner);
    expect(manifest).toBeDefined();
    expect(manifest!.details.completionIds).toEqual(["workflow:independent"]);
    await rm(join(directory, "a".repeat(64) + ".json"));
    await restoreDurableCompletionGroups(owner);
    registerCompletionMember(
      "workflow",
      "wfd_group",
      "group",
      "uncertain",
      owner,
    );
    sealCompletionGroups(owner);
    publishCompletion(
      { ...record("wfd_group"), policy: "group", groupId: "uncertain" },
      owner,
    );
    expect(prepareCompletionManifest(owner)!.details.completionIds).toEqual([
      "workflow:wfd_group",
    ]);
    clearCompletionCoordinator(owner);
  });

  it("restores grouped workflow errors while holding safe terminals behind corrupt group state", async () => {
    const { pi, scope, ctx, tools, entries, sessionManager } = setup();
    const owner = sessionOwner(scope);
    scope.parentStreaming = true;
    sessionManager.getEntries = () => [];
    const runScope = { cwd: root, sessionId: "same-parent", root };
    const stores: WorkflowRunStore[] = [];
    const listRuns = WorkflowRunStore.list.bind(WorkflowRunStore);
    const inspectRun = WorkflowRunStore.inspect.bind(WorkflowRunStore);
    const listSpy = vi
      .spyOn(WorkflowRunStore, "list")
      .mockImplementation((requestedScope) =>
        listRuns({ ...requestedScope, root }),
      );
    const inspectSpy = vi
      .spyOn(WorkflowRunStore, "inspect")
      .mockImplementation((requestedScope, id) =>
        inspectRun({ ...requestedScope, root }, id),
      );
    const groupsDirectory =
      sessionLedgerPath(root, "same-parent", "subagentura-completion-groups") +
      ".groups";
    const invalidSnapshotPath = join(groupsDirectory, "a".repeat(64) + ".json");

    try {
      await mkdir(groupsDirectory, { recursive: true });
      await writeFile(invalidSnapshotPath, "broken");
      const persistTerminal = async (
        name: string,
        status: "error" | "done" | "cancelled",
      ) => {
        const store = await WorkflowRunStore.create(runScope, {
          script: `export const meta={name:${JSON.stringify(name)},description:"d"}; return "unused";`,
          args: encodeRunValue(undefined),
          budgetTotal: 100,
        });
        stores.push(store);
        await store.append("accepted", {});
        await store.append("delivery", {
          completion: { policy: "group", groupId: "g" },
        });
        if (status === "cancelled") {
          await store.append("cancelled", {
            status,
            completedAt: Date.now(),
          });
        } else {
          await store.append("terminal", {
            status,
            completedAt: Date.now(),
            ...(status === "error"
              ? { error: "workflow failed" }
              : { result: encodeRunValue({ errorCount: 0 }) }),
          });
        }
        await store.close();
        return store.id;
      };
      const errorId = await persistTerminal("failed", "error");
      const successId = await persistTerminal("successful", "done");
      const cancelledId = await persistTerminal("cancelled", "cancelled");
      writeCompletionGroup(groupsDirectory, {
        groupId: "g",
        members: [
          `workflow:${errorId}`,
          `workflow:${successId}`,
          `workflow:${cancelledId}`,
        ],
        sealed: true,
      });

      expect(prepareCompletionManifest(owner)).toBeUndefined();
      registerWorkflowTool(pi, scope);
      await restoreDurableWorkflowRuns(pi, owner, ctx);

      const manifest = prepareCompletionManifest(owner);
      expect(manifest?.details.completionIds).toEqual([`workflow:${errorId}`]);
      const manifestRecords = manifest!.content
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const errorRecord = manifestRecords.find(
        (record) => record.source === "workflow" && record.sourceId === errorId,
      );
      expect(errorRecord).toMatchObject({
        completionId: `workflow:${errorId}`,
        status: "error",
      });
      expect(
        entries.some(
          (entry) =>
            entry.data?.completionId === `workflow:${errorId}` &&
            entry.data?.groupId === "g",
        ),
      ).toBe(true);
      expect(manifestRecords).not.toContainEqual(
        expect.objectContaining({
          source: "workflow",
          sourceId: successId,
        }),
      );
      expect(manifestRecords).not.toContainEqual(
        expect.objectContaining({
          source: "workflow",
          sourceId: cancelledId,
        }),
      );

      const resultTool = tools.get("get_workflow_result");
      expect(resultTool).toBeDefined();
      const errorResult = await resultTool.execute(
        "result-call",
        { workflowId: errorRecord!.sourceId },
        undefined,
        undefined,
        ctx,
      );
      expect(errorResult.structuredContent).toMatchObject({
        status: "error",
        workflowId: errorId,
        error: "workflow failed",
      });

      await rm(invalidSnapshotPath);
      await restoreDurableCompletionGroups(owner);
      const publishPeer = (sourceId: string, status: "done" | "cancelled") =>
        publishCompletion(
          {
            schemaVersion: 1,
            completionId: `workflow:${sourceId}`,
            source: "workflow",
            sourceId,
            label: sourceId,
            status,
            policy: "group",
            groupId: "g",
            references: [{ label: "result", value: "result" }],
            completedAt: Date.now(),
          },
          owner,
        );
      publishPeer(successId, "done");
      publishPeer(cancelledId, "cancelled");
      const repairedManifest = prepareCompletionManifest(owner);
      expect(repairedManifest?.details.completionIds).toHaveLength(2);
      expect(repairedManifest?.details.completionIds).toEqual(
        expect.arrayContaining([
          `workflow:${successId}`,
          `workflow:${cancelledId}`,
        ]),
      );
      expect(repairedManifest?.details.completionIds).not.toContain(
        `workflow:${errorId}`,
      );
    } finally {
      listSpy.mockRestore();
      inspectSpy.mockRestore();
      clearCompletionCoordinator(owner);
      await Promise.all(stores.map((store) => store.close()));
      await Promise.all(
        stores.map((store) =>
          rm(store.directory, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("counts a blocked error once after sync group recovery validates its membership", async () => {
    const { scope, sessionManager } = setup();
    const owner = sessionOwner(scope);
    sessionManager.getEntries = () => [];
    const directory =
      sessionLedgerPath(root, "same-parent", "subagentura-completion-groups") +
      ".groups";
    const errorId = `wfd_${"1".repeat(32)}`;
    const peerId = `wfd_${"2".repeat(32)}`;
    await mkdir(directory, { recursive: true });
    writeCompletionGroup(directory, {
      groupId: "sync-repair",
      members: [`workflow:${errorId}`, `workflow:${peerId}`],
      sealed: true,
    });
    const invalidPath = join(directory, "a".repeat(64) + ".json");
    await writeFile(invalidPath, "broken snapshot");

    expect(() => restoreDurableCompletionGroupsSync(owner)).toThrow();
    const failedRecord = {
      schemaVersion: 1 as const,
      completionId: `completion-${errorId}`,
      source: "workflow" as const,
      sourceId: errorId,
      label: "failed member",
      status: "error" as const,
      policy: "group" as const,
      groupId: "sync-repair",
      references: [{ label: "result", value: "result" }],
      completedAt: 1,
    };
    publishCompletion(failedRecord, owner);
    const firstManifest = prepareCompletionManifest(owner);
    expect(firstManifest?.details.completionIds).toEqual([
      failedRecord.completionId,
    ]);

    await rm(invalidPath);
    restoreDurableCompletionGroupsSync(owner);
    publishCompletion(
      {
        ...failedRecord,
        completionId: `completion-${peerId}`,
        sourceId: peerId,
        label: "successful member",
        status: "done",
        completedAt: 2,
      },
      owner,
    );
    const repairedManifest = prepareCompletionManifest(owner);
    expect(repairedManifest?.details.completionIds).toEqual([
      `completion-${peerId}`,
    ]);
    expect(repairedManifest?.details.completionIds).not.toContain(
      failedRecord.completionId,
    );
    clearCompletionCoordinator(owner);
  });

  it("keeps valid listed runs when another run journal is corrupt", async () => {
    const { pi, scope, ctx, tools } = setup();
    const runScope = { cwd: root, sessionId: "same-parent", root };
    const valid = await WorkflowRunStore.create(runScope, {
      script:
        'export const meta={name:"waiting",description:"d"}; return "unused";',
      args: encodeRunValue(undefined),
      budgetTotal: 100,
    });
    await valid.close();
    const validError = await WorkflowRunStore.create(runScope, {
      script:
        'export const meta={name:"failed",description:"d"}; return "unused";',
      args: encodeRunValue(undefined),
      budgetTotal: 100,
    });
    await validError.append("terminal", {
      status: "error",
      error: "private listed terminal diagnostic",
      completedAt: Date.now(),
    });
    await validError.close();
    const corrupt = await WorkflowRunStore.create(runScope, {
      script:
        'export const meta={name:"private-run",description:"d"}; return "unused";',
      args: encodeRunValue(undefined),
      budgetTotal: 100,
    });
    await corrupt.close();
    const corruptPath = join(corrupt.directory, "journal.ndjson");
    await appendFile(corruptPath, '{"private":"listing diagnostic"}\n');
    const unreadableBytes = await readFile(corruptPath);
    registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => vi.fn(),
      () => undefined,
      root,
    );

    const listed = await tools
      .get("list_workflow_runs")
      .execute("list-runs", {}, undefined, undefined, ctx);

    expect(listed.isError).not.toBe(true);
    expect(listed.details.runs).toContainEqual(
      expect.objectContaining({ workflowId: valid.id, name: "waiting" }),
    );
    expect(listed.details.runs).toContainEqual(
      expect.objectContaining({
        workflowId: validError.id,
        name: "failed",
        status: "error",
      }),
    );
    expect(listed.details.runs).toContainEqual({
      workflowId: corrupt.id,
      status: "unavailable",
    });
    expect(listed.content[0].text).toContain(valid.id);
    expect(listed.content[0].text).toContain(`${corrupt.id}: unavailable`);
    expect(listed.content[0].text).not.toContain("listing diagnostic");
    expect(
      JSON.stringify({
        details: listed.details,
        structured: listed.structuredContent,
      }),
    ).not.toContain("listing diagnostic");
    expect(
      JSON.stringify({
        details: listed.details,
        structured: listed.structuredContent,
      }),
    ).not.toContain("private listed terminal diagnostic");
    expect(listed.structuredContent.runs).toContainEqual({
      workflowId: valid.id,
      name: "waiting",
      status: "interrupted",
    });
    expect(listed.structuredContent.runs).toContainEqual({
      workflowId: corrupt.id,
      status: "unavailable",
    });
    expect(await readFile(corruptPath)).toEqual(unreadableBytes);
  });
  it("does not let a stale durable result read consume a replacement generation's completion", async () => {
    const { pi, scope, ctx } = setup();
    const oldOwner = sessionOwner(scope);
    let currentOwner = oldOwner;
    const runScope = { cwd: root, sessionId: "same-parent", root };
    const realList = WorkflowRunStore.list.bind(WorkflowRunStore);
    const realInspect = WorkflowRunStore.inspect.bind(WorkflowRunStore);
    const listSpy = vi
      .spyOn(WorkflowRunStore, "list")
      .mockImplementation((requestedScope) =>
        realList({ ...requestedScope, root }),
      );
    let pauseNextInspect = true;
    const inspectPaused = Promise.withResolvers<void>();
    const inspectBarrier = Promise.withResolvers<void>();
    const inspectSpy = vi
      .spyOn(WorkflowRunStore, "inspect")
      .mockImplementation(async (requestedScope, id) => {
        if (pauseNextInspect) {
          pauseNextInspect = false;
          inspectPaused.resolve();
          await inspectBarrier.promise;
        }
        return realInspect({ ...requestedScope, root }, id);
      });
    let store: WorkflowRunStore | undefined;
    let pendingRead: Promise<any> | undefined;
    try {
      const createdStore = await WorkflowRunStore.create(runScope, {
        script:
          'export const meta={name:"generation-fence",description:"d"}; return "unused";',
        args: encodeRunValue(undefined),
        budgetTotal: 100,
      });
      store = createdStore;
      await createdStore.append("accepted", {});
      await createdStore.append("delivery", {
        completion: { policy: "each" },
      });
      await createdStore.append("terminal", {
        status: "done",
        policy: "group",
        groupId: "retry",
        references: [{ label: "result", value: "result" }],
        completedAt: 1,
      },
      owner,
    );
    sealCompletionGroups(owner);
    await expect(
      restoreDurableCompletionGroups(owner, undefined, async () => {
        throw new Error("temporary journal failure");
      }),
    ).rejects.toThrow("temporary journal failure");
    await restoreDurableCompletionGroups(owner, undefined, async () => {
      registerRecoveredCompletionMember(
        "workflow",
        "recovered-run",
        "group",
        "retry",
        owner,
      );
    });
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "workflow:recovered-run",
        source: "workflow",
        sourceId: "recovered-run",
        label: "recovered",
        status: "done",
        policy: "group",
        groupId: "retry",
        references: [{ label: "result", value: "result" }],
        completedAt: 1,
      },
      owner,
    );
    expect(prepareCompletionManifest(owner)!.details.completionIds).toEqual(
      expect.arrayContaining(["interactive:peer", "workflow:recovered-run"]),
    );
    clearCompletionCoordinator(owner);
  });

  it("rejects a truncated durable recovery scan above the list limit", async () => {
    const scope = { cwd: root, sessionId: "workflow-v4", root };
    const seed = await WorkflowRunStore.create(scope, {
      script: "unused",
      args: "",
    });
    await seed.close();
    const directory = dirname(seed.directory);
    for (let index = 1; index <= 1000; index++) {
      await mkdir(
        join(directory, `wfd_${index.toString(16).padStart(32, "0")}`),
      );
    }
    expect(await WorkflowRunStore.list(scope)).toHaveLength(1000);
    await expect(
      WorkflowRunStore.list(scope, { requireComplete: true }),
    ).rejects.toThrow("exceeds 1,000 runs");
  });

  it("stops completed durable attempt wrappers instead of retaining idle children", async () => {
    const { pi, scope, ctx } = setup();
    let manifest = "";
    const runner: WorkflowAgentRunner = async ({ durableAttempt }) => {
      const prepared = await prepareDurableProcess(durableAttempt!);
      prepared.beforeDispatch({
        id: "child",
        artifactDir: root,
        task: "read-only",
        paneId: "old-pane",
      } as InteractiveSubagentState);
      manifest = prepared.path;
      return { isError: false, output: "done", usage: zeroUsage() };
    };
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => runner,
      () => true,
      root,
    );
    const result = await api.run(
      {
        script:
          'export const meta={name:"cleanup",description:"d"}; return await agent("work", {id:"one"});',
        async: false,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.status).toBe("done");
    await expect(access(manifest + ".cancel")).resolves.toBeUndefined();
  });

  it("persists a synchronous run and keeps its result inspectable after registry cleanup", async () => {
    const { pi, scope, ctx } = setup();
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => vi.fn(),
      () => true,
      root,
    );
    const result = await api.run(
      {
        script: 'export const meta={name:"sync",description:"d"}; return args;',
        args: { value: 42 },
        async: false,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.status).toBe("done");
    expect(workflowJobRegistry.size).toBe(0);
    expect(
      (await api.inspect(result.details.workflowId, ctx, true)).content[0].text,
    ).toContain("42");
    expect(
      (
        await api.run(
          { workflowId: result.details.workflowId },
          undefined,
          undefined,
          ctx,
        )
      ).isError,
    ).toBe(true);
  });
  it("sanitizes historical agent RPC diagnostics on synchronous legacy resume while preserving stored metadata and unrelated RPC errors", async () => {
    const { pi, scope, ctx, tools } = setup();
    const owner = sessionOwner(scope);
    const runScope = { cwd: root, sessionId: "same-parent", root };
    const marker = "PRIVATE_HISTORICAL_AGENT_RPC_CANARY";
    const failure = {
      errorCategory: "provider" as const,
      errorStage: "provider" as const,
    };
    const usage = { ...zeroUsage(), output: 7 };
    const source = `export const meta = { name: "legacy-replay", description: "test" };
      let agentFailure;
      try {
        await agent("private", { id: "private", isolation: "in-process" });
      } catch (error) {
        agentFailure = {
          message: error.message,
          category: error.category,
          stage: error.stage,
          spent: budget.spent(),
        };
      }
      let missingWorkflow;
      try {
        await workflow("requested-missing-workflow", undefined, { id: "nested" });
      } catch (error) {
        missingWorkflow = error.message;
      }
      return { agentFailure, missingWorkflow };`;
    const store = await WorkflowRunStore.create(runScope, {
      parentSessionId: "same-parent",
      script: source,
      args: encodeRunValue(undefined),
      budgetTotal: 1000,
      concurrency: 4,
      processConcurrency: 1,
      workflowTimeoutMs: 60_000,
    });
    const id = store.id;
    await store.append("accepted", {});
    await store.append("request", {
      id: 1,
      method: "agent",
      payload: encodeRunValue({
        prompt: "private",
        opts: {
          id: "private",
          isolation: "in-process",
          phase: undefined,
        },
        v4Definition: false,
        operationPath: ["private"],
      }),
    });
    await store.append("attempt", {
      key: "1-0",
      configuration: encodeRunValue({
        prompt: "private",
        persona: undefined,
        model: undefined,
        isolation: "in-process",
        label: undefined,
        thinkingLevel: undefined,
      }),
      isolation: "in-process",
    });
    await store.append("dispatch", { key: "1-0", sequence: 1 });
    await store.append("outcome", {
      key: "1-0",
      ok: false,
      error: marker,
      failure,
      usage,
    });
    await store.append("response", {
      id: 1,
      frontier: 1,
      value: encodeRunValue({
        id: 1,
        ok: false,
        error: marker,
        tokensDelta: 7,
        stats: { errorCount: 1, failure },
      }),
    });
    await store.append("request", {
      id: 2,
      method: "loadWorkflow",
      payload: encodeRunValue({
        name: "requested-missing-workflow",
        args: undefined,
        operationPath: ["nested"],
      }),
    });
    await store.append("response", {
      id: 2,
      frontier: 2,
      value: encodeRunValue({
        id: 2,
        ok: false,
        error:
          'workflow(): no saved workflow named "requested-missing-workflow".',
        tokensDelta: 0,
        stats: { errorCount: 0 },
      }),
    });
    await store.close();

    const runAgent: WorkflowAgentRunner = vi.fn(async () => {
      throw new Error("Historical agent RPC must not redispatch.");
    });
    registerDurableWorkflowTools(
      pi,
      () => owner,
      () => runAgent,
      () => true,
      root,
    );
    try {
      const response = await tools
        .get("resume_workflow")!
        .execute(
          "resume-legacy",
          { workflowId: id, async: false },
          undefined,
          undefined,
          ctx,
        );
      expect(response.content[0].text).not.toContain(marker);
      expect(JSON.stringify(response.details)).not.toContain(marker);
      expect(response.details.status).toBe("done");
      const visible = JSON.parse(response.content[0].text);
      expect(visible.agentFailure.message).not.toContain(marker);
      expect(visible.agentFailure).toMatchObject({
        category: "provider",
        stage: "provider",
        spent: 7,
      });
      expect(visible.missingWorkflow).toContain("requested-missing-workflow");
      expect(response.details.usage.output).toBe(7);
      expect(runAgent).not.toHaveBeenCalled();

      const events = await WorkflowRunStore.inspect(runScope, id);
      const recordedResponse = events?.find(
        (event) => event.kind === "response" && event.data.id === 1,
      );
      expect(
        recordedResponse?.kind === "response"
          ? decodeRunValue<{ error: string }>(recordedResponse.data.value).error
          : undefined,
      ).toBe(marker);
      const terminal = events?.findLast((event) => event.kind === "terminal");
      expect(terminal?.kind).toBe("terminal");
      if (terminal?.kind !== "terminal") return;
      const result = decodeRunValue<{
        errorCount: number;
        failure?: { errorCategory: string; errorStage: string };
        usage: { output: number };
      }>(terminal.data.result);
      expect(result.errorCount).toBe(1);
      expect(result.failure).toEqual(failure);
      expect(result.usage.output).toBe(7);
    } finally {
      clearCompletionCoordinator(owner);
    }
  });
  it("keeps historical uncaught legacy agent RPC diagnostics private on synchronous resume", async () => {
    const { pi, scope, ctx, tools } = setup();
    const owner = sessionOwner(scope);
    const runScope = { cwd: root, sessionId: "same-parent", root };
    const marker = "PRIVATE_UNCAUGHT_HISTORICAL_AGENT_RPC_CANARY";
    const source = `export const meta = { name: "uncaught-legacy-replay", description: "test" };
      return await agent("private", { id: "private", isolation: "in-process" });`;
    const store = await WorkflowRunStore.create(runScope, {
      parentSessionId: "same-parent",
      script: source,
      args: encodeRunValue(undefined),
      budgetTotal: 1000,
      concurrency: 4,
      processConcurrency: 1,
      workflowTimeoutMs: 60_000,
    });
    const id = store.id;
    await store.append("accepted", {});
    await store.append("request", {
      id: 1,
      method: "agent",
      payload: encodeRunValue({
        prompt: "private",
        opts: {
          id: "private",
          isolation: "in-process",
          phase: undefined,
        },
        v4Definition: false,
        operationPath: ["private"],
      }),
    });
    await store.append("response", {
      id: 1,
      frontier: 1,
      value: encodeRunValue({
        id: 1,
        ok: false,
        error: marker,
        tokensDelta: 0,
        stats: { errorCount: 1 },
      }),
    });
    await store.close();

    const runAgent: WorkflowAgentRunner = vi.fn(async () => {
      throw new Error("Historical agent RPC must not redispatch.");
    });
    registerDurableWorkflowTools(
      pi,
      () => owner,
      () => runAgent,
      () => true,
      root,
    );
    try {
      const response = await tools
        .get("resume_workflow")!
        .execute(
          "resume-legacy-uncaught",
          { workflowId: id, async: false },
          undefined,
          undefined,
          ctx,
        );
      expect(response.isError).toBe(true);
      expect(response.details.status).toBe("error");
      expect(response.content[0].text).not.toContain(marker);
      expect(JSON.stringify(response.details)).not.toContain(marker);
      expect(runAgent).not.toHaveBeenCalled();

      const events = await WorkflowRunStore.inspect(runScope, id);
      const recordedResponse = events?.find(
        (event) => event.kind === "response" && event.data.id === 1,
      );
      expect(
        recordedResponse?.kind === "response"
          ? decodeRunValue<{ error: string }>(recordedResponse.data.value).error
          : undefined,
      ).toBe(marker);
    } finally {
      clearCompletionCoordinator(owner);
    }
  });

  it.each(["in-process", "process"])(
    "keeps durable agent diagnostics local and returns only generic summaries (%s)",
    async (isolation) => {
      const { pi, scope, ctx, tools } = setup();
      const marker = "PRIVATE_DURABLE_AGENT_ERROR_CANARY";
      const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "private-diagnostic", version: 1,
        async run(ctx) {
          await ctx.agent("private", {
            prompt: "private work",
            id: "private", isolation: "${isolation}", persist: false
          });
          return "unexpected";
        }
      });`;
      const notify = vi.fn(() => true);
      const api = registerDurableWorkflowTools(
        pi,
        () => sessionOwner(scope),
        () => async () => {
          throw new Error(marker);
        },
        notify,
        root,
      );
      const started = await api.run({ script }, undefined, undefined, ctx);
      const id = started.details.workflowId as string;
      const job = workflowJobRegistry.get(id)!;
      await expect(job.promise).rejects.toThrow(marker);
      const inspected = await api.inspect(id, ctx);
      const collected = await api.inspect(id, ctx, true);
      const listed = await tools
        .get("list_workflow_runs")!
        .execute("", {}, undefined, undefined, ctx);
      expect(JSON.stringify(inspected)).not.toContain(marker);
      expect(JSON.stringify(collected)).not.toContain(marker);
      expect(JSON.stringify(listed)).not.toContain(marker);
      const synchronous = await api.run(
        { script, async: false },
        undefined,
        undefined,
        ctx,
      );
      expect(JSON.stringify(synchronous)).not.toContain(marker);
      const events = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "workflow-v4", root },
        id,
      );
      expect(
        events?.findLast((event) => event.kind === "terminal")?.data.error,
      ).toContain(marker);
    },
  );

  it("interrupts on lifecycle cleanup, then resumes with the new live runner context", async () => {
    const { pi, scope, ctx } = setup();
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let runner: WorkflowAgentRunner = ({ signal }) =>
      new Promise((_, reject) => {
        started();
        signal!.addEventListener(
          "abort",
          () => reject(new Error("interrupted")),
          { once: true },
        );
      });
    const notify = vi.fn(() => true);
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => runner,
      notify,
      root,
    );
    const response = await api.run(
      {
        script:
          'export const meta={name:"resume",description:"d"}; return await agent("work", {id:"work",isolation:"in-process"});',
      },
      undefined,
      undefined,
      ctx,
    );
    expect(response.details.status).toBe("started");
    const id = response.details.workflowId;
    const job = workflowJobRegistry.get(id)!;
    await agentStarted;
    cleanupWorkflowJobsForOwner(sessionOwner(scope));
    await expect(job.promise).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
    expect((await api.inspect(id, ctx)).details.status).toBe("interrupted");
    expect((await api.inspect(id, ctx)).details.error).toBeTruthy();
    expect((await api.inspect(id, ctx)).details.usage).toBeDefined();
    clearCompletionCoordinator(sessionOwner(scope));
    scope.generation++;
    runner = vi.fn(async () => ({
      isError: false as const,
      output: "resumed",
      usage: zeroUsage(),
    }));
    const resumed = await api.run(
      { workflowId: id, async: false },
      undefined,
      undefined,
      ctx,
    );
    expect(resumed.details.status).toBe("done");
    expect(resumed.content[0].text).toBe("resumed");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("restores unfinished mixed completion barriers before a durable aggregate", async () => {
    const { pi, scope } = setup();
    const id = "wfd_" + "a".repeat(32);
    const oldOwner = sessionOwner(scope);
    registerCompletionMember("interactive", "peer", "group", "mixed", oldOwner);
    registerCompletionMember(
      "in-process",
      "ephemeral",
      "group",
      "mixed",
      oldOwner,
    );
    registerCompletionMember("workflow", id, "group", "mixed", oldOwner);
    sealCompletionGroups(oldOwner);
    clearCompletionCoordinator(oldOwner);
    scope.generation++;
    const owner = sessionOwner(scope);
    await restoreDurableCompletionGroups(owner);
    const record = (source: "workflow" | "interactive", sourceId: string) => ({
      schemaVersion: 1 as const,
      completionId: source + ":" + sourceId,
      source,
      sourceId,
      label: sourceId,
      status: "done" as const,
      policy: "group" as const,
      groupId: "mixed",
      references: [{ label: "result", value: "result" }],
      completedAt: 1,
    });
    publishCompletion(record("workflow", id), owner);
    expect(prepareCompletionManifest(owner)).toBeUndefined();
    publishCompletion(
      { ...record("interactive", "peer"), turnId: "turn" },
      owner,
    );
    expect(prepareCompletionManifest(owner)).toBeDefined();
    clearCompletionCoordinator(owner);
  });
  it("recovers each completion after a same-session async resume of an interrupted sync gate", async () => {
    const { pi, scope, ctx, tools } = setup();
    const oldOwner = sessionOwner(scope);
    clearCompletionCoordinator(oldOwner);
    registerCompletionCoordinator(pi, scope);
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "sync-resume-delivery",
        version: 1,
        run: async (ctx) => {
          return await ctx.gate("approval", {
            title: "Approve?",
            summary: "Confirm the workflow step",
          });
        },
      });`;
    const { promise: promptStarted, resolve: continuePrompt } =
      Promise.withResolvers<void>();
    let approve = false;
    const confirm = vi.fn(
      (_title: string, _summary: string, options: { signal?: AbortSignal }) => {
        if (approve) return Promise.resolve(true);
        continuePrompt();
        const { promise, reject } = Promise.withResolvers<boolean>();
        const interrupted = () => reject(new Error("interrupted"));
        if (options.signal?.aborted) interrupted();
        else
          options.signal?.addEventListener("abort", interrupted, {
            once: true,
          });
        return promise;
      },
    );
    const runCtx = {
      ...ctx,
      hasUI: true,
      ui: { confirm },
    };
    const runner: WorkflowAgentRunner = async () => ({
      isError: false,
      output: "unused",
      usage: zeroUsage(),
    });
    const notify = vi.fn(() => true);
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => runner,
      notify,
      root,
    );
    const runScope = { cwd: root, sessionId: "workflow-v4", root };

    try {
      const initialRun = api.run(
        { script, async: false },
        undefined,
        undefined,
        runCtx,
      );
      await promptStarted;
      const interruptedJob = [...workflowJobRegistry.values()].find(
        (job) => job.executionMode === "sync" && job.durable,
      )!;
      const workflowId = interruptedJob.id;
      cleanupWorkflowJobsForOwner(oldOwner);
      await expect(interruptedJob.promise).rejects.toThrow();
      await initialRun;
      const interruptedEvents = await WorkflowRunStore.inspect(
        runScope,
        workflowId,
      );
      expect(
        interruptedEvents?.some((event) => event.kind === "interrupted"),
      ).toBe(true);

      clearCompletionCoordinator(oldOwner);
      scope.generation++;
      const owner = sessionOwner(scope);
      registerCompletionCoordinator(pi, scope);
      const resumed = await api.run(
        { workflowId, async: true },
        undefined,
        undefined,
        runCtx,
      );
      expect(resumed.details).toMatchObject({
        status: "started",
        workflowId,
        durable: true,
      });
      const resumedJob = workflowJobRegistry.get(workflowId)!;
      await vi.waitFor(() =>
        expect(
          resumedJob.snapshot.steps?.some(
            (step) =>
              step.status === "waiting_for_input" &&
              JSON.stringify(step.path) === JSON.stringify(["approval"]),
          ),
        ).toBe(true),
      );
      resumedJob.suppressCompletionNotification = true;
      approve = true;
      const answer = await tools
        .get("respond_workflow_input")!
        .execute(
          "answer",
          { workflowId, path: ["approval"] },
          undefined,
          undefined,
          runCtx,
        );
      expect(answer.details.status).toBe("running");
      await expect(resumedJob.promise).resolves.toMatchObject({
        result: true,
      });
      expect(notify).not.toHaveBeenCalled();

      const terminalEvents = await WorkflowRunStore.inspect(
        runScope,
        workflowId,
      );
      expect(terminalEvents?.at(-1)).toMatchObject({
        kind: "terminal",
        data: { status: "done" },
      });
      const latestDelivery = terminalEvents
        ?.filter((event) => event.kind === "delivery")
        .at(-1);
      expect(latestDelivery?.data).toMatchObject({
        parentSessionId: "same-parent",
        completion: { policy: "each" },
      });

      clearCompletionCoordinator(owner);
      registerCompletionCoordinator(pi, scope);
      // A busy parent leaves the recovered wake queued for explicit inspection.
      scope.parentStreaming = true;
      await restoreDurableWorkflowRuns(pi, owner, runCtx, root);
      const manifest = prepareCompletionManifest(owner);
      expect(manifest?.details.completionIds).toEqual([
        `workflow:${workflowId}`,
      ]);
      expect(manifest).toBeDefined();
      const manifestRecords = manifest!.content
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(manifestRecords).toContainEqual(
        expect.objectContaining({
          sourceId: workflowId,
          retrieve: `get_workflow_result(workflowId: ${JSON.stringify(workflowId)})`,
        }),
      );
      clearCompletionCoordinator(owner);
    } finally {
      clearCompletionCoordinator(sessionOwner(scope));
    }
  });
});

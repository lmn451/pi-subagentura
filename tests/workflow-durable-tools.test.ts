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
import { join } from "node:path";
import {
  registerDurableWorkflowTools,
  restoreDurableWorkflowRuns,
} from "../src/workflow-durable-tools";
import { registerWorkflowTool } from "../src/workflow-tool";
import {
  registerSessionScope,
  sessionOwner,
  clearSessionScopes,
} from "../src/session-scope";
import {
  cleanupWorkflowJobsForOwner,
  workflowJobRegistry,
} from "../src/workflow-jobs";
import {
  registerCompletionCoordinator,
  registerCompletionMember,
  sealCompletionGroups,
  clearCompletionCoordinator,
  restoreDurableCompletionGroups,
  restoreDurableCompletionGroupsSync,
  publishCompletion,
  prepareCompletionManifest,
} from "../src/completion-coordinator";
import { zeroUsage } from "../src/usage";
import { WorkflowRunStore, encodeRunValue } from "../src/workflow-run-store";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { writeCompletionGroup } from "../src/completion-group-store";

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
  const scope = registerSessionScope({
    id: 1,
    generation: 1,
    lifecycle: "started",
    pi,
    cwd: root,
    sessionManager: {
      getSessionId: () => "same-parent",
      getSessionDir: () => root,
      getEntries: () => entries,
    },
  });
  registerCompletionCoordinator(pi, scope);
  const ctx = { cwd: root, sessionManager: scope.sessionManager };
  return { pi, scope, ctx, tools, entries };
}

describe("durable public tools", () => {
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
    const { pi, scope, ctx, tools, entries } = setup();
    const owner = sessionOwner(scope);
    scope.parentStreaming = true;
    scope.sessionManager.getEntries = () => [];
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
    const { scope } = setup();
    const owner = sessionOwner(scope);
    scope.sessionManager.getEntries = () => [];
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
        result: encodeRunValue({
          result: "done",
          agentsSpawned: 0,
          errorCount: 0,
        }),
        completedAt: Date.now(),
      });
      await createdStore.close();

      const api = registerDurableWorkflowTools(
        pi,
        () => sessionOwner(scope),
        () => vi.fn(),
        () => {},
        root,
      );
      pendingRead = api.inspect(createdStore.id, ctx, true);
      await inspectPaused.promise;

      clearCompletionCoordinator(oldOwner);
      scope.generation++;
      scope.parentStreaming = true;
      currentOwner = sessionOwner(scope);
      registerCompletionCoordinator(pi, scope);
      await restoreDurableWorkflowRuns(pi, currentOwner, ctx);

      inspectBarrier.resolve();
      const result = await pendingRead;
      expect(result.details.status).toBe("done");

      let receipts = "";
      try {
        receipts = await readFile(
          sessionLedgerPath(
            root,
            "same-parent",
            "subagentura-completion-consumed",
          ),
          "utf8",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const receiptRecords = receipts
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(receiptRecords).not.toContainEqual(
        expect.objectContaining({
          source: "workflow",
          sourceId: createdStore.id,
        }),
      );
      const manifest = prepareCompletionManifest(currentOwner);
      expect(manifest?.details.completionIds).toEqual([
        `workflow:${createdStore.id}`,
      ]);
      expect(manifest?.content).toContain('"status":"done"');
    } finally {
      inspectBarrier.resolve();
      await pendingRead?.catch(() => undefined);
      listSpy.mockRestore();
      inspectSpy.mockRestore();
      clearCompletionCoordinator(oldOwner);
      clearCompletionCoordinator(currentOwner);
      await store?.close();
      if (store) await rm(store.directory, { recursive: true, force: true });
    }
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
});

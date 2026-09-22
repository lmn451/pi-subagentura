import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  access,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { sessionLedgerPath } from "../src/completion-ledger";
import { prepareDurableProcess } from "../src/workflow-durable-process";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDurableWorkflowTools } from "../src/workflow-durable-tools";
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
import type { WorkflowAgentRunner } from "../src/workflow-core";

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
  it("does not rewrite a failed group snapshot during later settlement", async () => {
    const { scope } = setup();
    const owner = sessionOwner(scope);
    const directory =
      sessionLedgerPath(root, "same-parent", "subagentura-completion-groups") +
      ".groups";
    await mkdir(directory, { recursive: true });
    const snapshot = join(directory, "b".repeat(64) + ".json");
    await writeFile(snapshot, "corrupt-snapshot");
    expect(() => restoreDurableCompletionGroupsSync(owner)).toThrow();
    sealCompletionGroups(owner);
    expect(await readFile(snapshot, "utf8")).toBe("corrupt-snapshot");
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

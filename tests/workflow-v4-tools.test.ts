import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
  MAX_WORKFLOW_JOBS,
  workflowJobRegistry,
} from "../src/workflow-jobs";
import {
  clearCompletionCoordinator,
  prepareCompletionManifest,
  registerCompletionCoordinator,
  sealCompletionGroups,
} from "../src/completion-coordinator";
import { DurableWorkflow } from "../src/workflow-durable";
import { runWorkflow } from "../src/workflow-worker";
import { getLiveWorkflowV4Store } from "../src/workflow-v4-store";
import { encodeRunValue, WorkflowRunStore } from "../src/workflow-run-store";
import { readCompletionGroups } from "../src/completion-group-store";
import { sessionLedgerPath } from "../src/completion-ledger";
import { restoreDurableWorkflowRuns } from "../src/workflow-durable-tools";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";

let root: string;
const owners: ReturnType<typeof sessionOwner>[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workflow-v4-tools-"));
});

afterEach(async () => {
  for (const owner of owners.splice(0)) cleanupWorkflowJobsForOwner(owner);
  for (const job of workflowJobRegistry.values()) job.abort.abort();
  await Promise.allSettled(
    [...workflowJobRegistry.values()].map((job) => job.promise),
  );
  workflowJobRegistry.clear();
  clearSessionScopes();
  await rm(root, { recursive: true, force: true });
});

function definition(name: string, body: string) {
  return `import { defineWorkflow } from "pi-subagentura/workflow";
    export default defineWorkflow({ name: "${name}", version: 1,
      run: async (ctx, args) => { ${body} }
    });`;
}

function setup(
  id: number,
  sessionId: string,
  ui: Record<string, unknown> = {},
) {
  const entries: any[] = [];
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn((_type: string, entry: unknown) => entries.push(entry)),
    sendMessage: vi.fn(),
  };
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => root,
    getEntries: () => entries,
  };
  const scope = registerSessionScope({
    id,
    generation: 1,
    lifecycle: "started",
    pi,
    cwd: root,
    sessionManager,
  });
  const owner = sessionOwner(scope);
  owners.push(owner);
  registerCompletionCoordinator(pi, scope);
  const ctx = {
    cwd: root,
    sessionManager,
    hasUI: true,
    ui,
  };
  return { pi, scope, owner, ctx, tools, entries };
}

function successfulRunner(output: string): WorkflowAgentRunner {
  return vi.fn(async () => ({
    isError: false as const,
    output,
    usage: zeroUsage(),
  }));
}

function register(
  setupResult: ReturnType<typeof setup>,
  runner: WorkflowAgentRunner,
) {
  return registerDurableWorkflowTools(
    setupResult.pi,
    () => sessionOwner(setupResult.scope),
    () => runner,
    () => true,
    root,
  );
}

async function executeTool(
  tools: Map<string, any>,
  name: string,
  params: unknown,
  ctx: unknown,
) {
  const tool = tools.get(name);
  expect(tool, `registered ${name} tool`).toBeDefined();
  return tool.execute("test-call", params, undefined, undefined, ctx);
}

describe("v4 workflow public tools", () => {
  it("removes a recovered group member whose journal proves acceptance failed", async () => {
    const first = setup(1, "acceptance-crash");
    const api = register(first, successfulRunner("unused"));
    const originalAppend = WorkflowRunStore.prototype.append;
    const append = vi.spyOn(WorkflowRunStore.prototype, "append");
    append.mockImplementation(async function (kind: string, data: any) {
      if (kind === "accepted") throw new Error("simulated acceptance crash");
      return originalAppend.call(this, kind, data);
    });
    try {
      const failed = await api.run(
        {
          script: definition("crashed-acceptance", "return true;"),
          completionPolicy: "group",
          completionGroupId: "crashed-acceptance-group",
        },
        undefined,
        undefined,
        first.ctx,
      );
      expect(failed.isError).toBe(true);
    } finally {
      append.mockRestore();
    }

    clearCompletionCoordinator(first.owner);
    clearSessionScopes();
    const second = setup(2, "acceptance-crash");
    await restoreDurableWorkflowRuns(second.pi, second.owner, second.ctx, root);
    const directory = `${sessionLedgerPath(
      root,
      "acceptance-crash",
      "subagentura-completion-groups",
    )}.groups`;
    expect(await readCompletionGroups(directory)).toEqual([]);
  });

  it("records rejected capacity admission and settles its completion member", async () => {
    const current = setup(1, "capacity-rejection");
    workflowJobRegistry.clear();
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      workflowJobRegistry.set(`occupied-${index}`, {
        id: `occupied-${index}`,
        status: "running",
        abort: new AbortController(),
        parentSessionOwner: current.owner,
      } as any);
    }
    const runner = successfulRunner("unused");
    const api = register(current, runner);
    const rejected = await api.run(
      {
        script: definition("capacity-rejected", "return true;"),
        completionPolicy: "group",
        completionGroupId: "capacity-group",
      },
      undefined,
      undefined,
      current.ctx,
    );
    expect(rejected.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    const ids = await WorkflowRunStore.list({
      cwd: root,
      sessionId: "workflow-v4",
      root,
    });
    const events = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      ids[0],
    );
    expect(events?.map((event) => event.kind)).toContain("accepted");
    expect(events?.at(-1)).toMatchObject({
      kind: "rejected",
      data: { status: "rejected", reason: "capacity" },
    });
    expect(workflowJobRegistry.has(ids[0])).toBe(false);
    sealCompletionGroups(current.owner);
    expect(
      prepareCompletionManifest(current.owner)?.details.completionIds,
    ).toContain(`workflow:${ids[0]}`);
    expect(workflowJobRegistry.size).toBe(MAX_WORKFLOW_JOBS);
  });

  it("answers a background gate through Pi UI and completes without model-supplied input", async () => {
    const confirm = vi.fn(async () => true);
    const current = setup(1, "gate-parent", { confirm });
    const api = register(current, successfulRunner("unused"));
    const response = await api.run(
      {
        script: definition(
          "background-gate",
          'await ctx.gate("approval", { title: "Approve deploy?", summary: "Deploy to prod" }); return { approved: true };',
        ),
      },
      undefined,
      undefined,
      current.ctx,
    );
    expect(response.details.status).toBe("started");
    const workflowId = response.details.workflowId;
    const job = workflowJobRegistry.get(workflowId)!;
    await vi.waitFor(() =>
      expect(
        job.snapshot.steps?.some((step) => step.status === "waiting_for_input"),
      ).toBe(true),
    );
    const waiting = job.snapshot.steps!.find(
      (step) => step.status === "waiting_for_input",
    )!;

    const answerTool = current.tools.get("respond_workflow_input");
    expect(Object.keys(answerTool.parameters.properties)).toEqual([
      "workflowId",
      "path",
    ]);
    await executeTool(
      current.tools,
      "respond_workflow_input",
      { workflowId, path: waiting.path, answer: false },
      current.ctx,
    );
    await expect(job.promise).resolves.toMatchObject({
      result: { approved: true },
    });
    expect(confirm).toHaveBeenCalledWith("Approve deploy?", "Deploy to prod", {
      signal: undefined,
    });
    expect(job.status).toBe("done");
    const listed = await executeTool(
      current.tools,
      "list_workflow_runs",
      {},
      current.ctx,
    );
    expect(listed.details.runs).toContainEqual(
      expect.objectContaining({ workflowId, status: "done" }),
    );
  });

  it("lists and resumes project-scoped v4 work in a fresh parent session with its new runner", async () => {
    const first = setup(1, "first-parent");
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const oldRunner: WorkflowAgentRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signalStarted();
        signal!.addEventListener(
          "abort",
          () => reject(new Error("parent replaced")),
          { once: true },
        );
      });
    const firstApi = register(first, oldRunner);
    const started = await firstApi.run(
      {
        script: definition(
          "project-resume",
          'const agent = await ctx.agent("answer", { prompt: "answer it" }); return { answer: agent };',
        ),
      },
      undefined,
      undefined,
      first.ctx,
    );
    const workflowId = started.details.workflowId;
    const interruptedJob = workflowJobRegistry.get(workflowId)!;
    await firstStarted;
    cleanupWorkflowJobsForOwner(first.owner);
    await expect(interruptedJob.promise).rejects.toThrow();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const second = setup(2, "second-parent");
    const newRunner = successfulRunner("new-parent-answer");
    register(second, newRunner);
    const listed = await executeTool(
      second.tools,
      "list_workflow_runs",
      {},
      second.ctx,
    );
    expect(listed.details.runs).toContainEqual(
      expect.objectContaining({ workflowId, durable: true }),
    );
    const resumed = await executeTool(
      second.tools,
      "resume_workflow",
      { workflowId, async: false },
      second.ctx,
    );
    expect(resumed.details.status).toBe("done");
    expect(newRunner).toHaveBeenCalledOnce();
    expect(resumed.content[0].text).toContain("new-parent-answer");
    const saved = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(saved?.some((event) => event.kind === "terminal")).toBe(true);
  });

  it("answers a persisted gate after reopening the project run and resumes it", async () => {
    const first = setup(1, "gate-before-reopen");
    const script = definition(
      "persisted-gate",
      'const accepted = await ctx.gate("approval", { title: "Resume deploy?", summary: "Continue after restart" }); return { accepted };',
    );
    const projectScope = { cwd: root, sessionId: "workflow-v4", root };
    const persisted = await WorkflowRunStore.create(projectScope, {
      parentSessionId: "gate-before-reopen",
      script,
      args: encodeRunValue({}),
      budgetTotal: 1000,
      completion: { legacy: false, policy: "each" },
      concurrency: 4,
      processConcurrency: 4,
      workflowTimeoutMs: 60_000,
    });
    const workflowId = persisted.id;
    await persisted.append("accepted", {});
    await persisted.append("delivery", {
      completion: { legacy: false, policy: "each" },
    });
    const durable = new DurableWorkflow(persisted);
    const interruptedRun = runWorkflow(script, {
      args: {},
      cwd: root,
      durable,
      budgetTotal: 1000,
      runAgent: successfulRunner("unused"),
    });
    await vi.waitFor(() =>
      expect(
        getLiveWorkflowV4Store(workflowId)
          ?.snapshot()
          .some((step) => step.status === "waiting_for_input"),
      ).toBe(true),
    );
    const waiting = getLiveWorkflowV4Store(workflowId)!
      .snapshot()
      .find((step) => step.status === "waiting_for_input")!;
    getLiveWorkflowV4Store(workflowId)!.close();
    await expect(interruptedRun).rejects.toThrow();
    durable.stop();
    await durable.drain();
    await persisted.close();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const confirm = vi.fn(async () => true);
    const second = setup(2, "gate-after-reopen", { confirm });
    register(second, successfulRunner("unused"));
    const answer = await executeTool(
      second.tools,
      "respond_workflow_input",
      { workflowId, path: waiting.path },
      second.ctx,
    );
    expect(answer.details.status, answer.content[0]?.text).toBe("started");
    const reopenedEvents = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(
      reopenedEvents?.filter((event) => event.kind === "v4.step").at(-1)?.data,
    ).toMatchObject({ status: "running", answer: true });
    const resumedJob = workflowJobRegistry.get(workflowId)!;
    await vi.waitFor(
      () =>
        expect(
          resumedJob.status,
          JSON.stringify(resumedJob.snapshot.steps),
        ).toBe("done"),
      { timeout: 1_000 },
    );
    await expect(resumedJob.promise).resolves.toMatchObject({
      result: { accepted: true },
    });
    expect(confirm).toHaveBeenCalledWith(
      "Resume deploy?",
      "Continue after restart",
      { signal: undefined },
    );
  });

  it("restores the configured execution timeout when resuming after a long interruption", async () => {
    const current = setup(1, "after-long-pause");
    const script = definition("long-pause", "return { resumed: true };");
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "before-long-pause",
        script,
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "each" },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 5_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    const api = register(current, successfulRunner("unused"));
    const start = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(start + 60_000);
    try {
      const resumed = await api.run(
        { workflowId, async: false },
        undefined,
        undefined,
        current.ctx,
      );
      expect(resumed.details.status, resumed.content[0]?.text).toBe("done");
      expect(resumed.content[0].text).toContain('"resumed":true');
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("routes a synchronous gate through the UI prompt callback", async () => {
    const confirm = vi.fn(async () => true);
    const current = setup(1, "sync-gate", { confirm });
    const api = register(current, successfulRunner("unused"));
    const execution = api.run(
      {
        script: definition(
          "sync-gate",
          'await ctx.gate("approval", { title: "Proceed?", summary: "Run sync step" }); return "complete";',
        ),
        async: false,
      },
      undefined,
      undefined,
      current.ctx,
    );
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    const result = await execution;
    expect(result.content[0].text).toContain("complete");
    expect(confirm).toHaveBeenCalledWith("Proceed?", "Run sync step", {
      signal: expect.any(AbortSignal),
    });
  });
});

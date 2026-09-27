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
import { encodeRunValue, WorkflowRunStore } from "../src/workflow-run-store";
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
  MAX_WORKFLOW_JOBS,
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
import { createTelemetrySession } from "../src/telemetry";

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
  it("does not emit cancellation telemetry before acceptance or after opt-out", async () => {
    const { pi, scope, ctx } = setup();
    const payloads: Array<{ event: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const owner = sessionOwner(scope);
    const api = registerDurableWorkflowTools(
      pi,
      () => owner,
      () => vi.fn(),
      () => true,
      root,
    );
    for (const scenario of [
      { accepted: false, optedOut: false },
      { accepted: true, optedOut: true },
    ]) {
      const telemetry = createTelemetrySession(!scenario.optedOut);
      scope.telemetry = telemetry;
      const store = await WorkflowRunStore.create(
        { cwd: root, sessionId: "same-parent", root },
        {
          script: 'export const meta={name:"cancel",description:"d"}; return 7;',
          args: encodeRunValue(undefined),
          budgetTotal: 100,
          telemetry: {
            enabled: true,
            correlationId: createTelemetrySession(true).correlationId,
            mode: "straight",
            invocation: "tool",
            async: true,
            completionPolicy: "each",
          },
        },
      );
      const id = store.id;
      if (scenario.accepted) await store.append("accepted", {});
      await store.close();
      await api.cancel(id, ctx);
    }
    expect(
      payloads.some((payload) =>
        payload.event.endsWith("workflow_completed"),
      ),
    ).toBe(false);
  });

  it("does not cancel or resume a durable run rejected by job admission", async () => {
    const { pi, scope, ctx } = setup();
    const payloads: Array<{ event: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }),
    );
    scope.telemetry = createTelemetrySession(true);
    const owner = sessionOwner(scope);
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      const id = `held-${index}`;
      workflowJobRegistry.set(id, {
        id,
        status: "done",
        completionPolicy: "each",
        resultRetrieved: false,
        parentSessionOwner: owner,
      } as any);
    }
    const runner: WorkflowAgentRunner = vi.fn(async () => ({
      isError: false as const,
      output: "ran",
      usage: zeroUsage(),
    }));
    const api = registerDurableWorkflowTools(
      pi,
      () => owner,
      () => runner,
      () => true,
      root,
    );
    const failed = await api.run(
      {
        script:
          'export const meta={name:"admission",description:"d"}; return await agent("work", {id:"work"});',
      },
      undefined,
      undefined,
      ctx,
    );
    expect(failed.isError).toBe(true);
    const id = (
      await WorkflowRunStore.list({
        cwd: root,
        sessionId: "same-parent",
        root,
      })
    )[0]!;
    expect(
      (
        await WorkflowRunStore.inspect(
          {
            cwd: root,
            sessionId: "same-parent",
            root,
          },
          id,
        )
      )?.some((event) => event.kind === "accepted"),
    ).toBe(true);

    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      workflowJobRegistry.delete(`held-${index}`);
    }
    const resumed = await api.run(
      { workflowId: id, async: false },
      undefined,
      undefined,
      ctx,
    );
    expect(resumed.details.status).toBe("error");
    expect(runner).not.toHaveBeenCalled();
    await api.cancel(id, ctx);
    expect(
      payloads.some((payload) => payload.event.endsWith("workflow_completed")),
    ).toBe(false);
  });

  it("does not emit another start when resuming accepted work before its first RPC", async () => {
    const { pi, scope, ctx } = setup();
    const payloads: Array<{ event: string; distinct_id: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const original = createTelemetrySession(true);
    scope.telemetry = original;
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "same-parent", root },
      {
        script:
          'export const meta={name:"early-resume",description:"d"}; return 7;',
        args: encodeRunValue(undefined),
        budgetTotal: 100,
        completion: { legacy: false, policy: "each" },
        concurrency: 1,
        processConcurrency: 1,
        workflowTimeoutMs: 10_000,
        telemetry: {
          enabled: true,
          correlationId: original.correlationId,
          mode: original.mode,
          invocation: "tool",
          async: true,
          completionPolicy: "each",
        },
      },
    );
    const id = store.id;
    await store.append("accepted", {});
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => vi.fn(),
      () => true,
      root,
    );
    const resumed = await api.run(
      { workflowId: id, async: false },
      undefined,
      undefined,
      ctx,
    );
    expect(resumed.details.status, resumed.content[0]?.text).toBe("done");
    expect(
      payloads.filter((payload) => payload.event.endsWith("workflow_started")),
    ).toEqual([]);
    expect(
      payloads.filter((payload) =>
        payload.event.endsWith("workflow_completed"),
      ),
    ).toHaveLength(1);
    expect(payloads[0]?.distinct_id).toBe(original.correlationId);
  });

  it("does not revive durable telemetry for a retired current session", async () => {
    const { pi, scope, ctx } = setup();
    const payloads: Array<{ event: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const original = createTelemetrySession(true);
    scope.telemetry = createTelemetrySession(true);
    scope.telemetry.active = false;
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "same-parent", root },
      {
        script: 'export const meta={name:"retired",description:"d"}; return 7;',
        args: encodeRunValue(undefined),
        budgetTotal: 100,
        completion: { legacy: false, policy: "each" },
        concurrency: 1,
        processConcurrency: 1,
        workflowTimeoutMs: 10_000,
        telemetry: {
          enabled: true,
          correlationId: original.correlationId,
          mode: original.mode,
          invocation: "tool",
          async: true,
          completionPolicy: "each",
        },
      },
    );
    const id = store.id;
    await store.append("accepted", {});
    await store.close();
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () => vi.fn(),
      () => true,
      root,
    );
    await api.cancel(id, ctx);
    expect(
      payloads.filter((payload) =>
        payload.event.endsWith("workflow_completed"),
      ),
    ).toEqual([]);
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
    const payloads: Array<{ event: string; distinct_id: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const originalTelemetry = createTelemetrySession(true);
    scope.telemetry = originalTelemetry;
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
    scope.telemetry = createTelemetrySession(true);
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
    const lifecycle = payloads.filter((payload) =>
      /workflow_(started|completed)$/.test(payload.event),
    );
    expect(lifecycle.map((payload) => payload.event)).toEqual([
      "pi_subagentura_workflow_started",
      "pi_subagentura_workflow_completed",
    ]);
    expect(lifecycle[0]?.distinct_id).toBe(originalTelemetry.correlationId);
    expect(lifecycle[1]?.distinct_id).toBe(originalTelemetry.correlationId);
  });

  it("closes interrupted cancellation telemetry once with its original correlation and clock", async () => {
    const { pi, scope, ctx } = setup();
    const payloads: Array<{
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const originalTelemetry = createTelemetrySession(true);
    scope.telemetry = originalTelemetry;
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const api = registerDurableWorkflowTools(
      pi,
      () => sessionOwner(scope),
      () =>
        ({ signal }) =>
          new Promise((_, reject) => {
            started();
            signal!.addEventListener(
              "abort",
              () => reject(new Error("interrupted")),
              { once: true },
            );
          }),
      () => true,
      root,
    );
    const response = await api.run(
      {
        script:
          'export const meta={name:"cancel-interrupted",description:"d"}; return await agent("work", {id:"work",isolation:"in-process"});',
      },
      undefined,
      undefined,
      ctx,
    );
    const id = response.details.workflowId;
    const job = workflowJobRegistry.get(id)!;
    await agentStarted;
    cleanupWorkflowJobsForOwner(sessionOwner(scope));
    await expect(job.promise).rejects.toThrow();

    scope.telemetry = createTelemetrySession(true);
    await api.cancel(id, ctx);
    await api.cancel(id, ctx);

    const lifecycle = payloads.filter((payload) =>
      /workflow_(started|completed)$/.test(payload.event),
    );
    expect(lifecycle.map((payload) => payload.event)).toEqual([
      "pi_subagentura_workflow_started",
      "pi_subagentura_workflow_completed",
    ]);
    expect(lifecycle[0]?.distinct_id).toBe(originalTelemetry.correlationId);
    expect(lifecycle[1]?.distinct_id).toBe(originalTelemetry.correlationId);
    expect(lifecycle[1]?.properties).toMatchObject({
      status: "cancelled",
      terminal_reason: "explicit_cancel",
    });
    const events = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "same-parent", root },
      id,
    );
    const cancellation = events?.findLast(
      (event) => event.kind === "cancelled",
    );
    expect(cancellation?.data).toMatchObject({
      status: "cancelled",
      telemetryCompletionReceipt: true,
    });
    expect(lifecycle[1]?.properties.duration_ms).toBe(
      Math.round(
        (cancellation!.data.completedAt - events![0]!.data.createdAt) / 100,
      ) * 100,
    );
    expect(JSON.stringify(lifecycle[1])).not.toContain(id);
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

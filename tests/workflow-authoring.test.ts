import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ dir: "", run: vi.fn() }));
vi.mock("../src/workflow-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("../src/workflow-core")>();
  return {
    ...core,
    loadWorkflowScript: (name: string) =>
      core.loadWorkflowScript(name, fixture.dir),
    listSavedWorkflows: () => core.listSavedWorkflows(fixture.dir),
    inspectSavedWorkflow: (script: string) =>
      core.inspectSavedWorkflow(script, fixture.dir),
    saveWorkflowScript: (
      name: string,
      script: string,
      _dir: unknown,
      options: any,
    ) => core.saveWorkflowScript(name, script, fixture.dir, options),
  };
});
vi.mock("../src/workflow-durable-tools", () => ({
  registerDurableWorkflowTools: () => ({ run: fixture.run }),
}));

import { registerWorkflowTool } from "../src/workflow-tool";
import { workflowJobRegistry } from "../src/workflow-jobs";

function setup() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  registerWorkflowTool(pi);
  const ctx = { cwd: fixture.dir, ui: { notify: vi.fn(), select: vi.fn() } };
  return { tools, commands, pi, ctx };
}

const meta = 'export const meta={name:"review",description:"Review work"};';
const ready = `${meta} return await agent("review", {id:"review"});`;
const legacy = `${meta} return await agent("review");`;

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), "workflow-authoring-"));
  fixture.run.mockReset().mockResolvedValue({
    content: [{ type: "text", text: "Started durable run." }],
    details: { status: "started", workflowId: "wfd_test", durable: true },
  });
});

afterEach(async () => {
  for (const job of workflowJobRegistry.values()) job.abort.abort();
  await Promise.allSettled(
    [...workflowJobRegistry.values()].map((job) => job.promise),
  );
  workflowJobRegistry.clear();
  rmSync(fixture.dir, { recursive: true, force: true });
});

describe("durable workflow authoring", () => {
  it("rejects an incompatible durable save without overwriting the existing definition", async () => {
    const { tools } = setup();
    const file = join(fixture.dir, "review.js");
    writeFileSync(file, ready);
    const response = await tools.get("save_workflow").execute("", {
      name: "review",
      script: legacy,
      requireDurable: true,
    });
    expect(response.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(ready);
  });

  it("lists durable readiness and a source digest while preserving legacy saves", async () => {
    const { tools } = setup();
    await tools
      .get("save_workflow")
      .execute("", { name: "ready", script: ready, requireDurable: true });
    await tools
      .get("save_workflow")
      .execute("", { name: "legacy", script: legacy });
    const response = await tools.get("list_workflows").execute();
    expect(response.details.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ready",
          durableReady: true,
          definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({ name: "legacy", durableReady: false }),
      ]),
    );
    expect(response.content[0].text).toContain("session-scoped");
  });

  it("starts a compatible saved definition through the durable runner with explicit args", async () => {
    writeFileSync(join(fixture.dir, "ready.js"), ready);
    const { commands, ctx } = setup();
    await commands.get("workflows").handler('ready {"topic":"storage"}', ctx);
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({
        script: ready,
        args: { topic: "storage" },
        durable: true,
        async: true,
      }),
      undefined,
      undefined,
      ctx,
      "saved_command",
    );
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("keeps a nested workflow session-scoped when its saved child is incompatible", async () => {
    const { tools } = setup();
    writeFileSync(join(fixture.dir, "child.js"), legacy);
    const nested = `${meta} return await workflow("child", {}, {id:"child"});`;
    const response = await tools.get("save_workflow").execute("", {
      name: "parent",
      script: nested,
      requireDurable: true,
    });
    expect(response.isError).toBe(true);
    await tools
      .get("save_workflow")
      .execute("", { name: "parent", script: nested });
    const listing = await tools.get("list_workflows").execute();
    expect(
      listing.details.workflows.find((item: any) => item.name === "parent")
        .durableReady,
    ).toBe(false);
  });

  it("runs a legacy saved script with a visible session-scoped label", async () => {
    writeFileSync(
      join(fixture.dir, "legacy.js"),
      `${meta} const unused = () => agent("work"); return "done";`,
    );
    const { commands, ctx, pi } = setup();
    await commands.get("workflows").handler("legacy {}", ctx);
    expect(fixture.run).not.toHaveBeenCalled();
    expect(pi.sendMessage.mock.calls[0][0].content).toContain(
      "Session-scoped run",
    );
    const job = [...workflowJobRegistry.values()][0];
    expect((await job.promise).result).toBe("done");
  });

  it("reports durable startup failure without silently starting a session-scoped run", async () => {
    writeFileSync(join(fixture.dir, "ready.js"), ready);
    fixture.run.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "Storage unavailable" }],
    });
    const { commands, ctx, pi } = setup();
    await commands.get("workflows").handler("ready {}", ctx);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain(
      "Storage unavailable",
    );
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("does not downgrade a durable selection changed while the user enters args", async () => {
    const file = join(fixture.dir, "ready.js");
    writeFileSync(file, ready);
    const { commands, ctx, pi } = setup();
    Object.assign(ctx.ui, {
      editor: async () => {
        writeFileSync(file, legacy);
        return "{}";
      },
    });
    await commands.get("workflows").handler("ready", ctx);
    expect(fixture.run).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain(
      "no longer durable-ready",
    );
  });

  it("emits a durable authoring request without executing a workflow itself", async () => {
    const { commands, ctx, pi } = setup();
    await commands.get("workflow").handler("review my changes", ctx);
    const prompt = pi.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("requireDurable: true");
    expect(prompt).toContain("durable: true");
    expect(prompt).toContain("stable");
    expect(fixture.run).not.toHaveBeenCalled();
  });
});

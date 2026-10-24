import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({
  dir: "",
  run: vi.fn(),
  save: vi.fn(),
}));
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
      options: { requireDurable?: boolean },
    ) => {
      fixture.save(name, script, options);
      return core.saveWorkflowScript(name, script, fixture.dir, options);
    },
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
const ready = `${meta} const unused=()=>agent("review", {id:"review"}); return "done";`;
const legacy = `${meta} const unused=()=>agent("review"); return "legacy";`;

beforeEach(() => {
  fixture.dir = mkdtempSync(join(tmpdir(), "workflow-authoring-"));
  fixture.run.mockReset().mockResolvedValue({
    content: [{ type: "text", text: "Started durable run." }],
    details: { status: "started", workflowId: "wfd_test", durable: true },
  });
  fixture.save.mockReset();
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
  });

  it("runs a durable-ready saved definition session-scoped by default", async () => {
    writeFileSync(join(fixture.dir, "ready.js"), ready);
    const { commands, ctx } = setup(true);
    await commands.get("workflows").handler('ready {"topic":"storage"}', ctx);
    expect(fixture.run).not.toHaveBeenCalled();
    const job = [...workflowJobRegistry.values()][0];
    expect(job).toBeDefined();
    await expect(job.promise).resolves.toMatchObject({ result: "done" });
  });

  it("keeps an explicitly durable workflow tool call durable", async () => {
    writeFileSync(join(fixture.dir, "ready.js"), ready);
    const { tools, ctx } = setup(true);
    await tools.get("workflow").execute(
      "durable-explicit",
      {
        name: "ready",
        args: { topic: "storage" },
        durable: true,
        async: true,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ready",
        args: { topic: "storage" },
        durable: true,
        async: true,
      }),
      undefined,
      undefined,
      ctx,
    );
  });

  it("runs a picker-selected durable-ready definition session-scoped by default", async () => {
    writeFileSync(join(fixture.dir, "ready.js"), ready);
    const { commands, ctx } = setup(true);
    ctx.ui.select = vi.fn(
      async (_prompt: string, choices: string[]) => choices[0],
    );
    await commands.get("workflows").handler("", ctx);
    expect(fixture.run).not.toHaveBeenCalled();
    const job = [...workflowJobRegistry.values()][0];
    expect(job).toBeDefined();
    await expect(job.promise).resolves.toMatchObject({ result: "done" });
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

  it("reports an explicitly durable startup failure without falling back", async () => {
    writeFileSync(join(fixture.dir, "ready.js"), ready);
    fixture.run.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "Storage unavailable" }],
    });
    const { tools, ctx } = setup(true);
    const result = await tools
      .get("workflow")
      .execute(
        "durable-failure",
        { name: "ready", durable: true, async: true },
        undefined,
        undefined,
        ctx,
      );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Storage unavailable");
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("does not let readiness changes select durable mode while entering args", async () => {
    const file = join(fixture.dir, "ready.js");
    writeFileSync(file, ready);
    const { commands, ctx } = setup(true);
    Object.assign(ctx.ui, {
      editor: async () => {
        writeFileSync(file, legacy);
        return "{}";
      },
    });
    await commands.get("workflows").handler("ready", ctx);
    expect(fixture.run).not.toHaveBeenCalled();
    const job = [...workflowJobRegistry.values()][0];
    expect(job).toBeDefined();
    await expect(job.promise).resolves.toMatchObject({ result: "legacy" });
  });

  it("forwards the original task without saving or running a workflow", async () => {
    const { commands, ctx, pi } = setup();
    const task = "review my changes";
    await commands.get("workflow").handler(task, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(task),
      { deliverAs: "followUp" },
    );
    expect(fixture.save).not.toHaveBeenCalled();
    expect(readdirSync(fixture.dir)).toEqual([]);
    expect(fixture.run).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });
});

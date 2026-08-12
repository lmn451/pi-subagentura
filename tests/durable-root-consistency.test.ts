import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableWorkflowController } from "../src/workflow-durable-plan-runner";
import { registerInteractiveSupervisor } from "../src/interactive-supervisor-registration";
import { registerWorkflowTool } from "../src/workflow-tool";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const roots: string[] = [];

type ToolResult = {
  details: Record<string, unknown>;
  isError?: boolean;
};

type ToolDefinition = {
  name: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
};

type CommandContext = {
  ui: {
    notify: (...args: unknown[]) => unknown;
    custom: (...args: unknown[]) => unknown;
  };
  sessionManager: { getSessionId: () => string };
  cwd?: string;
};

type CommandDefinition = {
  handler: (args: string, context: unknown) => Promise<unknown> | unknown;
};

type ComponentFactory<Component> = (
  tui: { requestRender: () => void },
  theme: unknown,
  keyboard: unknown,
  done: (value: unknown) => void,
) => Component;

type TreeComponent = { render: (width: number) => string[] };
type SupervisorComponent = TreeComponent & {
  handleInput: (data: string) => void;
};

function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} was not registered`);
  return tool;
}

function commandNamed(
  commands: Map<string, CommandDefinition>,
  name: string,
): CommandDefinition {
  const command = commands.get(name);
  if (!command) throw new Error(`Command ${name} was not registered`);
  return command;
}

afterEach(async () => {
  clearSessionScopes();
  await WorkflowRunStore.releaseAllLeases();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable session root consistency", () => {
  it("uses the session root for tools, plan commands, tree, and supervisor cancellation", async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), "durable-session-root-"));
    roots.push(sessionRoot);
    expect(sessionRoot).not.toBe(process.cwd());

    const owner: WorkflowOwnerIdentity = {
      projectKey: "durable-root-consistency",
      cwd: sessionRoot,
      piSessionId: "session-root-consistency",
      ownerId: "owner-root-consistency",
      ownerGeneration: 0,
      leaseToken: "lease-root-consistency",
    };
    const store = new WorkflowRunStore({ rootDir: sessionRoot, owner });
    const runId = "session-root-run";
    await store.createRun({
      runId,
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append(runId, "run_created", {});
    await store.append(runId, "run_started", {});

    const tools: ToolDefinition[] = [];
    const workflowCommands = new Map<string, CommandDefinition>();
    const workflowPi = {
      registerTool: vi.fn((definition: unknown) => {
        if (isToolDefinition(definition)) tools.push(definition);
      }),
      registerCommand: vi.fn((name: string, definition: unknown) => {
        if (
          typeof definition === "object" &&
          definition !== null &&
          "handler" in definition &&
          typeof definition.handler === "function"
        ) {
          workflowCommands.set(name, {
            handler: definition.handler as CommandDefinition["handler"],
          });
        }
      }),
      on: vi.fn(),
      sendMessage: vi.fn(),
    };
    const scope = registerSessionScope({
      id: 901,
      generation: 0,
      lifecycle: "started",
      pi: workflowPi as unknown as Parameters<typeof registerWorkflowTool>[0],
      sessionManager: { getSessionId: () => owner.piSessionId },
      durableWorkflowOwner: owner,
    });
    registerWorkflowTool(
      workflowPi as unknown as Parameters<typeof registerWorkflowTool>[0],
      scope,
    );

    const durableStatus = await toolNamed(
      tools,
      "get_durable_workflow_status",
    ).execute("", { workflowId: runId });
    expect(durableStatus.details).toMatchObject({
      runId,
      status: "running",
    });

    const durableResult = await toolNamed(
      tools,
      "get_durable_workflow_result",
    ).execute("", { workflowId: runId });
    expect(durableResult).toMatchObject({
      isError: true,
      details: { workflowId: runId, status: "running" },
    });

    const workflowStatus = await toolNamed(
      tools,
      "get_workflow_status",
    ).execute("", { workflowId: runId });
    expect(workflowStatus.details).toMatchObject({
      durable: true,
      workflowId: runId,
      status: "running",
    });

    const workflowResult = await toolNamed(
      tools,
      "get_workflow_result",
    ).execute("", { workflowId: runId });
    expect(workflowResult).toMatchObject({
      isError: true,
      details: { durable: true, workflowId: runId, status: "running" },
    });

    const planNotify = vi.fn();
    const treeNotify = vi.fn();
    let treeRendered = "";
    const treeCustom = vi.fn(async (factory: unknown) => {
      const component = (factory as ComponentFactory<TreeComponent>)(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      );
      treeRendered = component.render(200).join("\n");
      return { kind: "close" };
    });
    const commandContext: CommandContext = {
      ui: { notify: planNotify, custom: treeCustom },
      sessionManager: { getSessionId: () => owner.piSessionId },
      cwd: sessionRoot,
    };
    await commandNamed(workflowCommands, "workflow-plan").handler(
      runId,
      commandContext,
    );
    expect(planNotify).toHaveBeenCalledWith(
      expect.stringContaining(`Durable workflow ${runId}: running`),
    );

    const statusNotify = vi.fn();
    await commandNamed(workflowCommands, "workflow-status").handler("", {
      ...commandContext,
      ui: { notify: statusNotify, custom: treeCustom },
    });
    expect(workflowPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(runId) }),
      { deliverAs: "followUp" },
    );

    await commandNamed(workflowCommands, "workflow-tree").handler("", {
      ...commandContext,
      ui: { notify: treeNotify, custom: treeCustom },
    });
    expect(treeRendered).toContain(runId);

    let supervisorRendered = "";
    let supervisorCommand: CommandDefinition | undefined;
    const supervisorPi = {
      registerShortcut: vi.fn(),
      registerCommand: vi.fn((name: string, definition: unknown) => {
        if (name !== "subagents") return;
        if (
          typeof definition === "object" &&
          definition !== null &&
          "handler" in definition &&
          typeof definition.handler === "function"
        ) {
          supervisorCommand = {
            handler: definition.handler as CommandDefinition["handler"],
          };
        }
      }),
    };
    registerInteractiveSupervisor(
      supervisorPi as unknown as Parameters<
        typeof registerInteractiveSupervisor
      >[0],
      scope,
    );
    const supervisorNotify = vi.fn();
    const supervisorCustom = vi.fn(async (factory: unknown) => {
      const component = (factory as ComponentFactory<SupervisorComponent>)(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      );
      supervisorRendered = component.render(200).join("\n");
      component.handleInput("x");
      return { kind: "close" };
    });
    const supervisorContext: CommandContext = {
      ui: { notify: supervisorNotify, custom: supervisorCustom },
      sessionManager: { getSessionId: () => owner.piSessionId },
    };
    if (!supervisorCommand)
      throw new Error("Supervisor command not registered");
    await supervisorCommand.handler("", supervisorContext);
    expect(supervisorRendered).toContain(runId);
    expect(supervisorNotify).toHaveBeenCalledWith(
      expect.stringContaining(`Cancelled ${runId}.`),
      "warning",
    );

    const cancelled = await toolNamed(tools, "cancel_workflow").execute("", {
      workflowId: runId,
    });
    expect(cancelled.details).toMatchObject({
      durable: true,
      workflowId: runId,
      status: "cancelled",
    });

    const directSessionProjection = await new DurableWorkflowController({
      store: new WorkflowRunStore({ rootDir: sessionRoot, owner }),
      owner,
    }).getStatus(runId);
    expect(directSessionProjection?.status).toBe("cancelled");

    const terminalResult = await toolNamed(
      tools,
      "get_durable_workflow_result",
    ).execute("", { workflowId: runId });
    expect(terminalResult.details).toMatchObject({
      workflowId: runId,
      status: "terminal",
      result: { status: "cancelled" },
    });
  });
});

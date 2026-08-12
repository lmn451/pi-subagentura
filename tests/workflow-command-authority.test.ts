import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowTool } from "../src/workflow";
import {
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
} from "../src/session-scope";

function projection(revision: number) {
  return {
    runId: "run-authority",
    planRevision: 0,
    owner: {
      projectKey: "project",
      cwd: process.cwd(),
      piSessionId: "session",
      ownerId: "owner",
      ownerGeneration: 3,
      leaseToken: "lease",
    },
    status: "blocked",
    revision,
    tasks: {},
    blockers: { tasks: {}, claims: {} },
    usage: { input: 0, output: 0 },
    lastEventOrdinal: 0,
  } as any;
}

afterEach(() => clearSessionScopes());

describe("registered durable plan command authority", () => {
  it("rejects a stale plan editor before invoking mutation", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const mutateTask = vi.fn();
    let journal = '{"eventOrdinal":5,"taskId":"task-1"}\n';
    const journalBefore = journal;
    const pi = {
      registerTool: vi.fn(),
      registerCommand: (name: string, command: { handler: Function }) =>
        commands.push({ name, handler: command.handler }),
      sendMessage: vi.fn(),
    } as any;
    const scope = createSessionScope(pi);
    scope.lifecycle = "started";
    scope.durableWorkflowOwner = projection(0).owner;
    scope.durableWorkflowStore = { getLeaseEpoch: async () => 7 } as any;
    scope.durableWorkflowController = {
      getStatus: async () => projection(5),
      mutateTask,
    } as any;
    registerSessionScope(scope);
    registerWorkflowTool(pi, scope);

    const command = commands.find((item) => item.name === "workflow-plan-edit");
    await command?.handler(
      `run-authority 4 3 7 ${scope.generation} block task-1`,
      { ui: { notify: vi.fn() } },
    );

    expect(mutateTask).not.toHaveBeenCalled();
    expect(journal).toBe(journalBefore);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "workflow-command",
        content: expect.stringContaining("stale"),
      }),
      { deliverAs: "followUp" },
    );
  });

  it("passes the complete authority envelope to a current plan editor", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const mutateTask = vi.fn(async () => projection(6));
    const pi = {
      registerTool: vi.fn(),
      registerCommand: (name: string, command: { handler: Function }) =>
        commands.push({ name, handler: command.handler }),
      sendMessage: vi.fn(),
    } as any;
    const scope = createSessionScope(pi);
    scope.lifecycle = "started";
    scope.durableWorkflowOwner = projection(0).owner;
    scope.durableWorkflowStore = { getLeaseEpoch: async () => 7 } as any;
    scope.durableWorkflowController = {
      getStatus: async () => projection(5),
      mutateTask,
    } as any;
    registerSessionScope(scope);
    registerWorkflowTool(pi, scope);

    const command = commands.find(
      (item) => item.name === "workflow-plan-mutate",
    );
    await command?.handler(
      `run-authority 5 ${scope.generation} 7 ${scope.generation} block task-1`,
      { ui: { notify: vi.fn() } },
    );

    expect(mutateTask).toHaveBeenCalledWith("run-authority", {
      type: "block",
      taskId: "task-1",
      expectedRevision: 5,
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowTool } from "../src/workflow-tool";
import {
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
  sessionOwner,
} from "../src/session-scope";
import {
  cancelWorkflowJob,
  startWorkflowJob,
  workflowJobRegistry,
} from "../src/workflow-jobs";

// Tool registration without ownership must not start or borrow a peer session.
describe("workflow registration requires session ownership", () => {
  beforeEach(() => {
    clearSessionScopes();
    workflowJobRegistry.clear();
  });

  afterEach(() => {
    for (const job of workflowJobRegistry.values()) {
      job.suppressCompletionNotification = true;
      cancelWorkflowJob(job, "explicit_cancel");
    }
    workflowJobRegistry.clear();
    clearSessionScopes();
  });

  it.each([false, true])(
    "rejects ownerless registration with async=%s while a peer is live",
    async (asyncMode) => {
      const tools = new Map<string, any>();
      const pi = {
        registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
        registerMessageRenderer: vi.fn(),
        sendMessage: vi.fn(),
        on: vi.fn(),
      } as any;
      const peer = createSessionScope(pi);
      peer.lifecycle = "started";
      registerSessionScope(peer);
      registerWorkflowTool(pi);

      const result = await tools.get("workflow").execute(
        "ownerless-invocation",
        {
          script:
            'export const meta = { name: "ownerless", description: "ownership probe" }; return 42;',
          async: asyncMode,
        },
        undefined,
        undefined,
        { cwd: process.cwd(), ui: { notify: vi.fn() } },
      );

      expect(result.isError).toBe(true);
      expect(result.details).toEqual({
        status: "session_unavailable",
        error: expect.any(String),
      });
      expect(workflowJobRegistry.size).toBe(0);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects ownerless jobs before building execution options", () => {
    const buildOptions = vi.fn(() => ({
      cwd: process.cwd(),
      runAgent: async () => {
        throw new Error("Unexpected agent invocation");
      },
    }));

    expect(() =>
      startWorkflowJob(
        "ownerless-direct",
        'export const meta = { name: "ownerless", description: "ownership probe" }; return 42;',
        buildOptions,
      ),
    ).toThrow(/live session/);
    expect(buildOptions).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });

  it.each(["stale", "shutdown"] as const)(
    "rejects a %s owner before building execution options",
    (reason) => {
      const scope = createSessionScope({} as any);
      const owner = sessionOwner(scope);
      const buildOptions = vi.fn(() => ({
        cwd: process.cwd(),
        runAgent: async () => {
          throw new Error("Unexpected agent invocation");
        },
      }));
      scope.lifecycle = "started";
      registerSessionScope(scope);
      if (reason === "stale") scope.generation++;
      else scope.lifecycle = "shutdown";

      expect(() =>
        startWorkflowJob(
          "retired-owner",
          'export const meta = { name: "retired", description: "ownership probe" }; return 42;',
          buildOptions,
          undefined,
          undefined,
          owner,
        ),
      ).toThrow(/live session/);
      expect(buildOptions).not.toHaveBeenCalled();
      expect(workflowJobRegistry.size).toBe(0);
    },
  );
});

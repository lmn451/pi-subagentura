import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withOrchestrationContext } from "../src/orchestration-context";
import {
  registerWorkflowEagerRouting,
  type WorkflowEagerRegistrationOptions,
} from "../src/workflow-eager";
import type { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import {
  startDurableWorkflowPlanJob,
  workflowJobRegistry,
  type WorkflowPlanJobState,
} from "../src/workflow-jobs";
import type { WorkflowPlanDefinition } from "../src/workflow-plan";
import { createSessionScope, type SessionScope } from "../src/session-scope";

const COMPLEX_TASK =
  "Implement the release:\n1. Update the parser\n2. Add regression tests";

type CapturedHandler = (...args: unknown[]) => unknown;
interface CapturedCommand {
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

function createApi(mode: unknown) {
  const handlers = new Map<string, CapturedHandler[]>();
  const commands = new Map<string, CapturedCommand>();
  const pi = {
    getFlag: vi.fn((name: string) =>
      name === "workflow-eager" ? mode : undefined,
    ),
    on: vi.fn((name: string, handler: CapturedHandler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
    registerCommand: vi.fn((name: string, command: CapturedCommand) => {
      commands.set(name, command);
    }),
    registerFlag: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  return Object.assign(pi, { handlers, commands });
}

function createHarness(
  mode: unknown,
  options: WorkflowEagerRegistrationOptions = {},
) {
  const pi = createApi(mode);
  const scope = createSessionScope(pi as unknown as ExtensionAPI);
  scope.generation = 1;
  scope.lifecycle = "started";
  registerWorkflowEagerRouting(pi as unknown as ExtensionAPI, scope, options);
  return { pi, scope, handlers: pi.handlers, commands: pi.commands };
}

function eventHandler(
  harness: { readonly handlers: ReadonlyMap<string, CapturedHandler[]> },
  name: string,
): CapturedHandler {
  const handler = harness.handlers.get(name)?.[0];
  if (handler === undefined) throw new Error(`missing ${name} handler`);
  return handler;
}

function controllerWith(
  projections: readonly Record<string, unknown>[] = [],
  additions: Record<string, unknown> = {},
): DurableWorkflowPlanController {
  return {
    owner: { projectKey: "project", piSessionKey: "session" },
    repository: { list: vi.fn().mockResolvedValue(projections) },
    ...additions,
  } as unknown as DurableWorkflowPlanController;
}

function runningJob(id = "wfr-v1-eager"): WorkflowPlanJobState {
  return {
    id,
    kind: "plan",
    name: "eager",
    status: "running",
  } as unknown as WorkflowPlanJobState;
}

function promptResult(value: unknown): { readonly systemPrompt: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("systemPrompt" in value) ||
    typeof value.systemPrompt !== "string"
  ) {
    throw new Error("expected a system-prompt routing result");
  }
  return { systemPrompt: value.systemPrompt };
}

function beforeEvent(prompt = COMPLEX_TASK) {
  return { prompt, systemPrompt: "base prompt", systemPromptOptions: {} };
}

describe("workflow eager runtime", () => {
  beforeEach(() => {
    workflowJobRegistry.clear();
  });

  afterEach(() => {
    workflowJobRegistry.clear();
  });

  it("registers workflow-eager as a string flag defaulting to off and leaves requests direct", async () => {
    const getController =
      vi.fn<
        (scope: SessionScope) => DurableWorkflowPlanController | undefined
      >();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    const harness = createHarness("off", {
      getController,
      startPlanJob,
    });

    expect(harness.pi.registerFlag).toHaveBeenCalledWith("workflow-eager", {
      description: expect.any(String),
      type: "string",
      default: "off",
    });
    expect(
      await eventHandler(harness, "before_agent_start")(beforeEvent()),
    ).toBeUndefined();
    expect(getController).not.toHaveBeenCalled();
    expect(startPlanJob).not.toHaveBeenCalled();
  });

  it("creates and starts a durable plan in the same parent turn without a completion callback", async () => {
    const controller = controllerWith();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    startPlanJob.mockResolvedValue(runningJob());
    const harness = createHarness("always", {
      getController: () => controller,
      startPlanJob,
    });

    const result = promptResult(
      await eventHandler(harness, "before_agent_start")(beforeEvent()),
    );

    expect(startPlanJob).toHaveBeenCalledOnce();
    const [
      plan,
      passedController,
      options,
      startedAt,
      onComplete,
      owner,
      mode,
    ] = startPlanJob.mock.calls[0]!;
    const validatedPlan: WorkflowPlanDefinition = plan;
    expect(passedController).toBe(controller);
    expect(options).toEqual({});
    expect(startedAt).toEqual(expect.any(Number));
    expect(onComplete).toBeUndefined();
    expect(owner).toEqual({ id: harness.scope.id, generation: 1 });
    expect(mode).toBe("async");
    expect(
      validatedPlan.phases.every((phase) => phase.mode === "sequence"),
    ).toBe(true);
    expect(
      validatedPlan.phases
        .flatMap((phase) => phase.tasks)
        .every((task) => task.agent?.isolation === "in-process"),
    ).toBe(true);
    expect(result.systemPrompt).toContain(
      "The host created and started durable workflow plan wfr-v1-eager",
    );
    expect(result.systemPrompt).toContain(
      "Do not perform, dispatch, or start duplicate direct work",
    );
  });

  it("suppresses eager routing inside an in-process orchestration context", async () => {
    const getController =
      vi.fn<
        (scope: SessionScope) => DurableWorkflowPlanController | undefined
      >();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    const harness = createHarness("always", {
      getController,
      startPlanJob,
    });

    const result = await withOrchestrationContext(
      { ownerJobId: "child-job", depth: 1 },
      () => eventHandler(harness, "before_agent_start")(beforeEvent()),
    );

    expect(result).toBeUndefined();
    expect(getController).not.toHaveBeenCalled();
    expect(startPlanJob).not.toHaveBeenCalled();
  });

  it("continues an active durable projection without planning or starting another run", async () => {
    const controller = controllerWith([
      { runId: "wfr-v1-active", status: "blocked" },
    ]);
    const draftFactory = vi.fn();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    const harness = createHarness("always", {
      draftFactory,
      getController: () => controller,
      startPlanJob,
    });

    const result = promptResult(
      await eventHandler(harness, "before_agent_start")(beforeEvent()),
    );

    expect(draftFactory).not.toHaveBeenCalled();
    expect(startPlanJob).not.toHaveBeenCalled();
    expect(result.systemPrompt).toContain("active workflow wfr-v1-active");
    expect(result.systemPrompt).toContain("Do not create another workflow");
  });

  it("continues an owner-scoped live plan even before its durable projection is visible", async () => {
    const getController =
      vi.fn<
        (scope: SessionScope) => DurableWorkflowPlanController | undefined
      >();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    const harness = createHarness("always", {
      getController,
      startPlanJob,
    });
    workflowJobRegistry.set("wfr-v1-live", {
      ...runningJob("wfr-v1-live"),
      parentSessionOwner: { id: harness.scope.id, generation: 1 },
    });

    const result = promptResult(
      await eventHandler(harness, "before_agent_start")(beforeEvent()),
    );

    expect(startPlanJob).not.toHaveBeenCalled();
    expect(getController).not.toHaveBeenCalled();
    expect(result.systemPrompt).toContain("active workflow wfr-v1-live");
  });

  it("rejects an invalid process-isolated draft before job creation or dispatch", async () => {
    const childDispatch = vi.fn();
    const controller = controllerWith([], { startPlan: childDispatch });
    const draftFactory = vi.fn(() => ({
      name: "invalid-eager-plan",
      description: "invalid process-isolated plan",
      phases: [
        {
          id: "phase-1",
          name: "Phase 1",
          mode: "sequence",
          tasks: [
            {
              id: "task-1",
              content: "Invalid task",
              instruction: "Do invalid work",
              agent: { isolation: "process" },
            },
          ],
        },
      ],
    }));
    const harness = createHarness("always", {
      draftFactory,
      getController: () => controller,
    });

    const result = promptResult(
      await eventHandler(harness, "before_agent_start")(beforeEvent()),
    );

    expect(draftFactory).toHaveBeenCalledTimes(2);
    expect(childDispatch).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
    expect(result.systemPrompt).toContain("Automatic workflow routing failed:");
    expect(result.systemPrompt).toContain("/workflow-plan create <task>");
    expect(result.systemPrompt).not.toContain("/workflow " + COMPLEX_TASK);
  });

  it("surfaces an exact durable start failure and removes the provisional live job", async () => {
    const startPlan = vi
      .fn()
      .mockRejectedValue(new Error("journal unavailable"));
    const controller = controllerWith([], { startPlan });
    const harness = createHarness("always", {
      getController: () => controller,
    });

    const result = promptResult(
      await eventHandler(harness, "before_agent_start")(beforeEvent()),
    );

    expect(startPlan).toHaveBeenCalledOnce();
    expect(workflowJobRegistry.size).toBe(0);
    expect(result.systemPrompt).toContain(
      "Automatic workflow routing failed: journal unavailable",
    );
    expect(result.systemPrompt).toContain("/workflow-plan create <task>");
  });

  it("does not clear a pending policy route for legacy workflow execution", async () => {
    const harness = createHarness("always", {
      getController: () => undefined,
    });
    const before = eventHandler(harness, "before_agent_start");
    const toolStarted = eventHandler(harness, "tool_execution_start");
    const settled = eventHandler(harness, "agent_settled");

    const policy = promptResult(await before(beforeEvent()));
    expect(policy.systemPrompt).toContain("not host-enforced");
    expect(policy.systemPrompt).toContain("durable: true");
    toolStarted({
      toolName: "workflow",
      args: {
        script: "return await agent('unrelated work')",
        durable: true,
        async: true,
      },
    });
    settled({ type: "agent_settled" });

    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "routing_unconfirmed",
        content: expect.stringContaining(
          "payload did not prove the requested declarative durable route",
        ),
        details: expect.objectContaining({
          status: "routing_unconfirmed",
          observedTools: { workflow: true, workflow_plan: false },
        }),
      }),
      { triggerTurn: false },
    );
  });

  it("observes workflow_plan without treating its management payload as route creation evidence", async () => {
    const harness = createHarness("always", {
      getController: () => undefined,
    });
    const before = eventHandler(harness, "before_agent_start");
    const toolStarted = eventHandler(harness, "tool_execution_start");
    const settled = eventHandler(harness, "agent_settled");

    const policy = promptResult(await before(beforeEvent()));
    expect(policy.systemPrompt).toContain(
      "`workflow_plan` tool only views or mutates an existing durable plan",
    );
    toolStarted({
      toolName: "workflow_plan",
      args: {
        workflowId: "wfr-v1-other",
        action: { operation: "view" },
      },
    });
    settled({ type: "agent_settled" });

    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "routing_unconfirmed",
        content: expect.stringContaining(
          "view/mutation payload cannot prove that the pending route was created or started",
        ),
        details: expect.objectContaining({
          status: "routing_unconfirmed",
          observedTools: { workflow: false, workflow_plan: true },
        }),
      }),
      { triggerTurn: false },
    );
  });

  it("keeps an unrelated declarative plan explicitly unconfirmed", async () => {
    const harness = createHarness("always", {
      getController: () => undefined,
    });
    const before = eventHandler(harness, "before_agent_start");
    const toolStarted = eventHandler(harness, "tool_execution_start");
    const settled = eventHandler(harness, "agent_settled");

    await before(beforeEvent());
    toolStarted({
      toolName: "workflow",
      args: {
        durable: true,
        async: true,
        plan: {
          name: "Unrelated route",
          description: "Inspect an unrelated module",
          phases: [
            {
              id: "phase-unrelated",
              name: "Unrelated work",
              mode: "sequence",
              tasks: [
                {
                  id: "task-unrelated",
                  content: "Inspect unrelated module",
                  instruction: "Inspect an unrelated module",
                  agent: { isolation: "in-process" },
                },
              ],
            },
          ],
        },
      },
    });
    settled({ type: "agent_settled" });

    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "routing_unconfirmed",
        details: expect.objectContaining({
          status: "routing_unconfirmed",
          observedTools: { workflow: true, workflow_plan: false },
        }),
      }),
      { triggerTurn: false },
    );
  });

  it("recognizes a matching declarative durable policy route", async () => {
    const harness = createHarness("always", {
      getController: () => undefined,
    });
    const before = eventHandler(harness, "before_agent_start");
    const toolStarted = eventHandler(harness, "tool_execution_start");
    const settled = eventHandler(harness, "agent_settled");

    await before(beforeEvent());
    toolStarted({
      toolName: "workflow",
      args: {
        durable: true,
        async: true,
        plan: {
          name: "Eager policy route",
          description: COMPLEX_TASK,
          phases: [
            {
              id: "phase-1",
              name: "Update parser",
              mode: "sequence",
              tasks: [
                {
                  id: "task-1",
                  content: "Update the parser",
                  instruction: "Update the parser",
                  agent: { isolation: "in-process" },
                },
              ],
            },
            {
              id: "phase-2",
              name: "Add tests",
              mode: "sequence",
              tasks: [
                {
                  id: "task-2",
                  content: "Add regression tests",
                  instruction: "Add regression tests",
                  agent: { isolation: "in-process" },
                },
              ],
            },
          ],
        },
      },
    });
    settled({ type: "agent_settled" });

    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("reports routing_unconfirmed when no observable route evidence exists", async () => {
    const harness = createHarness("always", {
      getController: () => undefined,
    });
    const before = eventHandler(harness, "before_agent_start");
    const settled = eventHandler(harness, "agent_settled");

    await before(beforeEvent());
    settled({ type: "agent_settled" });

    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "routing_unconfirmed",
        content: expect.stringContaining(
          "No workflow routing tool call was observed",
        ),
        details: expect.objectContaining({
          status: "routing_unconfirmed",
          observedTools: { workflow: false, workflow_plan: false },
        }),
      }),
      { triggerTurn: false },
    );
  });

  it("runs /workflow-plan create through the host path while the eager flag is off", async () => {
    const controller = controllerWith();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    startPlanJob.mockResolvedValue(runningJob("wfr-v1-command"));
    const harness = createHarness("off", {
      getController: () => controller,
      startPlanJob,
    });

    await harness.commands
      .get("workflow-plan")!
      .handler("create audit authentication and billing", {});

    expect(startPlanJob).toHaveBeenCalledOnce();
    expect(startPlanJob.mock.calls[0]![4]).toBeUndefined();
    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "workflow-plan",
        content: expect.stringContaining(
          "Started durable workflow plan wfr-v1-command",
        ),
      }),
      { triggerTurn: false },
    );
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports strict command usage and exact host errors without a legacy user-message fallback", async () => {
    const controller = controllerWith();
    const startPlanJob = vi.fn<typeof startDurableWorkflowPlanJob>();
    startPlanJob.mockRejectedValue(new Error("lease denied"));
    const harness = createHarness("off", {
      getController: () => controller,
      startPlanJob,
    });
    const command = harness.commands.get("workflow-plan")!.handler;

    await command("", {});
    await command("run something", {});
    expect(startPlanJob).not.toHaveBeenCalled();
    expect(harness.pi.sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content:
          "Usage: /workflow-plan create <task> | view/export/edit/append/skip/approve/deny/resume ...",
      }),
      { triggerTurn: false },
    );
    expect(harness.pi.sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content:
          "Usage: /workflow-plan create <task> | view/export/edit/append/skip/approve/deny/resume ...",
      }),
      { triggerTurn: false },
    );

    await command("create reconcile durable state", {});
    expect(harness.pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "lease denied" }),
      { triggerTurn: false },
    );
    expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

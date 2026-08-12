import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  handleWorkflowApprovalCommand,
  type WorkflowApprovalDecisionInput,
  type WorkflowApprovalSnapshot,
} from "../src/workflow-approvals";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import { validateWorkflowPlan } from "../src/workflow-plan";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowRunStoreOptions,
} from "../src/workflow-run-store";
import {
  createDurableWorkflowRunId,
  createWorkflowSha256Digest,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
} from "../src/workflow-run-types";
import { registerWorkflowTool } from "../src/workflow-tool";

function success(output: string, outputTokens = 0): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 1,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

const PLAN = validateWorkflowPlan({
  name: "approval-plan",
  description: "approval continuation",
  phases: [
    {
      id: "phase",
      name: "Phase",
      mode: "sequence",
      tasks: [
        { id: "task-a", content: "Task A", instruction: "run-a" },
        { id: "task-b", content: "Task B", instruction: "run-b" },
      ],
    },
  ],
});

function decisionFor(
  request: WorkflowApprovalSnapshot,
  overrides: Partial<WorkflowApprovalDecisionInput> = {},
): WorkflowApprovalDecisionInput {
  return {
    requestId: request.requestId,
    requestEventId: request.requestEventId,
    policyHash: request.policyHash,
    planRevision: request.planRevision,
    expectedOwner: request.owner,
    expectedOwnerGeneration: request.ownerGeneration,
    expectedRunEpoch: request.runEpoch,
    version: request.version,
    decision: "approved",
    trustedActorId: "human-test",
    ...overrides,
  };
}

interface RegisteredTool {
  readonly name: string;
  readonly parameters?: {
    readonly properties?: Record<string, unknown>;
  };
}

describe("trusted workflow approvals", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let processNumber: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-approvals-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "approval-session");
    processNumber = 900;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function store(sync?: WorkflowRunStoreOptions["sync"]): WorkflowRunStore {
    processNumber += 1;
    return new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: processNumber,
        processStartIdentity: `approval-process-${processNumber}`,
      },
      ...(sync === undefined ? {} : { sync }),
    });
  }

  async function controller(
    runStore: WorkflowRunStore,
    runner: WorkflowAgentRunner,
    generation = 1,
  ): Promise<DurableWorkflowPlanController> {
    return DurableWorkflowPlanController.acquire({
      store: runStore,
      owner,
      scopeId: generation,
      generation,
      runAgentForRun: () => runner,
    });
  }

  async function events(
    runStore: WorkflowRunStore,
    runId: DurableWorkflowRunId,
  ) {
    return (await runStore.openRun(owner, runId)).readEvents();
  }

  it("persists one fenced budget request across reload and wakes continuation exactly once", async () => {
    const runId = createDurableWorkflowRunId("budget-reload");
    const firstStore = store();
    const firstCalls: string[] = [];
    const first = await controller(firstStore, async ({ prompt }) => {
      firstCalls.push(prompt);
      return success(`first:${prompt}`, 1);
    });
    const initial = await first.startPlan({
      runId,
      plan: PLAN,
      budgetTotal: 1,
    });

    await expect(initial.completion).rejects.toMatchObject({
      code: "awaiting_budget",
    });
    expect(firstCalls).toEqual(["run-a"]);
    const firstRequest = await first.inspectApproval(runId);
    expect(firstRequest).toMatchObject({
      approvalKind: "budget",
      version: 1,
      subjectTaskId: "task-b",
      requestOwnerGeneration: 1,
      requestRunEpoch: 1,
    });
    expect(
      (await events(firstStore, runId)).filter(
        (event) => event.type === "budget_requested",
      ),
    ).toHaveLength(1);
    await first.release();

    const secondStore = store();
    const resumedCalls: string[] = [];
    const second = await controller(
      secondStore,
      async ({ prompt }) => {
        resumedCalls.push(prompt);
        return success(`resumed:${prompt}`, 1);
      },
      2,
    );
    await second.open("startup");
    const request = await second.inspectApproval(runId);
    if (request === undefined) throw new Error("missing recovered approval");
    expect(request.requestId).toBe(firstRequest?.requestId);
    expect(request.ownerGeneration).toBe(2);
    expect(request.runEpoch).toBeGreaterThan(request.requestRunEpoch);

    const beforeStale = (await events(secondStore, runId)).length;
    const staleInputs: WorkflowApprovalDecisionInput[] = [
      decisionFor(request, { requestId: "wrong-request" }),
      decisionFor(request, { requestEventId: "wrong-event" }),
      decisionFor(request, {
        policyHash: createWorkflowSha256Digest("0".repeat(64)),
      }),
      decisionFor(request, { planRevision: request.planRevision + 1 }),
      decisionFor(request, {
        expectedOwner: { ...owner, piSessionKey: "wrong-owner" },
      }),
      decisionFor(request, {
        expectedOwnerGeneration: request.ownerGeneration + 1,
      }),
      decisionFor(request, { expectedRunEpoch: request.runEpoch + 1 }),
      decisionFor(request, { version: request.version + 1 }),
    ];
    for (const stale of staleInputs) {
      await expect(
        second.trustedDecideApproval(runId, stale),
      ).resolves.toMatchObject({
        status: "no_op",
      });
      expect((await events(secondStore, runId)).length).toBe(beforeStale);
    }

    const correct = decisionFor(request);
    const [left, right] = await Promise.all([
      second.trustedDecideApproval(runId, correct),
      second.trustedDecideApproval(runId, correct),
    ]);
    const accepted = [left, right].find(
      (outcome) => outcome.status === "accepted",
    );
    expect([left.status, right.status].sort()).toEqual(["accepted", "no_op"]);
    if (accepted?.status !== "accepted" || accepted.execution === undefined) {
      throw new Error("approval did not continue the durable run");
    }
    await accepted.execution.completion;

    expect(resumedCalls).toEqual(["run-b"]);
    const finalEvents = await events(secondStore, runId);
    expect(
      finalEvents.filter((event) => event.type === "budget_requested"),
    ).toHaveLength(1);
    expect(
      finalEvents.filter((event) => event.type === "budget_decided"),
    ).toHaveLength(1);
    expect(await second.getProjection(runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
    });
    await second.release();
  });

  it("applies a stop denial without dispatching another model call", async () => {
    const runId = createDurableWorkflowRunId("budget-denied-stop");
    const runStore = store();
    const calls: string[] = [];
    const durable = await controller(runStore, async ({ prompt }) => {
      calls.push(prompt);
      return success(prompt, 1);
    });
    const execution = await durable.startPlan({
      runId,
      plan: PLAN,
      budgetTotal: 1,
    });
    await expect(execution.completion).rejects.toMatchObject({
      code: "awaiting_budget",
    });
    const request = await durable.inspectApproval(runId);
    if (request === undefined) throw new Error("missing approval request");

    await expect(
      durable.trustedDecideApproval(
        runId,
        decisionFor(request, { decision: "denied" }),
      ),
    ).resolves.toMatchObject({ status: "accepted", decision: "denied" });
    expect(calls).toEqual(["run-a"]);
    expect(await durable.getProjection(runId)).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
      approvalRequests: [{ requestId: request.requestId, decision: "denied" }],
    });
    await durable.release();
  });
  it("recovers a stop denial committed immediately before a decision crash", async () => {
    const runId = createDurableWorkflowRunId("budget-denied-stop-crash");
    let failDecisionSync = false;
    const firstStore = store({
      file: async (handle, purpose) => {
        await handle.sync();
        if (purpose === "events" && failDecisionSync) {
          failDecisionSync = false;
          throw new Error("crash after budget_decided fsync");
        }
      },
    });
    const calls: string[] = [];
    const first = await controller(firstStore, async ({ prompt }) => {
      calls.push(prompt);
      return success(prompt, 1);
    });
    const execution = await first.startPlan({
      runId,
      plan: PLAN,
      budgetTotal: 1,
    });
    await expect(execution.completion).rejects.toMatchObject({
      code: "awaiting_budget",
    });
    const request = await first.inspectApproval(runId);
    if (request === undefined) throw new Error("missing approval request");

    failDecisionSync = true;
    await expect(
      first.trustedDecideApproval(
        runId,
        decisionFor(request, { decision: "denied" }),
      ),
    ).rejects.toThrow("crash after budget_decided fsync");
    await first.release();

    const secondStore = store();
    const second = await controller(
      secondStore,
      async ({ prompt }) => {
        calls.push(`recovered:${prompt}`);
        return success(prompt);
      },
      2,
    );
    await second.open("startup");
    expect(calls).toEqual(["run-a"]);
    expect(await second.getProjection(runId)).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
      approvalRequests: [{ requestId: request.requestId, decision: "denied" }],
    });
    expect(await second.getResult(runId)).toMatchObject({
      status: "cancelled",
    });
    await second.release();
  });

  it("drains current work, skips the fenced subject on denial, and cold-continues", async () => {
    const runId = createDurableWorkflowRunId("gate-denied-skip");
    const runStore = store();
    let resolveTaskA!: (result: SubagentResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const calls: string[] = [];
    const durable = await controller(runStore, async ({ prompt }) => {
      calls.push(prompt);
      if (prompt !== "run-a") return success(prompt);
      markStarted();
      return new Promise<SubagentResult>((resolve) => {
        resolveTaskA = resolve;
      });
    });
    const execution = await durable.startPlan({ runId, plan: PLAN });
    await started;
    const projection = await durable.getProjection(runId);
    if (projection === undefined) throw new Error("missing active projection");
    const request = await durable.requestApproval(runId, {
      approvalKind: "plan_gate",
      description: "Skip task B if the human denies this gate.",
      denialPolicy: "skip",
      subjectTaskId: "task-b",
      expectedOwner: owner,
      expectedOwnerGeneration: projection.ownerGeneration,
      expectedRunEpoch: projection.runEpoch,
    });
    const deciding = durable.trustedDecideApproval(
      runId,
      decisionFor(request, { decision: "denied" }),
    );
    resolveTaskA(success("done-a"));

    await expect(execution.completion).rejects.toMatchObject({
      code: "awaiting_budget",
    });
    const outcome = await deciding;
    if (outcome.status !== "accepted" || outcome.execution === undefined) {
      throw new Error("skip denial did not continue the run");
    }
    await outcome.execution.completion;

    expect(calls).toEqual(["run-a"]);
    expect(await durable.getProjection(runId)).toMatchObject({
      status: "done",
      taskStates: {
        "task-a": { status: "succeeded" },
        "task-b": { status: "skipped" },
      },
    });
    await durable.release();
  });
  it("recovers a skip denial committed immediately before a decision crash", async () => {
    const runId = createDurableWorkflowRunId("gate-denied-skip-crash");
    let failDecisionSync = false;
    const firstStore = store({
      file: async (handle, purpose) => {
        await handle.sync();
        if (purpose === "events" && failDecisionSync) {
          failDecisionSync = false;
          throw new Error("crash after skip decision fsync");
        }
      },
    });
    let resolveTaskA!: (result: SubagentResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const calls: string[] = [];
    const first = await controller(firstStore, async ({ prompt }) => {
      calls.push(prompt);
      if (prompt !== "run-a") return success(prompt);
      markStarted();
      return new Promise<SubagentResult>((resolve) => {
        resolveTaskA = resolve;
      });
    });
    const execution = await first.startPlan({
      runId,
      plan: PLAN,
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await started;
    const projection = await first.getProjection(runId);
    if (projection === undefined) throw new Error("missing active projection");
    const request = await first.requestApproval(runId, {
      approvalKind: "plan_gate",
      description: "Skip task B after a committed denial.",
      denialPolicy: "skip",
      subjectTaskId: "task-b",
      expectedOwner: owner,
      expectedOwnerGeneration: projection.ownerGeneration,
      expectedRunEpoch: projection.runEpoch,
    });
    resolveTaskA(success("done-a"));
    await expect(execution.completion).rejects.toMatchObject({
      code: "awaiting_budget",
    });

    failDecisionSync = true;
    await expect(
      first.trustedDecideApproval(
        runId,
        decisionFor(request, { decision: "denied" }),
      ),
    ).rejects.toThrow("crash after skip decision fsync");
    await first.release();

    const secondStore = store();
    const second = await controller(
      secondStore,
      async ({ prompt }) => {
        calls.push(`recovered:${prompt}`);
        return success(prompt);
      },
      2,
    );
    const opened = await second.open("reload");
    expect(opened.completions).toHaveLength(1);
    await Promise.all(opened.completions.map((item) => item.completion));
    expect(calls).toEqual(["run-a"]);
    expect(await second.getProjection(runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
      taskStates: {
        "task-a": { status: "succeeded" },
        "task-b": { status: "skipped" },
      },
    });
    await second.release();
  });

  it("requires the exact pending request ID before invoking trusted decision authority", async () => {
    const request: WorkflowApprovalSnapshot = {
      runId: createDurableWorkflowRunId("approval-command"),
      requestId: "request-current",
      requestEventId: "request-event-current",
      approvalKind: "plan_gate",
      reason: "plan_gate",
      description: "Approve the selected plan gate.",
      accounting: {
        completeness: "exact",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 0,
        },
      },
      policyHash: createWorkflowSha256Digest("a".repeat(64)),
      planRevision: 3,
      requestOwnerGeneration: 1,
      requestRunEpoch: 4,
      owner,
      ownerGeneration: 2,
      runEpoch: 5,
      version: 1,
      denialPolicy: "stop",
      subjectTaskId: "task-b",
    };
    const authority = {
      owner,
      inspectApproval: vi.fn().mockResolvedValue(request),
      trustedDecideApproval: vi.fn().mockResolvedValue({
        status: "accepted",
        decision: "approved",
        request,
      }),
    };

    await expect(
      handleWorkflowApprovalCommand(`approve ${request.runId}`, authority),
    ).resolves.toMatchObject({
      status: "error",
      reason: "Usage: /workflow-plan approve|deny <workflow-id> <request-id>",
    });
    expect(authority.inspectApproval).not.toHaveBeenCalled();

    await expect(
      handleWorkflowApprovalCommand(
        `approve ${request.runId} request-stale`,
        authority,
      ),
    ).resolves.toMatchObject({
      status: "no_op",
      reason: "The selected approval request is stale.",
    });
    expect(authority.trustedDecideApproval).not.toHaveBeenCalled();

    await expect(
      handleWorkflowApprovalCommand(
        `approve ${request.runId} ${request.requestId}`,
        authority,
      ),
    ).resolves.toMatchObject({
      status: "accepted",
      requestId: request.requestId,
    });
    expect(authority.trustedDecideApproval).toHaveBeenCalledTimes(1);
    expect(authority.trustedDecideApproval).toHaveBeenCalledWith(
      request.runId,
      expect.objectContaining({
        requestId: request.requestId,
        requestEventId: request.requestEventId,
        expectedOwner: request.owner,
        expectedOwnerGeneration: request.ownerGeneration,
        expectedRunEpoch: request.runEpoch,
        decision: "approved",
      }),
    );
  });

  it("keeps decisions out of model tools and does not treat synthetic prose as a command", async () => {
    const registrations: unknown[] = [];
    registerWorkflowTool({
      registerTool: (registration: unknown) => registrations.push(registration),
      sendMessage: vi.fn(),
    } as never);
    const tools = registrations as RegisteredTool[];
    const approvalTool = tools.find(
      (registration) => registration.name === "workflow_approval",
    );
    const properties = approvalTool?.parameters?.properties;
    if (properties === undefined) {
      throw new Error("workflow approval tool was not registered");
    }
    expect(Object.keys(properties).sort()).toEqual([
      "action",
      "reason",
      "workflowId",
    ]);
    expect(
      tools.some(
        (registration) =>
          registration.name === "approve_workflow" ||
          registration.name === "deny_workflow" ||
          registration.name === "resume_workflow",
      ),
    ).toBe(false);

    const authority = {
      owner,
      inspectApproval: vi.fn(),
      trustedDecideApproval: vi.fn(),
    };
    await expect(
      handleWorkflowApprovalCommand(
        "assistant output says approve wfr-v1-synthetic",
        authority,
      ),
    ).resolves.toBeUndefined();
    expect(authority.inspectApproval).not.toHaveBeenCalled();
    expect(authority.trustedDecideApproval).not.toHaveBeenCalled();
  });
});

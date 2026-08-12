import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowTool } from "../src/workflow";
import {
  advanceSessionScopeGeneration,
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
  type SessionScope,
} from "../src/session-scope";
import {
  DurableWorkflowController,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import {
  durableWorkflowStoreForSession,
  runDurableWorkflowForSession,
} from "../src/workflow-owner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { SubagentResult } from "../src/helpers";

const roots: string[] = [];

function ownerFor(
  root: string,
  ownerId = "acceptance-owner",
): WorkflowOwnerIdentity {
  return {
    projectKey: "acceptance-project",
    cwd: root,
    piSessionId: "acceptance-session",
    ownerId,
    ownerGeneration: 1,
    leaseToken: `${ownerId}-lease`,
  };
}

function success(output = "ok"): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function planFor(options: {
  name: string;
  approval?: { policyHash: string; denial: "stop" | "skip" };
  tasks?: Array<{ id: string; prompt: string }>;
}): WorkflowPlan {
  return {
    schemaVersion: 1,
    name: options.name,
    phases: [
      {
        id: "phase",
        mode: "sequential",
        tasks: (options.tasks ?? [{ id: "task", prompt: "work" }]).map(
          (task) => ({
            ...task,
            ...(options.approval ? { approval: { ...options.approval } } : {}),
          }),
        ),
      },
    ],
  };
}

function liveScope(
  pi: Record<string, unknown>,
  owner: WorkflowOwnerIdentity,
  generation = 1,
): SessionScope {
  const scope = createSessionScope(pi as never);
  scope.generation = generation;
  scope.lifecycle = "started";
  scope.durableWorkflowOwner = owner;
  scope.sessionManager = {
    getSessionId: () => owner.piSessionId,
    getEntries: () => [],
  };
  registerSessionScope(scope);
  return scope;
}

function commandHarness() {
  const commands = new Map<string, { handler: Function }>();
  const entries: unknown[] = [];
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: Function }) => {
      commands.set(name, command);
    }),
    sendMessage: vi.fn((message: unknown) => {
      entries.push(message);
    }),
  };
  return { commands, entries, pi };
}

function commandContext() {
  return { ui: { notify: vi.fn() }, cwd: process.cwd() } as any;
}

async function createPersistedRun(
  root: string,
  owner: WorkflowOwnerIdentity,
  runId: string,
  plan: WorkflowPlan,
): Promise<WorkflowRunStore> {
  const store = new WorkflowRunStore({ rootDir: root, owner });
  await store.createRun({
    runId,
    planRevision: plan.schemaVersion,
    resumePolicy: "manual",
    owner,
  });
  await store.append(runId, "run_created", { plan });
  await store.append(runId, "run_started", {});
  return store;
}

async function authorityArgs(
  root: string,
  scope: SessionScope,
  runId: string,
  revision: number,
): Promise<string> {
  const store = durableWorkflowStoreForSession(root, scope);
  if (!store) throw new Error("test scope has no durable store");
  return `${runId} ${revision} ${scope.generation} ${await store.getLeaseEpoch()} ${scope.generation}`;
}

afterEach(async () => {
  clearSessionScopes();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("frozen durable workflow authority acceptance", () => {
  it("F08 exhaustively folds task, approval, budget, and cancellation permutations", async () => {
    const taskKinds = ["plain", "gated"] as const;
    const approvalModes = [
      "none",
      "pending",
      "approved",
      "rejected-stop",
      "rejected-skip",
    ] as const;
    const budgetModes = ["open", "paused"] as const;
    const cancellationModes = ["keep", "cancel"] as const;
    let caseNumber = 0;

    for (const taskKind of taskKinds) {
      for (const approvalMode of approvalModes) {
        for (const budgetMode of budgetModes) {
          for (const cancellationMode of cancellationModes) {
            caseNumber++;
            const root = await mkdtemp(
              join(tmpdir(), "workflow-f08-permutation-"),
            );
            roots.push(root);
            const owner = ownerFor(root, `f08-owner-${caseNumber}`);
            const plan = planFor({
              name: `f08-${caseNumber}`,
              approval:
                taskKind === "gated"
                  ? { policyHash: "plan-policy", denial: "skip" }
                  : undefined,
            });
            const store = await createPersistedRun(
              root,
              owner,
              `f08-run-${caseNumber}`,
              plan,
            );
            const controller = new DurableWorkflowController({ store, owner });

            let projection = (await controller.getStatus(
              `f08-run-${caseNumber}`,
            ))!;
            if (taskKind === "gated" && approvalMode === "none") {
              expect(projection.tasks.task.approval).toEqual({
                policyHash: "plan-policy",
                denial: "skip",
              });
            }
            if (taskKind === "plain") {
              expect(projection.tasks.task.approval).toBeUndefined();
            }

            if (taskKind === "gated" && approvalMode === "pending") {
              // This is the same request path used by the durable plan runner,
              // while the other approval modes exercise trusted decisions.
              await controller.requestApproval(`f08-run-${caseNumber}`, {
                requestId: `f08-approval-${caseNumber}`,
                taskId: "task",
                policyHash: "plan-policy",
                planRevision: 1,
                ownerGeneration: owner.ownerGeneration,
                leaseEpoch: await store.getLeaseEpoch(),
                version: 1,
                denial: "skip",
              });
            } else if (approvalMode !== "none") {
              const denial = approvalMode === "rejected-skip" ? "skip" : "stop";
              await controller.requestApproval(`f08-run-${caseNumber}`, {
                requestId: `f08-approval-${caseNumber}`,
                taskId: "task",
                policyHash: "f08-policy",
                planRevision: 1,
                ownerGeneration: owner.ownerGeneration,
                leaseEpoch: await store.getLeaseEpoch(),
                version: 1,
                denial,
              });
              if (approvalMode !== "pending") {
                await controller.decideApproval(
                  `f08-run-${caseNumber}`,
                  `f08-approval-${caseNumber}`,
                  {
                    requestId: `f08-approval-${caseNumber}`,
                    status:
                      approvalMode === "approved" ? "approved" : "rejected",
                    decidedBy: "f08-operator",
                    reason:
                      approvalMode === "approved"
                        ? undefined
                        : `f08-${approvalMode}`,
                  },
                );
              }
            }

            if (budgetMode === "paused") {
              await controller.pauseForBudget(
                `f08-run-${caseNumber}`,
                "f08-budget",
              );
            }
            if (cancellationMode === "cancel") {
              await controller.cancel(
                `f08-run-${caseNumber}`,
                `f08-cancel-${caseNumber}`,
              );
            }

            const replayStore = new WorkflowRunStore({ rootDir: root, owner });
            const replayed = new DurableWorkflowController({
              store: replayStore,
              owner,
            });
            projection = (await replayed.getStatus(`f08-run-${caseNumber}`))!;

            if (cancellationMode === "cancel") {
              expect(projection.status).toBe("cancelled");
              expect(projection.terminal).toEqual({ status: "cancelled" });
              expect(projection.cancellation).toMatchObject({
                ownerId: owner.ownerId,
                ownerGeneration: owner.ownerGeneration,
                requestId: `f08-cancel-${caseNumber}`,
              });
              expect(projection.delivery).toMatchObject({
                deliveryId: workflowDeliveryId(`f08-run-${caseNumber}`),
                status: "pending",
              });
            } else {
              const expectedApproval =
                approvalMode === "none"
                  ? undefined
                  : approvalMode === "pending"
                    ? "pending"
                    : approvalMode === "approved"
                      ? "approved"
                      : "rejected";
              if (expectedApproval) {
                expect(projection.approval?.status).toBe(expectedApproval);
                expect(projection.approval?.request).toMatchObject({
                  requestId: `f08-approval-${caseNumber}`,
                  taskId: "task",
                });
              } else {
                expect(projection.approval).toBeUndefined();
              }

              if (approvalMode === "rejected-skip") {
                expect(projection.tasks.task.status).toBe("skipped");
                expect(projection.blockers.approval).toBeUndefined();
              } else if (
                approvalMode === "pending" ||
                approvalMode === "rejected-stop"
              ) {
                expect(projection.blockers.approval).toMatchObject({
                  source: "approval",
                  requestId: `f08-approval-${caseNumber}`,
                });
              } else {
                expect(projection.blockers.approval).toBeUndefined();
              }

              if (budgetMode === "paused") {
                expect(projection.status).toBe("awaiting_budget");
                expect(projection.blockers.budget).toEqual({
                  reason: "f08-budget",
                });
              } else {
                expect(projection.blockers.budget).toBeUndefined();
              }

              expect(projection.blockers.claims).toEqual({});
              expect(projection.terminal).toBeUndefined();
            }

            const events = (await replayStore.readRun(`f08-run-${caseNumber}`))
              .events;
            expect(events.some((event) => event.type === "run_created")).toBe(
              true,
            );
            expect(
              events.filter((event) => event.type === "run_cancel_requested"),
            ).toHaveLength(cancellationMode === "cancel" ? 1 : 0);
            await replayStore.release();
          }
        }
      }
    }

    expect(caseNumber).toBe(40);
  }, 30_000);

  it("F09 replays tampered and missing mutation hashes before routing registered edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-f09-authority-"));
    roots.push(root);
    const owner = ownerFor(root);
    const runId = "f09-persisted-replay";
    const plan = planFor({
      name: "f09-plan",
      tasks: [
        { id: "task", prompt: "first" },
        { id: "later", prompt: "later" },
      ],
    });
    const store = await createPersistedRun(root, owner, runId, plan);
    const controller = new DurableWorkflowController({ store, owner });
    const blocked = (await controller.mutateTask(runId, {
      type: "block",
      taskId: "task",
      expectedRevision: 2,
    }))!;
    const beforeTampering = await store.readRun(runId);
    const leaseEpoch = await store.getLeaseEpoch();

    await store.append(runId, "task_unblocked", {
      taskId: "task",
      mutationProtocolVersion: 1,
      mutationRunId: runId,
      mutationType: "task_unblocked",
      mutationOwnerId: owner.ownerId,
      mutationOwnerGeneration: owner.ownerGeneration,
      mutationLeaseEpoch: leaseEpoch,
      mutationBaseRevision: blocked.revision,
      mutationBaseOrdinal: blocked.lastEventOrdinal,
      previousMutationHash: blocked.mutationHash ?? "",
    });
    await store.append(runId, "task_skipped", {
      taskId: "task",
      mutationProtocolVersion: 1,
      mutationRunId: runId,
      mutationType: "task_skipped",
      mutationOwnerId: owner.ownerId,
      mutationOwnerGeneration: owner.ownerGeneration,
      mutationLeaseEpoch: leaseEpoch,
      mutationBaseRevision: blocked.revision,
      mutationBaseOrdinal: blocked.lastEventOrdinal,
      previousMutationHash: blocked.mutationHash ?? "",
      mutationHash: "not-the-chain",
    });

    const coldStore = new WorkflowRunStore({ rootDir: root, owner });
    const coldController = new DurableWorkflowController({
      store: coldStore,
      owner,
    });
    const replayed = (await coldController.getStatus(runId))!;
    expect(replayed.revision).toBe(blocked.revision);
    expect(replayed.tasks.task.status).toBe("blocked");
    expect(replayed.mutationHash).toBe(blocked.mutationHash);
    expect(replayed.lastEventOrdinal).toBe(beforeTampering.events.length + 1);

    vi.spyOn(process, "cwd").mockReturnValue(root);
    const harness = commandHarness();
    const scope = liveScope(harness.pi, owner, 1);
    registerWorkflowTool(harness.pi as never, scope);
    const staleContext = commandContext();
    const journalBeforeStaleEdit = await coldStore.readRun(runId);
    await harness.commands
      .get("workflow-plan-edit")!
      .handler(
        `${runId} ${blocked.revision - 1} ${owner.ownerGeneration} ${leaseEpoch} ${scope.generation} unblock task`,
        staleContext,
      );
    expect(await coldStore.readRun(runId)).toEqual(journalBeforeStaleEdit);
    expect(staleContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        `Workflow plan revision is stale: expected ${blocked.revision - 1}, current ${blocked.revision}`,
      ),
    );

    const current = await authorityArgs(root, scope, runId, blocked.revision);
    await harness.commands
      .get("workflow-plan-mutate")!
      .handler(`${current} unblock task`, commandContext());
    let projection = (await coldController.getStatus(runId))!;
    expect(projection.tasks.task.status).toBe("pending");
    expect(projection.revision).toBe(blocked.revision + 1);

    const appendArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-plan-append")!
      .handler(`${appendArgs} appended phase appended work`, commandContext());
    projection = (await coldController.getStatus(runId))!;
    expect(projection.tasks.appended).toMatchObject({
      status: "pending",
      phaseId: "phase",
      prompt: "appended work",
    });

    let budgetArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-budget")!
      .handler(
        `${budgetArgs.split(" ").slice(0, 1)} pause ${budgetArgs.split(" ").slice(1).join(" ")} registered-pause`,
        commandContext(),
      );
    projection = (await coldController.getStatus(runId))!;
    expect(projection.status).toBe("awaiting_budget");
    expect(projection.blockers.budget).toEqual({ reason: "registered-pause" });

    budgetArgs = await authorityArgs(root, scope, runId, projection.revision);
    await harness.commands
      .get("workflow-budget")!
      .handler(
        `${budgetArgs.split(" ").slice(0, 1)} resume ${budgetArgs.split(" ").slice(1).join(" ")}`,
        commandContext(),
      );
    projection = (await coldController.getStatus(runId))!;
    expect(projection.status).toBe("running");

    const staleSessionArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    advanceSessionScopeGeneration(scope.id);
    const staleReloadContext = commandContext();
    await harness.commands
      .get("workflow-plan-edit")!
      .handler(`${staleSessionArgs} block appended`, staleReloadContext);
    expect(staleReloadContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Durable workflow authority envelope is stale"),
    );
    expect((await coldController.getStatus(runId))!.tasks.appended.status).toBe(
      "pending",
    );

    const freshArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-plan-edit")!
      .handler(`${freshArgs} block appended`, commandContext());
    projection = (await coldController.getStatus(runId))!;
    expect(projection.tasks.appended.status).toBe("blocked");

    const cancelArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-cancel")!
      .handler(`${cancelArgs} operator-cancellation`, commandContext());
    projection = (await coldController.getStatus(runId))!;
    expect(projection.status).toBe("cancelled");
    expect(projection.cancellation).toMatchObject({
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
    });
    expect(
      (await coldStore.readRun(runId)).events.filter(
        (event) => event.type === "run_cancel_requested",
      ),
    ).toHaveLength(1);
    await coldStore.release();
  });

  it("F15 routes exact approval and explicit-resume envelopes idempotently across reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-f15-commands-"));
    roots.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const harness = commandHarness();
    const owner = ownerFor(root);
    const scope = liveScope(harness.pi, owner, 1);
    scope.sessionManager = {
      getSessionId: () => owner.piSessionId,
      getEntries: () => harness.entries,
    };
    const plan = planFor({
      name: "f15-plan",
      approval: { policyHash: "approval-policy", denial: "skip" },
      tasks: [
        { id: "gated", prompt: "gated" },
        { id: "follow", prompt: "follow" },
      ],
    });
    const runId = "f15-command-run";
    const runAgent = vi.fn(async () => success("must not dispatch"));
    const blocked = await runDurableWorkflowForSession(root, scope, {
      runId,
      plan,
      runAgent,
    });
    expect(blocked.status).toBe("blocked");
    expect(runAgent).not.toHaveBeenCalled();
    registerWorkflowTool(harness.pi as never, scope);

    const request = blocked.approval!.request;
    const epoch = await durableWorkflowStoreForSession(
      root,
      scope,
    )!.getLeaseEpoch();
    const staleApprovalContext = commandContext();
    await harness.commands
      .get("workflow-approval")!
      .handler(
        `${runId} ${request.requestId} approve wrong-policy ${request.planRevision} ${owner.ownerGeneration} ${epoch} ${scope.generation} ${request.version}`,
        staleApprovalContext,
      );
    expect(staleApprovalContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Workflow approval authority envelope is stale"),
    );

    const approvalArgs = `${runId} ${request.requestId} reject ${request.policyHash} ${request.planRevision} ${owner.ownerGeneration} ${epoch} ${scope.generation} ${request.version} operator-rejected`;
    await harness.commands
      .get("workflow-approval")!
      .handler(approvalArgs, commandContext());
    const store = durableWorkflowStoreForSession(root, scope)!;
    let projection = (await new DurableWorkflowController({
      store,
      owner,
    }).getStatus(runId))!;
    expect(projection.approval?.status).toBe("rejected");
    expect(projection.tasks.gated.status).toBe("skipped");
    expect(projection.approval?.decision).toMatchObject({
      requestId: request.requestId,
      policyHash: request.policyHash,
      planRevision: request.planRevision,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch: epoch,
      version: request.version,
    });

    await harness.commands
      .get("workflow-approval")!
      .handler(approvalArgs, commandContext());
    let events = (await store.readRun(runId)).events;
    expect(
      events.filter((event) => event.type === "approval_decided"),
    ).toHaveLength(1);

    let mutationArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-plan-mutate")!
      .handler(`${mutationArgs} skip follow`, commandContext());
    projection = (await new DurableWorkflowController({
      store,
      owner,
    }).getStatus(runId))!;
    expect(projection.tasks.follow.status).toBe("skipped");

    const oldResumeArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-resume")!
      .handler(oldResumeArgs, commandContext());
    projection = (await new DurableWorkflowController({
      store,
      owner,
    }).getStatus(runId))!;
    expect(projection.status).toBe("done");
    expect(projection.delivery).toMatchObject({ status: "delivered" });
    events = (await store.readRun(runId)).events;
    expect(events.filter((event) => event.type === "run_result")).toHaveLength(
      1,
    );
    expect(
      events.filter((event) => event.type === "delivery_intent"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "delivery_receipt"),
    ).toHaveLength(1);

    advanceSessionScopeGeneration(scope.id);
    const staleReloadContext = commandContext();
    await harness.commands
      .get("workflow-resume")!
      .handler(oldResumeArgs, staleReloadContext);
    expect(staleReloadContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Durable workflow authority envelope is stale"),
    );
    expect((await store.readRun(runId)).events).toHaveLength(events.length);

    const freshResumeArgs = await authorityArgs(
      root,
      scope,
      runId,
      projection.revision,
    );
    await harness.commands
      .get("workflow-resume")!
      .handler(freshResumeArgs, commandContext());
    events = (await store.readRun(runId)).events;
    expect(events.filter((event) => event.type === "run_result")).toHaveLength(
      1,
    );
    expect(
      events.filter((event) => event.type === "delivery_intent"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "delivery_receipt"),
    ).toHaveLength(1);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("F17 reloads durable edit data, rejects stale saves before mutation, and exports the refresh snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-f17-edit-"));
    roots.push(root);
    const owner = ownerFor(root);
    const runId = "f17-edit-run";
    const plan = planFor({ name: "f17-plan" });
    const originalStore = await createPersistedRun(root, owner, runId, plan);
    const originalController = new DurableWorkflowController({
      store: originalStore,
      owner,
    });
    const blocked = (await originalController.mutateTask(runId, {
      type: "block",
      taskId: "task",
      expectedRevision: 2,
    }))!;
    const oldRevision = blocked.revision - 1;
    await originalStore.release();

    vi.spyOn(process, "cwd").mockReturnValue(root);
    const harness = commandHarness();
    const scope = liveScope(harness.pi, owner, 1);
    registerWorkflowTool(harness.pi as never, scope);
    const store = durableWorkflowStoreForSession(root, scope)!;
    const epoch = await store.getLeaseEpoch();
    const staleContext = commandContext();
    const journalBefore = await store.readRun(runId);
    await harness.commands
      .get("workflow-plan-edit")!
      .handler(
        `${runId} ${oldRevision} ${owner.ownerGeneration} ${epoch} ${scope.generation} unblock task`,
        staleContext,
      );
    expect(await store.readRun(runId)).toEqual(journalBefore);
    expect(staleContext.ui.notify).toHaveBeenCalledWith(
      `Durable workflow edit failed: Workflow plan revision is stale: expected ${oldRevision}, current ${blocked.revision}`,
    );

    const currentArgs = await authorityArgs(
      root,
      scope,
      runId,
      blocked.revision,
    );
    await harness.commands
      .get("workflow-plan-edit")!
      .handler(`${currentArgs} unblock task`, commandContext());
    const current = (await new DurableWorkflowController({
      store,
      owner,
    }).getStatus(runId))!;
    expect(current.tasks.task.status).toBe("pending");
    expect(current.revision).toBe(blocked.revision + 1);

    await harness.commands
      .get("workflow-plan-export")!
      .handler(runId, commandContext());
    const exportMessage = harness.entries.at(-1) as any;
    const exported = JSON.parse(exportMessage.content);
    expect(exported).toMatchObject({
      runId,
      revision: current.revision,
      tasks: {
        task: {
          id: "task",
          status: "pending",
          prompt: "work",
        },
      },
    });
    expect(exported.tasks.task.history).toBeUndefined();
    await store.release();
  });
});

import { describe, expect, it } from "vitest";
import {
  formatWorkflowContinuity,
  recordWorkflowReminder,
  shouldRemindWorkflow,
} from "../src/workflow-continuity";
import { passesWorkflowRoutingRolloutGate } from "../src/workflow-routing";

describe("workflow continuity", () => {
  it("formats bounded factual context without outputs", () => {
    const text = formatWorkflowContinuity({
      runId: "run-1",
      revision: 4,
      status: "running",
      phase: "build",
      phaseMode: "parallel",
      tasks: [{ id: "a", status: "running" }],
      pendingCount: 0,
      blockedCount: 0,
      approvalPendingCount: 0,
      awaitingBudget: false,
    });
    expect(text).toContain("run=run-1 revision=4 status=running");
    expect(text).toContain("phase=build mode=parallel");
    expect(text).not.toContain("secret result");
  });

  it("suppresses reminders and caps them per generation", () => {
    const state = { generation: 1, emitted: 0, lastProgressRevision: 2 };
    expect(
      shouldRemindWorkflow({
        activeWakeup: true,
        allBlocked: false,
        awaitingUserInput: false,
        state,
        revision: 2,
        generation: 1,
      }),
    ).toBe(false);
    expect(
      shouldRemindWorkflow({
        activeWakeup: false,
        allBlocked: false,
        awaitingUserInput: false,
        state,
        revision: 2,
        generation: 1,
      }),
    ).toBe(true);
    const next = recordWorkflowReminder(state, 2, 1);
    expect(
      shouldRemindWorkflow({
        activeWakeup: false,
        allBlocked: false,
        awaitingUserInput: false,
        state: next,
        revision: 2,
        generation: 1,
      }),
    ).toBe(false);
    expect(recordWorkflowReminder(next, 3, 2)).toEqual({
      generation: 2,
      emitted: 1,
      lastProgressRevision: 3,
    });
  });

  it("requires an enabled minimum-SDK rollout gate and measured compliance", () => {
    expect(
      passesWorkflowRoutingRolloutGate({
        enabled: true,
        minimumSdkSatisfied: true,
        observedRuns: 100,
        compliantRuns: 98,
        maxUnconfirmedRate: 0.03,
      }),
    ).toBe(true);
    expect(
      passesWorkflowRoutingRolloutGate({
        enabled: true,
        minimumSdkSatisfied: true,
        observedRuns: 100,
        compliantRuns: 90,
        maxUnconfirmedRate: 0.03,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  decideWorkflowRouting,
  parseWorkflowEagerMode,
  WORKFLOW_EAGER_DEFAULT,
} from "../src/workflow-routing";

describe("workflow eager routing", () => {
  it("parses the opt-in configuration with an off default", () => {
    expect(WORKFLOW_EAGER_DEFAULT).toBe("off");
    expect(parseWorkflowEagerMode(undefined)).toBe("off");
    expect(parseWorkflowEagerMode(false)).toBe("off");
    expect(parseWorkflowEagerMode("preferred")).toBe("preferred");
    expect(() => parseWorkflowEagerMode("invalid")).toThrow("workflow-eager");
  });

  it("defaults off to direct execution", () => {
    expect(
      decideWorkflowRouting({ mode: "off", text: "refactor the service" }),
    ).toEqual({
      kind: "direct",
      reason: "routing_disabled",
    });
  });

  it("routes eligible complex work only in the opt-in lanes", () => {
    expect(
      decideWorkflowRouting({
        mode: "preferred",
        text: "Investigate and refactor the service",
      }),
    ).toMatchObject({
      kind: "durable_plan",
      reason: "eligible_complex_request",
    });
    expect(
      decideWorkflowRouting({ mode: "always", text: "small task" }),
    ).toEqual({ kind: "direct", reason: "not_complex" });
  });

  it("suppresses routing for simple and management contexts", () => {
    expect(
      decideWorkflowRouting({ mode: "preferred", text: "What is this?" }),
    ).toEqual({ kind: "direct", reason: "simple_request" });
    expect(
      decideWorkflowRouting({
        mode: "always",
        text: "refactor it",
        managementCommand: true,
      }),
    ).toEqual({ kind: "direct", reason: "management_command" });
    expect(
      decideWorkflowRouting({
        mode: "always",
        text: "refactor it",
        childContext: true,
      }),
    ).toEqual({ kind: "direct", reason: "child_context" });
    expect(
      decideWorkflowRouting({
        mode: "preferred",
        text: "refactor it",
        hasActiveWorkflow: true,
      }),
    ).toEqual({ kind: "direct", reason: "active_workflow" });
    expect(
      decideWorkflowRouting({
        mode: "preferred",
        text: "refactor it",
        awaitingUserInput: true,
      }),
    ).toEqual({ kind: "direct", reason: "awaiting_user_input" });
    expect(
      decideWorkflowRouting({
        mode: "preferred",
        text: "refactor it",
        planOnly: true,
      }),
    ).toEqual({ kind: "direct", reason: "plan_only" });
  });
});

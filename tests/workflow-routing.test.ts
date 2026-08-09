import { describe, expect, it } from "vitest";
import {
  decideWorkflowRouting,
  parseWorkflowEagerMode,
  WorkflowRoutingMetrics,
  WORKFLOW_EAGER_DEFAULT,
  type WorkflowEagerMode,
  type WorkflowRoutingInput,
} from "../src/workflow-routing";

function decide(
  mode: WorkflowEagerMode,
  text: string,
  overrides: Partial<WorkflowRoutingInput> = {},
) {
  return decideWorkflowRouting({ mode, text, ...overrides });
}

describe("workflow eager routing policy", () => {
  it("defaults off and rejects unknown flag values", () => {
    expect(WORKFLOW_EAGER_DEFAULT).toBe("off");
    expect(parseWorkflowEagerMode(undefined)).toBe("off");
    expect(parseWorkflowEagerMode(false)).toBe("off");
    expect(parseWorkflowEagerMode("preferred")).toBe("preferred");
    expect(parseWorkflowEagerMode("always")).toBe("always");
    expect(() => parseWorkflowEagerMode("sometimes")).toThrow(
      "workflow-eager must be off, preferred, or always",
    );
  });

  it("routes only multi-slice or phased work in preferred mode", () => {
    expect(decide("preferred", "Fix the parser bug")).toEqual({
      kind: "direct",
      reason: "simple_request",
    });
    expect(decide("preferred", "Fix one workflow bug")).toEqual({
      kind: "direct",
      reason: "simple_request",
    });
    expect(
      decide(
        "preferred",
        "Investigate the parser and then update the callers and tests",
      ),
    ).toMatchObject({ kind: "durable_plan", mode: "preferred" });
    expect(
      decide(
        "preferred",
        "Refactor authentication across the codebase in multiple phases",
      ),
    ).toMatchObject({ kind: "durable_plan", mode: "preferred" });
    expect(
      decide(
        "preferred",
        "Refactor authentication across the repository. Do not change the public API.",
      ),
    ).toMatchObject({ kind: "durable_plan", mode: "preferred" });
    expect(
      decide(
        "preferred",
        "Do a repository-wide audit and then fix the discovered issues",
      ),
    ).toMatchObject({ kind: "durable_plan", mode: "preferred" });
    expect(
      decide("preferred", "Run npm test and then fix the failures"),
    ).toMatchObject({ kind: "durable_plan", mode: "preferred" });
    expect(
      decide(
        "preferred",
        "I need you to write tests across the repository in multiple phases",
      ),
    ).toMatchObject({ kind: "durable_plan", mode: "preferred" });
  });

  it("routes remaining actionable work in always mode", () => {
    expect(decide("always", "Fix the parser bug")).toMatchObject({
      kind: "durable_plan",
      mode: "always",
      reason: "eligible_actionable_request",
    });
  });

  it.each([
    ["", "empty_request"],
    ["Thanks!", "social_conversation"],
    ["Why does this parser use a cache?", "pure_question"],
    ["What should we refactor first?", "pure_question"],
    ["Do you think we should refactor this?", "pure_question"],
    ["Write a plan only; do not implement it", "plan_only"],
    ["/workflow-status active", "management_command"],
    ["Run the typecheck", "one_command_operation"],
    ["Run npm test", "one_command_operation"],
    ["Can you run npm test?", "one_command_operation"],
    [
      "The repository uses review gates across multiple phases",
      "non_actionable_request",
    ],
    ["PostgreSQL is our primary database", "non_actionable_request"],
  ])("suppresses %j in always mode as %s", (text, reason) => {
    expect(decide("always", text)).toEqual({ kind: "direct", reason });
  });

  it.each([
    ["childContext", "child_context"],
    ["hasActiveWorkflow", "active_workflow"],
    ["awaitingUserInput", "awaiting_user_input"],
    ["managementCommand", "management_command"],
    ["planOnly", "plan_only"],
  ] as const)("honors the explicit %s suppression", (key, reason) => {
    expect(decide("always", "Implement the feature", { [key]: true })).toEqual({
      kind: "direct",
      reason,
    });
  });

  it("keeps all natural requests direct while disabled", () => {
    expect(decide("off", "Refactor everything in multiple phases")).toEqual({
      kind: "direct",
      reason: "routing_disabled",
    });
  });

  it("keeps the local preferred-mode fixture at zero false positives", () => {
    const fixtures = [
      { text: "Fix one parser bug", route: false },
      { text: "Fix one workflow bug", route: false },
      { text: "Explain the workflow architecture", route: false },
      { text: "Run npm test", route: false },
      { text: "Write a plan only and do not implement it", route: false },
      {
        text: "Audit the repository across multiple subsystems",
        route: true,
      },
      {
        text: "Investigate the parser and then update its callers and tests",
        route: true,
      },
      {
        text: "Migrate storage across services in multiple phases",
        route: true,
      },
    ];
    const actual = fixtures.map(
      ({ text }) => decide("preferred", text).kind === "durable_plan",
    );
    const falsePositives = actual.filter(
      (routed, index) => routed && !fixtures[index]?.route,
    );

    expect(actual).toEqual(fixtures.map(({ route }) => route));
    expect(falsePositives).toHaveLength(0);
  });

  it("records local rollout facts without external telemetry", () => {
    const metrics = new WorkflowRoutingMetrics();
    metrics.recordDecision(decide("preferred", "Fix one bug"));
    metrics.recordDecision(
      decide("preferred", "Audit the repository in multiple phases"),
    );
    metrics.recordHostStarted();
    metrics.recordPolicyObserved();
    metrics.recordRoutingUnconfirmed();

    expect(metrics.snapshot()).toEqual({
      decisions: 2,
      eligible: 1,
      hostStarted: 1,
      policyObserved: 1,
      routingUnconfirmed: 1,
      unconfirmedRate: 0.5,
      directReasons: { simple_request: 1 },
    });
  });
});

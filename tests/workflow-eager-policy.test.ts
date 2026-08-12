import { describe, expect, it } from "vitest";
import {
  createValidatedEagerWorkflowPlan,
  decideWorkflowEagerRequest,
  resolveWorkflowEagerMode,
} from "../src/workflow-eager-policy";

function draftWith(
  options: {
    mode?: "sequence" | "parallel";
    isolation?: string;
    instruction?: string;
  } = {},
): unknown {
  const agent =
    options.isolation === undefined
      ? undefined
      : { isolation: options.isolation };
  return {
    name: "Generated plan",
    description: "Generated description",
    phases: [
      {
        id: "phase-generated",
        name: "Generated phase",
        mode: options.mode ?? "sequence",
        tasks: [
          {
            id: "task-generated",
            content: "Generated task",
            instruction: options.instruction ?? "Complete the generated task.",
            ...(agent === undefined ? {} : { agent }),
          },
        ],
      },
    ],
  };
}

const COMPLEX_REQUEST = [
  "Implement the release:",
  "1. Update the parser",
  "2) Add regression tests",
].join("\n");

describe("resolveWorkflowEagerMode", () => {
  it.each(["off", "preferred", "always"] as const)(
    "resolves the %s mode",
    (mode) => {
      expect(resolveWorkflowEagerMode(mode)).toEqual({ mode });
    },
  );

  it("defaults absent configuration to off", () => {
    expect(resolveWorkflowEagerMode(undefined)).toEqual({ mode: "off" });
  });

  it("falls back to off and reports an invalid value", () => {
    const result = resolveWorkflowEagerMode("sometimes");

    expect(result.mode).toBe("off");
    expect(result.error).toContain('Invalid workflow-eager value "sometimes"');
    expect(result.error).toContain('"off", "preferred", or "always"');
  });
});

describe("decideWorkflowEagerRequest", () => {
  it("keeps automatic routing disabled in off mode", () => {
    expect(decideWorkflowEagerRequest(COMPLEX_REQUEST, "off")).toEqual({
      route: false,
      reason: "disabled",
      slices: [],
    });
  });

  it.each([
    ["empty requests", "   ", "empty-request"],
    ["pure questions", "Why is the build failing?", "pure-question"],
    ["social conversation", "Thanks for your help!", "social"],
    [
      "plan-only work",
      "Draft an implementation plan only; do not make changes.",
      "plan-only",
    ],
    [
      "turns awaiting user input",
      "Wait for my confirmation before making changes.",
      "awaiting-user-input",
    ],
    [
      "workflow management commands",
      "/workflow-plan create release",
      "workflow-management",
    ],
    [
      "natural workflow management requests",
      "Resume the active workflow",
      "workflow-management",
    ],
  ])("suppresses %s even in always mode", (_label, prompt, reason) => {
    const result = decideWorkflowEagerRequest(prompt, "always");

    expect(result.route).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.slices).toEqual([]);
  });

  it("keeps a simple focused fix direct in preferred mode", () => {
    expect(
      decideWorkflowEagerRequest("Fix the typo in src/help.ts.", "preferred"),
    ).toEqual({
      route: false,
      reason: "preferred-simple",
      slices: [],
    });
  });

  it("keeps a one-command operation direct in preferred mode", () => {
    expect(
      decideWorkflowEagerRequest("Run the focused test.", "preferred"),
    ).toMatchObject({
      route: false,
      reason: "preferred-simple",
    });
  });

  it("routes and extracts explicit numbered slices in preferred mode", () => {
    expect(decideWorkflowEagerRequest(COMPLEX_REQUEST, "preferred")).toEqual({
      route: true,
      reason: "explicit-multi-slice",
      slices: ["Update the parser", "Add regression tests"],
    });
  });

  it("routes an explicitly phased request in preferred mode", () => {
    const result = decideWorkflowEagerRequest(
      "First, update the parser. Then, migrate callers. Finally, run focused tests.",
      "preferred",
    );

    expect(result).toEqual({
      route: true,
      reason: "phased-complex",
      slices: ["update the parser", "migrate callers", "run focused tests"],
    });
  });

  it("routes two natural action clauses without requiring list syntax", () => {
    expect(
      decideWorkflowEagerRequest(
        "Implement the parser migration and add regression tests.",
        "preferred",
      ),
    ).toEqual({
      route: true,
      reason: "phased-complex",
      slices: ["Implement the parser migration", "add regression tests"],
    });
  });

  it("does not mistake a noun conjunction for independent work", () => {
    expect(
      decideWorkflowEagerRequest(
        "Implement authentication and authorization.",
        "preferred",
      ),
    ).toMatchObject({
      route: false,
      reason: "preferred-simple",
    });
  });

  it("routes other executable requests in always mode", () => {
    expect(
      decideWorkflowEagerRequest("Fix the typo in src/help.ts.", "always"),
    ).toEqual({
      route: true,
      reason: "always-executable",
      slices: ["Fix the typo in src/help.ts."],
    });
  });

  it("does not treat a factual statement as an executable request", () => {
    expect(
      decideWorkflowEagerRequest(
        "The parser currently has three stages.",
        "always",
      ),
    ).toMatchObject({ route: false, reason: "not-executable" });
  });
});

describe("createValidatedEagerWorkflowPlan", () => {
  it("creates stable explicit IDs and a sequential in-process plan", () => {
    const plan = createValidatedEagerWorkflowPlan("Prepare the release", [
      "Update the parser",
      "Add regression tests",
    ]);

    expect(plan).toEqual({
      name: "Automatic workflow plan",
      description: "Prepare the release",
      phases: [
        {
          id: "phase-1",
          name: "Phase 1",
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
          name: "Phase 2",
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
    });
  });

  it("makes one correction after invalid output and passes the exact cause", () => {
    const attempts: Array<{
      attempt: number;
      previousError: string | undefined;
    }> = [];

    const plan = createValidatedEagerWorkflowPlan(
      "Complete the task",
      ["Complete the task"],
      (_task, _slices, attempt, previousError) => {
        attempts.push({ attempt, previousError });
        return attempt === 0
          ? draftWith({ isolation: "process" })
          : draftWith();
      },
    );

    expect(attempts).toEqual([
      { attempt: 0, previousError: undefined },
      {
        attempt: 1,
        previousError:
          "Durable workflow task task-generated requests unsupported process isolation.",
      },
    ]);
    expect(plan.phases[0].tasks[0].agent?.isolation).toBe("in-process");
  });

  it("makes one correction after the draft factory throws", () => {
    const attempts: number[] = [];
    const corrections: Array<string | undefined> = [];

    createValidatedEagerWorkflowPlan(
      "Complete the task",
      ["Complete the task"],
      (_task, _slices, attempt, previousError) => {
        attempts.push(attempt);
        corrections.push(previousError);
        if (attempt === 0) {
          throw new Error("planner unavailable");
        }
        return draftWith({ isolation: "in-process" });
      },
    );

    expect(attempts).toEqual([0, 1]);
    expect(corrections).toEqual([undefined, "planner unavailable"]);
  });

  it("reports both exact failures and never makes a third attempt", () => {
    let calls = 0;

    expect(() =>
      createValidatedEagerWorkflowPlan(
        "Complete the task",
        ["Complete the task"],
        (_task, _slices, attempt) => {
          calls += 1;
          throw new Error(
            attempt === 0 ? "first exact cause" : "second exact cause",
          );
        },
      ),
    ).toThrow(
      "Unable to create a valid eager workflow plan after 2 attempts. " +
        "Attempt 0: first exact cause. Attempt 1: second exact cause.",
    );
    expect(calls).toBe(2);
  });

  it("enforces eager task-count and text bounds before schema validation", () => {
    let countCalls = 0;
    expect(() =>
      createValidatedEagerWorkflowPlan(
        "Complete the task",
        ["Complete the task"],
        () => {
          countCalls += 1;
          return {
            name: "Oversized plan",
            description: "Too many tasks",
            phases: [
              {
                id: "phase-1",
                name: "Phase 1",
                mode: "sequence",
                tasks: Array.from({ length: 17 }, (_, index) => ({
                  id: `task-${index + 1}`,
                  content: `Task ${index + 1}`,
                  instruction: `Complete task ${index + 1}`,
                })),
              },
            ],
          };
        },
      ),
    ).toThrow("Eager workflow plan exceeds the 16-task limit.");
    expect(countCalls).toBe(2);

    let textCalls = 0;
    expect(() =>
      createValidatedEagerWorkflowPlan(
        "Complete the task",
        ["Complete the task"],
        () => {
          textCalls += 1;
          return draftWith({ instruction: "x".repeat(4097) });
        },
      ),
    ).toThrow("task.instruction exceeds the 4096-character limit.");
    expect(textCalls).toBe(2);
  });

  it("rejects parallel drafts on both bounded attempts", () => {
    let calls = 0;
    expect(() =>
      createValidatedEagerWorkflowPlan(
        "Complete the task",
        ["Complete the task"],
        () => {
          calls += 1;
          return draftWith({ mode: "parallel" });
        },
      ),
    ).toThrow("Durable workflow preview supports sequential phases only.");
    expect(calls).toBe(2);
  });
});

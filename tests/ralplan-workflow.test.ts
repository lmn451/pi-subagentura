import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorkflow,
  runWorkflow,
  type WorkflowAgentRunner,
} from "../src/workflow";
import type { SubagentResult } from "../src/helpers";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const EXAMPLES = join(REPO, "examples", "workflows");

function result(value: unknown): SubagentResult {
  return {
    isError: false,
    output: JSON.stringify(value),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: "test/model",
  };
}

function failed(): SubagentResult {
  return {
    isError: true,
    output: "",
    errorMessage: "test failure",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function workflow(name: string): string {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

const draft = {
  principles: ["safe", "small", "tested"],
  decisionDrivers: ["safety", "compatibility", "delivery"],
  options: [
    { name: "A", pros: ["safe"], cons: ["slow"] },
    { name: "B", pros: ["fast"], cons: ["risk"] },
  ],
  planBody: "immutable snapshot",
  openQuestions: [],
};

function planner(): unknown {
  return { verdict: "DRAFT_READY", draft };
}

function architect(verdict = "APPROVE"): unknown {
  return {
    verdict,
    steelman: "alternative",
    tradeoffTension: "speed versus safety",
    principleViolations: verdict === "APPROVE" ? [] : ["safety"],
    summary: "architect result",
  };
}

function critic(verdict = "APPROVE"): unknown {
  return {
    verdict,
    findings:
      verdict === "APPROVE"
        ? []
        : [{ severity: "MAJOR", area: "risk", evidence: "`risk`" }],
    summary: "critic result",
    preMortemStatus: "missing",
    testPlanStatus: "missing",
  };
}

describe("ralplan Phase 1 contracts", () => {
  it("reviews one immutable planner snapshot in order without Architect leakage", async () => {
    const prompts: Record<string, string> = {};
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      labels.push(label ?? "");
      if (label === "planner") return result(planner());
      if (label === "architect") {
        prompts.architect = String(prompt);
        return result(architect());
      }
      if (label === "critic") {
        prompts.critic = String(prompt);
        return result(critic());
      }
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 1,
      },
      runAgent: runner,
    });

    expect(labels).toEqual(["planner", "architect", "critic"]);
    expect(prompts.architect).toContain("immutable snapshot");
    expect(prompts.critic).toContain("immutable snapshot");
    expect(prompts.critic).not.toContain("ARCHITECT REVIEW");
    expect(prompts.critic).not.toContain("architect result");
    expect(run.result).toMatchObject({
      status: "consensus",
      iterations: 1,
      pending_approval: true,
      execution_halted: true,
    });
    expect(run.result).not.toHaveProperty("recommendedExecution");
  });

  it("runs Critic after Architect revision and re-reviews on the next round", async () => {
    const labels: string[] = [];
    const plannerPrompts: string[] = [];
    let plannerCalls = 0;
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      labels.push(label ?? "");
      if (label === "planner") {
        plannerCalls++;
        plannerPrompts.push(String(prompt));
        return result(planner());
      }
      if (label === "architect")
        return result(
          architect(plannerCalls === 1 ? "REVISION_NEEDED" : "APPROVE"),
        );
      if (label === "critic") return result(critic());
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 2,
      },
      runAgent: runner,
    });

    expect(labels).toEqual([
      "planner",
      "architect",
      "critic",
      "planner",
      "architect",
      "critic",
    ]);
    expect(run.result).toMatchObject({ status: "consensus", iterations: 2 });
    expect(plannerPrompts[0]).not.toContain("architect result");
    expect(plannerPrompts[1]).toContain("architect result");
    expect(plannerPrompts[1]).toContain("critic result");
  });

  it("treats missing reviewers as non-approval and clamps rounds to five", async () => {
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label }) => {
      labels.push(label ?? "");
      if (label === "planner") return result(planner());
      if (label === "architect") return failed();
      if (label === "critic") return result(critic("REJECT"));
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 99,
        executeOnConsensus: true,
      },
      runAgent: runner,
    });

    expect(labels).toHaveLength(15);
    expect(run.result).toMatchObject({
      status: "no_consensus",
      iterations: 5,
      capped: true,
      pending_approval: true,
      execution_halted: true,
    });
    expect(run.result).not.toHaveProperty("recommendedExecution");
    expect(run.result).toHaveProperty("executeOnConsensusIgnored", true);
  });

  it("does not infer approval when a reviewer omits its verdict", async () => {
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label }) => {
      labels.push(label ?? "");
      if (label === "planner") return result(planner());
      if (label === "architect")
        return result({ steelman: "missing explicit verdict" });
      if (label === "critic") return result(critic());
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 1,
      },
      runAgent: runner,
    });

    expect(labels).toContain("critic");
    expect(run.result).toMatchObject({
      status: "no_consensus",
      lastVerdict: { architect: "MISSING", critic: "APPROVE" },
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("halts without consensus when Planner output is missing", async () => {
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label }) => {
      labels.push(label ?? "");
      return failed();
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 0,
      },
      runAgent: runner,
    });

    expect(labels).toEqual(["planner"]);
    expect(run.result).toMatchObject({
      status: "no_planner_output",
      iterations: 1,
      pending_approval: true,
      execution_halted: true,
    });
    expect(run.result).not.toHaveProperty("recommendedExecution");
  });

  it("keeps deliberate-mode hard gates in structured Planner output", async () => {
    const runner: WorkflowAgentRunner = async ({ label }) => {
      if (label === "planner") return result(planner());
      if (label === "architect") return result(architect());
      if (label === "critic") return result(critic());
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        deliberate: true,
        maxIterations: 1,
      },
      runAgent: runner,
    });

    expect(run.result).toMatchObject({
      status: "no_consensus",
      pending_approval: true,
      execution_halted: true,
      deliberate: { valid: false },
    });
  });

  it("honors gate false and makes interactive markers non-blocking", async () => {
    const runner: WorkflowAgentRunner = async ({ label }) => {
      if (label === "planner") return result(planner());
      if (label === "architect") return result(architect());
      if (label === "critic") return result(critic());
      throw new Error(`Unexpected label: ${label}`);
    };

    const bypassed = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "plan something",
        gate: false,
        interactive: false,
        maxIterations: 1,
      },
      runAgent: runner,
    });
    const gated = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "plan something",
        gate: true,
        interactive: true,
        maxIterations: 1,
      },
      runAgent: runner,
    });

    expect(bypassed.result).toMatchObject({
      gate: { enabled: false },
      interactive: { enabled: false },
    });
    expect(gated.result).toMatchObject({
      gated: true,
      pending_approval: true,
      execution_halted: true,
    });
    expect(gated.result).not.toHaveProperty("recommendedExecution");
  });

  it("keeps the smaller consensus example independent and pending", async () => {
    const prompts: Record<string, string> = {};
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      if (label === "planner-1")
        return result({ verdict: "DRAFT_READY", draft });
      if (label === "architect-1") {
        prompts.architect = String(prompt);
        return result(architect());
      }
      if (label === "critic-1") {
        prompts.critic = String(prompt);
        return result(critic());
      }
      if (label === "consolidate") {
        return result({
          verdict: "CONSOLIDATED",
          path: "plans/plan.md",
          summary: "done",
        });
      }
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-consensus.mjs"), {
      args: { idea: "review src/auth.ts", maxIterations: 1 },
      runAgent: runner,
    });

    expect(prompts.critic).toContain("immutable snapshot");
    expect(prompts.critic).not.toContain("ARCHITECT REVIEW");
    expect(run.result).toMatchObject({
      consensus: true,
      pending_approval: true,
      execution_halted: true,
    });
    expect(run.result).not.toHaveProperty("recommendedExecution");
  });

  it("remains parseable", () => {
    expect(() => parseWorkflow(workflow("ralplan-occ.mjs"))).not.toThrow();
    expect(() =>
      parseWorkflow(workflow("ralplan-consensus.mjs")),
    ).not.toThrow();
  });
});

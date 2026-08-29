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
const HEADINGS = [
  "RALPLAN-DR",
  "Architecture Decision Record",
  "Task Breakdown",
  "Dependency Graph",
  "Acceptance Criteria",
  "Risk Register",
];

function workflow(name: string): string {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

function json(value: unknown): SubagentResult {
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

function paths(root: string, round: number) {
  return {
    draft: `${root}/drafts/plan_draft-r${round}.md`,
    architect: `${root}/drafts/architect_review-r${round}.md`,
    critic: `${root}/drafts/critic_review-r${round}.md`,
    final: `${root}/plan.md`,
  };
}

function verification(path: string, round: number, kind: string, valid = true) {
  return {
    valid,
    path,
    round,
    kind,
    sizeBytes: valid ? 100 : 0,
    sha256: `digest-${round}-${kind}`,
    headings: HEADINGS,
    issues: valid ? [] : ["invalid"],
  };
}

function architect(path: string, round: number, verdict = "APPROVE") {
  return {
    verdict,
    draftDigest: `digest-${round}-draft`,
    reviewPath: path,
    steelman: "alternative",
    tradeoffTension: "speed versus safety",
    principleViolations: verdict === "APPROVE" ? [] : ["safety"],
    summary: "architect result",
  };
}

function critic(path: string, round: number, verdict = "APPROVE") {
  return {
    verdict,
    draftDigest: `digest-${round}-draft`,
    reviewPath: path,
    findings: [],
    summary: "critic result",
  };
}

function occRunner(
  root: string,
  options: {
    architectVerdict?: (round: number) => string;
    criticVerdict?: (round: number) => string;
    prompts?: Record<string, string[]>;
  } = {},
): WorkflowAgentRunner {
  let round = 0;
  return async ({ label, prompt }) => {
    if (options.prompts) {
      const promptList = (options.prompts[label ?? ""] ??= []);
      promptList.push(String(prompt));
    }
    if (label === "planner") {
      round++;
      return json({
        verdict: "DRAFT_READY",
        path: paths(root, round).draft,
        round,
        summary: `draft ${round}`,
      });
    }
    if (label === "verify-draft")
      return json(verification(paths(root, round).draft, round, "draft"));
    if (label === "architect")
      return json(
        architect(
          paths(root, round).architect,
          round,
          options.architectVerdict?.(round) ?? "APPROVE",
        ),
      );
    if (label === "critic")
      return json(
        critic(
          paths(root, round).critic,
          round,
          options.criticVerdict?.(round) ?? "APPROVE",
        ),
      );
    if (label === "verify-architect")
      return json(
        verification(paths(root, round).architect, round, "architect-review"),
      );
    if (label === "verify-critic")
      return json(
        verification(paths(root, round).critic, round, "critic-review"),
      );
    if (label === "consolidate")
      return json({
        verdict: "CONSOLIDATED",
        path: paths(root, round).final,
        sourceDraftDigest: `digest-${round}-draft`,
        summary: "final",
      });
    if (label === "verify-final")
      return json(verification(paths(root, round).final, round, "final-plan"));
    throw new Error(`Unexpected label: ${label}`);
  };
}

describe("ralplan independent review contracts", () => {
  it("reviews one immutable artifact in order without Architect leakage", async () => {
    const root = "/repo/plans";
    const prompts: Record<string, string[]> = {};
    const labels: string[] = [];
    const base = occRunner(root, { prompts });
    const runner: WorkflowAgentRunner = async (input) => {
      labels.push(input.label ?? "");
      return base(input);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 1,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: runner,
    });

    expect(labels).toEqual([
      "planner",
      "verify-draft",
      "architect",
      "critic",
      "verify-architect",
      "verify-critic",
      "consolidate",
      "verify-final",
    ]);
    expect(prompts.architect[0]).toContain("plan_draft-r1.md");
    expect(prompts.critic[0]).toContain("plan_draft-r1.md");
    expect(prompts.critic[0]).not.toContain("architect_review-r1.md");
    expect(prompts.critic[0]).not.toContain("architect result");
    expect(run.result).toMatchObject({
      status: "pending_approval",
      consensus: true,
      pending_approval: true,
      execution_halted: true,
    });
    expect(run.result).not.toHaveProperty("recommendedExecution");
  });

  it("runs Critic after Architect revision and re-reviews the next round", async () => {
    const root = "/repo/plans";
    const prompts: Record<string, string[]> = {};
    const labels: string[] = [];
    const base = occRunner(root, {
      prompts,
      architectVerdict: (round) =>
        round === 1 ? "REVISION_NEEDED" : "APPROVE",
    });
    const runner: WorkflowAgentRunner = async (input) => {
      labels.push(input.label ?? "");
      return base(input);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 2,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: runner,
    });

    expect(labels.filter((label) => label === "critic")).toHaveLength(2);
    expect(prompts.planner[0]).not.toContain("architect result");
    expect(prompts.planner[1]).toContain("architect result");
    expect(prompts.planner[1]).toContain("critic result");
    expect(run.result).toMatchObject({ consensus: true, iterations: 2 });
  });

  it("treats reviewer errors as non-approval and clamps rounds to five", async () => {
    const root = "/repo/plans";
    let round = 0;
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label }) => {
      labels.push(label ?? "");
      if (label === "planner") {
        round++;
        return json({
          verdict: "DRAFT_READY",
          path: paths(root, round).draft,
          round,
          summary: "draft",
        });
      }
      if (label === "verify-draft")
        return json(verification(paths(root, round).draft, round, "draft"));
      if (label === "architect") return failed();
      if (label === "critic")
        return json(critic(paths(root, round).critic, round, "REJECT"));
      if (label === "verify-architect")
        return json(
          verification(
            paths(root, round).architect,
            round,
            "architect-review",
            false,
          ),
        );
      if (label === "verify-critic")
        return json(
          verification(paths(root, round).critic, round, "critic-review"),
        );
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 99,
        artifactsDir: root,
        planName: "plan",
        executeOnConsensus: true,
      },
      runAgent: runner,
    });

    expect(labels.filter((label) => label === "planner")).toHaveLength(5);
    expect(labels.filter((label) => label === "critic")).toHaveLength(5);
    expect(run.result).toMatchObject({
      consensus: false,
      iterations: 5,
      capped: true,
      status: "artifact_validation_failed",
      pending_approval: true,
      execution_halted: true,
      executeOnConsensusIgnored: true,
    });
    expect(run.result).not.toHaveProperty("recommendedExecution");
  });

  it("does not infer approval when a reviewer omits its verdict", async () => {
    const root = "/repo/plans";
    let round = 0;
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label }) => {
      labels.push(label ?? "");
      if (label === "planner") {
        round++;
        return json({
          verdict: "DRAFT_READY",
          path: paths(root, round).draft,
          round,
          summary: "draft",
        });
      }
      if (label === "verify-draft")
        return json(verification(paths(root, round).draft, round, "draft"));
      if (label === "architect") return json({ steelman: "missing verdict" });
      if (label === "critic")
        return json(critic(paths(root, round).critic, round));
      if (label === "verify-architect")
        return json(
          verification(
            paths(root, round).architect,
            round,
            "architect-review",
            false,
          ),
        );
      if (label === "verify-critic")
        return json(
          verification(paths(root, round).critic, round, "critic-review"),
        );
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 1,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: runner,
    });

    expect(labels).toContain("critic");
    expect(run.result).toMatchObject({
      consensus: false,
      status: "artifact_validation_failed",
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("clamps zero rounds to one and rejects missing Planner artifacts", async () => {
    const root = "/repo/plans";
    const labels: string[] = [];
    const runner: WorkflowAgentRunner = async ({ label }) => {
      labels.push(label ?? "");
      if (label === "verify-draft")
        return json(verification(paths(root, 1).draft, 1, "draft", false));
      return failed();
    };

    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 0,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: runner,
    });

    expect(labels.filter((label) => label === "verify-draft")).toHaveLength(1);
    expect(run.result).toMatchObject({
      consensus: false,
      iterations: 1,
      status: "artifact_validation_failed",
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("enforces deliberate artifact sections", async () => {
    const root = "/repo/plans";
    const runner = occRunner(root);
    const run = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        deliberate: true,
        maxIterations: 1,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: runner,
    });

    expect(run.result).toMatchObject({
      consensus: false,
      status: "artifact_validation_failed",
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("honors gate false and makes interactive markers non-blocking", async () => {
    const root = "/repo/plans";
    const bypassed = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "plan something",
        gate: false,
        interactive: false,
        maxIterations: 1,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: occRunner(root),
    });
    const gated = await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: { idea: "plan something", gate: true, interactive: true },
      runAgent: async () => {
        throw new Error("gate should not spawn agents");
      },
    });

    expect(bypassed.result).toMatchObject({
      gate: { enabled: false },
      interactive: { enabled: false, blocking: false },
    });
    expect(gated.result).toMatchObject({
      gated: true,
      interactive: { enabled: true, blocking: false },
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("keeps the compact example independent, verified, and pending", async () => {
    const root = "/repo/plans";
    const prompts: Record<string, string> = {};
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      prompts[label ?? ""] = String(prompt);
      if (label === "planner-1")
        return json({
          verdict: "DRAFT_READY",
          path: paths(root, 1).draft,
          round: 1,
          summary: "draft",
        });
      if (label === "verify-draft-1")
        return json(verification(paths(root, 1).draft, 1, "draft"));
      if (label === "architect-1")
        return json(architect(paths(root, 1).architect, 1));
      if (label === "critic-1") return json(critic(paths(root, 1).critic, 1));
      if (label === "verify-architect-1")
        return json(
          verification(paths(root, 1).architect, 1, "architect-review"),
        );
      if (label === "verify-critic-1")
        return json(verification(paths(root, 1).critic, 1, "critic-review"));
      if (label === "consolidate")
        return json({
          verdict: "CONSOLIDATED",
          path: paths(root, 1).final,
          sourceDraftDigest: "digest-1-draft",
          summary: "final",
        });
      if (label === "verify-final")
        return json(verification(paths(root, 1).final, 1, "final-plan"));
      throw new Error(`Unexpected label: ${label}`);
    };

    const run = await runWorkflow(workflow("ralplan-consensus.mjs"), {
      args: {
        idea: "review src/auth.ts",
        maxIterations: 1,
        artifactsDir: root,
        planName: "plan",
      },
      runAgent: runner,
    });

    expect(prompts["critic-1"]).toContain("plan_draft-r1.md");
    expect(prompts["critic-1"]).not.toContain("architect_review-r1.md");
    expect(run.result).toMatchObject({
      consensus: true,
      status: "pending_approval",
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("remains parseable", () => {
    expect(() => parseWorkflow(workflow("ralplan-occ.mjs"))).not.toThrow();
    expect(() =>
      parseWorkflow(workflow("ralplan-consensus.mjs")),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow, type WorkflowAgentRunner } from "../src/workflow";
import type { SubagentResult } from "../src/helpers";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const EXAMPLES = join(REPO, "examples", "workflows");

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

function draftResult(path: string, round: number) {
  return { verdict: "DRAFT_READY", path, round, summary: `draft ${round}` };
}

function verified(path: string, round: number, kind: string) {
  return {
    valid: true,
    path,
    round,
    kind,
    sizeBytes: 1024,
    sha256: `digest-${round}-${kind}`,
    headings: [
      "RALPLAN-DR",
      "Architecture Decision Record",
      "Task Breakdown",
      "Dependency Graph",
      "Acceptance Criteria",
      "Risk Register",
    ],
    issues: [],
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

function consolidated(path: string, digest: string) {
  return {
    verdict: "CONSOLIDATED",
    path,
    sourceDraftDigest: digest,
    summary: "final",
  };
}

describe("RALPLAN artifact contract", () => {
  it("uses immutable per-round artifacts and verifies every claimed artifact", async () => {
    const root = "/repo/plans";
    const labels: string[] = [];
    const prompts: Record<string, string> = {};
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      labels.push(label ?? "");
      prompts[label ?? ""] = String(prompt);
      if (label === "planner")
        return json(draftResult(`${root}/drafts/plan_draft-r1.md`, 1));
      if (label === "verify-draft")
        return json(verified(`${root}/drafts/plan_draft-r1.md`, 1, "draft"));
      if (label === "architect")
        return json(architect(`${root}/drafts/architect_review-r1.md`, 1));
      if (label === "critic")
        return json(critic(`${root}/drafts/critic_review-r1.md`, 1));
      if (label === "verify-architect")
        return json(
          verified(
            `${root}/drafts/architect_review-r1.md`,
            1,
            "architect-review",
          ),
        );
      if (label === "verify-critic")
        return json(
          verified(`${root}/drafts/critic_review-r1.md`, 1, "critic-review"),
        );
      if (label === "consolidate")
        return json(consolidated(`${root}/plan.md`, "digest-1-draft"));
      if (label === "verify-final")
        return json(verified(`${root}/plan.md`, 1, "final-plan"));
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
    expect(prompts.architect).toContain("plan_draft-r1.md");
    expect(prompts.critic).toContain("plan_draft-r1.md");
    expect(prompts.critic).not.toContain("architect_review-r1.md");
    expect(run.result).toMatchObject({
      status: "pending_approval",
      consensus: true,
      planDigest: "digest-1-final-plan",
      artifactPaths: {
        plan: `${root}/plan.md`,
        drafts: [`${root}/drafts/plan_draft-r1.md`],
        architectReviews: [`${root}/drafts/architect_review-r1.md`],
        criticReviews: [`${root}/drafts/critic_review-r1.md`],
      },
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("keeps prior artifacts immutable and gives both reviews only to the next Planner", async () => {
    const root = "/repo/plans";
    const plannerPrompts: string[] = [];
    let round = 0;
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      if (label === "planner") {
        round++;
        plannerPrompts.push(String(prompt));
        return json(
          draftResult(`${root}/drafts/plan_draft-r${round}.md`, round),
        );
      }
      if (label === "verify-draft")
        return json(
          verified(`${root}/drafts/plan_draft-r${round}.md`, round, "draft"),
        );
      if (label === "architect")
        return json(
          architect(
            `${root}/drafts/architect_review-r${round}.md`,
            round,
            round === 1 ? "REVISION_NEEDED" : "APPROVE",
          ),
        );
      if (label === "critic")
        return json(critic(`${root}/drafts/critic_review-r${round}.md`, round));
      if (label === "verify-architect")
        return json(
          verified(
            `${root}/drafts/architect_review-r${round}.md`,
            round,
            "architect-review",
          ),
        );
      if (label === "verify-critic")
        return json(
          verified(
            `${root}/drafts/critic_review-r${round}.md`,
            round,
            "critic-review",
          ),
        );
      if (label === "consolidate")
        return json(consolidated(`${root}/plan.md`, "digest-2-draft"));
      if (label === "verify-final")
        return json(verified(`${root}/plan.md`, 2, "final-plan"));
      throw new Error(`Unexpected label: ${label}`);
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

    expect(plannerPrompts[0]).not.toContain("architect result");
    expect(plannerPrompts[1]).toContain("architect result");
    expect(plannerPrompts[1]).toContain("critic result");
    expect(run.result).toMatchObject({ iterations: 2, consensus: true });
  });

  it("rejects missing, oversized, malformed, and wrong-round artifacts", async () => {
    const root = "/repo/plans";
    const cases = [
      { issue: "missing", path: `${root}/drafts/plan_draft-r1.md`, round: 1 },
      { issue: "oversized", path: `${root}/drafts/plan_draft-r1.md`, round: 1 },
      { issue: "malformed", path: `${root}/drafts/plan_draft-r1.md`, round: 1 },
      {
        issue: "wrong round",
        path: `${root}/drafts/plan_draft-r2.md`,
        round: 2,
      },
    ];

    for (const testCase of cases) {
      const runner: WorkflowAgentRunner = async ({ label }) => {
        if (label === "planner")
          return json(draftResult(testCase.path, testCase.round));
        if (label === "verify-draft") {
          return json({
            ...verified(testCase.path, testCase.round, "draft"),
            valid: false,
            sizeBytes: testCase.issue === "oversized" ? 2_000_000 : 0,
            issues: [testCase.issue],
          });
        }
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

      expect(run.result).toMatchObject({
        consensus: false,
        status: "artifact_validation_failed",
        pending_approval: true,
        execution_halted: true,
      });
    }
  });

  it("runs an advisory Analyst preflight and requires requirements coverage when requested", async () => {
    const root = "/repo/plans";
    const prompts: Record<string, string> = {};
    const runner: WorkflowAgentRunner = async ({ label, prompt }) => {
      prompts[label ?? ""] = String(prompt);
      if (label === "analyst") {
        return json({
          requirements: [{ id: "REQ-1", text: "Preserve compatibility" }],
          openQuestions: [],
        });
      }
      if (label === "planner")
        return json(draftResult(`${root}/drafts/plan_draft-r1.md`, 1));
      if (label === "verify-draft") {
        const report = verified(
          `${root}/drafts/plan_draft-r1.md`,
          1,
          "draft",
        ) as { headings: string[] };
        report.headings.push("Requirement Coverage Map");
        return json(report);
      }
      if (label === "architect")
        return json(architect(`${root}/drafts/architect_review-r1.md`, 1));
      if (label === "critic")
        return json(critic(`${root}/drafts/critic_review-r1.md`, 1));
      if (label === "verify-architect")
        return json(
          verified(
            `${root}/drafts/architect_review-r1.md`,
            1,
            "architect-review",
          ),
        );
      if (label === "verify-critic")
        return json(
          verified(`${root}/drafts/critic_review-r1.md`, 1, "critic-review"),
        );
      if (label === "consolidate")
        return json(consolidated(`${root}/plan.md`, "digest-1-draft"));
      if (label === "verify-final") {
        const report = verified(`${root}/plan.md`, 1, "final-plan") as {
          headings: string[];
        };
        report.headings.push("Requirement Coverage Map");
        return json(report);
      }
      throw new Error(`Unexpected label: ${label}`);
    };

    await runWorkflow(workflow("ralplan-occ.mjs"), {
      args: {
        idea: "force: review src/auth.ts",
        gate: false,
        maxIterations: 1,
        artifactsDir: root,
        planName: "plan",
        requirementsTraceability: true,
      },
      runAgent: runner,
    });

    expect(prompts.planner).toContain("REQ-1");
    expect(prompts["verify-draft"]).toContain("Requirement Coverage Map");
    expect(prompts.critic).toContain("requirements coverage");
  });

  it("does not report consensus when final artifact verification fails", async () => {
    const root = "/repo/plans";
    const runner: WorkflowAgentRunner = async ({ label }) => {
      if (label === "planner")
        return json(draftResult(`${root}/drafts/plan_draft-r1.md`, 1));
      if (label === "verify-draft")
        return json(verified(`${root}/drafts/plan_draft-r1.md`, 1, "draft"));
      if (label === "architect")
        return json(architect(`${root}/drafts/architect_review-r1.md`, 1));
      if (label === "critic")
        return json(critic(`${root}/drafts/critic_review-r1.md`, 1));
      if (label === "verify-architect")
        return json(
          verified(
            `${root}/drafts/architect_review-r1.md`,
            1,
            "architect-review",
          ),
        );
      if (label === "verify-critic")
        return json(
          verified(`${root}/drafts/critic_review-r1.md`, 1, "critic-review"),
        );
      if (label === "consolidate")
        return json(consolidated(`${root}/plan.md`, "digest-1-draft"));
      if (label === "verify-final")
        return json({
          ...verified(`${root}/plan.md`, 1, "final-plan"),
          valid: false,
          issues: ["missing ADR"],
        });
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

    expect(run.result).toMatchObject({
      consensus: false,
      status: "artifact_validation_failed",
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("rejects reviewer source-digest mismatches", async () => {
    const root = "/repo/plans";
    const runner: WorkflowAgentRunner = async ({ label }) => {
      if (label === "planner")
        return json(draftResult(`${root}/drafts/plan_draft-r1.md`, 1));
      if (label === "verify-draft")
        return json(verified(`${root}/drafts/plan_draft-r1.md`, 1, "draft"));
      if (label === "architect") {
        return json({
          ...architect(`${root}/drafts/architect_review-r1.md`, 1),
          draftDigest: "different-digest",
        });
      }
      if (label === "critic")
        return json(critic(`${root}/drafts/critic_review-r1.md`, 1));
      if (label === "verify-architect")
        return json(
          verified(
            `${root}/drafts/architect_review-r1.md`,
            1,
            "architect-review",
          ),
        );
      if (label === "verify-critic")
        return json(
          verified(`${root}/drafts/critic_review-r1.md`, 1, "critic-review"),
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

    expect(run.result).toMatchObject({
      consensus: false,
      status: "artifact_validation_failed",
      pending_approval: true,
      execution_halted: true,
    });
  });

  it("rejects unsafe artifact names before spawning agents", async () => {
    const runner: WorkflowAgentRunner = async () => {
      throw new Error("must not spawn");
    };

    await expect(
      runWorkflow(workflow("ralplan-occ.mjs"), {
        args: {
          idea: "force: review src/auth.ts",
          gate: false,
          artifactsDir: "/repo/plans",
          planName: "../escape",
        },
        runAgent: runner,
      }),
    ).rejects.toThrow("planName");
  });
});

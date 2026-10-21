import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
const workDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

function ok(output: string): SubagentResult {
  return {
    isError: false,
    output,
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

function json(value: unknown): SubagentResult {
  return ok(JSON.stringify(value));
}

function script(name: string): string {
  return readFileSync(join(EXAMPLES, name), "utf8");
}

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundled workflow examples", () => {
  const sourceReviewAspects = [
    "intent-design",
    "compatibility",
    "behavior-change",
    "correctness-quality",
  ] as const;
  const sourceReviewLabels: Record<
    (typeof sourceReviewAspects)[number],
    string
  > = {
    "intent-design": "Intent and design alignment",
    compatibility: "Compatibility",
    "behavior-change": "Unintended behavior changes",
    "correctness-quality": "Correctness and quality",
  };
  const sourceReviewArgs = {
    files: ["src/auth.ts", "src/session.ts"],
    intendedChange:
      "Replace the token cache while preserving existing callers.",
  };

  function passingSourceReviewResponses(): Record<string, unknown | Error> {
    const responses: Record<string, unknown | Error> = {};
    for (const aspect of sourceReviewAspects) {
      responses[sourceReviewLabels[aspect]] = {
        verdict: "pass",
        findings: [],
      };
    }
    return responses;
  }

  async function runSourceReview(responses: Record<string, unknown | Error>) {
    const run = await runWorkflow(script("review-source.ts"), {
      args: sourceReviewArgs,
      runAgent: async ({ label }) => {
        const key = label ?? "";
        if (!Object.hasOwn(responses, key)) {
          throw new Error(`Unexpected source-review agent: ${key}`);
        }
        const response = responses[key];
        if (response instanceof Error) throw response;
        return json(response);
      },
      requestInput: async () => true,
    });
    return run;
  }

  it("passes only when all aspect reviews complete cleanly", async () => {
    const run = await runSourceReview(passingSourceReviewResponses());

    expect(run.result).toMatchObject({
      status: "pass",
      reviews: [
        { aspect: "intent-design", outcome: "completed", verdict: "pass" },
        { aspect: "compatibility", outcome: "completed", verdict: "pass" },
        { aspect: "behavior-change", outcome: "completed", verdict: "pass" },
        {
          aspect: "correctness-quality",
          outcome: "completed",
          verdict: "pass",
        },
      ],
      findings: [],
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    });
  });

  it("sorts findings deterministically and preserves independent evidence", async () => {
    const responses = passingSourceReviewResponses();
    responses["Intent and design alignment"] = {
      verdict: "pass",
      findings: [
        {
          severity: "low",
          location: "src/z.ts:9",
          evidence: "the fallback remains",
          explanation: "The fallback no longer matches the intended design.",
        },
      ],
    };
    responses["Compatibility"] = {
      verdict: "concern",
      findings: [
        {
          severity: "medium",
          location: "src/a.ts:12",
          evidence: "export function refresh()",
          explanation: "The exported function signature changes.",
        },
      ],
    };
    responses["Unintended behavior changes"] = {
      verdict: "pass",
      findings: [
        {
          severity: "high",
          location: "src/auth.ts:4",
          evidence: "return legacyResult()",
          explanation: "Existing callers now receive a different result.",
        },
      ],
    };
    responses["Correctness and quality"] = {
      verdict: "pass",
      findings: [
        {
          severity: "high",
          location: "src/auth.ts:4",
          evidence: "return legacyResult()",
          explanation: "The new branch returns stale state.",
        },
      ],
    };

    const run = await runSourceReview(responses);

    expect(run.result).toMatchObject({
      status: "blocking",
      severityCounts: { critical: 0, high: 2, medium: 1, low: 1 },
    });
    const output = run.result as { findings: unknown[] };
    expect(output.findings).toEqual([
      {
        aspect: "behavior-change",
        severity: "high",
        location: "src/auth.ts:4",
        evidence: "return legacyResult()",
        explanation: "Existing callers now receive a different result.",
      },
      {
        aspect: "correctness-quality",
        severity: "high",
        location: "src/auth.ts:4",
        evidence: "return legacyResult()",
        explanation: "The new branch returns stale state.",
      },
      {
        aspect: "compatibility",
        severity: "medium",
        location: "src/a.ts:12",
        evidence: "export function refresh()",
        explanation: "The exported function signature changes.",
      },
      {
        aspect: "intent-design",
        severity: "low",
        location: "src/z.ts:9",
        evidence: "the fallback remains",
        explanation: "The fallback no longer matches the intended design.",
      },
    ]);
  });

  it("keeps lower-severity findings in a concern result", async () => {
    const responses = passingSourceReviewResponses();
    responses["Intent and design alignment"] = {
      verdict: "pass",
      findings: [
        {
          severity: "low",
          location: "src/auth.ts:30",
          evidence: "cacheTTL = 0",
          explanation: "The default may cause avoidable cache churn.",
        },
      ],
    };

    const run = await runSourceReview(responses);

    expect(run.result).toMatchObject({
      status: "concern",
      findings: [
        {
          aspect: "intent-design",
          severity: "low",
          location: "src/auth.ts:30",
        },
      ],
      severityCounts: { critical: 0, high: 0, medium: 0, low: 1 },
    });
  });

  it("marks a failed or explicitly uncertain review as uncertain, not pass", async () => {
    const responses = passingSourceReviewResponses();
    responses["Compatibility"] = new Error("Compatibility review failed.");
    responses["Correctness and quality"] = {
      verdict: "uncertain",
      findings: [],
    };

    const run = await runSourceReview(responses);

    expect(run.result).toMatchObject({
      status: "uncertain",
      reviews: [
        { aspect: "intent-design", outcome: "completed", verdict: "pass" },
        {
          aspect: "compatibility",
          outcome: "failed",
          verdict: "uncertain",
          failure: {
            name: expect.any(String),
            message: expect.any(String),
          },
        },
        { aspect: "behavior-change", outcome: "completed", verdict: "pass" },
        {
          aspect: "correctness-quality",
          outcome: "completed",
          verdict: "uncertain",
        },
      ],
    });
  });

  it("bounds oversized agent failures before persisting map results", async () => {
    const responses = passingSourceReviewResponses();
    const oversizedMessage = "provider error ".repeat(50_000);
    responses["Compatibility"] = new Error(oversizedMessage);

    const run = await runSourceReview(responses);

    const report = run.result as {
      status: string;
      reviews: Array<{
        aspect: string;
        outcome?: string;
        verdict?: string;
        failure?: { name?: string; message: string };
      }>;
    };
    expect(report.status).toBe("uncertain");
    const failedReview = report.reviews.find(
      (review) => review.aspect === "compatibility",
    );
    expect(failedReview).toMatchObject({
      outcome: "failed",
      verdict: "uncertain",
      failure: { name: "Error" },
    });
    const failureMessage = failedReview?.failure?.message;
    expect(failureMessage).toHaveLength(1_200);
    expect(failureMessage).toMatch(/^ReviewError: Error: provider error /);
    expect(failureMessage).toContain(oversizedMessage.slice(0, 100));
  });

  it("lets blocking findings take precedence over failed reviews", async () => {
    const responses = passingSourceReviewResponses();
    responses["Compatibility"] = new Error("Compatibility review failed.");
    responses["Unintended behavior changes"] = {
      verdict: "blocking",
      findings: [],
    };

    const run = await runSourceReview(responses);

    expect(run.result).toMatchObject({
      status: "blocking",
      reviews: [
        { aspect: "intent-design", outcome: "completed", verdict: "pass" },
        { aspect: "compatibility", outcome: "failed", verdict: "uncertain" },
        {
          aspect: "behavior-change",
          outcome: "completed",
          verdict: "blocking",
        },
        {
          aspect: "correctness-quality",
          outcome: "completed",
          verdict: "pass",
        },
      ],
    });
  });

  it("parses every bundled .mjs workflow", () => {
    const files = readdirSync(EXAMPLES)
      .filter((file) => file.endsWith(".mjs"))
      .sort();

    expect(files).toEqual([
      "durable-review.mjs",
      "package-to-skill.mjs",
      "ralplan-consensus.mjs",
      "ralplan-from-skill.mjs",
      "ralplan-occ.mjs",
      "skill-to-workflow.mjs",
    ]);
    for (const file of files) {
      expect(() => parseWorkflow(script(file)), file).not.toThrow();
    }
  });

  it.each(["object", "JSON string"])(
    "ralplan-consensus consumes documented %s args",
    async (argsKind) => {
      const artifactsDir = join(tempDir("ralplan-consensus-"), "custom");
      const args = {
        idea: "Review src/auth.ts and produce a plan",
        maxIterations: 1,
        artifactsDir,
      };
      const runner: WorkflowAgentRunner = async ({ label }) => {
        if (label === "planner-1") {
          return json({
            verdict: "DRAFT_READY",
            path: join(artifactsDir, "drafts", "plan_draft.md"),
            adrSummary: "ADR",
            summary: "draft",
          });
        }
        if (label === "architect-1") {
          return json({
            verdict: "APPROVE",
            issues: [],
            steelman: "alternative",
            tradeoffTension: "speed versus safety",
            summary: "approved",
          });
        }
        if (label === "critic-1") {
          return json({
            verdict: "APPROVE",
            gaps: [],
            selfAudit: "checked",
            summary: "approved",
          });
        }
        if (label === "consolidate") {
          return json({
            verdict: "CONSOLIDATED",
            path: join(artifactsDir, "plan.md"),
            summary: "done",
          });
        }
        throw new Error(`Unexpected label: ${label}`);
      };

      const run = await runWorkflow(script("ralplan-consensus.mjs"), {
        args: argsKind === "object" ? args : JSON.stringify(args),
        runAgent: runner,
      });

      expect(run.result).toMatchObject({
        consensus: true,
        iterations: 1,
        planPath: join(artifactsDir, "plan.md"),
      });
    },
  );

  it.each(["object", "JSON string"])(
    "ralplan-occ consumes %s args and routes reviewer models",
    async (argsKind) => {
      const root = tempDir("ralplan-occ-");
      const args = {
        idea: "force: review src/auth.ts and produce a migration plan",
        deliberate: false,
        maxIterations: 1,
        artifactsDir: join(root, "plans"),
        draftsDir: join(root, "drafts"),
        planName: "auth-review",
        architectModel: "test/architect",
        criticModel: "test/critic",
        executeOnConsensus: true,
      };
      const models = new Map<string, string | undefined>();
      const runner: WorkflowAgentRunner = async ({ label, model }) => {
        models.set(label ?? "", model);
        if (label === "planner") {
          return json({
            principles: ["safe", "small", "tested"],
            decisionDrivers: ["security", "compatibility", "delivery"],
            options: [
              { name: "A", pros: ["safe"], cons: ["slow"] },
              { name: "B", pros: ["fast"], cons: ["risk"] },
            ],
            invalidatedOptions: [],
            planBody: "Plan",
            openQuestions: [],
          });
        }
        if (label === "architect") {
          return json({
            summary: "sound",
            steelman: "keep the old design",
            tradeoffTension: "speed versus safety",
            synthesis: "stage the change",
            principleViolations: [],
          });
        }
        if (label === "critic") {
          return json({
            verdict: "ACCEPT",
            summary: "accepted",
            findings: [],
            preMortemStatus: "present-3",
            testPlanStatus: "complete",
          });
        }
        throw new Error(`Unexpected label: ${label}`);
      };

      const run = await runWorkflow(script("ralplan-occ.mjs"), {
        args: argsKind === "object" ? args : JSON.stringify(args),
        runAgent: runner,
      });

      expect(run.result).toMatchObject({
        status: "consensus_approved",
        iterations: 1,
        artifactPaths: { plan: join(root, "plans", "auth-review.md") },
        pending_approval: true,
        execution_halted: true,
      });
      expect(models.get("architect")).toBe("test/architect");
      expect(models.get("critic")).toBe("test/critic");
    },
  );

  it.each(["object", "JSON string"])(
    "ralplan-from-skill consumes documented %s args",
    async (argsKind) => {
      const workingDir = tempDir("ralplan-from-skill-");
      const args = {
        idea: "Plan a safe authentication migration",
        workingDir,
        planName: "auth-migration",
        deliberate: false,
        maxIterations: 1,
      };
      const runner: WorkflowAgentRunner = async ({ label }) => {
        if (label === "ralplan-planner-1") return ok("DRAFT_WRITTEN");
        if (label === "ralplan-architect-1") {
          return ok("Review complete\n**VERDICT: APPROVE**");
        }
        if (label === "ralplan-critic-1") {
          return ok("Review complete\n**VERDICT: APPROVE**");
        }
        throw new Error(`Unexpected label: ${label}`);
      };

      const run = await runWorkflow(script("ralplan-from-skill.mjs"), {
        args: argsKind === "object" ? args : JSON.stringify(args),
        runAgent: runner,
      });

      expect(run.result).toMatchObject({
        planPath: join(workingDir, "plans", "auth-migration.md"),
        iterations: 1,
        mode: "SHORT",
        verdicts: { architect: "APPROVE", critic: "APPROVE" },
      });
    },
  );

  it.each(["object", "JSON string"])(
    "skill-to-workflow runs against a fixture with %s args and emits parseable output",
    async (argsKind) => {
      const root = tempDir("skill-to-workflow-");
      const skillPath = join(root, "source-skill");
      const outputPath = join(root, `generated-${argsKind}.mjs`);
      mkdirSync(join(skillPath, "prompts"), { recursive: true });
      writeFileSync(
        join(skillPath, "SKILL.md"),
        "---\nname: fixture\ndescription: Fixture skill\n---\n\n# Fixture\n",
      );
      writeFileSync(join(skillPath, "prompts", "reviewer.md"), "Review it.\n");
      const generated = `export const meta = { name: "fixture-flow", description: "Generated fixture workflow" };\nreturn { ok: true };\n`;
      const runner: WorkflowAgentRunner = async ({ label }) => {
        if (label === "discover") {
          return json({
            skillMd: {
              path: join(skillPath, "SKILL.md"),
              size: 64,
              exists: true,
            },
            rolePrompts: [
              {
                path: join(skillPath, "prompts", "reviewer.md"),
                size: 11,
                role: "reviewer",
                inferredType: "role-prompt",
              },
            ],
            references: [],
            scripts: [],
            subdirs: ["prompts"],
            totalSize: 75,
          });
        }
        if (label === "analyze") {
          return json({
            name: "fixture",
            description: "Fixture skill",
            coreDirective: "Review",
            roles: [{ name: "reviewer", responsibility: "Review" }],
            stateMachine: { type: "single", phases: ["Review"] },
            artifacts: [],
            signals: [],
            interactiveCheckpoints: [],
            boundary: "review only",
          });
        }
        if (label === "design") {
          return json({
            algorithm: "Run reviewer",
            mappings: [{ skillElement: "reviewer", primitive: "agent" }],
            fidelityLimitations: [],
            args: [],
            returnShape: "object",
          });
        }
        if (label === "generate") return json({ script: generated });
        if (label === "validate") {
          writeFileSync(outputPath, generated);
          return json({
            valid: true,
            issues: [],
            scriptPath: outputPath,
            lineCount: 2,
          });
        }
        throw new Error(`Unexpected label: ${label}`);
      };
      const args = { skillPath, outputPath };

      const run = await runWorkflow(script("skill-to-workflow.mjs"), {
        args: argsKind === "object" ? args : JSON.stringify(args),
        runAgent: runner,
      });

      expect(run.result).toMatchObject({
        skillPath,
        outputPath,
        validation: { valid: true, scriptPath: outputPath },
      });
      expect(existsSync(outputPath)).toBe(true);
      expect(() =>
        parseWorkflow(readFileSync(outputPath, "utf8")),
      ).not.toThrow();
    },
  );

  it.each(["object", "JSON string"])(
    "package-to-skill runs against a fixture with %s args",
    async (argsKind) => {
      const root = tempDir("package-to-skill-");
      const sourcePath = join(root, "source-package");
      const skillDir = join(root, `generated-${argsKind}`);
      mkdirSync(join(sourcePath, "src"), { recursive: true });
      writeFileSync(
        join(sourcePath, "package.json"),
        JSON.stringify({ name: "fixture-package", version: "1.0.0" }),
      );
      writeFileSync(join(sourcePath, "src", "index.ts"), "export {};\n");
      const runner: WorkflowAgentRunner = async ({ label }) => {
        if (label === "survey") {
          return json({
            packageJson: {
              path: join(sourcePath, "package.json"),
              exists: true,
            },
            skillMd: { path: "", exists: false },
            rolePrompts: [],
            extensionFiles: [
              {
                path: join(sourcePath, "src", "index.ts"),
                size: 11,
                inferredRole: "extension",
              },
            ],
            agentsFiles: [],
            references: [],
            readme: { path: "", exists: false },
          });
        }
        if (label === "distill") {
          return json({
            distilledJson: JSON.stringify({
              skillName: "fixture-skill",
              description: "Fixture skill",
              rolePrompts: [],
              completionSignals: [],
            }),
          });
        }
        if (label === "generate-and-persist") {
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(
            join(skillDir, "SKILL.md"),
            "---\nname: fixture-skill\ndescription: Fixture skill\n---\n",
          );
          writeFileSync(
            join(skillDir, "package.json"),
            JSON.stringify({
              name: "fixture-skill",
              version: "1.0.0",
              pi: { skills: ["."] },
            }),
          );
          return json({
            valid: true,
            issues: [],
            skillDir,
            filesWritten: ["SKILL.md", "package.json"],
            totalBytes: 128,
          });
        }
        throw new Error(`Unexpected label: ${label}`);
      };
      const args = {
        sourcePath,
        skillDir,
        packageName: "fixture-skill",
        packageVersion: "1.0.0",
      };

      const run = await runWorkflow(script("package-to-skill.mjs"), {
        args: argsKind === "object" ? args : JSON.stringify(args),
        runAgent: runner,
      });

      expect(run.result).toMatchObject({
        sourcePath,
        skillDir,
        packageName: "fixture-skill",
        filesGenerated: 2,
        validation: { valid: true },
      });
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillDir, "package.json"))).toBe(true);
    },
  );
});

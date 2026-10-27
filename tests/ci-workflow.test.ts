import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
}

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  strategy?: { matrix?: Record<string, string[]> };
  steps: WorkflowStep[];
}

interface Workflow {
  on?: {
    push?: { branches?: string[] };
    pull_request?: unknown;
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
  concurrency?: { group?: string; "cancel-in-progress"?: string };
  jobs: Record<string, WorkflowJob>;
}

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const workflow = parse(
  readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;
const packageJson = JSON.parse(
  readFileSync(resolve(REPO, "package.json"), "utf8"),
) as { scripts: Record<string, string>; engines: { node: string } };

function step(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps.find((candidate) => candidate.name === name);
  expect(found, `missing CI step: ${name}`).toBeDefined();
  return found!;
}

function commands(job: WorkflowJob): string[] {
  return job.steps.flatMap((candidate) =>
    candidate.run === undefined ? [] : [candidate.run.trim()],
  );
}

function normalizeCondition(condition = ""): string {
  return condition.replace(/\s+/g, " ").trim();
}

describe("CI workflow (.github/workflows/ci.yml)", () => {
  it("runs for protected branch pushes, pull requests, schedules, and manual dispatch", () => {
    expect(workflow.on?.push?.branches).toEqual(["master"]);
    expect(workflow.on?.pull_request).toBeDefined();
    expect(workflow.on?.schedule?.map(({ cron }) => cron)).toEqual([
      "0 6 * * *",
    ]);
    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflow.concurrency?.group).toBe(
      "ci-${{ github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it("preserves stable merge-gate checks and the declared runtime and SDK matrix", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["minimum-node", "test"]);
    const minimumNode = workflow.jobs["minimum-node"]!;
    const test = workflow.jobs.test!;
    const minimumVersion = packageJson.engines.node.replace(/^>=/, "");

    expect(minimumNode.name).toBe(`Minimum Node ${minimumVersion}`);
    expect(step(minimumNode, "Setup minimum Node.js").with).toMatchObject({
      "node-version": minimumVersion,
    });
    expect(commands(minimumNode)).toContain("npm run typecheck");
    expect(commands(minimumNode)).toContain("npm run test:property");
    expect(commands(minimumNode)).toContain("npm run pack:check");
    expect(test.name).toBe("Test (Pi ${{ matrix.pi-version }})");
    expect(test.strategy?.matrix).toEqual({
      "pi-version": ["1.2.0", "latest"],
    });
  });

  it.each(["1.2.0", "latest"])(
    "installs all selected %s SDK packages in one npm invocation",
    (version) => {
      const test = workflow.jobs.test!;
      const install = step(test, "Install selected Pi SDK");
      expect(install.env).toEqual({ PI_VERSION: "${{ matrix.pi-version }}" });
      expect(install.run).toBeDefined();

      const output = execFileSync(
        "bash",
        ["-c", `npm() { printf '%s\\n' "$*"; }\n${install.run}`],
        { encoding: "utf8", env: { ...process.env, PI_VERSION: version } },
      );
      const invocations = output.trim().split("\n");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain(
        "install --no-save --package-lock=false",
      );
      for (const name of [
        "pi-agent-core",
        "pi-ai",
        "pi-coding-agent",
        "pi-tui",
      ])
        expect(invocations[0]).toContain(`@earendil-works/${name}@${version}`);
    },
  );

  it("assigns checks to the intended SDK leg", () => {
    const test = workflow.jobs.test!;
    for (const name of [
      "Check formatting",
      "Run unit and Pi session tests with coverage thresholds",
      "Run terminal visual E2E tests",
      "Verify published tarball is loadable (regression: v2.0.0 missing helpers.ts)",
    ])
      expect(normalizeCondition(step(test, name).if)).toBe(
        "matrix.pi-version == '1.2.0'",
      );
    for (const name of ["Run unit tests", "Run Pi session integration tests"])
      expect(normalizeCondition(step(test, name).if)).toBe(
        "matrix.pi-version == 'latest'",
      );

    expect(packageJson.scripts["test:unit"]).toContain(
      "--exclude tests/published-tarball.test.ts",
    );
    expect(packageJson.scripts["coverage:check"]).toContain(
      "--exclude tests/published-tarball.test.ts",
    );
  });

  it("runs hosted Herdr coverage with failure diagnostics", () => {
    const test = workflow.jobs.test!;
    expect(step(test, "Install Herdr").env).toEqual({
      HERDR_VERSION: "v0.9.0",
      HERDR_SHA256:
        "4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f",
    });
    expect(step(test, "Run headless Herdr integration tests")).toMatchObject({
      run: "npm run test:herdr:headless",
      "timeout-minutes": 6,
    });
    expect(step(test, "Upload Herdr diagnostics")).toMatchObject({
      if: "failure()",
      uses: "actions/upload-artifact@v6",
    });
    expect(packageJson.scripts["test:herdr:headless"]).toBe(
      "node --experimental-strip-types tests/helpers/herdr-headless.ts",
    );
  });

  it("keeps randomized and mutation runs on scheduled/manual pinned-SDK checks", () => {
    const test = workflow.jobs.test!;
    const deepCondition =
      "matrix.pi-version == '1.2.0' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";
    expect(
      normalizeCondition(step(test, "Run randomized-order tests").if),
    ).toBe(deepCondition);
    expect(
      normalizeCondition(step(test, "Run non-blocking mutation pilot").if),
    ).toBe(deepCondition);
    expect(
      step(test, "Run non-blocking mutation pilot")["continue-on-error"],
    ).toBe(true);
    expect(packageJson.scripts["test:random"]).toContain("--sequence.shuffle");
    expect(packageJson.scripts["test:property"]).toBe(
      "vitest run tests/property",
    );
    expect(packageJson.scripts["mutation:pilot"]).toBe("stryker run");
  });
});

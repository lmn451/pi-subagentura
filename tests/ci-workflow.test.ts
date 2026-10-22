import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  strategy?: {
    matrix?: {
      "pi-version"?: string[];
    };
  };
  steps: WorkflowStep[];
}

interface Workflow {
  on?: {
    push?: { branches?: string[] };
    pull_request?: unknown;
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: string;
  };
  jobs: Record<string, WorkflowJob>;
}

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const workflow = parse(
  readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;
const packageJson = JSON.parse(
  readFileSync(resolve(REPO, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
};

function step(job: WorkflowJob, name: string): WorkflowStep {
  const match = job.steps.find((candidate) => candidate.name === name);
  expect(match, `missing CI step: ${name}`).toBeDefined();
  return match!;
}

function normalizedCondition(candidate: WorkflowStep): string {
  return (candidate.if ?? "").replace(/\s+/g, " ").trim();
}

function allSteps(): WorkflowStep[] {
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

describe("CI workflow (.github/workflows/ci.yml)", () => {
  it("validates PRs once and only runs push CI for master", () => {
    expect(workflow.on?.push?.branches).toEqual(["master"]);
    expect(workflow.on?.pull_request).toBeDefined();
    expect(workflow.concurrency?.group).toBe(
      "ci-${{ github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow.on?.schedule?.map(({ cron }) => cron)).toContain(
      "0 6 * * *",
    );
    expect(workflow.on?.workflow_dispatch).toBeDefined();
  });

  it("preserves stable merge-gate check names and the actual SDK matrix", () => {
    const minimumNode = workflow.jobs["minimum-node"]!;
    const test = workflow.jobs.test!;

    expect(Object.keys(workflow.jobs)).toEqual(["minimum-node", "test"]);
    expect(minimumNode.name).toBe("Minimum Node 22.23.2");
    expect(minimumNode["runs-on"]).toBe("ubuntu-latest");
    expect(
      minimumNode.steps.some(({ run }) => run === "npm run typecheck"),
    ).toBe(true);
    expect(
      minimumNode.steps.some(({ run }) => run === "npm run test:property"),
    ).toBe(true);
    expect(
      minimumNode.steps.some(({ run }) => run === "npm run pack:check"),
    ).toBe(true);

    expect(test.name).toBe("Test (Pi ${{ matrix.pi-version }})");
    const versions = test.strategy?.matrix?.["pi-version"] ?? [];
    expect(test.strategy?.matrix).toEqual({
      "pi-version": ["1.2.0", "latest"],
    });
    expect(
      versions.map((version) =>
        test.name?.replace("${{ matrix.pi-version }}", version),
      ),
    ).toEqual(["Test (Pi 1.2.0)", "Test (Pi latest)"]);
  });

  it("passes the matrix SDK version to the installer", () => {
    const test = workflow.jobs.test!;
    const install = step(test, "Install selected Pi SDK");

    expect(install.env).toEqual({ PI_VERSION: "${{ matrix.pi-version }}" });
  });

  it("declares the supported Pi SDK floor without pi-server", () => {
    for (const name of [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ]) {
      expect(packageJson.peerDependencies[name]).toBe(">=1.2.0");
      expect(packageJson.devDependencies[name]).toBe("1.4.0");
    }
    expect(packageJson.peerDependencies).not.toHaveProperty(
      "@earendil-works/pi-server",
    );
    expect(packageJson.devDependencies).not.toHaveProperty(
      "@earendil-works/pi-server",
    );
    expect(packageJson.files).not.toContain("src/pi-sdk-compat.ts");
  });

  it("runs static, coverage, packaging, and session checks on their intended legs", () => {
    const test = workflow.jobs.test!;
    const steps = allSteps();
    for (const command of [
      "npm run format:check",
      "npm run coverage:check",
      "npm run pack:check",
      "npm run test:property",
    ]) {
      expect(steps.filter(({ run }) => run === command)).toHaveLength(1);
    }

    expect(normalizedCondition(step(test, "Check formatting"))).toBe(
      "matrix.pi-version == '1.2.0'",
    );
    expect(
      normalizedCondition(
        step(test, "Run unit and Pi session tests with coverage thresholds"),
      ),
    ).toBe("matrix.pi-version == '1.2.0'");
    expect(normalizedCondition(step(test, "Run unit tests"))).toBe(
      "matrix.pi-version == 'latest'",
    );
    expect(
      normalizedCondition(step(test, "Run Pi session integration tests")),
    ).toBe("matrix.pi-version == 'latest'");
    expect(packageJson.scripts["test:unit"]).toContain(
      "--exclude tests/published-tarball.test.ts",
    );
    expect(packageJson.scripts["test:unit"]).toContain(
      "--exclude 'tests/property/**'",
    );
    expect(packageJson.scripts["coverage:check"]).toContain(
      "--exclude tests/published-tarball.test.ts",
    );
  });

  it("runs real Herdr coverage on hosted runners with failure diagnostics", () => {
    const test = workflow.jobs.test!;
    const install = step(test, "Install Herdr");
    expect(install.env?.HERDR_VERSION).toBe("v0.9.0");
    expect(install.env?.HERDR_SHA256).toBe(
      "4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f",
    );
    expect(install.run).toContain("herdr-linux-x86_64");
    expect(install.run).toContain("sha256sum -c -");
    expect(step(test, "Run headless Herdr integration tests").run).toBe(
      "npm run test:herdr:headless",
    );
    expect(step(test, "Upload Herdr diagnostics").if).toBe("failure()");
    expect(packageJson.scripts["test:herdr:headless"]).toBe(
      "node --experimental-strip-types tests/helpers/herdr-headless.ts",
    );
  });

  it("keeps random and mutation scripts available only as deep checks", () => {
    const test = workflow.jobs.test!;
    const deepCondition =
      "matrix.pi-version == '1.2.0' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";
    const random = step(test, "Run randomized-order tests");
    const mutation = step(test, "Run non-blocking mutation pilot");

    expect(normalizedCondition(random)).toBe(deepCondition);
    expect(normalizedCondition(mutation)).toBe(deepCondition);
    expect(mutation["continue-on-error"]).toBe(true);
    expect(packageJson.scripts["test:random"]).toContain("--sequence.shuffle");
    expect(packageJson.scripts["test:property"]).toBe(
      "vitest run tests/property",
    );
    expect(packageJson.scripts["mutation:pilot"]).toBe("stryker run");
  });
});

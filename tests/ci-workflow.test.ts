import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const workflow = readFileSync(
  resolve(REPO, ".github/workflows/ci.yml"),
  "utf8",
);
const contributing = readFileSync(resolve(REPO, "CONTRIBUTING.md"), "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(REPO, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

function jobBlock(job: string, nextJob?: string): string {
  const start = workflow.indexOf(`\n  ${job}:`);
  const end = nextJob ? workflow.indexOf(`\n  ${nextJob}:`, start) : -1;
  expect(start).toBeGreaterThanOrEqual(0);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function stepBlock(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function occurrences(value: string): number {
  return workflow.split(value).length - 1;
}

describe("CI workflow (.github/workflows/ci.yml)", () => {
  it("validates PRs once and only runs push CI for master", () => {
    expect(workflow).toContain(
      "on:\n  push:\n    branches: [master]\n  pull_request:\n",
    );
    expect(workflow).toContain(
      "group: ci-${{ github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow).toContain('cron: "0 6 * * *"');
    expect(workflow).toContain("  workflow_dispatch:");
  });

  it("preserves all stable merge-gate check names", () => {
    const jobs = workflow.slice(workflow.indexOf("\njobs:"));
    const jobIds = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(
      (match) => match[1],
    );
    const minimumNode = jobBlock("minimum-node", "test");
    const test = jobBlock("test");

    expect(jobIds).toEqual(["minimum-node", "test"]);
    expect(minimumNode).toContain("name: Minimum Node 22.23.2");
    expect(minimumNode).toContain("node-version: 22.23.2");
    expect(minimumNode).toContain("run: npm run typecheck");
    expect(minimumNode).toContain("run: npm run test:property");
    expect(minimumNode).toContain("run: npm run pack:check");
    expect(test).toContain("name: Test (Pi ${{ matrix.pi-version }})");
    expect(test).toContain('pi-version: ["0.80.6", "latest"]');
    for (const check of [
      "Minimum Node 22.23.2",
      "Test (Pi 0.80.6)",
      "Test (Pi latest)",
    ]) {
      expect(contributing).toContain(`- \`${check}\``);
    }
  });

  it("installs the missing Pi server package for the latest SDK", () => {
    const install = stepBlock(
      "Install latest Pi server compatibility dependency",
    );
    expect(install).toContain("if: matrix.pi-version == 'latest'");
    expect(install).toContain("@earendil-works/pi-server@${PI_VERSION}");
  });

  it("runs static, coverage, and packaging checks once", () => {
    expect(occurrences("run: npm run format:check")).toBe(1);
    expect(occurrences("run: npm run coverage:check")).toBe(1);
    expect(occurrences("run: npm run pack:check")).toBe(1);
    expect(occurrences("run: npm run test:property")).toBe(1);

    expect(stepBlock("Check formatting")).toContain(
      "if: matrix.pi-version == '0.80.6'",
    );
    expect(
      stepBlock("Run unit and Pi session tests with coverage thresholds"),
    ).toContain("if: matrix.pi-version == '0.80.6'");
    expect(stepBlock("Run unit tests")).toContain(
      "if: matrix.pi-version == 'latest'",
    );
    expect(stepBlock("Run Pi session integration tests")).toContain(
      "if: matrix.pi-version == 'latest'",
    );
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

  it("keeps random and mutation scripts but runs them only as deep checks", () => {
    const random = stepBlock("Run randomized-order tests");
    const mutation = stepBlock("Run non-blocking mutation pilot");

    for (const step of [random, mutation]) {
      expect(step).toContain("matrix.pi-version == '0.80.6'");
      expect(step).toContain("github.event_name == 'schedule'");
      expect(step).toContain("github.event_name == 'workflow_dispatch'");
    }
    expect(mutation).toContain("continue-on-error: true");
    expect(packageJson.scripts["test:random"]).toContain("--sequence.shuffle");
    expect(packageJson.scripts["test:property"]).toBe(
      "vitest run tests/property",
    );
    expect(packageJson.scripts["mutation:pilot"]).toBe("stryker run");
  });
});

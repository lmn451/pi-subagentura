import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const packageJson = JSON.parse(
  readFileSync(resolve(REPO, "package.json"), "utf8"),
) as { engines?: { node?: string } };
const ciWorkflow = parse(
  readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8"),
) as {
  jobs: Record<
    string,
    {
      steps: Array<{
        uses?: string;
        with?: Record<string, unknown>;
        run?: string;
      }>;
      strategy?: { matrix?: Record<string, unknown> };
    }
  >;
};

describe("Node support policy", () => {
  it("declares the v4 workflow minimum Node runtime", () => {
    expect(packageJson.engines?.node).toBe(">=24.12.0");
  });

  it("smoke-tests the exact minimum without changing the Pi SDK matrix", () => {
    const minimum = ciWorkflow.jobs["minimum-node"];
    expect(
      minimum.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
        ?.with?.["node-version"],
    ).toBe("24.12.0");
    expect(minimum.steps.map((step) => step.run)).toContain("npm ci");
    expect(
      minimum.steps.some((step) =>
        step.run?.startsWith("PI_OFFLINE=1 npx --no-install pi"),
      ),
    ).toBe(true);
    expect(ciWorkflow.jobs.test.strategy?.matrix?.["pi-version"]).toEqual([
      "0.80.6",
      "latest",
    ]);
    expect(
      ciWorkflow.jobs.test.steps.find((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      )?.with?.["node-version"],
    ).toBe(26);
  });
});

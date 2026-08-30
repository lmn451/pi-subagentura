import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const packageJson = JSON.parse(
  readFileSync(resolve(REPO, "package.json"), "utf8"),
) as { engines?: { node?: string } };
const ciWorkflow = readFileSync(
  resolve(REPO, ".github/workflows/ci.yml"),
  "utf8",
);

function minimumNodeJob(): string {
  const start = ciWorkflow.indexOf("\n  minimum-node:");
  const end = ciWorkflow.indexOf("\n  test:", start);
  if (start === -1 || end === -1) return "";
  return ciWorkflow.slice(start, end);
}

describe("Node support policy", () => {
  it("declares the Pi SDK minimum Node runtime", () => {
    expect(packageJson.engines?.node).toBe(">=22.19.0");
  });

  it("smoke-tests the exact minimum without changing the Pi SDK matrix", () => {
    const job = minimumNodeJob();

    expect(job).toContain("node-version: 22.19.0");
    expect(job).toContain("npm ci");
    expect(job).toContain("PI_OFFLINE=1 npx --no-install pi");
    expect(ciWorkflow).toContain('pi-version: ["0.80.6", "latest"]');
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const packageJson = JSON.parse(
  readFileSync(resolve(REPO, "package.json"), "utf8"),
) as { engines?: { node?: string } };

describe("Node support policy", () => {
  it("declares the Pi SDK minimum Node runtime", () => {
    expect(packageJson.engines?.node).toBe(">=22.23.2");
  });
});

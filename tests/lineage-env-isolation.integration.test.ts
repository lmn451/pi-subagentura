import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LIVE_LINEAGE_ENV_NAMES } from "./lineage-env";

it("quarantines a test worker launched with every live lineage variable", () => {
  const injected = Object.fromEntries(
    LIVE_LINEAGE_ENV_NAMES.map((name) => [name, `live-sentinel-${name}`]),
  );
  injected.PI_SUBAGENTURA_CHILD = "1";
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "node_modules/vitest/vitest.mjs"),
      "run",
      "tests/fixtures/lineage-env-sentinel.test.ts",
      "--reporter=dot",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...injected },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  expect(result.status, result.stderr || result.stdout).toBe(0);
});

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const vitestEntry = join(projectRoot, "node_modules/vitest/vitest.mjs");
const fixture = "tests/fixtures/debug-log-env-sentinel.test.ts";

it.each(["vitest.config.ts", "vitest.mutation.config.ts"])(
  "%s keeps test diagnostics out of the inherited runtime log directory",
  (configName) => {
    const root = mkdtempSync(join(tmpdir(), "debug-log-isolation-"));
    const runtimeLogs = join(root, "runtime");
    const marker = join(root, "executed");
    const configFile = join(root, "fixture.config.mjs");
    try {
      mkdirSync(runtimeLogs);
      writeFileSync(join(runtimeLogs, "existing.log"), "preserve runtime logs");
      writeFileSync(
        configFile,
        `import config from ${JSON.stringify(join(projectRoot, configName))};
export default {
  ...config,
  test: { ...config.test, include: [${JSON.stringify(fixture)}] },
};
`,
      );
      const result = spawnSync(
        process.execPath,
        [vitestEntry, "run", "--config", configFile, "--maxWorkers=1"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            SUBAGENT_DEBUG_LOG_DIR: runtimeLogs,
            PI_DEBUG_LOG_ISOLATION_MARKER: marker,
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("executed");
      expect(readdirSync(runtimeLogs)).toEqual(["existing.log"]);
      expect(readFileSync(join(runtimeLogs, "existing.log"), "utf8")).toBe(
        "preserve runtime logs",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  40_000,
);

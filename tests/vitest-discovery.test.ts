import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const configPath = resolve(repositoryRoot, "vitest.config.ts");
const fixtureTest =
  'import { test } from "vitest";\ntest("fixture", () => {});\n';

function listFiles(fixtureRoot: string, extraArgs: string[] = []): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) delete env[key];
  }

  const result = spawnSync(
    process.execPath,
    [
      vitestCli,
      "list",
      "--filesOnly",
      "--json",
      "--root",
      fixtureRoot,
      "--config",
      configPath,
      ...extraArgs,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      timeout: 12_000,
    },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);

  const files = JSON.parse(result.stdout) as Array<{ file: string }>;
  return files
    .map(({ file }) => {
      const absoluteFile = isAbsolute(file) ? file : resolve(fixtureRoot, file);
      return relative(fixtureRoot, absoluteFile).split(sep).join("/");
    })
    .sort();
}

describe("root Vitest discovery", () => {
  it(
    "lists only root test trees and keeps the npm test exclusions",
    { timeout: 30_000 },
    () => {
      const fixtureRoot = realpathSync(
        mkdtempSync(join(tmpdir(), "pi-agents-vitest-discovery-")),
      );
      try {
        const fixturePaths = [
          "tests/root.test.ts",
          "tests/test/nested.test.ts",
          "tests/property/property.test.ts",
          "tests/tmux.integration.test.ts",
          "tests/zellij.integration.test.ts",
          "tests/herdr.integration.test.ts",
          "tests/terminal-e2e/tui.test.ts",
          ".pi/git/repo/tests/nested-repo.test.ts",
          ".worktrees/repo/tests/worktree.test.ts",
          "src/fixture.test.ts",
        ];
        for (const fixturePath of fixturePaths) {
          const filePath = join(fixtureRoot, fixturePath);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, fixtureTest);
        }

        const rootTests = [
          "tests/root.test.ts",
          "tests/test/nested.test.ts",
          "tests/property/property.test.ts",
          "tests/tmux.integration.test.ts",
          "tests/zellij.integration.test.ts",
          "tests/herdr.integration.test.ts",
          "tests/terminal-e2e/tui.test.ts",
        ].sort();
        expect(listFiles(fixtureRoot)).toEqual(rootTests);

        const npmTestExclusions = [
          "--exclude",
          "tests/tmux.integration.test.ts",
          "--exclude",
          "tests/zellij.integration.test.ts",
          "--exclude",
          "tests/herdr.integration.test.ts",
          "--exclude",
          "tests/terminal-e2e/**",
        ];
        expect(listFiles(fixtureRoot, npmTestExclusions)).toEqual(
          [
            "tests/root.test.ts",
            "tests/test/nested.test.ts",
            "tests/property/property.test.ts",
          ].sort(),
        );
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHerdrResults,
  assertManagedHerdr,
} from "./helpers/herdr-headless";

describe("required Herdr integration coverage", () => {
  const passed = {
    success: true,
    numTotalTests: 14,
    numPassedTests: 14,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTests: 0,
  };

  it("accepts a complete run and additional passing coverage", () => {
    expect(() => assertHerdrResults(passed)).not.toThrow();
    expect(() =>
      assertHerdrResults({
        ...passed,
        numTotalTests: 15,
        numPassedTests: 15,
      }),
    ).not.toThrow();
  });

  it.each([
    { numPassedTests: 0, numPendingTests: 14 },
    { numPassedTests: 13, numPendingTests: 1 },
    { numPassedTests: 13, numTodoTests: 1 },
    { success: false, numPassedTests: 13, numFailedTests: 1 },
    { numTotalTests: 0, numPassedTests: 0 },
    { numTotalTests: 13, numPassedTests: 13 },
  ])("rejects incomplete or unsuccessful reports: %j", (changes) => {
    expect(() => assertHerdrResults({ ...passed, ...changes })).toThrow(
      "at least 14 passed tests and zero skips",
    );
  });

  it.each(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"])(
    "rejects a missing %s before invoking Herdr or Vitest",
    (key) => {
      const env: NodeJS.ProcessEnv = {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/unused",
        HERDR_PANE_ID: "w1:p1",
      };
      delete env[key];
      expect(() => assertManagedHerdr(env)).toThrow(
        "requires the binary and a managed pane",
      );
    },
  );

  it("rejects a missing binary even when all pane markers are set", () => {
    expect(() =>
      assertManagedHerdr({
        PATH: "/nonexistent-herdr-test-path",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/unused",
        HERDR_PANE_ID: "w1:p1",
      }),
    ).toThrow(/ENOENT/);
  });

  it("fails instead of skipping when a managed pane is required but absent", () => {
    const env = { ...process.env };
    delete env.HERDR_ENV;
    delete env.HERDR_SOCKET_PATH;
    delete env.HERDR_PANE_ID;
    env.PI_SUBAGENTURA_HERDR_REQUIRED = "1";
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "tests/herdr.integration.test.ts",
      ],
      { env, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Herdr integration requires the binary and a managed pane",
    );
  }, 25_000);
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("incremental TypeScript checks", () => {
  it("enforces stricter indexed and optional types in dependency-light core", () => {
    const config = readJson("tsconfig.core.json");
    expect(config.extends).toBe("./tsconfig.json");
    expect(config.compilerOptions).toMatchObject({
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
    });
    expect(config.include).toEqual(
      expect.arrayContaining([
        "src/identifier-types.ts",
        "src/usage.ts",
        "typechecks/core.test-d.ts",
      ]),
    );
  });

  it("runs the stricter core check as part of the mandatory typecheck", () => {
    const scripts = readJson("package.json").scripts as Record<string, string>;
    expect(scripts["typecheck:core"]).toBe("tsc -p tsconfig.core.json");
    expect(scripts.typecheck).toContain("npm run typecheck:core");
  });

  it("checks the JavaScript worker and RPC decoder in the mandatory typecheck", () => {
    const config = readJson("tsconfig.worker.json");
    expect(config.compilerOptions).toMatchObject({
      allowJs: true,
      checkJs: true,
    });
    expect(config.include).toEqual(
      expect.arrayContaining([
        "src/workflow-worker-thread.mjs",
        "src/workflow-rpc.mjs",
      ]),
    );
    const scripts = readJson("package.json").scripts as Record<string, string>;
    expect(scripts["typecheck:worker"]).toBe("tsc -p tsconfig.worker.json");
    expect(scripts.typecheck).toContain("npm run typecheck:worker");
  });
});

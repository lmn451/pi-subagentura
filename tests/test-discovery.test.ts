import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

describe("test discovery boundary", () => {
  it("discovers only this checkout's suites", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "subagentura-discovery-")),
    );
    const expected = [
      "tests/workflow.test.ts",
      "tests/property/workflow-core.property.test.ts",
      "tests/terminal-e2e/terminal.test.ts",
    ];
    const unrelated = [
      ".worktrees/feature/tests/workflow.test.ts",
      ".worktrees/feature/.worktrees/release/tests/workflow.test.ts",
      ".empryo/checkpoint/tests/workflow.test.ts",
    ];
    try {
      for (const path of [...expected, ...unrelated]) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "");
      }
      const vitest = await createVitest({
        root,
        config: fileURLToPath(new URL("../vitest.config.ts", import.meta.url)),
        watch: false,
      });
      try {
        const specs = await vitest.globTestSpecifications();
        expect(
          specs.map((spec) => relative(root, spec.moduleId)).sort(),
        ).toEqual(expected.sort());
      } finally {
        await vitest.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

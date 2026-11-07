import { defineConfig } from "vitest/config";

// Tests should not inherit interactive child mode from the invoking process.
delete process.env.PI_SUBAGENTURA_CHILD;
// Mutation workers must not append injected failures to runtime diagnostics.
delete process.env.SUBAGENT_DEBUG_LOG_DIR;
export default defineConfig({
  test: {
    include: [
      "tests/completion-presentation.test.ts",
      "tests/property/completion-presentation.property.test.ts",
    ],
    testTimeout: 15_000,
    setupFiles: ["./tests/setup-lineage-env.ts"],
  },
});

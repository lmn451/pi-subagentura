import { defineConfig } from "vitest/config";

// Tests should not inherit interactive child mode from the invoking process.
delete process.env.PI_SUBAGENTURA_CHILD;
export default defineConfig({
  test: {
    testTimeout: 15_000,
    // `--testTimeout` does not raise this, and the terminal E2E suite tears a
    // tmux server plus a real Pi process down inside afterEach. Left at the 10s
    // default, a genuine failure can surface as a confusing hook timeout.
    hookTimeout: 30_000,
    setupFiles: ["./tests/setup-lineage-env.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Compatibility branches are exercised by the baseline/latest SDK matrix.
      exclude: ["src/ndjson.d.ts", "src/pi-sdk-compat.ts"],
      thresholds: {
        statements: 71,
        branches: 64,
        functions: 74,
        lines: 72,
      },
    },
  },
});

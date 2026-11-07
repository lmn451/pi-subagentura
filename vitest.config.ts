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
    sequence: { setupFiles: "list" },
    setupFiles: [
      "./tests/setup-telemetry-fetch-sentinel.ts",
      "./tests/setup-lineage-env.ts",
      "./tests/setup-routing-env.ts",
      "./tests/setup-telemetry-network.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 71,
        branches: 64,
        functions: 74,
        lines: 72,
      },
    },
  },
});

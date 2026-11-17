import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/fixtures/nested-pi-no-session.test.ts"],
    testTimeout: 15_000,
  },
});

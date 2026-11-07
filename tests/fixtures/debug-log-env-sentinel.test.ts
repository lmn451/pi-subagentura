import { writeFileSync } from "node:fs";
import { it } from "vitest";

const marker = process.env.PI_DEBUG_LOG_ISOLATION_MARKER;

it.skipIf(!marker)("exercises logging from a quarantined worker", async () => {
  const { debugLog } = await import("../../src/helpers");
  debugLog("warn", "test_debug_log_isolation_probe");
  writeFileSync(marker!, "executed");
});

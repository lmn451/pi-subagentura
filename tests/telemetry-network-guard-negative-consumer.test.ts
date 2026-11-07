import { appendFileSync, writeFileSync } from "node:fs";
import { describe, it, onTestFailed } from "vitest";
import { captureTelemetry, createTelemetrySession } from "../src/telemetry";
import { telemetryFetchSentinelCalls } from "./helpers/telemetry-fetch-sentinel";

const markerPath = process.env.PI_TELEMETRY_GUARD_NEGATIVE_MARKER;

describe.skipIf(
  process.env.PI_TELEMETRY_FETCH_SENTINEL !== "1" || markerPath === undefined,
)("unacknowledged telemetry lifecycle regression", () => {
  it("completes capture and is failed by the suite lifecycle hook", () => {
    if (markerPath === undefined) {
      throw new Error("The isolated regression marker path is required");
    }
    onTestFailed(() => {
      appendFileSync(markerPath, `${JSON.stringify({ testFailed: true })}\n`);
    });

    captureTelemetry(createTelemetrySession(true), {
      event: "session_started",
    });
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        callbackCompleted: true,
        sentinelCalls: telemetryFetchSentinelCalls(),
      })}\n`,
    );
  });
});

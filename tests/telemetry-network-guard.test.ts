import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const denyNetworkPreload = fileURLToPath(
  new URL("./terminal-e2e/fixtures/deny-network.cjs", import.meta.url),
);
const vitestEntry = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const configFile = fileURLToPath(
  new URL("../vitest.config.ts", import.meta.url),
);
const positiveConsumer = fileURLToPath(
  new URL("./telemetry-network-guard-consumer.test.ts", import.meta.url),
);
const negativeConsumer = fileURLToPath(
  new URL(
    "./telemetry-network-guard-negative-consumer.test.ts",
    import.meta.url,
  ),
);
type MarkerEnvironment =
  | "PI_TELEMETRY_GUARD_POSITIVE_MARKER"
  | "PI_TELEMETRY_GUARD_NEGATIVE_MARKER";

function runConsumer(
  testFile: string,
  markerEnvironment: MarkerEnvironment,
  markerPath: string,
) {
  const childEnvironment: typeof process.env = {
    ...process.env,
    PI_TELEMETRY_FETCH_SENTINEL: "1",
    PI_SUBAGENTURA_TELEMETRY_ORIGIN: "unknown",
  };
  delete childEnvironment.SUBAGENTURA_E2E_NETWORK_LOG;
  delete childEnvironment.PI_TELEMETRY_GUARD_POSITIVE_MARKER;
  delete childEnvironment.PI_TELEMETRY_GUARD_NEGATIVE_MARKER;
  childEnvironment[markerEnvironment] = markerPath;

  const escapedPreload = denyNetworkPreload
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  childEnvironment.NODE_OPTIONS = [
    childEnvironment.NODE_OPTIONS,
    `--require="${escapedPreload}"`,
  ]
    .filter(Boolean)
    .join(" ");

  return spawnSync(
    process.execPath,
    [
      "--require",
      denyNetworkPreload,
      vitestEntry,
      "run",
      testFile,
      "--config",
      configFile,
      "--maxWorkers=1",
    ],
    {
      cwd: projectRoot,
      env: childEnvironment,
      encoding: "utf8",
      timeout: 40_000,
    },
  );
}

it("blocks enabled telemetry and fails unacknowledged captures in lifecycle", () => {
  const markerRoot = mkdtempSync(join(tmpdir(), "telemetry-guard-regression-"));
  const positiveMarker = join(markerRoot, "positive.json");
  const negativeMarker = join(markerRoot, "negative.json");

  try {
    const positive = runConsumer(
      positiveConsumer,
      "PI_TELEMETRY_GUARD_POSITIVE_MARKER",
      positiveMarker,
    );
    expect(positive.error).toBeUndefined();
    expect(positive.status).toBe(0);
    expect(JSON.parse(readFileSync(positiveMarker, "utf8"))).toEqual({
      callbackCompleted: true,
      sentinelCalls: 0,
    });

    const negative = runConsumer(
      negativeConsumer,
      "PI_TELEMETRY_GUARD_NEGATIVE_MARKER",
      negativeMarker,
    );
    expect(negative.error).toBeUndefined();
    expect(negative.status).not.toBeNull();
    expect(negative.status).toBeGreaterThan(0);
    const negativeEvents = readFileSync(negativeMarker, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(negativeEvents).toEqual([
      { callbackCompleted: true, sentinelCalls: 0 },
      { testFailed: true },
    ]);
  } finally {
    rmSync(markerRoot, { recursive: true, force: true });
  }
}, 90_000);

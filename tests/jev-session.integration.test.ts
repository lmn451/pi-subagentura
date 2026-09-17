import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
let harness: PiSessionHarness | undefined;
let cwd: string | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Jev advisor in a real Pi session", () => {
  it("activates after late flag binding and survives reload without a network request", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected network"));
    vi.stubGlobal("fetch", fetch);
    cwd = mkdtempSync(join(tmpdir(), "pi-jev-session-"));

    // This real SDK harness loads the extension before applying flag values,
    // matching the CLI order that a factory-only registration check misses.
    harness = await createPiSessionHarness(cwd, {
      extensionRoot,
      extensionFlags: { orchestratorv2: true },
      bindExtensionLifecycle: true,
      includeTools: true,
    });

    expect(harness.session.getActiveToolNames()).toContain(
      "resolve_orchestrator_route",
    );
    await harness.reload();
    expect(
      harness.session
        .getActiveToolNames()
        .filter((name) => name === "resolve_orchestrator_route"),
    ).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the advisor absent in a real legacy session with the env opt-in", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected network"));
    vi.stubGlobal("fetch", fetch);
    cwd = mkdtempSync(join(tmpdir(), "pi-jev-legacy-"));
    harness = await createPiSessionHarness(cwd, {
      extensionRoot,
      extensionFlags: { orchestrator: true },
      bindExtensionLifecycle: true,
      includeTools: true,
    });

    expect(
      harness.session.getAllTools().map((tool) => tool.name),
    ).not.toContain("resolve_orchestrator_route");
    expect(fetch).not.toHaveBeenCalled();
  });
});

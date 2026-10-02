import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
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
  it.skipIf(!("classify" in ModelRegistry.prototype))(
    "registers exactly once after late flag binding and reload with native auth",
    async () => {
      vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
      vi.stubEnv("OPENROUTER_API_KEY", "synthetic-test-key");
      const fetch = vi.fn().mockRejectedValue(new Error("unexpected network"));
      vi.stubGlobal("fetch", fetch);
      cwd = mkdtempSync(join(tmpdir(), "pi-jev-enabled-"));
      harness = await createPiSessionHarness(cwd, {
        extensionRoot,
        extensionFlags: { orchestratorv2: true },
        bindExtensionLifecycle: true,
        includeTools: true,
      });
      const advisorNames = () =>
        harness!.session
          .getActiveToolNames()
          .filter((name) => name === "resolve_orchestrator_route");
      expect(advisorNames()).toHaveLength(1);
      await harness.reload();
      expect(advisorNames()).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("stays absent after late flag binding and reload without a native authenticated classifier", async () => {
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

    expect(harness.session.getActiveToolNames()).not.toContain(
      "resolve_orchestrator_route",
    );
    await harness.reload();
    expect(
      harness.session
        .getActiveToolNames()
        .filter((name) => name === "resolve_orchestrator_route"),
    ).toHaveLength(0);
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

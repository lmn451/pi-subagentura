import { describe, expect, it, vi } from "vitest";

// `sanitizeTelemetryModel` runs on the sub-agent launch path. It consults the
// host agent's model registry, which is third-party code this extension does
// not own, so a throw there must degrade the telemetry dimension rather than
// fail the launch.
vi.mock("@earendil-works/pi-ai/compat", () => ({
  getProviders: () => {
    throw new Error("provider registry unavailable");
  },
  getModel: () => {
    throw new Error("model registry unavailable");
  },
}));

const { sanitizeTelemetryModel } = await import("../src/telemetry");

describe("model sanitization with a hostile registry", () => {
  it.each([
    ["gpt-5.6-sol", "custom"],
    ["openai/gpt-5.6-sol", "custom"],
    ["", "default"],
    [undefined, "default"],
    ["default", "default"],
    ["custom", "custom"],
  ])("maps %s to %s without throwing", (model, expected) => {
    expect(() =>
      sanitizeTelemetryModel(model as string | undefined),
    ).not.toThrow();
    expect(sanitizeTelemetryModel(model as string | undefined)).toBe(expected);
  });
});

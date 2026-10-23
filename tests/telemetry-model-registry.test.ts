import { describe, expect, it, vi } from "vitest";

// `sanitizeTelemetryModel` runs on the sub-agent launch path. A generated
// catalog lookup failure must degrade this telemetry dimension, not fail launch.
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinProviders: () => {
    throw new Error("provider catalog unavailable");
  },
  getBuiltinModel: () => {
    throw new Error("model catalog unavailable");
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

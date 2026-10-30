import { describe, expect, it, vi } from "vitest";
import { createRoutingEngine, isRoutingEnabled } from "../src/routing-factory";
import { nativeClassifierRegistry } from "./helpers/native-classifier";

const env = { PI_ORCHESTRATOR_ROUTER: "jev" };

describe("native-only routing activation", () => {
  it("uses the authenticated Pi classifier without requiring an env key", () => {
    const modelRegistry = nativeClassifierRegistry();
    expect(createRoutingEngine({ env, modelRegistry })).toBeDefined();
    expect(isRoutingEnabled(env, modelRegistry)).toBe(true);
    expect(modelRegistry.findOfType).toHaveBeenCalledWith(
      "classifier",
      "openrouter",
      "~typesafe/jev-latest",
    );
    expect(modelRegistry.classify).not.toHaveBeenCalled();
  });

  it.each([undefined, "openrouter", "native", "JEV", "true", "unknown"])(
    "does not activate an unsupported selection: %s",
    (router) => {
      const modelRegistry = nativeClassifierRegistry();
      const configured = { PI_ORCHESTRATOR_ROUTER: router };
      expect(
        createRoutingEngine({ env: configured, modelRegistry }),
      ).toBeUndefined();
      expect(isRoutingEnabled(configured, modelRegistry)).toBe(false);
      expect(modelRegistry.classify).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}, { findOfType: vi.fn() }, { classify: vi.fn() }])(
    "stays disabled without the native APIs even with provider keys",
    (modelRegistry) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      expect(
        createRoutingEngine({
          env: {
            ...env,
            TYPESAFE_API_KEY: "test-key",
            OPENROUTER_API_KEY: "test-key",
          },
          modelRegistry,
        }),
      ).toBeUndefined();
      expect(isRoutingEnabled(env, modelRegistry)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      fetch.mockRestore();
    },
  );

  it("stays disabled when the classifier or authentication is unavailable", () => {
    const modelRegistry = nativeClassifierRegistry();
    modelRegistry.findOfType.mockReturnValue(undefined);
    expect(createRoutingEngine({ env, modelRegistry })).toBeUndefined();
    modelRegistry.findOfType.mockReturnValue(modelRegistry.model);
    modelRegistry.getProviderAuthStatus.mockReturnValue({ configured: false });
    expect(createRoutingEngine({ env, modelRegistry })).toBeUndefined();
    expect(modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("uses only the explicitly configured native provider/model", () => {
    const modelRegistry = nativeClassifierRegistry();
    modelRegistry.model.provider = "typesafe";
    modelRegistry.model.id = "jev-latest";
    expect(
      createRoutingEngine({
        env: {
          ...env,
          PI_ORCHESTRATOR_ROUTER_PROVIDER: "typesafe",
          PI_ORCHESTRATOR_ROUTER_MODEL: "jev-latest",
        },
        modelRegistry,
      }),
    ).toBeDefined();
    expect(modelRegistry.findOfType).toHaveBeenCalledWith(
      "classifier",
      "typesafe",
      "jev-latest",
    );
  });
});

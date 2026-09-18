import { describe, expect, it, vi } from "vitest";
import {
  configuredRoutingProvider,
  createRoutingEngine,
  isRoutingEnabled,
} from "../src/routing-factory";
import type { RoutingEngine, RoutingInput } from "../src/routing-engine";

function env(router?: string): NodeJS.ProcessEnv {
  return {
    ...(router === undefined ? {} : { PI_ORCHESTRATOR_ROUTER: router }),
    TYPESAFE_API_KEY: "test-key",
  };
}

describe("routing engine activation", () => {
  it("selects the direct Jev adapter when explicitly configured", () => {
    const engine = createRoutingEngine({
      env: env("jev"),
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(configuredRoutingProvider(env("jev"))).toBe("jev");
    expect(engine).toBeDefined();
    expect(isRoutingEnabled(env("jev"))).toBe(true);
  });

  it.each(["openjev", "llm"])(
    "keeps recognized but unimplemented provider disabled: %s",
    (router) => {
      expect(configuredRoutingProvider(env(router))).toBe(router);
      expect(createRoutingEngine({ env: env(router) })).toBeUndefined();
      expect(isRoutingEnabled(env(router))).toBe(false);
    },
  );

  it.each(["unknown", "true", "1"])(
    "does not activate a legacy or invalid provider value: %s",
    (router) => {
      expect(configuredRoutingProvider(env(router))).toBeUndefined();
      expect(createRoutingEngine({ env: env(router) })).toBeUndefined();
      expect(isRoutingEnabled(env(router))).toBe(false);
    },
  );

  it("does not activate without an explicit provider selection", () => {
    expect(configuredRoutingProvider(env())).toBeUndefined();
    expect(createRoutingEngine({ env: env() })).toBeUndefined();
    expect(isRoutingEnabled(env())).toBe(false);
  });
  it("accepts a fake engine for match and no_match decisions", async () => {
    const input: RoutingInput = {
      task: "Review the API",
      candidates: [],
    };
    const fake: RoutingEngine = {
      decide: vi
        .fn<RoutingEngine["decide"]>()
        .mockResolvedValueOnce({
          kind: "match",
          childId: "child-a",
          evidence: {
            confidence: 1,
            topProbability: 1,
            runnerUpProbability: 0,
            margin: 1,
          },
        })
        .mockResolvedValueOnce({ kind: "no_match", reason: "ambiguous" }),
    };

    await expect(fake.decide(input)).resolves.toMatchObject({
      kind: "match",
      childId: "child-a",
    });
    await expect(fake.decide(input)).resolves.toEqual({
      kind: "no_match",
      reason: "ambiguous",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createCompatibleSessionRuntime } from "../src/pi-sdk-compat";
import { createRoutingEngine } from "../src/routing-factory";
import type { RoutingInput } from "../src/routing-engine";

const hasNativeClassifier = "classify" in ModelRegistry.prototype;
const env = { PI_ORCHESTRATOR_ROUTER: "jev" };
const input: RoutingInput = {
  task: "Review the API validation",
  candidates: [
    {
      childId: "child-api",
      description: "Owns API validation",
      status: "idle",
    },
    { childId: "child-ui", description: "Owns UI styling", status: "idle" },
  ],
};
const wireResponse = {
  answers: {
    route: {
      type: "choice",
      choice: "candidate_0",
      probabilities: { candidate_0: 0.9, candidate_1: 0.05, none: 0.05 },
      confidence: 0.95,
    },
  },
  usage: { input_tokens: 20, output_tokens: 3 },
};
let agentDir: string | undefined;
let registry: ModelRegistry;
const fetch = vi.fn<typeof globalThis.fetch>();

beforeEach(async () => {
  if (!hasNativeClassifier) return;
  agentDir = mkdtempSync(join(tmpdir(), "pi-classifier-sdk-"));
  // Stub transport before runtime creation; never use real credentials or HTTP.
  fetch.mockReset().mockRejectedValue(new Error("unexpected network"));
  vi.stubGlobal("fetch", fetch);
  const runtime = await createCompatibleSessionRuntime({ agentDir });
  if (runtime.kind !== "modern") throw new Error("native runtime required");
  registry = new ModelRegistry(runtime.modelRuntime as never);
  registry.registerProvider("openrouter", { apiKey: "synthetic-sdk-test-key" });
  registry.registerProvider("typesafe", { apiKey: "synthetic-sdk-test-key" });
  fetch.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = undefined;
});

// The minimum SDK intentionally lacks classifiers; CI's latest leg runs these.
describe.skipIf(!hasNativeClassifier)("routing through Pi's native SDK", () => {
  it.each([
    ["openrouter", "~typesafe/jev-latest"],
    ["typesafe", "jev-latest"],
  ])(
    "uses the real %s catalog, auth, wire adapter and result parser",
    async (provider, model) => {
      fetch.mockResolvedValueOnce(Response.json(wireResponse));
      const onUsage = vi.fn();
      const engine = createRoutingEngine({
        env: {
          ...env,
          PI_ORCHESTRATOR_ROUTER_PROVIDER: provider,
          PI_ORCHESTRATOR_ROUTER_MODEL: model,
        },
        modelRegistry: registry,
        onUsage,
      });
      expect(engine).toBeDefined();
      await expect(engine!.decide(input)).resolves.toMatchObject({
        kind: "match",
        childId: "child-api",
        evidence: { confidence: 0.95, margin: 0.85 },
      });
      expect(fetch).toHaveBeenCalledOnce();
      const [url, request] = fetch.mock.calls[0];
      expect(new URL(String(url)).pathname).toMatch(/\/systemone$/);
      expect(new Headers(request?.headers).get("authorization")).toBe(
        "Bearer synthetic-sdk-test-key",
      );
      const payload = JSON.parse(String(request?.body));
      expect(payload.model).toBe(model);
      expect(payload.state.task).toBe(input.task);
      expect(payload.questions.route.type).toBe("choice");
      expect(Object.keys(payload.questions.route.criteria)).toEqual([
        "candidate_0",
        "candidate_1",
        "none",
      ]);
      expect(request?.body).not.toContain("child-api");
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 20,
          output: 3,
          totalTokens: 23,
        }),
      );
    },
  );

  it("rejects the old selector and requires both IDs when switching provider", () => {
    expect(
      createRoutingEngine({
        env: { PI_ORCHESTRATOR_ROUTER: "openrouter" },
        modelRegistry: registry,
      }),
    ).toBeUndefined();
    expect(
      createRoutingEngine({
        env: { ...env, PI_ORCHESTRATOR_ROUTER_PROVIDER: "typesafe" },
        modelRegistry: registry,
      }),
    ).toBeUndefined();
    expect(createRoutingEngine({ env, modelRegistry: registry })).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reduces an SDK HTTP 402 result to unavailable without leaking provider text", async () => {
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            message: "Insufficient credits: private diagnostic",
            code: 402,
          },
        },
        { status: 402 },
      ),
    );
    const engine = createRoutingEngine({ env, modelRegistry: registry });
    expect(engine).toBeDefined();
    await expect(engine!.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

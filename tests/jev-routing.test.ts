import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevRoutingEngine } from "../src/jev-routing";
import {
  decideFromRoutingChoice,
  isRoutingEvidenceSufficient,
} from "../src/routing-engine";
import type { RoutingInput } from "../src/routing-engine";
import {
  classifierResult,
  nativeClassifierRegistry,
} from "./helpers/native-classifier";

const input: RoutingInput = {
  task: "Review the API implementation",
  candidates: [
    {
      childId: "child-alpha",
      description: "Owns the API and validation.",
      aliases: ["api"],
      status: "running",
    },
    { childId: "child-beta", description: "Owns persistence.", status: "idle" },
  ],
};
const env = { PI_ORCHESTRATOR_ROUTER: "jev" };
const winner = () =>
  classifierResult("candidate_0", {
    candidate_0: 0.9,
    candidate_1: 0.05,
    none: 0.05,
  });

function setup(overrides: NodeJS.ProcessEnv = {}) {
  const modelRegistry = nativeClassifierRegistry();
  modelRegistry.classify.mockResolvedValue(winner());
  const engine = createJevRoutingEngine({
    env: { ...env, ...overrides },
    modelRegistry,
  });
  return { modelRegistry, engine: engine! };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native Jev routing", () => {
  it("calls only Pi with scrubbed opaque choices and maps a healthy winner", async () => {
    const { engine, modelRegistry } = setup({
      CUSTOM_API_KEY: "opaque-credential-value",
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      engine.decide({
        ...input,
        task: "Review child-alpha opaque-credential-value sk_live_123456789 /Users/alice/.pi/session.jsonl https://user:pass@example.test/?token=abc",
      }),
    ).resolves.toMatchObject({
      kind: "match",
      childId: "child-alpha",
      evidence: { confidence: 0.95, margin: 0.85 },
    });
    expect(modelRegistry.classify).toHaveBeenCalledOnce();
    const [model, context, options] = modelRegistry.classify.mock.calls[0];
    expect(model).toBe(modelRegistry.model);
    expect(context.questions.route.type).toBe("choice");
    expect(Object.keys(context.questions.route.criteria)).toEqual([
      "candidate_0",
      "candidate_1",
      "none",
    ]);
    expect(context).not.toHaveProperty("model");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const text = JSON.stringify(context);
    for (const secret of [
      "child-alpha",
      "child-beta",
      "sk_live_123456789",
      "/Users/alice",
      "user:pass@",
      "opaque-credential-value",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks availability and never falls back after model/auth removal", async () => {
    const { engine, modelRegistry } = setup();
    modelRegistry.findOfType.mockReturnValue(undefined);
    await expect(engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });
    modelRegistry.findOfType.mockReturnValue(modelRegistry.model);
    modelRegistry.getProviderAuthStatus.mockReturnValue({ configured: false });
    await expect(engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });
    expect(modelRegistry.classify).not.toHaveBeenCalled();
  });

  it.each([
    [
      "none",
      { candidate_0: 0.03, candidate_1: 0.07, none: 0.9 },
      0.95,
      {},
      "none",
    ],
    [
      "candidate_0",
      { candidate_0: 0.9, candidate_1: 0.05, none: 0.05 },
      0.5,
      {},
      "low_confidence",
    ],
    [
      "candidate_0",
      { candidate_0: 0.6, candidate_1: 0.35, none: 0.05 },
      0.95,
      {
        PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY: "0.5",
        PI_ORCHESTRATOR_ROUTER_MIN_MARGIN: "0.5",
      },
      "ambiguous",
    ],
    [
      "candidate_0",
      { candidate_0: 0.5, candidate_1: 0.5, none: 0 },
      1,
      {
        PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY: "0.5",
        PI_ORCHESTRATOR_ROUTER_MIN_MARGIN: "0",
      },
      "ambiguous",
    ],
  ] as const)(
    "abstains for %s / %s",
    async (choice, probabilities, confidence, overrides, reason) => {
      const { engine, modelRegistry } = setup(overrides);
      modelRegistry.classify.mockResolvedValue(
        classifierResult(choice, probabilities, confidence),
      );
      await expect(engine.decide(input)).resolves.toMatchObject({
        kind: "no_match",
        reason,
      });
    },
  );

  it.each([
    {},
    { ...winner(), stopReason: "unknown" },
    classifierResult("foreign", {
      candidate_0: 0.9,
      candidate_1: 0.05,
      none: 0.05,
    }),
    classifierResult("candidate_0", {
      candidate_0: 0.9,
      candidate_1: 0.05,
      none: 0.04,
    }),
    classifierResult("candidate_0", {
      candidate_0: 0.1,
      candidate_1: 0.8,
      none: 0.1,
    }),
    classifierResult("candidate_0", { candidate_0: 0.9, none: 0.1 }),
    classifierResult("candidate_0", {
      candidate_0: NaN,
      candidate_1: 0.05,
      none: 0.05,
    }),
    classifierResult(
      "candidate_0",
      { candidate_0: 0.9, candidate_1: 0.05, none: 0.05 },
      Infinity,
    ),
    {
      stopReason: "stop",
      answers: { route: { ...winner().answers.route, type: "bool" } },
    },
  ])("rejects invalid decoded answers", async (result) => {
    const { engine, modelRegistry } = setup();
    modelRegistry.classify.mockResolvedValue(result);
    await expect(engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "invalid_response",
    });
  });

  it.each(["error", "aborted"])(
    "handles native stopReason=%s without exposing error text",
    async (stopReason) => {
      const { engine, modelRegistry } = setup();
      modelRegistry.classify.mockResolvedValue({
        ...winner(),
        stopReason,
        errorMessage: "secret raw provider error",
      });
      await expect(engine.decide(input)).resolves.toEqual(
        stopReason === "aborted"
          ? { kind: "cancelled" }
          : { kind: "error", reason: "unavailable" },
      );
    },
  );

  it("reduces synchronous and rejected classifier errors to a closed reason", async () => {
    const { engine, modelRegistry } = setup();
    modelRegistry.classify.mockRejectedValueOnce(new Error("secret error"));
    await expect(engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });
    modelRegistry.classify.mockImplementationOnce(() => {
      throw new Error("secret error");
    });
    await expect(engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });
  });

  it("validates input and byte bounds before calling Pi", async () => {
    const { engine, modelRegistry } = setup();
    await expect(engine.decide({ ...input, candidates: [] })).resolves.toEqual({
      kind: "no_match",
      reason: "none",
    });
    await expect(
      engine.decide({
        ...input,
        candidates: [{ ...input.candidates[0], description: " " }],
      }),
    ).resolves.toEqual({ kind: "error", reason: "invalid_input" });
    await expect(
      engine.decide({
        ...input,
        candidates: [input.candidates[0], input.candidates[0]],
      }),
    ).resolves.toEqual({ kind: "error", reason: "invalid_input" });
    await expect(
      engine.decide({ ...input, task: "é".repeat(16384) }),
    ).resolves.toEqual({ kind: "error", reason: "payload_too_large" });
    expect(modelRegistry.classify).not.toHaveBeenCalled();
    const bounded = setup({ PI_ORCHESTRATOR_ROUTER_MAX_REQUEST_BYTES: "64" });
    await expect(bounded.engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });
    expect(bounded.modelRegistry.classify).not.toHaveBeenCalled();
    const response = setup({ PI_ORCHESTRATOR_ROUTER_MAX_RESPONSE_BYTES: "8" });
    await expect(response.engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });
  });

  it("enforces the llama.cpp 62-label limit without truncating candidates", async () => {
    const { engine, modelRegistry } = setup();
    modelRegistry.model.api = "llama-cpp-classify";
    const candidates = Array.from({ length: 62 }, (_, index) => ({
      ...input.candidates[0],
      childId: `child-${index}`,
    }));
    await expect(engine.decide({ ...input, candidates })).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });
    expect(modelRegistry.classify).not.toHaveBeenCalled();
    modelRegistry.classify.mockResolvedValue(
      classifierResult(
        "candidate_0",
        Object.fromEntries([
          ...candidates
            .slice(0, 61)
            .map((_, index) => [`candidate_${index}`, index === 0 ? 0.9 : 0]),
          ["none", 0.1],
        ]),
      ),
    );
    await expect(
      engine.decide({ ...input, candidates: candidates.slice(0, 61) }),
    ).resolves.toMatchObject({ kind: "match", childId: "child-0" });
  });

  it("does not apply the llama.cpp limit to Jev", async () => {
    const { engine, modelRegistry } = setup();
    const candidates = Array.from({ length: 64 }, (_, index) => ({
      ...input.candidates[0],
      childId: `child-${index}`,
    }));
    modelRegistry.classify.mockResolvedValue(
      classifierResult(
        "none",
        Object.fromEntries([
          ...candidates.map((_, index) => [`candidate_${index}`, 0]),
          ["none", 1],
        ]),
      ),
    );
    await expect(
      engine.decide({ ...input, candidates }),
    ).resolves.toMatchObject({ kind: "no_match", reason: "none" });
    expect(modelRegistry.classify).toHaveBeenCalledOnce();
  });

  it("disables invalid configuration without calling Pi", () => {
    const modelRegistry = nativeClassifierRegistry();
    for (const overrides of [
      { PI_ORCHESTRATOR_ROUTER_MIN_MARGIN: "NaN" },
      { PI_ORCHESTRATOR_ROUTER_MODEL: " " },
      { PI_ORCHESTRATOR_ROUTER_PROVIDER: "x".repeat(257) },
    ]) {
      expect(
        createJevRoutingEngine({
          env: { ...env, ...overrides },
          modelRegistry,
        }),
      ).toBeUndefined();
    }
    modelRegistry.findOfType.mockImplementation(() => {
      throw new Error("catalog failure");
    });
    expect(createJevRoutingEngine({ env, modelRegistry })).toBeUndefined();
    expect(modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("bounds blocked classification and aborts the host request on timeout", async () => {
    vi.useFakeTimers();
    const { engine, modelRegistry } = setup({
      PI_ORCHESTRATOR_ROUTER_TIMEOUT_MS: "5",
    });
    modelRegistry.classify.mockImplementation(() => new Promise(() => {}));
    const pending = engine.decide(input);
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toEqual({
      kind: "error",
      reason: "timeout",
    });
    expect(modelRegistry.classify.mock.calls[0][2].signal.aborted).toBe(true);
  });

  it("cancels blocked and pre-aborted requests and ignores late answers", async () => {
    const { engine, modelRegistry } = setup();
    let release!: (result: unknown) => void;
    modelRegistry.classify.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = engine.decide(input, controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(modelRegistry.classify.mock.calls[0][2].signal.aborted).toBe(true);
    release(winner());
    await expect(engine.decide(input, controller.signal)).resolves.toEqual({
      kind: "cancelled",
    });
    expect(modelRegistry.classify).toHaveBeenCalledOnce();
  });

  it("reports validated classifier usage separately from advice", async () => {
    const modelRegistry = nativeClassifierRegistry();
    const usage = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: {
        input: 0.01,
        output: 0.01,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.02,
      },
    };
    modelRegistry.classify.mockResolvedValue({ ...winner(), usage });
    const onUsage = vi.fn();
    const engine = createJevRoutingEngine({ env, modelRegistry, onUsage })!;
    await expect(engine.decide(input)).resolves.toMatchObject({
      kind: "match",
    });
    expect(onUsage).toHaveBeenCalledWith(usage);
  });
});

describe("routing evidence policy", () => {
  it("requires consistent positive separation", () => {
    expect(
      isRoutingEvidenceSufficient({
        confidence: 0.9,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      }),
    ).toBe(true);
    expect(
      isRoutingEvidenceSufficient(
        {
          confidence: 1,
          topProbability: 0.5,
          runnerUpProbability: 0.5,
          margin: 0,
        },
        { minConfidence: 0, minTopProbability: 0, minMargin: 0 },
      ),
    ).toBe(false);
    expect(
      decideFromRoutingChoice("child-alpha", ["child-alpha"], {
        confidence: 0.9,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.7,
      }),
    ).toEqual({ kind: "error", reason: "invalid_response" });
  });
});

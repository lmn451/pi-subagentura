import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecisionBackendError,
  type ChoiceDecisionRequest,
  type DecisionBackend,
  type DecisionPolicy,
  type DecisionObservation,
} from "../src/decision/types";
import {
  ThresholdDecisionPolicy,
  createDecisionPolicy,
} from "../src/decision/policy";
import {
  DecisionRuntime,
  MAX_DECISION_STATE_BYTES,
} from "../src/decision/runtime";

const request: ChoiceDecisionRequest<"retry" | "inspect"> = {
  state: { attempt: 1, reproduced: false },
  question: "What should happen next?",
  choices: [
    { value: "retry", description: "Retry with a modified setup." },
    { value: "inspect", description: "Inspect the failing fixture." },
  ],
};

function observation<T extends string>(
  choice: T,
  probabilities?: Partial<Record<string, number>>,
  confidence?: number,
): DecisionObservation<T> {
  return {
    choice,
    ...(probabilities === undefined
      ? {}
      : { probabilities: probabilities as Partial<Record<T, number>> }),
    ...(confidence === undefined ? {} : { confidence }),
    evidence: { calibration: "provider-calibrated" },
    provenance: { backend: "fake", model: "fake-1", remote: false },
  };
}

function backend(choose: unknown): DecisionBackend {
  return {
    id: "fake",
    capabilities: {
      choice: true,
      probabilities: true,
      confidence: true,
      calibration: "provider-calibrated",
      remote: false,
    },
    choose: choose as DecisionBackend["choose"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DecisionRuntime", () => {
  it("validates a request, invokes one injected backend, and evaluates selection", async () => {
    const choose = vi
      .fn<DecisionBackend["choose"]>()
      .mockResolvedValue(
        observation<"retry" | "inspect">(
          "retry",
          { retry: 0.9, inspect: 0.1 },
          0.95,
        ),
      );
    const runtime = new DecisionRuntime(
      backend(choose),
      new ThresholdDecisionPolicy({
        minConfidence: 0.8,
        minTopProbability: 0.8,
        minMargin: 0.2,
      }),
    );

    await expect(runtime.decide(request)).resolves.toEqual({
      kind: "selected",
      value: "retry",
      observation: observation<"retry" | "inspect">(
        "retry",
        { retry: 0.9, inspect: 0.1 },
        0.95,
      ),
    });
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.mock.calls[0]?.[0]).toEqual(request);
    expect(choose.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {
      name: "requires at least two choices",
      input: { ...request, choices: [request.choices[0]] },
    },
    {
      name: "rejects duplicate choices",
      input: {
        ...request,
        choices: [request.choices[0], { ...request.choices[0] }],
      },
    },
    {
      name: "rejects a blank question",
      input: { ...request, question: "  " },
    },
  ])("returns invalid_input when it $name", async ({ input }) => {
    const choose = vi.fn<DecisionBackend["choose"]>();
    const runtime = new DecisionRuntime(backend(choose));

    await expect(runtime.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "invalid_input",
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it("returns payload_too_large before invoking the backend", async () => {
    const choose = vi.fn<DecisionBackend["choose"]>();
    const runtime = new DecisionRuntime(backend(choose));

    await expect(
      runtime.decide({
        ...request,
        state: "x".repeat(MAX_DECISION_STATE_BYTES),
      }),
    ).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it("rejects an observation whose choice is outside the request", async () => {
    const choose = vi
      .fn<DecisionBackend["choose"]>()
      .mockResolvedValue(observation("other"));
    const runtime = new DecisionRuntime(backend(choose));

    await expect(runtime.decide(request)).resolves.toEqual({
      kind: "error",
      reason: "invalid_response",
    });
  });

  it("normalizes typed and unexpected backend failures", async () => {
    const timeout = new DecisionRuntime(
      backend(
        vi
          .fn<DecisionBackend["choose"]>()
          .mockRejectedValue(
            new DecisionBackendError(
              "timeout",
              "private provider detail",
              true,
            ),
          ),
      ),
    );
    await expect(timeout.decide(request)).resolves.toEqual({
      kind: "error",
      reason: "timeout",
    });

    const unavailable = new DecisionRuntime(
      backend(
        vi
          .fn<DecisionBackend["choose"]>()
          .mockRejectedValue(new Error("private provider detail")),
      ),
    );
    await expect(unavailable.decide(request)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });
  });

  it("returns semantic abstention without retrying or asking another backend", async () => {
    const choose = vi
      .fn<DecisionBackend["choose"]>()
      .mockResolvedValue(
        observation<"retry" | "inspect">(
          "retry",
          { retry: 0.5, inspect: 0.5 },
          0.95,
        ),
      );
    const runtime = new DecisionRuntime(
      backend(choose),
      new ThresholdDecisionPolicy({
        minConfidence: 0.8,
        minTopProbability: 0.5,
        minMargin: 0,
      }),
    );

    await expect(runtime.decide(request)).resolves.toMatchObject({
      kind: "abstain",
      reason: "ambiguous",
    });
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation and aborts the backend signal", async () => {
    const controller = new AbortController();
    let backendSignal: AbortSignal | undefined;
    const choose = vi.fn<DecisionBackend["choose"]>(
      <T extends string>(
        _request: ChoiceDecisionRequest<T>,
        signal: AbortSignal | undefined,
      ) =>
        new Promise<DecisionObservation<T>>((_resolve, _reject) => {
          backendSignal = signal;
        }),
    );
    const runtime = new DecisionRuntime(backend(choose));

    const resultPromise = runtime.decide(request, controller.signal);
    await vi.waitFor(() => expect(backendSignal).toBeDefined());
    controller.abort();

    await expect(resultPromise).resolves.toEqual({ kind: "cancelled" });
    expect(backendSignal?.aborted).toBe(true);
  });

  it("enforces an overall deadline and cleans up after success", async () => {
    let backendSignal: AbortSignal | undefined;
    const choose = vi.fn<DecisionBackend["choose"]>(
      <T extends string>(
        _request: ChoiceDecisionRequest<T>,
        signal: AbortSignal | undefined,
      ) =>
        new Promise<DecisionObservation<T>>((_resolve, _reject) => {
          backendSignal = signal;
        }),
    );
    const runtime = new DecisionRuntime(backend(choose), undefined, {
      deadlineMs: 5,
    });

    await expect(runtime.decide(request)).resolves.toEqual({
      kind: "error",
      reason: "timeout",
    });
    expect(backendSignal?.aborted).toBe(true);
  });

  it("accepts a backend without optional evidence when policy does not require it", async () => {
    const choose = vi
      .fn<DecisionBackend["choose"]>()
      .mockResolvedValue(observation("inspect"));
    const runtime = new DecisionRuntime(
      backend(choose),
      createDecisionPolicy(),
    );

    await expect(runtime.decide(request)).resolves.toEqual({
      kind: "selected",
      value: "inspect",
      observation: observation("inspect"),
    });
  });
});

it("contains hostile request getters as invalid input", async () => {
  const choose = vi.fn<DecisionBackend["choose"]>();
  const runtime = new DecisionRuntime(backend(choose));
  const hostile = new Proxy(request, {
    get() {
      throw new Error("hostile getter");
    },
  });

  await expect(
    runtime.decide(hostile as ChoiceDecisionRequest<"retry" | "inspect">),
  ).resolves.toEqual({
    kind: "error",
    reason: "invalid_input",
  });
  expect(choose).not.toHaveBeenCalled();
});

it("cancels after response validation observes an abort", async () => {
  const controller = new AbortController();
  const response = observation<"retry" | "inspect">("retry");
  Object.defineProperty(response, "choice", {
    get() {
      controller.abort();
      return "retry";
    },
  });
  const evaluate = vi.fn() as unknown as DecisionPolicy["evaluate"];
  const runtime = new DecisionRuntime(
    backend(vi.fn().mockResolvedValue(response)),
    {
      evaluate,
    },
  );

  await expect(runtime.decide(request, controller.signal)).resolves.toEqual({
    kind: "cancelled",
  });
  expect(evaluate).not.toHaveBeenCalled();
});

describe("ThresholdDecisionPolicy", () => {
  it("requires configured evidence and calibration", () => {
    const policy = new ThresholdDecisionPolicy({
      minConfidence: 0.8,
      minTopProbability: 0.8,
      minMargin: 0.2,
      acceptedCalibration: ["provider-calibrated"],
    });

    expect(
      policy.evaluate(observation<"retry" | "inspect">("retry"), request),
    ).toEqual({
      kind: "abstain",
      reason: "low_confidence",
      observation: observation<"retry" | "inspect">("retry"),
    });
    expect(
      policy.evaluate(
        {
          ...observation<"retry" | "inspect">(
            "retry",
            { retry: 0.9, inspect: 0.1 },
            0.95,
          ),
          evidence: { calibration: "uncalibrated" },
        },
        request,
      ),
    ).toEqual({
      kind: "abstain",
      reason: "low_confidence",
      observation: {
        ...observation<"retry" | "inspect">(
          "retry",
          { retry: 0.9, inspect: 0.1 },
          0.95,
        ),
        evidence: { calibration: "uncalibrated" },
      },
    });
  });
});

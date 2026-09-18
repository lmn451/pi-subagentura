import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJevRoutingEngine,
  isJevRoutingEnabled,
  JEV_ROUTING_ENDPOINT,
} from "../src/jev-routing";
import {
  decideFromRoutingChoice,
  isRoutingEvidenceSufficient,
} from "../src/routing-engine";
import type { RoutingInput } from "../src/routing-engine";

const CHILD_A = "child-alpha";
const CHILD_B = "child-beta";

const input: RoutingInput = {
  task: "Review the API implementation",
  candidates: [
    {
      childId: CHILD_A,
      description: "Owns the TypeScript API and request validation.",
      aliases: ["api", "typescript"],
      status: "running",
    },
    {
      childId: CHILD_B,
      description: "Owns persistence and migration work.",
      aliases: ["storage"],
      status: "idle",
    },
  ],
};

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PI_ORCHESTRATOR_ROUTER: "jev",
    TYPESAFE_API_KEY: "test-key",
    ...overrides,
  };
}

function providerResponse(
  choice: string,
  probabilities: Record<string, number>,
  confidence = 0.95,
): Response {
  return new Response(
    JSON.stringify({
      answers: {
        route: {
          type: "choice",
          choice,
          confidence,
          probabilities,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fetchReturning(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Jev routing adapter", () => {
  it("requires exact opt-in and a key without making disabled calls", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    expect(isJevRoutingEnabled({})).toBe(false);
    expect(isJevRoutingEnabled({ PI_ORCHESTRATOR_ROUTER: "JEV" })).toBe(false);

    const disabled = createJevRoutingEngine({
      env: {},
      fetch: fetchMock,
    });
    await expect(disabled.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "disabled",
    });

    const missingKey = createJevRoutingEngine({
      env: { PI_ORCHESTRATOR_ROUTER: "jev" },
      fetch: fetchMock,
    });
    await expect(missingKey.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "missing_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the bounded Choice request and maps a healthy winner", async () => {
    const response = providerResponse("candidate_0", {
      candidate_0: 0.9,
      candidate_1: 0.05,
      none: 0.05,
    });
    const fetchMock = fetchReturning(response) as ReturnType<typeof vi.fn>;
    const engine = createJevRoutingEngine({
      env: env(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await engine.decide({
      ...input,
      task: `${input.task} test-key sk_live_123456789 secret=/Users/alice/.pi/session.jsonl https://user:pass@example.test/?token=abc`,
      candidates: [
        {
          ...input.candidates[0],
          description: `${CHILD_A} owns sk_live_123456789`,
        },
        ...input.candidates.slice(1),
      ],
    });

    expect(result).toEqual({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.05,
        margin: 0.85,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_ROUTING_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init.body)) as {
      model: string;
      state: { task: string; candidates: Array<Record<string, unknown>> };
      questions: {
        route: { type: string; criteria: Record<string, string> };
      };
    };
    expect(body.model).toBe("jev-latest");
    expect(body.questions.route.type).toBe("choice");
    expect(Object.keys(body.questions.route.criteria).sort()).toEqual([
      "candidate_0",
      "candidate_1",
      "none",
    ]);
    expect(body.questions.route.criteria.none).toBe(
      "No existing child has responsibility for this task.",
    );
    expect(JSON.stringify(body)).not.toContain(CHILD_A);
    expect(JSON.stringify(body)).not.toContain(CHILD_B);
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(JSON.stringify(body)).toContain("[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("/Users/alice");
    expect(JSON.stringify(body)).not.toContain("user:pass@");
  });

  it("returns no-match and preserves evidence for the host", async () => {
    const engine = createJevRoutingEngine({
      env: env(),
      fetch: fetchReturning(
        providerResponse("none", {
          candidate_0: 0.03,
          candidate_1: 0.07,
          none: 0.9,
        }),
      ),
    });
    const noMatch = await engine.decide(input);
    expect(noMatch).toMatchObject({
      kind: "no_match",
      reason: "none",
    });
    expect(noMatch.kind).toBe("no_match");
    if (noMatch.kind === "no_match") {
      expect(noMatch.evidence).toMatchObject({
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.07,
      });
      expect(noMatch.evidence?.margin).toBeCloseTo(0.83);
    }
  });

  it("rejects empty candidate responsibility metadata before transport", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const engine = createJevRoutingEngine({
      env: env(),
      fetch: fetchMock,
    });
    await expect(
      engine.decide({
        ...input,
        candidates: [{ ...input.candidates[0], description: "  " }],
      }),
    ).resolves.toEqual({
      kind: "error",
      reason: "invalid_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps low-confidence and ambiguous advice closed, including ties", async () => {
    const lowConfidence = createJevRoutingEngine({
      env: env(),
      fetch: fetchReturning(
        providerResponse(
          "candidate_0",
          { candidate_0: 0.9, candidate_1: 0.05, none: 0.05 },
          0.5,
        ),
      ),
    });
    await expect(lowConfidence.decide(input)).resolves.toMatchObject({
      kind: "no_match",
      reason: "low_confidence",
    });

    const ambiguous = createJevRoutingEngine({
      env: env({
        PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY: "0.5",
        PI_ORCHESTRATOR_ROUTER_MIN_MARGIN: "0.5",
      }),
      fetch: fetchReturning(
        providerResponse("candidate_0", {
          candidate_0: 0.6,
          candidate_1: 0.35,
          none: 0.05,
        }),
      ),
    });
    await expect(ambiguous.decide(input)).resolves.toMatchObject({
      kind: "no_match",
      reason: "ambiguous",
    });

    const tie = createJevRoutingEngine({
      env: env({
        PI_ORCHESTRATOR_ROUTER_MIN_CONFIDENCE: "0",
        PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY: "0.5",
        PI_ORCHESTRATOR_ROUTER_MIN_MARGIN: "0",
      }),
      fetch: fetchReturning(
        providerResponse("candidate_0", {
          candidate_0: 0.5,
          candidate_1: 0.5,
          none: 0,
        }),
      ),
    });
    await expect(tie.decide(input)).resolves.toMatchObject({
      kind: "no_match",
      reason: "ambiguous",
    });
  });

  it("rejects malformed, unknown, non-unit, and non-argmax responses", async () => {
    const bodies: Response[] = [
      new Response("not-json", { status: 200 }),
      providerResponse("candidate_0", {
        candidate_0: 0.9,
        candidate_1: 0.05,
        none: 0.04,
      }),
      providerResponse("candidate_0", {
        candidate_0: 0.1,
        candidate_1: 0.8,
        none: 0.1,
      }),
      new Response(
        JSON.stringify({
          answers: {
            route: {
              type: "ranking",
              choice: "candidate_0",
              confidence: 0.9,
              probabilities: {
                candidate_0: 0.9,
                candidate_1: 0.05,
                none: 0.05,
              },
            },
          },
        }),
        { status: 200 },
      ),
    ];
    for (const body of bodies) {
      const engine = createJevRoutingEngine({
        env: env(),
        fetch: fetchReturning(body),
      });
      await expect(engine.decide(input)).resolves.toMatchObject({
        kind: "error",
        reason: "invalid_response",
      });
    }
  });

  it("returns closed transport failures and honors request/response bounds", async () => {
    const unavailable = createJevRoutingEngine({
      env: env(),
      fetch: vi.fn(async () => {
        throw new Error("provider body must not escape");
      }) as unknown as typeof fetch,
    });
    await expect(unavailable.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    });

    const tooLargeRequest = createJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_MAX_REQUEST_BYTES: "64" }),
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(tooLargeRequest.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });

    const tooLargeResponse = createJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_MAX_RESPONSE_BYTES: "8" }),
      fetch: fetchReturning(
        providerResponse("candidate_0", {
          candidate_0: 0.9,
          candidate_1: 0.05,
          none: 0.05,
        }),
      ),
    });
    await expect(tooLargeResponse.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });
  });

  it("rejects non-finite or out-of-range environment thresholds", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const engine = createJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_MIN_MARGIN: "NaN" }),
      fetch: fetchMock,
    });
    await expect(engine.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "invalid_config",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("completes timeout and caller cancellation while transport is blocked", async () => {
    const timeout = createJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_TIMEOUT_MS: "5" }),
      fetch: vi.fn(
        () => new Promise<Response>(() => undefined),
      ) as unknown as typeof fetch,
    });
    const timeoutResult = await timeout.decide(input);
    expect(timeoutResult).toEqual({
      kind: "error",
      reason: "timeout",
    });

    let releaseBody!: () => void;
    const blockedBody = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const blockedResponse = {
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () =>
            blockedBody.then(() => ({ done: true, value: undefined })),
          releaseLock: vi.fn(),
        }),
      },
    } as unknown as Response;
    const cancellation = new AbortController();
    const cancelled = createJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_TIMEOUT_MS: "1000" }),
      fetch: fetchReturning(blockedResponse),
    });
    const resultPromise = cancelled.decide(input, cancellation.signal);
    await vi.waitFor(() => expect(releaseBody).toBeTypeOf("function"));
    cancellation.abort();
    await expect(resultPromise).resolves.toEqual({ kind: "cancelled" });
    releaseBody();
  });
});

describe("routing evidence policy", () => {
  it("requires consistent positive separation and rejects an exact tie", () => {
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
      decideFromRoutingChoice(CHILD_A, [CHILD_A, CHILD_B], {
        confidence: 0.9,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.7,
      }),
    ).toEqual({
      kind: "error",
      reason: "invalid_response",
    });
  });
});

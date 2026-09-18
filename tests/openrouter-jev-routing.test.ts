import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenRouterJevRoutingEngine,
  isOpenRouterJevRoutingEnabled,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_JEV_ROUTING_ENDPOINT,
  OPENROUTER_JEV_ROUTING_MODEL,
  OPENROUTER_JEV_MODEL_ENV,
} from "../src/openrouter-jev-routing";
import {
  configuredRoutingProvider,
  createRoutingEngine,
  isRoutingEnabled,
} from "../src/routing-factory";
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
    PI_ORCHESTRATOR_ROUTER: "openrouter",
    [OPENROUTER_API_KEY_ENV]: "openrouter-test-key",
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

describe("OpenRouter Jev routing adapter", () => {
  it("requires exact opt-in and a key without making disabled calls", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    expect(isOpenRouterJevRoutingEnabled({})).toBe(false);
    expect(
      isOpenRouterJevRoutingEnabled({ PI_ORCHESTRATOR_ROUTER: "OPENROUTER" }),
    ).toBe(false);

    const disabled = createOpenRouterJevRoutingEngine({
      env: {},
      fetch: fetchMock,
    });
    await expect(disabled.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "disabled",
    });

    const missingKey = createOpenRouterJevRoutingEngine({
      env: { PI_ORCHESTRATOR_ROUTER: "openrouter" },
      fetch: fetchMock,
    });
    await expect(missingKey.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "missing_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is selected by the provider-neutral factory only when explicitly configured", () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const configured = env();
    const engine = createRoutingEngine({ env: configured, fetch: fetchMock });

    expect(configuredRoutingProvider(configured)).toBe("openrouter");
    expect(engine).toBeDefined();
    expect(isRoutingEnabled(configured)).toBe(true);

    for (const provider of ["openjev", "llm"]) {
      const inactive = { ...configured, PI_ORCHESTRATOR_ROUTER: provider };
      expect(configuredRoutingProvider(inactive)).toBe(provider);
      expect(createRoutingEngine({ env: inactive })).toBeUndefined();
      expect(isRoutingEnabled(inactive)).toBe(false);
    }
    expect(
      createRoutingEngine({
        env: { [OPENROUTER_API_KEY_ENV]: "must-not-enable" },
      }),
    ).toBeUndefined();
  });

  it("sends the Decisions System-One Choice shape with local tokens and auth", async () => {
    const response = providerResponse("candidate_0", {
      candidate_0: 0.9,
      candidate_1: 0.05,
      none: 0.05,
    });
    const fetchMock = fetchReturning(response) as ReturnType<typeof vi.fn>;
    const engine = createOpenRouterJevRoutingEngine({
      env: env(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await engine.decide({
      ...input,
      task: `${input.task} openrouter-test-key sk_live_123456789 secret=/Users/alice/.pi/session.jsonl https://user:pass@example.test/?token=abc`,
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
    expect(url).toBe(OPENROUTER_JEV_ROUTING_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer openrouter-test-key",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init.body)) as {
      model: string;
      state: { task: string; candidates: Array<Record<string, unknown>> };
      questions: {
        route: {
          type: string;
          instructions: string;
          criteria: Record<string, string>;
        };
      };
    };
    expect(body.model).toBe(OPENROUTER_JEV_ROUTING_MODEL);
    expect(body.state.candidates.map((candidate) => candidate.option)).toEqual([
      "candidate_0",
      "candidate_1",
    ]);
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
    expect(JSON.stringify(body)).not.toContain("openrouter-test-key");
    expect(JSON.stringify(body)).toContain("[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("/Users/alice");
    expect(JSON.stringify(body)).not.toContain("user:pass@");
  });

  it("supports a documented model override without changing the endpoint", async () => {
    const fetchMock = fetchReturning(
      providerResponse("none", {
        candidate_0: 0.05,
        candidate_1: 0.05,
        none: 0.9,
      }),
    ) as ReturnType<typeof vi.fn>;
    const engine = createOpenRouterJevRoutingEngine({
      env: env({ [OPENROUTER_JEV_MODEL_ENV]: "~typesafe/jev-1.13" }),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(engine.decide(input)).resolves.toMatchObject({
      kind: "no_match",
      reason: "none",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("~typesafe/jev-1.13");
  });

  it("returns no_match for the explicit none answer", async () => {
    const engine = createOpenRouterJevRoutingEngine({
      env: env(),
      fetch: fetchReturning(
        providerResponse("none", {
          candidate_0: 0.03,
          candidate_1: 0.07,
          none: 0.9,
        }),
      ),
    });

    await expect(engine.decide(input)).resolves.toMatchObject({
      kind: "no_match",
      reason: "none",
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.07,
      },
    });
  });

  it("fails closed for malformed, unsupported, non-unit, and non-argmax responses", async () => {
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
      const engine = createOpenRouterJevRoutingEngine({
        env: env(),
        fetch: fetchReturning(body),
      });
      await expect(engine.decide(input)).resolves.toEqual({
        kind: "error",
        reason: "invalid_response",
      });
    }
  });

  it("maps HTTP and rate-limit responses to closed errors without exposing bodies", async () => {
    for (const status of [401, 429, 500]) {
      const engine = createOpenRouterJevRoutingEngine({
        env: env(),
        fetch: fetchReturning(
          new Response(`secret provider body ${status}`, { status }),
        ),
      });
      await expect(engine.decide(input)).resolves.toEqual({
        kind: "error",
        reason: "unavailable",
      });
    }
  });

  it("honors request and response bounds before accepting provider data", async () => {
    const requestFetch = vi.fn() as unknown as typeof fetch;
    const tooLargeRequest = createOpenRouterJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_MAX_REQUEST_BYTES: "64" }),
      fetch: requestFetch,
    });
    await expect(tooLargeRequest.decide(input)).resolves.toEqual({
      kind: "error",
      reason: "payload_too_large",
    });
    expect(requestFetch).not.toHaveBeenCalled();

    const tooLargeResponse = createOpenRouterJevRoutingEngine({
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

  it("completes timeout and caller cancellation while transport is blocked", async () => {
    const timeout = createOpenRouterJevRoutingEngine({
      env: env({ PI_ORCHESTRATOR_ROUTER_TIMEOUT_MS: "5" }),
      fetch: vi.fn(
        () => new Promise<Response>(() => undefined),
      ) as unknown as typeof fetch,
    });
    await expect(timeout.decide(input)).resolves.toEqual({
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
    const cancelled = createOpenRouterJevRoutingEngine({
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

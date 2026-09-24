import { describe, expect, it, vi } from "vitest";
import { createJevRoutingEngine } from "../src/jev-routing";
import { createOpenRouterJevRoutingEngine } from "../src/openrouter-jev-routing";

const providers = [
  { provider: "jev", createEngine: createJevRoutingEngine },
  { provider: "openrouter", createEngine: createOpenRouterJevRoutingEngine },
];
const assignments = [
  '{"password":"sensitive-password-without-known-prefix"}',
  '{"AWS_SECRET_ACCESS_KEY":"sensitive-aws-secret"}',
  '{"api_key" : "sensitive-api-key"}',
  "{'token': 'sensitive-token'}",
  '{"password":"sensitive password tail-secret"}',
  '{"password":"sensitive\\\"quoted tail-secret"}',
  "password=sensitive-password",
  'password="sensitive password tail-secret"',
  'password="sensitive-partial-password',
  "token='sensitive-partial-token",
];

describe.each(providers)(
  "$provider credential redaction",
  ({ provider, createEngine }) => {
    it.each(assignments)(
      "scrubs %s in task and candidate metadata",
      async (assignment) => {
        const fetchMock = vi.fn<typeof fetch>(
          async () =>
            new Response(
              JSON.stringify({
                answers: {
                  route: {
                    type: "choice",
                    choice: "none",
                    confidence: 0.9,
                    probabilities: { candidate_0: 0.05, none: 0.95 },
                  },
                },
              }),
            ),
        );
        const engine = createEngine({
          env: {
            PI_ORCHESTRATOR_ROUTER: provider,
            TYPESAFE_API_KEY: "test-key",
            OPENROUTER_API_KEY: "test-key",
          },
          fetch: fetchMock,
        });
        const decision = await engine.decide({
          task: `Review API configuration ${assignment}`,
          candidates: [
            {
              childId: "0123456789abcdef",
              description: `Owns API configuration ${assignment}`,
              aliases: [`API ${assignment}`],
              status: "idle",
            },
          ],
        });
        const body = String(fetchMock.mock.calls[0][1]?.body);
        const payload = JSON.parse(body);
        expect(decision.kind).toBe("no_match");
        expect(body).not.toMatch(/sensitive|tail-secret/);
        expect(payload.state.task).toContain("Review API configuration");
        expect(payload.state.task).toContain("[REDACTED]");
        expect(payload.state.candidates[0].description).toContain("[REDACTED]");
        expect(payload.state.candidates[0].aliases[0]).toContain("[REDACTED]");
        expect(payload.questions.route.criteria.candidate_0).toContain(
          "[REDACTED]",
        );
      },
    );
  },
);

import { describe, expect, it } from "vitest";
import { createJevRoutingEngine } from "../src/jev-routing";
import { nativeClassifierRegistry } from "./helpers/native-classifier";

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

describe("native classifier credential redaction", () => {
  it.each(assignments)("scrubs %s in task and metadata", async (assignment) => {
    const modelRegistry = nativeClassifierRegistry();
    const engine = createJevRoutingEngine({
      env: { PI_ORCHESTRATOR_ROUTER: "jev" },
      modelRegistry,
    })!;
    await engine.decide({
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
    const payload = modelRegistry.classify.mock.calls[0][1];
    expect(JSON.stringify(payload)).not.toMatch(/sensitive|tail-secret/);
    expect(payload.state.task).toContain("Review API configuration");
    expect(payload.state.task).toContain("[REDACTED]");
    expect(payload.state.candidates[0].description).toContain("[REDACTED]");
    expect(payload.state.candidates[0].aliases[0]).toContain("[REDACTED]");
    expect(payload.questions.route.criteria.candidate_0).toContain(
      "[REDACTED]",
    );
  });
});

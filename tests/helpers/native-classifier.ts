import { vi } from "vitest";

export function classifierResult(
  choice = "candidate_0",
  probabilities: Record<string, number> = { candidate_0: 0.9, none: 0.1 },
  confidence = 0.95,
) {
  return {
    stopReason: "stop",
    answers: {
      route: { type: "choice", choice, probabilities, confidence },
    },
  };
}

export function nativeClassifierRegistry() {
  const model = {
    type: "classifier",
    provider: "openrouter",
    id: "~typesafe/jev-latest",
    api: "typesafe-system-one",
  };
  return {
    model,
    findOfType: vi.fn(() => model as typeof model | undefined),
    getProviderAuthStatus: vi.fn(() => ({ configured: true })),
    classify: vi.fn().mockResolvedValue(classifierResult()),
  };
}

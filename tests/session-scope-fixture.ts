import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSessionScope,
  registerSessionScope,
  type SessionScope,
} from "../src/session-scope";

/** A real registered owner for tests that exercise session-scoped operations. */
export function createTestSessionScope(
  overrides: Partial<SessionScope> = {},
): SessionScope {
  const scope = createSessionScope(overrides.pi ?? ({} as ExtensionAPI));
  Object.assign(scope, {
    generation: 1,
    lifecycle: "started",
    sessionManager: {
      getSessionId: () => `test-session-${scope.id}`,
      getEntries: () => [],
    },
    ...overrides,
  });
  return registerSessionScope(scope);
}

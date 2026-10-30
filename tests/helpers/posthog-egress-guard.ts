const guardKey = Symbol.for("pi-subagentura.posthog-egress-guard");
const posthogServiceDomains = ["posthog.com", "posthog.io"] as const;
const maxBlockedAttempts = 1_000;

interface GuardState {
  guardedFetch: typeof fetch;
  testActive: boolean;
  fetchAtTestStart: typeof fetch | undefined;
  testBlockedAttempts: number;
  expectedTestAttempts: number;
  outsideBlockedAttempts: number;
}

function getState(): GuardState {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[guardKey] as GuardState | undefined;
  if (existing) return existing;

  const originalFetch = globalThis.fetch;
  let state: GuardState;
  const guardedFetch: typeof fetch = function (input, init) {
    if (isPosthogServiceRequest(input)) {
      if (state.testActive) {
        state.testBlockedAttempts = Math.min(
          state.testBlockedAttempts + 1,
          maxBlockedAttempts,
        );
      } else {
        state.outsideBlockedAttempts = Math.min(
          state.outsideBlockedAttempts + 1,
          maxBlockedAttempts,
        );
      }
      return Promise.reject(
        new TypeError("PostHog network access is blocked in tests"),
      );
    }

    return Reflect.apply(originalFetch, globalThis, [input, init]);
  };
  state = {
    guardedFetch,
    testActive: false,
    fetchAtTestStart: undefined,
    testBlockedAttempts: 0,
    expectedTestAttempts: 0,
    outsideBlockedAttempts: 0,
  };
  registry[guardKey] = state;
  return state;
}

export function isPosthogServiceRequest(
  input: Parameters<typeof fetch>[0] | URL,
): boolean {
  let rawUrl: string | undefined;
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.href;
  } else if (input !== null && typeof input === "object") {
    rawUrl = input.url;
  }
  if (rawUrl === undefined) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return posthogServiceDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

export function installPosthogEgressGuard(): void {
  const state = getState();
  globalThis.fetch = state.guardedFetch;
}

export function beginPosthogGuardedTest(): void {
  const state = getState();
  state.testActive = true;
  state.fetchAtTestStart = globalThis.fetch;
  state.testBlockedAttempts = 0;
  state.expectedTestAttempts = 0;
}

export function expectBlockedPosthogFetches(count: number): void {
  const state = getState();
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Expected blocked PostHog fetch count must be positive");
  }

  if (state.testActive) {
    if (state.testBlockedAttempts !== count) {
      throw new Error(
        `Expected ${count} blocked PostHog fetches, observed ${state.testBlockedAttempts}`,
      );
    }
    state.expectedTestAttempts = count;
    return;
  }

  if (state.outsideBlockedAttempts !== count) {
    throw new Error(
      `Expected ${count} blocked PostHog fetches, observed ${state.outsideBlockedAttempts}`,
    );
  }
  state.outsideBlockedAttempts = 0;
}

export function assertNoUnexpectedPosthogFetches(): void {
  const state = getState();
  if (!state.testActive) return;

  const testBlockedAttempts = state.testBlockedAttempts;
  const expectedTestAttempts = state.expectedTestAttempts;
  const outsideBlockedAttempts = state.outsideBlockedAttempts;
  const fetchAtTestStart = state.fetchAtTestStart;
  state.testActive = false;
  state.fetchAtTestStart = undefined;
  state.testBlockedAttempts = 0;
  state.expectedTestAttempts = 0;
  state.outsideBlockedAttempts = 0;
  if (fetchAtTestStart !== undefined) {
    globalThis.fetch = fetchAtTestStart;
  }

  const failures: string[] = [];
  if (outsideBlockedAttempts > 0) {
    failures.push(
      `Blocked ${outsideBlockedAttempts} PostHog fetch attempt(s) outside the test body`,
    );
  }
  if (testBlockedAttempts !== expectedTestAttempts) {
    failures.push(
      `Blocked ${testBlockedAttempts} unmocked PostHog fetch attempt(s) during the test; ` +
        `expected ${expectedTestAttempts}`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

export function assertPosthogGuardedSuiteComplete(): void {
  const state = getState();
  const outsideBlockedAttempts = state.outsideBlockedAttempts;
  state.outsideBlockedAttempts = 0;
  state.testActive = false;
  state.fetchAtTestStart = undefined;
  state.testBlockedAttempts = 0;
  state.expectedTestAttempts = 0;
  globalThis.fetch = state.guardedFetch;

  if (outsideBlockedAttempts > 0) {
    throw new Error(
      `Blocked ${outsideBlockedAttempts} unacknowledged PostHog fetch attempt(s) during suite lifetime`,
    );
  }
}

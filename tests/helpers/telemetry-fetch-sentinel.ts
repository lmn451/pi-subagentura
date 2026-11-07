const sentinelKey = Symbol.for("pi-subagentura.telemetry-fetch-sentinel");

type SentinelState = {
  calls: number;
  armed: boolean;
};

function getState(): SentinelState {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[sentinelKey] as SentinelState | undefined;
  if (existing) return existing;

  const created: SentinelState = { calls: 0, armed: false };
  registry[sentinelKey] = created;
  return created;
}

export function installTelemetryFetchSentinel(): void {
  const state = getState();
  if (state.armed) return;

  state.calls = 0;
  state.armed = true;
  globalThis.fetch = (async () => {
    state.calls += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

export function clearTelemetryFetchSentinelCalls(): void {
  getState().calls = 0;
}

export function telemetryFetchSentinelCalls(): number {
  return getState().calls;
}

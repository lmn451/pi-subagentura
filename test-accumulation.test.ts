import { describe, it, expect } from "bun:test";

// ── Bug 2: Output reset on turn_start ──────────────────────────────

function createLiveStatus() {
  return {
    turn: 0,
    output: "",
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    activeTool: undefined as { name: string; args: Record<string, unknown> } | undefined,
  };
}

function simulateTurnStart(status: ReturnType<typeof createLiveStatus>) {
  status.turn++;
  status.usage.turns = status.turn;
  // FIX: Reset output on each new turn
  status.output = "";
}

function simulateTextDelta(status: ReturnType<typeof createLiveStatus>, delta: string) {
  status.output += delta;
}

function simulateTurnEnd(status: ReturnType<typeof createLiveStatus>) {
  status.activeTool = undefined;
}

// ── Bug 1: Debounce activeTool ─────────────────────────────────────

const DEBOUNCE_MS = 150;

function createDebounceHarness() {
  let activeToolTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActiveTool: { name: string; args: Record<string, unknown> } | undefined;
  const state = { activeTool: undefined as typeof pendingActiveTool };

  function setActiveToolDebounced(tool: typeof pendingActiveTool) {
    pendingActiveTool = tool;
    if (activeToolTimer) {
      clearTimeout(activeToolTimer);
      activeToolTimer = undefined;
    }
    if (tool) {
      activeToolTimer = setTimeout(() => {
        activeToolTimer = undefined;
        state.activeTool = pendingActiveTool;
      }, DEBOUNCE_MS);
    } else {
      if (state.activeTool) {
        state.activeTool = undefined;
      }
    }
  }

  return { state, setActiveToolDebounced };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Bug 2: Output reset on turn_start", () => {
  it("should only show current turn's output, not accumulated text", () => {
    const status = createLiveStatus();

    simulateTurnStart(status); // turn 1
    simulateTextDelta(status, "Analyzing code...");
    simulateTurnEnd(status);

    simulateTurnStart(status); // turn 2
    simulateTextDelta(status, "Found bug in line 42.");
    simulateTurnEnd(status);

    simulateTurnStart(status); // turn 3
    simulateTextDelta(status, "Fixing now...");
    simulateTurnEnd(status);

    expect(status.turn).toBe(3);
    expect(status.output).toBe("Fixing now...");
  });

  it("should reset output to empty string at start of each turn", () => {
    const status = createLiveStatus();

    simulateTurnStart(status);
    simulateTextDelta(status, "Hello");
    expect(status.output).toBe("Hello");

    simulateTurnStart(status); // resets output
    expect(status.output).toBe("");

    simulateTextDelta(status, "World");
    expect(status.output).toBe("World");
  });
});

describe("Bug 1: Debounce activeTool", () => {
  it("should not show activeTool for fast tool calls (synchronous start+end)", () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    // Fast tool: start then end synchronously (within the same tick)
    setActiveToolDebounced({ name: "read", args: { path: "/foo" } });
    setActiveToolDebounced(undefined);

    // activeTool should remain undefined — no flicker
    expect(state.activeTool).toBeUndefined();
  });

  it("should show activeTool after debounce period for slow tools", async () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    setActiveToolDebounced({ name: "bash", args: { command: "sleep 5" } });

    // Before debounce fires: not visible yet
    expect(state.activeTool).toBeUndefined();

    // Wait past debounce threshold
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    // Now the activeTool should be committed
    expect(state.activeTool).toEqual({ name: "bash", args: { command: "sleep 5" } });
  });

  it("should clear activeTool immediately when a committed tool ends", async () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    setActiveToolDebounced({ name: "bash", args: { command: "sleep 5" } });
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    expect(state.activeTool).toBeDefined();

    // Slow tool finishes — clear immediately, no debounce delay
    setActiveToolDebounced(undefined);
    expect(state.activeTool).toBeUndefined();
  });

  it("should cancel pending timer if tool ends before debounce fires", () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    // Start a tool (timer begins)
    setActiveToolDebounced({ name: "read", args: { path: "/bar" } });

    // Tool finishes fast — cancels the timer, activeTool never appears
    setActiveToolDebounced(undefined);
    expect(state.activeTool).toBeUndefined();
  });
});
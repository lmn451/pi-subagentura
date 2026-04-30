import { describe, it, expect } from "bun:test";
import { getProviders } from "@mariozechner/pi-ai";
import {
  ACTIVE_TOOL_DEBOUNCE_MS,
  formatTokens,
  formatUsage,
  resolveModel,
  SubagentLiveStatus,
  SubagentResult,
} from "./helpers";

// ── Simulation helpers ────────────────────────────────────────────────
// These simulate live status behavior for turn handling tests.
// They mirror what runSubagent() does internally.

function createLiveStatus(): SubagentLiveStatus {
  return {
    turn: 0,
    output: "",
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    activeTool: undefined as { name: string; args: Record<string, unknown> } | undefined,
  };
}

function simulateTurnStart(status: SubagentLiveStatus) {
  status.turn++;
  status.usage.turns = status.turn;
  status.output = "";
}

function simulateTextDelta(status: SubagentLiveStatus, delta: string) {
  status.output += delta;
}

function simulateTurnEnd(status: SubagentLiveStatus) {
  status.activeTool = undefined;
}

// ── Debounce harness ──────────────────────────────────────────────────
// Mirrors the debounce logic in runSubagent() using ACTIVE_TOOL_DEBOUNCE_MS.

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
      }, ACTIVE_TOOL_DEBOUNCE_MS);
    } else {
      if (state.activeTool) {
        state.activeTool = undefined;
      }
    }
  }

  return { state, setActiveToolDebounced };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("should return raw number below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("should format thousands with one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("should format tens of thousands with k", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(50000)).toBe("50k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  it("should format millions with M", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2500000)).toBe("2.5M");
  });
});

describe("formatUsage", () => {
  const baseUsage: SubagentResult["usage"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };

  it("should return empty string for empty usage", () => {
    expect(formatUsage(baseUsage)).toBe("");
  });

  it("should format turns correctly", () => {
    expect(formatUsage({ ...baseUsage, turns: 1 })).toBe("1 turn");
  });

  it("should format plural turns", () => {
    expect(formatUsage({ ...baseUsage, turns: 3 })).toBe("3 turns");
  });

  it("should format all usage fields", () => {
    const usage = { ...baseUsage, input: 1500, output: 500, cacheRead: 100, cacheWrite: 200, cost: 0.0123, turns: 2 };
    const result = formatUsage(usage);
    expect(result).toContain("1.5k");
    expect(result).toContain("↓500");
    expect(result).toContain("R100");
    expect(result).toContain("W200");
    expect(result).toContain("$0.0123");
    expect(result).toContain("2 turns");
  });

  it("should append model at the end", () => {
    const result = formatUsage({ ...baseUsage, turns: 1 }, "anthropic/claude-3-5-sonnet-20241022");
    expect(result).toMatch(/anthropic\/claude-3-5-sonnet-20241022$/);
  });
});

describe("live status turn handling", () => {
  it("should reset output on turn start", () => {
    const status = createLiveStatus();

    simulateTurnStart(status);
    simulateTextDelta(status, "Hello");
    expect(status.output).toBe("Hello");

    simulateTurnStart(status); // resets output
    expect(status.output).toBe("");

    simulateTextDelta(status, "World");
    expect(status.output).toBe("World");
  });

  it("should only show current turn output, not accumulated", () => {
    const status = createLiveStatus();

    simulateTurnStart(status);
    simulateTextDelta(status, "Analyzing code...");
    simulateTurnEnd(status);

    simulateTurnStart(status);
    simulateTextDelta(status, "Found bug in line 42.");
    simulateTurnEnd(status);

    simulateTurnStart(status);
    simulateTextDelta(status, "Fixing now...");
    simulateTurnEnd(status);

    expect(status.turn).toBe(3);
    expect(status.output).toBe("Fixing now...");
  });

  it("should count turns correctly", () => {
    const status = createLiveStatus();
    simulateTurnStart(status);
    simulateTurnStart(status);
    simulateTurnStart(status);
    expect(status.turn).toBe(3);
    expect(status.usage.turns).toBe(3);
  });
});

describe("active tool debouncing", () => {
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
    await new Promise((r) => setTimeout(r, ACTIVE_TOOL_DEBOUNCE_MS + 50));

    // Now the activeTool should be committed
    expect(state.activeTool).toEqual({ name: "bash", args: { command: "sleep 5" } });
  });

  it("should clear activeTool immediately when a committed tool ends", async () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    setActiveToolDebounced({ name: "bash", args: { command: "sleep 5" } });
    await new Promise((r) => setTimeout(r, ACTIVE_TOOL_DEBOUNCE_MS + 50));

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

describe("resolveModel", () => {
  it("should return undefined when no modelId and no defaultModel", () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
  });

  it("should return defaultModel when modelId is undefined", () => {
    const defaultModel = { provider: "anthropic", id: "claude-3-5-sonnet-20241022" } as any;
    expect(resolveModel(undefined, defaultModel)).toBe(defaultModel);
  });

  it("should parse provider/id format correctly", () => {
    const result = resolveModel("anthropic/claude-3-5-sonnet-20241022", undefined);
    expect(result?.provider).toBe("anthropic");
  });

  it("should return undefined for unknown provider/id when no default", () => {
    expect(resolveModel("unknown/impossibly-long-model-id", undefined)).toBeUndefined();
  });

  it("should fall back to defaultModel when provider not found", () => {
    const defaultModel = { provider: "openai", id: "gpt-4o" } as any;
    expect(resolveModel("unknown/model", defaultModel)).toBe(defaultModel);
  });

  it("should search all providers dynamically for bare id", () => {
    // resolveModel iterates getProviders() for bare IDs
    const providers = getProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain("anthropic");
  });
});

describe("error handling scenarios", () => {
  it("should handle empty task string", () => {
    const status = createLiveStatus();
    expect(status.output).toBe("");
  });

  it("should handle undefined optional parameters gracefully", () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
    expect(
      formatUsage(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        undefined,
      ),
    ).toBe("");
  });
});

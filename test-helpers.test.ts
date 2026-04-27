import { describe, it, expect } from "bun:test";

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
  status.output = "";
}

function simulateTextDelta(status: ReturnType<typeof createLiveStatus>, delta: string) {
  status.output += delta;
}

function simulateTurnEnd(status: ReturnType<typeof createLiveStatus>) {
  status.activeTool = undefined;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(
  u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number },
  model?: string,
): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function resolveModel(
  modelId: string | undefined,
  defaultModel: { provider: string; id: string } | undefined,
): { provider: string; id: string } | undefined {
  if (!modelId) return defaultModel;

  if (modelId.includes("/")) {
    const [provider, id] = modelId.split("/", 2);
    const providerToModel: Record<string, string> = {
      anthropic: "claude",
      openai: "gpt",
      google: "gemini",
      deepseek: "deepseek-chat",
      openrouter: "openrouter",
    };
    return providerToModel[provider] ? { provider, id } : defaultModel;
  }

  const searchOrder = ["anthropic", "openai", "google", "deepseek", "openrouter"];
  for (const p of searchOrder) {
    if (p === "anthropic") return { provider: p, id: modelId };
  }

  return defaultModel;
}

describe("resolveModel", () => {
  it("should return undefined when no modelId and no defaultModel", () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
  });

  it("should return defaultModel when modelId is undefined", () => {
    const defaultModel = { provider: "anthropic", id: "claude-3-5-sonnet-20241022" };
    expect(resolveModel(undefined, defaultModel)).toBe(defaultModel);
  });

  it("should parse provider/id format correctly", () => {
    const result = resolveModel("anthropic/claude-3-5-sonnet-20241022", undefined);
    expect(result?.provider).toBe("anthropic");
    expect(result?.id).toBe("claude-3-5-sonnet-20241022");
  });

  it("should return undefined for unknown provider/id when no default", () => {
    expect(resolveModel("unknown/impossibly-long-model-id", undefined)).toBeUndefined();
  });

  it("should fall back to defaultModel when provider not found", () => {
    const defaultModel = { provider: "openai", id: "gpt-4o" };
    expect(resolveModel("unknown/model", defaultModel)).toBe(defaultModel);
  });

  it("should search known providers in order for bare id", () => {
    const searchLog: string[] = [];
    const searchOrder = ["anthropic", "openai", "google", "deepseek", "openrouter"];
    for (const p of searchOrder) {
      searchLog.push(p);
      if (p === "anthropic") break;
    }
    expect(searchLog).toEqual(["anthropic"]);
  });
});

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
  const baseUsage = {
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
    const usage = {
      input: 1500,
      output: 500,
      cacheRead: 100,
      cacheWrite: 200,
      cost: 0.0123,
      turns: 2,
    };
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

    simulateTurnStart(status);
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

describe("error handling scenarios", () => {
  it("should use targetModel as fallback when session.model is undefined", () => {
    const targetModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const result = resolveModel(undefined, targetModel);
    expect(result).not.toBeUndefined();
    expect(result?.provider).toBe("anthropic");
  });

  it("should handle empty task string", () => {
    const status = createLiveStatus();
    expect(status.output).toBe("");
  });

  it("should handle undefined optional parameters gracefully", () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
    expect(formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, undefined)).toBe("");
  });
});
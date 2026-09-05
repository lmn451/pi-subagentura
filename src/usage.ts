/**
 * Dependency-light usage primitives shared by workflow accounting and the
 * Pi-facing helpers. This module intentionally does not import an SDK.
 */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Pricing provenance; "mixed" is used only for aggregated samples. */
  costSource?: "provider" | "estimated" | "unavailable" | "mixed";
  turns: number;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export function normalizeUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  const cacheRead = usageNumber(usage.cacheRead);
  const cacheWrite = usageNumber(usage.cacheWrite);
  const cost = usageNumber(usage.cost);
  const hasAccounting =
    input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || cost > 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    ...(hasAccounting && usage.costSource
      ? { costSource: usage.costSource }
      : {}),
    turns: usageNumber(usage.turns),
  };
}

type AssistantCostSource = Exclude<NonNullable<Usage["costSource"]>, "mixed">;

function mergeUsageCostSource(
  existing: Usage["costSource"],
  next: Usage["costSource"],
): Usage["costSource"] {
  if (!next) return existing;
  if (!existing) return next;
  if (existing === next) return existing;
  return "mixed";
}

/** Return a new aggregate; callers never share mutable accounting state. */
export function addUsageSamples(total: Usage, next: Usage): Usage {
  const costSource = mergeUsageCostSource(total.costSource, next.costSource);
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    cost: total.cost + next.cost,
    ...(costSource ? { costSource } : {}),
    turns: total.turns + next.turns,
  };
}

/** Extract one assistant-message usage record without mutating it. */
export function usageFromAssistantMessage(
  message: unknown,
  turns = 1,
): Usage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { role?: unknown; usage?: unknown };
  if (
    candidate.role !== "assistant" ||
    !candidate.usage ||
    typeof candidate.usage !== "object"
  ) {
    return undefined;
  }
  const raw = candidate.usage as Record<string, unknown>;
  const rawCost = raw.cost;
  const cost =
    typeof rawCost === "number"
      ? usageNumber(rawCost)
      : rawCost && typeof rawCost === "object"
        ? usageNumber((rawCost as Record<string, unknown>).total)
        : 0;
  const input = usageNumber(raw.input);
  const output = usageNumber(raw.output);
  const cacheRead = usageNumber(raw.cacheRead);
  const cacheWrite = usageNumber(raw.cacheWrite);
  const rawCostSource = raw.costSource;
  const explicitSource: AssistantCostSource | undefined =
    rawCostSource === "provider" ||
    rawCostSource === "estimated" ||
    rawCostSource === "unavailable"
      ? rawCostSource
      : undefined;
  const hasAccounting =
    input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || cost > 0;
  const costSource = hasAccounting
    ? (explicitSource ?? (cost > 0 ? "estimated" : "unavailable"))
    : undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    ...(costSource ? { costSource } : {}),
    turns: Math.max(0, turns),
  };
}

/** Aggregate assistant usage from a session, falling back to the live sample. */
export function usageFromAssistantMessages(
  messages: readonly unknown[],
  fallback: Usage,
): Usage {
  let total = zeroUsage();
  let found = false;
  for (const message of messages) {
    const usage = usageFromAssistantMessage(message);
    if (!usage) continue;
    found = true;
    total = addUsageSamples(total, usage);
  }
  return found ? total : { ...fallback };
}

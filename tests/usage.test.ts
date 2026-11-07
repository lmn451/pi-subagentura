import { describe, expect, it } from "vitest";
import {
  usageFromAssistantMessage,
  usageFromAssistantMessages,
  zeroUsage,
} from "../src/usage";

describe("Pi 1.5 cost provenance", () => {
  it.each([0, 0.02])("recognizes a provider-billed total of %s", (total) => {
    expect(
      usageFromAssistantMessage({
        role: "assistant",
        usage: { input: 1, cost: { total, totalFromProvider: true } },
      }),
    ).toMatchObject({ cost: total, costSource: "provider" });
  });
  it.each([false, undefined, "true"])(
    "does not trust a provider flag of %s",
    (totalFromProvider) => {
      expect(
        usageFromAssistantMessage({
          role: "assistant",
          usage: { input: 1, cost: { total: 0.02, totalFromProvider } },
        }),
      ).toMatchObject({ costSource: "estimated" });
    },
  );
  it.each([undefined, -1, NaN, Infinity, "0.02"])(
    "does not label an invalid total %s as billed",
    (total) => {
      expect(
        usageFromAssistantMessage({
          role: "assistant",
          usage: { input: 1, cost: { total, totalFromProvider: true } },
        }),
      ).toMatchObject({ cost: 0, costSource: "unavailable" });
    },
  );
  it("preserves legacy explicit provenance", () => {
    expect(
      usageFromAssistantMessage({
        role: "assistant",
        usage: { input: 1, cost: 0.02, costSource: "provider" },
      }),
    ).toMatchObject({ costSource: "provider" });
  });
  it("aggregates billed and estimated turns as mixed", () => {
    const usage = usageFromAssistantMessages(
      [
        {
          role: "assistant",
          usage: { input: 1, cost: { total: 0.02, totalFromProvider: true } },
        },
        { role: "assistant", usage: { input: 1, cost: { total: 0.03 } } },
      ],
      zeroUsage(),
    );
    expect(usage).toMatchObject({ cost: 0.05, costSource: "mixed", turns: 2 });
  });
  it("keeps an empty sample provenance-free", () => {
    expect(
      usageFromAssistantMessage({
        role: "assistant",
        usage: { cost: { total: 0, totalFromProvider: true } },
      })?.costSource,
    ).toBeUndefined();
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addWorkflowUsage,
  extractJson,
  sanitizeWorkflowName,
  validateSchema,
  zeroWorkflowUsage,
} from "../../src/workflow-core";
import { propertyParameters } from "./property-options";

const nameStartCharacters = "abcdefghijklmnopqrstuvwxyz0123456789";
const nameCharacters = `${nameStartCharacters}-`;

function characterFrom(characters: string) {
  return fc
    .integer({ min: 0, max: characters.length - 1 })
    .map((index) => characters[index]!);
}

const workflowName = fc
  .tuple(
    characterFrom(nameStartCharacters),
    fc.array(characterFrom(nameCharacters), { maxLength: 63 }),
  )
  .map(([first, rest]) => `${first}${rest.join("")}`);

const usage = fc
  .record({
    input: fc.nat({ max: 10_000 }),
    output: fc.nat({ max: 10_000 }),
    cacheRead: fc.nat({ max: 10_000 }),
    cacheWrite: fc.nat({ max: 10_000 }),
    cost: fc.nat({ max: 10_000 }),
    turns: fc.nat({ max: 100 }),
  })
  .map((value) => ({ ...value, costSource: "provider" as const }));

describe("workflow core properties", () => {
  it("round-trips bounded JSON text through strict extraction", () => {
    fc.assert(
      fc.property(fc.json({ maxDepth: 3 }), (json) => {
        expect(extractJson(` \n${json}\t `)).toBe(json);
      }),
      propertyParameters(),
    );
  });

  it("rejects JSON scalars surrounded by prose", () => {
    fc.assert(
      fc.property(fc.integer(), (value) => {
        expect(extractJson(`before ${value} after`)).toBeNull();
      }),
      propertyParameters(),
    );
  });

  it("enforces generated array cardinality bounds", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 12 }),
        fc.nat({ max: 12 }),
        fc.nat({ max: 12 }),
        (firstBound, secondBound, length) => {
          const minItems = Math.min(firstBound, secondBound);
          const maxItems = Math.max(firstBound, secondBound);
          const errors = validateSchema(Array.from({ length }), {
            type: "array",
            minItems,
            maxItems,
          });

          if (length < minItems) {
            expect(errors).toEqual([
              `$: expected >= ${minItems} items, got ${length}`,
            ]);
          } else if (length > maxItems) {
            expect(errors).toEqual([
              `$: expected <= ${maxItems} items, got ${length}`,
            ]);
          } else {
            expect(errors).toEqual([]);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it("accepts every bounded workflow name generated from its grammar", () => {
    fc.assert(
      fc.property(workflowName, (name) => {
        expect(sanitizeWorkflowName(name)).toBe(name);
      }),
      propertyParameters(),
    );
  });

  it("aggregates bounded usage without mutating its inputs", () => {
    fc.assert(
      fc.property(fc.array(usage, { maxLength: 20 }), (samples) => {
        const originalSamples = structuredClone(samples);
        const initial = zeroWorkflowUsage();
        const aggregate = samples.reduce(addWorkflowUsage, initial);
        const sum = (field: keyof (typeof samples)[number]) =>
          samples.reduce((total, sample) => total + Number(sample[field]), 0);
        const hasAccounting = samples.some(
          (sample) =>
            sample.input > 0 ||
            sample.output > 0 ||
            sample.cacheRead > 0 ||
            sample.cacheWrite > 0 ||
            sample.cost > 0,
        );
        const input = sum("input");
        const output = sum("output");
        const cacheRead = sum("cacheRead");
        const cacheWrite = sum("cacheWrite");

        expect(aggregate).toEqual({
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: input + output + cacheRead + cacheWrite,
          costUsd: sum("cost"),
          turns: sum("turns"),
          ...(hasAccounting ? { costSource: "provider" } : {}),
        });
        expect(samples).toEqual(originalSamples);
        expect(initial).toEqual(zeroWorkflowUsage());
      }),
      propertyParameters(),
    );
  });
});

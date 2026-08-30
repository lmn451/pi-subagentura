import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_COMPLETION_DISPLAY_LABEL_LENGTH,
  completionDisplayLabel,
  formatCompletionMessage,
} from "../../src/completion-presentation";
import { propertyParameters } from "./property-options";

const boundedDisplayInput = fc.oneof(
  fc.string({ maxLength: 500 }),
  fc
    .array(fc.integer({ min: 0, max: 0x9f }), { maxLength: 500 })
    .map((codes) => String.fromCharCode(...codes)),
);
const ignoredDisplaySuffixPrefix = "\0".repeat(
  MAX_COMPLETION_DISPLAY_LABEL_LENGTH * 4,
);
const visibleDisplayText = fc
  .array(fc.integer({ min: 0x61, max: 0x7a }), {
    minLength: 1,
    maxLength: 32,
  })
  .map((codes) => String.fromCharCode(...codes));

describe("completion presentation properties", () => {
  it("normalizes arbitrary labels to a bounded idempotent display value", () => {
    fc.assert(
      fc.property(boundedDisplayInput, (prefix) => {
        const label = completionDisplayLabel(`${prefix}visible`);

        expect(label.length).toBeGreaterThan(0);
        expect(label.length).toBeLessThanOrEqual(
          MAX_COMPLETION_DISPLAY_LABEL_LENGTH,
        );
        expect(label).toBe(label.trim());
        expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
        expect(label).not.toMatch(/\s{2,}/u);
        expect(completionDisplayLabel(label)).toBe(label);
      }),
      propertyParameters(),
    );
  });

  it("preserves visible content inside the bounded input window", () => {
    fc.assert(
      fc.property(visibleDisplayText, (text) => {
        const paddingLength =
          MAX_COMPLETION_DISPLAY_LABEL_LENGTH * 4 - text.length;
        const label = completionDisplayLabel(
          `${"\0".repeat(paddingLength)}${text}`,
          "fallback",
        );

        expect(label).toBe(text);
      }),
      propertyParameters(),
    );
  });

  it("falls back when the bounded input window normalizes empty", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0x1f }), {
          minLength: 1,
          maxLength: 64,
        }),
        boundedDisplayInput,
        (codes, ignoredSuffix) => {
          const controls = String.fromCharCode(...codes);
          expect(completionDisplayLabel(controls)).toBe("sub-agent");
          expect(
            completionDisplayLabel(
              `${ignoredDisplaySuffixPrefix}${ignoredSuffix}visible`,
              "fallback",
            ),
          ).toBe("fallback");
        },
      ),
      propertyParameters(),
    );
  });

  it("uses the caller fallback for every non-string label", () => {
    const nonString = fc.oneof(
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 4 }),
    );

    fc.assert(
      fc.property(
        nonString,
        fc.string({ maxLength: 64 }),
        (value, fallback) => {
          expect(completionDisplayLabel(value, fallback)).toBe(fallback);
        },
      ),
      propertyParameters(),
    );
  });

  it("formats arbitrary safe labels without changing message text", () => {
    fc.assert(
      fc.property(
        boundedDisplayInput,
        fc.string({ maxLength: 200 }),
        (prefix, text) => {
          const label = completionDisplayLabel(`${prefix}visible`);
          expect(formatCompletionMessage(label, text)).toBe(
            `from: ${label}, ${text}`,
          );
        },
      ),
      propertyParameters(),
    );
  });
});

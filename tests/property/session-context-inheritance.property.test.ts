import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { getParentContextMessages } from "../../src/pi-sdk-compat";
import { propertyParameters } from "./property-options";

describe("parent context inheritance properties", () => {
  it("uses projected messages across omission and replacement edits", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.option(fc.string({ maxLength: 100 }), { nil: null }),
        (originalContent, replacementContent) => {
          const projectedMessages =
            replacementContent === null
              ? []
              : [{ role: "user", content: replacementContent }];
          const sessionManager = {
            getBranch: () => [
              {
                type: "message",
                message: { role: "user", content: originalContent },
              },
            ],
            buildSessionProjection: () => ({ messages: projectedMessages }),
          };

          expect(getParentContextMessages(sessionManager)).toEqual(
            projectedMessages,
          );
        },
      ),
      propertyParameters(),
    );
  });
});

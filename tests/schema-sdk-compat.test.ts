import { expect, expectTypeOf, it } from "vitest";
import type { Static } from "typebox";
import { BaseParams, InteractiveParams } from "../src/schemas";

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

it("retains literal thinking levels across Pi SDK versions", () => {
  expectTypeOf<Static<typeof BaseParams>["thinkingLevel"]>().toEqualTypeOf<
    ThinkingLevel | undefined
  >();
  expectTypeOf<
    Static<typeof InteractiveParams>["thinkingLevel"]
  >().toEqualTypeOf<ThinkingLevel | undefined>();
  expect(BaseParams.properties.thinkingLevel).toMatchObject({
    type: "string",
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  });
});

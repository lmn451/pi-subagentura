import { validateToolArguments } from "@earendil-works/pi-ai";
import { expect, expectTypeOf, it } from "vitest";
import type { Static } from "typebox";
import {
  BaseParams,
  InteractiveParams,
  MAX_INTERACTIVE_CONTEXT_BYTES,
  ResultParams,
} from "../src/schemas";

function validate(
  parameters:
    | typeof BaseParams
    | typeof InteractiveParams
    | typeof ResultParams,
  args: object,
) {
  return validateToolArguments(
    { name: "schema_compat", description: "SDK validation", parameters },
    {
      type: "toolCall",
      id: "compat",
      name: "schema_compat",
      arguments: args as Parameters<
        typeof validateToolArguments
      >[1]["arguments"],
    },
  );
}

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

it("validates tool schemas through the installed Pi SDK", () => {
  expect(validate(BaseParams, { task: "review", maxAge: "1000" })).toEqual({
    task: "review",
    maxAge: 1000,
  });
  expect(
    validate(InteractiveParams, {
      task: "review",
      includeContext: false,
      context: "handoff",
      routingDescription: "reviewer",
      routingAliases: ["review"],
    }),
  ).toMatchObject({ includeContext: false, context: "handoff" });
});

it.each([
  { maxAge: -1 },
  { maxAge: 2_147_483_648 },
  { thinkingLevel: "invalid" },
  { completionGroupId: "../unsafe" },
  { completionGroupId: "x".repeat(129) },
  { notifyOnComplete: "inject" },
])("retains spawn bounds through Pi validation (case %#)", (args) => {
  expect(() => validate(BaseParams, { task: "review", ...args })).toThrow();
});

it.each([
  { includeContext: true, context: "handoff" },
  { context: "handoff" },
  { routingAliases: ["review"] },
  {
    includeContext: false,
    context: "x".repeat(MAX_INTERACTIVE_CONTEXT_BYTES + 1),
  },
  { mux: "unknown" },
  { unknownField: true },
])(
  "retains interactive constraints through Pi validation (case %#)",
  (args) => {
    expect(() =>
      validate(InteractiveParams, { task: "review", ...args }),
    ).toThrow();
  },
);

it.each([0, 300_001])(
  "retains result wait bounds through Pi validation: %s",
  (timeoutMs) => {
    expect(() => validate(ResultParams, { jobId: "job", timeoutMs })).toThrow();
  },
);

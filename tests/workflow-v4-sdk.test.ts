import { describe, expect, it } from "vitest";
import { defineWorkflow, schema } from "../src/workflow-v4-sdk.mjs";

describe("v4 workflow SDK", () => {
  it("builds the supported JSON Schema subset and marks optional fields", () => {
    const input = schema.object({
      path: schema.string(),
      includeTests: schema.optional(schema.boolean()),
      files: schema.array(schema.string()),
    });

    expect(input).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        includeTests: { type: "boolean" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["path", "files"],
      additionalProperties: false,
    });
  });

  it("preserves a valid typed definition for the runtime", () => {
    const definition = defineWorkflow({
      name: "review-auth",
      version: 2,
      description: "Review auth",
      input: schema.object({ path: schema.string() }),
      output: schema.object({ issues: schema.array(schema.string()) }),
      async run(_ctx, args) {
        return { issues: args.path ? [] : ["missing path"] };
      },
    });

    expect(definition.name).toBe("review-auth");
    expect(definition.version).toBe(2);
    expect(definition.run).toBeTypeOf("function");
  });

  it.each([
    [{ name: "Bad Name", version: 1, run() {} }, /name/],
    [{ name: "valid", version: 0, run() {} }, /version/],
    [{ name: "valid", version: 1 }, /run/],
  ])("rejects invalid definition metadata", (definition, error) => {
    expect(() => defineWorkflow(definition as never)).toThrow(error);
  });
});

import { describe, expect, it } from "vitest";
import { createWorkflowStructuredOutputTool } from "../src/workflow-structured-output";

describe("workflow structured output tool", () => {
  it("captures tool output and sets terminate", async () => {
    const tool = createWorkflowStructuredOutputTool({ type: "number" });

    const result = await tool.tool.execute("call-1", { value: 42 });

    expect(result.terminate).toBe(true);
    expect(tool.capture).toEqual({ called: true, value: 42 });
    expect(result.details).toEqual({ value: 42 });
  });

  it("builds tool parameters with a required value field", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    const tool = createWorkflowStructuredOutputTool(schema);

    expect(tool.tool.parameters).toMatchObject({
      type: "object",
      required: ["value"],
      properties: {
        value: schema,
      },
    });
  });

  it("marks structured-output tools as sequential", () => {
    const tool = createWorkflowStructuredOutputTool({ type: "string" });
    expect(tool.tool.executionMode).toBe("sequential");
  });

  it("requests preferred JSON-schema constrained sampling", () => {
    const tool = createWorkflowStructuredOutputTool({ type: "string" });
    expect(tool.tool.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
  });
});

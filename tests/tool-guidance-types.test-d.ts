import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerToolWithDefaultGuidance } from "../src/tool-guidance";

declare const pi: ExtensionAPI;
const parameters = Type.Object({ jobId: Type.String() });

type Details = { jobId: string; count: number };

registerToolWithDefaultGuidance<typeof parameters, Details>(pi, {
  name: "typed_contract",
  label: "Typed Contract",
  description: "Compile-time SDK result and rendering contract.",
  parameters,
  async execute(_id, params) {
    const jobId: string = params.jobId;
    // @ts-expect-error TypeBox parameters must not degrade to any.
    params.unknownParameter;
    return {
      content: [{ type: "text", text: jobId }],
      details: { jobId, count: 1 },
      structuredContent: { jobId, count: 1 },
    };
  },
  renderResult(result, _options, _theme, context) {
    const count: number = result.details.count;
    // @ts-expect-error Details retain the known numeric result contract.
    const invalid: string = result.details.count;
    // @ts-expect-error The default renderer state is unknown, not any.
    context.state.notARealProperty;
    void count;
    void invalid;
    throw new Error("Compile-time only");
  },
});

const invalidTool: ToolDefinition<typeof parameters, Details, unknown> = {
  name: "invalid_contract",
  label: "Invalid Contract",
  description: "Reject malformed tool results.",
  parameters,
  // @ts-expect-error Tool results require SDK content and known numeric details.
  async execute() {
    return {
      content: [{ type: "not_content", text: "bad" }],
      details: { jobId: "id", count: "not a number" },
    };
  },
};
void invalidTool;

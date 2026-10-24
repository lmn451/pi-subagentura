import { Type, type TObject, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface WorkflowStructuredOutputCapture {
  called: boolean;
  value: unknown;
}

type WorkflowStructuredOutputParameters = TObject<{ value: TSchema }>;

function wrapSchemaWithValue(
  schema: unknown,
): WorkflowStructuredOutputParameters {
  return Type.Object(
    {
      value: schema as TSchema,
    },
    { required: ["value"] },
  );
}

export function createWorkflowStructuredOutputTool(schema: unknown) {
  const capture: WorkflowStructuredOutputCapture = {
    called: false,
    value: undefined,
  };

  const wrappedSchema = wrapSchemaWithValue(schema);

  return {
    capture,
    tool: {
      name: "structured_output",
      label: "structured output",
      description:
        "Return the final structured output for workflow schema-driven calls.",
      parameters: wrappedSchema,
      constrainedSampling: {
        type: "json_schema",
        strict: "prefer",
      },
      executionMode: "sequential",
      async execute(
        _toolCallId: string,
        params: { value: unknown },
      ): Promise<AgentToolResult<{ value: unknown }>> {
        capture.called = true;
        capture.value = params.value;
        return Promise.resolve({
          content: [{ type: "text", text: "Structured output captured." }],
          details: { value: params.value },
          terminate: true,
        });
      },
    } satisfies ToolDefinition<
      WorkflowStructuredOutputParameters,
      { value: unknown }
    >,
  };
}

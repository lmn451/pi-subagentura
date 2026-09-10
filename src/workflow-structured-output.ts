import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface WorkflowStructuredOutputCapture {
  called: boolean;
  value: unknown;
}

interface WorkflowStructuredOutputToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  constrainedSampling: {
    type: "json_schema";
    strict: "prefer";
  };
  executionMode: "sequential";
  execute(
    _toolCallId: string,
    params: { value: unknown },
    _signal?: AbortSignal,
    _onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ): Promise<AgentToolResult<{ value: unknown }>>;
}

export interface WorkflowStructuredOutputTool {
  tool: WorkflowStructuredOutputToolDefinition;
  capture: WorkflowStructuredOutputCapture;
}

function wrapSchemaWithValue(schema: unknown): unknown {
  return Type.Object(
    {
      value: schema as any,
    },
    { required: ["value"] },
  );
}

export function createWorkflowStructuredOutputTool(
  schema: unknown,
): WorkflowStructuredOutputTool {
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
    },
  };
}

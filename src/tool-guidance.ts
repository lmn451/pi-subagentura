import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { withOperationTelemetry } from "./telemetry-operations";

export const TOOL_DEFAULT_GUIDANCE =
  "Treat documented defaults as reasonable defaults. Override them only when the user explicitly asks.";

export function registerToolWithDefaultGuidance<
  TParams extends TSchema,
  TDetails = unknown,
  TState = any,
>(pi: ExtensionAPI, tool: ToolDefinition<TParams, TDetails, TState>): void {
  pi.registerTool({
    ...tool,
    description: `${tool.description}\n${TOOL_DEFAULT_GUIDANCE}`,
    execute: withOperationTelemetry(pi, "tool", tool.name, tool.execute, 2),
  });
}

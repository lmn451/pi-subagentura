import { Container, Text } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { debugLog } from "./helpers";
import { withOperationTelemetry } from "./telemetry-operations";

export const TOOL_DEFAULT_GUIDANCE =
  "Treat documented defaults as reasonable defaults. Override them only when the user explicitly asks.";

export function registerToolWithDefaultGuidance<
  TParams extends TSchema,
  TDetails = unknown,
  TState = any,
>(pi: ExtensionAPI, tool: ToolDefinition<TParams, TDetails, TState>): void {
  const executeWithTelemetry = withOperationTelemetry(
    pi,
    "tool",
    tool.name,
    tool.execute,
    2,
  );
  pi.registerTool({
    ...tool,
    description: `${tool.description}\n${TOOL_DEFAULT_GUIDANCE}`,
    execute(toolCallId, args, signal, onUpdate, ctx) {
      debugLog("info", "extension_tool_call", { toolName: tool.name, args });
      return executeWithTelemetry(toolCallId, args, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const summary =
        tool.renderCall?.(args, theme, context) ??
        new Text(theme.fg("toolTitle", theme.bold(tool.label)), 0, 0);
      if (!context?.expanded) return summary;

      let parameters: string;
      try {
        parameters = JSON.stringify(args, null, 2) ?? "{}";
      } catch {
        parameters = "[parameters unavailable]";
      }

      const component = new Container();
      component.addChild(summary);
      component.addChild(new Text(theme.fg("muted", "Parameters:"), 0, 0));
      component.addChild(new Text(theme.fg("toolOutput", parameters), 0, 0));
      return component;
    },
  });
}

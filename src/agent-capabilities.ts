/** Built-in Pi tools exposed to read-only workflow agents. */
export const READ_ONLY_AGENT_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
] as const;

/** Pi tool names that remain available unless explicitly denied. */
export const READ_ONLY_AGENT_EXCLUDED_TOOL_NAMES = [
  "mcp__*",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

/** Child-only CLI flag marking workflow read-only process launches. */
export const READ_ONLY_WORKFLOW_FLAG = "subagentura-workflow-read-only";

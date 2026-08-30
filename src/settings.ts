import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_DEPTH_FLAG = "subagentura-max-depth";
export const HIDE_AGENTS_LIST_FLAG = "subagentura-hide-agents-list";
export const DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH = 2;
const MAX_CONFIGURED_DEPTH = 64;

export interface ExtensionSettings {
  maxDepth: number;
  hideAgentsList: boolean;
}

export function registerExtensionSettings(pi: ExtensionAPI): void {
  pi.registerFlag(MAX_DEPTH_FLAG, {
    description:
      "Maximum Orchestratorv2 lineage depth (default: 2; legacy stays at 8)",
    type: "string",
    default: String(DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH),
  });
  pi.registerFlag(HIDE_AGENTS_LIST_FLAG, {
    description:
      "Hide agent-list tools and the visual agent list/status supervisor",
    type: "boolean",
    default: false,
  });
}

export function readExtensionSettings(pi: ExtensionAPI): ExtensionSettings {
  const maxDepthValue = readFlag(pi, MAX_DEPTH_FLAG);
  const hideAgentsListValue = readFlag(pi, HIDE_AGENTS_LIST_FLAG);
  return {
    maxDepth: parseMaxDepth(maxDepthValue),
    hideAgentsList: parseHideAgentsList(hideAgentsListValue),
  };
}

function readFlag(pi: ExtensionAPI, name: string): unknown {
  const getFlag = (pi as Partial<ExtensionAPI>).getFlag;
  if (typeof getFlag !== "function") return undefined;
  return getFlag.call(pi, name);
}

function parseMaxDepth(value: unknown): number {
  if (value === undefined || value === false) {
    return DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `${MAX_DEPTH_FLAG} (max depth) must be a non-negative integer no greater than ${MAX_CONFIGURED_DEPTH}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_CONFIGURED_DEPTH) {
    throw new Error(
      `${MAX_DEPTH_FLAG} (max depth) must be a non-negative integer no greater than ${MAX_CONFIGURED_DEPTH}`,
    );
  }
  return parsed;
}

function parseHideAgentsList(value: unknown): boolean {
  if (value === undefined || typeof value === "boolean") return value ?? false;
  throw new Error(
    `${HIDE_AGENTS_LIST_FLAG} (hide agents list) must be a boolean`,
  );
}

export function isAgentsListHidden(pi: ExtensionAPI): boolean {
  return readExtensionSettings(pi).hideAgentsList;
}

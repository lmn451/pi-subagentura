import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_DEPTH_FLAG = "subagentura-max-depth";
export const HIDE_AGENT_LIST_FLAG = "subagentura-hide-agent-list";
export const DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH = 2;
const MAX_CONFIGURED_DEPTH = 64;

export interface ExtensionSettings {
  maxDepth: number;
  hideAgentList: boolean;
}

export function registerExtensionSettings(pi: ExtensionAPI): void {
  pi.registerFlag(MAX_DEPTH_FLAG, {
    description:
      "Maximum Orchestratorv2 lineage depth (default: 2; legacy stays at 8)",
    type: "string",
    default: String(DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH),
  });
  pi.registerFlag(HIDE_AGENT_LIST_FLAG, {
    description: "Hide compact per-agent activity widget rows",
    type: "boolean",
    default: false,
  });
}

export function readExtensionSettings(pi: ExtensionAPI): ExtensionSettings {
  const maxDepthValue = readFlag(pi, MAX_DEPTH_FLAG);
  const hideAgentListValue = readFlag(pi, HIDE_AGENT_LIST_FLAG);
  return {
    maxDepth: parseMaxDepth(maxDepthValue),
    hideAgentList: parseHideAgentList(hideAgentListValue),
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

function parseHideAgentList(value: unknown): boolean {
  if (value === undefined || typeof value === "boolean") return value ?? false;
  throw new Error(
    `${HIDE_AGENT_LIST_FLAG} (hide agent list) must be a boolean`,
  );
}

export function isAgentListHidden(pi: ExtensionAPI): boolean {
  return readExtensionSettings(pi).hideAgentList;
}

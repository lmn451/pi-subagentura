import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getSetting,
  type SettingDefinition,
  type SettingStorageOptions,
} from "@juanibiapina/pi-extension-settings";

export const MAX_DEPTH_FLAG = "subagentura-max-depth";
export const HIDE_AGENT_LIST_FLAG = "subagentura-hide-agent-list";
export const DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH = 2;
const MAX_CONFIGURED_DEPTH = 64;
const SETTINGS_EXTENSION_NAME = "pi-subagentura";
const MAX_DEPTH_SETTING = "max-depth";
const HIDE_AGENT_LIST_SETTING = "hide-agent-list";
const MAX_DEPTH_DEFINITION = {
  id: MAX_DEPTH_SETTING,
  label: "Maximum depth",
  description: `Maximum Orchestratorv2 lineage depth (0-${MAX_CONFIGURED_DEPTH})`,
  defaultValue: String(DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH),
} satisfies SettingDefinition;
const HIDE_AGENT_LIST_DEFINITION = {
  id: HIDE_AGENT_LIST_SETTING,
  label: "Hide agent list",
  description: "Hide compact per-agent activity widget rows",
  defaultValue: "false",
  values: ["false", "true"],
} satisfies SettingDefinition;

export interface ExtensionSettings {
  maxDepth: number;
  hideAgentList: boolean;
}

export function registerExtensionSettings(pi: ExtensionAPI): void {
  pi.registerFlag(MAX_DEPTH_FLAG, {
    description:
      "Maximum Orchestratorv2 lineage depth (default: 2; legacy stays at 8)",
    type: "string",
  });
  pi.registerFlag(HIDE_AGENT_LIST_FLAG, {
    description: "Hide compact per-agent activity widget rows",
    type: "boolean",
    default: false,
  });
  emitExtensionSettingsRegistration(pi);
}

export function emitExtensionSettingsRegistration(pi: ExtensionAPI): void {
  const events = (pi as Partial<ExtensionAPI>).events;
  if (events && typeof events.emit === "function") {
    events.emit("pi-extension-settings:register", {
      name: SETTINGS_EXTENSION_NAME,
      settings: [MAX_DEPTH_DEFINITION, HIDE_AGENT_LIST_DEFINITION],
    });
  }
}

export function readExtensionSettings(
  pi: ExtensionAPI,
  storageOptions: SettingStorageOptions = {},
): ExtensionSettings {
  const maxDepthValue = readFlag(pi, MAX_DEPTH_FLAG);
  const hideAgentListValue = readFlag(pi, HIDE_AGENT_LIST_FLAG);
  const persistedMaxDepthValue = getSetting(
    SETTINGS_EXTENSION_NAME,
    MAX_DEPTH_SETTING,
    MAX_DEPTH_DEFINITION.defaultValue,
    storageOptions,
  );
  return {
    maxDepth: parseMaxDepth(
      maxDepthValue === undefined || maxDepthValue === false
        ? persistedMaxDepthValue
        : maxDepthValue,
    ),
    hideAgentList:
      parseHideAgentList(hideAgentListValue) ||
      parsePersistedHideAgentList(
        getSetting(
          SETTINGS_EXTENSION_NAME,
          HIDE_AGENT_LIST_SETTING,
          HIDE_AGENT_LIST_DEFINITION.defaultValue,
          storageOptions,
        ),
      ),
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

function parsePersistedHideAgentList(value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === "false" || value === undefined) return false;
  throw new Error(
    `${HIDE_AGENT_LIST_SETTING} setting must be either "true" or "false"`,
  );
}

export function isAgentListHidden(pi: ExtensionAPI): boolean {
  return readExtensionSettings(pi).hideAgentList;
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getSetting,
  type SettingDefinition,
  type SettingStorageOptions,
} from "@juanibiapina/pi-extension-settings";
import { debugLog } from "./helpers";

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
  description:
    "Hide compact per-agent activity widget rows (global only; ignored by /extension-settings-local)",
  defaultValue: "false",
  values: ["false", "true"],
} satisfies SettingDefinition;

export interface ExtensionSettings {
  maxDepth: number;
  hideAgentList: boolean;
}

/** Reports a persisted value that was ignored, so the TUI can surface it. */
export type InvalidSettingReporter = (message: string) => void;

export function registerExtensionSettings(pi: ExtensionAPI): void {
  pi.registerFlag(MAX_DEPTH_FLAG, {
    description: `Override the persisted Orchestratorv2 max-depth setting for this run (0-${MAX_CONFIGURED_DEPTH}); legacy orchestration stays at 8`,
    type: "string",
  });
  pi.registerFlag(HIDE_AGENT_LIST_FLAG, {
    description:
      "Force-hide the compact per-agent activity widget rows for this run; it can only turn hiding on, so it cannot override a persisted hide-agent-list of true",
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

/**
 * Resolve the effective settings. CLI flags are still validated strictly —
 * a bad flag is an operator typo worth failing on — but persisted values are
 * parsed defensively: a hand-edited or panel-written file must never abort
 * session start, so an invalid value degrades to the documented default and is
 * reported through `onInvalidSetting`.
 */
export function readExtensionSettings(
  pi: ExtensionAPI,
  storageOptions: SettingStorageOptions = {},
  onInvalidSetting?: InvalidSettingReporter,
): ExtensionSettings {
  const maxDepthValue = readFlag(pi, MAX_DEPTH_FLAG);
  const hideAgentListValue = readFlag(pi, HIDE_AGENT_LIST_FLAG);
  // Parsed unconditionally so persisted validation never depends on whether a
  // flag happened to short-circuit the check.
  const persistedHideAgentList = readPersistedHideAgentList(
    storageOptions,
    onInvalidSetting,
  );
  return {
    maxDepth:
      maxDepthValue === undefined || maxDepthValue === false
        ? readPersistedMaxDepth(storageOptions, onInvalidSetting)
        : parseMaxDepth(maxDepthValue),
    hideAgentList:
      parseHideAgentList(hideAgentListValue) || persistedHideAgentList,
  };
}

function readFlag(pi: ExtensionAPI, name: string): unknown {
  const getFlag = (pi as Partial<ExtensionAPI>).getFlag;
  if (typeof getFlag !== "function") return undefined;
  return getFlag.call(pi, name);
}

/**
 * Without an authoritative session cwd, local lookups would silently resolve
 * against the Node process cwd — an unrelated directory for a resumed session.
 * Degrade explicitly to the global file instead.
 */
function resolveStorageOptions(
  options: SettingStorageOptions,
): SettingStorageOptions {
  if (options.scope !== undefined || options.cwd !== undefined) return options;
  return { ...options, scope: "global" };
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

function readPersistedMaxDepth(
  storageOptions: SettingStorageOptions,
  onInvalidSetting?: InvalidSettingReporter,
): number {
  let raw: unknown = undefined;
  try {
    raw = getSetting(
      SETTINGS_EXTENSION_NAME,
      MAX_DEPTH_SETTING,
      MAX_DEPTH_DEFINITION.defaultValue,
      resolveStorageOptions(storageOptions),
    );
    return parseMaxDepth(raw);
  } catch {
    reportInvalidPersistedSetting(
      MAX_DEPTH_SETTING,
      raw,
      `must be an integer between 0 and ${MAX_CONFIGURED_DEPTH}; using ${DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH}`,
      onInvalidSetting,
    );
    return DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH;
  }
}

/**
 * Read only `hide-agent-list`, from the global file. A checked-in project
 * `.pi/settings-extensions.json` must not be able to hide agent activity from
 * whoever opens the repo, so the local scope is deliberately ignored here.
 */
function readPersistedHideAgentList(
  storageOptions: SettingStorageOptions,
  onInvalidSetting?: InvalidSettingReporter,
): boolean {
  let raw: unknown = undefined;
  try {
    raw = getSetting(
      SETTINGS_EXTENSION_NAME,
      HIDE_AGENT_LIST_SETTING,
      HIDE_AGENT_LIST_DEFINITION.defaultValue,
      { ...storageOptions, scope: "global" },
    );
  } catch {
    reportInvalidPersistedSetting(
      HIDE_AGENT_LIST_SETTING,
      raw,
      'must be either "true" or "false"; using "false"',
      onInvalidSetting,
    );
    return false;
  }
  if (raw === "true") return true;
  if (raw === "false" || raw === undefined) return false;
  reportInvalidPersistedSetting(
    HIDE_AGENT_LIST_SETTING,
    raw,
    'must be either "true" or "false"; using "false"',
    onInvalidSetting,
  );
  return false;
}

function reportInvalidPersistedSetting(
  setting: string,
  value: unknown,
  detail: string,
  onInvalidSetting?: InvalidSettingReporter,
): void {
  debugLog("warn", "extension_setting_invalid", { setting, value });
  onInvalidSetting?.(
    `Ignoring invalid ${SETTINGS_EXTENSION_NAME} ${setting} setting ${JSON.stringify(value)}: it ${detail}.`,
  );
}

/**
 * Narrow, non-throwing read used by the 5s poll tick: a malformed persisted
 * value must never escape into the poller, where it would freeze the footer
 * and widgets for the rest of the session.
 */
export function isAgentListHidden(
  pi: ExtensionAPI,
  storageOptions: SettingStorageOptions = {},
): boolean {
  try {
    if (parseHideAgentList(readFlag(pi, HIDE_AGENT_LIST_FLAG))) return true;
  } catch (error) {
    debugLog("warn", "extension_setting_flag_invalid", {
      setting: HIDE_AGENT_LIST_FLAG,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return readPersistedHideAgentList(storageOptions);
  } catch (error) {
    debugLog("warn", "extension_setting_read_failed", {
      setting: HIDE_AGENT_LIST_SETTING,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

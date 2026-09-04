import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  getSetting,
  type SettingDefinition,
  type SettingStorageOptions,
} from "@juanibiapina/pi-extension-settings";
import { debugLog } from "./helpers";

export const MAX_DEPTH_FLAG = "subagentura-max-depth";
export const HIDE_AGENT_LIST_FLAG = "subagentura-hide-agent-list";
export const TELEMETRY_FLAG = "subagentura-telemetry";
export const TELEMETRY_OPT_OUT_FLAG = "no-subagentura-telemetry";
export const TELEMETRY_ENV = "PI_SUBAGENTURA_TELEMETRY";
export const DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH = 2;
const MAX_CONFIGURED_DEPTH = 64;
const SETTINGS_EXTENSION_NAME = "pi-subagentura";
const SETTINGS_FILE_NAME = "settings-extensions.json";
const MAX_DEPTH_SETTING = "max-depth";
const HIDE_AGENT_LIST_SETTING = "hide-agent-list";
const TELEMETRY_SETTING = "telemetry";
const REDACTED_TELEMETRY_VALUE = "<redacted invalid telemetry value>";
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
const TELEMETRY_DEFINITION = {
  id: TELEMETRY_SETTING,
  label: "Telemetry",
  description:
    "Send anonymous session-level product analytics (project-local value overrides global value)",
  defaultValue: "true",
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
  pi.registerFlag(TELEMETRY_FLAG, {
    description: "Send anonymous session-level product analytics",
    type: "boolean",
    default: true,
  });
  pi.registerFlag(TELEMETRY_OPT_OUT_FLAG, {
    description: "Disable anonymous session-level product analytics",
    type: "boolean",
  });
}

export function emitExtensionSettingsRegistration(pi: ExtensionAPI): void {
  const events = (pi as Partial<ExtensionAPI>).events;
  if (events && typeof events.emit === "function") {
    events.emit("pi-extension-settings:register", {
      name: SETTINGS_EXTENSION_NAME,
      settings: [
        MAX_DEPTH_DEFINITION,
        HIDE_AGENT_LIST_DEFINITION,
        TELEMETRY_DEFINITION,
      ],
    });
  }
}

/**
 * Resolve the effective settings. CLI flags are still validated strictly —
 * a bad flag is an operator typo worth failing on — but persisted values are
 * parsed defensively: a hand-edited or panel-written file must never abort
 * session start, so an invalid candidate is ignored and resolution continues
 * through the remaining scopes before using the documented default.
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
  if (options.cwd !== undefined || options.scope === "global") return options;
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
  for (const path of settingsFilePaths(resolveStorageOptions(storageOptions))) {
    const raw = readSettingsFile(path, MAX_DEPTH_SETTING, onInvalidSetting)?.[
      MAX_DEPTH_SETTING
    ];
    if (raw === undefined) continue;
    try {
      // The CLI accepts false as "unset"; persisted values must be strings.
      if (typeof raw !== "string") throw new Error("Invalid max-depth type");
      return parseMaxDepth(raw);
    } catch {
      reportInvalidPersistedSetting(
        MAX_DEPTH_SETTING,
        "<redacted invalid max-depth value>",
        `must be an integer between 0 and ${MAX_CONFIGURED_DEPTH}; ignoring this candidate`,
        onInvalidSetting,
      );
    }
  }
  return DEFAULT_ORCHESTRATOR_V2_MAX_DEPTH;
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

/**
 * Read `telemetry` project-local first, with the global file as fallback when an
 * authoritative cwd is available. Without one, only the global file is read.
 */
function readPersistedTelemetry(
  storageOptions: SettingStorageOptions,
  onInvalidSetting?: InvalidSettingReporter,
): boolean {
  const resolvedStorageOptions = resolveStorageOptions(storageOptions);
  const validations = validateSettingsFiles(
    resolvedStorageOptions,
    onInvalidSetting,
  );

  if (
    resolvedStorageOptions.scope === "global" ||
    resolvedStorageOptions.cwd === undefined
  ) {
    return (
      readTelemetryCandidate(
        resolvedStorageOptions,
        validations[0],
        onInvalidSetting,
      ) ?? true
    );
  }

  const localValidation = validations[0];
  const globalValidation = validations[1];
  if (!localValidation || !globalValidation) return true;

  // With two structurally valid files and no invalid candidate, let the
  // settings helper apply its normal local-over-global precedence.
  if (
    isUsableTelemetryFile(localValidation) &&
    isUsableTelemetryFile(globalValidation)
  ) {
    const raw = readTelemetrySetting(resolvedStorageOptions);
    return parseTelemetryValue(raw, onInvalidSetting) ?? true;
  }

  // A malformed or invalid local candidate is ignored so the global candidate
  // can still win. Conversely, a malformed global file must not erase a valid
  // local choice.
  const localValue = readTelemetryCandidate(
    { ...resolvedStorageOptions, scope: "local" },
    localValidation,
    onInvalidSetting,
  );
  if (localValue !== undefined) return localValue;
  return (
    readTelemetryCandidate(
      { ...resolvedStorageOptions, scope: "global" },
      globalValidation,
      onInvalidSetting,
    ) ?? true
  );
}

interface SettingsFileValidation {
  valid: boolean;
  telemetry: "missing" | "valid" | "invalid";
}

function isUsableTelemetryFile(validation: SettingsFileValidation): boolean {
  return validation.valid && validation.telemetry !== "invalid";
}

function readTelemetryCandidate(
  storageOptions: SettingStorageOptions,
  validation: SettingsFileValidation | undefined,
  onInvalidSetting?: InvalidSettingReporter,
): boolean | undefined {
  if (!validation || !isUsableTelemetryFile(validation)) return undefined;
  return parseTelemetryValue(
    readTelemetrySetting(storageOptions),
    onInvalidSetting,
  );
}

function readTelemetrySetting(storageOptions: SettingStorageOptions): unknown {
  try {
    return getSetting(
      SETTINGS_EXTENSION_NAME,
      TELEMETRY_SETTING,
      undefined,
      storageOptions,
    );
  } catch {
    // Structural failures are reported by validateSettingsFiles. Treat a
    // concurrent file replacement as an absent candidate rather than aborting.
    return undefined;
  }
}

function parseTelemetryValue(
  raw: unknown,
  onInvalidSetting?: InvalidSettingReporter,
): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  reportInvalidPersistedSetting(
    TELEMETRY_SETTING,
    REDACTED_TELEMETRY_VALUE,
    'must be either "true" or "false"; ignoring this candidate',
    onInvalidSetting,
  );
  return undefined;
}

function settingsFilePaths(storageOptions: SettingStorageOptions): string[] {
  const globalPath = join(
    storageOptions.agentDir ?? getAgentDir(),
    SETTINGS_FILE_NAME,
  );
  if (storageOptions.scope === "global" || storageOptions.cwd === undefined) {
    return [globalPath];
  }
  return [join(storageOptions.cwd, ".pi", SETTINGS_FILE_NAME), globalPath];
}

/**
 * The settings helper treats unreadable and syntactically invalid files as
 * empty. Preflight every file in the resolver's scope order so those failures
 * remain visible without exposing file contents.
 */
function validateSettingsFiles(
  storageOptions: SettingStorageOptions,
  onInvalidSetting?: InvalidSettingReporter,
): SettingsFileValidation[] {
  return settingsFilePaths(storageOptions).map((path) =>
    validateSettingsFile(path, onInvalidSetting),
  );
}

function readSettingsFile(
  path: string,
  setting: string,
  onInvalidSetting?: InvalidSettingReporter,
): Record<string, unknown> | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    reportInvalidPersistedSetting(
      setting,
      undefined,
      "could not be read; ignoring this candidate",
      onInvalidSetting,
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    reportInvalidPersistedSetting(
      setting,
      "<invalid JSON document>",
      "must be valid JSON; ignoring this candidate",
      onInvalidSetting,
    );
    return undefined;
  }

  const invalidRoot =
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed);
  const extensionSettings = invalidRoot
    ? undefined
    : (parsed as Record<string, unknown>)[SETTINGS_EXTENSION_NAME];
  if (
    invalidRoot ||
    (extensionSettings !== undefined &&
      (typeof extensionSettings !== "object" ||
        extensionSettings === null ||
        Array.isArray(extensionSettings)))
  ) {
    reportInvalidPersistedSetting(
      setting,
      "<invalid settings document shape>",
      "must be stored in an object-shaped settings document; ignoring this candidate",
      onInvalidSetting,
    );
    return undefined;
  }

  return (extensionSettings as Record<string, unknown> | undefined) ?? {};
}

function validateSettingsFile(
  path: string,
  onInvalidSetting?: InvalidSettingReporter,
): SettingsFileValidation {
  const settings = readSettingsFile(path, TELEMETRY_SETTING, onInvalidSetting);
  if (!settings) return { valid: false, telemetry: "missing" };
  const telemetryValue = settings[TELEMETRY_SETTING];
  if (telemetryValue === undefined) {
    return { valid: true, telemetry: "missing" };
  }
  if (telemetryValue === "true" || telemetryValue === "false") {
    return { valid: true, telemetry: "valid" };
  }
  reportInvalidPersistedSetting(
    TELEMETRY_SETTING,
    REDACTED_TELEMETRY_VALUE,
    'must be either "true" or "false"; ignoring this candidate',
    onInvalidSetting,
  );
  return { valid: true, telemetry: "invalid" };
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

/**
 * Reads as "false" for switches where a false answer costs nothing: the product
 * switch (`PI_SUBAGENTURA_TELEMETRY`, where false means "do not send") and the
 * environment probes (`CI`, `VITEST`, where false only means "not that
 * environment"). Being generous here makes the opt-out easier to hit and the
 * environment detection harder to trip by accident.
 */
const PERMISSIVE_FALSY_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * `DO_NOT_TRACK` and `PI_OFFLINE` have the opposite polarity: setting them IS
 * the opt-out, so a value this code fails to recognize must keep telemetry off,
 * not turn it on. Only the two unambiguous negations cancel them — reading
 * `DO_NOT_TRACK=off` as "do track" would silently convert a privacy request
 * into consent.
 */
const OPT_OUT_FALSY_VALUES = new Set(["0", "false"]);

/** Normalized switch value; unset and empty are both "no decision". */
function envSwitchValue(name: string): string | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  return value === undefined || value === "" ? undefined : value;
}

/** True when the switch is set to anything outside its own falsy vocabulary. */
function envSwitchIsTruthy(name: string, falsy: ReadonlySet<string>): boolean {
  const value = envSwitchValue(name);
  return value !== undefined && !falsy.has(value);
}

export function isTelemetryEnabled(
  pi: ExtensionAPI,
  storageOptions: SettingStorageOptions = {},
  onInvalidSetting?: InvalidSettingReporter,
): boolean {
  const productSwitch = envSwitchValue(TELEMETRY_ENV);
  if (
    productSwitch !== undefined &&
    PERMISSIVE_FALSY_VALUES.has(productSwitch)
  ) {
    return false;
  }
  if (envSwitchIsTruthy("DO_NOT_TRACK", OPT_OUT_FALSY_VALUES)) return false;
  if (envSwitchIsTruthy("PI_OFFLINE", OPT_OUT_FALSY_VALUES)) return false;
  if (envSwitchIsTruthy("CI", PERMISSIVE_FALSY_VALUES)) return false;
  if (envSwitchIsTruthy("VITEST", PERMISSIVE_FALSY_VALUES)) return false;
  if (process.env.NODE_ENV === "test") return false;
  if (readFlag(pi, TELEMETRY_OPT_OUT_FLAG) === true) return false;
  const persistedTelemetryEnabled = readPersistedTelemetry(
    storageOptions,
    onInvalidSetting,
  );
  return persistedTelemetryEnabled && readFlag(pi, TELEMETRY_FLAG) !== false;
}

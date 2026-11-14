import { posix, win32 } from "node:path";
import type {
  TelemetryParentMux,
  TelemetrySessionHost,
  TelemetryTerminalProgram,
} from "./telemetry";

const MAX_ENV_FIELD_LENGTH = 4_096;

export interface EnvironmentSnapshot {
  readonly guidanceHost: "orca" | "agterm" | "rex" | "unknown";
  readonly telemetryHost: TelemetrySessionHost;
  readonly terminalProgram: TelemetryTerminalProgram;
  readonly parentMux: TelemetryParentMux;
}

function boundedField(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_ENV_FIELD_LENGTH
    ? trimmed
    : undefined;
}

function hasNativeMarker(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= MAX_ENV_FIELD_LENGTH &&
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export function sanitizeTelemetryTerminalProgram(
  value: unknown,
): TelemetryTerminalProgram {
  switch (value) {
    case "agterm":
    case "ghostty":
    case "vscode":
    case "wezterm":
    case "kitty":
      return value;
    case "WezTerm":
      return "wezterm";
    case "iTerm.app":
    case "iterm2":
      return "iterm2";
    case "Apple_Terminal":
    case "apple_terminal":
      return "apple_terminal";
    default:
      return "unknown";
  }
}

export function sanitizeTelemetryParentMux(value: unknown): TelemetryParentMux {
  return value === "tmux" ||
    value === "zellij" ||
    value === "herdr" ||
    value === "rex"
    ? value
    : "unknown";
}

/**
 * Captures bounded, closed environment observations only. These labels are not
 * evidence of live host or mux authority and never retain raw environment data.
 */
export function detectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EnvironmentSnapshot {
  const sourceId = boundedField(env.ORCA_RUNTIME_SOURCE_ID);
  const incarnation = boundedField(env.ORCA_RUNTIME_SOURCE_INCARNATION);
  const profile = boundedField(env.ORCA_RUNTIME_SOURCE_PROFILE_PATH);
  const pathApi = platform === "win32" ? win32 : posix;
  const hasOrcaOrigin = Boolean(
    sourceId && incarnation && profile && pathApi.isAbsolute(profile),
  );
  const hasAgtermMarker = env.AGTERM_ENABLED === "1";
  const hasRexLocationHints = Boolean(
    boundedField(env.REX_SESSION) && boundedField(env.REX_BLOCK),
  );

  const guidanceConflict =
    (hasOrcaOrigin && hasAgtermMarker) ||
    (hasOrcaOrigin && hasRexLocationHints) ||
    (hasAgtermMarker && hasRexLocationHints);
  const guidanceHost = guidanceConflict
    ? "unknown"
    : hasOrcaOrigin
      ? "orca"
      : hasAgtermMarker
        ? "agterm"
        : hasRexLocationHints
          ? "rex"
          : "unknown";
  const telemetryHost: TelemetrySessionHost =
    hasOrcaOrigin && hasAgtermMarker
      ? "unknown"
      : hasOrcaOrigin
        ? "orca"
        : hasAgtermMarker
          ? "agterm"
          : "unknown";

  const muxCandidates: TelemetryParentMux[] = [];
  if (hasNativeMarker(env.TMUX)) muxCandidates.push("tmux");
  if (hasNativeMarker(env.ZELLIJ_SESSION_NAME)) muxCandidates.push("zellij");
  if (env.HERDR_ENV === "1") muxCandidates.push("herdr");
  if (
    hasNativeMarker(env.REX_SESSION) &&
    hasNativeMarker(env.REX_BLOCK) &&
    hasNativeMarker(env.REX_SERVER)
  ) {
    muxCandidates.push("rex");
  }
  const parentMux = sanitizeTelemetryParentMux(
    muxCandidates.length === 1 ? muxCandidates[0] : "unknown",
  );

  return Object.freeze({
    guidanceHost,
    telemetryHost,
    terminalProgram: sanitizeTelemetryTerminalProgram(env.TERM_PROGRAM),
    parentMux,
  });
}

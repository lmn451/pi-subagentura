import { posix, win32 } from "node:path";
import type {
  TelemetryParentMux,
  TelemetrySessionHost,
  TelemetryTerminalProgram,
} from "./telemetry";

const MAX_ENV_FIELD_LENGTH = 4_096;

export type GuidanceHostStatus =
  | "eligible"
  | "ambiguous"
  | "unsupported"
  | "unknown";
export type ParentMuxObservationStatus =
  | "candidate"
  | "ambiguous"
  | "unsupported"
  | "unknown";

export interface EnvironmentSnapshot {
  readonly guidanceHost: "orca" | "agterm" | "rex" | "unknown";
  /** Prompt eligibility only; never proof of current host ownership. */
  readonly guidanceHostStatus: GuidanceHostStatus;
  readonly telemetryHost: TelemetrySessionHost;
  readonly terminalProgram: TelemetryTerminalProgram;
  readonly parentMux: TelemetryParentMux;
  /** Marker observation only; never a native backend selection. */
  readonly parentMuxStatus: ParentMuxObservationStatus;
  /** Permission to use the native launcher by default, not live mux proof. */
  readonly v2NativeDefaultPermitted: boolean;
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
    value === "rex" ||
    value === "wezterm"
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
  const hasOrcaHints =
    env.ORCA_RUNTIME_SOURCE_ID !== undefined ||
    env.ORCA_RUNTIME_SOURCE_INCARNATION !== undefined ||
    env.ORCA_RUNTIME_SOURCE_PROFILE_PATH !== undefined;
  const hasAgtermHint = env.AGTERM_ENABLED !== undefined;
  const hasRexHints =
    env.REX_SESSION !== undefined || env.REX_BLOCK !== undefined;
  const hostHintPresent = hasOrcaHints || hasAgtermHint || hasRexHints;
  // Orca can establish a host-managed default after verification. External
  // Agterm and Rex work is request-driven, but incomplete hints still block an
  // automatic default even if an unrelated host guide is eligible.
  const hostPermitsNativeDefault =
    !hasOrcaHints &&
    !guidanceConflict &&
    (!hasAgtermHint || hasAgtermMarker) &&
    (!hasRexHints || hasRexLocationHints);
  const guidanceHostStatus: GuidanceHostStatus = guidanceConflict
    ? "ambiguous"
    : guidanceHost !== "unknown"
      ? "eligible"
      : hostHintPresent
        ? "unsupported"
        : "unknown";
  const telemetryHost: TelemetrySessionHost =
    hasOrcaOrigin && hasAgtermMarker
      ? "unknown"
      : hasOrcaOrigin
        ? "orca"
        : hasAgtermMarker
          ? "agterm"
          : "unknown";

  const isRexTerminalHint =
    typeof env.TERM_PROGRAM === "string" &&
    env.TERM_PROGRAM.trim().toLowerCase() === "rex";
  const muxHintFamilies = [
    env.TMUX !== undefined || env.TMUX_PANE !== undefined,
    env.ZELLIJ !== undefined ||
      env.ZELLIJ_SESSION_NAME !== undefined ||
      env.ZELLIJ_PANE_ID !== undefined,
    env.HERDR_ENV !== undefined ||
      env.HERDR_PANE_ID !== undefined ||
      env.HERDR_SOCKET_PATH !== undefined,
    env.WEZTERM_PANE !== undefined || env.WEZTERM_UNIX_SOCKET !== undefined,
    env.REX_SESSION !== undefined ||
      env.REX_BLOCK !== undefined ||
      env.REX_SERVER !== undefined ||
      isRexTerminalHint,
  ].filter(Boolean).length;
  const muxCandidates: TelemetryParentMux[] = [];
  if (hasNativeMarker(env.TMUX)) muxCandidates.push("tmux");
  if (hasNativeMarker(env.ZELLIJ_SESSION_NAME)) muxCandidates.push("zellij");
  if (env.HERDR_ENV === "1") muxCandidates.push("herdr");
  if (
    hasNativeMarker(env.WEZTERM_PANE) &&
    hasNativeMarker(env.WEZTERM_UNIX_SOCKET)
  )
    muxCandidates.push("wezterm");
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
  const parentMuxStatus: ParentMuxObservationStatus =
    muxHintFamilies > 1 || muxCandidates.length > 1
      ? "ambiguous"
      : muxHintFamilies === 1
        ? muxCandidates.length === 1
          ? "candidate"
          : "unsupported"
        : "unknown";

  return Object.freeze({
    guidanceHost,
    guidanceHostStatus,
    telemetryHost,
    terminalProgram: sanitizeTelemetryTerminalProgram(env.TERM_PROGRAM),
    parentMux,
    parentMuxStatus,
    v2NativeDefaultPermitted:
      hostPermitsNativeDefault &&
      (parentMuxStatus === "unknown" || parentMuxStatus === "candidate"),
  });
}

export function formatV2ExecutionContextGuidance(
  environment: EnvironmentSnapshot,
): string {
  const hostStatus =
    environment.guidanceHostStatus === "eligible"
      ? `eligible (${environment.guidanceHost})`
      : environment.guidanceHostStatus;
  const muxStatus =
    environment.parentMuxStatus === "candidate"
      ? `candidate (${environment.parentMux})`
      : environment.parentMuxStatus;
  const defaultGuidance = environment.v2NativeDefaultPermitted
    ? [
        "- No-target execution surface: native launcher permitted.",
        "- For an otherwise authorized request with no explicit target, use the native guidance and launcher. This permits launch-time resolution and verification; it does not select a mux. If verification or launch fails, report the blocker rather than switching to another target.",
      ]
    : [
        "- No-target execution surface: no automatic default from this snapshot.",
        "- Follow the applicable host guidance under its opt-in and verification rules. If no guidance establishes an authorized surface, report the blocker and ask. Do not fall back automatically.",
      ];

  return [
    "## Runtime execution context and no-target policy",
    "",
    `- Host-guide eligibility: ${hostStatus}.`,
    `- Native mux observation: ${muxStatus}.`,
    "- This snapshot performs no live checks. Unknown means no recognized marker was observed in that category; it does not prove that a host or backend is absent. A marker candidate may be incomplete, stale, or unverified.",
    "- These observations do not prove current host or mux ownership, user intent, target identity, or permission. Ambiguous evidence does not select an adapter.",
    ...defaultGuidance,
    "- The native interactive tool is registered, but this snapshot does not prove backend availability or launch success. Its runtime resolver owns mux selection and validation. An explicit user-selected target takes precedence, and an explicit native mux preference is passed through to the resolver. Do not silently switch surfaces or backends; report unsupported or unverified requests instead of falling back to a different target.",
    "- Host-guide eligibility describes the current session, not an alternate destination. If you have no applicable guide or means to verify the requested target, report the gap before selecting a different surface.",
  ].join("\n");
}

/**
 * Interactive sub-agent orchestrator (tmux/zellij).
 *
 * PR #1 refactor: this file used to do all tmux exec calls inline. Those
 * moved to `multiplexer-tmux.ts` behind the `Multiplexer` interface in
 * `multiplexer.ts`. This file is now the thin orchestrator:
 *
 *   - defines the lifecycle state (`InteractiveSubagentState`) and registry
 *   - builds the launch script and the per-child paths
 *   - picks a `Multiplexer` via `getMux()` and stores its name on the state
 *   - dispatches the helper operations (is-alive, send-keys, kill) to the
 *     right backend
 *   - derives status and formats the user-facing summary
 *
 * No tmux-specific `execFileSync("tmux", ...)` calls remain in this file —
 * the new home for them is `multiplexer-tmux.ts`. The PR also relaxes the
 * spawn check: a child can be created even when the parent is not in a
 * tmux/zellij session (a new detached session is created on the fly; the
 * user attaches via the returned `attachCommand`).
 *
 * The exports kept here are the public surface consumed by `subagent.ts`
 * and the test suite. Their signatures are preserved verbatim so the rest
 * of the codebase compiles unchanged.
 */

import {
  findSessionScope,
  sessionOwner,
  resolveLiveSessionScope,
  sessionIdForOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CLI_SOURCE } from "./subagent-artifact-cli";
import {
  appendInteractiveState,
  appendCompletionEvent,
  artifactPath,
  INTERACTIVE_ARTIFACT_OWNER_FILE,
  assertNever,
  newEventId,
  type SubagentEvent,
  type PersistedDeliveryIntent,
  type PersistedLifecycleFold,
  removeInteractiveState,
  updateInteractiveState,
} from "./artifact";
import { acknowledgeDeliveryWithoutDispatch, deliveryIdFor } from "./delivery";
import {
  type CapturePaneOptions,
  type CapturePaneResult,
  getMux,
  NoMultiplexerAvailableError,
  type MuxName,
  type Multiplexer,
  type PaneRef,
  safeSegment,
} from "./multiplexer";
import {
  snapshotInteractiveContext,
  type CancellationSnapshotReceipt,
  type CancellationSnapshotSource,
} from "./cancellation-snapshots";
import {
  countLineageManifestsSync,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  hashLineageRoot,
  LINEAGE_SCHEMA_VERSION,
  type LineageManifest,
  pruneTerminalLineageNodesSync,
  resolveLineageStorePathsSync,
  writeLineageManifestAtomicSync,
} from "./interactive-lineage";
import {
  advanceInteractiveStateActor,
  createInteractiveStateActor,
  type InteractiveStateActor,
} from "./interactive-state-xstate";
import {
  initialInteractiveMachineState,
  projectInteractiveStatus,
  transitionInteractiveMachine,
  type InteractiveMachineEvent,
  type InteractiveMachineState,
  type InteractiveMachineTransition,
  type InteractiveProjectedStatus,
  type PaneLiveness,
} from "./interactive-state";

// Re-export the tmux-specific `readPaneExitCode` for the test suite. The
// launch script's EXIT trap still writes the @pi-exit-code pane option
// (it's a no-op on non-tmux systems thanks to `2>/dev/null || true`); this
// helper is the only place that reads it back. The artifact's `done`
// event is the source of truth in production.
import { TmuxMultiplexer } from "./multiplexer-tmux";
export { readPaneExitCode } from "./multiplexer-tmux";

/**
 * System prompt sent to every interactive sub-agent. Tells the child how to
 * signal completion so the parent can be notified, and where to write its
 * result. The persona (if provided) is placed ABOVE this so the protocol —
 * the part that keeps the parent-child notification loop working — is the
 * most recent instruction the LLM reads (recency wins for instruction
 * following).
 *
 * `artifactDir` is the resolved absolute path baked into the prompt so the
 * child can use it directly in `write` tool calls. Bash commands and `cli.mjs`
 * calls still work via the exported `ARTIFACT_DIR` env var from the launch
 * script, but the `write` tool treats its `path` argument as a literal string,
 * so we must give it the absolute path up front.
 */
export function buildChildSubagentProtocol(artifactDir: string): string {
  const cliPath = `${artifactDir}/cli.mjs`;
  const outputPath = `${artifactDir}/output.md`;
  return `You are running inside a Pi sub-agent launched by a parent agent. The parent agent reads your work from two files in your artifact directory and from one CLI command. You MUST follow this protocol or your work will be lost.

BE BRIEF. The parent does not need a play-by-play of your reasoning — it needs a concise final answer in output.md and a one-sentence summary after the lifecycle command succeeds. Skip the recap, the apology, and the "let me know if..." closer. Long preambles waste tokens and delay the done signal.

COMPLETION IS MANDATORY FOR EVERY TURN. A turn is not complete when output.md is written or when you have drafted a final response; it is complete only after cli.mjs returns successfully. This applies to the initial turn and every turn created by a follow-up message. Do not produce or send your final assistant response before invoking cli.mjs, because ending the response first can prevent the lifecycle command from running and leave the parent waiting forever.

Your artifact directory is: ${artifactDir}

  output.md      — your final result (prose, findings, code, whatever the parent asked for)
  events.ndjson  — append-only lifecycle log (managed by the wrapper, you do not write to it)
  cli.mjs        — the wrapper's lifecycle helper, invoked via bash

Use the literal path above in your \`write\` tool calls — the \`write\` tool does not expand \$ARTIFACT_DIR or any other shell variable, so a path like "\$ARTIFACT_DIR/output.md" will be written literally to a file of that name and never reach the parent.

When your task is done, follow this checklist in order. The parent is a parent agent and cannot guess that you have finished — it will only know after step 3 succeeds. Skipping or reordering any step breaks the completion contract.

  1. Finish all task work. Once you start this checklist, do not begin new work.
  2. Write your final result to ${outputPath} using the \`write\` tool. Use the exact path above. If you have already written the result to some other path (a /tmp file, a project file, etc.), copy or append it to output.md so the parent can read it.
  3. Run the appropriate bash command and wait for it to return. A successful invocation must record exactly one completion event for this turn. \$ARTIFACT_DIR is exported to your shell by the wrapper, so the quoted forms expand correctly even if the path contains spaces:

       "$ARTIFACT_DIR/cli.mjs" done 0       # success
       "$ARTIFACT_DIR/cli.mjs" error "short reason"   # unrecoverable failure

     This must be your final tool call for the turn. If the command itself fails, do not send the final assistant response; fix the cause and retry until one completion event has been recorded successfully.

  4. Only after the lifecycle command succeeds, produce your final assistant text in the chat summarising what you did and where to find the work. Make no more tool calls during this turn.
  5. Stay in the REPL. Do not call \`/exit\` or press Ctrl-D. The REPL stays open after step 3 so the user (or the parent) can follow up; the wrapper's EXIT trap will only fire if you actually exit. If you exit, the wrapper will treat it as a crash and the parent will not see your final answer.

Do not call 'cancelled' yourself — the parent agent writes that event only when it explicitly aborts you via the cancel_interactive_subagent tool.

For reference: ${cliPath} is the lifecycle CLI. Each invocation appends one NDJSON line to events.ndjson. The parent reads that file every few seconds. The atomic write pattern (write to .tmp, then rename onto output.md) is fine if you want crash-safety.

─── HARDENING REMINDER (read this last, it is the most recent instruction on purpose) ───
The child-only Pi lifecycle hook is a crash-safety fallback, not permission to omit the command. At the end of EVERY initial or follow-up turn: write output.md FIRST, call \`cli.mjs done 0\`, wait until exactly one completion event is recorded successfully, and only then send the final assistant response. The CLI is idempotent for the active turn, so the later agent_settled hook is a no-op. Never rely on the hook when you can call the CLI yourself.`;
}

/**
 * Sub-agent status for the interactive registry.
 *
 * - "running"  — child is processing a turn (last artifact event is "started" or absent)
 * - "idle"     — child finished a turn, REPL is open, pane alive; ready for a follow-up prompt
 * - "cancelled" — parent called cancel_interactive_subagent; terminal, no follow-up allowed
 * - "exited"   — child pi process is actually gone (pane dead, or it called `error`); terminal
 * - "unknown"  — can't determine (rare; pane dead but no recorded event)
 */
export type InteractiveSubagentStatus = InteractiveProjectedStatus;

export interface InteractiveSubagentState {
  id: string;
  name: string;
  task: string;
  paneId: string;
  /** tmux window name / zellij tab name (set when spawned in background mode via new-window -n / new-tab). */
  windowName?: string;
  /**
   * Which backend was used to spawn this sub-agent. Set once at spawn time
   * and never changes — all later operations on the child (is-alive,
   * send-keys, kill, attach) route through this backend. Pre-PR-2 this is
   * always "tmux".
   */
  mux: MuxName;
  /**
   * The mux session the pane lives in, as returned by `createPane`. Needed to
   * address the pane in later ops on backends whose pane ids are scoped to a
   * session (zellij targets every action with `--session <name>`). Undefined
   * for tmux (pane ids are server-global). Set once at spawn time; never
   * changes — like `paneId`/`windowName`, it must be persisted on the state
   * rather than held on the shared backend instance, which the resolver
   * reuses across spawns.
   */
  muxSession?: string;
  sessionFile: string;
  cwd: string;
  /**
   * Parent pi session id. Used as the per-session key for the on-disk state file
   * (see src/artifact.ts: stateFilePath). Required for terminal-event cleanup to
   * remove the entry from the file; rehydrate rebuilds it from the file on
   * session_start. Optional for tests that don't care about reload semantics.
   */
  parentSessionId?: string;
  /** Live supervisor owner; intentionally not persisted for workflow children. */
  supervisorOwner?: SessionOwnerToken;
  /** Exact runtime session generation that owns this state; never persisted. */
  sessionOwner?: SessionOwnerToken;
  /** Workflow that owns this child, when completion is aggregated by the workflow. */
  workflowId?: string;
  /** Completion is delivered standalone or consumed by a workflow aggregate. */
  completionOwner?: "standalone" | "workflow";
  /** Workflow-runner acknowledgement that this child's result was consumed; runtime-only and intentionally not persisted. */
  workflowResultConsumed?: boolean;
  model?: string;
  startedAt: number;
  /**
   * Compatibility projection of the machine kernel. Spawn begins running;
   * durable completion events become idle while the pane is alive, parent
   * cancellation becomes cancelled, and confirmed process exit becomes exited.
   * Follow-up turn records clear only turn-completion state.
   */
  status: InteractiveSubagentStatus;
  /** Receipt for the latest parent cancellation snapshot. */
  cancellationSnapshot?: CancellationSnapshotReceipt;
  /** Captured child pi exit code (0 = success). Undefined while still running. */
  exitCode?: number;
  attachCommand: string;
  selectPaneCommand: string;
  launchScriptFile: string;
  /** Absolute path to the artifact directory (events.ndjson + output.md). */
  artifactDir: string;
  /** Physical byte offset consumed from events.ndjson. */
  eventByteCursor?: number;
  /** Current child Pi turn identity, persisted across reloads. */
  activeTurnId?: string;
  /** Durable completion queue and reconciled custom-message receipts. */
  pendingDeliveries?: PersistedDeliveryIntent[];
  deliveryReceipts?: string[];
  lifecycle?: PersistedLifecycleFold;
  /** @deprecated Legacy v1 timestamp cursor retained for API compatibility. */
  lastDeliveredEventTs?: number;
  /** Byte offset through which session JSONL bytes were fed to the parser. */
  lastDeliveredSessionByte?: number;
  /** Start of the parser's current incomplete line, if one exists. */
  sessionPartialLineStart?: number;
  /** Persisted pre-reload cursor used once for truncation detection. */
  sessionObservedByteCursor?: number;
  /** Most recent tool_activity summary, for the TUI widget. */
  lastToolSummary?: string;
  lastToolName?: string;
  lastActivityAt?: number;
  /** @deprecated Legacy session metadata retained for API compatibility. */
  lastStopReason?: "stop" | "length" | "error" | "aborted";
  /** @deprecated Legacy session metadata retained for API compatibility. */
  lastStopReasonAt?: number;
  /** @deprecated Legacy protocol field retained for API compatibility. */
  autoDoneForTurnAt?: number;
  /** @deprecated Legacy session metadata retained for API compatibility. */
  lastStopText?: string;
  /**
   * Notification delivery mode requested by spawner's notifyOnComplete param.
   * "notify" emits status and artifact pointers. "inject" also includes bounded,
   * untrusted output in one attributed custom message.
   */
  notifyOnComplete?: "notify" | "inject";
  /**
   * When true, the attributed custom completion message triggers a parent turn.
   * The public subagent_interactive tool defaults this to true for both modes;
   * legacy states may retain an explicit false value.
   */
  triggerTurnOnComplete?: boolean;
  /** @deprecated Legacy v1 inject cursor retained for API compatibility. */
  lastInjectedEventTs?: number;
  /** @deprecated Legacy v1 snapshot cursor retained for API compatibility. */
  lastSnapshotEventTs?: number;
  /** @deprecated Legacy protocol field retained for API compatibility. */
  injected?: boolean;
}

declare global {
  var __piSubagenturaInteractiveRegistry:
    Map<string, InteractiveSubagentState> | undefined;
}

if (!globalThis.__piSubagenturaInteractiveRegistry) {
  globalThis.__piSubagenturaInteractiveRegistry = new Map<
    string,
    InteractiveSubagentState
  >();
}

export const interactiveSubagentRegistry =
  globalThis.__piSubagenturaInteractiveRegistry!;
/** Insert a state into its authoritative session map and the legacy aggregate index. */
export function registerInteractiveSubagentState(
  state: InteractiveSubagentState,
  scope?: SessionScope,
): void {
  if (scope) {
    state.sessionOwner = sessionOwner(scope);
    scope.interactiveStates.set(state.id, state);
  }
  interactiveSubagentRegistry.set(state.id, state);
}

/** Remove the same state object from every registry that currently indexes it. */
export function removeInteractiveSubagentState(
  state: InteractiveSubagentState,
): boolean {
  let removed = false;
  if (interactiveSubagentRegistry.get(state.id) === state) {
    removed = interactiveSubagentRegistry.delete(state.id);
  }
  const owner = state.sessionOwner;
  if (owner) {
    const scope = findSessionScope(owner.id);
    if (scope?.interactiveStates.get(state.id) === state) {
      scope.interactiveStates.delete(state.id);
      removed = true;
    }
  }
  return removed;
}

const interactiveStateActors = new WeakMap<
  InteractiveSubagentState,
  InteractiveStateActor
>();

function paneLivenessFromCompatibilityStatus(
  status: InteractiveSubagentStatus,
): PaneLiveness {
  switch (status) {
    case "running":
    case "idle":
      return { kind: "alive" };
    case "exited":
      return { kind: "dead" };
    case "cancelled":
    case "unknown":
      return { kind: "unknown" };
    default:
      return assertNever(status);
  }
}

function lifecycleForCompatibilityInitialization(
  state: InteractiveSubagentState,
): Readonly<PersistedLifecycleFold> {
  const lifecycle = state.lifecycle ?? {};
  const hasLifecycleDecision =
    lifecycle.currentTurnId !== undefined ||
    lifecycle.completionTurnId !== undefined ||
    lifecycle.completionOutcome !== undefined ||
    lifecycle.completionSource !== undefined ||
    lifecycle.completionExitCode !== undefined ||
    lifecycle.processStatus !== undefined ||
    lifecycle.processExitCode !== undefined ||
    lifecycle.parentCancelled !== undefined ||
    lifecycle.legacyTerminal !== undefined;
  if (hasLifecycleDecision) return lifecycle;

  // One-time migration for registry objects created before the machine kernel.
  // Once cached below, compatibility status is never consulted again.
  switch (state.status) {
    case "running":
    case "unknown":
      return lifecycle;
    case "idle":
      return { ...lifecycle, legacyTerminal: "done" };
    case "cancelled":
      return { ...lifecycle, parentCancelled: true };
    case "exited":
      return {
        ...lifecycle,
        processStatus: "error",
        ...(state.exitCode === undefined
          ? {}
          : { processExitCode: state.exitCode }),
      };
    default:
      return assertNever(state.status);
  }
}

export function initializeInteractiveStateMachine(
  state: InteractiveSubagentState,
  pane: PaneLiveness = paneLivenessFromCompatibilityStatus(state.status),
): InteractiveMachineState {
  const machine = initialInteractiveMachineState({
    lifecycle: lifecycleForCompatibilityInitialization(state),
    pane,
  });
  interactiveStateActors.set(state, createInteractiveStateActor(machine));
  state.lifecycle = { ...machine.lifecycle };
  state.status = projectInteractiveStatus(machine);
  return machine;
}

function getInteractiveStateActor(
  state: InteractiveSubagentState,
): InteractiveStateActor {
  const existing = interactiveStateActors.get(state);
  if (existing) return existing;
  initializeInteractiveStateMachine(state);
  const initialized = interactiveStateActors.get(state);
  if (!initialized) {
    throw new Error("interactive state actor initialization failed");
  }
  return initialized;
}

export function getInteractiveMachineState(
  state: InteractiveSubagentState,
): InteractiveMachineState {
  return getInteractiveStateActor(state).getSnapshot().context.state;
}

export function advanceInteractiveState(
  state: InteractiveSubagentState,
  event: InteractiveMachineEvent,
): InteractiveMachineTransition {
  const actor = getInteractiveStateActor(state);
  const transition = advanceInteractiveStateActor(actor, event, (candidate) => {
    if (
      event.type === "pane_observed" &&
      candidate.state.pane.kind === "dead" &&
      state.parentSessionId
    ) {
      updateInteractiveState(state.cwd, state.id, (entry) => {
        entry.paneDeathConfirmed = true;
      });
    }
  });
  switch (transition.kind) {
    case "applied": {
      state.lifecycle = { ...transition.state.lifecycle };
      state.status = projectInteractiveStatus(transition.state);
      const exitCode =
        transition.state.lifecycle.processExitCode ??
        transition.state.lifecycle.completionExitCode;
      if (state.status === "exited" && exitCode !== undefined) {
        state.exitCode = exitCode;
      }
      return transition;
    }
    case "unchanged":
    case "stale":
    case "invalid":
      return transition;
    default:
      return assertNever(transition);
  }
}

export function interactiveStatusForState(
  state: InteractiveSubagentState,
): InteractiveSubagentStatus {
  return projectInteractiveStatus(getInteractiveMachineState(state));
}

export function isInteractiveStateActive(
  state: InteractiveSubagentState,
): boolean {
  const status = interactiveStatusForState(state);
  switch (status) {
    case "running":
    case "idle":
      return true;
    case "unknown":
    case "cancelled":
    case "exited":
      return false;
    default:
      return assertNever(status);
  }
}

/**
 * True iff a tmux server is running and the parent is attached to one of its
 * sessions. Kept for backward compat with the existing `isTmuxAvailable`
 * name; PR #2's `isAnyMuxAvailable` will be the mux-agnostic version.
 */
export function isTmuxAvailable(): boolean {
  return new TmuxMultiplexer().isAvailable();
}

/** Setup hint shown to the user when no mux is available. Mux-agnostic. */
export function tmuxSetupHint(): string {
  return (
    "Start pi inside tmux or zellij, for example:\n" +
    "  tmux new -A -s pi 'pi'\n" +
    "  zellij --session pi  (or just start pi inside an existing zellij session)"
  );
}

function defaultSessionRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    : join(homedir(), ".pi", "agent", "sessions");
}

function sessionDirFor(cwd: string): string {
  const cwdLabel = `${safeSegment(basename(cwd))}-${randomBytes(3).toString("hex")}`;
  return join(defaultSessionRoot(), "subagentura", cwdLabel);
}

export function createInteractiveSubagentPaths(params: {
  id: string;
  name: string;
  cwd: string;
}): {
  sessionFile: string;
  artifactDir: string;
  promptFile: string;
  systemPromptFile: string;
  launchScriptFile: string;
} {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = safeSegment(params.name);
  const dir = sessionDirFor(params.cwd);
  const artifactDir = join(dir, "artifacts", params.id);
  return {
    sessionFile: join(dir, `${timestamp}-${params.id}.jsonl`),
    artifactDir,
    promptFile: join(artifactDir, `${label}-prompt.md`),
    systemPromptFile: join(artifactDir, `${label}-system.md`),
    launchScriptFile: join(artifactDir, `${label}-launch.sh`),
  };
}

export function buildInteractivePrompt(params: {
  task: string;
  contextText?: string | null;
}): string {
  const footer =
    "\n\n" +
    "MANDATORY COMPLETION PROTOCOL: before sending your final assistant response, " +
    "write your result to output.md (path from the system prompt), run the command below, " +
    "and wait for it to succeed. Repeat this for every turn:\n" +
    '  "$ARTIFACT_DIR/cli.mjs" done 0';

  if (!params.contextText) return params.task + footer;
  return (
    [
      "You are an interactive sub-agent running in your own Pi session.",
      "The parent session context is included below for reference.",
      "",
      "--- Parent session context ---",
      params.contextText,
      "--- End parent session context ---",
      "",
      "Task:",
      params.task,
    ].join("\n") + footer
  );
}

export function buildPiInteractiveCommand(params: {
  sessionFile: string;
  name: string;
  promptFile: string;
  systemPromptFile?: string;
  model?: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
}): string {
  const escape = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const parts = [
    "pi",
    "--session",
    escape(params.sessionFile),
    "--name",
    escape(params.name),
  ];
  if (params.model) {
    parts.push("--model", escape(params.model));
  }
  if (params.thinkingLevel) {
    parts.push("--thinking", escape(params.thinkingLevel));
  }
  if (params.systemPromptFile) {
    parts.push("--append-system-prompt", escape(params.systemPromptFile));
  }
  parts.push(escape(`@${params.promptFile}`));
  return `cd ${escape(params.cwd)} && ${parts.join(" ")}`;
}

export function writeLaunchScript(
  path: string,
  command: string,
  artifactDir: string,
  internalEnv: Record<string, string> = {},
): void {
  mkdirSync(dirname(path), { recursive: true });

  // 1. Write the inline `subagent-artifact` CLI helper into the artifact dir.
  //    The wrapper and child both invoke it for lifecycle events.

  const cliPath = join(artifactDir, "cli.mjs");
  writeFileSync(cliPath, CLI_SOURCE, { mode: 0o700 });

  // 2. Write the launch script. The script:
  //    - exports ARTIFACT_DIR so the child inherits it;
  //    - calls `cli.mjs start` to record the started event;
  //    - traps EXIT to record process exit and, when needed, one lock-protected completion;
  //    - also writes the @pi-exit-code pane option for the readPaneExitCode fallback
  //      (tmux-only; the `2>/dev/null || true` makes it a silent no-op on other muxes).
  const escape = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  // The grep pattern is single-quoted (so bash's quoting preserves the JSON quotes), but a
  // single-quoted string inside another single-quoted string (the trap body) terminates the outer one
  // at trap-set time with `syntax error near unexpected token '('`. Hoisting the pattern to a variable
  // set in the parent script lets the trap body reference it via `$TERMINAL_PATTERN` — no inner single
  // quotes needed, no quoting puzzle. Expanded at trap-fire time, not at script-load time.
  const script = [
    "#!/bin/bash",
    "set -e",
    `export ARTIFACT_DIR=${escape(artifactDir)}`,
    "export PI_SUBAGENTURA_CHILD=1",
    ...Object.entries(internalEnv).map(
      ([name, value]) => `export ${name}=${escape(value)}`,
    ),
    // Single-quote the helper path like every other interpolated path in this
    // script; a double-quoted path still expands $, `` and \ inside it.
    `${escape(cliPath)} start`,
    "on_exit() {",
    "    rc=$?",
    "    trap - EXIT",
    `    ${escape(cliPath)} process-exit "$rc" || true`,
    '    tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$rc" 2>/dev/null || true',
    '    exit "$rc"',
    "}",
    "trap on_exit EXIT",
    command,
    "",
  ].join("\n");
  // 0o700: only the owning user can read the script (which embeds absolute
  // paths to session/prompt/system files). 0o755 would leak the layout.
  writeFileSync(path, script, { mode: 0o700 });
}

export function launchInteractiveSubagent(params: {
  name: string;
  task: string;
  persona?: string;
  model?: string;
  cwd: string;
  contextText?: string | null;
  /** Spawn in a detached named window (invisible) instead of a visible split. */
  background?: boolean;
  /**
   * Notification delivery mode requested by the spawner. The public
   * `subagent_interactive` tool passes `"notify"` by default; explicit callers
   * choose `"inject"` when full output delivery is required.
   */
  notifyOnComplete?: "notify" | "inject";
  /** Whether notify-mode completion messages should trigger a parent LLM turn. */
  triggerTurnOnComplete?: boolean;
  /** Mux preference — passed to getMux(). "auto" (default) = env-var heuristic. */
  muxPreference?: "auto" | "tmux" | "zellij";
  /**
   * Parent pi session id. Used as the per-session key for the on-disk state file
   * so a parent reload can rehydrate the sub-agent. If omitted, persistence is
   * skipped (used by tests that don't care about reload).
   */
  parentSessionId?: string;
  /** Live supervisor owner independent of persistence and delivery policy. */
  supervisorOwner?: SessionOwnerToken;
  /** Current runtime scope that authoritatively owns the spawned state. */
  sessionScope?: SessionScope;
  /** Workflow owner for grouping and cancellation. */
  workflowId?: string;
  /** Workflow-managed completions are consumed by the workflow runner. */
  completionOwner?: "standalone" | "workflow";
  /**
   * The parent session's working directory, used for the state file location.
   * If omitted, falls back to `cwd` (backward-compatible for tests).
   */
  parentCwd?: string;
  /** Thinking/reasoning level for the child Pi process. */
  thinkingLevel?: ThinkingLevel;
}): InteractiveSubagentState {
  // 8 bytes, not 4: at 32 bits a birthday collision inside one tree is not
  // remote, and the duplicate-id path only degrades gracefully — it does not
  // recover the shadowed agent.
  const id = randomBytes(8).toString("hex");
  const cwd = resolve(params.cwd);
  const stateCwd = params.parentCwd ? resolve(params.parentCwd) : cwd;
  const artifactOwnerSessionId =
    params.parentSessionId ?? sessionIdForOwner(params.supervisorOwner);
  const background = params.background !== false; // default true (hidden)
  const paths = createInteractiveSubagentPaths({ id, name: params.name, cwd });
  const parentAgentId = process.env.PI_SUBAGENTURA_AGENT_ID;
  const rootId = process.env.PI_SUBAGENTURA_ROOT_ID ?? params.parentSessionId;
  const sessionRoot =
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT ?? defaultSessionRoot();
  const currentDepth = Number.parseInt(
    process.env.PI_SUBAGENTURA_DEPTH ?? "0",
    10,
  );
  const maxDepth = Number.parseInt(
    process.env.PI_SUBAGENTURA_MAX_DEPTH ?? String(DEFAULT_MAX_DEPTH),
    10,
  );
  const effectiveCurrentDepth = Number.isFinite(currentDepth)
    ? currentDepth
    : 0;
  const effectiveMaxDepth =
    Number.isFinite(maxDepth) && maxDepth >= 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const nextDepth = effectiveCurrentDepth + 1;
  if (rootId && nextDepth > effectiveMaxDepth) {
    throw new Error(
      `interactive sub-agent depth ${nextDepth} exceeds max ${effectiveMaxDepth}`,
    );
  }
  const configuredMaxNodes = Number.parseInt(
    process.env.PI_SUBAGENTURA_MAX_NODES ?? String(DEFAULT_MAX_NODES),
    10,
  );
  const maxNodes =
    Number.isFinite(configuredMaxNodes) && configuredMaxNodes > 0
      ? configuredMaxNodes
      : DEFAULT_MAX_NODES;
  // The cap applies whenever a lineage root exists, even when this spawn will
  // not persist a manifest of its own — recursion inside a tree still has to be
  // bounded by that tree's budget.
  const lineageStore = rootId
    ? resolveLineageStorePathsSync(sessionRoot, rootId)
    : undefined;
  if (lineageStore) {
    let activeCount = existsSync(lineageStore.nodesDir)
      ? countLineageManifestsSync(lineageStore.nodesDir)
      : 0;
    if (activeCount >= maxNodes) {
      // Physical manifests include confirmed-dead ancestors retained to keep
      // child lineage connected. Probe only at the cap, then admit by the
      // active/non-dead count; unknown panes conservatively consume capacity.
      activeCount = pruneTerminalLineageNodesSync(
        lineageStore.nodesDir,
        (manifest) => getLineagePaneLiveness(manifest).kind === "dead",
      ).active;
    }
    if (activeCount >= maxNodes) {
      throw new Error(
        `interactive sub-agent tree reached max nodes ${maxNodes} (${activeCount} nodes are active or have unknown liveness)`,
      );
    }
  }
  const prompt = buildInteractivePrompt({
    task: params.task,
    contextText: params.contextText,
  });
  mkdirSync(paths.artifactDir, { recursive: true });
  if (artifactOwnerSessionId) {
    writeFileSync(
      join(paths.artifactDir, INTERACTIVE_ARTIFACT_OWNER_FILE),
      artifactOwnerSessionId,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  writeFileSync(paths.promptFile, prompt, { encoding: "utf8", mode: 0o600 });

  // Cap the persona to prevent a misbehaving parent from shipping a huge
  // system prompt to the model on every turn. 64 KiB is well above what any
  // realistic persona needs; larger values are rejected so the child session
  // fails fast with a clear error.
  const MAX_PERSONA_BYTES = 64 * 1024;
  if (
    params.persona !== undefined &&
    Buffer.byteLength(params.persona, "utf8") > MAX_PERSONA_BYTES
  ) {
    throw new Error(
      `persona too large: ${Buffer.byteLength(params.persona, "utf8")} bytes (max ${MAX_PERSONA_BYTES})`,
    );
  }

  // Always write a system prompt that includes the child protocol, and place
  // the user-supplied persona (if any) ABOVE the protocol. Recency wins for
  // instruction-following, so the protocol — the part that keeps the
  // parent-child notification loop working — is the most recent instruction
  // the LLM reads. A persona that says "ignore the protocol" is a known LLM
  // footgun, and placing the protocol last makes it stick.
  const protocol = buildChildSubagentProtocol(paths.artifactDir);
  const systemPromptContent = params.persona
    ? `# Persona\n\n${params.persona}\n\n${protocol}`
    : protocol;
  writeFileSync(paths.systemPromptFile, systemPromptContent, {
    encoding: "utf8",
    mode: 0o600,
  });

  const systemPromptFile = paths.systemPromptFile;

  // Resolve the multiplexer up front so a clear error reaches the caller
  // before we start writing files. The resolver throws NoMultiplexerAvailableError
  // with a setup hint if neither backend is usable.
  let mux;
  try {
    mux = getMux({ preference: params.muxPreference });
  } catch (err) {
    if (err instanceof NoMultiplexerAvailableError) {
      throw new Error(`${err.message}\n${tmuxSetupHint()}`);
    }
    throw err;
  }

  // Create the pane FIRST (so we have a target for the launch script to attach
  // to). If any later step throws, try to kill the orphan pane and rethrow.
  const {
    paneId,
    windowName,
    session: muxSession,
  } = mux.createPane({
    name: params.name,
    cwd,
    background,
    parentPane: process.env.TMUX_PANE,
    windowName: safeSegment(params.name),
    id,
  });
  let persistedState = false;
  let lineageManifestPath: string | undefined;
  // Persist as soon as the pane is addressable. A crash after this point is
  // recoverable on reload. If persistence itself fails, abort and kill the
  // pane; otherwise the child would be invisible to rehydrate after a restart.
  if (params.parentSessionId) {
    try {
      appendInteractiveState(stateCwd, {
        id,
        paneId,
        windowName,
        mux: mux.name,
        muxSession,
        artifactDir: paths.artifactDir,
        sessionFile: paths.sessionFile,
        notifyOnComplete: params.notifyOnComplete ?? "inject",
        triggerTurnOnComplete: params.triggerTurnOnComplete,
        parentSessionId: params.parentSessionId,
        eventByteCursor: 0,
        sessionByteCursor: 0,
        pendingDeliveries: [],
        deliveryReceipts: [],
      });
      persistedState = true;
    } catch (err) {
      try {
        mux.killPane(paneId, muxSession);
      } catch {
        /* best effort — preserve the original persistence error */
      }
      throw err;
    }
  }
  if (rootId && params.parentSessionId) {
    try {
      lineageManifestPath = writeLineageManifestAtomicSync(
        lineageStore!.nodesDir,
        {
          schemaVersion: LINEAGE_SCHEMA_VERSION,
          agentId: id,
          ...(parentAgentId ? { parentAgentId } : {}),
          rootId,
          rootHash: hashLineageRoot(rootId),
          ownerSessionId: params.parentSessionId,
          name: params.name,
          taskPreview: params.task.replace(/\s+/g, " ").slice(0, 4096),
          startedAt: new Date().toISOString(),
          cwd,
          pane: {
            backend: mux.name,
            paneId,
            ...(muxSession ? { muxSession } : {}),
            ...(windowName ? { windowName } : {}),
          },
          artifactDir: paths.artifactDir,
          childSessionFile: paths.sessionFile,
        },
      );
    } catch (err) {
      if (persistedState) {
        try {
          removeInteractiveState(stateCwd, id);
        } catch {
          /* preserve the lineage error */
        }
      }
      mux.killPane(paneId, muxSession);
      throw err;
    }
  }
  try {
    const command = buildPiInteractiveCommand({
      sessionFile: paths.sessionFile,
      name: params.name,
      promptFile: paths.promptFile,
      systemPromptFile,
      model: params.model,
      cwd,
      thinkingLevel: params.thinkingLevel,
    });
    writeLaunchScript(paths.launchScriptFile, command, paths.artifactDir, {
      ...(rootId ? { PI_SUBAGENTURA_ROOT_ID: rootId } : {}),
      ...(rootId ? { PI_SUBAGENTURA_LINEAGE_SESSION_ROOT: sessionRoot } : {}),
      PI_SUBAGENTURA_AGENT_ID: id,
      PI_SUBAGENTURA_DEPTH: String(nextDepth),
      PI_SUBAGENTURA_MAX_DEPTH: String(effectiveMaxDepth),
      PI_SUBAGENTURA_MAX_NODES: String(maxNodes),
    });
    const escape = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    mux.sendKeys(
      paneId,
      `exec bash ${escape(paths.launchScriptFile)}`,
      muxSession,
    );
    mux.sendEnter(paneId, muxSession);
  } catch (err) {
    // Orphan-pane guard. If writeLaunchScript or sendKeys throws after
    // the pane was created, kill the pane before rethrowing so we don't
    // leak it into the user's mux server. Also clean up persisted state.
    if (persistedState && params.parentSessionId) {
      try {
        removeInteractiveState(stateCwd, id);
      } catch {
        /* best effort — the pane kill below is the important cleanup */
      }
    }
    if (lineageManifestPath) {
      try {
        rmSync(lineageManifestPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    mux.killPane(paneId, muxSession);
    throw err;
  }

  const attach = mux.buildAttachCommands({
    paneId,
    windowName,
    session: muxSession,
  });
  const state: InteractiveSubagentState = {
    id,
    name: params.name,
    task: params.task,
    paneId,
    windowName,
    mux: mux.name,
    muxSession,
    sessionFile: paths.sessionFile,
    cwd: stateCwd,
    model: params.model,
    startedAt: Date.now(),
    status: "running",
    attachCommand: attach.attachCommand,
    selectPaneCommand: attach.focusCommand,
    launchScriptFile: paths.launchScriptFile,
    artifactDir: paths.artifactDir,
    notifyOnComplete: params.notifyOnComplete ?? "inject",
    triggerTurnOnComplete: params.triggerTurnOnComplete,
    parentSessionId: params.parentSessionId,
    supervisorOwner: params.supervisorOwner,
    workflowId: params.workflowId,
    completionOwner: params.completionOwner,
    eventByteCursor: 0,
    pendingDeliveries: [],
    deliveryReceipts: [],
  };
  initializeInteractiveStateMachine(state, { kind: "alive" });
  interactiveSubagentRegistry.set(id, state);
  return state;
}

/**
 * Resolve the multiplexer that created a given sub-agent state. Uses
 * `state.mux` to dispatch to the right backend via `getMux({ preference:
 * state.mux })`, which returns a cached instance so the exec probe is
 * paid once per process.
 */
function getMuxForState(state: InteractiveSubagentState): Multiplexer {
  return getMux({ preference: state.mux });
}

export function paneRefForState(state: InteractiveSubagentState): PaneRef {
  return {
    paneId: state.paneId,
    windowName: state.windowName,
    session: state.muxSession,
  };
}

export function focusInteractiveSubagent(
  state: InteractiveSubagentState,
): Promise<void> {
  return getMuxForState(state).focusPane(paneRefForState(state));
}

export function captureInteractiveSubagent(
  state: InteractiveSubagentState,
  options: CapturePaneOptions,
): Promise<CapturePaneResult> {
  return getMuxForState(state).capturePane(paneRefForState(state), options);
}

export function showInteractiveSubagentNativeViewer(
  state: InteractiveSubagentState,
  content: string,
): Promise<boolean> {
  return getMuxForState(state).showNativeViewer(state.name, content);
}

/**
 * Synchronous recovery preflight. A false compatibility probe is inconclusive
 * because the legacy boolean API also returns false for transport failures.
 * The recurring async observer performs authoritative dead classification.
 */
export function inspectInteractivePaneForRehydrate(
  state: InteractiveSubagentState,
): PaneLiveness {
  try {
    const mux = getMuxForState(state);
    if (!mux.isAvailable()) {
      return { kind: "unavailable", reason: `${state.mux} is unavailable` };
    }
    return mux.isPaneAlive(state.paneId, state.muxSession)
      ? { kind: "alive" }
      : {
          kind: "unknown",
          reason: "synchronous pane probe could not confirm liveness",
        };
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Observe pane liveness without blocking the parent event loop. */
export function observeInteractivePane(
  state: InteractiveSubagentState,
): Promise<PaneLiveness> {
  return getMuxForState(state).observePane(state.paneId, state.muxSession);
}

/**
 * Inspect the pane recorded in a lineage manifest without collapsing transport
 * failure into confirmed death. Lineage pruning is synchronous because launch
 * admission is synchronous, so it uses the mux tri-state compatibility probe;
 * live owner reconciliation still uses the typed asynchronous observer.
 */
export function getLineagePaneLiveness(
  manifest: LineageManifest,
): PaneLiveness {
  const backend = manifest.pane.backend;
  if (backend !== "tmux" && backend !== "zellij") {
    return { kind: "unavailable", reason: `unsupported mux ${backend}` };
  }
  try {
    const liveness = getMux({ preference: backend }).getPaneLiveness(
      manifest.pane.paneId,
      manifest.pane.muxSession,
    );
    switch (liveness) {
      case "alive":
        return { kind: "alive" };
      case "dead":
        return { kind: "dead" };
      case "unknown":
        return { kind: "unknown" };
      default:
        return assertNever(liveness);
    }
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether a mux client is attached to the session hosting this agent's pane.
 *
 * `undefined` means "cannot tell". Focus is server-side state — tmux
 * `select-window` exits 0 with zero clients attached — so a successful focus is
 * invisible to the user for a detached `pi-subagent-<id>` session, which is the
 * normal case for the relaxed spawn path.
 *
 * The probe itself belongs to the multiplexer layer. Backends opt in by
 * implementing the optional `hasAttachedClientAsync(session?)` method; until
 * they do, this resolves `undefined` and the UI stays quiet.
 */
export async function interactiveSubagentHasAttachedClient(
  state: InteractiveSubagentState,
): Promise<boolean | undefined> {
  const mux = getMuxForState(state) as Multiplexer & {
    hasAttachedClientAsync?: (
      session?: string,
    ) => Promise<boolean | undefined> | boolean | undefined;
  };
  if (typeof mux.hasAttachedClientAsync !== "function") return undefined;
  try {
    return await mux.hasAttachedClientAsync(state.muxSession);
  } catch {
    return undefined;
  }
}

/**
 * Send a command (text + Enter) to a pane, using the mux that created it.
 * Mux-agnostic — replaces `sendCommandToTmuxPane(paneId, command)`.
 */
export function sendCommandToPane(
  state: InteractiveSubagentState,
  command: string,
): void {
  const mux = getMuxForState(state);
  mux.sendKeys(state.paneId, command, state.muxSession);
  mux.sendEnter(state.paneId, state.muxSession);
}

/** Rebuild attach/focus commands for a persisted or rehydrated state. */
export function buildAttachCommandsForState(
  state: Pick<
    InteractiveSubagentState,
    "paneId" | "windowName" | "mux" | "muxSession"
  >,
): { attachCommand: string; focusCommand: string } {
  return getMuxForState(state as InteractiveSubagentState).buildAttachCommands({
    paneId: state.paneId,
    windowName: state.windowName,
    session: state.muxSession,
  });
}

/**
 * Probe a tmux pane. Kept as a thin helper for the existing call sites in
 * subagent.ts; PR #2 will route through `state.mux` so this becomes mux-agnostic.
 */
/**
 * Probe a tmux pane. Kept as a thin helper for the existing call sites in
 * subagent.ts; PR #2 will route through `state.mux` so this becomes mux-agnostic.
 */
export function isTmuxPaneAlive(paneId: string): boolean {
  return new TmuxMultiplexer().isPaneAlive(paneId);
}

/**
 * Send a command to a tmux pane. Backward-compat alias — prefer
 * `sendCommandToPane(state, command)` which is mux-agnostic.
 */
export function sendCommandToTmuxPane(paneId: string, command: string): void {
  const mux = new TmuxMultiplexer();
  mux.sendKeys(paneId, command);
  mux.sendEnter(paneId);
}

export function cancelInteractiveSubagent(
  id: string,
  source: CancellationSnapshotSource = "cancel_interactive_subagent",
  ownedState?: InteractiveSubagentState,
): InteractiveSubagentState | undefined {
  const state =
    ownedState?.id === id ? ownedState : interactiveSubagentRegistry.get(id);
  if (!state) return undefined;

  const snapshot = snapshotInteractiveContext({
    kind: "interactive",
    id: state.id,
    parentSessionId: state.parentSessionId,
    cwd: state.cwd,
    sessionFile: state.sessionFile,
    artifactDir: state.artifactDir,
    startedAt: state.startedAt,
    source,
  });
  state.cancellationSnapshot = snapshot;

  // 1. Drop a `.cancelled` flag file in the artifact dir. The wrapper's EXIT trap
  //    checks for this before writing the `done` event; if present, it writes
  //    `cancelled` instead so the artifact log is self-describing.
  try {
    writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
  } catch {
    /* best effort — dir may not exist yet if the launch script is still warming up */
  }
  appendCancellation(state);

  // 2. Advance the registry projection. The durable artifact remains authoritative.
  advanceInteractiveState(state, { type: "parent_cancelled" });

  // 3. Kill without a blocking liveness preflight. Pane teardown is idempotent
  // from the lifecycle's perspective; the async observer confirms death.
  try {
    getMuxForState(state).killPane(state.paneId, state.muxSession);
  } catch {
    /* best effort; the poller continues reconciling durable artifacts */
  }
  return state;
}

function appendCancellation(
  state: InteractiveSubagentState,
  acknowledgeDelivery = true,
): void {
  let turnId = "process";
  try {
    const active = JSON.parse(
      readFileSync(join(state.artifactDir, "active-turn.json"), "utf8"),
    ) as { turnId?: string };
    if (active.turnId) turnId = active.turnId;
  } catch {
    /* cancellation before the first turn uses the process turn */
  }
  const art = artifactPath(
    dirname(state.artifactDir),
    basename(state.artifactDir),
  );
  let completion = appendCompletionEvent(art, {
    turnId,
    outcome: "cancelled",
    source: "parent",
  });
  if (!completion) {
    turnId = `process-cancel-${newEventId()}`;
    completion = appendCompletionEvent(art, {
      turnId,
      outcome: "cancelled",
      source: "parent",
    });
  }
  if (!completion) return;
  if (!acknowledgeDelivery) return;
  const mode = state.notifyOnComplete ?? "inject";
  const deliveryId = deliveryIdFor({
    parentSessionId: state.parentSessionId ?? "pi",
    subagentId: state.id,
    turnId,
    mode,
  });
  // The parent initiated this terminal path, so the cancel tool result or session
  // transition already accounts for it. Persist a synthetic receipt before pane
  // teardown so polling or rehydrate cannot inject a duplicate completion.
  acknowledgeDeliveryWithoutDispatch(state, deliveryId);
}

/**
 * Cancel a persisted descendant without claiming its completion in the root
 * session. The descendant's owning Pi process remains responsible for polling
 * the durable completion and delivering it to its own session.
 */
export function cancelInteractiveDescendantByState(
  state: InteractiveSubagentState,
): InteractiveSubagentState {
  state.cancellationSnapshot = snapshotInteractiveContext({
    kind: "interactive",
    id: state.id,
    parentSessionId: state.parentSessionId,
    cwd: state.cwd,
    sessionFile: state.sessionFile,
    artifactDir: state.artifactDir,
    startedAt: state.startedAt,
    source: "cancel_interactive_subagent",
  });
  try {
    writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
  } catch {
    /* best effort; the owner will reconcile the durable pane state */
  }
  appendCancellation(state, false);
  advanceInteractiveState(state, { type: "parent_cancelled" });
  try {
    getMuxForState(state).killPane(state.paneId, state.muxSession);
  } catch {
    /* best effort; the owner reconciles durable artifacts */
  }
  return state;
}

/**
 * Kills a tmux pane and writes the .cancelled flag for an interactive sub-agent,
 * bypassing the registry. Used by the session_shutdown handler which snapshots
 * running states before clearing the registry (see subagent.ts session_shutdown
 * handler — snapshot-before-clear pattern).
 *
 * Differs from `cancelInteractiveSubagent` in three intentional ways:
 *   1. NO registry lookup: takes the full `InteractiveSubagentState` by value
 *      instead of looking it up by id. This is required because the shutdown
 *      handler clears the registry BEFORE killing panes (to prevent the
 *      in-flight poll tick race), so `cancelInteractiveSubagent(id)` would
 *      early-return `undefined` and the pane-kill would be skipped.
 *   2. State advancement is still routed through the lifecycle kernel, even
 *      though this snapshot has already been detached from the registry.
 *   3. `mux.killPane` wrapped in try/catch: a synchronous `execFileSync` failure
 *      (e.g. tmux already exited, session torn down) must not abort the
 *      shutdown loop over remaining running states. The original function
 *      relies on its caller to wrap in try/catch; this variant does it
 *      internally so the shutdown handler is a clean loop.
 *
 * @param state - the snapshotted state of the sub-agent to cancel
 */
export function cancelInteractiveSubagentByState(
  state: InteractiveSubagentState,
): void {
  const snapshot = snapshotInteractiveContext({
    kind: "interactive",
    id: state.id,
    parentSessionId: state.parentSessionId,
    cwd: state.cwd,
    sessionFile: state.sessionFile,
    artifactDir: state.artifactDir,
    startedAt: state.startedAt,
    source: "session_shutdown",
  });
  state.cancellationSnapshot = snapshot;

  // 1. Write .cancelled flag (best-effort)
  try {
    writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
  } catch {
    /* best-effort */
  }
  appendCancellation(state);
  advanceInteractiveState(state, { type: "parent_cancelled" });

  // 2. Kill without a blocking liveness preflight.
  try {
    getMuxForState(state).killPane(state.paneId, state.muxSession);
  } catch {
    /* best-effort */
  }
  // The detached snapshot is advanced for consistent cancellation semantics.
}

/**
 * Compatibility status projection retained for existing callers and tests.
 * A v2 completion ends one turn, so done/error is idle while the pane lives;
 * legacy error and confirmed process exit remain terminal.
 */
export function deriveInteractiveSubagentStatus(
  lastEvent: SubagentEvent | null,
  paneAlive: boolean,
): InteractiveSubagentStatus {
  let machine = initialInteractiveMachineState({
    pane: { kind: paneAlive ? "alive" : "dead" },
  });
  if (lastEvent) {
    const transition = transitionInteractiveMachine(machine, {
      type: "artifact",
      event: lastEvent,
    });
    if (transition.kind === "applied") machine = transition.state;
  }
  return projectInteractiveStatus(machine);
}

export function deriveInteractiveSubagentStatusFromEvents(
  events: SubagentEvent[],
  paneAlive: boolean,
): InteractiveSubagentStatus {
  let machine = initialInteractiveMachineState({
    pane: { kind: paneAlive ? "alive" : "dead" },
  });
  for (const event of events) {
    const transition = transitionInteractiveMachine(machine, {
      type: "artifact",
      event,
    });
    if (transition.kind === "applied") machine = transition.state;
  }
  return projectInteractiveStatus(machine);
}

export function foldInteractiveLifecycle(
  lifecycle: PersistedLifecycleFold,
  event: SubagentEvent,
): void {
  const machine = initialInteractiveMachineState({ lifecycle });
  const transition = transitionInteractiveMachine(machine, {
    type: "artifact",
    event,
  });
  if (transition.kind !== "applied") return;
  Object.assign(lifecycle, transition.state.lifecycle);
}

export function deriveInteractiveSubagentStatusFromLifecycle(
  lifecycle: PersistedLifecycleFold,
  paneState: boolean | PaneLiveness,
): InteractiveSubagentStatus {
  const pane: PaneLiveness =
    typeof paneState === "boolean"
      ? { kind: paneState ? "alive" : "dead" }
      : paneState;
  return projectInteractiveStatus(
    initialInteractiveMachineState({ lifecycle, pane }),
  );
}

/**
 * Update registry status for every tracked sub-agent based on the artifact's
 * last event and pane liveness (via the mux that created each pane).
 * Idempotent — safe to call on every poll tick.
 *
 * Follow-up support: a `done` event with a live pane is the "idle" state,
 * NOT exited. The child is between turns, REPL is open, and
 * `send_interactive_subagent_message` will accept more prompts. Only when
 * the pane is actually gone (or the child called `error`) is the sub-agent
 * terminal.
 * Liveness probing is asynchronous so native mux subprocesses never block the
 * parent event loop. Revision fences discard results from older observations.
 */
export async function pruneDeadInteractiveSubagents(): Promise<void> {
  const pending = [...interactiveSubagentRegistry.values()]
    .filter((state) => {
      const status = interactiveStatusForState(state);
      return status !== "cancelled" && status !== "exited";
    })
    .map((state) => {
      const started = advanceInteractiveState(state, {
        type: "pane_observation_started",
      });
      return {
        state,
        revision:
          started.kind === "applied"
            ? started.state.observationRevision
            : getInteractiveMachineState(state).observationRevision,
      } as const;
    });
  const observations = await Promise.all(
    pending.map(async ({ state, revision }) => {
      try {
        return {
          state,
          revision,
          liveness: await observeInteractivePane(state),
        } as const;
      } catch (error) {
        return {
          state,
          revision,
          liveness: {
            kind: "unknown",
            reason: error instanceof Error ? error.message : String(error),
          } as const,
        } as const;
      }
    }),
  );
  for (const observation of observations) {
    if (
      interactiveSubagentRegistry.get(observation.state.id) !==
      observation.state
    ) {
      continue;
    }
    advanceInteractiveState(observation.state, {
      type: "pane_observed",
      revision: observation.revision,
      liveness: observation.liveness,
    });
  }
}

export function formatInteractiveState(
  state: InteractiveSubagentState,
): string {
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  const taskPreview = state.task.replace(/\s+/g, " ").slice(0, 80);
  const lines: string[] = [
    `${state.name} (${state.id}) — ${interactiveStatusForState(state)}, ${elapsed}s`,
    `Task: ${taskPreview}${state.task.length > 80 ? "…" : ""}`,
    `Mux: ${state.mux}`,
    `Pane: ${state.paneId}`,
  ];
  if (state.windowName) lines.push(`Window: ${state.windowName}`);
  if (state.exitCode !== undefined) lines.push(`Exit code: ${state.exitCode}`);
  lines.push(`Artifact: ${state.artifactDir}`);
  if (!(state.mux === "tmux" && process.env.TMUX)) {
    lines.push(`Attach: ${state.attachCommand}`);
  }
  lines.push(`Focus: ${state.selectPaneCommand}`);
  lines.push(`Session: ${state.sessionFile}`);
  return lines.join("\n");
}

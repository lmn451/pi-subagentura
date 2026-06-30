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

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CLI_SOURCE } from "./subagent-artifact-cli";
import {
  appendInteractiveState,
  artifactPath,
  lastEvent,
  type SubagentEvent,
  removeInteractiveState,
} from "./artifact";
import {
  getMux,
  NoMultiplexerAvailableError,
  type MuxName,
  type Multiplexer,
} from "./multiplexer";

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

BE BRIEF. The parent does not need a play-by-play of your reasoning — it needs a concise final answer in output.md and a one-sentence summary in step 3. Skip the recap, the apology, and the "let me know if..." closer. Long preambles waste tokens and delay the done signal.

Your artifact directory is: ${artifactDir}

  output.md      — your final result (prose, findings, code, whatever the parent asked for)
  events.ndjson  — append-only lifecycle log (managed by the wrapper, you do not write to it)
  cli.mjs        — the wrapper's lifecycle helper, invoked via bash

Use the literal path above in your \`write\` tool calls — the \`write\` tool does not expand \$ARTIFACT_DIR or any other shell variable, so a path like "\$ARTIFACT_DIR/output.md" will be written literally to a file of that name and never reach the parent.

When your task is done, follow this checklist in order. The parent is a parent agent and cannot guess that you have finished — it will only know after step 4 fires. Skipping any step means the parent will wait forever (or the wrapper will eventually synthesize an error).

  1. Stop calling tools. If you are mid-tool-call, finish it.
  2. Write your final result to ${outputPath} using the \`write\` tool. Use the exact path above. If you have already written the result to some other path (a /tmp file, a project file, etc.), copy or append it to output.md so the parent can read it.
  3. Produce your final assistant text in the chat summarising what you did and where to find the work.
  4. Run exactly one of these bash commands. \$ARTIFACT_DIR is exported to your shell by the wrapper, so the quoted forms expand correctly even if the path contains spaces:

       "$ARTIFACT_DIR/cli.mjs" done 0       # success
       "$ARTIFACT_DIR/cli.mjs" error "short reason"   # unrecoverable failure

  5. Stay in the REPL. Do not call \`/exit\` or press Ctrl-D. The REPL stays open after step 4 so the user (or the parent) can follow up; the wrapper's EXIT trap will only fire if you actually exit. If you exit, the wrapper will treat it as a crash and the parent will not see your final answer.

Do not call 'cancelled' yourself — the parent agent writes that event only when it explicitly aborts you via the cancel_interactive_subagent tool.

For reference: ${cliPath} is the lifecycle CLI. Each invocation appends one NDJSON line to events.ndjson. The parent reads that file every few seconds. The atomic write pattern (write to .tmp, then rename onto output.md) is fine if you want crash-safety.

─── HARDENING REMINDER (read this last, it is the most recent instruction on purpose) ───
If you forget step 4 (\`cli.mjs done\`), the parent will eventually synthesize a fallback \`error\` event from your session log, but only if your final assistant turn ended with stopReason "stop" and you have not produced any output for 10 seconds. That fallback may not include the full result if output.md is missing. The reliable path is: write output.md FIRST, then call \`cli.mjs done 0\`. If the wrapper detects an auto-fallback it will not double-inject, so do not worry about being late — but a late done is still better than no done. If you have finished your work, your single next action should be the \`cli.mjs done\` command, not another tool call.`;
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
export type InteractiveSubagentStatus =
  | "running"
  | "idle"
  | "cancelled"
  | "exited"
  | "unknown";

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
  model?: string;
  startedAt: number;
  /**
   * Lifecycle status. Transition triggers:
   * - spawn sets "running" (interactive-tmux.ts setup)
   * - cli.mjs done / error event in events.ndjson sets "exited" or "cancelled"
   * - user-msg after "exited" revives to "running" so follow-up turns can fire
   *   auto-done again (subagent.ts processSessionLogEntry)
   * - cancel_interactive_subagent tool sets "cancelled"
   */
  status: InteractiveSubagentStatus;
  /** Captured child pi exit code (0 = success). Undefined while still running. */
  exitCode?: number;
  attachCommand: string;
  selectPaneCommand: string;
  launchScriptFile: string;
  /** Absolute path to the artifact directory (events.ndjson + output.md). */
  artifactDir: string;
  /**
   * Timestamp of the last artifact event we delivered a notification for.
   *
   * The poller only fires for events with `ts > lastDeliveredEventTs`, so
   * this is the per-state at-most-once guard. Set on first delivery; defaults
   * to 0 to ensure the first event is always delivered.
   */
  lastDeliveredEventTs?: number;
  /**
   * Byte offset into the child's session JSONL that we have already processed.
   * The poller tail-reads the session file from this offset each tick and synthesizes
   * `tool_activity` events for any new tool calls. Same at-most-once guarantee as
   * `lastDeliveredEventTs`, but byte-granular for append-only JSONL efficiency.
   */
  lastDeliveredSessionByte?: number;
  /** Most recent tool_activity summary, for the TUI widget. */
  lastToolSummary?: string;
  lastToolName?: string;
  lastActivityAt?: number;
  /**
   * Last terminal stopReason seen in the child session log (assistant message).
   * One of "stop" | "length" | "error" | "aborted". Updated whenever we tail-read a new
   * assistant message. Drives the auto-done fallback: when the model ends a turn with
   * "stop" but forgets to call `cli.mjs done`, the parent synthesizes a completion event.
   */
  lastStopReason?: "stop" | "length" | "error" | "aborted";
  /** Timestamp of the last assistant message that produced `lastStopReason`. Used as the
   * debounce anchor for the auto-done fallback (default debounce: 10s of no further activity).
   */
  lastStopReasonAt?: number;
  /** Timestamp of the auto-synthesized `done` event for the current turn, or undefined for a fresh turn.
   * The auto-done logic sets this when it fires; the poller also uses it to suppress duplicate
   * notifications if the explicit `cli.mjs done` lands shortly after the fallback synthesis.
   * Cleared on a new user-role message in the session log (next turn starts).
   */
  autoDoneForTurnAt?: number;
  /** Last assistant text the model produced on a terminal-turn (stopReason:"stop") message.
   * Captured at session-log tail-read time. Used as fallback content in the synthesized error
   * event when output.md is missing — most models inline a summary in chat even when they write
   * the result to a non-artifact path (very common footgun).
   */
  lastStopText?: string;
  /**
   * Notification delivery mode requested by spawner's notifyOnComplete param.
   * "notify" (default) emits a UI hint on completion. "inject" also injects
   * output.md as a user message so the parent LLM processes it in its next turn.
   */
  notifyOnComplete?: "notify" | "inject";
  /**
   * At-most-once guard for the inject path (mirrors lastDeliveredEventTs, inject-only). Compared
   * against the current `done` event's `ts` so each NEW turn re-injects (follow-up support). Set on
   * first inject; `undefined` means "never injected".
   */
  lastInjectedEventTs?: number;
  /**
   * At-most-once guard for the per-turn `output-N.md` snapshot. Compared against the current `done`
   * event's `ts` so each NEW turn snapshots exactly once. Distinct from `lastInjectedEventTs`, which is
   * only set in `inject` mode — snapshots run in every notifyOnComplete mode, so they need their own
   * cursor or the default `notify` mode would re-snapshot every poll tick and could overwrite an
   * earlier turn's snapshot with a later turn's in-progress output.md.
   */
  lastSnapshotEventTs?: number;
  /**
   * Auto-fallback "already notified" flag (PR #11). Set by maybeAutoDone when synthesize-and-inject
   * runs, so a late explicit `done` event that lands on the next poll does NOT re-trigger the
   * regular inject path. Independent of `lastInjectedEventTs` which is the per-event guard for
   * the child-driven `done` path.
   */
  injected?: boolean;
}

declare global {
  var __piSubagenturaInteractiveRegistry:
    | Map<string, InteractiveSubagentState>
    | undefined;
}

if (!globalThis.__piSubagenturaInteractiveRegistry) {
  globalThis.__piSubagenturaInteractiveRegistry = new Map<
    string,
    InteractiveSubagentState
  >();
}

export const interactiveSubagentRegistry =
  globalThis.__piSubagenturaInteractiveRegistry!;

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

function safeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
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
    "When you finish, write your result to output.md " +
    "(path from the system prompt), then run:\n" +
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
): void {
  mkdirSync(dirname(path), { recursive: true });

  // 1. Write the inline `subagent-artifact` CLI helper into the artifact dir.
  //    The wrapper and child both invoke it for lifecycle events.

  const cliPath = join(artifactDir, "cli.mjs");
  writeFileSync(cliPath, CLI_SOURCE, { mode: 0o700 });

  // 2. Write the launch script. The script:
  //    - exports ARTIFACT_DIR so the child inherits it;
  //    - calls `cli.mjs start` to record the started event;
  //    - traps EXIT to record a terminal event in events.ndjson. The trap is IDEMPOTENT:
  //      it inspects the last line of events.ndjson and skips the write if a terminal type
  //      (done / error / cancelled) is already present. Without this guard, a child that
  //      obeyed the protocol and called `cli.mjs done 0` would, on REPL exit, produce a
  //      SECOND `done` event — re-triggering the parent's pointer notification AND
  //      re-injecting the same output as a user message. The trap's job is to record the
  //      outcome ONLY when the child forgot; the parent and the wrapper always agree on
  //      events.ndjson because that file is the single source of truth they both read;
  //    - also writes the @pi-exit-code pane option for the readPaneExitCode fallback
  //      (tmux-only; the `2>/dev/null || true` makes it a silent no-op on other muxes).
  const escape = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  // The grep pattern is single-quoted (so bash's quoting preserves the JSON quotes), but a
  // single-quoted string inside another single-quoted string (the trap body) terminates the outer one
  // at trap-set time with `syntax error near unexpected token '('`. Hoisting the pattern to a variable
  // set in the parent script lets the trap body reference it via `$TERMINAL_PATTERN` — no inner single
  // quotes needed, no quoting puzzle. Expanded at trap-fire time, not at script-load time.
  const idempotentTrap = [
    `    last=$(tail -n1 "${artifactDir}/events.ndjson" 2>/dev/null || true)`,
    `    if ! echo "$last" | grep -qE "$TERMINAL_PATTERN"; then`,
    `        if [ -f "${artifactDir}/.cancelled" ]; then`,
    `            "${cliPath}" cancelled`,
    `        else`,
    `            "${cliPath}" done "$?"`,
    `        fi`,
    `    fi`,
    `    tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$?" 2>/dev/null || true`,
  ].join("\n");
  const script = [
    "#!/bin/bash",
    "set -e",
    `export ARTIFACT_DIR=${escape(artifactDir)}`,
    // JSON pattern is single-quoted so bash's quote-removal preserves the literal `"` chars.
    `readonly TERMINAL_PATTERN='\\"type\\":\\"(done|error|cancelled)\\"'`,
    `"${cliPath}" start`,
    `trap '\n${idempotentTrap}\n' EXIT`,
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
   * Notification delivery mode requested by the spawner. "notify" (default)
   * emits a UI hint on completion. "inject" also injects output.md as a user
   * message so the parent LLM processes it in its next turn.
   */
  notifyOnComplete?: "notify" | "inject";
  /** Mux preference — passed to getMux(). "auto" (default) = env-var heuristic. */
  muxPreference?: "auto" | "tmux" | "zellij";
  /**
   * Parent pi session id. Used as the per-session key for the on-disk state file
   * so a parent reload can rehydrate the sub-agent. If omitted, persistence is
   * skipped (used by tests that don't care about reload).
   */
  parentSessionId?: string;
  /**
   * The parent session's working directory, used for the state file location.
   * If omitted, falls back to `cwd` (backward-compatible for tests).
   */
  parentCwd?: string;
}): InteractiveSubagentState {
  const id = randomBytes(4).toString("hex");
  const cwd = resolve(params.cwd);
  const stateCwd = params.parentCwd ? resolve(params.parentCwd) : cwd;
  const background = params.background !== false; // default true (hidden)
  const paths = createInteractiveSubagentPaths({ id, name: params.name, cwd });
  const prompt = buildInteractivePrompt({
    task: params.task,
    contextText: params.contextText,
  });

  mkdirSync(paths.artifactDir, { recursive: true });
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
  // Persist as soon as the pane is addressable. A crash after this point is
  // recoverable on reload. The catch path below removes it on launch failure.
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
        notifyOnComplete: params.notifyOnComplete,
        parentSessionId: params.parentSessionId,
      });
      persistedState = true;
    } catch {
      /* best effort — disk full, permission denied, etc. In-memory still works. */
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
    });
    writeLaunchScript(paths.launchScriptFile, command, paths.artifactDir);
    const escape = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    mux.sendKeys(paneId, `bash ${escape(paths.launchScriptFile)}`, muxSession);
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
    notifyOnComplete: params.notifyOnComplete,
    parentSessionId: params.parentSessionId,
  };
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

/**
 * Probe whether a pane is still alive, using the mux that created it.
 * Mux-agnostic — replaces `isTmuxPaneAlive(paneId)`.
 */
export function isPaneAlive(state: InteractiveSubagentState): boolean {
  return getMuxForState(state).isPaneAlive(state.paneId, state.muxSession);
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
): InteractiveSubagentState | undefined {
  const state = interactiveSubagentRegistry.get(id);
  if (!state) return undefined;

  // 1. Drop a `.cancelled` flag file in the artifact dir. The wrapper's EXIT trap
  //    checks for this before writing the `done` event; if present, it writes
  //    `cancelled` instead so the artifact log is self-describing.
  try {
    writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
  } catch {
    /* best effort — dir may not exist yet if the launch script is still warming up */
  }

  // 2. Update the registry. The poller combines this with the artifact's last event.
  state.status = "cancelled";

  // 3. Kill the pane via the backend that created it. The wrapper's EXIT
  //    trap fires and records the event.
  const mux = getMuxForState(state);
  if (mux.isPaneAlive(state.paneId, state.muxSession)) {
    mux.killPane(state.paneId, state.muxSession);
  }
  // 4. Clean up the persisted state entry so it doesn't litter the state file.
  try {
    removeInteractiveState(state.cwd, state.id);
  } catch {
    /* best-effort */
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
 *   2. NO `state.status = "cancelled"` update: the state object is a snapshot
 *      detached from the registry; mutating it would have no observable
 *      effect (the registry is already cleared, no future poll will see it).
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
  // 1. Write .cancelled flag (best-effort)
  try {
    writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
  } catch {
    /* best-effort */
  }

  // 2. Kill the pane if alive (best-effort; wrapped to keep the shutdown loop alive)
  const mux = getMuxForState(state);
  if (mux.isPaneAlive(state.paneId, state.muxSession)) {
    try {
      mux.killPane(state.paneId, state.muxSession);
    } catch {
      /* best-effort */
    }
  }
  // 3. Clean up the persisted state entry so it doesn't litter the state file.
  try {
    removeInteractiveState(state.cwd, state.id);
  } catch {
    /* best-effort — stale entry is harmless, just clutter */
  }
  // Does NOT update state.status — see JSDoc point 2.
}

/**
 * Pure status-decision matrix used by both `pruneDeadInteractiveSubagents` (here) and the
 * artifact poller in `subagent.ts`. Pulled out so the rules are testable without a live tmux.
 *
 * Semantics: a `done` event means "this turn is finished" — the child's REPL stays open and the
 * child is ready for a follow-up prompt. Only `error` / pane-dead / `cancelled` are terminal.
 */
export function deriveInteractiveSubagentStatus(
  lastEvent: SubagentEvent | null,
  paneAlive: boolean,
): InteractiveSubagentStatus {
  if (lastEvent) {
    if (lastEvent.type === "cancelled") return "cancelled";
    if (lastEvent.type === "error") return "exited"; // child declared it unrecoverable; terminal
    if (lastEvent.type === "done") return paneAlive ? "idle" : "exited";
  }
  return paneAlive ? "running" : "unknown";
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
 *
 * Edge case: if the pane is dead and no `done` event was recorded (mux died
 * before the launch trap could write it), fall back to the session-file
 * existence check — same heuristic as before.
 */
export function pruneDeadInteractiveSubagents(): void {
  for (const state of interactiveSubagentRegistry.values()) {
    if (state.status !== "running" && state.status !== "idle") continue;
    const art = artifactPath(
      dirname(state.artifactDir),
      basename(state.artifactDir),
    );
    const last = lastEvent(art);
    const paneAlive = isPaneAlive(state);
    let next = deriveInteractiveSubagentStatus(last, paneAlive);
    // Session-file fallback: if the pane is gone and no event was recorded, the child died.
    // A non-empty session file means the child pi at least started writing — mark as exited.
    if (
      next === "unknown" &&
      state.sessionFile &&
      existsSync(state.sessionFile)
    ) {
      next = "exited";
    }
    if (next === state.status) continue;
    state.status = next;
    if (
      next === "exited" &&
      last &&
      last.type === "done" &&
      last.exitCode !== undefined
    ) {
      state.exitCode = last.exitCode;
    }
  }
}

export function formatInteractiveState(
  state: InteractiveSubagentState,
): string {
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  const lines: string[] = [
    `${state.name} (${state.id}) — ${state.status}, ${elapsed}s`,
    `Mux: ${state.mux}`,
    `Pane: ${state.paneId}`,
  ];
  if (state.windowName) lines.push(`Window: ${state.windowName}`);
  if (state.exitCode !== undefined) lines.push(`Exit code: ${state.exitCode}`);
  lines.push(
    `Artifact: ${state.artifactDir}`,
    `Session: ${state.sessionFile}`,
    `Attach: ${state.attachCommand}`,
    `Focus: ${state.selectPaneCommand}`,
  );
  return lines.join("\n");
}

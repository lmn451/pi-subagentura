import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import isPathInside from "is-path-inside";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  artifactPath,
  eventLogEndOffset,
  removeInteractiveState,
  INTERACTIVE_ARTIFACT_OWNER_FILE,
  isArtifactOutputSettled,
  isCompletionEvent,
  loadInteractiveStates,
  lastEvent,
  MAX_TURN_ID_LENGTH,
  listOutputHistory,
  listOutputTurns,
  readEvents,
  readEventBatch,
  readOutput,
  readOutputForTurnId,
  readOutputForTurn,
  updateInteractiveState,
  type SubagentArtifact,
} from "../artifact";
import {
  assertCompletionGroupOpen,
  reserveCompletionGroup,
  releaseCompletionGroup,
  consumeCompletionSource,
  registerCompletionMember,
  type CompletionGroupReservation,
  type ResolvedCompletionPolicy,
  resolveCompletionPolicy,
} from "../completion-coordinator";
import {
  cancelInteractiveSubagent,
  disposeWorkflowInteractiveSubagent,
  removeInteractiveSubagentState,
  formatInteractiveState,
  interactiveSubagentRegistry,
  isReusableWorkflowChildExpired,
  launchInteractiveSubagent,
  pruneDeadInteractiveSubagents,
  sendCommandToPane,
  tmuxSetupHint,
  type InteractiveSubagentState,
} from "../interactive-tmux";
import {
  inspectDirectInteractiveRecovery,
  recoverDirectInteractiveSubagent,
} from "../interactive-recovery";
import { debugLog } from "../helpers";
import {
  completionTriggersTurn,
  formatCompletionDeliveryBehavior,
  sanitizeOutput,
} from "../notifications";
import { isOrchestratorV2Enabled } from "../completion-turn";
import {
  MAX_ORCHESTRATOR_ROUTING_ALIASES,
  MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
  MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  appendOrchestratorRoutingAuthorityEntry,
  isValidOrchestratorChildId,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../orchestrator-routing";
import { InteractiveParams, MAX_INTERACTIVE_CONTEXT_BYTES } from "../schemas";
import { registerToolWithDefaultGuidance } from "../tool-guidance";
import { updateRunningSubagentFooter } from "../artifact-poller";
import {
  getStartedSessionScopes,
  resolveToolSessionScope,
  sessionOwner,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";

function isValidSubagentId(id: string): boolean {
  return isValidOrchestratorChildId(id);
}
const MAX_FOLLOWUP_BYTES = 64 * 1024;
const MAX_ARTIFACT_PROVIDER_OUTPUT_BYTES = 64 * 1024;
const MAX_FOLLOWUP_PREVIEW_CHARS = 500;
const FOLLOWUP_COMPLETION_REMINDER =
  ' [MANDATORY COMPLETION PROTOCOL FOR EVERY FOLLOW-UP TURN: Before sending your final assistant response, write the result to output.md; make "$ARTIFACT_DIR/cli.mjs" done 0 your final tool call and wait for success. If it fails, do not send the final response; fix the cause and retry until completion is recorded. Do not rely on the lifecycle hook. After completion is recorded, remain in the Pi REPL and wait for follow-up; do not intentionally exit or close the pane unless explicitly asked.]';

function formatFollowupPreview(message: string): string {
  if (message.length <= MAX_FOLLOWUP_PREVIEW_CHARS) return message;
  return `${message.slice(0, MAX_FOLLOWUP_PREVIEW_CHARS)}… [truncated; ${message.length} chars total]`;
}

function formatArtifactProviderOutput(output: string | null): string {
  if (output === null) return "";
  const sanitized = sanitizeOutput(output);
  const originalBytes = Buffer.byteLength(sanitized, "utf8");
  let bounded = sanitized;
  if (originalBytes > MAX_ARTIFACT_PROVIDER_OUTPUT_BYTES) {
    const marker = `\n[Output truncated from ${originalBytes} bytes.]`;
    bounded = Buffer.from(sanitized, "utf8")
      .subarray(
        0,
        Math.max(
          0,
          MAX_ARTIFACT_PROVIDER_OUTPUT_BYTES -
            Buffer.byteLength(marker, "utf8"),
        ),
      )
      .toString("utf8");
    while (
      Buffer.byteLength(`${bounded}${marker}`, "utf8") >
      MAX_ARTIFACT_PROVIDER_OUTPUT_BYTES
    ) {
      bounded = bounded.slice(0, -1);
    }
    bounded += marker;
  }
  return `\n<untrusted-subagent-output>\n${bounded || "(empty output)"}\n</untrusted-subagent-output>`;
}

type InitialRoutingMetadataResult =
  | { status: "persisted"; entry: OrchestratorRoutingEntry }
  | { status: "warning"; error: string };

function parentBranchEntries(ctx: unknown): readonly unknown[] {
  if (!ctx || typeof ctx !== "object") return [];
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!sessionManager || typeof sessionManager !== "object") return [];
  const getBranch = (sessionManager as { getBranch?: unknown }).getBranch;
  if (typeof getBranch !== "function") return [];
  try {
    const branch = getBranch.call(sessionManager);
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

function persistInitialRoutingMetadata(params: {
  cwd: string;
  childId: string;
  description?: string;
  aliases?: string[];
  authorityEntries?: readonly unknown[];
  pi?: ExtensionAPI;
}): InitialRoutingMetadataResult | undefined {
  if (params.description === undefined) return undefined;
  if (!isValidSubagentId(params.childId)) {
    return {
      status: "warning",
      error: `spawn returned invalid child id ${params.childId}`,
    };
  }
  try {
    const overlay = upsertOrchestratorRoutingEntry(
      params.cwd,
      {
        childId: params.childId,
        description: params.description!,
        ...(params.aliases === undefined ? {} : { aliases: params.aliases }),
        provenance: "orchestratorv2",
      },
      { authorityEntries: params.authorityEntries ?? [] },
    );
    const entry = overlay.records.find(
      (record) => record.childId === params.childId,
    );
    if (!entry) throw new Error("routing metadata update was not persisted");
    appendOrchestratorRoutingAuthorityEntry(params.pi ?? {}, params.cwd, entry);
    return { status: "persisted", entry };
  } catch (error) {
    return {
      status: "warning",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateInitialRoutingMetadata(
  description: string | undefined,
  aliases: string[] | undefined,
): string | undefined {
  if (aliases !== undefined && description === undefined) {
    return "routingAliases requires routingDescription";
  }
  if (description === undefined) return undefined;
  if (description.trim().length === 0) {
    return "description must be a non-empty string";
  }
  const descriptionBytes = Buffer.byteLength(description, "utf8");
  if (descriptionBytes > MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES) {
    return `description exceeds ${MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES} bytes`;
  }
  if (aliases === undefined) return undefined;
  if (aliases.length > MAX_ORCHESTRATOR_ROUTING_ALIASES) {
    return `aliases exceeds ${MAX_ORCHESTRATOR_ROUTING_ALIASES} entries`;
  }
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (alias.trim().length === 0) return "alias must be a non-empty string";
    if (
      Buffer.byteLength(alias, "utf8") > MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES
    ) {
      return `alias exceeds ${MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES} bytes`;
    }
    if (seen.has(alias)) return `duplicate alias: ${alias}`;
    seen.add(alias);
  }
  return undefined;
}

function validateRoutingMetadataMode(
  topLevelOrchestratorV2: boolean,
  description: string | undefined,
  aliases: string[] | undefined,
): string | undefined {
  if (topLevelOrchestratorV2 && description === undefined) {
    return "routingDescription is required for a top-level Orchestratorv2 child";
  }
  if (!topLevelOrchestratorV2 && (description !== undefined || aliases)) {
    return "routingDescription and routingAliases are reserved for a top-level Orchestratorv2 session";
  }
  return undefined;
}
function persistInteractiveRollbackTombstone(
  state: InteractiveSubagentState,
): void {
  const tombstoneAt = Date.now();
  if (!state.parentSessionId) return;
  try {
    updateInteractiveState(state.cwd, state.id, (entry) => {
      delete entry.completionPolicy;
      delete entry.completionGroupId;
      delete entry.notifyOnComplete;
      delete entry.triggerTurnOnComplete;
      entry.completionTombstone = "failed";
      entry.completionTombstoneAt = tombstoneAt;
    });
  } catch (error) {
    debugLog("warn", "interactive_spawn_tombstone_failed", {
      id: state.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function rollbackInteractiveSpawn(state: InteractiveSubagentState): void {
  state.completionPolicy = undefined;
  state.completionGroupId = undefined;
  try {
    cancelInteractiveSubagent(state.id, "cancel_interactive_subagent", state);
  } catch {
    /* Registration failed; pane cleanup is best effort. */
  }
  removeInteractiveSubagentState(state);
  if (state.parentSessionId) {
    try {
      removeInteractiveState(state.cwd, state.id);
    } catch {
      persistInteractiveRollbackTombstone(state);
    }
  }
}

export function findArtifactById(id: string): SubagentArtifact | null {
  // Sub-agent ids are historically 4 random bytes (8 hex chars) and currently
  // 8 random bytes (16 hex chars). Validate before joining into a path so that
  // an LLM-supplied id like "../../../etc" cannot escape the artifact root.
  // (path.join normalises "..", so a malicious id would otherwise resolve
  // to a sibling directory and get exfiltrated to the parent LLM via
  // read_subagent_artifact).
  if (!isValidSubagentId(id)) return null;

  const root =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    join(homedir(), ".pi", "agent", "sessions");
  // Resolve the root once, with symlinks followed, so the containment check below
  // is anchored on the real on-disk location. realpathSync throws if root doesn't
  // exist; in that case there's nothing for us to find.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  let topLevel: string[];
  try {
    topLevel = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of topLevel) {
    const candidate = join(root, entry, "artifacts", id);
    try {
      if (statSync(candidate).isDirectory()) {
        // statSync follows symlinks, so a symlink at
        // <root>/<cwd>/artifacts/<id> pointing outside the artifact root
        // would otherwise be returned as a valid artifact. Resolve the
        // candidate with realpath and verify it is still inside the
        // resolved root. realpathSync is safe here because statSync
        // above already confirmed candidate exists as a directory.
        let realCandidate: string;
        try {
          realCandidate = realpathSync(candidate);
        } catch {
          continue;
        }
        if (!isPathInside(realCandidate, realRoot)) continue;
        return artifactPath(join(root, entry, "artifacts"), id);
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

function getArtifactForState(
  state: Pick<InteractiveSubagentState, "artifactDir">,
): SubagentArtifact {
  return artifactPath(dirname(state.artifactDir), basename(state.artifactDir));
}

interface SelectedCompletion {
  turnId: string;
  protocolV2: boolean;
}

function completionForRead(
  art: SubagentArtifact,
  selector: { turn?: number; turnId?: string },
): SelectedCompletion | undefined {
  const completions: ReturnType<typeof readEventBatch>["records"] = [];
  const snapshotEndOffset = eventLogEndOffset(art);
  let cursor = 0;
  while (cursor < snapshotEndOffset) {
    const batch = readEventBatch(art, cursor);
    for (const record of batch.records) {
      if (record.endOffset > snapshotEndOffset) break;
      if (isCompletionEvent(record.event)) completions.push(record);
    }
    const nextOffset = batch.records.at(-1)?.endOffset ?? batch.endOffset;
    if (nextOffset <= cursor) break;
    cursor = Math.min(nextOffset, snapshotEndOffset);
  }
  const selected = selector.turnId
    ? completions.find(
        ({ event }) =>
          event.type === "completion" && event.turnId === selector.turnId,
      )
    : selector.turn !== undefined
      ? completions.filter(({ event }) => event.type === "done")[
          selector.turn - 1
        ]
      : completions.at(-1);
  if (!selected) return undefined;
  return selected.event.type === "completion"
    ? { turnId: selected.event.turnId, protocolV2: true }
    : { turnId: `legacy-${selected.startOffset}`, protocolV2: false };
}

function resolveInteractiveToolStates(token: SessionToolToken | undefined):
  | {
      scope?: SessionScope;
      states: Map<string, InteractiveSubagentState>;
    }
  | undefined {
  const scope = resolveToolSessionScope(token);
  if (scope) return { scope, states: scope.interactiveStates };
  if (!token && getStartedSessionScopes().length === 0) {
    return { states: interactiveSubagentRegistry };
  }
  return undefined;
}

function findOwnedDiskArtifact(
  cwd: string,
  id: string,
  scope: SessionScope | undefined,
): SubagentArtifact | null {
  if (!scope) return findArtifactById(id);
  let parentSessionId: string | undefined;
  try {
    parentSessionId = scope.sessionManager?.getSessionId?.();
  } catch {
    return null;
  }
  if (!parentSessionId) return null;
  const artifact = findArtifactById(id);
  if (!artifact) return null;
  try {
    const persistedOwner = readFileSync(
      join(artifact.dir, INTERACTIVE_ARTIFACT_OWNER_FILE),
      "utf8",
    );
    return persistedOwner === parentSessionId ? artifact : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    // Older artifacts may still have exact evidence in the persisted state file.
  }
  const persisted = loadInteractiveStates(cwd)?.states[id];
  if (!persisted || persisted.parentSessionId !== parentSessionId) return null;
  try {
    return realpathSync(persisted.artifactDir) === realpathSync(artifact.dir)
      ? artifact
      : null;
  } catch {
    return null;
  }
}

export function registerInteractiveSubagentTools(
  pi: ExtensionAPI,
  registrationScope?: SessionScope,
): void {
  const toolToken: SessionToolToken | undefined = registrationScope
    ? { id: registrationScope.id }
    : undefined;
  // ── Tool 6: spawn an attachable mux-backed Pi session ──────────────
  registerToolWithDefaultGuidance(pi, {
    name: "subagent_interactive",
    label: "Interactive Subagent",
    description: [
      "Spawn a separate Pi process in a tmux/zellij pane and return immediately.",
      "Use this when the user wants to attach to the sub-agent session and continue follow-ups there.",
      "Works inside tmux or zellij. The tool returns attach/focus commands and the child session file.",
      "This is intentionally separate from SDK subagents: it favors observability and attachability over in-process execution.",
      "Completion coordination defaults to each: every terminal turn creates one TUI-only notice, while safely-idle results are coalesced into a compact immutable-reference manifest that resumes the parent.",
      "Use completionPolicy=group with a shared completionGroupId for related agents; the parent resumes once the spawning turn settles and every registered member is terminal.",
      "Human input takes priority, and successful read_subagent_artifact collection consumes the matching pending delivery.",
      "Deprecated notifyOnComplete and triggerTurnOnComplete inputs map to coordinated each delivery and cannot be combined with completionPolicy or completionGroupId.",
    ].join("\n"),
    parameters: InteractiveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registration = resolveInteractiveToolStates(toolToken);
      if (!registration) {
        return {
          content: [
            {
              type: "text",
              text: "This interactive tool registration is no longer attached to a live session.",
            },
          ],
          details: { status: "session_unavailable" },
          isError: true,
        };
      }
      if (
        registration.scope?.lineageMode === "child" &&
        !registration.scope.spawnTreeContext
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Recursive interactive spawning is disabled because this child has no explicit lineage bootstrap.",
            },
          ],
          details: { status: "lineage_unavailable" },
          isError: true,
        };
      }
      const routingMetadataError = validateInitialRoutingMetadata(
        params.routingDescription,
        params.routingAliases,
      );
      const topLevelOrchestratorV2 =
        registration.scope !== undefined &&
        process.env.PI_SUBAGENTURA_CHILD !== "1" &&
        isOrchestratorV2Enabled(pi);
      const routingModeError = validateRoutingMetadataMode(
        topLevelOrchestratorV2,
        params.routingDescription,
        params.routingAliases,
      );
      if (routingMetadataError || routingModeError) {
        const error = routingMetadataError ?? routingModeError!;
        return {
          content: [
            {
              type: "text",
              text: `Invalid initial routing metadata: ${error}`,
            },
          ],
          details: {
            status: "invalid_routing_metadata",
            error,
          },
          isError: true,
        };
      }
      const contextParams = params as typeof params & {
        includeContext?: boolean;
        context?: string;
      };
      if (
        contextParams.context !== undefined &&
        Buffer.byteLength(contextParams.context, "utf8") >
          MAX_INTERACTIVE_CONTEXT_BYTES
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Explicit context exceeds ${MAX_INTERACTIVE_CONTEXT_BYTES} bytes.`,
            },
          ],
          details: {
            status: "invalid_context",
            maxBytes: MAX_INTERACTIVE_CONTEXT_BYTES,
          },
          isError: true,
        };
      }
      let completion: ResolvedCompletionPolicy;
      try {
        if (
          !registration.scope &&
          (params.completionPolicy !== undefined ||
            params.completionGroupId !== undefined)
        ) {
          throw new Error(
            "completionPolicy and completionGroupId require a live parent session scope for coordinated delivery",
          );
        }
        completion = registration.scope
          ? resolveCompletionPolicy(params)
          : { legacy: true };
        if (registration.scope) {
          assertCompletionGroupOpen(
            completion.policy,
            completion.groupId,
            sessionOwner(registration.scope),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: `Sub-agent not started: ${message}` },
          ],
          details: { status: "error", error: message },
          isError: true,
        };
      }
      const completionMode = params.notifyOnComplete ?? "notify";
      const triggerTurn = completionTriggersTurn(
        completionMode,
        params.triggerTurnOnComplete ?? true,
      );
      let completionReservation: CompletionGroupReservation | undefined;
      if (registration.scope) {
        try {
          completionReservation = reserveCompletionGroup(
            completion.policy,
            completion.groupId,
            sessionOwner(registration.scope),
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Sub-agent not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
      }
      debugLog("info", "tool_call", {
        toolName: "subagent_interactive",
        toolCallId: _toolCallId,
        taskLength: params.task?.length ?? 0,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        includeContext: contextParams.includeContext ?? false,
        notifyOnComplete: completion.legacy ? completionMode : null,
        triggerTurnOnComplete: completion.legacy ? triggerTurn : null,
        completionPolicy: completion.policy ?? "legacy",
        completionGroupId: completion.groupId ?? null,
      });

      let contextText: string | null =
        contextParams.includeContext === false
          ? (contextParams.context ?? null)
          : null;
      let authorityEntries: readonly unknown[] | undefined;
      if (contextParams.includeContext === true) {
        const branch = ctx.sessionManager.getBranch();
        authorityEntries = branch;
        const messages = branch
          .filter(
            (e): e is typeof e & { type: "message" } => e.type === "message",
          )
          .map((e) => e.message);
        contextText = serializeConversation(convertToLlm(messages));
      } else if (topLevelOrchestratorV2) {
        authorityEntries = parentBranchEntries(ctx);
      }

      const taskPreview = params.task.replace(/\s+/g, " ").slice(0, 48);
      const name = params.name ?? `Subagent: ${taskPreview || "interactive"}`;
      const targetCwd = params.cwd ?? ctx.cwd;

      try {
        const state = launchInteractiveSubagent({
          name,
          task: params.task,
          persona: params.persona,
          model: params.model,
          cwd: targetCwd,
          contextText,
          background: params.background, // defaults to true (hidden) inside the helper
          notifyOnComplete: completion.legacy ? completionMode : undefined,
          triggerTurnOnComplete: completion.legacy ? triggerTurn : undefined,
          completionPolicy: completion.policy,
          completionGroupId: completion.groupId,
          muxPreference: params.mux, // pass through user's mux preference
          parentCwd: ctx.cwd,
          parentSessionId: ctx.sessionManager.getSessionId(),
          thinkingLevel: params.thinkingLevel,
          sessionScope: registration.scope,
          spawnTreeContext: registration.scope?.spawnTreeContext,
        });
        if (registration.scope && completion.policy) {
          try {
            registerCompletionMember(
              "interactive",
              state.id,
              completion.policy,
              completion.groupId,
              sessionOwner(registration.scope),
              completionReservation,
            );
          } catch (error) {
            releaseCompletionGroup(completionReservation);
            rollbackInteractiveSpawn(state);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to start interactive sub-agent: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { status: "error", error: String(error) },
              isError: true,
            };
          }
        }
        const routingMetadata = persistInitialRoutingMetadata({
          cwd: ctx.cwd,
          childId: state.id,
          description: params.routingDescription,
          aliases: params.routingAliases,
          authorityEntries,
          pi,
        });
        updateRunningSubagentFooter(
          ctx.ui,
          registration.scope ? sessionOwner(registration.scope) : undefined,
        );

        const displayMode = state.windowName
          ? "background (new window/tab)"
          : "visible split";
        const locationLines = [`Artifact: ${state.artifactDir}`];
        if (!(state.mux === "tmux" && process.env.TMUX)) {
          locationLines.push(`Attach: ${state.attachCommand}`);
        }
        locationLines.push(`Focus: ${state.selectPaneCommand}`);
        locationLines.push(`Session: ${state.sessionFile}`);
        if (routingMetadata?.status === "warning") {
          locationLines.push(
            `Warning: initial routing metadata was not persisted: ${routingMetadata.error}`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Interactive sub-agent ${state.id} started (${displayMode}) in ${state.mux} pane ${state.paneId}.\n\n` +
                `${
                  completion.legacy
                    ? formatCompletionDeliveryBehavior(
                        completionMode,
                        triggerTurn,
                        "planned",
                      )
                    : completion.policy === "group"
                      ? `Completion will notify the user immediately and resume the parent once group ${completion.groupId} is sealed at parent settlement and all registered members finish.`
                      : "Completion will notify the user immediately and resume the parent with immutable result references when safely idle."
                }\n\n` +
                locationLines.join("\n"),
            },
          ],
          details: {
            ...state,
            status: "started",
            thinkingLevel: params.thinkingLevel,
            ...(routingMetadata === undefined ? {} : { routingMetadata }),
          },
        };
      } catch (error) {
        releaseCompletionGroup(completionReservation);
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to start interactive sub-agent: ${msg}\n${tmuxSetupHint()}`,
            },
          ],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const task = String(args.task ?? "");
      const preview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent_interactive ")) +
          theme.fg("accent", String(args.name ?? preview)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | (Partial<InteractiveSubagentState> & { thinkingLevel?: string })
        | undefined;
      const id = details?.id ?? "unknown";
      const paneId = details?.paneId ?? "unknown";
      const thinking = details?.thinkingLevel
        ? ` · thinking: ${details.thinkingLevel}`
        : "";
      if ((result as any).isError) {
        const first = result.content?.[0];
        const text =
          first?.type === "text"
            ? first.text
            : "Failed to start interactive sub-agent";
        return new Text(theme.fg("error", text), 0, 0);
      }
      return new Text(
        theme.fg("accent", "⚡ ") +
          theme.fg("toolTitle", `Interactive sub-agent ${id}`) +
          theme.fg("dim", ` — pane ${paneId}${thinking}`),
        0,
        0,
      );
    },
  });

  // ── Tool: explicitly recover a dead direct-interactive runtime ───────
  registerToolWithDefaultGuidance(pi, {
    name: "recover_interactive_subagent",
    label: "Recover Interactive Subagent",
    description: [
      "Recover a persisted direct interactive child after its tmux pane or Zellij tab was accidentally closed.",
      "This is incident recovery, not normal spawning or workflow reuse. The recorded pane must be conclusively dead,",
      "the current parent must still own the exact persisted session/artifact/lineage identity, and no duplicate runtime",
      "may reference the same child session. The operation shows a native user confirmation before creating a replacement",
      "pane and rebinds the same child ID without changing delivery cursors, receipts, artifacts, or routing authority.",
      "Workflow-origin children and in-process/background jobs are intentionally unsupported.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        pattern: "^(?:[a-f0-9]{8}|[a-f0-9]{16})$",
        description:
          "Persisted direct interactive child ID whose recorded pane is dead",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      const registration = resolveInteractiveToolStates(toolToken);
      const scope = registration?.scope;
      const state = registration?.states.get(params.id);
      if (!scope || !state) {
        return interactiveRecoveryError(
          params.id,
          "not_found",
          `Interactive sub-agent ${params.id} is not persisted in this parent session.`,
        );
      }
      let plan;
      try {
        plan = await inspectDirectInteractiveRecovery({
          state,
          scope,
          parentCwd: ctx.cwd,
        });
      } catch (error) {
        return interactiveRecoveryError(
          params.id,
          "preflight_failed",
          recoveryErrorMessage(error),
        );
      }
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Recover dead interactive sub-agent?",
          formatInteractiveRecoveryConfirmation(plan),
        );
      } catch (error) {
        return interactiveRecoveryError(
          params.id,
          "confirmation_unavailable",
          `Recovery requires an interactive confirmation UI: ${recoveryErrorMessage(error)}`,
        );
      }
      if (!confirmed) {
        return {
          content: [
            {
              type: "text",
              text: `Recovery cancelled for interactive sub-agent ${params.id}; no state was changed.`,
            },
          ],
          details: { status: "confirmation_declined", id: params.id },
        };
      }
      try {
        const recovered = await recoverDirectInteractiveSubagent({
          state,
          scope,
          parentCwd: ctx.cwd,
          expectedFingerprint: plan.fingerprint,
        });
        updateRunningSubagentFooter(ctx.ui, sessionOwner(scope));
        return {
          content: [
            {
              type: "text",
              text:
                `Recovered interactive sub-agent ${params.id} in ${recovered.mux} pane ${recovered.paneId} using Pi session ${plan.piSessionId}. ` +
                `The same child ID, artifacts, lineage, and delivery state were preserved. Wait until status is idle, then send an explicit child-ID follow-up.`,
            },
          ],
          details: {
            status: "recovered",
            id: params.id,
            piSessionId: plan.piSessionId,
            paneId: recovered.paneId,
            mux: recovered.mux,
            muxSession: recovered.muxSession,
            runtimeStatus: recovered.status,
            attachCommand: recovered.attachCommand,
            focusCommand: recovered.selectPaneCommand,
            sessionFile: recovered.sessionFile,
            artifactDir: recovered.artifactDir,
          },
        };
      } catch (error) {
        return interactiveRecoveryError(
          params.id,
          "recovery_failed",
          recoveryErrorMessage(error),
        );
      }
    },
  });

  // ── Tool 7: inspect attachable tmux-backed sessions ────────────────
  registerToolWithDefaultGuidance(pi, {
    name: "get_interactive_subagent_status",
    label: "Get Interactive Subagent Status",
    description:
      "Inspect tmux-backed interactive subagents. Omit jobId to list all tracked sessions. Returns attach/select commands and session paths without capturing pane output.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({
          description:
            "Interactive sub-agent ID returned by subagent_interactive",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      const registration = resolveInteractiveToolStates(toolToken);
      const visibleStates = registration?.states;
      if (visibleStates) {
        pruneDeadInteractiveSubagents(visibleStates.values());
        updateRunningSubagentFooter(
          ctx.ui,
          registration.scope ? sessionOwner(registration.scope) : undefined,
        );
      }
      const states = params.jobId
        ? [visibleStates?.get(params.jobId)].filter(
            (s): s is InteractiveSubagentState => Boolean(s),
          )
        : visibleStates
          ? [...visibleStates.values()]
          : [];

      if (states.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.jobId
                ? `Interactive sub-agent ${params.jobId} not found.`
                : "No interactive sub-agents are tracked.",
            },
          ],
          details: { status: "not_found", jobId: params.jobId },
          isError: Boolean(params.jobId),
        };
      }

      const sections = states.map((state) => {
        return formatInteractiveState(state);
      });

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: {
          count: states.length,
          subagents: states.map((state) => ({ ...state })),
        },
      };
    },
  });

  // ── Tool 8: cancel an attachable tmux-backed session ───────────────
  registerToolWithDefaultGuidance(pi, {
    name: "cancel_interactive_subagent",
    label: "Cancel Interactive Subagent",
    description:
      "Kill an interactive sub-agent pane and retain its cancelled artifact. Coordinated delivery still emits one TUI-only terminal notice and may later add a compact cancellation selector; the tool result does not inject a duplicate full-output cancellation message.",
    parameters: Type.Object({
      jobId: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      const registration = resolveInteractiveToolStates(toolToken);
      const ownedState = registration?.states.get(params.jobId);
      const state = ownedState
        ? cancelInteractiveSubagent(
            params.jobId,
            "cancel_interactive_subagent",
            ownedState,
          )
        : undefined;
      let userNotification: string;
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.jobId} not found.`,
            },
          ],
          details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }
      updateRunningSubagentFooter(
        ctx.ui,
        registration?.scope ? sessionOwner(registration.scope) : undefined,
      );
      const snapshotText = state.cancellationSnapshot?.path
        ? ` Snapshot ${state.cancellationSnapshot.status}: ${state.cancellationSnapshot.path}`
        : state.cancellationSnapshot?.error
          ? ` Snapshot error: ${state.cancellationSnapshot.error}`
          : "";
      userNotification =
        `Interactive sub-agent ${params.jobId} cancelled; coordinated delivery will use one TUI notice and, when eligible, one compact cancellation selector. ` +
        `Artifacts retained at ${state.artifactDir}.${snapshotText}`;
      try {
        ctx.ui.notify(userNotification, "warning");
      } catch {
        /* cancellation succeeded; a stale UI must not turn it into a tool failure */
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Interactive sub-agent ${params.jobId} cancelled. ` +
              `Coordinated delivery will use one TUI notice and, when eligible, one compact cancellation selector. ` +
              `Artifacts retained at ${state.artifactDir}.` +
              (state.cancellationSnapshot?.path
                ? ` Snapshot ${state.cancellationSnapshot.status}: ${state.cancellationSnapshot.path}.`
                : state.cancellationSnapshot?.error
                  ? ` Snapshot error: ${state.cancellationSnapshot.error}.`
                  : ""),
          },
        ],
        details: { ...state },
      };
    },
  });

  // ── Tool: send a follow-up message to a live interactive sub-agent ──────
  // The child REPL stays open after `done` (see buildChildSubagentProtocol in
  // interactive-tmux.ts), so the parent can push a new prompt into the same
  // session via tmux send-keys. Model context is preserved across messages —
  // this is a true follow-up turn, not a fresh spawn.
  //
  // Caps: the message must be non-empty (an empty Enter in the REPL would submit a
  // blank prompt) and at most MAX_FOLLOWUP_BYTES UTF-8 bytes (symmetric with
  // MAX_PERSONA_BYTES in interactive-tmux.ts — 64 KiB is well above any realistic
  // follow-up prompt; larger values are rejected up-front with a structured error).
  registerToolWithDefaultGuidance(pi, {
    name: "send_interactive_subagent_message",
    label: "Send Interactive Subagent Message",
    description: [
      "Send a follow-up prompt to a live interactive sub-agent. The message is delivered into the",
      "child's existing REPL via tmux send-keys, so the child's model context is preserved — this",
      "is a true follow-up turn, not a fresh spawn. An opted-in reusable workflow child accepts a follow-up",
      "only after its completed turn is idle and its workflow runner has consumed the result. It is",
      "promoted to standalone only after that follow-up is sent successfully. An idle follow-up resets",
      "future completion delivery to independent each; a source can satisfy a group only once, so later",
      "turns from that source/group are also independent. The child will run the new turn and (per its",
      "system prompt) call '$ARTIFACT_DIR/cli.mjs done 0' again when it finishes. Use",
      "get_interactive_subagent_status to check the pane state first if you're not sure it's still alive.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
      message: Type.String({
        description:
          "The follow-up prompt text to send into the child's REPL (must be non-empty; max 64 KiB)",
      }),
    }),

    async execute(_toolCallId, params): Promise<any> {
      // Validate the id shape first for a precise error.
      if (!isValidSubagentId(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 8 or 16 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      // Content validation (no registry I/O): fail fast on empty / oversized messages.
      // An empty message would submit a blank Enter in the child REPL; an oversized message
      // is more than the child can usefully consume and risks blowing the REPL history.
      if (params.message.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Message is empty; send a non-empty follow-up prompt.",
            },
          ],
          details: { id: params.id, status: "empty_message", messageLength: 0 },
          isError: true,
        };
      }
      const messageBytes = Buffer.byteLength(params.message, "utf8");
      if (messageBytes > MAX_FOLLOWUP_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `Message too large: ${messageBytes} bytes (max ${MAX_FOLLOWUP_BYTES}). Shorten the prompt and try again.`,
            },
          ],
          details: {
            id: params.id,
            status: "message_too_large",
            messageLength: messageBytes,
            maxBytes: MAX_FOLLOWUP_BYTES,
          },
          isError: true,
        };
      }
      const registration = resolveInteractiveToolStates(toolToken);
      const state = registration?.states.get(params.id);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} not found.`,
            },
          ],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      if (isReusableWorkflowChildExpired(state)) {
        const disposed = disposeWorkflowInteractiveSubagent(state);
        return {
          content: [
            {
              type: "text",
              text: disposed
                ? `Interactive sub-agent ${params.id} exceeded its reusable workflow-child retention deadline and was disposed.`
                : `Interactive sub-agent ${params.id} exceeded its reusable workflow-child retention deadline; disposal failed and will be retried.`,
            },
          ],
          details: {
            id: params.id,
            status: "workflow_reuse_expired",
            disposed,
          },
          isError: true,
        };
      }
      if (
        state.completionOwner === "workflow" &&
        (!state.workflowResultConsumed || state.status !== "idle")
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} is still under workflow ownership; its workflow must consume the current result and the pane must be idle before a follow-up can be sent.`,
            },
          ],
          details: { id: params.id, status: "workflow_owned" },
          isError: true,
        };
      }
      if (
        state.completionOwner === "workflow" &&
        state.workflowReusable !== true
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} was not opted in for workflow-child reuse and cannot be promoted.`,
            },
          ],
          details: { id: params.id, status: "workflow_not_reusable" },
          isError: true,
        };
      }
      // Standalone panes accept follow-ups while running or idle. Workflow ownership has two
      // independent release conditions: artifact polling folded the completion into idle, and the
      // workflow runner acknowledged returning that result.
      if (state.status !== "running" && state.status !== "idle") {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} is ${state.status}; follow-up messages can only be sent to running or idle sub-agents. Spawn a new one if needed.`,
            },
          ],
          details: { id: params.id, status: state.status },
          isError: true,
        };
      }
      // sendCommandToPane uses send-keys + Enter; it throws synchronously if the
      // pane is gone (e.g. the child exited between the status check and now).
      // Wrap so the parent gets a structured error instead of an exception trace.
      const startsNewTurn = state.status === "idle";
      try {
        sendCommandToPane(state, params.message + FOLLOWUP_COMPLETION_REMINDER);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message to interactive sub-agent ${params.id}: ${msg}`,
            },
          ],
          details: {
            id: params.id,
            status: "send_failed",
            paneId: state.paneId,
            error: msg,
          },
          isError: true,
        };
      }
      // Reaching the send proves both workflow release conditions held at the guard above.
      if (
        state.completionOwner === "workflow" &&
        state.workflowResultConsumed &&
        state.status === "idle"
      ) {
        state.completionOwner = "standalone";
        state.workflowId = undefined;
        state.workflowReuseExpiresAt = undefined;
      }
      let persistenceWarning: string | undefined;
      if (startsNewTurn) {
        state.completionPolicy = "each";
        state.completionGroupId = undefined;
        state.notifyOnComplete = undefined;
        state.triggerTurnOnComplete = undefined;
        if (state.parentSessionId) {
          try {
            updateInteractiveState(state.cwd, state.id, (entry) => {
              entry.completionPolicy = "each";
              delete entry.completionGroupId;
              delete entry.notifyOnComplete;
              delete entry.triggerTurnOnComplete;
            });
          } catch (error) {
            persistenceWarning =
              "The message was sent, but the new completion policy could not be persisted; reload may require manual recovery.";
            debugLog("warn", "interactive_followup_policy_persist_failed", {
              id: state.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      const messagePreview = formatFollowupPreview(params.message);
      const messageTruncated =
        params.message.length > MAX_FOLLOWUP_PREVIEW_CHARS;
      return {
        content: [
          {
            type: "text",
            text:
              `Sent follow-up to interactive sub-agent ${params.id} (${params.message.length} chars) in pane ${state.paneId}.` +
              `\n\nMessage sent:\n${messagePreview}` +
              (persistenceWarning ? `\n\nWarning: ${persistenceWarning}` : ""),
          },
        ],
        details: {
          id: params.id,
          ...(persistenceWarning ? { persistenceWarning } : {}),
          paneId: state.paneId,
          messageLength: params.message.length,
          messagePreview,
          messageTruncated,
          status: "sent",
        },
      };
    },
  });

  // ── Tool: read an interactive sub-agent's artifact ───────────────
  // Events and immutable terminal snapshots are authoritative. output.md remains
  // mutable staging for legacy or still-running artifacts only.
  registerToolWithDefaultGuidance(pi, {
    name: "read_subagent_artifact",
    label: "Read Subagent Artifact",
    description: [
      "Read an interactive sub-agent's artifact on disk. Returns lifecycle events and, by default,",
      "the latest terminal immutable protocol-v2 snapshot. Mutable output.md is used only when",
      "no protocol-v2 terminal snapshot applies, including legacy or still-running artifacts.",
      "Use `since` (unix ms) to fetch only events newer than your last read. Use `turnId` for a",
      "protocol-v2 Pi turn, or legacy numeric `turn` for an output-N.md snapshot.",
      "Returning a terminal output consumes its matching pending coordinated delivery so it is not sent again automatically; events-only reads do not consume it.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
      since: Type.Optional(
        Type.Number({
          description: "Only return events with ts >= this unix-ms timestamp",
        }),
      ),
      includeOutput: Type.Optional(
        Type.Boolean({
          description:
            "Include the output (default true). Set false to fetch only events.",
        }),
      ),
      turn: Type.Optional(
        Type.Number({
          description:
            "Read a specific turn's output-N.md snapshot. Omit to read the latest output.md.",
        }),
      ),
      turnId: Type.Optional(
        Type.String({
          maxLength: MAX_TURN_ID_LENGTH,
          description:
            "Read a protocol-v2 immutable output by its Pi-derived turnId (max 256 characters).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      // Validate the id shape FIRST so a malformed id gets a precise error
      // instead of being collapsed into the generic "not found" message.
      if (!isValidSubagentId(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 8 or 16 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      if (params.turn !== undefined && params.turnId !== undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Pass either turn or turnId, not both.",
            },
          ],
          details: { id: params.id, status: "invalid_selector" },
          isError: true,
        };
      }
      const registration = resolveInteractiveToolStates(toolToken);
      const state = registration?.states.get(params.id);
      const foreignInMemoryState =
        !state && interactiveSubagentRegistry.has(params.id);
      const art = state
        ? getArtifactForState(state)
        : registration && !foreignInMemoryState
          ? findOwnedDiskArtifact(ctx.cwd, params.id, registration.scope)
          : null;
      if (!art) {
        return {
          content: [
            {
              type: "text",
              text: `No artifact found for sub-agent ${params.id}.`,
            },
          ],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      const events = readEvents(art, params.since);
      // Historical selectors imply includeOutput: selecting a turn without its
      // immutable content would be surprising and provides no useful mapping.
      const wantsOutput =
        params.includeOutput !== false ||
        params.turn !== undefined ||
        params.turnId !== undefined;
      const selectedCompletion = wantsOutput
        ? completionForRead(art, params)
        : undefined;
      const output = wantsOutput
        ? params.turnId !== undefined
          ? readOutputForTurnId(art, params.turnId)
          : params.turn !== undefined
            ? readOutputForTurn(art, params.turn)
            : selectedCompletion?.protocolV2
              ? readOutputForTurnId(art, selectedCompletion.turnId)
              : readOutput(art)
        : null;
      const lastEventValue =
        events.length > 0 ? events[events.length - 1] : null;
      // Distinguish three cases when output is missing/empty so the caller
      // doesn't see a misleading "not written yet" after the sub-agent has
      // already exited (the common case: model finished without writing).
      let outputText: string;
      if (!wantsOutput) {
        outputText = "(not requested)";
      } else if (output === null) {
        if (params.turnId !== undefined) {
          outputText = `(no immutable snapshot for turnId ${params.turnId})`;
        } else if (params.turn !== undefined) {
          outputText = `(no snapshot for turn ${params.turn} — the poller may not have run yet, or this turn number is past the history)`;
        } else {
          const exited =
            lastEventValue && isArtifactOutputSettled(lastEventValue);
          outputText = exited
            ? `(sub-agent exited without writing output.md — last event: ${lastEventValue.type} @ ${lastEventValue.ts})`
            : `(${events.length} events, last: ${lastEventValue ? `${lastEventValue.type} @ ${lastEventValue.ts}` : "(none)"} — output.md not written yet)`;
        }
      } else if (output.length === 0) {
        outputText = "(empty — 0 chars)";
      } else {
        outputText = `${output.length} chars`;
      }
      // Available turns summary so the caller knows what history exists.
      const availableTurns = listOutputTurns(art);
      const outputHistory = listOutputHistory(art);
      const turnsLine =
        availableTurns.length > 0
          ? `Available turns: [${availableTurns.join(", ")}]\n`
          : "";
      const historyLine =
        outputHistory.length > 0
          ? `Protocol-v2 outputs: ${outputHistory
              .map(({ turnId, eventId }) => `${turnId} → ${eventId}`)
              .join(", ")}\n`
          : "";
      if (wantsOutput && output !== null && selectedCompletion) {
        consumeCompletionSource(
          pi,
          {
            source: "interactive",
            sourceId: params.id,
            turnId: selectedCompletion.turnId,
          },
          registration?.scope ? sessionOwner(registration.scope) : undefined,
        );
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Artifact for ${params.id} (${events.length} event${events.length === 1 ? "" : "s"}${params.since ? ` since ${params.since}` : ""}).\n` +
              `Last event: ${lastEventValue ? `${lastEventValue.type} @ ${lastEventValue.ts}` : "(none)"}\n` +
              (params.turn !== undefined
                ? `Reading turn: ${params.turn}\n`
                : "") +
              (params.turnId !== undefined
                ? `Reading turnId: ${params.turnId}\n`
                : "") +
              turnsLine +
              historyLine +
              `Output: ${outputText}` +
              (wantsOutput ? formatArtifactProviderOutput(output) : ""),
          },
        ],
        details: {
          id: params.id,
          artifactDir: art.dir,
          events,
          output,
          lastEvent: lastEventValue,
          availableTurns,
          outputHistory,
        },
      };
    },
  });

  // ── Tool: list known interactive sub-agent artifacts ─────────────
  registerToolWithDefaultGuidance(pi, {
    name: "list_subagent_artifacts",
    label: "List Subagent Artifacts",
    description: [
      "List interactive sub-agent artifacts visible to this parent session.",
      "Returns id, name, status, and last-update time. Use read_subagent_artifact",
      "to fetch a specific one.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<any> {
      const registration = resolveInteractiveToolStates(toolToken);
      const visibleStates = registration?.states;
      if (visibleStates) {
        pruneDeadInteractiveSubagents(visibleStates.values());
        updateRunningSubagentFooter(
          ctx.ui,
          registration.scope ? sessionOwner(registration.scope) : undefined,
        );
      }
      const states = visibleStates ? [...visibleStates.values()] : [];
      const summary = states.map((s) => {
        const art = getArtifactForState(s);
        const last = lastEvent(art);
        return {
          id: s.id,
          name: s.name,
          task: s.task,
          status: s.status,
          lastEvent: last,
          lastUpdate: last?.ts,
          artifactDir: s.artifactDir,
        };
      });
      if (summary.length === 0) {
        return {
          content: [
            { type: "text", text: "No interactive sub-agents are tracked." },
          ],
          details: { count: 0, subagents: [] },
        };
      }
      const lines = summary.map((s) => {
        const ev = s.lastEvent;
        const taskPreview = (s.task ?? "").replace(/\s+/g, " ").slice(0, 60);
        const evStr = ev
          ? `last: ${ev.type}${ev.message ? ` (${ev.message.slice(0, 60)})` : ""}`
          : "no events yet";
        return `${s.id}  ${s.name}  [${s.status}]  ${taskPreview} — ${evStr}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: summary.length, subagents: summary },
      };
    },
  });
}

function formatInteractiveRecoveryConfirmation(
  plan: Awaited<ReturnType<typeof inspectDirectInteractiveRecovery>>,
): string {
  return [
    `Child runtime ID: ${plan.childId}`,
    `Pi session ID: ${plan.piSessionId}`,
    `Backend / old pane: ${plan.mux} ${plan.oldPaneId}`,
    `Child cwd: ${plan.childCwd}`,
    `Session JSONL: ${plan.sessionFile}`,
    `Artifacts: ${plan.artifactDir}`,
    `Parent owner: ${plan.parentSessionId}`,
    `Lineage root: ${plan.lineageRootId}`,
    "",
    "A new pane/process will reopen the same Pi session and rebind only this dead direct child.",
    "Child ID, delivery cursors/receipts, artifacts, lineage, and routing authority remain unchanged.",
  ].join("\n");
}

function recoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interactiveRecoveryError(
  id: string,
  status:
    | "not_found"
    | "preflight_failed"
    | "confirmation_unavailable"
    | "recovery_failed",
  error: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Interactive sub-agent ${id} was not recovered: ${error}`,
      },
    ],
    details: { status, id, error },
    isError: true,
  };
}

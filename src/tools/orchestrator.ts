import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_ORCHESTRATOR_ROUTING_ALIASES,
  MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
  MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  listOrchestratorRoutingEntries,
  loadOrchestratorAgentRegistryView,
  upsertOrchestratorRoutingEntry,
  validateOrchestratorRoutingEntryInput,
  type OrchestratorRoutingEntry,
} from "../orchestrator-routing";
import { isOrchestratorV2WakeupMessage } from "../completion-turn";
import {
  resolveToolSessionScope,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";

const CHILD_ID_PATTERN = "^(?:[a-f0-9]{8}|[a-f0-9]{16})$";
const CONFIRMATION_TOKEN_PREFIX = "orchestrator-confirm:";
const CONFIRMATION_TOKEN_MAX_BYTES = 128;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 32;

interface PendingConfirmation {
  childId: string;
  payload: string;
  generation: number;
  issuedAfterUserEntryId?: string;
  createdAt: number;
}

const pendingConfirmations = new WeakMap<
  SessionScope,
  Map<string, PendingConfirmation>
>();

const ListOrchestratorAgentsParams = Type.Object({});

const UpdateOrchestratorAgentDescriptionParams = Type.Object({
  childId: Type.String({
    pattern: CHILD_ID_PATTERN,
    description:
      "Interactive child ID whose confirmed routing metadata changes",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
    description: "Confirmed responsibility description for routing decisions",
  }),
  aliases: Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        maxLength: MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
      }),
      {
        maxItems: MAX_ORCHESTRATOR_ROUTING_ALIASES,
        description: "Optional confirmed exact aliases",
      },
    ),
  ),
  provenance: Type.Union([
    Type.Literal("user"),
    Type.Literal("orchestratorv2"),
  ]),
  confirmed: Type.Boolean({
    description:
      "False requests a server-issued token. True applies the exact pending update only after a later user message contains that token.",
  }),
  confirmationToken: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: CONFIRMATION_TOKEN_MAX_BYTES,
      description:
        "Server-issued token for this exact update. The latest user message must contain it before confirmed=true succeeds.",
    }),
  ),
});

export function registerOrchestratorTools(
  pi: ExtensionAPI,
  registrationScope?: SessionScope,
): void {
  const toolToken: SessionToolToken | undefined = registrationScope
    ? { id: registrationScope.id }
    : undefined;

  pi.registerTool({
    name: "list_orchestrator_agents",
    label: "List Orchestrator Agents",
    description:
      "List the bounded Orchestratorv2 routing overlay joined to this parent session's current interactive runtimes. Returns metadata, status, liveness, attach/focus commands, and artifact pointers without child transcripts or output.",
    parameters: ListOrchestratorAgentsParams,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const scope = resolveToolSessionScope(toolToken);
      if (!scope) return sessionUnavailableResult();
      try {
        const projection = await loadOrchestratorAgentRegistryView(
          ctx.cwd,
          scope.interactiveStates,
          { signal },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(projection, null, 2),
            },
          ],
          details: { status: "ok", ...projection },
        };
      } catch (error) {
        return routingErrorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "update_orchestrator_agent_description",
    label: "Update Orchestrator Agent Description",
    description:
      "Persist a confirmed responsibility description, exact aliases, and provenance for an interactive child owned by this parent session.",
    parameters: UpdateOrchestratorAgentDescriptionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolSessionScope(toolToken);
      if (!scope) return sessionUnavailableResult();
      if (!scope.interactiveStates.has(params.childId)) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive child ${params.childId} has no actionable runtime in this parent session.`,
            },
          ],
          details: {
            status: "not_actionable",
            childId: params.childId,
            reason: "runtime_missing_in_current_session",
          },
          isError: true,
        };
      }

      let existing: OrchestratorRoutingEntry | undefined;
      try {
        existing = listOrchestratorRoutingEntries(ctx.cwd).find(
          (entry) => entry.childId === params.childId,
        );
      } catch (error) {
        return routingErrorResult(error);
      }
      const effectiveAliases =
        params.aliases === undefined
          ? optionalAliases(existing).aliases
          : params.aliases;
      try {
        validateOrchestratorRoutingEntryInput({
          childId: params.childId,
          description: params.description,
          ...(effectiveAliases === undefined
            ? {}
            : { aliases: effectiveAliases }),
          provenance: params.provenance,
        });
      } catch (error) {
        return routingErrorResult(error);
      }
      const confirmation = confirmOrRequestChange({
        scope,
        ctx,
        childId: params.childId,
        payload: JSON.stringify({
          description: params.description,
          aliases: effectiveAliases,
          provenance: params.provenance,
          priorEntry: existing,
        }),
        confirmed: params.confirmed,
        confirmationToken: params.confirmationToken,
      });
      if (!confirmation.ok) return confirmation.response;

      try {
        const overlay = upsertOrchestratorRoutingEntry(
          ctx.cwd,
          {
            childId: params.childId,
            description: params.description,
            ...(effectiveAliases === undefined
              ? {}
              : { aliases: effectiveAliases }),
            provenance: params.provenance,
          },
          {
            expectedEntry: existing,
          },
        );
        const entry = overlay.records.find(
          (record) => record.childId === params.childId,
        );
        if (!entry)
          throw new Error("routing metadata update was not persisted");
        consumePendingConfirmation(scope, confirmation.token);
        return {
          content: [
            {
              type: "text",
              text: `Updated confirmed routing metadata for interactive child ${params.childId}.`,
            },
          ],
          details: { status: "updated", entry },
        };
      } catch (error) {
        return routingErrorResult(error);
      }
    },
  });
}

function confirmationMap(
  scope: SessionScope,
): Map<string, PendingConfirmation> {
  let entries = pendingConfirmations.get(scope);
  if (!entries) {
    entries = new Map();
    pendingConfirmations.set(scope, entries);
  }
  return entries;
}

function prunePendingConfirmations(
  entries: Map<string, PendingConfirmation>,
  now: number,
): void {
  for (const [token, pending] of entries) {
    if (now - pending.createdAt > CONFIRMATION_TTL_MS) entries.delete(token);
  }
}

function confirmOrRequestChange(params: {
  scope: SessionScope;
  ctx: unknown;
  childId: string;
  payload: string;
  confirmed: boolean;
  confirmationToken?: string;
}):
  | { ok: true; token: string }
  | {
      ok: false;
      response:
        | ReturnType<typeof confirmationRequiredResult>
        | ReturnType<typeof confirmationErrorResult>;
    } {
  const entries = confirmationMap(params.scope);
  const now = Date.now();
  prunePendingConfirmations(entries, now);
  if (!params.confirmed) {
    while (entries.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) break;
      entries.delete(oldest);
    }
    const confirmationToken = `${CONFIRMATION_TOKEN_PREFIX}${randomUUID()}`;
    entries.set(confirmationToken, {
      childId: params.childId,
      payload: params.payload,
      generation: params.scope.generation,
      issuedAfterUserEntryId: latestUserMessage(params.ctx)?.id,
      createdAt: now,
    });
    return {
      ok: false,
      response: confirmationRequiredResult(params.childId, confirmationToken),
    };
  }

  const token = params.confirmationToken;
  const pending = token ? entries.get(token) : undefined;
  if (
    !token ||
    !pending ||
    pending.childId !== params.childId ||
    pending.payload !== params.payload ||
    pending.generation !== params.scope.generation
  ) {
    return {
      ok: false,
      response: confirmationErrorResult(
        "confirmation_invalid",
        params.childId,
        "No matching pending confirmation exists for this exact change.",
      ),
    };
  }

  const userMessage = latestUserMessage(params.ctx);
  if (
    !userMessage ||
    userMessage.id === pending.issuedAfterUserEntryId ||
    !userMessage.text.includes(token)
  ) {
    return {
      ok: false,
      response: confirmationErrorResult(
        "user_confirmation_required",
        params.childId,
        `A later user message must contain the exact token ${token}.`,
      ),
    };
  }
  return { ok: true, token };
}

function consumePendingConfirmation(scope: SessionScope, token: string): void {
  pendingConfirmations.get(scope)?.delete(token);
}

function latestUserMessage(
  ctx: unknown,
): { id: string; text: string } | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!sessionManager || typeof sessionManager !== "object") return undefined;
  const getBranch = (sessionManager as { getBranch?: unknown }).getBranch;
  if (typeof getBranch !== "function") return undefined;
  let branch: unknown;
  try {
    branch = getBranch.call(sessionManager);
  } catch {
    return undefined;
  }
  if (!Array.isArray(branch)) return undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; type?: unknown; message?: unknown };
    if (record.type !== "message" || typeof record.id !== "string") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const userMessage = message as { role?: unknown; content?: unknown };
    if (userMessage.role !== "user") continue;
    const text = textContent(userMessage.content);
    if (isOrchestratorV2WakeupMessage(text)) continue;
    return { id: record.id, text };
  }
  return undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function confirmationRequiredResult(
  childId: string,
  confirmationToken: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `User confirmation is required. Show the exact update and ask the user to send ${confirmationToken}; then retry the identical payload with confirmed=true and confirmationToken.`,
      },
    ],
    details: {
      status: "confirmation_required",
      childId,
      confirmationToken,
    },
    isError: true,
  };
}

function confirmationErrorResult(
  status: "confirmation_invalid" | "user_confirmation_required",
  childId: string,
  message: string,
) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { status, childId },
    isError: true,
  };
}

function optionalAliases(
  entry: OrchestratorRoutingEntry | undefined,
): { aliases: string[] } | Record<string, never> {
  return entry?.aliases === undefined ? {} : { aliases: [...entry.aliases] };
}

function sessionUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: "This orchestrator tool registration is no longer attached to a live session.",
      },
    ],
    details: { status: "session_unavailable" },
    isError: true,
  };
}

function routingErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `Orchestrator routing metadata error: ${message}`,
      },
    ],
    details: { status: "routing_metadata_error", error: message },
    isError: true,
  };
}

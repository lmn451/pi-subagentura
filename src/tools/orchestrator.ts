import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_ORCHESTRATOR_ROUTING_ALIASES,
  MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
  MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  listOrchestratorRoutingEntries,
  loadOrchestratorAgentRegistryView,
  removeOrchestratorRoutingEntry,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../orchestrator-routing";
import {
  resolveToolSessionScope,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";

const CHILD_ID_PATTERN = "^[a-f0-9]{16}$";
const CONFIRMATION_TOKEN_PREFIX = "orchestrator-confirm:";
const CONFIRMATION_TOKEN_MAX_BYTES = 128;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 32;

type ConfirmationAction = "update" | "remove";

interface PendingConfirmation {
  action: ConfirmationAction;
  childId: string;
  payload: string;
  generation: number;
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
  provenance: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("luna")]),
  ),
  confirmed: Type.Boolean({
    description:
      "False requests a server-issued confirmation token. True applies the exact pending update only after the latest user message contains that token.",
  }),
  confirmationToken: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: CONFIRMATION_TOKEN_MAX_BYTES,
      description:
        "Server-issued token from the pending update. The latest user message must contain it before confirmed=true succeeds.",
    }),
  ),
});

const RemoveOrchestratorAgentDescriptionParams = Type.Object({
  childId: Type.String({
    pattern: CHILD_ID_PATTERN,
    description: "Interactive child ID whose routing metadata is removed",
  }),
  confirmed: Type.Boolean({
    description:
      "False requests a server-issued confirmation token. True removes the exact pending entry only after the latest user message contains that token.",
  }),
  confirmationToken: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: CONFIRMATION_TOKEN_MAX_BYTES,
      description:
        "Server-issued token from the pending removal. The latest user message must contain it before confirmed=true succeeds.",
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
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const scope = resolveToolSessionScope(toolToken);
      if (!scope) return sessionUnavailableResult();
      try {
        const projection = await loadOrchestratorAgentRegistryView(
          ctx.cwd,
          scope.interactiveStates,
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

      const confirmation = confirmOrRequestChange({
        scope,
        ctx,
        action: "update",
        childId: params.childId,
        payload: JSON.stringify({
          description: params.description,
          aliases: params.aliases,
          provenance: params.provenance,
        }),
        confirmed: params.confirmed,
        confirmationToken: params.confirmationToken,
      });
      if (confirmation) return confirmation;

      try {
        const existing = listOrchestratorRoutingEntries(ctx.cwd).find(
          (entry) => entry.childId === params.childId,
        );
        const overlay = upsertOrchestratorRoutingEntry(ctx.cwd, {
          childId: params.childId,
          description: params.description,
          ...(params.aliases === undefined
            ? optionalAliases(existing)
            : { aliases: params.aliases }),
          ...(params.provenance === undefined
            ? optionalProvenance(existing)
            : { provenance: params.provenance }),
        });
        const entry = overlay.records.find(
          (record) => record.childId === params.childId,
        );
        if (!entry)
          throw new Error("routing metadata update was not persisted");
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

  pi.registerTool({
    name: "remove_orchestrator_agent_description",
    label: "Remove Orchestrator Agent Description",
    description:
      "Remove one confirmed routing metadata entry so stale records can be retired and capacity recovered. This does not cancel or delete an interactive child.",
    parameters: RemoveOrchestratorAgentDescriptionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveToolSessionScope(toolToken);
      if (!scope) return sessionUnavailableResult();
      try {
        const existing = listOrchestratorRoutingEntries(ctx.cwd).find(
          (entry) => entry.childId === params.childId,
        );
        if (!existing) return routingEntryNotFoundResult(params.childId);
        const confirmation = confirmOrRequestChange({
          scope,
          ctx,
          action: "remove",
          childId: params.childId,
          payload: JSON.stringify(existing),
          confirmed: params.confirmed,
          confirmationToken: params.confirmationToken,
        });
        if (confirmation) return confirmation;
        const entry = removeOrchestratorRoutingEntry(ctx.cwd, params.childId);
        if (!entry) return routingEntryNotFoundResult(params.childId);
        return {
          content: [
            {
              type: "text",
              text: `Removed confirmed routing metadata for interactive child ${params.childId}.`,
            },
          ],
          details: { status: "removed", entry },
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
  action: ConfirmationAction;
  childId: string;
  payload: string;
  confirmed: boolean;
  confirmationToken?: string;
}) {
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
      action: params.action,
      childId: params.childId,
      payload: params.payload,
      generation: params.scope.generation,
      createdAt: now,
    });
    return confirmationRequiredResult(
      params.action,
      params.childId,
      confirmationToken,
    );
  }

  const token = params.confirmationToken;
  const pending = token ? entries.get(token) : undefined;
  if (
    !token ||
    !pending ||
    pending.action !== params.action ||
    pending.childId !== params.childId ||
    pending.payload !== params.payload ||
    pending.generation !== params.scope.generation
  ) {
    return confirmationErrorResult(
      "confirmation_invalid",
      params.action,
      params.childId,
      "No matching pending confirmation exists for this exact change.",
    );
  }

  const userText = latestUserMessageText(params.ctx);
  if (!userText?.includes(token)) {
    return confirmationErrorResult(
      "user_confirmation_required",
      params.action,
      params.childId,
      `The latest user message must contain the exact token ${token}.`,
    );
  }
  entries.delete(token);
  return undefined;
}

function latestUserMessageText(ctx: unknown): string | undefined {
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
    const record = entry as { type?: unknown; message?: unknown };
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const userMessage = message as { role?: unknown; content?: unknown };
    if (userMessage.role !== "user") continue;
    return textContent(userMessage.content);
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
  action: ConfirmationAction,
  childId: string,
  confirmationToken: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `User confirmation is required. Ask the user to send the exact token ${confirmationToken}, then retry this exact ${action} with confirmed=true and confirmationToken.`,
      },
    ],
    details: {
      status: "confirmation_required",
      action,
      childId,
      confirmationToken,
    },
    isError: true,
  };
}

function confirmationErrorResult(
  status: "confirmation_invalid" | "user_confirmation_required",
  action: ConfirmationAction,
  childId: string,
  message: string,
) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { status, action, childId },
    isError: true,
  };
}

function routingEntryNotFoundResult(childId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `No routing metadata exists for interactive child ${childId}.`,
      },
    ],
    details: { status: "not_found", childId },
    isError: true,
  };
}

function optionalAliases(
  entry: OrchestratorRoutingEntry | undefined,
): { aliases: string[] } | Record<string, never> {
  return entry?.aliases === undefined ? {} : { aliases: [...entry.aliases] };
}

function optionalProvenance(
  entry: OrchestratorRoutingEntry | undefined,
): { provenance: "user" | "luna" } | Record<string, never> {
  return entry?.provenance === undefined
    ? {}
    : { provenance: entry.provenance };
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_ORCHESTRATOR_ROUTING_ALIASES,
  MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
  MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  listOrchestratorRoutingEntries,
  loadOrchestratorAgentRegistryView,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../orchestrator-routing";
import {
  resolveToolSessionScope,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";

const CHILD_ID_PATTERN = "^[a-f0-9]{16}$";

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
  confirmed: Type.Literal(true, {
    description:
      "Must be true after the user or Luna has confirmed this metadata update",
  }),
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

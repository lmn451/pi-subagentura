import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  MAX_ORCHESTRATOR_ROUTING_ALIASES,
  MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
  MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
} from "./orchestrator-routing";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const MAX_INTERACTIVE_CONTEXT_BYTES = 64 * 1024;

function thinkingLevelSchema(description: string) {
  return StringEnum(THINKING_LEVELS, { description });
}

export const BaseParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the sub-agent" }),
  persona: Type.Optional(
    Type.String({
      description:
        "Optional persona / system prompt (e.g. 'You are a senior TypeScript reviewer')",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override model (e.g. 'anthropic/claude-sonnet-4-5'). Default: inherit from current session.",
    }),
  ),
  thinkingLevel: Type.Optional(
    thinkingLevelSchema(
      'Thinking/reasoning level. Default: from settings, else "medium". Higher levels use more tokens. Clamped to model capabilities automatically.',
    ),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory (default: current cwd)",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Run subagent in background. DEFAULT: true — fan-out and long-running work must not block the parent turn. Returns a jobId immediately; coordinated completion publishes a TUI-only notice and later resumes the parent with a compact retrieval reference. Pass async: false ONLY for a single short sub-agent whose answer you need inline before continuing. Async keeps the parent responsive but does NOT by itself prevent nested fan-out — depth is capped separately.",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union(
      [
        Type.Literal("notify", {
          description:
            "Deprecated compatibility value. Maps to coordinated each delivery with a TUI-only notice and compact references.",
        }),
        Type.Literal("inject", {
          description:
            "Deprecated compatibility value. Maps to coordinated each delivery and never injects full output.",
        }),
      ],
      {
        description:
          "Deprecated compatibility payload mode. Either value maps to coordinated each delivery and cannot be combined with completionPolicy or completionGroupId.",
      },
    ),
  ),
  triggerTurnOnComplete: Type.Optional(
    Type.Boolean({
      description:
        "Deprecated compatibility input. Coordinated policy/barrier and human-priority timing are authoritative; cannot be combined with completionPolicy or completionGroupId.",
    }),
  ),
  completionPolicy: Type.Optional(
    Type.Union([Type.Literal("each"), Type.Literal("group")], {
      description:
        'Completion coordination policy for background work. "each" resumes the parent for ready independent work (coalesced while busy). "group" waits for every explicitly registered member sharing completionGroupId after the spawning parent turn settles. Defaults to "each"; sync sub-agent calls reject completionPolicy/completionGroupId.',
    }),
  ),
  completionGroupId: Type.Optional(
    Type.String({
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
      description:
        'Required with completionPolicy="group". Explicit identifier shared by related jobs. Safe 1–128 character IDs only; at most 32 members per group and 512 groups per parent session.',
    }),
  ),
  maxAge: Type.Optional(
    Type.Number({
      description:
        "Optional TTL in milliseconds for completed job retention. Jobs persist indefinitely if omitted.",
    }),
  ),
});

export const StatusParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

export const ResultParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Explicitly wait for a running job. Set true ONLY when the user asks to wait. Otherwise running jobs return immediately and continue in the background.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 300_000,
      description:
        "Maximum explicit wait in milliseconds. Defaults to 30000. A timeout does not cancel the job.",
    }),
  ),
});

export const CancelParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const InteractiveSpawnFields = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Display name for the sub-agent session. Defaults to a task preview.",
    }),
  ),
  task: Type.String({
    description: "Task to start in the interactive sub-agent",
  }),
  persona: Type.Optional(
    Type.String({
      description:
        "Optional persona / system prompt appended to the child Pi session",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional model override for the child Pi process",
    }),
  ),
  thinkingLevel: Type.Optional(
    thinkingLevelSchema(
      'Thinking/reasoning level for the child Pi process. Default: from settings, else "medium". Clamped to model capabilities.',
    ),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the child Pi process" }),
  ),
  routingDescription: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
      description:
        "Optional initial responsibility description persisted for Orchestratorv2 routing after the child starts.",
    }),
  ),
  routingAliases: Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        maxLength: MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
      }),
      {
        maxItems: MAX_ORCHESTRATOR_ROUTING_ALIASES,
        description:
          "Optional exact aliases persisted with the initial Orchestratorv2 routing description. Requires routingDescription.",
      },
    ),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Spawn the sub-agent in a detached named window (hidden from your mux layout) instead of a visible horizontal split. Default true. Pass background: false for a side-by-side split you can watch in real time.",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union([Type.Literal("notify"), Type.Literal("inject")], {
      description:
        "Deprecated compatibility mode. Either value maps to coordinated each delivery with TUI-only notice and compact references; cannot be combined with completionPolicy or completionGroupId.",
    }),
  ),
  triggerTurnOnComplete: Type.Optional(
    Type.Boolean({
      description:
        "Deprecated compatibility input. Coordinated policy/barrier and human-priority timing are authoritative; cannot be combined with completionPolicy or completionGroupId.",
    }),
  ),
  completionPolicy: Type.Optional(
    Type.Union([Type.Literal("each"), Type.Literal("group")], {
      description:
        'Completion coordination policy for background work. "each" resumes the parent for ready independent work (coalesced while busy). "group" waits for every explicitly registered member sharing completionGroupId after the spawning parent turn settles. Defaults to "each"; sync sub-agent calls reject completionPolicy/completionGroupId.',
    }),
  ),
  completionGroupId: Type.Optional(
    Type.String({
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
      description:
        'Required with completionPolicy="group". Explicit identifier shared by related agents. Safe 1–128 character IDs only; at most 32 members per group and 512 groups per parent session.',
    }),
  ),
  mux: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("tmux"),
        Type.Literal("zellij"),
        Type.Literal("herdr"),
      ],
      {
        description:
          'Which multiplexer backend to use. "auto" (default) picks based on environment: Herdr if HERDR_ENV=1, zellij if ZELLIJ_SESSION_NAME is set, tmux if TMUX is set, then an available detached-session backend. An explicit value forces that backend.',
      },
    ),
  ),
});
Object.assign(InteractiveSpawnFields, {
  dependentRequired: { routingAliases: ["routingDescription"] },
});

const InteractiveContextMode = Type.Union([
  Type.Object(
    {
      includeContext: Type.Literal(true, {
        description:
          "Serialize the full parent conversation branch into the initial child prompt.",
      }),
    },
    { not: { required: ["context"] } },
  ),
  Type.Object({
    includeContext: Type.Literal(false, {
      description:
        "Keep the child independent unless an explicit context handoff is supplied.",
    }),
    context: Type.Optional(
      Type.String({
        maxLength: MAX_INTERACTIVE_CONTEXT_BYTES,
        description:
          "Explicit handoff/context passed directly to the initial child prompt.",
      }),
    ),
  }),
  Type.Object(
    {},
    {
      description:
        "Legacy default with neither parent-branch nor explicit context fields.",
      not: {
        anyOf: [{ required: ["includeContext"] }, { required: ["context"] }],
      },
    },
  ),
]);

const InteractiveProviderFields = Type.Object({
  ...InteractiveSpawnFields.properties,
  includeContext: Type.Optional(
    Type.Boolean({
      description:
        "Whether to serialize the parent branch. False permits an explicit context handoff; true forbids one.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      maxLength: MAX_INTERACTIVE_CONTEXT_BYTES,
      description:
        "Explicit handoff/context, permitted only when includeContext is false.",
    }),
  ),
});

function exposeProviderObjectShape<T extends object>(
  validationSchema: T,
  providerShape: typeof InteractiveProviderFields,
): T {
  // Pi 0.80.6's Anthropic adapter projects only these top-level keywords.
  // Keep allOf/anyOf on the returned schema so TypeBox validation stays strict.
  return {
    ...validationSchema,
    type: providerShape.type,
    properties: providerShape.properties,
    required: providerShape.required,
  };
}

export const InteractiveParams = exposeProviderObjectShape(
  Type.Intersect([InteractiveSpawnFields, InteractiveContextMode], {
    unevaluatedProperties: false,
  }),
  InteractiveProviderFields,
);

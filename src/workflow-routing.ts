export type WorkflowEagerMode = "off" | "preferred" | "always";
export const WORKFLOW_EAGER_DEFAULT: WorkflowEagerMode = "off";
export type WorkflowRoutingDecision =
  | { kind: "direct"; reason: string }
  | {
      kind: "durable_plan";
      reason: string;
      mode: WorkflowEagerMode;
      enforcement?: "host-enforced" | "model-policy";
      independentSlices?: number;
    };

export interface WorkflowRoutingInput {
  mode: WorkflowEagerMode;
  text: string;
  /**
   * Context gates are supplied by the host when it has authoritative state.
   * The text classifier remains conservative when a gate is omitted.
   */
  hasActiveWorkflow?: boolean;
  awaitingUserInput?: boolean;
  childContext?: boolean;
  managementCommand?: boolean;
  planOnly?: boolean;
  socialConversation?: boolean;
  question?: boolean;
  oneCommand?: boolean;
  /** Number of independent agent-worthy slices identified by a bounded planner. */
  independentSlices?: number;
  /** True when the request explicitly needs phased continuation. */
  phasedContinuation?: boolean;
  /**
   * Whether the host can force a workflow tool call in this turn. Undefined
   * preserves the legacy pure-decision shape for callers that only classify.
   */
  hostHookAvailable?: boolean;
  /** Set by a host observer once direct side effects have started. */
  directWorkStarted?: boolean;
}

export interface WorkflowRoutingObservation {
  status: "suppressed" | "observed" | "routing_unconfirmed";
  reason: string;
  /** A route is host-enforced only when the host supplied the required hook. */
  enforcement: "none" | "host-enforced" | "model-policy";
  workflowToolCalled: boolean;
}

export interface WorkflowRoutingClassification {
  decision: WorkflowRoutingDecision;
  independentSlices: number;
}

const QUESTION_REQUEST =
  /(?:\?|^(?:what|why|how|when|where|who|can you|could you|please explain)\b)/i;
const SOCIAL_REQUEST =
  /^(?:hi|hello|hey|thanks?|thank you|good morning|good afternoon|good evening|good night|how are you|nice to meet you)\b/i;
const ONE_COMMAND_REQUEST =
  /^(?:run|execute|invoke|use|call|open|close|list|show|read|write|install|uninstall|start|stop|check|format|test|build|git)\b/i;

export interface WorkflowRoutingRolloutGate {
  enabled: boolean;
  minimumSdkSatisfied: boolean;
  observedRuns: number;
  compliantRuns: number;
  maxUnconfirmedRate: number;
}

export function passesWorkflowRoutingRolloutGate(
  gate: WorkflowRoutingRolloutGate,
): boolean {
  if (!gate.enabled || !gate.minimumSdkSatisfied || gate.observedRuns <= 0)
    return false;
  const unconfirmed = gate.observedRuns - gate.compliantRuns;
  return unconfirmed / gate.observedRuns <= gate.maxUnconfirmedRate;
}

const SIMPLE_REQUEST =
  /^(?:what|why|how|when|where|who|can you|could you|please explain)\b/i;
const COMPLEX_MARKER =
  /\b(?:investigate|migrate|refactor|implement|audit|compare|review|debug|build|release|coordinate|analyze)\b/gi;
const INDEPENDENT_SLICE_BOUNDARY = /(?:[;\n]+|[.!?]+(?:\s+|$))/;

function hasComplexMarker(text: string): boolean {
  COMPLEX_MARKER.lastIndex = 0;
  const matched = COMPLEX_MARKER.test(text);
  COMPLEX_MARKER.lastIndex = 0;
  return matched;
}

export function parseWorkflowEagerMode(value: unknown): WorkflowEagerMode {
  if (
    value === undefined ||
    value === null ||
    value === false ||
    value === ""
  ) {
    return WORKFLOW_EAGER_DEFAULT;
  }
  if (value === "off" || value === "preferred" || value === "always") {
    return value;
  }
  throw new Error("workflow-eager must be off, preferred, or always");
}

export function decideWorkflowRouting(
  input: WorkflowRoutingInput,
): WorkflowRoutingDecision {
  return classifyWorkflowRouting(input).decision;
}

/**
 * Classify before any direct tool/child side effect. This function deliberately
 * treats explicit host gates as authoritative while retaining text fallbacks for
 * the minimum-SDK policy lane.
 */
export function classifyWorkflowRouting(
  input: WorkflowRoutingInput,
): WorkflowRoutingClassification {
  const text = input.text.trim();
  if (input.mode === "off")
    return directClassification("routing_disabled", text);
  if (!text) return directClassification("empty_request", text);
  if (input.childContext) return directClassification("child_context", text);
  if (input.hasActiveWorkflow)
    return directClassification("active_workflow", text);
  if (input.awaitingUserInput)
    return directClassification("awaiting_user_input", text);
  if (input.managementCommand || /^\/(?:workflow|wf)\b/i.test(text)) {
    return directClassification("management_command", text);
  }
  if (input.planOnly || /^(?:plan|outline|design)\b/i.test(text)) {
    return directClassification("plan_only", text);
  }
  const question = input.question ?? QUESTION_REQUEST.test(text);
  if (question) {
    // Preserve the historical preferred/simple reason while making the
    // mandatory always suppression observable as "question".
    if (input.mode === "preferred" && SIMPLE_REQUEST.test(text)) {
      return directClassification("simple_request", text);
    }
    return directClassification("question", text);
  }
  if (input.socialConversation ?? SOCIAL_REQUEST.test(text)) {
    return directClassification("social_conversation", text);
  }
  const oneCommand =
    input.oneCommand ??
    (ONE_COMMAND_REQUEST.test(text) &&
      !/[;&\n]|(?:\band\b|\bthen\b|\bafter\b)/i.test(text));
  if (oneCommand) return directClassification("one_command", text);

  const independentSlices = countIndependentSlices(text);
  const plannerSlices = input.independentSlices ?? 0;
  const effectiveIndependentSlices = Math.max(independentSlices, plannerSlices);
  const phasedContinuation = Boolean(input.phasedContinuation);
  const hasPlannerEvidence = plannerSlices >= 2;
  if (!hasComplexMarker(text) && !hasPlannerEvidence && !phasedContinuation) {
    return directClassification(
      "not_complex",
      text,
      effectiveIndependentSlices,
    );
  }
  if (
    input.mode === "preferred" &&
    !phasedContinuation &&
    effectiveIndependentSlices < 2
  ) {
    return directClassification(
      "preferred_requires_multiple_slices",
      text,
      effectiveIndependentSlices,
    );
  }
  if (input.directWorkStarted) {
    return directClassification(
      "direct_work_started",
      text,
      effectiveIndependentSlices,
    );
  }
  return {
    decision: {
      kind: "durable_plan",
      reason: "eligible_complex_request",
      mode: input.mode,
      ...(input.hostHookAvailable === undefined
        ? {}
        : {
            enforcement: input.hostHookAvailable
              ? "host-enforced"
              : "model-policy",
          }),
      independentSlices: effectiveIndependentSlices,
    },
    independentSlices: effectiveIndependentSlices,
  };
}

function directClassification(
  reason: string,
  text: string,
  independentSlices = 0,
): WorkflowRoutingClassification {
  return {
    decision: { kind: "direct", reason },
    independentSlices: countIndependentSlices(text, independentSlices),
  };
}

/**
 * Count only bounded, explicit work slices. This is intentionally a lower
 * bound: a planner can raise it through `independentSlices`, but text alone
 * cannot manufacture a workflow from a single focused fix.
 */
export function countIndependentSlices(text: string, minimum = 0): number {
  const clauses = text
    .split(INDEPENDENT_SLICE_BOUNDARY)
    .filter(hasComplexMarker);
  return Math.max(minimum, clauses.length);
}

/**
 * Convert a classification and host/model observation into a user-visible
 * result. A missing workflow call is never represented as host enforcement.
 */
export function observeWorkflowRouting(input: {
  decision: WorkflowRoutingDecision;
  workflowToolCalled: boolean;
  directWorkStarted?: boolean;
}): WorkflowRoutingObservation {
  if (input.decision.kind === "direct") {
    return {
      status: "suppressed",
      reason: input.decision.reason,
      enforcement: "none",
      workflowToolCalled: false,
    };
  }
  // A workflow call after a direct tool call is not evidence of eager routing:
  // the host must never claim a route or duplicate already-started work.
  if (input.directWorkStarted) {
    return {
      status: "routing_unconfirmed",
      reason: "direct_work_started",
      enforcement: "model-policy",
      workflowToolCalled: false,
    };
  }
  if (input.workflowToolCalled) {
    return {
      status: "observed",
      reason: "workflow_tool_called",
      enforcement:
        input.decision.enforcement === "host-enforced"
          ? "host-enforced"
          : "model-policy",
      workflowToolCalled: true,
    };
  }
  return {
    status: "routing_unconfirmed",
    reason: "workflow_tool_not_called",
    enforcement: "model-policy",
    workflowToolCalled: false,
  };
}

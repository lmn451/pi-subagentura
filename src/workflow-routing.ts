export type WorkflowEagerMode = "off" | "preferred" | "always";
export const WORKFLOW_EAGER_DEFAULT: WorkflowEagerMode = "off";
export type WorkflowRoutingDecision =
  | { kind: "direct"; reason: string }
  | { kind: "durable_plan"; reason: string; mode: WorkflowEagerMode };

export interface WorkflowRoutingInput {
  mode: WorkflowEagerMode;
  text: string;
  hasActiveWorkflow?: boolean;
  awaitingUserInput?: boolean;
  childContext?: boolean;
  managementCommand?: boolean;
  planOnly?: boolean;
}

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
  /\b(?:investigate|migrate|refactor|implement|audit|compare|review|debug|build|release|coordinate|analyze)\b/i;

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
  const text = input.text.trim();
  if (input.mode === "off")
    return { kind: "direct", reason: "routing_disabled" };
  if (!text) return { kind: "direct", reason: "empty_request" };
  if (input.childContext) return { kind: "direct", reason: "child_context" };
  if (input.hasActiveWorkflow)
    return { kind: "direct", reason: "active_workflow" };
  if (input.awaitingUserInput)
    return { kind: "direct", reason: "awaiting_user_input" };
  if (input.managementCommand)
    return { kind: "direct", reason: "management_command" };
  if (input.planOnly) return { kind: "direct", reason: "plan_only" };
  if (SIMPLE_REQUEST.test(text) && input.mode === "preferred") {
    return { kind: "direct", reason: "simple_request" };
  }
  if (!COMPLEX_MARKER.test(text)) {
    return { kind: "direct", reason: "not_complex" };
  }
  return {
    kind: "durable_plan",
    reason: "eligible_complex_request",
    mode: input.mode,
  };
}

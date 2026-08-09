export type WorkflowEagerMode = "off" | "preferred" | "always";

export const WORKFLOW_EAGER_DEFAULT: WorkflowEagerMode = "off";

export type WorkflowDirectReason =
  | "routing_disabled"
  | "empty_request"
  | "child_context"
  | "active_workflow"
  | "awaiting_user_input"
  | "management_command"
  | "plan_only"
  | "pure_question"
  | "social_conversation"
  | "one_command_operation"
  | "non_actionable_request"
  | "simple_request";

export type WorkflowRoutingDecision =
  | { kind: "direct"; reason: WorkflowDirectReason }
  | {
      kind: "durable_plan";
      reason: "eligible_complex_request" | "eligible_actionable_request";
      mode: Exclude<WorkflowEagerMode, "off">;
    };

export interface WorkflowRoutingInput {
  mode: WorkflowEagerMode;
  text: string;
  hasActiveWorkflow?: boolean;
  awaitingUserInput?: boolean;
  childContext?: boolean;
  managementCommand?: boolean;
  planOnly?: boolean;
}

export interface WorkflowRoutingMetricsSnapshot {
  readonly decisions: number;
  readonly eligible: number;
  readonly hostStarted: number;
  readonly policyObserved: number;
  readonly routingUnconfirmed: number;
  readonly unconfirmedRate: number;
  readonly directReasons: Readonly<Record<string, number>>;
}

const ACTION =
  /\b(?:add|analyze|audit|build|change|compare|coordinate|create|debug|delete|design|document|execute|fix|implement|investigate|migrate|move|optimize|refactor|release|remove|rename|review|run|test|update|verify|write)\b/gi;
const COMPLEX_SHAPE =
  /\b(?:across|codebase|end[- ]to[- ]end|in parallel|multiple|phases?|pull request|repository|several)\b/i;
const ORDERED_WORK = /\b(?:after|before|first|next|then)\b/i;
const SOCIAL =
  /^(?:good (?:morning|afternoon|evening)|hello|hey|hi|how are you|nice|ok(?:ay)?|thanks?|thank you)[!.\s]*$/i;
const QUESTION_LEAD =
  /^(?:can|could|how|is|may|should|what|when|where|which|who|why|will|would)\b/i;
const AUXILIARY_QUESTION =
  /^(?:do|does)\s+(?:i|you|we|they|he|she|it|this|that)\b/i;
const ACTION_REQUEST_QUESTION =
  /^(?:can|could|will|would)\s+you\b.*\b(?:add|analyze|audit|build|change|compare|coordinate|create|debug|delete|design|document|execute|fix|implement|investigate|migrate|move|optimize|refactor|release|remove|rename|review|run|test|update|verify|write)\b/i;
const IMPERATIVE_ACTION =
  /^(?:please\s+)?(?:add|analyze|audit|build|change|compare|coordinate|create|debug|delete|design|document|execute|fix|implement|investigate|migrate|move|optimize|refactor|release|remove|rename|review|run|test|update|verify|write)\b/i;
const DO_IMPERATIVE = /^do\s+(?:a|an)\b/i;
const REQUEST_CONTEXT =
  /^(?:(?:i|we)\s+(?:need|want)\s+(?:you\s+)?to|need to|(?:the|your)\s+task\s+is\s+to|help me)\b/i;
const PLAN_ONLY =
  /^(?:please\s+)?(?:do not (?:change|edit|implement|modify)|don't (?:change|edit|implement|modify)|no (?:changes|implementation)|plan only|planning only|proposal only|just (?:make|write|create) (?:a )?plan|(?:make|write|create) (?:me )?(?:a )?plan(?: only)?)\b/i;
const MANAGEMENT =
  /^(?:\/(?:workflow|workflows|workflow-[a-z-]+)\b|(?:cancel|continue|inspect|list|resume|show|status|stop)\s+(?:the\s+)?(?:active\s+)?workflow\b)/i;
const ONE_COMMAND =
  /^(?:(?:can|could|will|would)\s+you\s+|please\s+)?(?:run|execute)\s+(?:the\s+)?(?:(?:npm\s+(?:run\s+)?)?(?:build|format(?::check)?|formatter|lint(?:er)?|tests?|typecheck)|git\s+(?:diff|status))(?:\s+[^;&|]+)?[.!?]?$/i;

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
  if (input.mode === "off") {
    return { kind: "direct", reason: "routing_disabled" };
  }
  if (!text) return { kind: "direct", reason: "empty_request" };
  if (input.childContext) return { kind: "direct", reason: "child_context" };
  if (input.hasActiveWorkflow) {
    return { kind: "direct", reason: "active_workflow" };
  }
  if (input.awaitingUserInput) {
    return { kind: "direct", reason: "awaiting_user_input" };
  }
  if (input.managementCommand || MANAGEMENT.test(text)) {
    return { kind: "direct", reason: "management_command" };
  }
  if (input.planOnly || PLAN_ONLY.test(text)) {
    return { kind: "direct", reason: "plan_only" };
  }
  if (SOCIAL.test(text)) {
    return { kind: "direct", reason: "social_conversation" };
  }
  if (isPureQuestion(text)) {
    return { kind: "direct", reason: "pure_question" };
  }
  if (ONE_COMMAND.test(text) && !hasCompoundWork(text)) {
    return { kind: "direct", reason: "one_command_operation" };
  }
  if (!hasActionableIntent(text)) {
    return { kind: "direct", reason: "non_actionable_request" };
  }
  if (input.mode === "preferred" && !hasComplexShape(text)) {
    return { kind: "direct", reason: "simple_request" };
  }
  return {
    kind: "durable_plan",
    reason:
      input.mode === "preferred"
        ? "eligible_complex_request"
        : "eligible_actionable_request",
    mode: input.mode,
  };
}

function isPureQuestion(text: string): boolean {
  if (ACTION_REQUEST_QUESTION.test(text)) return false;
  if (QUESTION_LEAD.test(text) || AUXILIARY_QUESTION.test(text)) return true;
  return text.endsWith("?") && !IMPERATIVE_ACTION.test(text);
}

function hasActionableIntent(text: string): boolean {
  if (
    IMPERATIVE_ACTION.test(text) ||
    DO_IMPERATIVE.test(text) ||
    ACTION_REQUEST_QUESTION.test(text)
  ) {
    return true;
  }
  if (!REQUEST_CONTEXT.test(text)) return false;
  ACTION.lastIndex = 0;
  return ACTION.test(text);
}

function hasComplexShape(text: string): boolean {
  return COMPLEX_SHAPE.test(text) || hasCompoundWork(text);
}

function hasCompoundWork(text: string): boolean {
  if (ORDERED_WORK.test(text)) return true;
  ACTION.lastIndex = 0;
  const actions = new Set<string>();
  for (const match of text.matchAll(ACTION))
    actions.add(match[0].toLowerCase());
  return actions.size >= 2 && /\b(?:and|plus|then|while)\b/i.test(text);
}

export class WorkflowRoutingMetrics {
  private decisions = 0;
  private eligible = 0;
  private hostStarted = 0;
  private policyObserved = 0;
  private routingUnconfirmed = 0;
  private readonly directReasons: Record<string, number> = Object.create(null);

  recordDecision(decision: WorkflowRoutingDecision): void {
    this.decisions++;
    if (decision.kind === "durable_plan") {
      this.eligible++;
      return;
    }
    this.directReasons[decision.reason] =
      (this.directReasons[decision.reason] ?? 0) + 1;
  }

  recordHostStarted(): void {
    this.hostStarted++;
  }

  recordPolicyObserved(): void {
    this.policyObserved++;
  }

  recordRoutingUnconfirmed(): void {
    this.routingUnconfirmed++;
  }

  snapshot(): WorkflowRoutingMetricsSnapshot {
    const policyDecisions = this.policyObserved + this.routingUnconfirmed;
    return {
      decisions: this.decisions,
      eligible: this.eligible,
      hostStarted: this.hostStarted,
      policyObserved: this.policyObserved,
      routingUnconfirmed: this.routingUnconfirmed,
      unconfirmedRate:
        policyDecisions === 0 ? 0 : this.routingUnconfirmed / policyDecisions,
      directReasons: { ...this.directReasons },
    };
  }
}

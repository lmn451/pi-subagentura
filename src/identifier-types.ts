/**
 * Compile-time identifier taxonomy.
 *
 * These brands distinguish values that are all represented as strings or
 * numbers at runtime. They do not validate untrusted input; apply a brand only
 * after a parser, schema, or trusted generator has established the boundary.
 */

declare const stringIdentifierBrand: unique symbol;
declare const numericIdentifierBrand: unique symbol;

export type IdentifierDomain =
  | "interactive-subagent"
  | "in-process-job"
  | "workflow"
  | "workflow-attempt"
  | "parent-session"
  | "root-session"
  | "agent-session"
  | "session-scope"
  | "session-scope-generation"
  | "turn"
  | "event"
  | "delivery"
  | "completion"
  | "completion-group"
  | "wake"
  | "pane"
  | "mux-session"
  | "mux-terminal"
  | "herdr-request"
  | "worker-rpc"
  | "telemetry-correlation"
  | "project"
  | "confirmation-token"
  | "tool-call"
  | "model";

export type StringIdentifier<Domain extends IdentifierDomain> = string & {
  readonly [stringIdentifierBrand]: Domain;
};

export type NumericIdentifier<Domain extends IdentifierDomain> = number & {
  readonly [numericIdentifierBrand]: Domain;
};

/** Brand a value at a trusted string boundary without changing its runtime value. */
export function asStringIdentifier<Domain extends IdentifierDomain>(
  value: string,
): StringIdentifier<Domain> {
  return value as StringIdentifier<Domain>;
}

/** Brand a value at a trusted numeric boundary without changing its runtime value. */
export function asNumericIdentifier<Domain extends IdentifierDomain>(
  value: number,
): NumericIdentifier<Domain> {
  return value as NumericIdentifier<Domain>;
}

export type InteractiveSubagentId = StringIdentifier<"interactive-subagent">;
export type InProcessJobId = StringIdentifier<"in-process-job">;
export type WorkflowId = StringIdentifier<"workflow">;
export type WorkflowAttemptId = NumericIdentifier<"workflow-attempt">;
export type ParentSessionId = StringIdentifier<"parent-session">;
export type RootSessionId = StringIdentifier<"root-session">;
export type AgentSessionId = StringIdentifier<"agent-session">;
export type SessionScopeId = NumericIdentifier<"session-scope">;
export type SessionScopeGeneration =
  NumericIdentifier<"session-scope-generation">;
export type TurnId = StringIdentifier<"turn">;
export type EventId = StringIdentifier<"event">;
export type DeliveryId = StringIdentifier<"delivery">;
export type CompletionId = StringIdentifier<"completion">;
export type CompletionGroupId = StringIdentifier<"completion-group">;
export type WakeId = StringIdentifier<"wake">;
export type PaneId = StringIdentifier<"pane">;
export type MuxSessionId = StringIdentifier<"mux-session">;
export type MuxTerminalId = StringIdentifier<"mux-terminal">;
export type HerdrRequestId = StringIdentifier<"herdr-request">;
export type WorkerRpcId = NumericIdentifier<"worker-rpc">;
export type TelemetryCorrelationId = StringIdentifier<"telemetry-correlation">;
export type ProjectId = StringIdentifier<"project">;
export type ConfirmationToken = StringIdentifier<"confirmation-token">;
export type ToolCallId = StringIdentifier<"tool-call">;
export type ModelId = StringIdentifier<"model">;

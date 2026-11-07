export const COMPLETION_ENTRY_TYPE = "subagentura-completion";
export const COMPLETION_CONSUMED_ENTRY_TYPE = "subagentura-completion-consumed";
export const COMPLETION_MANIFEST_TYPE = "subagent-manifest";
export const COMPLETION_RECORD_SCHEMA_VERSION = 1;
export const MAX_COMPLETION_RECORDS = 4096;
export const MAX_COMPLETION_LABEL_LENGTH = 160;
export const MAX_MANIFEST_RECORDS = 128;

export type CompletionPolicy = "each" | "group";
export type CompletionSource = "interactive" | "in-process" | "workflow";
export type CompletionStatus = "done" | "error" | "cancelled";

export interface CompletionReference {
  label: string;
  value: string;
}

export interface CompletionRecord {
  schemaVersion: typeof COMPLETION_RECORD_SCHEMA_VERSION;
  completionId: string;
  source: CompletionSource;
  sourceId: string;
  turnId?: string;
  label: string;
  status: CompletionStatus;
  /** TUI-only label metadata; status remains authoritative for behavior. */
  presentation?: "completed-with-errors";
  policy: CompletionPolicy;
  groupId?: string;
  /** Number of registered group members still awaiting terminal completion. */
  groupRemaining?: number;
  /** Indicates that this member completed the sealed group barrier. */
  groupComplete?: boolean;
  references: CompletionReference[];
  completedAt: number;
  /**
   * Source completion time for delivery-latency analytics. Interactive
   * completions recovered from legacy state may not have one; the required
   * `completedAt` remains the coordinator publication timestamp.
   */
  telemetryCompletedAt?: number;
  /** Monotonic publication sequence used to retire spilled session entries. */
  sequence?: number;
  ownerSessionId?: string;
}

export interface CompletionPolicyParams {
  completionPolicy?: CompletionPolicy;
  completionGroupId?: string;
}

export interface ResolvedCompletionPolicy {
  policy: CompletionPolicy;
  groupId?: string;
}

interface CompletionConsumptionBase {
  schemaVersion: typeof COMPLETION_RECORD_SCHEMA_VERSION;
  consumedAt: number;
  reason: "manual" | "manifest" | "lifecycle";
}

export interface InteractiveTurnConsumption extends CompletionConsumptionBase {
  source: "interactive";
  sourceId: string;
  turnId: string;
  scope?: never;
}

export interface InteractiveSourceConsumption extends CompletionConsumptionBase {
  source: "interactive";
  sourceId: string;
  scope: "source";
  turnId?: never;
}

export interface NonInteractiveCompletionConsumption extends CompletionConsumptionBase {
  source: "in-process" | "workflow";
  sourceId: string;
  turnId?: never;
  scope?: never;
}

export interface CompletionIdsConsumption extends CompletionConsumptionBase {
  completionIds: string[];
  source?: never;
  sourceId?: never;
  turnId?: never;
  scope?: never;
}

export type CompletionConsumption =
  | InteractiveTurnConsumption
  | InteractiveSourceConsumption
  | NonInteractiveCompletionConsumption
  | CompletionIdsConsumption;

export type CompletionConsumptionSelector =
  | Pick<InteractiveTurnConsumption, "source" | "sourceId" | "turnId">
  | Pick<InteractiveSourceConsumption, "source" | "sourceId" | "scope">
  | Pick<NonInteractiveCompletionConsumption, "source" | "sourceId">;

export interface CompletionExpectation {
  completionId: string;
  source: CompletionSource;
  sourceId: string;
  turnId?: string;
}

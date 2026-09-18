export type DecisionCalibration =
  "provider-calibrated" | "derived" | "uncalibrated" | "unknown";

export type DecisionJSONPrimitive = string | number | boolean | null;

export type DecisionJSONValue =
  | DecisionJSONPrimitive
  | { readonly [key: string]: DecisionJSONValue }
  | readonly DecisionJSONValue[];

export interface DecisionChoice<T extends string = string> {
  value: T;
  description: string;
}

export interface ChoiceDecisionRequest<T extends string = string> {
  state?: DecisionJSONValue;
  question: string;
  instructions?: string;
  choices: readonly DecisionChoice<T>[];
}

export interface DecisionObservation<T extends string = string> {
  choice: T;
  probabilities?: Partial<Record<T, number>>;
  confidence?: number;
  evidence: {
    calibration: DecisionCalibration;
  };
  provenance: {
    backend: string;
    model?: string;
    remote: boolean;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface DecisionCapabilities {
  choice: boolean;
  probabilities: boolean;
  confidence: boolean;
  calibration: DecisionCalibration;
  remote: boolean;
}

export type DecisionBackendErrorCode =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "payload_too_large"
  | "invalid_config"
  | "unsupported";

export class DecisionBackendError extends Error {
  readonly name = "DecisionBackendError";

  constructor(
    readonly code: DecisionBackendErrorCode,
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface DecisionBackend {
  readonly id: string;
  readonly capabilities: DecisionCapabilities;

  choose<T extends string>(
    request: ChoiceDecisionRequest<T>,
    signal?: AbortSignal,
  ): Promise<DecisionObservation<T>>;
}

export type DecisionErrorReason =
  | "disabled"
  | "invalid_config"
  | "invalid_input"
  | "payload_too_large"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "unsupported";

export type DecisionResult<T extends string = string> =
  | {
      kind: "selected";
      value: T;
      observation: DecisionObservation<T>;
    }
  | {
      kind: "abstain";
      reason: "none" | "ambiguous" | "low_confidence";
      observation?: DecisionObservation<T>;
    }
  | {
      kind: "error";
      reason: DecisionErrorReason;
    }
  | {
      kind: "cancelled";
    };

export interface DecisionPolicy {
  evaluate<T extends string>(
    observation: DecisionObservation<T>,
    request: ChoiceDecisionRequest<T>,
  ): DecisionResult<T>;
}

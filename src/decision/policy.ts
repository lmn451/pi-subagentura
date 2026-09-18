import {
  type ChoiceDecisionRequest,
  type DecisionCalibration,
  type DecisionObservation,
  type DecisionPolicy,
  type DecisionResult,
} from "./types";

const PROBABILITY_TOLERANCE = 1e-9;
const CALIBRATIONS: readonly DecisionCalibration[] = [
  "provider-calibrated",
  "derived",
  "uncalibrated",
  "unknown",
];

export interface ThresholdDecisionPolicyOptions {
  minConfidence?: number;
  minTopProbability?: number;
  minMargin?: number;
  acceptedCalibration?: readonly DecisionCalibration[];
}

interface ProbabilitySummary {
  topProbability: number;
  margin?: number;
}

export class ThresholdDecisionPolicy implements DecisionPolicy {
  readonly options: Readonly<ThresholdDecisionPolicyOptions>;

  constructor(options: ThresholdDecisionPolicyOptions = {}) {
    validateOptions(options);
    this.options = {
      ...options,
      ...(options.acceptedCalibration === undefined
        ? {}
        : { acceptedCalibration: [...options.acceptedCalibration] }),
    };
  }

  evaluate<T extends string>(
    observation: DecisionObservation<T>,
    request: ChoiceDecisionRequest<T>,
  ): DecisionResult<T> {
    if (!isValidDecisionObservation(observation, request)) {
      return { kind: "error", reason: "invalid_response" };
    }

    const acceptedCalibration = this.options.acceptedCalibration;
    if (
      acceptedCalibration !== undefined &&
      !acceptedCalibration.includes(observation.evidence.calibration)
    ) {
      return abstain("low_confidence", observation);
    }

    const probabilities = summarizeProbabilities(observation);
    if (probabilities?.margin !== undefined && probabilities.margin <= 0) {
      return abstain("ambiguous", observation);
    }
    if (
      this.options.minConfidence !== undefined &&
      (observation.confidence === undefined ||
        observation.confidence < this.options.minConfidence)
    ) {
      return abstain("low_confidence", observation);
    }
    if (
      this.options.minTopProbability !== undefined &&
      (probabilities === undefined ||
        probabilities.topProbability < this.options.minTopProbability)
    ) {
      return abstain("low_confidence", observation);
    }
    if (
      this.options.minMargin !== undefined &&
      (probabilities?.margin === undefined ||
        probabilities.margin < this.options.minMargin)
    ) {
      return abstain("ambiguous", observation);
    }
    return {
      kind: "selected",
      value: observation.choice,
      observation,
    };
  }
}

export function createDecisionPolicy(
  options: ThresholdDecisionPolicyOptions = {},
): DecisionPolicy {
  return new ThresholdDecisionPolicy(options);
}

export function isValidDecisionObservation<T extends string>(
  observation: unknown,
  request: ChoiceDecisionRequest<T>,
): observation is DecisionObservation<T> {
  try {
    if (!isRecord(observation)) return false;
    const values = new Set(request.choices.map((choice) => choice.value));
    if (typeof observation.choice !== "string") return false;
    if (!values.has(observation.choice as T)) return false;
    if (!isValidEvidence(observation.evidence)) return false;
    if (!isValidProvenance(observation.provenance)) return false;
    if (
      observation.confidence !== undefined &&
      !isProbability(observation.confidence)
    ) {
      return false;
    }
    if (
      observation.probabilities !== undefined &&
      !isValidProbabilities(
        observation.probabilities,
        values,
        observation.choice,
      )
    ) {
      return false;
    }
    return observation.usage === undefined || isValidUsage(observation.usage);
  } catch {
    // Provider-controlled objects can be proxies or throwing getters.
    return false;
  }
}

function validateOptions(options: ThresholdDecisionPolicyOptions): void {
  for (const value of [
    options.minConfidence,
    options.minTopProbability,
    options.minMargin,
  ]) {
    if (value !== undefined && !isProbability(value)) {
      throw new RangeError(
        "decision policy thresholds must be between 0 and 1",
      );
    }
  }
  if (options.acceptedCalibration === undefined) return;
  if (!Array.isArray(options.acceptedCalibration)) {
    throw new TypeError("accepted decision calibrations must be an array");
  }
  for (const calibration of options.acceptedCalibration) {
    if (!CALIBRATIONS.includes(calibration)) {
      throw new TypeError("unsupported decision calibration");
    }
  }
}

function isValidEvidence(value: unknown): value is {
  calibration: DecisionCalibration;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value.calibration === "string" &&
    CALIBRATIONS.includes(value.calibration as DecisionCalibration)
  );
}

function isValidProvenance(value: unknown): value is {
  backend: string;
  model?: string;
  remote: boolean;
} {
  if (!isRecord(value)) return false;
  if (
    typeof value.backend !== "string" ||
    value.backend.trim().length === 0 ||
    typeof value.remote !== "boolean"
  ) {
    return false;
  }
  return (
    value.model === undefined ||
    (typeof value.model === "string" && value.model.trim().length > 0)
  );
}

function isValidProbabilities(
  value: unknown,
  choices: ReadonlySet<string>,
  selectedChoice: string,
): value is Partial<Record<string, number>> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.includes(selectedChoice)) return false;
  for (const key of keys) {
    if (!choices.has(key) || !isProbability(value[key])) return false;
  }
  const selectedProbability = value[selectedChoice];
  if (!isProbability(selectedProbability)) return false;
  let maximum = selectedProbability;
  for (const key of keys) {
    const probability = value[key];
    if (!isProbability(probability)) return false;
    if (probability > maximum) maximum = probability;
  }
  return selectedProbability >= maximum - PROBABILITY_TOLERANCE;
}

function isValidUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.inputTokens, value.outputTokens, value.costUsd].every(
    (entry) => entry === undefined || isNonNegativeFiniteNumber(entry),
  );
}

function summarizeProbabilities(
  observation: DecisionObservation,
): ProbabilitySummary | undefined {
  const probabilities = observation.probabilities;
  if (probabilities === undefined) return undefined;
  const selectedProbability = probabilities[observation.choice];
  if (selectedProbability === undefined) return undefined;
  let runnerUp: number | undefined;
  const entries = Object.entries(probabilities) as [string, number][];
  for (const [choice, probability] of entries) {
    if (choice === observation.choice) continue;
    if (runnerUp === undefined || probability > runnerUp) {
      runnerUp = probability;
    }
  }
  return {
    topProbability: selectedProbability,
    ...(runnerUp === undefined
      ? {}
      : { margin: selectedProbability - runnerUp }),
  };
}

function abstain<T extends string>(
  reason: "ambiguous" | "low_confidence",
  observation: DecisionObservation<T>,
): DecisionResult<T> {
  return { kind: "abstain", reason, observation };
}

function isProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

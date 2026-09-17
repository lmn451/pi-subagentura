/**
 * Provider-neutral types and policy for advisory child routing.
 *
 * This module deliberately contains no provider or runtime state. The Jev
 * adapter translates its response into these values, while the parent tool
 * remains responsible for deciding whether a returned child can be used.
 */

export interface RoutingCandidate {
  childId: string;
  description: string;
  aliases?: string[];
  status: string;
}

export interface RoutingInput {
  task: string;
  candidates: readonly RoutingCandidate[];
}

export interface RoutingEvidence {
  confidence: number;
  topProbability: number;
  runnerUpProbability: number;
  margin: number;
}

export type RoutingAskReason =
  | "disabled"
  | "missing_key"
  | "invalid_config"
  | "no_candidates"
  | "invalid_input"
  | "payload_too_large"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "no_match"
  | "low_confidence"
  | "ambiguous"
  | "state_changed"
  | "incomplete_registry";

export type RoutingDecision =
  | { kind: "reuse"; childId: string; evidence: RoutingEvidence }
  | {
      kind: "ask";
      reason: RoutingAskReason;
      candidateIds: string[];
      evidence?: RoutingEvidence;
    }
  | { kind: "cancelled" };

export interface RoutingEngine {
  decide(input: RoutingInput, signal?: AbortSignal): Promise<RoutingDecision>;
}

export interface RoutingPolicy {
  minConfidence: number;
  minTopProbability: number;
  minMargin: number;
}

export const DEFAULT_ROUTING_POLICY: Readonly<RoutingPolicy> = Object.freeze({
  minConfidence: 0.8,
  minTopProbability: 0.8,
  minMargin: 0.2,
});

/**
 * Return the closed policy reason for evidence that cannot authorize reuse.
 * An exact tie remains ambiguous even when a trusted caller sets the minimum
 * margin to zero.
 */
export function routingEvidenceFailureReason(
  evidence: RoutingEvidence,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): "low_confidence" | "ambiguous" | undefined {
  if (!isValidRoutingEvidence(evidence) || !isValidPolicy(policy)) {
    return "low_confidence";
  }
  if (
    evidence.confidence < policy.minConfidence ||
    evidence.topProbability < policy.minTopProbability
  ) {
    return "low_confidence";
  }
  // An exact tie is never safe to resolve by candidate order, even when a
  // trusted test policy permits a zero minimum margin.
  if (evidence.margin <= 0 || evidence.margin < policy.minMargin) {
    return "ambiguous";
  }
  return undefined;
}

export function isRoutingEvidenceSufficient(
  evidence: RoutingEvidence,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): boolean {
  return routingEvidenceFailureReason(evidence, policy) === undefined;
}

/**
 * Apply the host policy to a validated provider choice. The adapter should
 * validate the choice and probabilities before calling this function.
 */
export function decideFromRoutingChoice(
  choice: string,
  candidateIds: readonly string[],
  evidence: RoutingEvidence,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutingDecision {
  const ids = [...candidateIds];
  if (!isValidRoutingEvidence(evidence)) {
    return { kind: "ask", reason: "invalid_response", candidateIds: ids };
  }
  if (choice === "none") {
    return {
      kind: "ask",
      reason: "no_match",
      candidateIds: ids,
      evidence,
    };
  }
  if (!ids.includes(choice)) {
    return { kind: "ask", reason: "invalid_response", candidateIds: ids };
  }
  const failureReason = routingEvidenceFailureReason(evidence, policy);
  if (failureReason !== undefined) {
    return {
      kind: "ask",
      reason: failureReason,
      candidateIds: ids,
      evidence,
    };
  }
  return { kind: "reuse", childId: choice, evidence };
}

export function isValidRoutingEvidence(
  evidence: RoutingEvidence,
): evidence is RoutingEvidence {
  if (!evidence || typeof evidence !== "object") return false;
  const margin = evidence.topProbability - evidence.runnerUpProbability;
  return (
    Number.isFinite(evidence.confidence) &&
    evidence.confidence >= 0 &&
    evidence.confidence <= 1 &&
    Number.isFinite(evidence.topProbability) &&
    evidence.topProbability >= 0 &&
    evidence.topProbability <= 1 &&
    Number.isFinite(evidence.runnerUpProbability) &&
    evidence.runnerUpProbability >= 0 &&
    evidence.runnerUpProbability <= 1 &&
    Number.isFinite(evidence.margin) &&
    evidence.margin >= 0 &&
    evidence.margin <= 1 &&
    evidence.topProbability >= evidence.runnerUpProbability &&
    Math.abs(evidence.margin - margin) <= 1e-6
  );
}

function isValidPolicy(policy: RoutingPolicy): boolean {
  return (
    Number.isFinite(policy.minConfidence) &&
    policy.minConfidence >= 0 &&
    policy.minConfidence <= 1 &&
    Number.isFinite(policy.minTopProbability) &&
    policy.minTopProbability >= 0 &&
    policy.minTopProbability <= 1 &&
    Number.isFinite(policy.minMargin) &&
    policy.minMargin >= 0 &&
    policy.minMargin <= 1
  );
}

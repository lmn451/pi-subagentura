import type { Usage } from "@earendil-works/pi-ai";
import {
  buildSystemOneChoicePayload,
  parseSystemOneChoiceResponse,
  prepareSystemOneInput,
  readSystemOneConfig,
  runWithSystemOneDeadline,
  systemOneByteLength,
  type NativeChoiceContext,
  type PreparedSystemOneInput,
  type SystemOneRoutingConfig,
} from "./system-one-choice";
import {
  ROUTING_PROVIDER_ENV,
  decideFromRoutingChoice,
  type RoutingDecision,
  type RoutingEngine,
  type RoutingInput,
} from "./routing-engine";

export const JEV_PROVIDER_ENV = "PI_ORCHESTRATOR_ROUTER_PROVIDER";
export const JEV_MODEL_ENV = "PI_ORCHESTRATOR_ROUTER_MODEL";
export const DEFAULT_JEV_PROVIDER = "openrouter";
export const DEFAULT_JEV_MODEL = "~typesafe/jev-latest";
const MAX_MODEL_SETTING_BYTES = 256;
const MAX_LLAMA_CANDIDATES = 61;

interface NativeClassifierModel {
  type: "classifier";
  provider: string;
  id: string;
  api: string;
}

/** Capability shim keeps optional routing loadable on pre-classifier hosts. */
interface NativeClassifierRegistry {
  findOfType(type: "classifier", provider: string, id: string): unknown;
  getProviderAuthStatus(provider: string): { configured: boolean };
  classify(
    model: NativeClassifierModel,
    context: NativeChoiceContext,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}

export interface JevRoutingEngineOptions {
  env?: NodeJS.ProcessEnv;
  modelRegistry?: unknown;
  onUsage?: (usage: Usage) => void;
}

export function isJevRoutingConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ROUTING_PROVIDER_ENV] === "jev";
}

export function createJevRoutingEngine(
  options: JevRoutingEngineOptions = {},
): RoutingEngine | undefined {
  const env = options.env ?? process.env;
  const registry = nativeRegistry(options.modelRegistry);
  const model = registry ? configuredModel(registry, env) : undefined;
  const config = readSystemOneConfig(env);
  if (
    !isJevRoutingConfigured(env) ||
    !registry ||
    !model ||
    config.kind !== "ready"
  ) {
    return undefined;
  }
  return {
    async decide(input, signal) {
      if (signal?.aborted) return { kind: "cancelled" };
      if (!isJevRoutingConfigured(env))
        return { kind: "error", reason: "disabled" };
      const currentModel = configuredModel(registry, env);
      if (!currentModel) return { kind: "error", reason: "unavailable" };
      const secrets = Object.entries(env)
        .filter(
          ([key, value]) =>
            /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) &&
            typeof value === "string",
        )
        .map(([, value]) => value!);
      return decideNative(
        input,
        signal,
        registry,
        currentModel,
        config.config,
        options.onUsage,
        secrets,
      );
    },
  };
}

function nativeRegistry(value: unknown): NativeClassifierRegistry | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.findOfType === "function" &&
    typeof value.classify === "function" &&
    typeof value.getProviderAuthStatus === "function"
    ? (value as unknown as NativeClassifierRegistry)
    : undefined;
}

function configuredModel(
  registry: NativeClassifierRegistry,
  env: NodeJS.ProcessEnv,
): NativeClassifierModel | undefined {
  const provider = env[JEV_PROVIDER_ENV] ?? DEFAULT_JEV_PROVIDER;
  const id = env[JEV_MODEL_ENV] ?? DEFAULT_JEV_MODEL;
  if (
    ![provider, id].every(
      (value) =>
        value.trim() === value &&
        value.length > 0 &&
        systemOneByteLength(value) <= MAX_MODEL_SETTING_BYTES,
    )
  ) {
    return undefined;
  }
  try {
    const model = registry.findOfType("classifier", provider, id);
    if (
      !isRecord(model) ||
      model.type !== "classifier" ||
      model.provider !== provider ||
      model.id !== id ||
      typeof model.api !== "string"
    ) {
      return undefined;
    }
    return registry.getProviderAuthStatus(provider)?.configured === true
      ? (model as unknown as NativeClassifierModel)
      : undefined;
  } catch {
    // Catalog/auth failures disable advice; raw host errors never reach the model.
    return undefined;
  }
}

async function decideNative(
  input: RoutingInput,
  signal: AbortSignal | undefined,
  registry: NativeClassifierRegistry,
  model: NativeClassifierModel,
  config: SystemOneRoutingConfig,
  onUsage: JevRoutingEngineOptions["onUsage"],
  secrets: readonly string[],
): Promise<RoutingDecision> {
  const prepared = prepareSystemOneInput(input, {
    ...config,
    maxCandidates:
      model.api === "llama-cpp-classify"
        ? Math.min(config.maxCandidates, MAX_LLAMA_CANDIDATES)
        : config.maxCandidates,
  });
  if (prepared.kind !== "ready") {
    return prepared.kind === "no_candidates"
      ? { kind: "no_match", reason: "none" }
      : { kind: "error", reason: prepared.kind };
  }
  const context = buildSystemOneChoicePayload(prepared.input, [
    ...secrets,
    ...input.candidates.map((candidate) => candidate.childId),
  ]);
  if (systemOneByteLength(JSON.stringify(context)) > config.maxRequestBytes) {
    return { kind: "error", reason: "payload_too_large" };
  }
  const outcome = await runWithSystemOneDeadline(
    (requestSignal) =>
      registry.classify(model, context, { signal: requestSignal }),
    signal,
    config.timeoutMs,
  );
  if (signal?.aborted || outcome.kind === "cancelled")
    return { kind: "cancelled" };
  if (outcome.kind === "timeout") return { kind: "error", reason: "timeout" };
  if (outcome.kind !== "ok") return { kind: "error", reason: "unavailable" };
  const usage = classifierUsage(outcome.value);
  if (usage) onUsage?.(usage);
  return nativeDecision(outcome.value, prepared.input, config);
}

function nativeDecision(
  result: unknown,
  input: PreparedSystemOneInput,
  config: SystemOneRoutingConfig,
): RoutingDecision {
  if (!isRecord(result)) return { kind: "error", reason: "invalid_response" };
  if (result.stopReason === "aborted") return { kind: "cancelled" };
  if (result.stopReason === "error")
    return { kind: "error", reason: "unavailable" };
  if (result.stopReason !== "stop")
    return { kind: "error", reason: "invalid_response" };
  try {
    // Pi owns network buffering; this bound applies to the decoded answer only.
    if (
      systemOneByteLength(JSON.stringify(result.answers) ?? "") >
      config.maxResponseBytes
    ) {
      return { kind: "error", reason: "payload_too_large" };
    }
  } catch {
    // Circular or otherwise non-JSON answers cannot authorize a route.
    return { kind: "error", reason: "invalid_response" };
  }
  const parsed = parseSystemOneChoiceResponse(
    result,
    input.candidates.map((candidate) => candidate.token),
  );
  if (!parsed) return { kind: "error", reason: "invalid_response" };
  const childId = input.candidates.find(
    (candidate) => candidate.token === parsed.choice,
  )?.childId;
  return decideFromRoutingChoice(
    childId ?? parsed.choice,
    input.candidates.map((candidate) => candidate.childId),
    parsed.evidence,
    config.policy,
  );
}

function classifierUsage(result: unknown): Usage | undefined {
  if (!isRecord(result) || !isRecord(result.usage)) return undefined;
  const raw = result.usage;
  const cost = raw.cost;
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const fields = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ] as const;
  const costs = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const;
  if (
    !isRecord(cost) ||
    !fields.every((key) => valid(raw[key])) ||
    !costs.every((key) => valid(cost[key]))
  )
    return undefined;
  return {
    input: raw.input as number,
    output: raw.output as number,
    cacheRead: raw.cacheRead as number,
    cacheWrite: raw.cacheWrite as number,
    totalTokens: raw.totalTokens as number,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
      total: cost.total as number,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

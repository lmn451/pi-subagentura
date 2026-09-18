import {
  MAX_SYSTEM_ONE_API_KEY_BYTES,
  decideWithSystemOneChoice,
  readSystemOneConfig,
  systemOneByteLength,
} from "./system-one-choice";
import {
  ROUTING_PROVIDER_ENV,
  type RoutingEngine,
  type RoutingInput,
} from "./routing-engine";

export const OPENROUTER_JEV_ROUTING_ENDPOINT =
  "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_JEV_ROUTING_MODEL = "~typesafe/jev-latest";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_JEV_MODEL_ENV = "OPENROUTER_JEV_MODEL";
export const MAX_OPENROUTER_JEV_MODEL_BYTES = 256;

/** Compatibility aliases for callers that name the provider without Jev. */
export const OPENROUTER_ROUTING_ENDPOINT = OPENROUTER_JEV_ROUTING_ENDPOINT;
export const OPENROUTER_ROUTING_MODEL = OPENROUTER_JEV_ROUTING_MODEL;
export const OPENROUTER_MODEL_ENV = OPENROUTER_JEV_MODEL_ENV;

export interface OpenRouterJevRoutingEngineOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface OpenRouterJevRoutingConfig {
  apiKey: string;
  model: string;
  systemOne: NonNullable<
    Extract<ReturnType<typeof readSystemOneConfig>, { kind: "ready" }>
  >["config"];
}

type ConfigResult =
  | { kind: "disabled" }
  | { kind: "missing_key" }
  | { kind: "invalid_config" }
  | { kind: "ready"; config: OpenRouterJevRoutingConfig };

export function isOpenRouterJevRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ROUTING_PROVIDER_ENV] === "openrouter";
}

export function createOpenRouterJevRoutingEngine(
  options: OpenRouterJevRoutingEngineOptions = {},
): RoutingEngine {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async decide(input: RoutingInput, signal?: AbortSignal) {
      if (signal?.aborted) return { kind: "cancelled" as const };

      const configResult = readConfig(env);
      if (configResult.kind !== "ready") {
        return { kind: "error" as const, reason: configResult.kind };
      }

      return decideWithSystemOneChoice(
        input,
        signal,
        configResult.config.systemOne,
        {
          endpoint: OPENROUTER_JEV_ROUTING_ENDPOINT,
          model: configResult.config.model,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${configResult.config.apiKey}`,
            "content-type": "application/json",
          },
          secrets: [configResult.config.apiKey],
          fetch: fetchImpl,
        },
      );
    },
  };
}

/** Alias for integrations that use the provider-neutral adapter name. */
export const createOpenRouterRoutingEngine = createOpenRouterJevRoutingEngine;

export function isOpenRouterRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isOpenRouterJevRoutingEnabled(env);
}

function readConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env[ROUTING_PROVIDER_ENV] !== "openrouter") {
    return { kind: "disabled" };
  }

  const rawKey = env[OPENROUTER_API_KEY_ENV];
  const apiKey = rawKey?.trim();
  if (!apiKey) return { kind: "missing_key" };
  if (systemOneByteLength(apiKey) > MAX_SYSTEM_ONE_API_KEY_BYTES) {
    return { kind: "invalid_config" };
  }

  const rawModel = env[OPENROUTER_JEV_MODEL_ENV];
  if (rawModel !== undefined && rawModel.trim().length === 0) {
    return { kind: "invalid_config" };
  }
  const model = rawModel?.trim() || OPENROUTER_JEV_ROUTING_MODEL;
  if (systemOneByteLength(model) > MAX_OPENROUTER_JEV_MODEL_BYTES) {
    return { kind: "invalid_config" };
  }

  const systemConfig = readSystemOneConfig(env);
  if (systemConfig.kind !== "ready") return systemConfig;
  return {
    kind: "ready",
    config: {
      apiKey,
      model,
      systemOne: systemConfig.config,
    },
  };
}

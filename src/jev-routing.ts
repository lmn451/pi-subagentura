import {
  DEFAULT_SYSTEM_ONE_MAX_CANDIDATES,
  DEFAULT_SYSTEM_ONE_MAX_REQUEST_BYTES,
  DEFAULT_SYSTEM_ONE_MAX_RESPONSE_BYTES,
  DEFAULT_SYSTEM_ONE_MAX_TASK_BYTES,
  DEFAULT_SYSTEM_ONE_TIMEOUT_MS,
  MAX_SYSTEM_ONE_ALIASES,
  MAX_SYSTEM_ONE_ALIAS_BYTES,
  MAX_SYSTEM_ONE_API_KEY_BYTES,
  MAX_SYSTEM_ONE_CANDIDATES,
  MAX_SYSTEM_ONE_CHILD_ID_BYTES,
  MAX_SYSTEM_ONE_DESCRIPTION_BYTES,
  MAX_SYSTEM_ONE_REQUEST_BYTES,
  MAX_SYSTEM_ONE_RESPONSE_BYTES,
  MAX_SYSTEM_ONE_STATUS_BYTES,
  MAX_SYSTEM_ONE_TASK_BYTES,
  MAX_SYSTEM_ONE_TIMEOUT_MS,
  SYSTEM_ONE_MAX_CANDIDATES_ENV,
  SYSTEM_ONE_MAX_REQUEST_BYTES_ENV,
  SYSTEM_ONE_MAX_RESPONSE_BYTES_ENV,
  SYSTEM_ONE_MAX_TASK_BYTES_ENV,
  SYSTEM_ONE_MIN_CONFIDENCE_ENV,
  SYSTEM_ONE_MIN_MARGIN_ENV,
  SYSTEM_ONE_MIN_TOP_PROBABILITY_ENV,
  SYSTEM_ONE_TIMEOUT_ENV,
  decideWithSystemOneChoice,
  readSystemOneConfig,
  systemOneByteLength,
  type SystemOneRoutingConfig,
} from "./system-one-choice";
import {
  ROUTING_PROVIDER_ENV,
  type RoutingEngine,
  type RoutingInput,
} from "./routing-engine";

export const JEV_ROUTING_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_ROUTING_MODEL = "jev-latest";
/** @deprecated Use ROUTING_PROVIDER_ENV for provider-neutral activation. */
export const JEV_ROUTER_ENV = ROUTING_PROVIDER_ENV;
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_TIMEOUT_ENV = SYSTEM_ONE_TIMEOUT_ENV;
export const JEV_MIN_CONFIDENCE_ENV = SYSTEM_ONE_MIN_CONFIDENCE_ENV;
export const JEV_MIN_TOP_PROBABILITY_ENV = SYSTEM_ONE_MIN_TOP_PROBABILITY_ENV;
export const JEV_MIN_MARGIN_ENV = SYSTEM_ONE_MIN_MARGIN_ENV;
export const JEV_MAX_REQUEST_BYTES_ENV = SYSTEM_ONE_MAX_REQUEST_BYTES_ENV;
export const JEV_MAX_RESPONSE_BYTES_ENV = SYSTEM_ONE_MAX_RESPONSE_BYTES_ENV;
export const JEV_MAX_CANDIDATES_ENV = SYSTEM_ONE_MAX_CANDIDATES_ENV;
export const JEV_MAX_TASK_BYTES_ENV = SYSTEM_ONE_MAX_TASK_BYTES_ENV;

export const DEFAULT_JEV_TIMEOUT_MS = DEFAULT_SYSTEM_ONE_TIMEOUT_MS;
export const DEFAULT_JEV_MAX_REQUEST_BYTES =
  DEFAULT_SYSTEM_ONE_MAX_REQUEST_BYTES;
export const DEFAULT_JEV_MAX_RESPONSE_BYTES =
  DEFAULT_SYSTEM_ONE_MAX_RESPONSE_BYTES;
export const DEFAULT_JEV_MAX_CANDIDATES = DEFAULT_SYSTEM_ONE_MAX_CANDIDATES;
export const DEFAULT_JEV_MAX_TASK_BYTES = DEFAULT_SYSTEM_ONE_MAX_TASK_BYTES;
export const MAX_JEV_TIMEOUT_MS = MAX_SYSTEM_ONE_TIMEOUT_MS;
export const MAX_JEV_REQUEST_BYTES = MAX_SYSTEM_ONE_REQUEST_BYTES;
export const MAX_JEV_RESPONSE_BYTES = MAX_SYSTEM_ONE_RESPONSE_BYTES;
export const MAX_JEV_CANDIDATES = MAX_SYSTEM_ONE_CANDIDATES;
export const MAX_JEV_TASK_BYTES = MAX_SYSTEM_ONE_TASK_BYTES;
export const MAX_JEV_CHILD_ID_BYTES = MAX_SYSTEM_ONE_CHILD_ID_BYTES;
export const MAX_JEV_DESCRIPTION_BYTES = MAX_SYSTEM_ONE_DESCRIPTION_BYTES;
export const MAX_JEV_ALIAS_BYTES = MAX_SYSTEM_ONE_ALIAS_BYTES;
export const MAX_JEV_ALIASES = MAX_SYSTEM_ONE_ALIASES;
export const MAX_JEV_STATUS_BYTES = MAX_SYSTEM_ONE_STATUS_BYTES;
export const MAX_JEV_API_KEY_BYTES = MAX_SYSTEM_ONE_API_KEY_BYTES;

export interface JevRoutingEngineOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface JevRoutingConfig {
  apiKey: string;
  systemOne: SystemOneRoutingConfig;
}

type ConfigResult =
  | { kind: "disabled" }
  | { kind: "missing_key" }
  | { kind: "invalid_config" }
  | { kind: "ready"; config: JevRoutingConfig };

export function isJevRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ROUTING_PROVIDER_ENV] === "jev";
}

export function createJevRoutingEngine(
  options: JevRoutingEngineOptions = {},
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
          endpoint: JEV_ROUTING_ENDPOINT,
          model: JEV_ROUTING_MODEL,
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

function readConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (env[ROUTING_PROVIDER_ENV] !== "jev") return { kind: "disabled" };

  const rawKey = env[JEV_API_KEY_ENV];
  const apiKey = rawKey?.trim();
  if (!apiKey) return { kind: "missing_key" };
  if (systemOneByteLength(apiKey) > MAX_JEV_API_KEY_BYTES) {
    return { kind: "invalid_config" };
  }

  const systemConfig = readSystemOneConfig(env);
  if (systemConfig.kind !== "ready") return systemConfig;
  return {
    kind: "ready",
    config: {
      apiKey,
      systemOne: systemConfig.config,
    },
  };
}

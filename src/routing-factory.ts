import { createJevRoutingEngine } from "./jev-routing";
import {
  ROUTING_PROVIDER_ENV,
  type RoutingEngine,
  type RoutingProvider,
} from "./routing-engine";

export interface RoutingEngineFactoryOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export function configuredRoutingProvider(
  env: NodeJS.ProcessEnv = process.env,
): RoutingProvider | undefined {
  const value = env[ROUTING_PROVIDER_ENV];
  return value === "jev" || value === "openjev" || value === "llm"
    ? value
    : undefined;
}

/**
 * Select the explicitly configured provider without making routing semantics
 * depend on a provider-specific adapter. Only the direct Jev adapter exists
 * in this release; other provider names remain deliberately inactive.
 */
export function createRoutingEngine(
  options: RoutingEngineFactoryOptions = {},
): RoutingEngine | undefined {
  const env = options.env ?? process.env;
  switch (configuredRoutingProvider(env)) {
    case "jev":
      return createJevRoutingEngine({ env, fetch: options.fetch });
    case "openjev":
    case "llm":
    case undefined:
      return undefined;
  }
}

export function isRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return createRoutingEngine({ env }) !== undefined;
}

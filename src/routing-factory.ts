import {
  createJevRoutingEngine,
  isJevRoutingConfigured,
  type JevRoutingEngineOptions,
} from "./jev-routing";
import type { RoutingEngine } from "./routing-engine";

export type RoutingEngineFactoryOptions = JevRoutingEngineOptions;
export const isRoutingConfigured = isJevRoutingConfigured;

/** Native Pi classification is the sole backend; no external fallback. */
export function createRoutingEngine(
  options: RoutingEngineFactoryOptions = {},
): RoutingEngine | undefined {
  if (!isRoutingConfigured(options.env)) return undefined;
  return createJevRoutingEngine(options);
}

export function isRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
  modelRegistry?: unknown,
): boolean {
  return createRoutingEngine({ env, modelRegistry }) !== undefined;
}

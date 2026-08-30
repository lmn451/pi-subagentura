import type { Parameters } from "fast-check";

const DEFAULT_PROPERTY_RUNS = 100;
const MAX_PROPERTY_RUNS = 10_000;
const DEFAULT_PROPERTY_SEED = 424_242;
const MIN_SEED = -0x80000000;
const MAX_SEED = 0x7fffffff;

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function propertyParameters(): Parameters<unknown> {
  const numRuns = boundedInteger(
    "FC_NUM_RUNS",
    DEFAULT_PROPERTY_RUNS,
    1,
    MAX_PROPERTY_RUNS,
  );
  const seed = boundedInteger(
    "FC_SEED",
    DEFAULT_PROPERTY_SEED,
    MIN_SEED,
    MAX_SEED,
  );
  const path = process.env.FC_PATH;
  return { numRuns, seed, ...(path ? { path } : {}) };
}

export type DurableValue =
  | null
  | boolean
  | number
  | string
  | DurableValue[]
  | { [key: string]: DurableValue };

const MAX_DURABLE_VALUE_BYTES = 256 * 1024;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,128}$/;

export function toDurableValue(
  value: unknown,
  path = "$",
  seen = new Set<unknown>(),
): DurableValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid durable number at ${path}`);
    }
    return value;
  }
  if (typeof value !== "object" || seen.has(value))
    throw new Error(`Invalid durable value at ${path}`);
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item, index) =>
      toDurableValue(item, `${path}[${index}]`, seen),
    );
  const output: { [key: string]: DurableValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_KEY.test(key))
      throw new Error(`Invalid durable key at ${path}.${key}`);
    output[key] = toDurableValue(item, `${path}.${key}`, seen);
  }
  return output;
}

export function encodeDurableValue(value: unknown): string {
  const encoded = JSON.stringify(toDurableValue(value));
  if (Buffer.byteLength(encoded, "utf8") > MAX_DURABLE_VALUE_BYTES) {
    throw new Error(`Durable value exceeds ${MAX_DURABLE_VALUE_BYTES} bytes`);
  }
  return encoded;
}

export function decodeDurableValue(encoded: string): DurableValue {
  return toDurableValue(JSON.parse(encoded));
}

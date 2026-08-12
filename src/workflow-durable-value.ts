import { createHash, type Hash } from "node:crypto";
import { isProxy } from "node:util/types";

export type DurablePrimitive = null | boolean | number | string;

export type DurableValue =
  | DurablePrimitive
  | readonly DurableValue[]
  | { readonly [key: string]: DurableValue };

export interface DurableValueLimits {
  /** Maximum path depth below the root value. The root has depth zero. */
  readonly maxDepth: number;
  /** Maximum number of values, including the root and repeated shared values. */
  readonly maxNodes: number;
  /** Maximum UTF-8 byte length of any string value or object key. */
  readonly maxStringBytes: number;
  /** Maximum UTF-8 byte length of the canonical JSON encoding. */
  readonly maxBytes: number;
}

export type DurableValueOptions = Partial<DurableValueLimits>;

export const DEFAULT_DURABLE_VALUE_LIMITS: Readonly<DurableValueLimits> =
  Object.freeze({
    maxDepth: 64,
    maxNodes: 100_000,
    maxStringBytes: 256 * 1024,
    maxBytes: 1024 * 1024,
  });

export type DurableValueErrorCode =
  | "invalid_limit"
  | "unsupported_type"
  | "non_finite_number"
  | "unsafe_number"
  | "cycle"
  | "accessor"
  | "non_enumerable_property"
  | "symbol_key"
  | "unsafe_key"
  | "sparse_array"
  | "array_property"
  | "malformed_json"
  | "non_canonical"
  | "max_depth"
  | "max_nodes"
  | "max_string_bytes"
  | "max_bytes";

export interface EncodedDurableValue {
  /** Canonical JSON, with object keys ordered by UTF-16 code units. */
  readonly json: string;
  /** UTF-8 byte length of `json`. */
  readonly bytes: number;
  /** Lowercase SHA-256 hex digest of the UTF-8 bytes of `json`. */
  readonly sha256: string;
}

export class DurableValueError extends Error {
  readonly code: DurableValueErrorCode;
  readonly path: string;
  readonly limit?: number;
  readonly actual?: number;

  constructor(
    code: DurableValueErrorCode,
    message: string,
    options: {
      path?: string;
      limit?: number;
      actual?: number;
    } = {},
  ) {
    super(message);
    this.name = "DurableValueError";
    this.code = code;
    this.path = options.path ?? "$";
    this.limit = options.limit;
    this.actual = options.actual;
  }
}

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type PathSegment = string | number;

export function resolveDurableValueLimits(
  options: DurableValueOptions = {},
): DurableValueLimits {
  const limits: DurableValueLimits = {
    maxDepth: options.maxDepth ?? DEFAULT_DURABLE_VALUE_LIMITS.maxDepth,
    maxNodes: options.maxNodes ?? DEFAULT_DURABLE_VALUE_LIMITS.maxNodes,
    maxStringBytes:
      options.maxStringBytes ?? DEFAULT_DURABLE_VALUE_LIMITS.maxStringBytes,
    maxBytes: options.maxBytes ?? DEFAULT_DURABLE_VALUE_LIMITS.maxBytes,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DurableValueError(
        "invalid_limit",
        `${name} must be a non-negative safe integer.`,
        { actual: value },
      );
    }
  }

  return limits;
}

/**
 * Validate and canonically encode a durable value in one bounded traversal.
 * Shared (but acyclic) references are encoded at each position, as JSON values
 * are trees; only references on the active ancestor path are cycles.
 */
export function encodeDurableValue(
  value: unknown,
  options: DurableValueOptions = {},
): EncodedDurableValue {
  return new DurableValueEncoder(
    resolveDurableValueLimits(options),
    true,
    true,
  ).encode(value);
}

/** Validate a value against the durable JSON contract. */
export function validateDurableValue(
  value: unknown,
  options: DurableValueOptions = {},
): asserts value is DurableValue {
  new DurableValueEncoder(
    resolveDurableValueLimits(options),
    false,
    false,
  ).validate(value);
}

/** Return the digest of the canonical durable JSON encoding. */
export function digestDurableValue(
  value: unknown,
  options: DurableValueOptions = {},
): string {
  return new DurableValueEncoder(
    resolveDurableValueLimits(options),
    false,
    true,
  ).digest(value);
}

/**
 * Decode owned JSON data and reject any representation that is not already the
 * canonical encoding. JSON.parse creates the returned object graph, so it never
 * aliases mutable state owned by the caller.
 */
export function decodeDurableValue(
  input: string | Uint8Array,
  options: DurableValueOptions = {},
): DurableValue {
  const limits = resolveDurableValueLimits(options);
  const json = decodeJsonInput(input, limits.maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DurableValueError("malformed_json", "Malformed durable JSON.");
  }

  const canonicalJson = new DurableValueEncoder(
    limits,
    true,
    false,
  ).canonicalJson(parsed);
  if (canonicalJson !== json) {
    throw new DurableValueError(
      "non_canonical",
      "Durable JSON is valid but not canonically encoded.",
    );
  }
  return parsed as DurableValue;
}

class DurableValueEncoder {
  private readonly chunks: string[] | undefined;
  private readonly hash: Hash | undefined;
  private readonly ancestors = new WeakSet<object>();
  private readonly path: PathSegment[] = [];
  private nodeCount = 0;
  private byteCount = 0;

  constructor(
    private readonly limits: DurableValueLimits,
    collectJson: boolean,
    computeHash: boolean,
  ) {
    this.chunks = collectJson ? [] : undefined;
    this.hash = computeHash ? createHash("sha256") : undefined;
  }

  encode(value: unknown): EncodedDurableValue {
    this.visit(value, 0);
    return {
      json: this.chunks!.join(""),
      bytes: this.byteCount,
      sha256: this.hash!.digest("hex"),
    };
  }

  validate(value: unknown): void {
    this.visit(value, 0);
  }

  digest(value: unknown): string {
    this.visit(value, 0);
    return this.hash!.digest("hex");
  }

  canonicalJson(value: unknown): string {
    this.visit(value, 0);
    return this.chunks!.join("");
  }

  private visit(value: unknown, depth: number): void {
    this.consumeNode(depth);

    if (value === null) {
      this.append("null");
      return;
    }

    switch (typeof value) {
      case "boolean":
        this.append(value ? "true" : "false");
        return;
      case "number":
        this.appendNumber(value);
        return;
      case "string":
        this.appendString(value);
        return;
      case "object":
        this.appendObject(value, depth);
        return;
      case "bigint":
      case "function":
      case "symbol":
      case "undefined":
        this.fail(
          "unsupported_type",
          `Unsupported durable value type: ${typeof value}.`,
        );
    }
  }

  private consumeNode(depth: number): void {
    if (depth > this.limits.maxDepth) {
      this.fail(
        "max_depth",
        `Durable value exceeds maxDepth (${depth} > ${this.limits.maxDepth}).`,
        this.limits.maxDepth,
        depth,
      );
    }

    const nextCount = this.nodeCount + 1;
    if (nextCount > this.limits.maxNodes) {
      this.fail(
        "max_nodes",
        `Durable value exceeds maxNodes (${nextCount} > ${this.limits.maxNodes}).`,
        this.limits.maxNodes,
        nextCount,
      );
    }
    this.nodeCount = nextCount;
  }

  private appendNumber(value: number): void {
    if (!Number.isFinite(value)) {
      this.fail("non_finite_number", "Durable numbers must be finite.");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      this.fail(
        "unsafe_number",
        "Durable integer values must be safe integers.",
      );
    }

    this.append(String(value));
  }

  private appendString(value: string): void {
    const stringBytes = Buffer.byteLength(value, "utf8");
    if (stringBytes > this.limits.maxStringBytes) {
      this.fail(
        "max_string_bytes",
        `Durable string exceeds maxStringBytes (${stringBytes} > ${this.limits.maxStringBytes}).`,
        this.limits.maxStringBytes,
        stringBytes,
      );
    }
    const remaining = this.limits.maxBytes - this.byteCount;
    const minimumBytes = stringBytes + 2;
    if (minimumBytes > remaining) {
      this.fail(
        "max_bytes",
        `Durable value exceeds maxBytes (at least ${this.byteCount + minimumBytes} > ${this.limits.maxBytes}).`,
        this.limits.maxBytes,
        this.byteCount + minimumBytes,
      );
    }
    const encoded = JSON.stringify(value);
    this.append(encoded);
  }

  private appendObject(value: object, depth: number): void {
    if (isProxy(value)) {
      this.fail("unsupported_type", "Proxy objects are not durable values.");
    }

    if (Array.isArray(value)) {
      this.appendArray(value, depth);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      this.fail(
        "unsupported_type",
        "Only arrays and plain objects are durable object values.",
      );
    }

    this.appendPlainObject(value as Record<string, unknown>, depth);
  }

  private appendArray(value: unknown[], depth: number): void {
    this.enterContainer(value);
    try {
      this.reserveChildNodes(value.length);
      if (Object.getOwnPropertySymbols(value).length > 0) {
        this.fail("symbol_key", "Symbol-keyed properties are not durable.");
      }

      const propertyNames = Object.getOwnPropertyNames(value);
      for (const key of propertyNames) {
        if (key === "length" || isCanonicalArrayIndex(key, value.length)) {
          continue;
        }
        this.withPath(key, () => {
          if (UNSAFE_OBJECT_KEYS.has(key)) {
            this.fail(
              "unsafe_key",
              `Unsafe durable object key: ${JSON.stringify(key)}.`,
            );
          }
          this.fail(
            "array_property",
            `Non-index array property is not durable: ${JSON.stringify(key)}.`,
          );
        });
      }

      if (propertyNames.length !== value.length + 1) {
        this.fail("sparse_array", "Sparse arrays are not durable values.");
      }

      this.append("[");
      for (let index = 0; index < value.length; index++) {
        if (index > 0) this.append(",");
        this.withPath(index, () => {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (descriptor === undefined) {
            this.fail("sparse_array", "Sparse arrays are not durable values.");
          }
          this.assertDataProperty(descriptor);
          this.visit(descriptor.value, depth + 1);
        });
      }
      this.append("]");
    } finally {
      this.ancestors.delete(value);
    }
  }

  private appendPlainObject(
    value: Record<string, unknown>,
    depth: number,
  ): void {
    this.enterContainer(value);
    try {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        this.fail("symbol_key", "Symbol-keyed properties are not durable.");
      }

      const keys = Object.getOwnPropertyNames(value);
      this.reserveChildNodes(keys.length);
      keys.sort();

      this.append("{");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (index > 0) this.append(",");
        this.withPath(key, () => {
          if (UNSAFE_OBJECT_KEYS.has(key)) {
            this.fail(
              "unsafe_key",
              `Unsafe durable object key: ${JSON.stringify(key)}.`,
            );
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined) {
            this.fail(
              "unsupported_type",
              "Durable object shape changed during encoding.",
            );
          }
          this.assertDataProperty(descriptor);
          this.appendString(key);
          this.append(":");
          this.visit(descriptor.value, depth + 1);
        });
      }
      this.append("}");
    } finally {
      this.ancestors.delete(value);
    }
  }

  private reserveChildNodes(count: number): void {
    if (count > this.limits.maxNodes - this.nodeCount) {
      const actual = this.nodeCount + count;
      this.fail(
        "max_nodes",
        `Durable value exceeds maxNodes (${actual} > ${this.limits.maxNodes}).`,
        this.limits.maxNodes,
        actual,
      );
    }
  }

  private enterContainer(value: object): void {
    if (this.ancestors.has(value)) {
      this.fail("cycle", "Cyclic values are not durable.");
    }
    this.ancestors.add(value);
  }

  private assertDataProperty(descriptor: PropertyDescriptor): void {
    if ("get" in descriptor || "set" in descriptor) {
      this.fail("accessor", "Accessor properties are not durable.");
    }
    if (!descriptor.enumerable) {
      this.fail(
        "non_enumerable_property",
        "Non-enumerable properties are not durable.",
      );
    }
  }

  private withPath(segment: PathSegment, action: () => void): void {
    this.path.push(segment);
    try {
      action();
    } finally {
      this.path.pop();
    }
  }

  private append(text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    const nextByteCount = this.byteCount + bytes;
    if (nextByteCount > this.limits.maxBytes) {
      this.fail(
        "max_bytes",
        `Durable value exceeds maxBytes (${nextByteCount} > ${this.limits.maxBytes}).`,
        this.limits.maxBytes,
        nextByteCount,
      );
    }
    this.byteCount = nextByteCount;
    this.chunks?.push(text);
    this.hash?.update(text, "utf8");
  }

  private fail(
    code: DurableValueErrorCode,
    message: string,
    limit?: number,
    actual?: number,
  ): never {
    throw new DurableValueError(code, message, {
      path: formatPath(this.path),
      limit,
      actual,
    });
  }
}

function decodeJsonInput(input: string | Uint8Array, maxBytes: number): string {
  if (typeof input === "string") {
    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes > maxBytes) {
      throw new DurableValueError(
        "max_bytes",
        `Durable JSON exceeds maxBytes (${bytes} > ${maxBytes}).`,
        { limit: maxBytes, actual: bytes },
      );
    }
    return input;
  }

  if (!(input instanceof Uint8Array)) {
    throw new DurableValueError(
      "unsupported_type",
      "Durable JSON input must be a string or Uint8Array.",
    );
  }
  if (input.byteLength > maxBytes) {
    throw new DurableValueError(
      "max_bytes",
      `Durable JSON exceeds maxBytes (${input.byteLength} > ${maxBytes}).`,
      { limit: maxBytes, actual: input.byteLength },
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new DurableValueError(
      "malformed_json",
      "Durable JSON is not valid UTF-8.",
    );
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function formatPath(path: readonly PathSegment[]): string {
  let result = "$";
  for (const segment of path) {
    result +=
      typeof segment === "number"
        ? `[${segment}]`
        : `[${JSON.stringify(segment)}]`;
  }
  return result;
}

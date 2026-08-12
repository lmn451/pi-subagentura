import { describe, expect, it } from "vitest";
import {
  DurableValueError,
  decodeDurableValue,
  digestDurableValue,
  encodeDurableValue,
  resolveDurableValueLimits,
  validateDurableValue,
  type DurableValueErrorCode,
} from "../src/workflow-durable-value";

function expectDurableError(
  action: () => unknown,
  code: DurableValueErrorCode,
  path?: string,
): DurableValueError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(DurableValueError);
  expect(caught).toMatchObject({
    code,
    ...(path === undefined ? {} : { path }),
  });
  return caught as DurableValueError;
}

describe("durable value canonical encoding", () => {
  it("orders object keys recursively and produces a stable digest", () => {
    const first = {
      z: { y: true, a: null },
      a: [{ d: 4, b: 2 }],
    };
    const second = {
      a: [{ b: 2, d: 4 }],
      z: { a: null, y: true },
    };

    const firstEncoded = encodeDurableValue(first);
    const secondEncoded = encodeDurableValue(second);

    expect(firstEncoded).toEqual(secondEncoded);
    expect(firstEncoded.json).toBe(
      '{"a":[{"b":2,"d":4}],"z":{"a":null,"y":true}}',
    );
    expect(firstEncoded.bytes).toBe(
      Buffer.byteLength(firstEncoded.json, "utf8"),
    );
    expect(firstEncoded.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(digestDurableValue(second)).toBe(firstEncoded.sha256);
  });

  it("matches a known SHA-256 digest", () => {
    expect(encodeDurableValue({ b: 2, a: 1 })).toEqual({
      json: '{"a":1,"b":2}',
      bytes: 13,
      sha256:
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    });
  });

  it("supports every durable value category", () => {
    const withoutPrototype = Object.create(null) as Record<string, unknown>;
    withoutPrototype.z = "last";
    withoutPrototype.a = "first";

    expect(encodeDurableValue(null).json).toBe("null");
    expect(encodeDurableValue(true).json).toBe("true");
    expect(encodeDurableValue(false).json).toBe("false");
    expect(encodeDurableValue(-0).json).toBe("0");
    expect(encodeDurableValue(Number.MIN_VALUE).json).toBe("5e-324");
    expect(encodeDurableValue(1.25).json).toBe("1.25");
    expect(encodeDurableValue(Number.MAX_SAFE_INTEGER).json).toBe(
      "9007199254740991",
    );
    expect(encodeDurableValue('line\n"quoted"').json).toBe(
      '"line\\n\\"quoted\\""',
    );
    expect(encodeDurableValue([null, true, 1, "x"]).json).toBe(
      '[null,true,1,"x"]',
    );
    expect(encodeDurableValue(withoutPrototype).json).toBe(
      '{"a":"first","z":"last"}',
    );
    expect(() => validateDurableValue({ nested: [1, 2, 3] })).not.toThrow();
  });

  it("accepts repeated acyclic references and counts each occurrence", () => {
    const shared = { value: 1 };
    expect(encodeDurableValue([shared, shared]).json).toBe(
      '[{"value":1},{"value":1}]',
    );
    expectDurableError(
      () => encodeDurableValue([shared, shared], { maxNodes: 4 }),
      "max_nodes",
    );
  });
});

describe("durable value forbidden inputs", () => {
  it.each([
    ["undefined", undefined],
    ["BigInt", BigInt(1)],
    ["function", () => 1],
    ["symbol", Symbol("value")],
  ])("rejects %s values", (_label, value) => {
    expectDurableError(
      () => encodeDurableValue({ value }),
      "unsupported_type",
      '$["value"]',
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite number %s",
    (value) => {
      expectDurableError(
        () => encodeDurableValue(value),
        "non_finite_number",
        "$",
      );
    },
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 1e100])(
    "rejects unsafe number %s",
    (value) => {
      expectDurableError(() => encodeDurableValue(value), "unsafe_number", "$");
    },
  );

  it.each([
    ["class instance", new (class Example {})()],
    ["Map", new Map([["key", "value"]])],
    ["Set", new Set([1])],
    ["typed array", new Uint8Array([1, 2])],
    ["DataView", new DataView(new ArrayBuffer(1))],
    ["Date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expectDurableError(
      () => encodeDurableValue(value),
      "unsupported_type",
      "$",
    );
  });

  it("rejects proxy objects before invoking their reflection traps", () => {
    let traps = 0;
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps++;
          return Object.prototype;
        },
        ownKeys() {
          traps++;
          return [];
        },
      },
    );

    expectDurableError(
      () => encodeDurableValue(value),
      "unsupported_type",
      "$",
    );
    expect(traps).toBe(0);
  });

  it("rejects symbol-keyed properties", () => {
    const value = { ok: true, [Symbol("hidden")]: 1 };
    expectDurableError(() => encodeDurableValue(value), "symbol_key", "$");
  });

  it("rejects non-enumerable properties instead of silently dropping them", () => {
    const value = { visible: true };
    Object.defineProperty(value, "hidden", {
      value: 1,
      enumerable: false,
    });

    expectDurableError(
      () => encodeDurableValue(value),
      "non_enumerable_property",
      '$["hidden"]',
    );
  });

  it("rejects sparse arrays and non-index array properties", () => {
    const sparse = new Array(2);
    sparse[1] = "present";
    expectDurableError(() => encodeDurableValue(sparse), "sparse_array", "$");

    const withProperty = [1] as unknown[] & { extra?: boolean };
    withProperty.extra = true;
    expectDurableError(
      () => encodeDurableValue(withProperty),
      "array_property",
      '$["extra"]',
    );
  });
});

describe("durable value cycles and descriptors", () => {
  it("rejects object and array cycles with the offending path", () => {
    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    expectDurableError(
      () => encodeDurableValue(objectCycle),
      "cycle",
      '$["self"]',
    );

    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    expectDurableError(() => encodeDurableValue(arrayCycle), "cycle", "$[0]");
  });

  it("rejects object accessors without invoking them", () => {
    let getterCalls = 0;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error("must not run");
      },
    });

    expectDurableError(
      () => encodeDurableValue(value),
      "accessor",
      '$["secret"]',
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects array accessors without invoking them", () => {
    let getterCalls = 0;
    const value: unknown[] = [];
    Object.defineProperty(value, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls++;
        return "must not run";
      },
    });

    expectDurableError(() => encodeDurableValue(value), "accessor", "$[0]");
    expect(getterCalls).toBe(0);
  });
});

describe("durable value prototype-pollution keys", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the %s key",
    (key) => {
      const value = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(value, key, {
        value: "blocked",
        enumerable: true,
      });

      expectDurableError(
        () => encodeDurableValue(value),
        "unsafe_key",
        `$[${JSON.stringify(key)}]`,
      );
    },
  );

  it("rejects unsafe keys while decoding", () => {
    expectDurableError(
      () => decodeDurableValue('{"__proto__":true}'),
      "unsafe_key",
      '$["__proto__"]',
    );
  });
});

describe("durable value limits", () => {
  it("enforces depth with root depth zero", () => {
    expect(encodeDurableValue({ value: 1 }, { maxDepth: 1 }).json).toBe(
      '{"value":1}',
    );
    const error = expectDurableError(
      () => encodeDurableValue({ nested: { value: 1 } }, { maxDepth: 1 }),
      "max_depth",
      '$["nested"]["value"]',
    );
    expect(error).toMatchObject({ limit: 1, actual: 2 });
  });

  it("enforces the total expanded node count", () => {
    expect(encodeDurableValue([1, 2], { maxNodes: 3 }).json).toBe("[1,2]");
    const error = expectDurableError(
      () => encodeDurableValue([1, 2], { maxNodes: 2 }),
      "max_nodes",
      "$",
    );
    expect(error).toMatchObject({ limit: 2, actual: 3 });
  });

  it("enforces canonical UTF-8 bytes at the boundary", () => {
    expect(encodeDurableValue("é", { maxBytes: 4 })).toMatchObject({
      json: '"é"',
      bytes: 4,
    });
    const error = expectDurableError(
      () => encodeDurableValue("é", { maxBytes: 3 }),
      "max_bytes",
      "$",
    );
    expect(error).toMatchObject({ limit: 3, actual: 4 });
  });

  it.each([{ maxDepth: -1 }, { maxNodes: 1.5 }, { maxBytes: Infinity }])(
    "rejects invalid limits %#",
    (limits) => {
      expectDurableError(
        () => resolveDurableValueLimits(limits),
        "invalid_limit",
        "$",
      );
    },
  );
});

describe("durable value decoding", () => {
  it("decodes canonical strings and UTF-8 bytes into owned values", () => {
    const json = '{"a":[1,true],"z":"é"}';
    const bytes = new TextEncoder().encode(json);
    const fromString = decodeDurableValue(json);
    const fromBytes = decodeDurableValue(bytes);

    expect(fromString).toEqual({ a: [1, true], z: "é" });
    expect(fromBytes).toEqual(fromString);
    bytes.fill(0);
    expect(fromBytes).toEqual({ a: [1, true], z: "é" });
  });

  it.each([
    ["whitespace", '{"a": 1}'],
    ["key order", '{"b":2,"a":1}'],
    ["duplicate key", '{"a":1,"a":1}'],
    ["negative zero", "-0"],
  ])("rejects non-canonical %s", (_label, json) => {
    expectDurableError(() => decodeDurableValue(json), "non_canonical", "$");
  });

  it("rejects malformed JSON and invalid UTF-8", () => {
    expectDurableError(() => decodeDurableValue("{"), "malformed_json", "$");
    expectDurableError(
      () => decodeDurableValue(new Uint8Array([0xff])),
      "malformed_json",
      "$",
    );
  });

  it("applies byte, depth, node, and numeric limits to decoded input", () => {
    expectDurableError(
      () => decodeDurableValue("null", { maxBytes: 3 }),
      "max_bytes",
      "$",
    );
    expectDurableError(
      () => decodeDurableValue('{"a":{"b":1}}', { maxDepth: 1 }),
      "max_depth",
      '$["a"]["b"]',
    );
    expectDurableError(
      () => decodeDurableValue("[1,2]", { maxNodes: 2 }),
      "max_nodes",
      "$",
    );
    expectDurableError(
      () => decodeDurableValue("9007199254740992"),
      "unsafe_number",
      "$",
    );
  });
});

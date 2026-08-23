/**
 * Tests for TypeBox parameter schemas.
 *
 * Uses typebox 1.x Schema.Compile for runtime validation:
 *   - compiled.Check(value) → boolean
 *   - compiled.Errors(value) → [isValid, error[]]
 *   - compiled.Parse(value) → decoded value (throws ParseError on invalid)
 */
import { describe, expect, it } from "vitest";
import Schema, { type XSchema } from "typebox/schema";

import {
  BaseParams,
  CancelParams,
  InteractiveParams,
  ResultParams,
  StatusParams,
} from "../src/schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compile a schema and return its Check function. */
function check(schema: XSchema) {
  return Schema.Compile(schema).Check.bind(Schema.Compile(schema));
}

/** Compile a schema and return its Errors function (returns [valid, errors[]]). */
function errors(schema: XSchema) {
  return Schema.Compile(schema).Errors.bind(Schema.Compile(schema));
}

/** Compile a schema and return its Parse function. */
function parse(schema: XSchema) {
  return Schema.Compile(schema).Parse.bind(Schema.Compile(schema));
}

/** Collect error messages only (skip the valid/invalid flag). */
function collectErrorMessages(schema: XSchema, value: unknown): string[] {
  const [, errs] = Schema.Compile(schema).Errors(value);
  return errs.map((e: { message: string }) => e.message);
}

/** Reproduce Pi 0.80.6's Anthropic convertTools top-level schema projection. */
function piAnthropicInputSchema(schema: any) {
  return {
    type: "object",
    properties: schema.properties ?? {},
    required: schema.required ?? [],
  };
}

// ---------------------------------------------------------------------------
// BaseParams
// ---------------------------------------------------------------------------

describe("BaseParams", () => {
  /* ---------- required `task` ---------- */

  it("passes with required task only", () => {
    expect(check(BaseParams)({ task: "do something" })).toBe(true);
  });

  it("passes with task and all optionals", () => {
    const value = {
      task: "refactor module X",
      persona: "You are a senior engineer",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high" as const,
      cwd: "/home/user/project",
      async: true,
      notifyOnComplete: "inject" as const,
      maxAge: 60_000,
    };
    expect(check(BaseParams)(value)).toBe(true);
  });

  it("fails when task is missing", () => {
    expect(check(BaseParams)({})).toBe(false);
  });

  it("fails when task has wrong type (number)", () => {
    expect(check(BaseParams)({ task: 42 })).toBe(false);
  });

  it("fails when task has wrong type (null)", () => {
    expect(check(BaseParams)({ task: null })).toBe(false);
  });

  it("fails when task has wrong type (object)", () => {
    expect(check(BaseParams)({ task: { ref: "x" } })).toBe(false);
  });

  it("errors for missing task include 'required' message", () => {
    const msgs = collectErrorMessages(BaseParams, {});
    expect(msgs.some((m) => /required/i.test(m))).toBe(true);
  });

  it("errors for wrong task type include 'string' keyword", () => {
    const msgs = collectErrorMessages(BaseParams, { task: 42 });
    expect(msgs.some((m) => /string/i.test(m))).toBe(true);
  });

  /* ---------- optional `persona` ---------- */

  it("accepts missing persona", () => {
    expect(check(BaseParams)({ task: "t" })).toBe(true);
  });

  it("accepts persona as string", () => {
    expect(check(BaseParams)({ task: "t", persona: "A reviewer" })).toBe(true);
  });

  it("rejects persona as number", () => {
    expect(check(BaseParams)({ task: "t", persona: 123 })).toBe(false);
  });

  it("rejects persona as boolean", () => {
    expect(check(BaseParams)({ task: "t", persona: true })).toBe(false);
  });

  /* ---------- optional `model` ---------- */

  it("accepts missing model", () => {
    expect(check(BaseParams)({ task: "t" })).toBe(true);
  });

  it("accepts model as string", () => {
    expect(check(BaseParams)({ task: "t", model: "openai/gpt-4o" })).toBe(true);
  });

  it("rejects model as number", () => {
    expect(check(BaseParams)({ task: "t", model: 1 })).toBe(false);
  });

  it("accepts Pi thinking levels and rejects unknown values", () => {
    for (const thinkingLevel of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      expect(check(BaseParams)({ task: "t", thinkingLevel })).toBe(true);
    }
    expect(check(BaseParams)({ task: "t", thinkingLevel: "extreme" })).toBe(
      false,
    );
  });

  /* ---------- optional `cwd` ---------- */

  it("accepts missing cwd", () => {
    expect(check(BaseParams)({ task: "t" })).toBe(true);
  });

  it("accepts cwd as string", () => {
    expect(check(BaseParams)({ task: "t", cwd: "/tmp" })).toBe(true);
  });

  it("rejects cwd as array", () => {
    expect(check(BaseParams)({ task: "t", cwd: ["/tmp"] })).toBe(false);
  });

  /* ---------- optional `async` (boolean) ---------- */

  it("accepts missing async", () => {
    expect(check(BaseParams)({ task: "t" })).toBe(true);
  });

  it("accepts async as true", () => {
    expect(check(BaseParams)({ task: "t", async: true })).toBe(true);
  });

  it("accepts async as false", () => {
    expect(check(BaseParams)({ task: "t", async: false })).toBe(true);
  });

  it("rejects async as string", () => {
    expect(check(BaseParams)({ task: "t", async: "yes" })).toBe(false);
  });

  it("rejects async as number", () => {
    expect(check(BaseParams)({ task: "t", async: 1 })).toBe(false);
  });

  it("rejects async as null", () => {
    expect(check(BaseParams)({ task: "t", async: null })).toBe(false);
  });

  /* ---------- optional `notifyOnComplete` (union "notify" | "inject") ---------- */

  it("accepts missing notifyOnComplete", () => {
    expect(check(BaseParams)({ task: "t" })).toBe(true);
  });

  it("accepts notifyOnComplete 'notify'", () => {
    expect(
      check(BaseParams)({ task: "t", notifyOnComplete: "notify" as const }),
    ).toBe(true);
  });

  it("accepts notifyOnComplete 'inject'", () => {
    expect(
      check(BaseParams)({ task: "t", notifyOnComplete: "inject" as const }),
    ).toBe(true);
  });

  it("rejects notifyOnComplete 'push'", () => {
    expect(check(BaseParams)({ task: "t", notifyOnComplete: "push" })).toBe(
      false,
    );
  });

  it("rejects notifyOnComplete empty string", () => {
    expect(check(BaseParams)({ task: "t", notifyOnComplete: "" })).toBe(false);
  });

  it("rejects notifyOnComplete number", () => {
    expect(check(BaseParams)({ task: "t", notifyOnComplete: 0 })).toBe(false);
  });

  it("rejects notifyOnComplete boolean", () => {
    expect(check(BaseParams)({ task: "t", notifyOnComplete: true })).toBe(
      false,
    );
  });

  it("produces meaningful errors for invalid notifyOnComplete", () => {
    const msgs = collectErrorMessages(BaseParams, {
      task: "t",
      notifyOnComplete: "bad",
    });
    expect(
      msgs.some((m) => /notify|inject|constant|equal|anyOf/i.test(m)),
    ).toBe(true);
  });

  /* ---------- optional `maxAge` (number) ---------- */

  it("accepts missing maxAge", () => {
    expect(check(BaseParams)({ task: "t" })).toBe(true);
  });

  it("accepts maxAge as positive integer", () => {
    expect(check(BaseParams)({ task: "t", maxAge: 5000 })).toBe(true);
  });

  it("accepts maxAge as zero", () => {
    expect(check(BaseParams)({ task: "t", maxAge: 0 })).toBe(true);
  });

  it("accepts maxAge as negative number", () => {
    // The schema is `Type.Number()` with no min constraint, so negative is valid
    expect(check(BaseParams)({ task: "t", maxAge: -1 })).toBe(true);
  });

  it("accepts maxAge as float", () => {
    expect(check(BaseParams)({ task: "t", maxAge: 1.5 })).toBe(true);
  });

  it("rejects maxAge as string", () => {
    expect(check(BaseParams)({ task: "t", maxAge: "5000" })).toBe(false);
  });

  it("rejects maxAge as boolean", () => {
    expect(check(BaseParams)({ task: "t", maxAge: true })).toBe(false);
  });

  it("rejects maxAge as null", () => {
    expect(check(BaseParams)({ task: "t", maxAge: null })).toBe(false);
  });

  it("rejects maxAge as object", () => {
    expect(check(BaseParams)({ task: "t", maxAge: {} })).toBe(false);
  });

  /* ---------- edge: empty/null/undefined input ---------- */

  it("rejects null input", () => {
    expect(check(BaseParams)(null)).toBe(false);
  });

  it("rejects undefined input", () => {
    expect(check(BaseParams)(undefined)).toBe(false);
  });

  it("rejects array input", () => {
    expect(check(BaseParams)([])).toBe(false);
  });

  it("rejects string input", () => {
    expect(check(BaseParams)("hello")).toBe(false);
  });

  /* ---------- Error shape ---------- */

  it("Errors returns [false, error[]] for invalid input", () => {
    const [valid, errs] = Schema.Compile(BaseParams).Errors({ task: 42 });
    expect(valid).toBe(false);
    expect(Array.isArray(errs)).toBe(true);
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) {
      expect(e).toHaveProperty("keyword");
      expect(e).toHaveProperty("schemaPath");
      expect(e).toHaveProperty("instancePath");
      expect(e).toHaveProperty("message");
    }
  });

  it("Errors returns [true, []] for valid input", () => {
    const [valid, errs] = Schema.Compile(BaseParams).Errors({
      task: "hello",
    });
    expect(valid).toBe(true);
    expect(errs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// StatusParams / ResultParams / CancelParams (identical shape)
// ---------------------------------------------------------------------------

function runJobIdTests(label: string, schema: XSchema) {
  describe(label, () => {
    it("passes with a valid jobId string", () => {
      expect(check(schema)({ jobId: "job_abc123" })).toBe(true);
    });

    it("passes with an empty jobId string", () => {
      // The schema is `Type.String()` with no minLength, so empty passes
      expect(check(schema)({ jobId: "" })).toBe(true);
    });

    it("fails when jobId is missing", () => {
      expect(check(schema)({})).toBe(false);
    });

    it("fails when jobId is a number", () => {
      expect(check(schema)({ jobId: 123 })).toBe(false);
    });

    it("fails when jobId is a boolean", () => {
      expect(check(schema)({ jobId: true })).toBe(false);
    });

    it("fails when jobId is null", () => {
      expect(check(schema)({ jobId: null })).toBe(false);
    });

    it("fails when jobId is an object", () => {
      expect(check(schema)({ jobId: { id: "x" } })).toBe(false);
    });

    it("fails when jobId is an array", () => {
      expect(check(schema)({ jobId: ["x"] })).toBe(false);
    });

    it("fails on null input", () => {
      expect(check(schema)(null)).toBe(false);
    });

    it("fails on undefined input", () => {
      expect(check(schema)(undefined)).toBe(false);
    });

    it("error messages mention 'required' when jobId is missing", () => {
      const msgs = collectErrorMessages(schema, {});
      expect(msgs.some((m) => /required/i.test(m))).toBe(true);
    });
  });
}

runJobIdTests("StatusParams", StatusParams);
runJobIdTests("ResultParams", ResultParams);
runJobIdTests("CancelParams", CancelParams);

// ---------------------------------------------------------------------------
// InteractiveParams
// ---------------------------------------------------------------------------

describe("InteractiveParams", () => {
  /* ---------- required `task` ---------- */

  it("passes with required task only", () => {
    expect(check(InteractiveParams)({ task: "explore API" })).toBe(true);
  });

  it("passes with task and all optionals", () => {
    const value = {
      task: "debug memory leak",
      name: "Debugger",
      persona: "You are a debug specialist",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "xhigh" as const,
      cwd: "/workspace",
      includeContext: true,
      routingDescription: "Debug the memory leak",
      routingAliases: ["memory", "leak"],
      background: false,
      notifyOnComplete: "inject" as const,
      mux: "auto" as const,
    };
    expect(check(InteractiveParams)(value)).toBe(true);
  });

  it("fails when task is missing", () => {
    expect(check(InteractiveParams)({})).toBe(false);
  });

  it("fails when task has wrong type", () => {
    expect(check(InteractiveParams)({ task: false })).toBe(false);
  });

  it("fails when task is null", () => {
    expect(check(InteractiveParams)({ task: null })).toBe(false);
  });

  it("errors for missing task mention 'required'", () => {
    const msgs = collectErrorMessages(InteractiveParams, {});
    expect(msgs.some((m) => /required/i.test(m))).toBe(true);
  });

  /* ---------- optional `name` ---------- */

  it("accepts missing name", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts name as string", () => {
    expect(check(InteractiveParams)({ task: "t", name: "My Agent" })).toBe(
      true,
    );
  });

  it("rejects name as boolean", () => {
    expect(check(InteractiveParams)({ task: "t", name: true })).toBe(false);
  });

  /* ---------- optional `persona` ---------- */

  it("accepts missing persona", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts persona as string", () => {
    expect(check(InteractiveParams)({ task: "t", persona: "A tester" })).toBe(
      true,
    );
  });

  it("rejects persona as number", () => {
    expect(check(InteractiveParams)({ task: "t", persona: 99 })).toBe(false);
  });

  /* ---------- optional `model` ---------- */

  it("accepts missing model", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts model as string", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        model: "gemini/gemini-2.5-pro",
      }),
    ).toBe(true);
  });

  it("rejects model as array", () => {
    expect(check(InteractiveParams)({ task: "t", model: [] })).toBe(false);
  });

  it("accepts Pi thinking levels and rejects unknown values", () => {
    for (const thinkingLevel of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      expect(check(InteractiveParams)({ task: "t", thinkingLevel })).toBe(true);
    }
    expect(
      check(InteractiveParams)({ task: "t", thinkingLevel: "extreme" }),
    ).toBe(false);
  });

  /* ---------- optional `cwd` ---------- */

  it("accepts missing cwd", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts cwd as string", () => {
    expect(check(InteractiveParams)({ task: "t", cwd: "/app" })).toBe(true);
  });

  it("rejects cwd as object", () => {
    expect(check(InteractiveParams)({ task: "t", cwd: { dir: "/" } })).toBe(
      false,
    );
  });

  /* ---------- discriminated context source ---------- */

  it("accepts missing includeContext", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts includeContext true", () => {
    expect(check(InteractiveParams)({ task: "t", includeContext: true })).toBe(
      true,
    );
  });

  it("accepts includeContext false", () => {
    expect(check(InteractiveParams)({ task: "t", includeContext: false })).toBe(
      true,
    );
  });

  it("accepts arbitrary explicit context only with includeContext false", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        includeContext: false,
        context: "User-provided handoff\nwith arbitrary detail.",
      }),
    ).toBe(true);
  });

  it("rejects explicit context without includeContext false", () => {
    expect(check(InteractiveParams)({ task: "t", context: "handoff" })).toBe(
      false,
    );
  });

  it("rejects explicit context with includeContext true", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        includeContext: true,
        context: "handoff",
      }),
    ).toBe(false);
  });

  it("rejects explicit context with a non-string value", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        includeContext: false,
        context: { handoff: true },
      }),
    ).toBe(false);
  });

  it("rejects includeContext as string", () => {
    expect(check(InteractiveParams)({ task: "t", includeContext: "yes" })).toBe(
      false,
    );
  });

  it("rejects includeContext as number", () => {
    expect(check(InteractiveParams)({ task: "t", includeContext: 1 })).toBe(
      false,
    );
  });

  it("declares common fields intersected with three strict context variants", () => {
    const schema = InteractiveParams as any;
    expect(schema.unevaluatedProperties).toBe(false);
    expect(schema.allOf).toHaveLength(2);

    const commonProperties = schema.allOf[0].properties;
    expect(commonProperties).toHaveProperty("task");
    expect(commonProperties).toHaveProperty("routingDescription");
    expect(commonProperties).toHaveProperty("routingAliases");
    expect(commonProperties).not.toHaveProperty("includeContext");
    expect(commonProperties).not.toHaveProperty("context");

    const variants = schema.allOf[1].anyOf;
    expect(variants).toHaveLength(3);
    expect(variants[0].properties.includeContext.const).toBe(true);
    expect(variants[0].properties).not.toHaveProperty("context");
    expect(variants[1].properties.includeContext.const).toBe(false);
    expect(variants[1].properties.context.type).toBe("string");
    expect(variants[2].properties).toEqual({});
  });

  it("exposes the full model-visible shape through Pi's Anthropic conversion", () => {
    const providerSchema = piAnthropicInputSchema(InteractiveParams);

    expect(providerSchema.required).toEqual(["task"]);
    expect(Object.keys(providerSchema.properties).sort()).toEqual(
      [
        "background",
        "context",
        "cwd",
        "includeContext",
        "model",
        "mux",
        "name",
        "notifyOnComplete",
        "persona",
        "routingAliases",
        "routingDescription",
        "task",
        "thinkingLevel",
        "triggerTurnOnComplete",
      ].sort(),
    );
    expect(providerSchema.properties.includeContext.type).toBe("boolean");
    expect(providerSchema.properties.context.type).toBe("string");
  });

  /* ---------- optional initial routing metadata ---------- */

  it("accepts an initial routing description and aliases", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        routingDescription: "Own the API migration",
        routingAliases: ["api", "migration"],
      }),
    ).toBe(true);
  });

  it("rejects empty routing descriptions and aliases", () => {
    expect(
      check(InteractiveParams)({ task: "t", routingDescription: "" }),
    ).toBe(false);
    expect(
      check(InteractiveParams)({
        task: "t",
        routingDescription: "Own the API migration",
        routingAliases: [""],
      }),
    ).toBe(false);
  });

  it("rejects unbounded routing aliases", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        routingDescription: "Own the API migration",
        routingAliases: Array.from({ length: 17 }, (_, index) => `a${index}`),
      }),
    ).toBe(false);
    expect(
      check(InteractiveParams)({
        task: "t",
        routingDescription: "Own the API migration",
        routingAliases: ["a".repeat(257)],
      }),
    ).toBe(false);
  });

  /* ---------- optional `background` (boolean) ---------- */

  it("accepts missing background", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts background true", () => {
    expect(check(InteractiveParams)({ task: "t", background: true })).toBe(
      true,
    );
  });

  it("accepts background false", () => {
    expect(check(InteractiveParams)({ task: "t", background: false })).toBe(
      true,
    );
  });

  it("rejects background as string", () => {
    expect(check(InteractiveParams)({ task: "t", background: "yes" })).toBe(
      false,
    );
  });

  it("rejects background as null", () => {
    expect(check(InteractiveParams)({ task: "t", background: null })).toBe(
      false,
    );
  });

  /* ---------- optional `notifyOnComplete` (union "notify" | "inject") ---------- */

  it("accepts missing notifyOnComplete", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts notifyOnComplete 'notify'", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        notifyOnComplete: "notify" as const,
      }),
    ).toBe(true);
  });

  it("accepts notifyOnComplete 'inject'", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        notifyOnComplete: "inject" as const,
      }),
    ).toBe(true);
  });

  it("rejects notifyOnComplete 'notify-inject'", () => {
    expect(
      check(InteractiveParams)({
        task: "t",
        notifyOnComplete: "notify-inject",
      }),
    ).toBe(false);
  });

  it("rejects notifyOnComplete number", () => {
    expect(check(InteractiveParams)({ task: "t", notifyOnComplete: 1 })).toBe(
      false,
    );
  });

  /* ---------- optional `mux` (union "auto" | "tmux" | "zellij") ---------- */

  it("accepts missing mux", () => {
    expect(check(InteractiveParams)({ task: "t" })).toBe(true);
  });

  it("accepts mux 'auto'", () => {
    expect(check(InteractiveParams)({ task: "t", mux: "auto" as const })).toBe(
      true,
    );
  });

  it("accepts mux 'tmux'", () => {
    expect(check(InteractiveParams)({ task: "t", mux: "tmux" as const })).toBe(
      true,
    );
  });

  it("accepts mux 'zellij'", () => {
    expect(
      check(InteractiveParams)({ task: "t", mux: "zellij" as const }),
    ).toBe(true);
  });

  it("rejects mux 'screen'", () => {
    expect(check(InteractiveParams)({ task: "t", mux: "screen" })).toBe(false);
  });

  it("rejects mux empty string", () => {
    expect(check(InteractiveParams)({ task: "t", mux: "" })).toBe(false);
  });

  it("rejects mux boolean", () => {
    expect(check(InteractiveParams)({ task: "t", mux: false })).toBe(false);
  });

  it("produces meaningful errors for invalid mux value", () => {
    const msgs = collectErrorMessages(InteractiveParams, {
      task: "t",
      mux: "hyper",
    });
    expect(msgs.some((m) => /auto|tmux|zellij|constant|anyOf/i.test(m))).toBe(
      true,
    );
  });

  /* ---------- edge: null / undefined / array input ---------- */

  it("rejects null input", () => {
    expect(check(InteractiveParams)(null)).toBe(false);
  });

  it("rejects undefined input", () => {
    expect(check(InteractiveParams)(undefined)).toBe(false);
  });

  it("rejects array input", () => {
    expect(check(InteractiveParams)([])).toBe(false);
  });

  it("Error shape includes keyword/schemaPath/instancePath/message", () => {
    const [, errs] = Schema.Compile(InteractiveParams).Errors({ task: 42 });
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) {
      expect(e).toHaveProperty("keyword");
      expect(e).toHaveProperty("schemaPath");
      expect(e).toHaveProperty("instancePath");
      expect(e).toHaveProperty("message");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: Parse behavior
// ---------------------------------------------------------------------------

describe("Parse (decoding)", () => {
  it("BaseParams.Parse returns the decoded value for valid input", () => {
    const value = { task: "hello", async: true, maxAge: 1000 };
    const result = parse(BaseParams)(value);
    expect(result).toEqual(value);
  });

  it("BaseParams.Parse passes through unknown properties", () => {
    const result = parse(BaseParams)({
      task: "hello",
      extraField: "should not be removed",
    });
    expect(result).toHaveProperty("extraField");
    expect(result).toMatchObject({
      task: "hello",
      extraField: "should not be removed",
    });
  });

  it("BaseParams.Parse throws on invalid input", () => {
    expect(() => parse(BaseParams)({})).toThrow();
  });

  it("BaseParams.Parse throws with meaningful error path", () => {
    try {
      parse(BaseParams)({});
    } catch (e: unknown) {
      const err = e as {
        errors?: Array<{ message: string; instancePath: string }>;
      };
      expect(err.errors).toBeDefined();
      expect(err.errors!.length).toBeGreaterThan(0);
      expect(err.errors![0]).toHaveProperty("message");
    }
  });

  it("InteractiveParams.Parse rejects unknown properties", () => {
    expect(() =>
      parse(InteractiveParams)({
        task: "test",
        unknownProp: 1,
      }),
    ).toThrow();
  });

  it("InteractiveParams.Parse preserves optionals when present", () => {
    const result = parse(InteractiveParams)({
      task: "test",
      name: "My Agent",
      mux: "tmux" as const,
    });
    expect(result).toEqual({ task: "test", name: "My Agent", mux: "tmux" });
  });

  it("StatusParams.Parse passes through unknown properties", () => {
    const result = parse(StatusParams)({ jobId: "j1", extra: true });
    expect(result).toMatchObject({ jobId: "j1", extra: true });
  });
});

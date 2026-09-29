const OPTIONAL_SCHEMA = Symbol("workflow.optional-schema");
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertSchema(value, label = "schema") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a schema object.`);
  }
  return value;
}

function freezeSchema(value) {
  return Object.freeze(value);
}

export const schema = Object.freeze({
  string() {
    return freezeSchema({ type: "string" });
  },
  number() {
    return freezeSchema({ type: "number" });
  },
  integer() {
    return freezeSchema({ type: "integer" });
  },
  boolean() {
    return freezeSchema({ type: "boolean" });
  },
  null() {
    return freezeSchema({ type: "null" });
  },
  enum(values) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError("schema.enum() requires a non-empty array.");
    }
    return freezeSchema({ enum: Object.freeze([...values]) });
  },
  array(items, options = {}) {
    assertSchema(items, "array item schema");
    const out = { type: "array", items };
    if (options.minItems !== undefined) out.minItems = options.minItems;
    if (options.maxItems !== undefined) out.maxItems = options.maxItems;
    return freezeSchema(out);
  },
  optional(value) {
    assertSchema(value, "optional schema");
    return Object.freeze({ ...value, [OPTIONAL_SCHEMA]: true });
  },
  object(properties, options = {}) {
    if (
      !properties ||
      typeof properties !== "object" ||
      Array.isArray(properties)
    ) {
      throw new TypeError("schema.object() requires a properties object.");
    }
    const additionalProperties = options.additionalProperties ?? false;
    if (typeof additionalProperties !== "boolean") {
      throw new TypeError("additionalProperties must be a boolean.");
    }
    const output = Object.create(null);
    const required = [];
    for (const [key, child] of Object.entries(properties)) {
      assertSchema(child, `property ${JSON.stringify(key)} schema`);
      const { [OPTIONAL_SCHEMA]: optional, ...plainSchema } = child;
      output[key] = freezeSchema(plainSchema);
      if (!optional) required.push(key);
    }
    return freezeSchema({
      type: "object",
      properties: freezeSchema(output),
      ...(required.length ? { required: Object.freeze(required) } : {}),
      additionalProperties,
    });
  },
});

export function defineWorkflow(definition) {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    throw new TypeError("defineWorkflow() requires a definition object.");
  }
  if (
    typeof definition.name !== "string" ||
    !WORKFLOW_NAME.test(definition.name)
  ) {
    throw new TypeError(
      "Workflow name must use lowercase letters, digits, and hyphens (max 64).",
    );
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new TypeError("Workflow version must be a positive integer.");
  }
  if (
    definition.description !== undefined &&
    typeof definition.description !== "string"
  ) {
    throw new TypeError("Workflow description must be a string.");
  }
  if (typeof definition.run !== "function") {
    throw new TypeError(
      "Workflow definition must provide a run(ctx, args) function.",
    );
  }
  if (definition.input !== undefined) assertSchema(definition.input, "input");
  if (definition.output !== undefined)
    assertSchema(definition.output, "output");
  return Object.freeze({ ...definition });
}

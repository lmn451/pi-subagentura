import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

const VALIDATION_FLAG = "PI_SUBAGENTURA_WITH_VALIDATION";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const MAX_VALIDATION_ERRORS = 8;
const MAX_ERROR_PATH_CHARS = 160;
const MAX_VALIDATION_CONTAINER_ENTRIES = 4096;
const MAX_VALIDATION_DEPTH = 64;
const MAX_VALIDATION_RESULT_TEXT_CHARS = 4096;

interface ValidationError {
  keyword: string;
  schemaPath?: string;
  params?: object;
}
interface CompiledValidator {
  Check(value: unknown): boolean;
  Errors(value: unknown): ValidationError[];
}
interface ObjectSchema {
  type?: unknown;
  properties?: unknown;
  additionalProperties?: unknown;
}
export interface InvalidParameterError {
  path: string;
  message: string;
}
export interface InvalidParamsDetails {
  status: "error";
  code: "invalid_params";
  tool: string;
  errors: InvalidParameterError[];
}
type ValidationOutcome =
  { ok: true; value: unknown } | { ok: false; errors: InvalidParameterError[] };

const compiledValidators = new WeakMap<object, CompiledValidator>();

export function runtimeParameterValidationEnabled(): boolean {
  const value = process.env[VALIDATION_FLAG];
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function compiledValidator(schema: TSchema): CompiledValidator {
  const cached = compiledValidators.get(schema);
  if (cached) return cached;
  const compiled = Compile(schema) as CompiledValidator;
  compiledValidators.set(schema, compiled);
  return compiled;
}

function objectSchema(schema: TSchema): ObjectSchema {
  return schema as ObjectSchema;
}

function normalizeValue(schema: TSchema, value: unknown): unknown {
  return value === undefined && objectSchema(schema).type === "object"
    ? {}
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedTopLevelParameter(
  schema: TSchema,
  value: unknown,
): InvalidParameterError | undefined {
  const current = objectSchema(schema);
  if (
    current.type !== "object" ||
    !isRecord(current.properties) ||
    !isRecord(value)
  ) {
    return undefined;
  }
  if (
    current.additionalProperties === true ||
    (typeof current.additionalProperties === "object" &&
      current.additionalProperties !== null)
  ) {
    return undefined;
  }
  try {
    const allowed = new Set(Object.keys(current.properties));
    return Object.keys(value).some((key) => !allowed.has(key))
      ? { path: "/", message: "Unexpected parameter" }
      : undefined;
  } catch {
    return {
      path: "/",
      message: "Parameter structure cannot be inspected safely",
    };
  }
}

// Validator.Errors materializes the full error array. Bound only diagnostics,
// not schema-valid values such as large workflow args/input under Type.Unknown.
function withinReportingBounds(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  const visited = new WeakSet<object>();
  let entries = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (typeof current.value !== "object" || current.value === null) continue;
      if (current.depth > MAX_VALIDATION_DEPTH) return false;
      if (visited.has(current.value)) return false;
      visited.add(current.value);
      const keys = Object.keys(current.value);
      entries += Array.isArray(current.value)
        ? current.value.length
        : keys.length;
      if (entries > MAX_VALIDATION_CONTAINER_ENTRIES) return false;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (descriptor && "value" in descriptor) {
          pending.push({
            value: descriptor.value,
            depth: current.depth + 1,
          });
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

function decodePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function schemaParameterPath(error: ValidationError): string {
  const tokens = (error.schemaPath ?? "")
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodePointerSegment);
  const segments: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "properties" && tokens[index + 1]) {
      segments.push(tokens[index + 1]);
      index++;
    } else if (tokens[index] === "items") {
      segments.push("*");
    }
  }
  if (error.keyword === "required") {
    const required = ((error.params ?? {}) as { requiredProperties?: unknown })
      .requiredProperties;
    const property = Array.isArray(required) ? required[0] : undefined;
    if (
      typeof property === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(property)
    ) {
      segments.push(property);
    }
  }
  const path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return path.slice(0, MAX_ERROR_PATH_CHARS);
}

function sanitizedMessage(error: ValidationError): string {
  const type = ((error.params ?? {}) as { type?: unknown }).type;
  switch (error.keyword) {
    case "required":
      return "Required parameter is missing";
    case "type":
      return typeof type === "string" && /^[a-z]+$/.test(type)
        ? `Expected ${type}`
        : "Invalid parameter type";
    case "const":
      return "Expected an allowed literal value";
    case "enum":
      return "Expected a value from the allowed set";
    case "anyOf":
    case "oneOf":
      return "Expected a value matching an allowed variant";
    case "additionalProperties":
    case "unevaluatedProperties":
      return "Unexpected parameter";
    case "pattern":
    case "format":
      return "String does not match the required format";
    case "minimum":
    case "exclusiveMinimum":
      return "Number is below the allowed minimum";
    case "maximum":
    case "exclusiveMaximum":
      return "Number is above the allowed maximum";
    case "minLength":
      return "String is shorter than the allowed minimum";
    case "maxLength":
      return "String is longer than the allowed maximum";
    case "minItems":
      return "Array has too few items";
    case "maxItems":
      return "Array has too many items";
    case "uniqueItems":
      return "Array items must be unique";
    default:
      return "Invalid parameter";
  }
}

function sanitizedErrors(
  errors: ValidationError[],
  initial: InvalidParameterError[] = [],
): InvalidParameterError[] {
  const result: InvalidParameterError[] = [];
  const seen = new Set<string>();
  const append = (entry: InvalidParameterError) => {
    const key = `${entry.path}\0${entry.message}`;
    if (seen.has(key) || result.length >= MAX_VALIDATION_ERRORS) return;
    seen.add(key);
    result.push(entry);
  };
  for (const entry of initial) append(entry);
  for (const error of errors) {
    append({
      path: schemaParameterPath(error),
      message: sanitizedMessage(error),
    });
  }
  return result.length > 0
    ? result
    : [{ path: "/", message: "Invalid parameter" }];
}

function validateRuntimeParameters(
  schema: TSchema,
  input: unknown,
): ValidationOutcome {
  const value = normalizeValue(schema, input);
  const unexpected = unexpectedTopLevelParameter(schema, value);
  const validator = compiledValidator(schema);
  let schemaValid: boolean;
  try {
    schemaValid = validator.Check(value);
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "/",
          message: "Parameter structure cannot be validated safely",
        },
      ],
    };
  }
  if (schemaValid && !unexpected) return { ok: true, value };
  if (schemaValid) return { ok: false, errors: [unexpected!] };
  if (!withinReportingBounds(value)) {
    return {
      ok: false,
      errors: [
        {
          path: "/",
          message: "Parameter structure exceeds validation reporting limits",
        },
      ],
    };
  }
  try {
    return {
      ok: false,
      errors: sanitizedErrors(
        validator.Errors(value),
        unexpected ? [unexpected] : [],
      ),
    };
  } catch {
    return {
      ok: false,
      errors: [{ path: "/", message: "Parameter validation failed" }],
    };
  }
}

function invalidParamsText(
  tool: string,
  errors: InvalidParameterError[],
): string {
  return [
    `Invalid parameters for ${tool}.`,
    ...errors.map((error) => `- ${error.path}: ${error.message}`),
  ].join("\n");
}

export function invalidRuntimeParamsResult(
  tool: string,
  errors: InvalidParameterError[],
): AgentToolResult<InvalidParamsDetails> & { isError: true } {
  return {
    content: [{ type: "text", text: invalidParamsText(tool, errors) }],
    details: { status: "error", code: "invalid_params", tool, errors },
    isError: true,
  };
}

export function invalidRuntimeParamsError(
  tool: string,
  errors: InvalidParameterError[],
): Error {
  return new Error(invalidParamsText(tool, errors));
}

export function isRuntimeValidationRejectionResult(
  tool: unknown,
  result: unknown,
): boolean {
  if (typeof tool !== "string" || !isRecord(result)) return false;
  const content = result.content;
  const details = result.details;
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(details)) {
    return false;
  }
  try {
    if (Object.keys(details).length !== 0) return false;
  } catch {
    return false;
  }
  const first = content[0];
  if (
    !isRecord(first) ||
    first.type !== "text" ||
    typeof first.text !== "string"
  ) {
    return false;
  }
  if (first.text.length > MAX_VALIDATION_RESULT_TEXT_CHARS) return false;
  const lines = first.text.split("\n");
  return (
    lines.length >= 2 &&
    lines.length <= MAX_VALIDATION_ERRORS + 1 &&
    lines[0] === `Invalid parameters for ${tool}.` &&
    lines.slice(1).every((line) => line.startsWith("- /") && line.length <= 256)
  );
}

function isInvalidParameterError(
  value: unknown,
): value is InvalidParameterError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function isInvalidParamsDetails(value: unknown): value is InvalidParamsDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InvalidParamsDetails>;
  return (
    candidate.status === "error" &&
    candidate.code === "invalid_params" &&
    typeof candidate.tool === "string" &&
    Array.isArray(candidate.errors) &&
    candidate.errors.length > 0 &&
    candidate.errors.every(isInvalidParameterError)
  );
}

export function withRuntimeParameterValidation<
  const TParams extends TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails | InvalidParamsDetails, TState> {
  const {
    execute,
    renderResult,
    prepareArguments,
    ...definitionWithoutCallbacks
  } = definition;
  const wrapped: ToolDefinition<
    TParams,
    TDetails | InvalidParamsDetails,
    TState
  > = {
    ...definitionWithoutCallbacks,
    prepareArguments(args) {
      const prepared = prepareArguments ? prepareArguments(args) : args;
      if (!runtimeParameterValidationEnabled()) {
        return prepared as never;
      }
      const validation = validateRuntimeParameters(
        definition.parameters,
        prepared,
      );
      if (!validation.ok) {
        throw invalidRuntimeParamsError(definition.name, validation.errors);
      }
      return validation.value as never;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let executionParams = params;
      if (runtimeParameterValidationEnabled()) {
        const validation = validateRuntimeParameters(
          definition.parameters,
          params,
        );
        if (!validation.ok) {
          return invalidRuntimeParamsResult(definition.name, validation.errors);
        }
        executionParams = validation.value as never;
      }
      return execute(
        toolCallId,
        executionParams,
        signal,
        onUpdate as AgentToolUpdateCallback<TDetails> | undefined,
        ctx,
      );
    },
  };
  if (renderResult) {
    wrapped.renderResult = (result, options, theme, context) => {
      if (isInvalidParamsDetails(result.details)) {
        const first = result.content[0];
        const text =
          first?.type === "text"
            ? first.text
            : invalidParamsText(result.details.tool, result.details.errors);
        return new Text(theme.fg("error", text), 0, 0);
      }
      return renderResult(
        result as AgentToolResult<TDetails>,
        options,
        theme,
        context,
      );
    };
  }
  return wrapped;
}

export function registerToolWithRuntimeValidation<
  const TParams extends TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  pi: ExtensionAPI,
  definition: ToolDefinition<TParams, TDetails, TState>,
): void {
  pi.registerTool(withRuntimeParameterValidation(definition));
}

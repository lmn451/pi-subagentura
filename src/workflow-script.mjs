import { parse } from "acorn";
import { stripTypeScriptTypes } from "node:module";

const META_EXPORT_NAME = "meta";
const RESERVE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Compile a legacy workflow module or a typed v4 definition module. */
export function compileWorkflowScript(script) {
  if (typeof script !== "string") {
    throw new Error("Workflow source must be a string.");
  }
  let source = script;
  let ast;
  try {
    ast = parseWorkflowAst(source);
  } catch (err) {
    try {
      source = stripTypeScriptTypes(script, { mode: "strip" });
      ast = parseWorkflowAst(source);
    } catch (stripError) {
      const message =
        stripError instanceof Error ? `: ${stripError.message}` : "";
      throw new Error(`Workflow TypeScript must use erasable syntax${message}`);
    }
  }
  if (
    findMetaExport(ast.body) === null &&
    ast.body.some((node) => node.type === "ExportDefaultDeclaration")
  ) {
    return compileDefinition(source, ast);
  }
  const legacy = parseLegacyWorkflow(source, ast);
  return { format: "legacy", ...legacy };
}

/** Backwards-compatible parser used by saved-script and runtime callers. */
export function parseWorkflow(script) {
  return compileWorkflowScript(script);
}

function parseLegacyWorkflow(script, ast = parseWorkflowAst(script)) {
  const metaExport = findMetaExport(ast.body);
  if (metaExport === null) {
    throw new Error(
      "Workflow script must declare `export const meta = { name, description }` as a pure literal.",
    );
  }

  let meta;
  try {
    meta = parseMetaLiteral(metaExport.init, "meta");
  } catch (err) {
    const message = err instanceof Error ? `: ${err.message}` : "";
    throw new Error(`Workflow \`meta\` must be a pure literal${message}`);
  }

  if (meta == null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Workflow `meta` did not evaluate to an object literal.");
  }

  if (typeof meta.name !== "string" || !meta.name) {
    throw new Error("Workflow `meta.name` must be a non-empty string.");
  }
  if (typeof meta.description !== "string" || !meta.description) {
    throw new Error("Workflow `meta.description` must be a non-empty string.");
  }

  const body = stripWorkflowExports(script, ast.body, metaExport.node);
  return { meta, body };
}

function compileDefinition(source, ast) {
  const runtimeImports = [];
  const removals = [];
  let defaultExport;
  let defineBinding;

  walk(ast, (node) => {
    if (node.type === "ImportExpression") {
      throw new Error("Dynamic imports are unavailable in v4 workflows.");
    }
    if (node.type === "MetaProperty" && node.meta?.name === "import") {
      throw new Error("`import.meta` is unavailable in v4 workflows.");
    }
  });

  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      if (
        node.source.value !== "pi-subagentura/workflow" ||
        (node.attributes?.length ?? 0) > 0
      ) {
        throw new Error(
          "V4 workflow runtime imports must come from `pi-subagentura/workflow`.",
        );
      }
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") {
          throw new Error(
            "V4 workflows may import only named `defineWorkflow` and `schema` runtime bindings.",
          );
        }
        const imported = specifier.imported.name;
        if (imported !== "defineWorkflow" && imported !== "schema") {
          throw new Error(
            `Unsupported workflow SDK import ${JSON.stringify(imported)}.`,
          );
        }
        runtimeImports.push({ imported, local: specifier.local.name });
        if (imported === "defineWorkflow") {
          if (defineBinding !== undefined) {
            throw new Error("Import `defineWorkflow` only once.");
          }
          defineBinding = specifier.local.name;
        }
      }
      removals.push({ start: node.start, end: node.end, replacement: "" });
      continue;
    }

    if (node.type === "ExportDefaultDeclaration") {
      if (defaultExport !== undefined) {
        throw new Error("V4 workflow source must have one default definition.");
      }
      defaultExport = node;
      continue;
    }

    if (
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      throw new Error(
        "V4 workflow modules may export only a default `defineWorkflow(...)` definition.",
      );
    }
  }

  if (!defaultExport) {
    throw new Error(
      "V4 workflow source must default-export `defineWorkflow(...)`.",
    );
  }
  rejectTopLevelReturns(ast);
  if (!defineBinding) {
    throw new Error("Import `defineWorkflow` from `pi-subagentura/workflow`.");
  }
  const declaration = defaultExport.declaration;
  if (
    declaration.type !== "CallExpression" ||
    declaration.callee.type !== "Identifier" ||
    declaration.callee.name !== defineBinding ||
    declaration.arguments.length !== 1 ||
    declaration.arguments[0]?.type !== "ObjectExpression"
  ) {
    throw new Error(
      "Default export must call `defineWorkflow` with one object literal.",
    );
  }

  const definition = declaration.arguments[0];
  const properties = new Map();
  for (const property of definition.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.shorthand ||
      property.kind !== "init"
    ) {
      throw new Error(
        "Workflow definition fields must use explicit object properties.",
      );
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (!key) throw new Error("Workflow definition has an invalid field name.");
    if (RESERVE_KEYS.has(key)) {
      throw new Error(
        `Workflow definition field ${JSON.stringify(key)} is reserved.`,
      );
    }
    if (properties.has(key))
      throw new Error(`Duplicate workflow field ${JSON.stringify(key)}.`);
    properties.set(key, property);
  }
  const name = staticString(properties.get("name"), "name");
  const versionProperty = properties.get("version");
  const version = versionProperty?.value?.value;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(
      "Workflow definition `version` must be a positive integer literal.",
    );
  }
  const descriptionProperty = properties.get("description");
  const description = descriptionProperty
    ? staticString(descriptionProperty, "description", true)
    : "";
  const runProperty = properties.get("run");
  if (
    !runProperty ||
    (!runProperty.method &&
      runProperty.value?.type !== "FunctionExpression" &&
      runProperty.value?.type !== "ArrowFunctionExpression")
  ) {
    throw new Error("Workflow definition `run` must be a function.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      "Workflow definition `name` must use lowercase letters, digits, and hyphens (max 64).",
    );
  }

  const aliases = new Map();
  for (const { imported, local } of runtimeImports) {
    if (aliases.has(local))
      throw new Error(`Duplicate SDK import binding ${JSON.stringify(local)}.`);
    aliases.set(local, imported);
  }
  const runBinding = freshIdentifier(ast, "__piRunWorkflowDefinition");
  const defineParam = freshIdentifier(ast, "__piDefineWorkflow");
  const schemaParam = freshIdentifier(ast, "__piWorkflowSchema");
  const bindings = [];
  for (const [local, imported] of aliases) {
    const injected = imported === "defineWorkflow" ? defineParam : schemaParam;
    bindings.push(`const ${local} = ${injected};`);
  }
  const definitionName = freshIdentifier(ast, "__piWorkflowDefinition");
  removals.push({
    start: defaultExport.start,
    end: defaultExport.end,
    replacement: `const ${definitionName} = ${source.slice(declaration.start, declaration.end)};`,
  });

  let body = applySourceReplacements(source, removals);
  body = `(async function (${runBinding}, ${defineParam}, ${schemaParam}) {\n${bindings.join("\n")}\n${body}\nreturn await ${runBinding}(${definitionName});\n})`;
  return {
    format: "definition",
    meta: { name, version, description },
    body,
  };
}

function staticString(property, field, allowEmpty = false) {
  const value = property?.value;
  if (
    value?.type !== "Literal" ||
    typeof value.value !== "string" ||
    (!allowEmpty && !value.value)
  ) {
    throw new Error(
      `Workflow definition \`${field}\` must be a ${allowEmpty ? "string" : "non-empty string"} literal.`,
    );
  }
  return value.value;
}

function rejectTopLevelReturns(ast) {
  function visit(node, inFunction = false) {
    if (!node || typeof node !== "object") return;
    const isFunction =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    const nestedFunction = inFunction || isFunction;
    if (node.type === "ReturnStatement" && !nestedFunction) {
      throw new Error(
        "V4 workflow modules may not contain a top-level return.",
      );
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child, nestedFunction);
      } else if (
        value &&
        typeof value === "object" &&
        typeof value.type === "string"
      ) {
        visit(value, nestedFunction);
      }
    }
  }
  visit(ast);
}

function freshIdentifier(ast, base) {
  const used = new Set();
  walk(ast, (node) => {
    if (node.type === "Identifier") used.add(node.name);
  });
  let candidate = base;
  let index = 0;
  while (used.has(candidate)) candidate = `${base}${++index}`;
  return candidate;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string"
    ) {
      walk(value, visit);
    }
  }
}

function applySourceReplacements(source, replacements) {
  replacements.sort((a, b) => b.start - a.start);
  let result = source;
  for (const replacement of replacements) {
    result = `${result.slice(0, replacement.start)}${replacement.replacement}${result.slice(replacement.end)}`;
  }
  return result;
}

function parseWorkflowAst(script) {
  return parse(script, {
    sourceType: "module",
    ecmaVersion: "latest",
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    ranges: true,
  });
}

function findMetaExport(body) {
  for (const node of body) {
    if (!isMetaExport(node)) continue;
    const decl = node.declaration.declarations[0];
    return { node, init: decl.init };
  }
  return null;
}

function isMetaExport(node) {
  if (
    node.type !== "ExportNamedDeclaration" ||
    !node.declaration ||
    node.declaration.type !== "VariableDeclaration" ||
    node.declaration.kind !== "const"
  ) {
    return false;
  }

  if (node.declaration.declarations.length !== 1) return false;

  const decl = node.declaration.declarations[0];
  return (
    decl.id?.type === "Identifier" &&
    decl.id.name === META_EXPORT_NAME &&
    !!decl.init
  );
}

function parseMetaLiteral(node, path) {
  if (node.type === "Literal") {
    if (node.value instanceof RegExp) {
      throw new Error(`${path}: regex values are not allowed`);
    }
    if (typeof node.value === "bigint") {
      throw new Error(`${path}: bigint values are not allowed`);
    }
    return node.value;
  }

  if (node.type === "ObjectExpression") {
    return parseObjectLiteral(node, path);
  }

  if (node.type === "ArrayExpression") {
    return parseArrayLiteral(node, path);
  }

  if (node.type === "UnaryExpression") {
    if (node.operator !== "-" && node.operator !== "+") {
      throw new Error(`${path}: unsupported unary operator ${node.operator}`);
    }
    if (
      node.argument.type !== "Literal" ||
      typeof node.argument.value !== "number"
    ) {
      throw new Error(
        `${path}: unary expressions are only allowed for numbers`,
      );
    }
    const value = node.argument.value;
    return node.operator === "-" ? -value : value;
  }

  if (node.type === "TemplateLiteral") {
    if (node.expressions.length > 0) {
      throw new Error(`${path}: template literals must be static`);
    }
    if (node.quasis.length !== 1) {
      throw new Error(`${path}: invalid template literal`);
    }
    const template = node.quasis[0];
    return template.value.cooked ?? template.value.raw;
  }

  if (node.type === "BinaryExpression") {
    if (node.operator !== "+") {
      throw new Error(`${path}: unsupported operator ${node.operator}`);
    }
    const left = parseMetaLiteral(node.left, `${path}.left`);
    const right = parseMetaLiteral(node.right, `${path}.right`);
    if (!isMetadataPrimitive(left) || !isMetadataPrimitive(right)) {
      throw new Error(
        `${path}: binary expressions can only combine primitive literals`,
      );
    }
    return left + right;
  }

  throw new Error(`${path}: unsupported expression (${node.type})`);
}

function isMetadataPrimitive(value) {
  const type = typeof value;
  return (
    value === null ||
    type === "string" ||
    type === "number" ||
    type === "boolean"
  );
}

function parseObjectLiteral(node, path) {
  const out = {};
  for (const property of node.properties) {
    if (property.type !== "Property") {
      throw new Error(`${path}: spread properties are not allowed`);
    }

    if (property.kind !== "init") {
      throw new Error(
        `${path}: only literal object properties are allowed, not method/getter/setter`,
      );
    }

    if (property.shorthand) {
      throw new Error(`${path}: shorthand properties are not allowed`);
    }

    if (property.computed) {
      throw new Error(`${path}: computed keys are not allowed`);
    }

    if (property.method) {
      throw new Error(`${path}: method properties are not allowed`);
    }

    if (property.key == null) {
      throw new Error(`${path}: missing property key`);
    }

    const key = parseMetaObjectKey(property.key, path);
    if (RESERVE_KEYS.has(key)) {
      throw new Error(
        `${path}: reserved key ${JSON.stringify(key)} is not allowed`,
      );
    }

    if (!property.value) {
      throw new Error(`${path}.${key}: object property value is missing`);
    }

    out[key] = parseMetaLiteral(property.value, `${path}.${key}`);
  }

  return out;
}

function parseMetaObjectKey(key, path) {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") {
    if (key.value === null) {
      throw new Error(`${path}: null keys are not allowed`);
    }
    if (typeof key.value === "string" || typeof key.value === "number") {
      return String(key.value);
    }
    throw new Error(`${path}: unsupported key type ${key.type}`);
  }

  throw new Error(`${path}: unsupported key type ${key.type}`);
}

function parseArrayLiteral(node, path) {
  const out = [];
  for (let i = 0; i < node.elements.length; i++) {
    const item = node.elements[i];
    if (item == null) {
      throw new Error(`${path}[${i}]: sparse array entries are not allowed`);
    }
    out.push(parseMetaLiteral(item, `${path}[${i}]`));
  }
  return out;
}

/** Strip workflow export wrappers into executable statements and remove meta declaration. */
function stripWorkflowExports(script, body, metaNode) {
  const removals = [];

  for (const node of body) {
    if (node === metaNode) {
      removals.push({
        start: node.start,
        end: node.end,
        replacement: "",
      });
      continue;
    }

    if (
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportDefaultDeclaration" &&
      node.type !== "ExportAllDeclaration"
    ) {
      continue;
    }

    if (node.declaration) {
      removals.push({
        start: node.start,
        end: node.end,
        replacement: script.slice(node.declaration.start, node.end),
      });
      continue;
    }

    removals.push({
      start: node.start,
      end: node.end,
      replacement: "",
    });
  }

  if (!removals.length) return script;

  removals.sort((a, b) => b.start - a.start);
  let out = script;
  for (const removal of removals) {
    out = `${out.slice(0, removal.start)}${removal.replacement}${out.slice(
      removal.end,
    )}`;
  }
  return out;
}

export function makeGuardedDate() {
  const Guard = function (...a) {
    if (a.length === 0) {
      throw new Error(
        "`new Date()` with no args is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
      );
    }
    return new Date(...a);
  };
  Guard.now = () => {
    throw new Error(
      "`Date.now()` is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
    );
  };
  Guard.parse = Date.parse;
  Guard.UTC = Date.UTC;
  // Don't set Guard.prototype = Date.prototype — that leaks host constructors
  // via Date.prototype.constructor → Function. Use a null-prototype object instead.
  Guard.prototype = Object.create(null);
  Guard.prototype.constructor = Guard;
  return Guard;
}

export function makeGuardedMath() {
  // Copy all Math properties onto a null-prototype object so the constructor
  // chain doesn't lead back to host Function via Math.constructor → Object → Function.
  const safe = Object.create(null);
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === "random") {
      safe.random = () => {
        throw new Error(
          "`Math.random()` is non-deterministic and unavailable in workflows. Vary by index instead.",
        );
      };
    } else {
      const val = Math[key];
      safe[key] = typeof val === "function" ? val.bind(Math) : val;
    }
  }
  return safe;
}

export function workflowStringify(x) {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

import { parse } from "acorn";

const META_EXPORT_NAME = "meta";
const RESERVE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Split a workflow script into its static `meta` literal and executable body. */
export function parseWorkflow(script) {
  const ast = parseWorkflowAst(script);
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
  const NativeDate = Date;
  const setPrototype = Object.setPrototypeOf;
  const Guard = function (...a) {
    if (a.length === 0) {
      throw new Error(
        "`new Date()` with no args is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
      );
    }
    return setPrototype(new NativeDate(...a), Guard.prototype);
  };
  Guard.now = () => {
    throw new Error(
      "`Date.now()` is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
    );
  };
  Guard.parse = NativeDate.parse;
  Guard.UTC = NativeDate.UTC;
  // Instances must lead back to the guard without mutating the native prototype.
  Guard.prototype = Object.create(
    Object.prototype,
    Object.getOwnPropertyDescriptors(NativeDate.prototype),
  );
  Object.defineProperty(Guard.prototype, "constructor", { value: Guard });
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

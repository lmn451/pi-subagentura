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

const DURABLE_OPERATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

/**
 * Statically validate the deliberately bounded durable-script subset and
 * return the stable operation table used by the parent-owned replay gate.
 */
export function analyzeDurableWorkflow(script, options = {}) {
  parseWorkflow(script);
  const ast = parseWorkflowAst(script);
  const operations = [];

  walkAst(ast, [], (node, ancestors) => {
    if (node.type !== "CallExpression") return;
    if (
      node.callee?.type !== "Identifier" ||
      (node.callee.name !== "agent" && node.callee.name !== "workflow")
    ) {
      return;
    }
    const insideLoop = ancestors.some((ancestor) => isLoopNode(ancestor));
    const optionIndex = node.callee.name === "agent" ? 1 : 2;
    const id = staticOperationId(
      node.arguments[optionIndex],
      node.callee.name,
      insideLoop,
    );
    if (insideLoop && id !== undefined) {
      throw new Error(
        `Durable ${node.callee.name}() calls inside loops require a caller-authored unique runtime id.`,
      );
    }
    const operation = {
      ...(id === undefined ? { dynamicId: true } : { id }),
      kind: node.callee.name,
      start: node.start,
    };
    if (node.callee.name === "workflow") {
      if (options.allowNested === false) {
        throw new Error(
          "Durable workflow() composition exceeds the configured maximum depth.",
        );
      }
      const name = staticString(node.arguments[0]);
      if (name === undefined || name.length === 0) {
        throw new Error(
          "Durable workflow(name, args, { id }) requires a static saved-workflow name.",
        );
      }
      operation.name = name;
    }
    operations.push(operation);
  });

  operations.sort((left, right) => left.start - right.start);
  const ids = new Set();
  for (const operation of operations) {
    if (operation.id === undefined) continue;
    if (ids.has(operation.id)) {
      throw new Error(
        `Durable workflow operation id "${operation.id}" is duplicated in one definition.`,
      );
    }
    ids.add(operation.id);
  }
  return {
    operations: operations.map(({ id, dynamicId, kind, name }) => ({
      ...(id === undefined ? { dynamicId } : { id }),
      kind,
      ...(name === undefined ? {} : { name }),
    })),
  };
}

function staticOperationId(node, helper, allowDynamic = false) {
  if (!node || node.type !== "ObjectExpression") {
    throw new Error(
      `Durable ${helper}() requires an explicit static { id: "..." } option.`,
    );
  }
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.computed ||
      property.method
    ) {
      continue;
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : staticString(property.key);
    if (key !== "id") continue;
    const id = staticString(property.value);
    if (id === undefined && allowDynamic) return undefined;
    if (id === undefined || id.length > 256 || !DURABLE_OPERATION_ID.test(id)) {
      throw new Error(
        `Durable ${helper}() id must be a portable non-empty identifier of at most 256 characters.`,
      );
    }
    return id;
  }
  throw new Error(
    `Durable ${helper}() requires an explicit static { id: "..." } option.`,
  );
}

function staticString(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

function isLoopNode(node) {
  return (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "WhileStatement" ||
    node.type === "DoWhileStatement"
  );
}

function walkAst(node, ancestors, visit) {
  if (!node || typeof node !== "object" || typeof node.type !== "string")
    return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "start" ||
      key === "end" ||
      key === "range" ||
      key === "loc" ||
      key === "type"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, nextAncestors, visit);
    } else {
      walkAst(value, nextAncestors, visit);
    }
  }
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

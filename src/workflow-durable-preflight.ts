import { createHash } from "node:crypto";
import { parseWorkflow } from "./workflow-script";
import { parse } from "acorn";

export interface DurableWorkflowInspection {
  durableReady: boolean;
  definitionDigest: string;
  errors: string[];
  /** Literal workflow() names whose definitions can be checked by the caller. */
  referencedWorkflows: string[];
}

const DURABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * Check the statically knowable requirements of a durable workflow definition.
 * Dynamic id expressions are intentionally allowed: map/pipeline callbacks
 * commonly derive their ids from item keys or indexes and the runtime checks
 * the resulting value when the call is made.
 */
export function inspectDurableWorkflow(
  script: string,
): DurableWorkflowInspection {
  const definitionDigest = createHash("sha256").update(script).digest("hex");
  const errors: string[] = [];
  const referencedWorkflows = new Set<string>();

  try {
    parseWorkflow(script);
  } catch (error) {
    errors.push(`Workflow definition is invalid: ${errorMessage(error)}`);
    return {
      durableReady: false,
      definitionDigest,
      errors,
      referencedWorkflows: [],
    };
  }

  let ast: any;
  try {
    ast = parse(script, {
      sourceType: "module",
      ecmaVersion: "latest",
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    errors.push(
      `Workflow source could not be analyzed: ${errorMessage(error)}`,
    );
    return {
      durableReady: false,
      definitionDigest,
      errors,
      referencedWorkflows: [],
    };
  }

  const literalIds = new Map<string, number>();
  walk(ast, (node, parent) => {
    if (node.type === "Identifier" && isEscapedReference(node, parent)) {
      errors.push(
        `aliased ${node.name} reference cannot be used in a durable workflow; call ${node.name}() directly.`,
      );
      return;
    }
    if (node.type !== "CallExpression") return;
    const name = node.callee?.type === "Identifier" ? node.callee.name : null;
    if (name !== "agent" && name !== "workflow") return;

    const location = node.loc?.start
      ? ` at line ${node.loc.start.line}, column ${node.loc.start.column + 1}`
      : "";
    const optionsIndex = name === "agent" ? 1 : 2;
    const options = node.arguments[optionsIndex];
    const optionsIssue = optionObjectIssue(options);
    if (optionsIssue) errors.push(`${name}()${location} ${optionsIssue}.`);
    const id = explicitIdProperty(options);
    if (!id) {
      errors.push(
        `${name}()${location} requires an options object with an explicit id property.`,
      );
    } else {
      const literal = staticString(id.value);
      if (id.value?.type === "Literal" && literal === undefined) {
        errors.push(
          `${name}()${location} has an invalid id; literal ids must be strings.`,
        );
      }
      if (literal !== undefined) {
        if (!DURABLE_ID.test(literal)) {
          errors.push(
            `${name}()${location} has an invalid id; use 1–128 safe characters matching ${DURABLE_ID.source}.`,
          );
        }
        const previous = literalIds.get(literal);
        if (previous !== undefined) {
          errors.push(
            `duplicate literal durable id ${JSON.stringify(literal)}${location}; each call needs a distinct id.`,
          );
        } else {
          literalIds.set(literal, node.start ?? 0);
        }
      }
    }

    if (name === "workflow") {
      const workflowName = node.arguments[0];
      const literalName = staticString(workflowName);
      if (literalName === undefined) {
        errors.push(
          `workflow()${location} name must be a literal string for durable preflight.`,
        );
      } else {
        referencedWorkflows.add(literalName);
      }
    }
  });

  return {
    durableReady: errors.length === 0,
    definitionDigest,
    errors,
    referencedWorkflows: [...referencedWorkflows],
  };
}

function explicitIdProperty(options: any): any | undefined {
  if (!options || options.type !== "ObjectExpression") return undefined;
  let found: any | undefined;
  for (const property of options.properties ?? []) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.computed ||
      property.key == null
    )
      continue;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key === "id") found = property;
  }
  return found;
}

function optionObjectIssue(options: any): string | undefined {
  if (!options || options.type !== "ObjectExpression") return undefined;
  if (
    options.properties.some(
      (property: any) => property.type === "SpreadElement",
    )
  )
    return "options object spreads are ambiguous and may overwrite its id";
  if (options.properties.some((property: any) => property.computed))
    return "computed options properties are ambiguous and may overwrite its id";
  return undefined;
}

function staticString(node: any): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  return undefined;
}

function walk(
  node: any,
  visit: (node: any, parent: any) => void,
  parent?: any,
): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, node);
    } else if (value && typeof value === "object") {
      walk(value, visit, node);
    }
  }
}

function isEscapedReference(node: any, parent: any): boolean {
  if (node.name !== "agent" && node.name !== "workflow") return false;
  if (parent?.type === "CallExpression" && parent.callee === node) return false;
  if (
    parent?.type === "Property" &&
    parent.key === node &&
    parent.computed === false &&
    parent.shorthand !== true
  )
    return false;
  if (
    parent?.type === "MemberExpression" &&
    parent.property === node &&
    parent.computed === false
  )
    return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

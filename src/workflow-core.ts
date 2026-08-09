import { cpus, homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeUsage, type SubagentResult, type Usage } from "./helpers";

// ── Limits ───────────────────────────────────────────────────────────
export const MAX_TOTAL_AGENTS = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const SCHEMA_RETRIES = 3;
export const MAX_WORKFLOW_DEPTH = 1; // workflow() composition is one level deep
export const INTERACTIVE_POLL_MS = 1000;
export const INTERACTIVE_DEAD_GRACE_TICKS = 3;
export const WORKFLOW_SYNC_TIMEOUT_MS = 30_000;
export const WORKFLOW_WALL_TIMEOUT_MS = 30 * 60_000;

export function defaultConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(16, n - 2));
}
export function defaultProcessConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(4, n - 2));
}
export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export type WorkflowCostSource =
  "provider" | "estimated" | "unavailable" | "mixed";

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
  /** Pricing provenance; omitted only for legacy/empty aggregates. */
  costSource?: WorkflowCostSource;
}

export function zeroWorkflowUsage(): WorkflowUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

export function hasWorkflowUsage(usage: WorkflowUsage | undefined): boolean {
  return Boolean(
    usage &&
    (usage.input > 0 ||
      usage.output > 0 ||
      usage.cacheRead > 0 ||
      usage.cacheWrite > 0 ||
      usage.totalTokens > 0 ||
      usage.costUsd > 0 ||
      usage.costSource !== undefined),
  );
}

export function presentWorkflowUsage(
  usage: WorkflowUsage | undefined,
): WorkflowUsage | undefined {
  return hasWorkflowUsage(usage) ? usage : undefined;
}

function usageCostSource(
  usage: Usage | undefined,
): WorkflowCostSource | undefined {
  if (!usage) return undefined;
  if (usage.costSource) return usage.costSource;
  if (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.cost === 0
  ) {
    return undefined;
  }
  return usage.cost > 0 ? "estimated" : "unavailable";
}

function mergeCostSource(
  total: WorkflowUsage,
  next: WorkflowCostSource | undefined,
): WorkflowCostSource | undefined {
  const existing =
    total.costSource ??
    (total.costUsd > 0
      ? "estimated"
      : hasWorkflowUsage(total)
        ? "unavailable"
        : undefined);
  if (!next) return existing;
  if (!existing) return next;
  if (existing === next) return next;
  return "mixed";
}

/** Return a new aggregate; callers never share mutable accounting state. */
export function addWorkflowUsage(
  total: WorkflowUsage,
  usage: Usage | undefined,
): WorkflowUsage {
  const normalized = normalizeUsage(usage);
  const input = total.input + (normalized?.input ?? 0);
  const output = total.output + (normalized?.output ?? 0);
  const cacheRead = total.cacheRead + (normalized?.cacheRead ?? 0);
  const cacheWrite = total.cacheWrite + (normalized?.cacheWrite ?? 0);
  const nextCostSource = usageCostSource(normalized);
  const costSource = mergeCostSource(total, nextCostSource);
  const provenance = costSource ? { costSource } : {};
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    costUsd: total.costUsd + (normalized?.cost ?? 0),
    turns: total.turns + (normalized?.turns ?? 0),
    ...provenance,
  };
}

export function workflowUsageFromUsage(
  usage: Usage | undefined,
): WorkflowUsage | undefined {
  const normalized = normalizeUsage(usage);
  if (!normalized || usageCostSource(normalized) === undefined)
    return undefined;
  return addWorkflowUsage(zeroWorkflowUsage(), normalized);
}

function formatWorkflowCost(costUsd: number): string {
  if (!Number.isFinite(costUsd)) return String(costUsd);
  return costUsd.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 15,
  });
}

export interface WorkflowUsageFormatOptions {
  expanded?: boolean;
  ascii?: boolean;
  outputBudget?: number | null;
}

function workflowCostPresentation(usage: WorkflowUsage): {
  source: WorkflowCostSource;
  cost: string;
} {
  const source =
    usage.costSource ?? (usage.costUsd > 0 ? "estimated" : "unavailable");
  const cost =
    source === "unavailable"
      ? "$?"
      : source === "mixed"
        ? "$? (mixed)"
        : source === "estimated"
          ? `~$${formatWorkflowCost(usage.costUsd)}`
          : `$${formatWorkflowCost(usage.costUsd)}`;
  return { source, cost };
}

export function formatWorkflowUsageFields(
  usage: WorkflowUsage,
  options: WorkflowUsageFormatOptions = {},
): string[] {
  const { source, cost } = workflowCostPresentation(usage);
  const budget =
    options.outputBudget == null
      ? ""
      : `/${formatWorkflowCost(options.outputBudget)}`;
  return options.ascii
    ? [
        `input tokens: ${usage.input}`,
        `output tokens: ${usage.output}${budget}`,
        `cache-read tokens: ${usage.cacheRead}`,
        `cache-write tokens: ${usage.cacheWrite}`,
        `cost: ${cost} (${source})`,
        `turns: ${usage.turns}`,
      ]
    : [
        `↑ input tokens: ${usage.input}`,
        `↓ output tokens: ${usage.output}${budget}`,
        `R cache-read tokens: ${usage.cacheRead}`,
        `W cache-write tokens: ${usage.cacheWrite}`,
        `$ cost: ${cost} (${source})`,
        `turns: ${usage.turns}`,
      ];
}

export function formatWorkflowUsage(
  usage: WorkflowUsage,
  options: WorkflowUsageFormatOptions = {},
): string {
  if (options.expanded) {
    return formatWorkflowUsageFields(usage, options).join("; ");
  }
  const { cost } = workflowCostPresentation(usage);
  const budget =
    options.outputBudget == null
      ? ""
      : `/${formatWorkflowCost(options.outputBudget)}`;
  const icons = options.ascii
    ? [
        `input=${usage.input}`,
        `output=${usage.output}${budget}`,
        `cache-read=${usage.cacheRead}`,
        `cache-write=${usage.cacheWrite}`,
        `cost=${cost}`,
      ]
    : [
        `↑${usage.input}`,
        `↓${usage.output}${budget}`,
        `R${usage.cacheRead}`,
        `W${usage.cacheWrite}`,
        `${cost}`,
      ];
  return icons.join(" ");
}

export function formatWorkflowUsageLegend(ascii = false): string {
  return ascii
    ? "Legend: input, output, cache-read, cache-write, cost"
    : "Legend: ↑ input · ↓ output · R cache-read · W cache-write · $ cost";
}

// ── Public types ─────────────────────────────────────────────────────

/** Options accepted by the injected `agent()` helper. */
export interface WorkflowAgentOpts {
  schema?: unknown;
  label?: string;
  phase?: string;
  model?: string;
  persona?: string;
  /** Defaults to "process" (tmux/zellij); use "in-process" to opt out. */
  isolation?: string;
  /** Accepted for fidelity but a no-op in v2. */
  agentType?: string;
  /** Thinking/reasoning level for the sub-agent. Clamped to model capabilities. */
  thinkingLevel?: ThinkingLevel;
}
export type WorkflowAgentProgress =
  | {
      kind: "phase";
      phase: string;
      message?: string;
      label?: string;
      agentId?: number;
      /** Latest live usage from the active agent, when available. */
      liveUsage?: WorkflowUsage;
    }
  | {
      kind: "log";
      message: string;
      phase?: string;
      label?: string;
      agentId?: number;
      /** Latest live usage from the active agent, when available. */
      liveUsage?: WorkflowUsage;
    };

/** Injectable spawn function — wraps in-process or process-backed agents. */
export type WorkflowAgentRunner = (req: {
  prompt: string;
  persona?: string;
  model?: string;
  signal?: AbortSignal;
  isolation?: string;
  label?: string;
  schema?: unknown;
  /** Disable built-in read/write/shell tools for schema-only planner calls. */
  structuredOutputOnly?: boolean;
  /** Thinking/reasoning for the sub-agent. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Optional callback for emitting progress events from inside the runner.
   * Used to surface fallback warnings and forward mid-agent live status.
   */
  onProgress?: (event: WorkflowAgentProgress) => void;
  onCancellationSnapshot?: (
    receipt: import("./cancellation-snapshots").CancellationSnapshotReceipt,
  ) => void;
}) => Promise<SubagentResult>;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
  [k: string]: unknown;
}

export type WorkflowProgress =
  | {
      kind: "phase";
      phase: string;
      message?: string;
      label?: string;
      agentId?: number;
      agentsSpawned: number;
      errorCount: number;
      /** @deprecated Output-token count; use usage.output. */
      tokensSpent: number;
      /** Soft completed-output-token target, if configured. */
      budgetTotal?: number | null;
      usage?: WorkflowUsage;
      /** Latest live usage from the active agent, when available. */
      liveUsage?: WorkflowUsage;
      runningCount: number;
      model?: string;
    }
  | {
      kind: "log";
      phase?: string;
      message: string;
      label?: string;
      agentId?: number;
      agentsSpawned: number;
      errorCount: number;
      /** @deprecated Output-token count; use usage.output. */
      tokensSpent: number;
      budgetTotal?: number | null;
      usage?: WorkflowUsage;
      /** Latest live usage from the active agent, when available. */
      liveUsage?: WorkflowUsage;
      runningCount: number;
      model?: string;
    }
  | {
      kind: "agent_start";
      phase?: string;
      message?: string;
      label?: string;
      agentId?: number;
      agentsSpawned: number;
      errorCount: number;
      /** @deprecated Output-token count; use usage.output. */
      tokensSpent: number;
      budgetTotal?: number | null;
      usage?: WorkflowUsage;
      /** Latest live usage from the active agent, when available. */
      liveUsage?: WorkflowUsage;
      runningCount: number;
      model?: string;
    }
  | {
      kind: "agent_done";
      phase?: string;
      message?: string;
      label?: string;
      status?: "done" | "error";
      agentId?: number;
      agentsSpawned: number;
      errorCount: number;
      /** @deprecated Output-token count; use usage.output. */
      tokensSpent: number;
      budgetTotal?: number | null;
      usage?: WorkflowUsage;
      /** Latest live usage from the active agent, when available. */
      liveUsage?: WorkflowUsage;
      runningCount: number;
      model?: string;
      /** Usage attributed to this agent attempt, when available. */
      agentUsage?: WorkflowUsage;
    };

export interface WorkflowAgentRecord {
  agentId: number;
  phase?: string;
  label?: string;
  model?: string;
  status: "running" | "done" | "error" | "cancelled";
  /** Usage attributed to this attempt; absent when the runner produced none. */
  usage?: WorkflowUsage;
}

export const MAX_WORKFLOW_AGENT_RECORDS = 50;

export type WorkflowProgressUpdate = {
  [K in WorkflowProgress["kind"]]: Omit<
    Extract<WorkflowProgress, { kind: K }>,
    | "agentsSpawned"
    | "errorCount"
    | "tokensSpent"
    | "budgetTotal"
    | "usage"
    | "runningCount"
  >;
}[WorkflowProgress["kind"]];

/** Legacy-compatible public result shape; v3.0.x producers populate `usage`. */
export interface WorkflowRunResult {
  meta: WorkflowMeta;
  result: unknown;
  agentsSpawned: number;
  errorCount: number;
  /** @deprecated Output-token count; use usage.output. */
  tokensSpent: number;
  usage?: WorkflowUsage;
  phases: string[];
}

/** Result produced by `runWorkflow`; unlike the legacy boundary, usage is present. */
export type WorkflowRunResultWithUsage = WorkflowRunResult & {
  usage: WorkflowUsage;
};

export class WorkflowExecutionError extends Error {
  readonly usage?: WorkflowUsage;

  constructor(message: string, usage?: WorkflowUsage, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkflowExecutionError";
    this.usage = usage;
  }
}

export interface RunWorkflowOptions {
  args?: unknown;
  /** Parent execution directory exposed to workflow scripts as immutable `cwd`. */
  cwd?: string;
  /** Soft completed-output-token target; in-flight parallel calls may overshoot. */
  budgetTotal?: number | null;
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onProgress?: (p: WorkflowProgress) => void;
  onCancellationSnapshot?: (
    receipt: import("./cancellation-snapshots").CancellationSnapshotReceipt,
  ) => void;
  concurrency?: number;
  processConcurrency?: number;
  /** Resolve a saved workflow script by name, for `workflow(name, args)` composition. */
  loadWorkflow?: (name: string) => string | null;
  /** Hard wall-clock cap for the workflow VM worker. Defaults to 30 minutes. */
  workflowTimeoutMs?: number;
}

// ── Script parsing ───────────────────────────────────────────────────

import { parseWorkflow } from "./workflow-script";
export { parseWorkflow };

// ── Minimal JSON-Schema validation (dependency-free) ─────────────────

/**
 * Parse model output as strict JSON.
 *
 * We only accept:
 * - The full trimmed output if it is valid JSON, or
 * - A fenced code block whose full content is valid JSON.
 */
export function extractJson(text: string): string | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* invalid candidate */
    }
  }

  return null;
}

/** Validate `value` against a small JSON-Schema subset. Returns a list of human-readable errors. */
export function validateSchema(
  value: unknown,
  schema: any,
  path = "$",
): string[] {
  const schemaErrors = validateSchemaDefinition(schema, path);
  if (schemaErrors.length > 0) return schemaErrors;

  if (!schema || typeof schema !== "object") return [];
  const errs: string[] = [];
  const t = schema.type as string | string[] | undefined;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((ty) => matchesType(value, ty))) {
      errs.push(
        `${path}: expected type ${types.join("|")}, got ${jsType(value)}`,
      );
      return errs; // type mismatch — deeper checks are noise
    }
  }
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e: unknown) => deepEqual(e, value))) {
      errs.push(`${path}: value not in enum`);
    }
  }
  if (matchesType(value, "object")) {
    const obj = value as Record<string, unknown>;
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {};
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, r)) {
          errs.push(`${path}.${r}: required property missing`);
        }
      }
    }
    for (const [k, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        errs.push(...validateSchema(obj[k], sub, `${path}.${k}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errs.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }
  }
  if (matchesType(value, "array")) {
    const arr = value as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) {
      errs.push(
        `${path}: expected >= ${schema.minItems} items, got ${arr.length}`,
      );
    }
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) {
      errs.push(
        `${path}: expected <= ${schema.maxItems} items, got ${arr.length}`,
      );
    }
    if (schema.items) {
      arr.forEach((el, idx) =>
        errs.push(...validateSchema(el, schema.items, `${path}[${idx}]`)),
      );
    }
  }
  return errs;
}

export function validateSchemaDefinition(schema: any, path = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${path}: schema must be an object`];
  }

  const errs: string[] = [];
  const allowed = new Set([
    "type",
    "enum",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
  ]);

  for (const key of Object.keys(schema)) {
    if (allowed.has(key)) continue;
    errs.push(`${path}: unsupported schema key "${key}"`);
  }

  const validTypes = new Set([
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ]);
  if (schema.type !== undefined) {
    if (Array.isArray(schema.type)) {
      for (const t of schema.type) {
        if (typeof t !== "string") {
          errs.push(
            `${path}.type: expected string type name, got ${jsType(t)}`,
          );
          continue;
        }
        if (!validTypes.has(t)) {
          errs.push(`${path}.type: unsupported type "${t}"`);
        }
      }
    } else if (typeof schema.type === "string") {
      if (!validTypes.has(schema.type)) {
        errs.push(`${path}.type: unsupported type "${schema.type}"`);
      }
    } else {
      errs.push(`${path}.type: expected string or array`);
    }
  }

  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    errs.push(`${path}.enum: expected array`);
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      errs.push(`${path}.required: expected string array`);
    } else if (!schema.required.every((k: unknown) => typeof k === "string")) {
      errs.push(`${path}.required: expected string array`);
    }
  }

  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    errs.push(`${path}.additionalProperties: expected boolean`);
  }

  if (
    schema.properties !== undefined &&
    (schema.properties === null ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties))
  ) {
    errs.push(`${path}.properties: expected object`);
  }

  if (typeof schema.minItems !== "undefined") {
    if (!Number.isInteger(schema.minItems) || schema.minItems < 0) {
      errs.push(`${path}.minItems: expected non-negative integer`);
    }
  }
  if (typeof schema.maxItems !== "undefined") {
    if (!Number.isInteger(schema.maxItems) || schema.maxItems < 0) {
      errs.push(`${path}.maxItems: expected non-negative integer`);
    } else if (
      schema.minItems !== undefined &&
      Number.isInteger(schema.minItems) &&
      schema.maxItems < schema.minItems
    ) {
      errs.push(`${path}.maxItems: must be >= minItems`);
    }
  }

  if (
    schema.items !== undefined &&
    (schema.items === null ||
      typeof schema.items !== "object" ||
      Array.isArray(schema.items))
  ) {
    errs.push(`${path}.items: expected object`);
  } else if (schema.items !== undefined) {
    errs.push(...validateSchemaDefinition(schema.items, `${path}.items`));
  }

  if (
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
  ) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      errs.push(...validateSchemaDefinition(sub, `${path}.${k}`));
    }
  }

  return errs;
}

function matchesType(v: unknown, ty: string): boolean {
  switch (ty) {
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && !Number.isNaN(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false;
  }
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== "object"
  )
    return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

// ── Concurrency semaphore ────────────────────────────────────────────

export interface Semaphore {
  acquire: () => Promise<void>;
  release: () => void;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      const tryRun = () => {
        if (active < max) {
          active++;
          resolve();
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return { acquire, release };
}

// ── Saved workflows ──────────────────────────────────────────────────

export const WORKFLOWS_DIR = join(homedir(), ".pi-subagentura", "workflows");

export function sanitizeWorkflowName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      `Invalid workflow name ${JSON.stringify(name)}; use lowercase letters, digits, and hyphens (max 64).`,
    );
  }
  return name;
}

export function saveWorkflowScript(
  name: string,
  script: string,
  dir = WORKFLOWS_DIR,
): string {
  const safe = sanitizeWorkflowName(name);
  parseWorkflow(script); // validate before persisting
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${safe}.js`);
  writeFileSync(file, script, { encoding: "utf8", mode: 0o600 });
  return file;
}

export function loadWorkflowScript(
  name: string,
  dir = WORKFLOWS_DIR,
): string | null {
  let safe: string;
  try {
    safe = sanitizeWorkflowName(name);
  } catch {
    return null;
  }
  const file = join(dir, `${safe}.js`);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function listSavedWorkflows(
  dir = WORKFLOWS_DIR,
): Array<{ name: string; description: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of readdirSync(dir)) {
    const m = /^(.+)\.js$/.exec(entry);
    if (!m) continue;
    let description = "";
    try {
      description = parseWorkflow(readFileSync(join(dir, entry), "utf8")).meta
        .description;
    } catch {
      description = "(unparseable)";
    }
    out.push({ name: m[1], description });
  }
  return out;
}

export function deleteWorkflowScript(
  name: string,
  dir = WORKFLOWS_DIR,
): boolean {
  const safe = sanitizeWorkflowName(name);
  const file = join(dir, `${safe}.js`);
  try {
    unlinkSync(file);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

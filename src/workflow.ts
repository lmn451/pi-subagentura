// Workflow runtime — ports Claude Code's "Dynamic Workflows" into pi-subagentura.
//
// The main agent authors a JS script of the shape:
//
//     export const meta = { name, description, phases };   // pure literal, parsed statically
//     // top-level body using injected globals:
//     phase("scan");
//     const findings = await parallel(files.map(f => () => agent(`review ${f}`, { schema: S })));
//     return { findings };
//
// Helpers (agent/parallel/pipeline/phase/log/workflow) and globals (args/budget) are injected
// into a `vm` context. Each `agent()` call spawns an ISOLATED sub-agent. The default backend is the
// in-process `startSubagentJob` primitive; `agent(p, { isolation: "process" })` instead spawns a
// tmux/zellij Pi process (real process isolation, attachable). Intermediate results live in script
// variables rather than the parent agent's context window.
//
// v2 adds: background (async) execution via a workflow-job registry, tmux process-backed agents,
// and saved/named workflows with one-level `workflow(name, args)` composition.
//
// NOTE: `vm.runInNewContext` is NOT a security boundary — the script author is the trusted main
// agent. It does isolate from Node globals (require/process/module are not injected) and from the
// host scope chain: eval/new Function inside the sandbox inherit the sandbox Date/Math, so even
// `({}).constructor.constructor('return Date')()` returns the guarded Date, not the host's. The
// guarantees we actually enforce: no Node globals are reachable; determinism guards throw on
// Date.now(), Math.random(), and argless `new Date()` inside a script.

import { runInNewContext } from "node:vm";
import { cpus, homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { startSubagentJob, debugLog } from "./helpers";
import type { SubagentResult, Usage } from "./helpers";
import {
  launchInteractiveSubagent,
  cancelInteractiveSubagent,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { readEvents, readOutput } from "./artifact";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Limits ───────────────────────────────────────────────────────────
export const MAX_TOTAL_AGENTS = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const SCHEMA_RETRIES = 3;
export const MAX_WORKFLOW_DEPTH = 1; // workflow() composition is one level deep
const INTERACTIVE_POLL_MS = 1000;
const INTERACTIVE_DEAD_GRACE_TICKS = 3;

function defaultConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(16, n - 2));
}
function defaultProcessConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(4, n - 2));
}
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

// ── Public types ─────────────────────────────────────────────────────

/** Options accepted by the injected `agent()` helper. */
export interface WorkflowAgentOpts {
  schema?: unknown;
  label?: string;
  phase?: string;
  model?: string;
  persona?: string;
  /** "process" routes to a tmux/zellij Pi process; otherwise in-process. */
  isolation?: string;
  /** Accepted for fidelity but a no-op in v2. */
  agentType?: string;
}

/** Injectable spawn function — the real one wraps startSubagentJob / launchInteractiveSubagent. */
export type WorkflowAgentRunner = (req: {
  prompt: string;
  persona?: string;
  model?: string;
  signal?: AbortSignal;
  isolation?: string;
  label?: string;
}) => Promise<SubagentResult>;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
  [k: string]: unknown;
}

export interface WorkflowProgress {
  kind: "phase" | "log" | "agent";
  phase?: string;
  message?: string;
  label?: string;
  agentsSpawned: number;
  errorCount: number;
  tokensSpent: number;
}

export interface WorkflowRunResult {
  meta: WorkflowMeta;
  result: unknown;
  agentsSpawned: number;
  errorCount: number;
  tokensSpent: number;
  phases: string[];
}

export interface RunWorkflowOptions {
  args?: unknown;
  budgetTotal?: number | null;
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onProgress?: (p: WorkflowProgress) => void;
  concurrency?: number;
  processConcurrency?: number;
  /** Resolve a saved workflow script by name, for `workflow(name, args)` composition. */
  loadWorkflow?: (name: string) => string | null;
}

// ── Script parsing ───────────────────────────────────────────────────

/**
 * Split a workflow script into its static `meta` literal and the executable body.
 * `meta` must be a pure literal — it is evaluated in a helperless context, so a literal that
 * references `agent`/etc. throws.
 */
export function parseWorkflow(script: string): {
  meta: WorkflowMeta;
  body: string;
} {
  const metaRe = /(^|\n)\s*export\s+const\s+meta\s*=\s*/;
  const m = metaRe.exec(script);
  if (!m) {
    throw new Error(
      "Workflow script must declare `export const meta = { name, description }` as a pure literal.",
    );
  }
  const braceStart = script.indexOf("{", m.index + m[0].length);
  if (braceStart === -1) {
    throw new Error(
      "`export const meta` must be assigned an object literal `{ ... }`.",
    );
  }
  const braceEnd = matchBrace(script, braceStart);
  const metaText = script.slice(braceStart, braceEnd + 1);

  let meta: WorkflowMeta;
  try {
    // Evaluate in a helperless context with determinism guards present — a pure literal needs none
    // of them, so any reference (to a helper, or to Date/Math) throws and is reported clearly.
    meta = runInNewContext(`(${metaText})`, {
      Date: makeGuardedDate(),
      Math: makeGuardedMath(),
    }) as WorkflowMeta;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Workflow \`meta\` must be a pure literal (no variables/calls). Eval failed: ${msg}`,
    );
  }
  if (!meta || typeof meta !== "object") {
    throw new Error("Workflow `meta` did not evaluate to an object.");
  }
  if (typeof meta.name !== "string" || !meta.name) {
    throw new Error("Workflow `meta.name` must be a non-empty string.");
  }
  if (typeof meta.description !== "string" || !meta.description) {
    throw new Error("Workflow `meta.description` must be a non-empty string.");
  }

  // Remove the whole `export const meta = {...};` span from the body, then defensively strip any
  // remaining line-anchored `export`/`export default` tokens (workflow bodies are top-level code).
  let trailing = braceEnd + 1;
  if (script[trailing] === ";") trailing++;
  const body = (script.slice(0, m.index) + script.slice(trailing))
    .replace(/(^|\n)\s*export\s+default\s+/g, "$1")
    .replace(/(^|\n)\s*export\s+/g, "$1");
  return { meta, body };
}

/** Brace-match starting at `openIdx` (which must point at `{`), skipping strings and comments. */
function matchBrace(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("Unbalanced braces in `export const meta` literal.");
}

/** Given index of a quote char, return index just past the closing quote. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return src.length;
}

// ── Determinism guards ───────────────────────────────────────────────

function makeGuardedDate(): typeof Date {
  const Guard = function (this: unknown, ...a: unknown[]) {
    if (a.length === 0) {
      throw new Error(
        "`new Date()` with no args is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
      );
    }
    // @ts-expect-error spread into Date constructor
    return new Date(...a);
  } as any;
  Guard.now = () => {
    throw new Error(
      "`Date.now()` is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
    );
  };
  Guard.parse = Date.parse;
  Guard.UTC = Date.UTC;
  Guard.prototype = Date.prototype;
  return Guard as typeof Date;
}

function makeGuardedMath(): Math {
  return new Proxy(Math, {
    get(target, prop, recv) {
      if (prop === "random") {
        return () => {
          throw new Error(
            "`Math.random()` is non-deterministic and unavailable in workflows. Vary by index instead.",
          );
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

// ── Minimal JSON-Schema validation (dependency-free) ─────────────────

/** Strip markdown fences and extract the first balanced JSON value from free-form model text. */
export function extractJson(text: string): string | null {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let i = start;
  let inStr: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
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
  if (matchesType(value, "object") && schema.properties) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in obj)) errs.push(`${path}.${r}: required property missing`);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in obj) errs.push(...validateSchema(obj[k], sub, `${path}.${k}`));
    }
  }
  if (matchesType(value, "array") && schema.items) {
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
    arr.forEach((el, idx) =>
      errs.push(...validateSchema(el, schema.items, `${path}[${idx}]`)),
    );
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
      return true;
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

interface Semaphore {
  acquire: () => Promise<void>;
  release: () => void;
}

function createSemaphore(max: number): Semaphore {
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

// ── Engine (shared across nested workflows) ──────────────────────────

interface Engine {
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onProgress?: (p: WorkflowProgress) => void;
  sem: Semaphore;
  processSem: Semaphore;
  loadWorkflow?: (name: string) => string | null;
  budgetTotal: number | null;
  counters: { agentsSpawned: number; errorCount: number; tokensSpent: number };
  phases: string[];
}

export async function runWorkflow(
  script: string,
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const engine: Engine = {
    runAgent: opts.runAgent,
    signal: opts.signal,
    onProgress: opts.onProgress,
    sem: createSemaphore(opts.concurrency ?? defaultConcurrency()),
    processSem: createSemaphore(
      opts.processConcurrency ?? defaultProcessConcurrency(),
    ),
    loadWorkflow: opts.loadWorkflow,
    budgetTotal: opts.budgetTotal ?? null,
    counters: { agentsSpawned: 0, errorCount: 0, tokensSpent: 0 },
    phases: [],
  };
  const { meta, result } = await executeScript(script, engine, opts.args, 0);
  return {
    meta,
    result,
    agentsSpawned: engine.counters.agentsSpawned,
    errorCount: engine.counters.errorCount,
    tokensSpent: engine.counters.tokensSpent,
    phases: engine.phases,
  };
}

async function executeScript(
  script: string,
  engine: Engine,
  args: unknown,
  depth: number,
): Promise<{ meta: WorkflowMeta; result: unknown }> {
  const { meta, body } = parseWorkflow(script);

  const checkAbort = () => {
    if (engine.signal?.aborted) throw new Error("Workflow aborted.");
  };

  const budget = {
    total: engine.budgetTotal,
    spent: () => engine.counters.tokensSpent,
    remaining: () =>
      engine.budgetTotal == null
        ? Infinity
        : Math.max(0, engine.budgetTotal - engine.counters.tokensSpent),
  };

  const emit = (
    p: Omit<WorkflowProgress, "agentsSpawned" | "errorCount" | "tokensSpent">,
  ) =>
    engine.onProgress?.({
      ...p,
      agentsSpawned: engine.counters.agentsSpawned,
      errorCount: engine.counters.errorCount,
      tokensSpent: engine.counters.tokensSpent,
    });

  async function agent(
    prompt: unknown,
    agentOpts: WorkflowAgentOpts = {},
  ): Promise<unknown> {
    checkAbort();
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("agent(prompt): prompt must be a non-empty string.");
    }
    if (engine.counters.agentsSpawned >= MAX_TOTAL_AGENTS) {
      throw new Error(
        `Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent lifetime cap.`,
      );
    }
    if (budget.total != null && budget.remaining() <= 0) {
      throw new Error("Workflow token budget exhausted.");
    }

    const hasSchema = agentOpts.schema != null;
    const isProcess = agentOpts.isolation === "process";
    const sem = isProcess ? engine.processSem : engine.sem;
    await sem.acquire();
    try {
      let lastErr = "";
      const attempts = hasSchema ? SCHEMA_RETRIES : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        checkAbort();
        engine.counters.agentsSpawned++;
        const finalPrompt = hasSchema
          ? buildSchemaPrompt(prompt, agentOpts.schema, attempt, lastErr)
          : prompt;
        const res = await engine.runAgent({
          prompt: finalPrompt,
          persona: agentOpts.persona,
          model: agentOpts.model,
          signal: engine.signal,
          isolation: agentOpts.isolation,
          label: agentOpts.label,
        });
        engine.counters.tokensSpent += res.usage?.output ?? 0;
        emit({ kind: "agent", label: agentOpts.label, phase: agentOpts.phase });

        if (res.isError) {
          engine.counters.errorCount++;
          return null;
        }
        if (!hasSchema) return res.output;

        const raw = extractJson(res.output);
        if (raw != null) {
          try {
            const parsed = JSON.parse(raw);
            const verrs = validateSchema(parsed, agentOpts.schema);
            if (verrs.length === 0) return parsed;
            lastErr = verrs.slice(0, 5).join("; ");
          } catch (e) {
            lastErr = `JSON parse error: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else {
          lastErr = "no JSON object/array found in output";
        }
      }
      engine.counters.errorCount++;
      emit({
        kind: "log",
        message: `agent(schema) failed after ${attempts} attempts: ${lastErr}`,
      });
      return null;
    } finally {
      sem.release();
    }
  }

  async function parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks))
      throw new Error("parallel(thunks): expected an array of functions.");
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new Error(
        `parallel(): ${thunks.length} thunks exceeds the ${MAX_ITEMS_PER_CALL} cap.`,
      );
    }
    return Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(() => {
            if (typeof t !== "function")
              throw new Error(
                "parallel(): each item must be a thunk () => Promise.",
              );
            if (engine.signal?.aborted) throw new Error("Workflow aborted.");
            return t();
          })
          .catch((err) => {
            // Re-throw on abort so Promise.all rejects and the calling workflow
            // sees the cancellation. Otherwise agents that aborted in-flight
            // would silently land as nulls and the caller couldn't tell.
            if (engine.signal?.aborted) {
              debugLog("warn", "parallel_thunk_aborted", {
                err: err instanceof Error ? err.message : String(err),
              });
              throw err;
            }
            debugLog("warn", "parallel_thunk_failed", {
              err: err instanceof Error ? err.message : String(err),
            });
            return null;
          }),
      ),
    );
  }

  async function pipeline(
    items: unknown,
    ...stages: unknown[]
  ): Promise<unknown[]> {
    if (!Array.isArray(items))
      throw new Error("pipeline(items, ...stages): items must be an array.");
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new Error(
        `pipeline(): ${items.length} items exceeds the ${MAX_ITEMS_PER_CALL} cap.`,
      );
    }
    const fns = stages.filter((s) => typeof s === "function") as Array<
      (prev: unknown, item: unknown, index: number) => unknown
    >;
    return Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        try {
          for (const stage of fns) {
            if (engine.signal?.aborted) throw new Error("Workflow aborted.");
            acc = await stage(acc, item, index);
          }
          return acc;
        } catch (err) {
          // Re-throw on abort so Promise.all rejects and remaining stages / items
          // are not invoked. Silently nulling here would hide cancellation from
          // the caller and leave downstream stages running.
          if (engine.signal?.aborted) {
            debugLog("warn", "pipeline_stage_aborted", {
              itemIndex: index,
              err: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
          debugLog("warn", "pipeline_stage_failed", {
            itemIndex: index,
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );
  }

  function phase(title: unknown): void {
    const t = String(title ?? "");
    engine.phases.push(t);
    emit({ kind: "phase", phase: t });
  }

  function log(message: unknown): void {
    emit({ kind: "log", message: String(message ?? "") });
  }

  async function workflow(
    nameOrRef: unknown,
    childArgs?: unknown,
  ): Promise<unknown> {
    if (depth >= MAX_WORKFLOW_DEPTH) {
      throw new Error("workflow() composition is one level deep only.");
    }
    let childScript: string | null = null;
    if (typeof nameOrRef === "string") {
      childScript = engine.loadWorkflow ? engine.loadWorkflow(nameOrRef) : null;
      if (childScript == null)
        throw new Error(`workflow(): no saved workflow named "${nameOrRef}".`);
    } else if (
      nameOrRef &&
      typeof nameOrRef === "object" &&
      typeof (nameOrRef as any).scriptPath === "string"
    ) {
      const p = (nameOrRef as any).scriptPath as string;
      if (!existsSync(p))
        throw new Error(`workflow(): scriptPath not found: ${p}`);
      childScript = readFileSync(p, "utf8");
    } else {
      throw new Error(
        "workflow(nameOrRef): expected a saved-workflow name or { scriptPath }.",
      );
    }
    const child = await executeScript(
      childScript,
      engine,
      childArgs,
      depth + 1,
    );
    return child.result;
  }

  const sandbox: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow,
    args,
    budget,
    console: {
      log: (...a: unknown[]) => log(a.map((x) => stringify(x)).join(" ")),
      error: (...a: unknown[]) => log(a.map((x) => stringify(x)).join(" ")),
      warn: (...a: unknown[]) => log(a.map((x) => stringify(x)).join(" ")),
    },
    Date: makeGuardedDate(),
    Math: makeGuardedMath(),
  };

  const wrapped = `(async () => {\n${body}\n})()`;
  let result: unknown;
  try {
    result = await runInNewContext(wrapped, sandbox, {
      filename: `workflow:${meta.name}.js`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Workflow "${meta.name}" failed: ${msg}`);
  }
  return { meta, result };
}

function stringify(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function buildSchemaPrompt(
  prompt: string,
  schema: unknown,
  attempt: number,
  lastErr: string,
): string {
  const schemaText = JSON.stringify(schema, null, 2);
  const retry =
    attempt > 0
      ? `\n\nYour previous response did not satisfy the schema (${lastErr}). Return corrected JSON only.`
      : "";
  return (
    `${prompt}\n\n` +
    `Respond with ONLY a single JSON value that conforms to this JSON Schema. ` +
    `No prose, no markdown fences, no commentary.\n\nJSON Schema:\n${schemaText}${retry}`
  );
}

// ── tmux/zellij process-backed agents ────────────────────────────────

/** Build a SubagentArtifact view over an interactive sub-agent's on-disk artifact dir. */
function artifactFor(state: InteractiveSubagentState) {
  return {
    id: state.id,
    dir: state.artifactDir,
    statusFile: join(state.artifactDir, "events.ndjson"),
    outputFile: join(state.artifactDir, "output.md"),
  };
}

/**
 * Await a process-backed (tmux/zellij) sub-agent's terminal event by polling its artifact dir,
 * then read its output.md. Honors the abort signal and detects a dead pane that never completed.
 */
export async function awaitInteractiveResult(
  state: InteractiveSubagentState,
  signal: AbortSignal | undefined,
  pollMs = INTERACTIVE_POLL_MS,
): Promise<SubagentResult> {
  const art = artifactFor(state);
  let deadTicks = 0;
  for (;;) {
    if (signal?.aborted) {
      try {
        cancelInteractiveSubagent(state.id);
      } catch {
        /* best effort */
      }
      return {
        isError: true,
        output: "",
        usage: zeroUsage(),
        model: undefined,
        errorMessage: "aborted",
      };
    }
    const events = readEvents(art);
    const terminal = [...events]
      .reverse()
      .find(
        (e) =>
          e.type === "done" || e.type === "error" || e.type === "cancelled",
      );
    if (terminal) {
      const output = readOutput(art) ?? "(no output)";
      if (terminal.type === "done") {
        return {
          isError: false,
          output,
          usage: zeroUsage(),
          model: state.model ?? "process",
        };
      }
      return {
        isError: true,
        output,
        usage: zeroUsage(),
        model: undefined,
        errorMessage:
          terminal.message ?? `interactive sub-agent ${terminal.type}`,
      };
    }
    // No terminal event yet — if the pane has died, give it a few grace ticks for a final flush.
    let alive = true;
    try {
      alive = isPaneAlive(state);
    } catch {
      alive = false;
    }
    if (!alive) {
      deadTicks++;
      debugLog("warn", "interactive_dead_pane", {
        deadTicks,
        graceLimit: INTERACTIVE_DEAD_GRACE_TICKS,
      });
      if (deadTicks >= INTERACTIVE_DEAD_GRACE_TICKS) {
        const output = readOutput(art) ?? "(no output)";
        return {
          isError: true,
          output,
          usage: zeroUsage(),
          model: undefined,
          errorMessage: "interactive sub-agent pane exited before completing",
        };
      }
    } else {
      deadTicks = 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── Background workflow-job registry ─────────────────────────────────

export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowJobState {
  id: string;
  name: string;
  status: WorkflowJobStatus;
  startedAt: number;
  promise: Promise<WorkflowRunResult>;
  abort: AbortController;
  snapshot: {
    agentsSpawned: number;
    errorCount: number;
    tokensSpent: number;
    phases: string[];
    lastMessage?: string;
    currentPhase?: string;
  };
  result?: WorkflowRunResult;
  error?: string;
}

const g = typeof global !== "undefined" ? global : globalThis;
declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaWorkflowJobs: Map<string, WorkflowJobState> | undefined;
}
if (!g.__piSubagenturaWorkflowJobs) {
  g.__piSubagenturaWorkflowJobs = new Map<string, WorkflowJobState>();
}
export const workflowJobRegistry = g.__piSubagenturaWorkflowJobs as Map<
  string,
  WorkflowJobState
>;

export const MAX_WORKFLOW_JOBS = 100;

/** Start a workflow running in the background. Returns the job id immediately. */
export function startWorkflowJob(
  name: string,
  script: string,
  opts: Omit<RunWorkflowOptions, "signal" | "onProgress">,
): WorkflowJobState {
  while (workflowJobRegistry.size >= MAX_WORKFLOW_JOBS) {
    // Evict the oldest terminal job; if none, allow slight overcap.
    let evicted = false;
    for (const [id, st] of workflowJobRegistry) {
      if (st.status !== "running") {
        debugLog("info", "workflow_job_evicted", { evictedId: id });
        workflowJobRegistry.delete(id);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      debugLog("warn", "workflow_job_cap_reached", {
        registrySize: workflowJobRegistry.size,
        cap: MAX_WORKFLOW_JOBS,
      });
      break;
    }
  }

  const id = `wf_${randomBytes(5).toString("hex")}`;
  const abort = new AbortController();
  const state: WorkflowJobState = {
    id,
    name,
    status: "running",
    startedAt: 0,
    promise: undefined as unknown as Promise<WorkflowRunResult>,
    abort,
    snapshot: { agentsSpawned: 0, errorCount: 0, tokensSpent: 0, phases: [] },
  };
  state.promise = runWorkflow(script, {
    ...opts,
    signal: abort.signal,
    onProgress: (p) => {
      state.snapshot.agentsSpawned = p.agentsSpawned;
      state.snapshot.errorCount = p.errorCount;
      state.snapshot.tokensSpent = p.tokensSpent;
      if (p.kind === "phase" && p.phase) {
        state.snapshot.currentPhase = p.phase;
        state.snapshot.phases.push(p.phase);
      }
      if (p.kind === "log" && p.message) state.snapshot.lastMessage = p.message;
    },
  })
    .then((r) => {
      if (state.status === "running") state.status = "done";
      state.result = r;
      return r;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = msg;
      throw err;
    });
  // Don't crash the process on an unobserved rejection before get_workflow_result is called.
  state.promise.catch(() => {});
  workflowJobRegistry.set(id, state);
  return state;
}

// ── Tool registration ────────────────────────────────────────────────

export function registerWorkflowTool(pi: ExtensionAPI): void {
  debugLog("info", "workflow_registered", {});
  // Build the real spawn function from the tool ctx. Switches backend on `isolation`.
  function makeRunAgent(ctx: any): WorkflowAgentRunner {
    return async ({ prompt, persona, model, signal, isolation, label }) => {
      if (isolation === "process") {
        try {
          const state = launchInteractiveSubagent({
            name: (label || "wf-agent").slice(0, 40),
            task: prompt,
            persona,
            model,
            cwd: ctx.cwd,
            contextText: null,
            background: true,
          });
          return await awaitInteractiveResult(state, signal);
        } catch (err) {
          // tmux/zellij unavailable (or launch failed) — fall back to in-process, loudly.
          const msg = err instanceof Error ? err.message : String(err);
          debugLog("warn", "isolation_process_fallback", { reason: msg });
          const { jobPromise } = await startSubagentJob({
            task: `[isolation:process unavailable — ran in-process; reason: ${msg}]\n\n${prompt}`,
            persona,
            modelOverride: model,
            cwd: ctx.cwd,
            contextText: null,
            signal,
            onUpdate: undefined,
            defaultModel: ctx.model,
            parentModelRegistry: ctx.modelRegistry,
          });
          return jobPromise;
        }
      }
      const { jobPromise } = await startSubagentJob({
        task: prompt,
        persona,
        modelOverride: model,
        cwd: ctx.cwd,
        contextText: null,
        signal,
        onUpdate: undefined,
        defaultModel: ctx.model,
        parentModelRegistry: ctx.modelRegistry,
      });
      return jobPromise;
    };
  }

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Run an agent-authored JavaScript workflow that deterministically orchestrates ISOLATED",
      "sub-agents. Intermediate results live in script variables, not your context window — fan out",
      "dozens of sub-agents (review pipelines, research sweeps, migrations) without context pressure.",
      "",
      "Script shape:",
      "  export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] };",
      "  phase('Scan');",
      "  const out = await parallel([() => agent('task A'), () => agent('task B')]);",
      "  return out;",
      "",
      "Injected helpers/globals:",
      "  agent(prompt, opts?)   -> spawn one isolated sub-agent. opts: { schema?, label?, phase?,",
      "                            model?, persona?, isolation? }. Without schema returns the final text;",
      "                            with schema (a JSON Schema) returns a validated object, or null after",
      "                            retries. Returns null on error (filter with Boolean).",
      "                            isolation:'process' spawns a tmux/zellij Pi process (real isolation,",
      "                            attachable); falls back to in-process if no multiplexer is available.",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  workflow(name, args?)  -> run a saved workflow inline (one level deep).",
      "  phase(title) / log(msg)-> progress UI only.  args -> your `args`.  budget -> token accounting.",
      "",
      "Run a saved workflow by passing `name` instead of `script`. Pass `async: true` to run in the",
      "background (returns a workflowId; poll get_workflow_status / get_workflow_result).",
      "Constraints: Date.now()/Math.random()/argless new Date() throw; concurrency capped automatically;",
      `>${MAX_TOTAL_AGENTS} agents or >${MAX_ITEMS_PER_CALL} items per call throws. meta MUST be a pure literal.`,
    ].join("\n"),
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          description:
            "The workflow script (export const meta + top-level body). Omit if using `name`.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Name of a saved workflow to run (instead of `script`).",
        }),
      ),
      args: Type.Optional(
        Type.Unknown({
          description: "JSON value exposed to the script as `args`.",
        }),
      ),
      budget: Type.Optional(
        Type.Number({
          description:
            "Optional total output-token target; agent() throws once exhausted.",
        }),
      ),
      async: Type.Optional(
        Type.Boolean({
          description:
            "Run in the background and return a workflowId immediately.",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ): Promise<any> {
      const script: string | null =
        typeof params.script === "string" && params.script.trim()
          ? params.script
          : params.name
            ? loadWorkflowScript(params.name)
            : null;
      if (!script) {
        const why = params.name
          ? `no saved workflow named "${params.name}"`
          : "provide `script` or `name`";
        return {
          content: [{ type: "text", text: `Workflow not run: ${why}.` }],
          details: { status: "error", error: why },
          isError: true,
        };
      }

      const runAgent = makeRunAgent(ctx);
      const baseOpts = {
        args: params.args,
        budgetTotal: params.budget ?? null,
        runAgent,
        loadWorkflow: (n: string) => loadWorkflowScript(n),
      };

      // ── Async (background) path ──
      if (params.async === true) {
        let meta: WorkflowMeta;
        try {
          meta = parseWorkflow(script).meta;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        const job = startWorkflowJob(meta.name, script, baseOpts);
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${meta.name}" started in background as ${job.id}. Poll get_workflow_status / get_workflow_result.`,
            },
          ],
          details: { status: "started", workflowId: job.id, name: meta.name },
        };
      }

      // ── Synchronous (block-and-stream) path ──
      try {
        const run = await runWorkflow(script, {
          ...baseOpts,
          signal,
          onProgress: (p) => {
            try {
              onUpdate?.({
                content: [{ type: "text", text: renderProgress(p) }],
                details: {
                  status: "running",
                  agentsSpawned: p.agentsSpawned,
                  errorCount: p.errorCount,
                  tokensSpent: p.tokensSpent,
                },
              });
            } catch {
              /* onUpdate is best-effort */
            }
          },
        });
        const resultText =
          typeof run.result === "string" ? run.result : stringify(run.result);
        const summary =
          `Workflow "${run.meta.name}" complete — ${run.agentsSpawned} agent(s), ` +
          `${run.errorCount} error(s), ${run.tokensSpent} output tokens.`;
        return {
          content: [{ type: "text", text: `${summary}\n\n${resultText}` }],
          details: {
            status: "done",
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            phases: run.phases,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Workflow failed: ${msg}` }],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── get_workflow_status ──
  pi.registerTool({
    name: "get_workflow_status",
    label: "Workflow Status",
    description:
      "Poll a background workflow's live progress (agents spawned, errors, tokens, current phase).",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: `Workflow ${params.workflowId} not found.` },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Workflow "${st.name}" [${st.status}] — ${st.snapshot.agentsSpawned} agent(s), ` +
              `${st.snapshot.errorCount} error(s), ${st.snapshot.tokensSpent} tokens` +
              (st.snapshot.currentPhase
                ? `, phase: ${st.snapshot.currentPhase}`
                : "") +
              (st.error ? `\nerror: ${st.error}` : ""),
          },
        ],
        details: {
          status: st.status,
          workflowId: st.id,
          name: st.name,
          ...st.snapshot,
        },
      };
    },
  });

  // ── get_workflow_result ──
  pi.registerTool({
    name: "get_workflow_result",
    label: "Workflow Result",
    description:
      "Block until a background workflow finishes and return its final result.",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: `Workflow ${params.workflowId} not found.` },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      try {
        const run = await st.promise;
        const resultText =
          typeof run.result === "string" ? run.result : stringify(run.result);
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${run.meta.name}" complete — ${run.agentsSpawned} agent(s), ` +
                `${run.errorCount} error(s), ${run.tokensSpent} tokens.\n\n${resultText}`,
            },
          ],
          details: {
            status: "done",
            workflowId: st.id,
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            phases: run.phases,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Workflow ${st.id} ${st.status}: ${msg}` },
          ],
          details: { status: st.status, workflowId: st.id, error: msg },
          isError: true,
        };
      }
    },
  });

  // ── cancel_workflow ──
  pi.registerTool({
    name: "cancel_workflow",
    label: "Cancel Workflow",
    description:
      "Abort a running background workflow (stops scheduling new agents; in-flight agents are signalled).",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: `Workflow ${params.workflowId} not found.` },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      st.abort.abort();
      if (st.status === "running") st.status = "cancelled";
      return {
        content: [{ type: "text", text: `Workflow ${st.id} cancelled.` }],
        details: { status: "cancelled", workflowId: st.id },
      };
    },
  });

  // ── save_workflow ──
  pi.registerTool({
    name: "save_workflow",
    label: "Save Workflow",
    description:
      "Persist a workflow script under a name so it can be run later by `name` or composed via workflow(name).",
    parameters: Type.Object({
      name: Type.String({
        description: "Slug name (lowercase letters, digits, hyphens; max 64).",
      }),
      script: Type.String({
        description: "The workflow script to save (validated before writing).",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const file = saveWorkflowScript(params.name, params.script);
        return {
          content: [
            {
              type: "text",
              text: `Saved workflow "${params.name}" to ${file}.`,
            },
          ],
          details: { status: "saved", name: params.name, file },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Could not save workflow: ${msg}` }],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── list_workflows ──
  pi.registerTool({
    name: "list_workflows",
    label: "List Workflows",
    description: "List saved workflows (name + description).",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      const items = listSavedWorkflows();
      const text = items.length
        ? items.map((w) => `- ${w.name}: ${w.description}`).join("\n")
        : "(no saved workflows)";
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", workflows: items },
      };
    },
  });
}

function renderProgress(p: WorkflowProgress): string {
  const head = `● workflow — ${p.agentsSpawned} agent(s), ${p.errorCount} error(s)`;
  if (p.kind === "phase") return `${head}\n  phase: ${p.phase}`;
  if (p.kind === "log") return `${head}\n  ${p.message}`;
  return `${head}${p.label ? `\n  → ${p.label}` : ""}`;
}

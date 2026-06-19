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
// into a `vm` context. Each `agent()` call spawns an ISOLATED in-process sub-agent via the same
// `startSubagentJob` primitive the other tools use, so intermediate results live in script
// variables rather than the parent agent's context window.
//
// NOTE: `vm.runInNewContext` is NOT an escape-proof jail. The script author is the trusted main

// agent, so we don't try to be one. The guarantees we actually make:

//   - No Node globals (process/require/module/Buffer/...) are injected into the sandbox.

//   - `Date.now()`, `Math.random()`, and argless `new Date()` throw when called DIRECTLY

//     (i.e. as bare identifiers resolved in the sandbox scope). This blocks the obvious

//     non-determinism footguns for a model writing naive script code.

//   - `eval(code)` and `new Function(code)` are NOT blocked: the code they evaluate runs in

//     the real global scope and can reach the real `Date.now()` / `Math.random()`. A script

//     author who goes out of their way to be non-deterministic can be — and the script

//     author is trusted, so that's fine. Sub-agent results are non-deterministic too

//     (LLM output), so "deterministic orchestration" below only means deterministic control

//     flow, not deterministic end-to-end results.

import { runInNewContext } from "node:vm";
import { cpus } from "node:os";
import { startSubagentJob } from "./helpers";
import type { SubagentResult } from "./helpers";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Limits ───────────────────────────────────────────────────────────
export const MAX_TOTAL_AGENTS = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const SCHEMA_RETRIES = 3;

function defaultConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(16, n - 2));
}

// ── Public types ─────────────────────────────────────────────────────

/** Options accepted by the injected `agent()` helper. */
export interface WorkflowAgentOpts {
  schema?: unknown;
  label?: string;
  phase?: string;
  model?: string;
  persona?: string;
  /** Accepted for fidelity but a no-op in v1. */
  agentType?: string;
  /** Accepted for fidelity but a no-op in v1 (tmux/worktree backends are v2). */
  isolation?: string;
}

/** Injectable spawn function — the real one wraps startSubagentJob; tests mock it. */
export type WorkflowAgentRunner = (req: {
  prompt: string;
  persona?: string;
  model?: string;
  signal?: AbortSignal;
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

/** Given index of a quote char, return index just past the closing quote. Template strings only
 * skip top-level — nested `${}` braces inside templates are rare in a meta literal and tolerated
 * by treating the whole template span up to the matching backtick. */
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

function createSemaphore(max: number) {
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

// ── The runtime ──────────────────────────────────────────────────────

export async function runWorkflow(
  script: string,
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const { meta, body } = parseWorkflow(script);
  const cap = opts.concurrency ?? defaultConcurrency();
  const sem = createSemaphore(cap);

  let agentsSpawned = 0;
  let errorCount = 0;
  let tokensSpent = 0;
  const phases: string[] = [];

  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error("Workflow aborted.");
  };

  const budget = {
    total: opts.budgetTotal ?? null,
    spent: () => tokensSpent,
    remaining: () =>
      opts.budgetTotal == null
        ? Infinity
        : Math.max(0, opts.budgetTotal - tokensSpent),
  };

  const emit = (
    p: Omit<WorkflowProgress, "agentsSpawned" | "errorCount" | "tokensSpent">,
  ) => opts.onProgress?.({ ...p, agentsSpawned, errorCount, tokensSpent });

  async function agent(
    prompt: unknown,
    agentOpts: WorkflowAgentOpts = {},
  ): Promise<unknown> {
    checkAbort();
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("agent(prompt): prompt must be a non-empty string.");
    }
    if (agentsSpawned >= MAX_TOTAL_AGENTS) {
      throw new Error(
        `Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent lifetime cap.`,
      );
    }
    if (budget.total != null && budget.remaining() <= 0) {
      throw new Error("Workflow token budget exhausted.");
    }

    const hasSchema = agentOpts.schema != null;
    await sem.acquire();
    try {
      let lastErr = "";
      const attempts = hasSchema ? SCHEMA_RETRIES : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        checkAbort();
        agentsSpawned++;
        const finalPrompt = hasSchema
          ? buildSchemaPrompt(prompt, agentOpts.schema, attempt, lastErr)
          : prompt;
        const res = await opts.runAgent({
          prompt: finalPrompt,
          persona: agentOpts.persona,
          model: agentOpts.model,
          signal: opts.signal,
        });
        tokensSpent += res.usage?.output ?? 0;
        emit({ kind: "agent", label: agentOpts.label, phase: agentOpts.phase });

        if (res.isError) {
          errorCount++;
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
      errorCount++;
      opts.onProgress?.({
        kind: "log",
        message: `agent(schema) failed after ${attempts} attempts: ${lastErr}`,
        agentsSpawned,
        errorCount,
        tokensSpent,
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
            if (opts.signal?.aborted) throw new Error("Workflow aborted.");
            return t();
          })
          .catch((err) => {
            // Re-throw on abort so Promise.all rejects and the calling workflow
            // sees the cancellation. Otherwise agents that aborted in-flight
            // would silently land as nulls and the caller couldn't tell.
            if (opts.signal?.aborted) throw err;
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
            if (opts.signal?.aborted) throw new Error("Workflow aborted.");
            acc = await stage(acc, item, index);
          }
          return acc;
        } catch (err) {
          // Re-throw on abort so Promise.all rejects and remaining stages / items
          // are not invoked. Silently nulling here would hide cancellation from
          // the caller and leave downstream stages running.
          if (opts.signal?.aborted) throw err;
          return null;
        }
      }),
    );
  }

  function phase(title: unknown): void {
    const t = String(title ?? "");
    phases.push(t);
    emit({ kind: "phase", phase: t });
  }

  function log(message: unknown): void {
    emit({ kind: "log", message: String(message ?? "") });
  }

  function workflow(): never {
    throw new Error("workflow() composition is not supported in v1.");
  }

  const sandbox: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow,
    args: opts.args,
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

  return { meta, result, agentsSpawned, errorCount, tokensSpent, phases };
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

// ── Tool registration ────────────────────────────────────────────────

export function registerWorkflowTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Run an agent-authored JavaScript workflow that orchestrates ISOLATED sub-agents with",

      "deterministic control flow (parallel/pipeline/barrier semantics are exact, but",

      "sub-agent outputs themselves are LLM-driven and non-deterministic). The script's",

      "intermediate results live in script variables, not in your context window — use this to",

      "fan out dozens of sub-agents (review pipelines, research sweeps, migrations) without",

      "context pressure.",

      "",
      "Script shape:",
      "  export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] };",
      "  // top-level body using injected globals — top-level await is allowed:",
      "  phase('Scan');",
      "  const out = await parallel([() => agent('task A'), () => agent('task B')]);",
      "  return out;",
      "",
      "Injected helpers/globals:",
      "  agent(prompt, opts?)   -> spawn one isolated sub-agent. opts: { schema?, label?, phase?,",
      "                            model?, persona? }. Without schema returns the final text string;",
      "                            with schema (a JSON Schema) returns a validated object, or null",
      "                            after retries. Returns null on sub-agent error (filter with Boolean).",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  phase(title) / log(msg)-> progress UI only.",
      "  args                   -> the JSON you pass in `args`.",
      "  budget                 -> { total, spent(), remaining() } token accounting.",
      "",
      "Constraints: Date.now()/Math.random()/argless new Date() throw when called directly",

      "(a determined script can still reach the real ones via eval/Function). Concurrency is",

      `capped automatically; >${MAX_TOTAL_AGENTS} agents or >${MAX_ITEMS_PER_CALL} items per call throws.`,

      "v1 runs to completion before returning (abortable). meta MUST be a pure literal.",
    ].join("\n"),
    parameters: Type.Object({
      script: Type.String({
        description:
          "The JavaScript workflow script (export const meta + top-level body).",
      }),
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
    }),

    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ): Promise<any> {
      const runAgent: WorkflowAgentRunner = async ({
        prompt,
        persona,
        model,
        signal: sig,
      }) => {
        const { jobPromise } = await startSubagentJob({
          task: prompt,
          persona,
          modelOverride: model,
          cwd: ctx.cwd,
          contextText: null, // isolated — fresh context per agent
          signal: sig,
          onUpdate: undefined,
          defaultModel: ctx.model,
          parentModelRegistry: ctx.modelRegistry,
        });
        return jobPromise;
      };

      try {
        const run = await runWorkflow(params.script, {
          args: params.args,
          budgetTotal: params.budget ?? null,
          runAgent,
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
}

function renderProgress(p: WorkflowProgress): string {
  const head = `● workflow — ${p.agentsSpawned} agent(s), ${p.errorCount} error(s)`;
  if (p.kind === "phase") return `${head}\n  phase: ${p.phase}`;
  if (p.kind === "log") return `${head}\n  ${p.message}`;
  return `${head}${p.label ? `\n  → ${p.label}` : ""}`;
}

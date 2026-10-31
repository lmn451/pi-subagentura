export interface ParsedWorkflowMeta {
  name: string;
  description: string;
  version?: number;
  [k: string]: unknown;
}

export interface CompiledWorkflowScript {
  format: "legacy" | "definition";
  meta: ParsedWorkflowMeta;
  body: string;
}

export function compileWorkflowScript(script: string): CompiledWorkflowScript;
export function parseWorkflow(script: string): CompiledWorkflowScript;

export function makeGuardedDate(): typeof Date;
export function makeGuardedMath(): Math;
export function workflowStringify(x: unknown): string;

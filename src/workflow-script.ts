export type ParsedWorkflowMeta = {
  name: string;
  description: string;
  argumentHint?: string;
  inputSchema?: unknown;
  [k: string]: unknown;
};

export {
  parseWorkflow,
  makeGuardedDate,
  makeGuardedMath,
  workflowStringify,
} from "./workflow-script.mjs";

export type ParsedWorkflowMeta = {
  name: string;
  description: string;
  version?: number;
  [k: string]: unknown;
};

export {
  compileWorkflowScript,
  parseWorkflow,
  makeGuardedDate,
  makeGuardedMath,
  workflowStringify,
} from "./workflow-script.mjs";

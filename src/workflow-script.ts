export type ParsedWorkflowMeta = {
  name: string;
  description: string;
  [k: string]: unknown;
};

export type DurableWorkflowOperationAnalysis =
  | {
      id: string;
      dynamicId?: never;
      kind: "agent" | "workflow";
      name?: string;
    }
  | {
      id?: never;
      dynamicId: true;
      kind: "agent";
      name?: never;
    }
  | {
      id?: never;
      dynamicId: true;
      kind: "workflow";
      name: string;
    };

export type DurableWorkflowAnalysis = {
  operations: DurableWorkflowOperationAnalysis[];
};

export {
  analyzeDurableWorkflow,
  parseWorkflow,
  makeGuardedDate,
  makeGuardedMath,
  workflowStringify,
} from "./workflow-script.mjs";

export interface ParsedWorkflowMeta {
  name: string;
  description: string;
  [k: string]: unknown;
}

export function parseWorkflow(script: string): {
  meta: ParsedWorkflowMeta;
  body: string;
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

export function analyzeDurableWorkflow(
  script: string,
  options?: { allowNested?: boolean },
): {
  operations: DurableWorkflowOperationAnalysis[];
};

export function makeGuardedDate(): typeof Date;
export function makeGuardedMath(): Math;
export function workflowStringify(x: unknown): string;

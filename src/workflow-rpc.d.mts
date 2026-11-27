import type {
  ParentWorkerMessage,
  WorkerAgentOpts,
  WorkerParentMessage,
} from "./workflow-rpc";
export function isWorkflowAgentIsolation(
  value: unknown,
): value is NonNullable<WorkerAgentOpts["isolation"]>;
export function isParentWorkerMessage(
  value: unknown,
): value is ParentWorkerMessage;
export function isWorkerParentMessage(
  value: unknown,
): value is WorkerParentMessage;

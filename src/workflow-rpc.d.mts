import type { ParentWorkerMessage, WorkerParentMessage } from "./workflow-rpc";
export function isParentWorkerMessage(
  value: unknown,
): value is ParentWorkerMessage;
export function isWorkerParentMessage(
  value: unknown,
): value is WorkerParentMessage;

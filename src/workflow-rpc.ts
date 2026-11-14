import type { ParsedWorkflowMeta } from "./workflow-script";

export interface WorkerAgentOpts {
  schema?: unknown;
  label?: string;
  phase?: string;
  model?: string;
  persona?: string;
  isolation?: string;
  agentType?: string;
  thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
}

export type WorkerRpcRequest =
  | {
      id: number;
      method: "agent";
      payload: { prompt: string; opts?: WorkerAgentOpts };
    }
  | { id: number; method: "loadWorkflow"; payload: string };
export type WorkerRpcResponse =
  | { id: number; ok: true; value: unknown; tokensDelta: number }
  | { id: number; ok: false; error: string; tokensDelta: number };
export interface WorkerInit {
  type: "init";
  script: string;
  args: unknown;
  cwd: string;
  budgetTotal: number | null;
  syncTimeoutMs: number;
  maxItemsPerCall: number;
  maxWorkflowDepth: number;
}
export type ParentWorkerMessage =
  | WorkerInit
  | { type: "abort" }
  | WorkerRpcResponse;
export type WorkerParentMessage =
  | WorkerRpcRequest
  | { type: "result"; value: { meta: ParsedWorkflowMeta; result: unknown } }
  | { type: "error"; error: string; rpcId?: number }
  | {
      type: "progress";
      payload:
        | { kind: "phase"; phase: string }
        | { kind: "log"; message: string };
    };
export {
  isParentWorkerMessage,
  isWorkerParentMessage,
} from "./workflow-rpc.mjs";

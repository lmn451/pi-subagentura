import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDurableWorkflowPlanController } from "./workflow-durable-runtime";
import { formatWorkflowPlanContext } from "./workflow-plan-context";
import type {
  ModelWorkflowPlanMutation,
  WorkflowPlanViewProjection,
} from "./workflow-plan-mutations";
import type { WorkflowPlanTaskDefinition } from "./workflow-plan";
import type { DurableWorkflowOwner } from "./workflow-run-types";
import { isDurableWorkflowRunId } from "./workflow-run-types";
import type { SessionScope } from "./session-scope";

const OWNER_SCHEMA = Type.Object(
  {
    projectKey: Type.String(),
    piSessionKey: Type.String(),
  },
  { additionalProperties: false },
);

const TASK_SCHEMA = Type.Object(
  {
    id: Type.String(),
    content: Type.String(),
    instruction: Type.String(),
    agent: Type.Optional(
      Type.Object(
        {
          label: Type.Optional(Type.String()),
          phase: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          persona: Type.Optional(Type.String()),
          isolation: Type.Optional(
            Type.Union([Type.Literal("in-process"), Type.Literal("process")]),
          ),
          agentType: Type.Optional(Type.String()),
          thinkingLevel: Type.Optional(Type.String()),
          schema: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const VIEW_ACTION_SCHEMA = Type.Object(
  { operation: Type.Literal("view") },
  { additionalProperties: false },
);

const MUTATION_FENCE_SCHEMA = {
  expectedOwner: OWNER_SCHEMA,
  expectedRunEpoch: Type.Integer({ minimum: 1 }),
  baseRevision: Type.Integer({ minimum: 1 }),
} as const;

const ACTION_SCHEMA = Type.Union([
  VIEW_ACTION_SCHEMA,
  Type.Object(
    {
      operation: Type.Literal("append"),
      ...MUTATION_FENCE_SCHEMA,
      phaseId: Type.String(),
      task: TASK_SCHEMA,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("block"),
      ...MUTATION_FENCE_SCHEMA,
      taskId: Type.String(),
      reason: Type.String({ minLength: 1, maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("unblock"),
      ...MUTATION_FENCE_SCHEMA,
      taskId: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("skip"),
      ...MUTATION_FENCE_SCHEMA,
      taskId: Type.String(),
      reason: Type.String({ minLength: 1, maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
]);

type WorkflowPlanToolMutationAction =
  | ({
      readonly operation: "append";
      readonly phaseId: string;
      readonly task: WorkflowPlanTaskDefinition;
    } & WorkflowPlanToolFence)
  | ({
      readonly operation: "block";
      readonly taskId: string;
      readonly reason: string;
    } & WorkflowPlanToolFence)
  | ({
      readonly operation: "unblock";
      readonly taskId: string;
    } & WorkflowPlanToolFence)
  | ({
      readonly operation: "skip";
      readonly taskId: string;
      readonly reason: string;
    } & WorkflowPlanToolFence);

interface WorkflowPlanToolFence {
  readonly expectedOwner: DurableWorkflowOwner;
  readonly expectedRunEpoch: number;
  readonly baseRevision: number;
}

interface WorkflowPlanToolParams {
  readonly workflowId: string;
  readonly action:
    { readonly operation: "view" } | WorkflowPlanToolMutationAction;
}

function modelMutation(
  action: WorkflowPlanToolMutationAction,
): ModelWorkflowPlanMutation {
  switch (action.operation) {
    case "append":
      return {
        operation: "append",
        phaseId: action.phaseId,
        task: action.task,
      };
    case "block":
      return {
        operation: "block",
        taskId: action.taskId,
        reason: action.reason,
      };
    case "unblock":
      return { operation: "unblock", taskId: action.taskId };
    case "skip":
      return {
        operation: "skip",
        taskId: action.taskId,
        reason: action.reason,
      };
    default:
      throw new Error("Unsupported workflow plan mutation operation.");
  }
}

interface WorkflowPlanToolDetails {
  readonly status: "ok" | "error";
  readonly error?: string;
  readonly workflowId?: string;
  readonly revision?: number;
  readonly revisionHash?: string;
  readonly runEpoch?: number;
  readonly workflowStatus?: string;
  readonly counts?: WorkflowPlanViewProjection["counts"];
}

function toolResult(view: WorkflowPlanViewProjection): {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowPlanToolDetails;
} {
  return {
    content: [{ type: "text" as const, text: formatWorkflowPlanContext(view) }],
    details: {
      status: "ok",
      workflowId: view.runId,
      revision: view.revision,
      revisionHash: view.revisionHash,
      runEpoch: view.runEpoch,
      workflowStatus: view.status,
      counts: view.counts,
    },
  };
}

/** Register the future-work-only model surface. Trusted approvals stay absent. */
export function registerWorkflowPlanMutationTool(
  pi: ExtensionAPI,
  sessionScope: SessionScope | undefined,
): void {
  pi.registerTool({
    name: "workflow_plan",
    label: "Workflow Plan",
    description:
      "View or perform exactly one fenced future-work mutation on a durable declarative workflow plan. " +
      "Allowed mutations are append, block, unblock, and audited skip. This tool cannot start or settle tasks, " +
      "change attempts, outputs, usage, approvals, or runtime evidence.",
    parameters: Type.Object(
      {
        workflowId: Type.String(),
        action: ACTION_SCHEMA,
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId: string, params: unknown) {
      try {
        // Pi validates tool parameters against ACTION_SCHEMA before invocation.
        const typedParams = params as unknown as WorkflowPlanToolParams;
        if (sessionScope === undefined) {
          throw new Error(
            "Workflow plan mutations require a live durable session.",
          );
        }
        const controller = getDurableWorkflowPlanController(sessionScope);
        if (controller === undefined) {
          throw new Error(
            "Durable workflow state is unavailable in this session.",
          );
        }
        if (!isDurableWorkflowRunId(typedParams.workflowId)) {
          throw new Error("Invalid durable workflow ID.");
        }
        if (typedParams.action.operation === "view") {
          return toolResult(
            await controller.getPlanView(typedParams.workflowId),
          );
        }
        const view = await controller.mutatePlan(typedParams.workflowId, {
          expectedOwner: typedParams.action.expectedOwner,
          expectedRunEpoch: typedParams.action.expectedRunEpoch,
          baseRevision: typedParams.action.baseRevision,
          actor: { kind: "model", id: "workflow-plan-tool" },
          mutation: modelMutation(typedParams.action),
        });
        return toolResult(view);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const details: WorkflowPlanToolDetails = {
          status: "error",
          error: message,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Workflow plan operation rejected: ${message}`,
            },
          ],
          details,
          isError: true,
        };
      }
    },
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getOrchestrationContext } from "./orchestration-context";
import {
  createValidatedEagerWorkflowPlan,
  decideWorkflowEagerRequest,
  resolveWorkflowEagerMode,
  type EagerPlanDraftFactory,
  type WorkflowEagerDecision,
  type WorkflowEagerMode,
} from "./workflow-eager-policy";
import type { DurableWorkflowPlanController } from "./workflow-durable-plan";
import { getDurableWorkflowPlanController } from "./workflow-durable-runtime";
import { handleWorkflowPlanEvolutionCommand } from "./workflow-plan-commands";
import { validateWorkflowPlan } from "./workflow-plan";
import {
  startDurableWorkflowPlanJob,
  workflowJobsForOwner,
} from "./workflow-jobs";
import {
  sessionOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";

const WORKFLOW_EAGER_FLAG = "workflow-eager";
const WORKFLOW_PLAN_COMMAND = "workflow-plan";
const WORKFLOW_TOOL = "workflow";
const WORKFLOW_PLAN_TOOL = "workflow_plan";
const WORKFLOW_PLAN_USAGE =
  "Usage: /workflow-plan create <task> | view/export/edit/append/skip/approve/deny/resume ...";
const ACTIVE_DURABLE_STATUSES: Readonly<Record<string, true>> = {
  running: true,
  blocked: true,
  awaiting_budget: true,
  interrupted: true,
};

interface ActiveWorkflow {
  readonly workflowId: string;
  readonly status: string;
}

interface StartedWorkflow extends ActiveWorkflow {
  readonly kind: "started";
}

interface ContinuedWorkflow extends ActiveWorkflow {
  readonly kind: "continuation";
}

interface FailedWorkflow {
  readonly kind: "failure";
  readonly error: string;
}

type HostWorkflowResult = StartedWorkflow | ContinuedWorkflow | FailedWorkflow;

type DurableControllerLookup = (
  scope: SessionScope,
) => DurableWorkflowPlanController | undefined;
type DurablePlanStarter = typeof startDurableWorkflowPlanJob;

/** Narrow dependency seams used by focused routing tests. */
export interface WorkflowEagerRegistrationOptions {
  readonly draftFactory?: EagerPlanDraftFactory;
  readonly getController?: DurableControllerLookup;
  readonly startPlanJob?: DurablePlanStarter;
}

interface PendingPolicyRoute {
  readonly mode: WorkflowEagerMode;
  readonly reason: string;
  readonly slices: readonly string[];
  matchingRouteObserved: boolean;
  workflowToolObserved: boolean;
  workflowPlanToolObserved: boolean;
}

interface ObservedWorkflowArgs {
  readonly durable?: unknown;
  readonly async?: unknown;
  readonly plan?: unknown;
  readonly script?: unknown;
  readonly name?: unknown;
}

function matchesPendingPolicyRoute(
  args: unknown,
  slices: readonly string[],
): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const payload = args as ObservedWorkflowArgs;
  if (
    payload.durable !== true ||
    payload.async !== true ||
    !Object.hasOwn(payload, "plan") ||
    Object.hasOwn(payload, "script") ||
    Object.hasOwn(payload, "name")
  ) {
    return false;
  }

  let plan;
  try {
    plan = validateWorkflowPlan(payload.plan);
  } catch {
    return false;
  }

  const instructions: string[] = [];
  for (const phase of plan.phases) {
    if (phase.mode !== "sequence") return false;
    for (const task of phase.tasks) {
      if (task.agent?.isolation !== "in-process") return false;
      instructions.push(
        task.instruction.replace(/\s+/g, " ").trim().toLowerCase(),
      );
    }
  }
  return (
    instructions.length === slices.length &&
    instructions.every((instruction, index) => {
      const expected = slices[index]!.replace(/\s+/g, " ").trim().toLowerCase();
      return instruction === expected;
    })
  );
}

function appendSystemContext(systemPrompt: string, context: string): string {
  return `${systemPrompt}\n\n${context}`;
}

function startedContext(result: StartedWorkflow): string {
  return [
    "[workflow-eager host route]",
    `The host created and started durable workflow plan ${result.workflowId} in this session (status: ${result.status}).`,
    "Do not perform, dispatch, or start duplicate direct work for this request. The durable plan now owns execution; use workflow status or result tools only when needed.",
  ].join("\n");
}

function continuationContext(result: ContinuedWorkflow): string {
  return [
    "[workflow-eager active workflow]",
    `The host found active workflow ${result.workflowId} (status: ${result.status}).`,
    "Treat this turn as continuation or inspection of that run. Do not create another workflow or dispatch duplicate direct work.",
  ].join("\n");
}

function failureContext(error: string): string {
  return [
    "[workflow-eager routing failure]",
    `Automatic workflow routing failed: ${error}`,
    `Surface this exact failure and recommend ${WORKFLOW_PLAN_USAGE.slice("Usage: ".length)}. Do not invoke legacy /workflow or begin duplicate direct work.`,
  ].join("\n");
}

function policyContext(decision: WorkflowEagerDecision): string {
  const slices = decision.slices
    .slice(0, 8)
    .map((slice, index) => `${index + 1}. ${slice.slice(0, 240)}`)
    .join("\n");
  return [
    "[workflow-eager policy route]",
    "Direct host start capability is unavailable, so this route is not host-enforced.",
    "Before doing or dispatching direct work, call the `workflow` tool exactly once with a declarative plan, durable: true, and async: true.",
    'Use only sequence phases with explicit stable IDs and agent isolation "in-process". Do not use script, name, process isolation, sendUserMessage, or legacy /workflow.',
    "The `workflow_plan` tool only views or mutates an existing durable plan; it cannot establish this pending route.",
    "If the tool is unavailable or fails, surface its exact error and recommend /workflow-plan create <task>.",
    slices.length > 0 ? `Bounded work slices:\n${slices}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function findLiveWorkflow(
  owner: SessionOwnerToken,
): ActiveWorkflow | undefined {
  const livePlan = workflowJobsForOwner(owner).find(
    (job) => job.kind === "plan" && job.status === "running",
  );
  return livePlan === undefined
    ? undefined
    : { workflowId: livePlan.id, status: livePlan.status };
}

async function findActiveWorkflow(
  controller: DurableWorkflowPlanController,
  owner: SessionOwnerToken,
): Promise<ActiveWorkflow | undefined> {
  const livePlan = findLiveWorkflow(owner);
  if (livePlan !== undefined) return livePlan;

  const durable = (await controller.repository.list(controller.owner)).find(
    (projection) => ACTIVE_DURABLE_STATUSES[projection.status] === true,
  );
  return durable === undefined
    ? undefined
    : { workflowId: durable.runId, status: durable.status };
}

function parseWorkflowPlanCommand(
  args: string,
): { readonly verb: string; readonly rest: string } | undefined {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (match === null) return undefined;
  return { verb: match[1]!, rest: match[2]?.trim() ?? "" };
}

function sendWorkflowPlanMessage(
  pi: ExtensionAPI,
  result:
    HostWorkflowResult | { readonly kind: "usage"; readonly error: string },
): void {
  const content =
    result.kind === "started"
      ? `Started durable workflow plan ${result.workflowId} (status: ${result.status}).`
      : result.kind === "continuation"
        ? `Active workflow ${result.workflowId} already owns this session (status: ${result.status}); no duplicate was created.`
        : result.error;
  pi.sendMessage(
    {
      customType: "workflow-plan",
      content,
      display: true,
      details: result,
    },
    { triggerTurn: false },
  );
}

/** Register opt-in natural-request routing and the host-owned declarative command. */
export function registerWorkflowEagerRouting(
  pi: ExtensionAPI,
  sessionScope: SessionScope,
  options: WorkflowEagerRegistrationOptions = {},
): void {
  const getController =
    options.getController ?? getDurableWorkflowPlanController;
  const startPlanJob = options.startPlanJob ?? startDurableWorkflowPlanJob;
  let pendingPolicyRoute: PendingPolicyRoute | undefined;
  let hostStartInFlight: Promise<HostWorkflowResult> | undefined;

  pi.registerFlag(WORKFLOW_EAGER_FLAG, {
    description:
      "Automatically route eligible complex parent requests to durable workflow plans (off|preferred|always)",
    type: "string",
    default: "off",
  });

  const doHostStart = async (
    task: string,
    slices: readonly string[],
    controller: DurableWorkflowPlanController,
  ): Promise<HostWorkflowResult> => {
    const owner = sessionOwner(sessionScope);
    try {
      const active = await findActiveWorkflow(controller, owner);
      if (active !== undefined) {
        return { kind: "continuation", ...active };
      }

      const plan = createValidatedEagerWorkflowPlan(
        task,
        slices,
        options.draftFactory,
      );
      const job = await startPlanJob(
        plan,
        controller,
        {},
        Date.now(),
        undefined,
        owner,
        "async",
      );
      return { kind: "started", workflowId: job.id, status: job.status };
    } catch (error) {
      return {
        kind: "failure",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const startHost = async (
    task: string,
    slices: readonly string[],
    controller: DurableWorkflowPlanController,
  ): Promise<HostWorkflowResult> => {
    if (hostStartInFlight !== undefined) {
      const current = await hostStartInFlight;
      return current.kind === "started"
        ? {
            kind: "continuation",
            workflowId: current.workflowId,
            status: current.status,
          }
        : current;
    }

    const operation = doHostStart(task, slices, controller);
    hostStartInFlight = operation;
    try {
      return await operation;
    } finally {
      if (hostStartInFlight === operation) hostStartInFlight = undefined;
    }
  };

  pi.on("before_agent_start", async (event) => {
    pendingPolicyRoute = undefined;
    if (getOrchestrationContext() !== undefined) return;

    const configured = resolveWorkflowEagerMode(
      pi.getFlag(WORKFLOW_EAGER_FLAG),
    );
    if (configured.error !== undefined) {
      return {
        systemPrompt: appendSystemContext(
          event.systemPrompt,
          failureContext(configured.error),
        ),
      };
    }
    if (configured.mode === "off") return;

    const decision = decideWorkflowEagerRequest(event.prompt, configured.mode);
    if (!decision.route) return;
    const livePlan = findLiveWorkflow(sessionOwner(sessionScope));
    if (livePlan !== undefined) {
      return {
        systemPrompt: appendSystemContext(
          event.systemPrompt,
          continuationContext({ kind: "continuation", ...livePlan }),
        ),
      };
    }

    const controller = getController(sessionScope);
    if (controller === undefined) {
      pendingPolicyRoute = {
        mode: configured.mode,
        reason: decision.reason,
        slices: decision.slices,
        matchingRouteObserved: false,
        workflowToolObserved: false,
        workflowPlanToolObserved: false,
      };
      return {
        systemPrompt: appendSystemContext(
          event.systemPrompt,
          policyContext(decision),
        ),
      };
    }

    const result = await startHost(event.prompt, decision.slices, controller);
    const context =
      result.kind === "started"
        ? startedContext(result)
        : result.kind === "continuation"
          ? continuationContext(result)
          : failureContext(result.error);
    return { systemPrompt: appendSystemContext(event.systemPrompt, context) };
  });

  pi.on("tool_execution_start", (event) => {
    const pending = pendingPolicyRoute;
    if (pending === undefined) return;
    if (event.toolName === WORKFLOW_PLAN_TOOL) {
      pending.workflowPlanToolObserved = true;
      return;
    }
    if (event.toolName !== WORKFLOW_TOOL) return;
    pending.workflowToolObserved = true;
    if (matchesPendingPolicyRoute(event.args, pending.slices)) {
      pending.matchingRouteObserved = true;
    }
  });

  pi.on("agent_settled", () => {
    const pending = pendingPolicyRoute;
    pendingPolicyRoute = undefined;
    if (pending === undefined || pending.matchingRouteObserved) return;

    const evidence =
      pending.workflowToolObserved && pending.workflowPlanToolObserved
        ? "The workflow and workflow_plan tools were observed, but neither payload proved the requested declarative durable route."
        : pending.workflowToolObserved
          ? "A workflow tool call was observed, but its payload did not prove the requested declarative durable route."
          : pending.workflowPlanToolObserved
            ? "The workflow_plan management tool was observed, but its view/mutation payload cannot prove that the pending route was created or started."
            : "No workflow routing tool call was observed before the agent settled.";
    pi.sendMessage(
      {
        customType: "routing_unconfirmed",
        content:
          `Workflow routing remains unconfirmed. ${evidence} ` +
          "Host enforcement was unavailable. Run /workflow-plan create <task> to use the host-owned durable path.",
        display: true,
        details: {
          status: "routing_unconfirmed",
          mode: pending.mode,
          reason: pending.reason,
          observedTools: {
            workflow: pending.workflowToolObserved,
            workflow_plan: pending.workflowPlanToolObserved,
          },
        },
      },
      { triggerTurn: false },
    );
  });

  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand(WORKFLOW_PLAN_COMMAND, {
    description:
      "Create, inspect, approve, resume, or revise a durable workflow plan",
    handler: async (args, ctx) => {
      const parsed = parseWorkflowPlanCommand(args);
      if (parsed === undefined) {
        sendWorkflowPlanMessage(pi, {
          kind: "usage",
          error: WORKFLOW_PLAN_USAGE,
        });
        return;
      }
      if (parsed.verb !== "create") {
        if (
          await handleWorkflowPlanEvolutionCommand(
            parsed.verb,
            parsed.rest,
            ctx,
            sessionScope,
            pi,
          )
        ) {
          return;
        }
        sendWorkflowPlanMessage(pi, {
          kind: "usage",
          error: WORKFLOW_PLAN_USAGE,
        });
        return;
      }
      if (!parsed.rest) {
        sendWorkflowPlanMessage(pi, {
          kind: "usage",
          error: WORKFLOW_PLAN_USAGE,
        });
        return;
      }
      if (getOrchestrationContext() !== undefined) {
        sendWorkflowPlanMessage(pi, {
          kind: "failure",
          error:
            "Durable workflow plans cannot be created inside an in-process orchestration context.",
        });
        return;
      }
      const livePlan = findLiveWorkflow(sessionOwner(sessionScope));
      if (livePlan !== undefined) {
        sendWorkflowPlanMessage(pi, { kind: "continuation", ...livePlan });
        return;
      }

      const controller = getController(sessionScope);
      if (controller === undefined) {
        sendWorkflowPlanMessage(pi, {
          kind: "failure",
          error:
            "Durable workflow session is not initialized for this cwd/session.",
        });
        return;
      }
      const decision = decideWorkflowEagerRequest(parsed.rest, "always");
      const result = await startHost(
        parsed.rest,
        decision.slices.length > 0 ? decision.slices : [parsed.rest],
        controller,
      );
      sendWorkflowPlanMessage(pi, result);
    },
  });
}

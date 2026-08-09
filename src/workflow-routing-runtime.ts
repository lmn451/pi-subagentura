import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  decideWorkflowRouting,
  parseWorkflowEagerMode,
  WorkflowRoutingMetrics,
} from "./workflow-routing";

export interface WorkflowRoutingStartResult {
  readonly status: "started";
  readonly workflowId: string;
  readonly name: string;
  readonly revision: number;
  readonly runEpoch: number;
  readonly ownerGeneration: number;
  readonly leaseEpoch: number;
}

export interface WorkflowRoutingHost {
  hasActiveWorkflow(): Promise<boolean>;
  planAndStart(
    task: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<WorkflowRoutingStartResult>;
}

interface PendingPolicyRoute {
  workflowCalls: number;
  observed: boolean;
  correctionAvailable: boolean;
  workflowCallId?: string;
}

const POLICY_INSTRUCTION = `Automatic durable workflow routing selected this request.
Before direct work or side effects, construct a bounded schemaVersion 1 declarative
plan with stable IDs, sequential phases, and in-process tasks, then call the
workflow tool with plan and durable:true. Validate before calling. You may make
at most one corrected workflow call if validation fails. Do not invoke legacy
/workflow <task>. If the durable call cannot be made, report the exact cause and
do not describe this route as host-enforced.`;

export function registerWorkflowRouting(
  pi: ExtensionAPI,
  host?: WorkflowRoutingHost,
): WorkflowRoutingMetrics {
  const metrics = new WorkflowRoutingMetrics();
  let pendingPolicy: PendingPolicyRoute | undefined;
  let hostCreationInFlight = false;

  const mode = () => parseWorkflowEagerMode(pi.getFlag("workflow-eager"));
  const sendRoutingMessage = (
    content: string,
    details: Record<string, unknown>,
  ) => {
    pi.sendMessage(
      {
        customType: "workflow-routing",
        content,
        display: true,
        details,
      },
      { triggerTurn: false },
    );
  };

  const startHostRoute = async (
    task: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowRoutingStartResult> => {
    if (!host) throw new Error("host-enforced workflow routing is unavailable");
    if (hostCreationInFlight) {
      throw new Error("another eager workflow plan is already being created");
    }
    hostCreationInFlight = true;
    try {
      return await host.planAndStart(task, ctx, ctx.signal);
    } finally {
      hostCreationInFlight = false;
    }
  };

  let policyFallbackCause: string | undefined;
  const registerPolicyLane = () => {
    pi.on("before_agent_start", async (event, ctx) => {
      const eagerMode = mode();
      if (eagerMode === "off") {
        const decision = decideWorkflowRouting({
          mode: eagerMode,
          text: event.prompt,
        });
        metrics.recordDecision(decision);
        pendingPolicy = undefined;
        return;
      }
      const routingInput = {
        mode: eagerMode,
        text: event.prompt,
        awaitingUserInput: previousAssistantAwaitsInput(ctx),
        childContext: process.env.PI_SUBAGENTURA_CHILD === "1",
      };
      let decision = decideWorkflowRouting(routingInput);
      if (decision.kind === "durable_plan" && host) {
        try {
          if (await host.hasActiveWorkflow()) {
            decision = decideWorkflowRouting({
              ...routingInput,
              hasActiveWorkflow: true,
            });
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          pendingPolicy = undefined;
          sendRoutingMessage(`Workflow routing failed: ${message}`, {
            lane: "model_policy",
            status: "error",
            error: message,
          });
          return;
        }
      }
      metrics.recordDecision(decision);
      if (decision.kind === "direct") {
        pendingPolicy = undefined;
        return;
      }
      pendingPolicy = {
        workflowCalls: 0,
        observed: false,
        correctionAvailable: true,
      };
      return {
        systemPrompt: `${event.systemPrompt}\n\n${POLICY_INSTRUCTION}`,
      };
    });

    pi.on("tool_call", (event) => {
      const pending = pendingPolicy;
      if (!pending) return;
      if (event.toolName !== "workflow") {
        return {
          block: true,
          reason:
            "Automatic durable workflow routing is pending; call workflow with plan and durable:true before other tools.",
        };
      }
      if (
        pending.workflowCalls >= 2 ||
        (pending.workflowCalls > 0 && !pending.correctionAvailable)
      ) {
        return {
          block: true,
          reason:
            pending.workflowCalls >= 2
              ? "Automatic workflow plan correction limit reached (two calls)."
              : "A workflow plan call is already running or succeeded; a correction is not allowed.",
        };
      }
      pending.workflowCalls++;
      const input = event.input as Record<string, unknown>;
      if (input.durable !== true || input.plan === undefined) {
        pending.correctionAvailable = true;
        return {
          block: true,
          reason:
            "Automatic routing requires the workflow tool with plan and durable:true; legacy workflow execution is disabled.",
        };
      }
      pending.correctionAvailable = false;
      pending.workflowCallId = event.toolCallId;
      if (!pending.observed) {
        pending.observed = true;
        metrics.recordPolicyObserved();
      }
    });

    pi.on("tool_execution_end", (event) => {
      const pending = pendingPolicy;
      if (!pending || event.toolCallId !== pending.workflowCallId) return;
      pending.workflowCallId = undefined;
      pending.correctionAvailable = event.isError;
    });

    pi.on("agent_settled", () => {
      const pending = pendingPolicy;
      pendingPolicy = undefined;
      if (!pending || pending.observed) return;
      metrics.recordRoutingUnconfirmed();
      sendRoutingMessage(
        "routing_unconfirmed: the model-policy lane did not produce an observed durable workflow plan call.",
        {
          lane: "model_policy",
          status: "routing_unconfirmed",
          ...(policyFallbackCause
            ? { capabilityReason: policyFallbackCause }
            : {}),
        },
      );
    });
  };

  if (host) {
    try {
      pi.on("input", async (event, ctx) => {
        let decision;
        try {
          const eagerMode = mode();
          if (eagerMode === "off") {
            decision = decideWorkflowRouting({
              mode: eagerMode,
              text: event.text,
            });
          } else {
            const routingInput = {
              mode: eagerMode,
              text: event.text,
              awaitingUserInput:
                event.streamingBehavior !== undefined ||
                !ctx.isIdle() ||
                previousAssistantAwaitsInput(ctx),
              childContext: process.env.PI_SUBAGENTURA_CHILD === "1",
            };
            decision = decideWorkflowRouting(routingInput);
            if (decision.kind === "durable_plan") {
              const active =
                hostCreationInFlight || (await host.hasActiveWorkflow());
              if (active) {
                decision = decideWorkflowRouting({
                  ...routingInput,
                  hasActiveWorkflow: true,
                });
              }
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendRoutingMessage(
            `Workflow routing failed: ${message}\nUse /workflow-plan create <task> to retry the host-owned declarative path.`,
            { lane: "host_enforced", status: "error", error: message },
          );
          return { action: "handled" } as const;
        }
        metrics.recordDecision(decision);
        if (decision.kind === "direct") return { action: "continue" } as const;

        try {
          const started = await startHostRoute(event.text, ctx);
          metrics.recordHostStarted();
          sendRoutingMessage(
            `Durable workflow plan "${started.name}" started in this turn as ${started.workflowId}.`,
            { lane: "host_enforced", ...started },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendRoutingMessage(
            `Workflow routing failed: ${message}\nUse /workflow-plan create <task> to retry the host-owned declarative path.`,
            { lane: "host_enforced", status: "error", error: message },
          );
        }
        return { action: "handled" } as const;
      });
    } catch (error) {
      policyFallbackCause =
        error instanceof Error ? error.message : String(error);
      registerPolicyLane();
    }
  } else {
    registerPolicyLane();
  }

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("workflow-plan", {
      description: "Create a durable declarative workflow plan from a task.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const prefix = "create ";
        const task = args.trim().startsWith(prefix)
          ? args.trim().slice(prefix.length).trim()
          : "";
        if (!task) {
          const usage = "Usage: /workflow-plan create <task>";
          ctx.ui.notify(usage, "error");
          sendRoutingMessage(usage, { status: "error" });
          return;
        }
        try {
          const started = await startHostRoute(task, ctx);
          metrics.recordHostStarted();
          const text = `Durable workflow plan "${started.name}" started as ${started.workflowId}.`;
          ctx.ui.notify(text);
          sendRoutingMessage(text, { lane: "host_command", ...started });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const text = `Workflow plan not started: ${message}`;
          ctx.ui.notify(text, "error");
          sendRoutingMessage(text, {
            lane: "host_command",
            status: "error",
            error: message,
          });
        }
      },
    });
  }

  return metrics;
}

function previousAssistantAwaitsInput(ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager as unknown as {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
  };
  const entries =
    typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : typeof manager?.getEntries === "function"
        ? manager.getEntries()
        : [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as Record<string, unknown>;
    const message =
      entry.message && typeof entry.message === "object"
        ? (entry.message as Record<string, unknown>)
        : entry;
    if (message.role !== "assistant") continue;
    const text = messageText(message.content);
    return /\?\s*$/.test(text);
  }
  return false;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

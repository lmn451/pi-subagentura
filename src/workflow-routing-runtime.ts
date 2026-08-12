import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyWorkflowRouting,
  observeWorkflowRouting,
  parseWorkflowEagerMode,
  type WorkflowEagerMode,
  type WorkflowRoutingClassification,
  type WorkflowRoutingDecision,
  type WorkflowRoutingObservation,
} from "./workflow-routing";

export interface WorkflowRoutingHostRouteResult {
  workflowToolCalled?: boolean;
}

export interface WorkflowRoutingRuntimeOptions {
  getMode: () => unknown;
  /** A host-owned controller/planner lane. Returning means work was started. */
  hostRoute?: (input: {
    prompt: string;
    classification: WorkflowRoutingClassification;
  }) =>
    | void
    | boolean
    | WorkflowRoutingHostRouteResult
    | Promise<void | boolean | WorkflowRoutingHostRouteResult>;
  childContext?: () => boolean;
  hasActiveWorkflow?: () => boolean;
  awaitingUserInput?: () => boolean;
  managementCommand?: (prompt: string) => boolean;
  planOnly?: (prompt: string) => boolean;
  socialConversation?: (prompt: string) => boolean;
  question?: (prompt: string) => boolean;
  oneCommand?: (prompt: string) => boolean;
  independentSlices?: (prompt: string) => number | undefined;
  phasedContinuation?: (prompt: string) => boolean;
  notify?: (observation: WorkflowRoutingObservation) => void;
}

export interface WorkflowRoutingRuntime {
  readonly hostHookAvailable: boolean;
  readonly hostEnforced: boolean;
  readonly lastObservation: () => WorkflowRoutingObservation | undefined;
  readonly lastDecision: () => WorkflowRoutingDecision | undefined;
  classify: (prompt: string) => WorkflowRoutingClassification;
  observe: (
    workflowToolCalled: boolean,
  ) => WorkflowRoutingObservation | undefined;
}

interface TurnRoutingState {
  prompt: string;
  decision: WorkflowRoutingDecision;
  directWorkStarted: boolean;
  workflowToolCalled: boolean;
  reported: boolean;
}

/**
 * Wire the eager capability lanes without assuming that every Pi SDK can force
 * tool choice. The policy lane only observes `tool_call`; it never starts a
 * retroactive duplicate after direct work has begun.
 */
export function registerWorkflowRoutingRuntime(
  pi: ExtensionAPI,
  options: WorkflowRoutingRuntimeOptions,
): WorkflowRoutingRuntime {
  let state: TurnRoutingState | undefined;
  let lastObservation: WorkflowRoutingObservation | undefined;
  let lastDecision: WorkflowRoutingDecision | undefined;
  let toolCallHookAvailable = false;
  let lifecycleHookAvailable = false;

  const classify = (prompt: string): WorkflowRoutingClassification => {
    let mode: WorkflowEagerMode;
    try {
      mode = parseWorkflowEagerMode(options.getMode());
    } catch {
      mode = "off";
    }
    return classifyWorkflowRouting({
      mode,
      text: prompt,
      childContext:
        options.childContext?.() ?? process.env.PI_SUBAGENTURA_CHILD === "1",
      hasActiveWorkflow: options.hasActiveWorkflow?.(),
      awaitingUserInput: options.awaitingUserInput?.(),
      managementCommand: options.managementCommand?.(prompt),
      planOnly: options.planOnly?.(prompt),
      socialConversation: options.socialConversation?.(prompt),
      question: options.question?.(prompt),
      oneCommand: options.oneCommand?.(prompt),
      independentSlices: options.independentSlices?.(prompt),
      phasedContinuation: options.phasedContinuation?.(prompt),
      // A controller callback is the only host-enforced capability. A raw
      // tool_call observer is minimum-SDK policy evidence, not enforcement.
      hostHookAvailable: typeof options.hostRoute === "function",
      directWorkStarted: state?.directWorkStarted,
    });
  };

  const emit = (observation: WorkflowRoutingObservation): void => {
    lastObservation = observation;
    options.notify?.(observation);
  };

  const observe = (
    workflowToolCalled: boolean,
  ): WorkflowRoutingObservation | undefined => {
    if (!state || state.reported) return lastObservation;
    state.workflowToolCalled ||= workflowToolCalled;
    const observation = observeWorkflowRouting({
      decision: state.decision,
      workflowToolCalled: state.workflowToolCalled,
      directWorkStarted: state.directWorkStarted,
    });
    // Suppression is useful to callers but should not create a visible routing
    // message for every ordinary direct turn.
    if (
      observation.status !== "suppressed" ||
      state.decision.kind === "durable_plan"
    ) {
      emit(observation);
    }
    state.reported = true;
    return observation;
  };

  const register = (
    event: string,
    handler: (event: unknown) => unknown,
  ): boolean => {
    try {
      const eventApi = pi as unknown as {
        on: (name: string, callback: (event: unknown) => unknown) => void;
      };
      eventApi.on(event, handler);
      return true;
    } catch {
      return false;
    }
  };

  const beforeAgentStart = async (event: unknown): Promise<void> => {
    if (
      !event ||
      typeof event !== "object" ||
      !("prompt" in event) ||
      typeof event.prompt !== "string"
    ) {
      return;
    }
    const prompt = event.prompt;
    const classification = classify(prompt);
    state = {
      prompt,
      decision: classification.decision,
      directWorkStarted: false,
      workflowToolCalled: false,
      reported: false,
    };
    lastDecision = classification.decision;
    lastObservation = undefined;
    if (classification.decision.kind !== "durable_plan") return;
    if (typeof options.hostRoute !== "function") return;
    try {
      const result = await options.hostRoute({
        prompt,
        classification,
      });
      if (
        result === true ||
        (result &&
          typeof result === "object" &&
          result.workflowToolCalled === true)
      ) {
        state.workflowToolCalled = true;
      }
    } catch {
      // A host lane failure is intentionally observed as unconfirmed below;
      // callers receive the exact route failure through their own callback.
    }
  };

  // before_agent_start exists on the minimum supported SDK. Registering it is
  // kept separate from optional tool/lifecycle hooks so old hosts still load.
  register("before_agent_start", beforeAgentStart);
  toolCallHookAvailable = register("tool_call", (event: unknown) => {
    if (!state || state.reported || !event || typeof event !== "object") return;
    const toolName =
      "toolName" in event && typeof event.toolName === "string"
        ? event.toolName
        : undefined;
    if (toolName === "workflow" || toolName === "start_durable_workflow") {
      state.workflowToolCalled = true;
      return;
    }
    // Any other tool is a direct side effect. Never create a workflow later.
    state.directWorkStarted = true;
  });
  const settle = () => {
    if (!state || state.reported) return;
    void observe(false);
  };
  lifecycleHookAvailable =
    register("agent_end", settle) || register("agent_settled", settle);

  return {
    get hostHookAvailable() {
      return toolCallHookAvailable || lifecycleHookAvailable;
    },
    get hostEnforced() {
      return typeof options.hostRoute === "function";
    },
    lastObservation: () => lastObservation,
    lastDecision: () => lastDecision,
    classify,
    observe,
  };
}

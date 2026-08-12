/**
 * pi-subagentura — In-process and interactive sub-agent tools for Pi.
 *
 * ## Public API
 *
 * **Extension entry** — default export: the extension activator function.
 *
 * **Type** — `SubagentDetails`: discriminated-union partial-result type surfaced
 * to the parent session's message renderer.
 *
 * ## Internal / testing re-exports
 *
 * The named exports below are re-exported from implementation modules for test
 * access and internal wiring. They are NOT part of the supported public API
 * and may change without a major version bump. Prefer importing from the source
 * module (`./helpers`, `./interactive-tmux`, etc.) if you depend on them.
 *
 * @module pi-subagentura
 */

import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
  type SubagentLiveStatus,
  type SubagentResult,
  type Usage,
} from "./helpers";
import { registerWorkflowTool } from "./workflow";
import {
  registerInProcessMaintenanceTools,
  registerInProcessSubagentTools,
  registerSubagentArtifactsCleanupTool,
  registerSubagentModelListTool,
} from "./tools/in-process";
import { registerInteractiveSubagentTools } from "./tools/interactive";
import { registerSessionHandlers } from "./session-handlers";
import { workflowContinuityForPi } from "./session-scope";
import { registerChildProtocol } from "./child-protocol";
import { registerCancelAllFlows } from "./cancel-all-flows-registration";
import { renderSubagentNotify } from "./rendering";
import { registerInteractiveSupervisor } from "./interactive-supervisor-registration";
import { parseWorkflowEagerMode } from "./workflow-routing";
import { formatWorkflowContinuity } from "./workflow-continuity";
/** @internal Session-rehydration helper used by session-handlers.ts */
export { rehydrateInteractiveSubagents } from "./rehydrate";
/**
 * Discriminated union describing the live status of a sub-agent job.
 * Used by `renderSubagentResult` and surfaced via `AgentToolResult.details`.
 *
 * Cases:
 * - `"started"` — async job launched, jobId available
 * - `"running"` — (in-process only) polling for live status
 * - `"done"` | `"error"` — completed with usage info
 * - `"cancelled"` | `"not_found"` — terminal states
 * - `"invalid_id"` — caller passed an unrecognised id
 */
export type SubagentDetails =
  | {
      status: "started";
      jobId: string;
      contextMessages: number;
      thinkingLevel?: ThinkingLevel;
    }
  | {
      status: "running";
      subagentStatus: SubagentLiveStatus;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      thinkingLevel?: ThinkingLevel;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found" }
  | { status: "invalid_id"; id: string };

const ORCHESTRATOR_SYSTEM_PROMPT = readFileSync(
  new URL("../ORCHESTRATOR_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();

const WORKFLOW_EAGER_PROMPT = (mode: "preferred" | "always") =>
  `
Automatic durable workflow routing is enabled in ${mode} mode. For an eligible
complex parent request, use the host-owned declarative workflow path in the
same turn: construct a bounded phased plan, validate it, and call
start_durable_workflow. Do not use legacy /workflow as a fallback. Keep pure
questions, social conversation, one-command requests, plan-only requests,
workflow-management commands, child contexts, and active-workflow continuations
on the direct or existing-workflow path. If an eligible request does not result
in a workflow call, routing is unconfirmed and must not be described as
host-enforced.
`.trim();

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENTURA_CHILD === "1") {
    registerChildProtocol(pi);
    if (typeof pi.registerMessageRenderer === "function") {
      pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
    }
    const sessionScope = registerSessionHandlers(pi);
    registerInteractiveSubagentTools(pi, sessionScope);
    registerSubagentArtifactsCleanupTool(pi, sessionScope);
    registerSubagentModelListTool(pi);
    registerInteractiveSupervisor(pi, sessionScope);
    return;
  }
  if (typeof pi.registerMessageRenderer !== "function") {
    throw new Error(
      "pi-subagentura requires Pi >= 0.80.6 with agent_settled and custom message renderer support",
    );
  }
  pi.registerFlag("orchestrator", {
    description: "Append the bundled orchestration system prompt",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("workflow-eager", {
    description: "Route eligible complex requests to durable workflows",
    type: "string",
    default: "off",
  });
  pi.on("before_agent_start", (event) => {
    const additions: string[] = [];
    const continuity = workflowContinuityForPi(pi);
    if (continuity) additions.push(formatWorkflowContinuity(continuity));
    if (pi.getFlag("orchestrator") === true) {
      additions.push(ORCHESTRATOR_SYSTEM_PROMPT);
    }
    const eagerMode = parseWorkflowEagerMode(pi.getFlag("workflow-eager"));
    if (eagerMode !== "off") {
      additions.push(WORKFLOW_EAGER_PROMPT(eagerMode));
    }
    if (additions.length === 0) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}`,
    };
  });
  registerWorkflowRoutingRuntime(pi, {
    getMode: () => pi.getFlag("workflow-eager"),
    childContext: () => process.env.PI_SUBAGENTURA_CHILD === "1",
    hasActiveWorkflow: () => {
      const continuity = (
        globalThis as typeof globalThis & {
          __piSubagenturaWorkflowContinuity?: WorkflowContinuitySnapshot;
        }
      ).__piSubagenturaWorkflowContinuity;
      return Boolean(
        continuity &&
        !["done", "error", "cancelled"].includes(continuity.status),
      );
    },
    managementCommand: (prompt) => /^\/(?:workflow|wf)\b/i.test(prompt.trim()),
    planOnly: (prompt) => /^(?:plan|outline|design)\b/i.test(prompt.trim()),
    notify: (observation) => {
      try {
        pi.sendMessage?.(
          {
            customType: "workflow-routing",
            content: `workflow routing ${observation.status}: ${observation.reason}`,
            display: true,
            details: observation,
          },
          { deliverAs: "followUp", triggerTurn: false },
        );
      } catch {
        /* routing evidence is best-effort and must not interrupt the turn */
      }
    },
  });
  pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
  const sessionScope = registerSessionHandlers(pi);
  registerInteractiveSubagentTools(pi, sessionScope);
  registerInteractiveSupervisor(pi, sessionScope);
  registerWorkflowTool(pi, sessionScope);
  registerInProcessSubagentTools(pi, sessionScope);
  registerInProcessMaintenanceTools(pi, sessionScope);
  // ── Cancel-all-flows shortcut and command ──────────────────────
  registerCancelAllFlows(pi, sessionScope);
}

/**
 * ── Internal helpers (re-exported for test access) ──
 *
 * These are implementation details of the in-process sub-agent machinery.
 * They are re-exported here so that tests and internal consumers (e.g.
 * session-handlers.ts) can import them through the package entry point.
 *
 * API consumers SHOULD NOT depend on these exports directly — they may
 * be renamed, moved, or removed in a minor release.
 */
export {
  formatUsage,
  SubagentResult,
  SubagentLiveStatus,
  ACTIVE_TOOL_DEBOUNCE_MS,
  // ── Async job machinery ──
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
export { getInjectCount, MAX_INJECT } from "./notifications";
/** @internal Interactive-subagent registry, consumed by session-handlers and tests */
export { interactiveSubagentRegistry } from "./interactive-tmux";
/** @internal Inject-count guard; exported for test assertions */
/** @internal Artifact-change poller; exported for test access */
export { pollArtifactChanges } from "./artifact-poller";
/** @internal Interactive-artifact lookup; exported for test access */
export { findArtifactById } from "./tools/interactive";

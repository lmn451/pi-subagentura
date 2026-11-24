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
  debugLog,
  type JobState,
  type JobStatus,
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
import { registerOrchestratorTools } from "./tools/orchestrator";
import {
  FORCE_JEV_FLAG,
  isForceJevEnabled,
  isRoutingEnabled,
} from "./routing-factory";
import { detectEnvironment } from "./environment";
import { registerSessionHandlers } from "./session-handlers";
import {
  acquireRuntimeChildArtifactOwnership,
  CHILD_ARTIFACT_BOOTSTRAP_ENV,
  type ChildArtifactOwnership,
} from "./child-artifact-ownership";
import { registerChildProtocol } from "./child-protocol";
import { registerCancelAllFlows } from "./cancel-all-flows-registration";
import { renderSubagentNotify } from "./rendering";
import { registerInteractiveSupervisor } from "./interactive-supervisor-registration";
import {
  isOrchestratorSplitEnabled,
  registerExtensionSettings,
} from "./settings";
import {
  acquireRuntimeSpawnTreeContext,
  LINEAGE_BOOTSTRAP_ENV,
} from "./spawn-tree-context";
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
const ORCHESTRATOR_V2_SYSTEM_PROMPT = readFileSync(
  new URL("../ORCHESTRATOR_V2_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const ORCHESTRATOR_V2_SPLIT_SYSTEM_PROMPT = readFileSync(
  new URL("../ORCHESTRATOR_V2_SPLIT_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const ORCA_INTERACTIVE_SYSTEM_PROMPT = readFileSync(
  new URL("../ORCA_INTERACTIVE_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const REX_INTERACTIVE_SYSTEM_PROMPT = readFileSync(
  new URL("../REX_INTERACTIVE_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const INTERACTIVE_SUBAGENT_SYSTEM_PROMPT = readFileSync(
  new URL("../INTERACTIVE_SUBAGENT_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();

const ORCHESTRATOR_V2_ROUTING_GUIDANCE = `
## Optional routing advisor

When the user's action, target/scope, deliverable, and required access are clear
and only the choice of current owner is uncertain, use the advisor to help select
among current owners. Call list_orchestrator_agents first, then
resolve_orchestrator_route with the user's original task. The advisor obtains
current authoritative candidates itself; do not pass it transcripts, file
contents, secrets, or unrelated context.

On kind="match", use the returned childId as the id of
send_interactive_subagent_message and send the original task. The recommendation
does not expand the child's responsibility or permissions. If the send fails
because the child is unavailable, surface that state instead of replacing it.

On kind="no_match" with reason="new_child_recommended", creation is permitted
under the existing policy, but the recommendation alone neither mandates nor
authorizes a spawn. If current authoritative registry metadata shows no suitable
owner and the request is clear, create one specialist without asking permission
merely to create it. On low_confidence or ambiguous, abstain: do not route to the
suggested owner or treat the result as proof that no suitable owner exists. If a
plausible-owner choice remains unresolved, ask about that choice, not for spawn
approval.

On kind="error", or when the advisor is unavailable, do not act on an advisor
recommendation. Fall back to the current authoritative registry metadata and the
base routing policy: reuse an exact live authorized owner, or, when none is
suitable and the request is clear, create one specialist without a redundant
approval prompt. Never let an error or recommendation override current registry
authority. On kind="cancelled", stop routing that request; do not send a task or
ask a follow-up about it.

Explicit child identity, explicit new-child instructions, and attach/focus
requests bypass the advisor and follow the existing policy. A clear exact
continuation may still route directly. Unclear action, scope, deliverable, or
access requires clarification; uncertainty only about which current owner fits
is a routing question, not unclear user scope. Aliases alone never authorize
reuse. Treat the advisor as a bounded selection aid; all sending, creation, and
lifecycle control remain with the parent.
`.trim();

const ORCHESTRATOR_V2_FORCE_JEV_GUIDANCE = `
## Required native routing advice

This rule replaces optional advice and prompt-only exact reuse for implicit
native owner decisions. Respect the execution surface precedence above.
Explicit child identity, explicit new-child instructions, and attach/focus
requests bypass the advisor and follow existing policy. Clarify unclear action,
scope, deliverable, or access before routing.

For a clear task with no explicit target, call list_orchestrator_agents first.
For whole-request assessment under --split, follow the split policy first, including with zero children.
Otherwise, if the registry is complete and has no eligible children, use existing policy
without classification. Do not infer absence from stale or incomplete state.
Otherwise, before implicit native reuse or creation, call
resolve_orchestrator_route with the original task, even when exactly one child is eligible.
Do not send transcripts, secrets, or unrelated context to the advisor.

On a match, send the original task to that child only if its confirmed
responsibility, scope, and access cover the request. Do not replace a child on
send failure. On new_child_recommended, create only when existing policy
authorizes it; the advice itself does not grant permission. On low_confidence
or ambiguous, ask a focused owner question instead of guessing or creating.
On any error, including unavailable, report that required classifier advice
could not be obtained; do not fall back to prompt-only routing or another classifier.
On cancellation, stop routing that request.
`.trim();

export default function (pi: ExtensionAPI) {
  const environment = detectEnvironment();
  const inheritedChildMarker = process.env.PI_SUBAGENTURA_CHILD === "1";
  const hasChildArtifactBootstrap = Boolean(
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV],
  );
  let childArtifactOwnership: ChildArtifactOwnership | undefined;
  let childArtifactOwnershipRejected = false;
  try {
    childArtifactOwnership = acquireRuntimeChildArtifactOwnership();
  } catch {
    childArtifactOwnershipRejected = true;
  }
  const isChild = childArtifactOwnership !== undefined;
  if (hasChildArtifactBootstrap && !isChild) {
    debugLog("warn", "child_artifact_ownership_rejected");
    throw new Error(
      "Refusing to start without validated child artifact ownership",
    );
  }
  if (childArtifactOwnershipRejected) {
    debugLog("warn", "child_artifact_ownership_rejected");
  } else if (inheritedChildMarker && !isChild) {
    debugLog("warn", "child_artifact_ownership_missing");
  }
  const childArtifactDir = childArtifactOwnership?.artifactDir;
  if (!childArtifactDir) delete process.env[LINEAGE_BOOTSTRAP_ENV];
  const initialSpawnTreeContext = childArtifactDir
    ? acquireRuntimeSpawnTreeContext(childArtifactDir)
    : undefined;
  const hostPrompts = isChild
    ? []
    : environment.guidanceHost === "orca"
      ? [ORCA_INTERACTIVE_SYSTEM_PROMPT, INTERACTIVE_SUBAGENT_SYSTEM_PROMPT]
      : environment.guidanceHost === "rex"
        ? [REX_INTERACTIVE_SYSTEM_PROMPT, INTERACTIVE_SUBAGENT_SYSTEM_PROMPT]
        : environment.guidanceHost === "agterm"
          ? [INTERACTIVE_SUBAGENT_SYSTEM_PROMPT]
          : [];
  pi.on("before_agent_start", (event, ctx) => {
    const includeOrchestrator = !isChild && pi.getFlag("orchestrator") === true;
    const includeOrchestratorV2 =
      !isChild && pi.getFlag("orchestratorv2") === true;
    let includeSplit = false;
    if (!isChild) {
      try {
        includeSplit = isOrchestratorSplitEnabled(pi);
      } catch (error) {
        // Pi catches before_agent_start errors and otherwise continues with the base prompt.
        ctx.abort();
        throw error;
      }
    }
    if (
      !includeOrchestrator &&
      !includeOrchestratorV2 &&
      hostPrompts.length === 0
    ) {
      return;
    }
    const prompts: string[] = [];
    if (includeOrchestrator) {
      prompts.push(ORCHESTRATOR_SYSTEM_PROMPT);
    }
    if (includeOrchestratorV2) {
      prompts.push(ORCHESTRATOR_V2_SYSTEM_PROMPT);
      if (includeSplit) prompts.push(ORCHESTRATOR_V2_SPLIT_SYSTEM_PROMPT);
      if (isForceJevEnabled(pi)) {
        prompts.push(ORCHESTRATOR_V2_FORCE_JEV_GUIDANCE);
      } else if (isRoutingEnabled(process.env, ctx.modelRegistry)) {
        prompts.push(ORCHESTRATOR_V2_ROUTING_GUIDANCE);
      }
    }
    prompts.push(...hostPrompts);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompts.join("\n\n")}`,
    };
  });
  if (childArtifactOwnership) {
    registerChildProtocol(pi, childArtifactOwnership);
    pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
    const sessionScope = registerSessionHandlers(
      pi,
      initialSpawnTreeContext,
      false,
      undefined,
      environment,
    );
    registerInteractiveSubagentTools(pi, sessionScope, true);
    registerSubagentArtifactsCleanupTool(pi, sessionScope);
    registerSubagentModelListTool(pi);
    registerInteractiveSupervisor(pi, sessionScope);
    return;
  }
  if (typeof pi.registerMessageRenderer !== "function") {
    throw new Error(
      "pi-subagentura requires Pi >= 1.2.0 with agent_settled and custom message renderer support",
    );
  }
  registerExtensionSettings(pi);
  pi.registerFlag("orchestrator", {
    description: "Append the bundled orchestration system prompt",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("orchestratorv2", {
    description: "Append the bundled Orchestratorv2 thin-router prompt",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(FORCE_JEV_FLAG, {
    description:
      "Require configured classifier advice for implicit Orchestratorv2 owner decisions",
    type: "boolean",
    default: false,
  });

  pi.on("input", (_event, ctx) => {
    try {
      isOrchestratorSplitEnabled(pi);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      // Pi catches hook exceptions. A handled input stops the model request.
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
  const sessionScope = registerSessionHandlers(
    pi,
    undefined,
    true,
    undefined,
    environment,
  );
  registerInteractiveSubagentTools(pi, sessionScope);
  registerOrchestratorTools(pi, sessionScope);
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
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
} from "./helpers";
/** @internal Artifact-change poller; exported for test access */
export { pollArtifactChanges } from "./artifact-poller";
/** @internal Interactive-artifact lookup; exported for test access */
export { findArtifactById } from "./tools/interactive";

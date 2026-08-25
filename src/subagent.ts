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
import { registerChildProtocol } from "./child-protocol";
import { registerCancelAllFlows } from "./cancel-all-flows-registration";
import { renderSubagentNotify } from "./rendering";
import { registerInteractiveSupervisor } from "./interactive-supervisor-registration";
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

export default function (pi: ExtensionAPI) {
  const isChild = process.env.PI_SUBAGENTURA_CHILD === "1";
  const childArtifactDir = isChild ? process.env.ARTIFACT_DIR : undefined;
  if (!isChild || !childArtifactDir) {
    delete process.env[LINEAGE_BOOTSTRAP_ENV];
  }
  const initialSpawnTreeContext = childArtifactDir
    ? acquireRuntimeSpawnTreeContext(childArtifactDir)
    : undefined;
  if (isChild) {
    registerChildProtocol(pi);
    if (typeof pi.registerMessageRenderer === "function") {
      pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
    }
    const sessionScope = registerSessionHandlers(
      pi,
      initialSpawnTreeContext,
      false,
    );
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
  pi.on("before_agent_start", (event) => {
    if (pi.getFlag("orchestrator") !== true) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_SYSTEM_PROMPT}`,
    };
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

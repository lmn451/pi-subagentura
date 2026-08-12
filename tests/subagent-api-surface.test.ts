/**
 * API surface lock-down test for pi-subagentura.
 *
 * This file documents the intended public API of the package and guards
 * against accidental additions or removals of exported symbols.
 *
 * **Public (intentionally supported):**
 *   - `default`           — Extension activator function (primary entry)
 *   - `SubagentDetails`   — Discriminated-union type for tool-result details
 *
 * **Testing / internal (re-exported for test access; NOT part of the
 *    supported public API — may change without a minor bump):**
 *   - `rehydrateInteractiveSubagents`
 *   - `formatUsage`
 *   - `SubagentResult`
 *   - `SubagentLiveStatus`
 *   - `ACTIVE_TOOL_DEBOUNCE_MS`
 *   - `jobRegistry`
 *   - `MAX_REGISTRY_SIZE`
 *   - `pruneOldestJob`
 *   - `pruneCompletedJobs`
 *   - `scheduleJobCleanup`
 *   - `startSubagentJob`
 *   - `JobState`          (type-only, erased at runtime)
 *   - `JobStatus`         (type-only, erased at runtime)
 *   - `NotifyOnComplete`  (type-only, erased at runtime)
 *   - `interactiveSubagentRegistry`
 *   - `getInjectCount`
 *   - `MAX_INJECT`
 *   - `pollArtifactChanges`
 *   - `findArtifactById`
 *   - durable workflow runtime/controller/job seams (Milestone 2 test access)
 *
 * If you add a new export to src/subagent.ts you MUST add it to the
 * set below (and document why it's needed there).  Tests that verify new
 * export names without updating this lock will fail intentionally.
 */

import { describe, expect, it } from "vitest";

// ── Compile-time guard for type-only exports ───────────────────────────
//
// TypeScript's `export { type X }` syntax makes X available for explicit
// named import but excludes it from `typeof import(…)`.  The imports below
// will fail to compile if any type-only export is removed or renamed.
// The unused dummy function prevents the "unused type" lint from firing
// without emitting any runtime code.

import type { JobState } from "../src/subagent";
import type { JobStatus } from "../src/subagent";
import type { NotifyOnComplete } from "../src/subagent";
import type { SubagentDetails } from "../src/subagent";
import type {
  RunWorkflowPlanOptions,
  WorkflowAgentDispatcherOptions,
  WorkflowAgentDispatchOptions,
  WorkflowPlanAgentDefinition,
  WorkflowPlanDefinition,
  WorkflowPlanMode,
  WorkflowPlanPhaseDefinition,
  WorkflowPlanRunResult,
  WorkflowPlanTaskDefinition,
  WorkflowPlanTaskResult,
} from "../src/subagent";
import type {
  DurableWorkflowPlanCancellationOptions,
  DurableWorkflowPlanExecution,
  DurableWorkflowPlanOpenResult,
  DurableWorkflowPlanStartOptions,
  DurableWorkflowRunAgentFactory,
  StartDurableWorkflowPlanJobOptions,
} from "../src/subagent";

function _typeExportGuard(
  _a: JobState,
  _b: JobStatus,
  _c: NotifyOnComplete,
  _d: SubagentDetails,
  _plan: WorkflowPlanDefinition,
  _phase: WorkflowPlanPhaseDefinition,
  _task: WorkflowPlanTaskDefinition,
  _agent: WorkflowPlanAgentDefinition,
  _mode: WorkflowPlanMode,
  _dispatcherOptions: WorkflowAgentDispatcherOptions,
  _dispatchOptions: WorkflowAgentDispatchOptions,
  _runOptions: RunWorkflowPlanOptions,
  _runResult: WorkflowPlanRunResult,
  _taskResult: WorkflowPlanTaskResult,
  _durableCancel: DurableWorkflowPlanCancellationOptions,
  _durableExecution: DurableWorkflowPlanExecution,
  _durableOpen: DurableWorkflowPlanOpenResult,
  _durableStart: DurableWorkflowPlanStartOptions,
  _durableFactory: DurableWorkflowRunAgentFactory,
  _durableJob: StartDurableWorkflowPlanJobOptions,
): void {}

// ── Expected export inventory ──────────────────────────────────────────
//
// (a) Runtime-visible named exports (value exports visible via Object.keys)
const RUNTIME_EXPORTS = [
  "ACTIVE_TOOL_DEBOUNCE_MS",
  "MAX_INJECT",
  "MAX_REGISTRY_SIZE",
  "DurableWorkflowPlanController",
  "DurableWorkflowPlanControllerError",
  "WorkflowAgentDispatcher",
  "SubagentLiveStatus",
  "SubagentResult",
  "findArtifactById",
  "createDurableWorkflowPlanRunId",
  "formatUsage",
  "getInjectCount",
  "getDurableWorkflowPlanController",
  "interactiveSubagentRegistry",
  "jobRegistry",
  "pollArtifactChanges",
  "pruneCompletedJobs",
  "pruneOldestJob",
  "rehydrateInteractiveSubagents",
  "scheduleJobCleanup",
  "registerDurableWorkflowRunAgentFactory",
  "runWorkflowPlan",
  "startSubagentJob",
  "startDurableWorkflowPlanJob",
  "startDurableWorkflowSession",
  "validateWorkflowPlan",
  "stopDurableWorkflowSession",
  "validateDurableWorkflowPlan",
] as const;

// (b) Type-only exports (export type …, erased at runtime)
const TYPE_ONLY_EXPORTS = [
  "JobState",
  "JobStatus",
  "NotifyOnComplete",
  "SubagentDetails",
  "WorkflowPlanDefinition",
  "WorkflowPlanPhaseDefinition",
  "WorkflowPlanTaskDefinition",
  "WorkflowPlanAgentDefinition",
  "WorkflowPlanMode",
  "WorkflowAgentDispatcherOptions",
  "WorkflowAgentDispatchOptions",
  "RunWorkflowPlanOptions",
  "WorkflowPlanRunResult",
  "WorkflowPlanTaskResult",
  "DurableWorkflowPlanCancellationOptions",
  "DurableWorkflowPlanExecution",
  "DurableWorkflowPlanOpenResult",
  "DurableWorkflowPlanStartOptions",
  "DurableWorkflowRunAgentFactory",
  "StartDurableWorkflowPlanJobOptions",
] as const;

// ── Tests ──────────────────────────────────────────────────────────────

describe("subagent API surface", () => {
  it("default export is the extension activator function", async () => {
    const mod = await import("../src/subagent");
    expect(typeof mod.default).toBe("function");
  });

  it("runtime-visible named exports are the expected set", async () => {
    const mod = await import("../src/subagent");

    const actualRuntime = Object.keys(mod)
      .filter((k) => k !== "default")
      .sort();

    expect(actualRuntime).toEqual([...RUNTIME_EXPORTS].sort());
  });

  it("type-only exports are not present at runtime (erased by tsc)", async () => {
    const mod = await import("../src/subagent");

    for (const name of TYPE_ONLY_EXPORTS) {
      expect(mod).not.toHaveProperty(name);
    }
  });
});

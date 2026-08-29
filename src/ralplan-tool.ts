import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  approveRalplanRun,
  failRalplanRun,
  getRalplanRunById,
  listRalplanRuns,
  prepareRalplanRecovery,
  rejectRalplanRun,
  type RalplanRunRecord,
} from "./ralplan-state";
import {
  getWorkflowJobForOwner,
  invokeWorkflowCompletionHook,
  normalizeCancelledWorkflowState,
} from "./workflow-jobs";
import { registerToolWithDefaultGuidance } from "./tool-guidance";
import { sessionOwner, type SessionScope } from "./session-scope";

function sessionId(scope: SessionScope): string | undefined {
  try {
    return scope.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function errorResult(message: string, runId?: string) {
  return {
    content: [
      { type: "text" as const, text: `RALPLAN action failed: ${message}` },
    ],
    details: { status: "error", error: message, ...(runId ? { runId } : {}) },
    isError: true,
  };
}

function requireScope(scope: SessionScope): {
  cwd: string;
  owner: ReturnType<typeof sessionOwner>;
  parentSessionId?: string;
} {
  if (scope.lifecycle !== "started" || !scope.cwd) {
    throw new Error("RALPLAN host tools require a live parent session");
  }
  return {
    cwd: scope.cwd,
    owner: sessionOwner(scope),
    parentSessionId: sessionId(scope),
  };
}

function summarize(record: RalplanRunRecord): string {
  return `${record.runId} [${record.phase}] digest=${record.planDigest ?? "unavailable"} workflow=${record.workflowId}`;
}

export function registerRalplanTools(
  pi: ExtensionAPI,
  scope: SessionScope,
): void {
  registerToolWithDefaultGuidance(pi, {
    name: "get_ralplan_status",
    label: "RALPLAN Status",
    description:
      "List host-owned RALPLAN planning state for this parent session. Interrupted evidence from the same parent session is read-only; status never resumes or executes work.",
    parameters: Type.Object({
      runId: Type.Optional(
        Type.String({ description: "Optional exact RALPLAN run id." }),
      ),
    }),
    async execute(_id: string, params: { runId?: string }): Promise<any> {
      try {
        const context = requireScope(scope);
        const records = listRalplanRuns(context.cwd, context).filter(
          (record) => !params.runId || record.runId === params.runId,
        );
        if (params.runId && records.length === 0) {
          return errorResult(
            "run not found in this parent session",
            params.runId,
          );
        }
        return {
          content: [
            {
              type: "text",
              text: records.length
                ? records.map(summarize).join("\n")
                : "No RALPLAN runs are visible in this parent session.",
            },
          ],
          details: { status: "ok", records },
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "approve_ralplan",
    label: "Approve RALPLAN",
    description:
      "Record explicit host approval for exactly {runId, planDigest}. Deactivates pending planning state before returning an approved handoff; does not execute the plan.",
    parameters: Type.Object({
      runId: Type.String({ description: "Pending RALPLAN run id." }),
      planDigest: Type.String({
        description: "Exact verified final-plan digest from RALPLAN status.",
      }),
    }),
    async execute(
      _id: string,
      params: { runId: string; planDigest: string },
    ): Promise<any> {
      try {
        const context = requireScope(scope);
        const record = approveRalplanRun({ ...context, ...params });
        return {
          content: [
            {
              type: "text",
              text:
                `RALPLAN ${record.runId} approved for a separate handoff. ` +
                "No execution was started.",
            },
          ],
          details: {
            status: record.phase,
            runId: record.runId,
            planDigest: record.planDigest,
            executionStarted: false,
          },
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
          params.runId,
        );
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "reject_ralplan",
    label: "Reject RALPLAN",
    description:
      "Reject an exact pending RALPLAN run in this parent session. Rejection is terminal and starts no execution.",
    parameters: Type.Object({
      runId: Type.String({ description: "Pending RALPLAN run id." }),
      reason: Type.String({ description: "Why the plan is rejected." }),
    }),
    async execute(
      _id: string,
      params: { runId: string; reason: string },
    ): Promise<any> {
      try {
        const context = requireScope(scope);
        const record = rejectRalplanRun({ ...context, ...params });
        return {
          content: [
            {
              type: "text",
              text: `RALPLAN ${record.runId} rejected. No execution was started.`,
            },
          ],
          details: {
            status: record.phase,
            runId: record.runId,
            executionStarted: false,
          },
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
          params.runId,
        );
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "cancel_ralplan",
    label: "Cancel RALPLAN",
    description:
      "Cancel an active RALPLAN planning workflow owned by this exact parent session and persist terminal cancellation evidence.",
    parameters: Type.Object({
      runId: Type.String({ description: "Active RALPLAN run id." }),
    }),
    async execute(_id: string, params: { runId: string }): Promise<any> {
      try {
        const context = requireScope(scope);
        const record = getRalplanRunById(context.cwd, params.runId);
        if (!record) throw new Error("RALPLAN run not found");
        if (
          record.owner.id !== context.owner.id ||
          record.owner.generation !== context.owner.generation ||
          record.parentSessionId !== context.parentSessionId
        ) {
          throw new Error("RALPLAN owner or parent session mismatch");
        }
        if (!record.active) throw new Error("RALPLAN run is already terminal");
        const job = getWorkflowJobForOwner(record.workflowId, context.owner);
        if (!job || job.status !== "running") {
          throw new Error("active RALPLAN workflow is not running");
        }
        job.abort.abort();
        job.status = "cancelled";
        normalizeCancelledWorkflowState(job);
        failRalplanRun({
          cwd: context.cwd,
          workflowId: record.workflowId,
          reason: "cancelled by explicit host action",
          phase: "cancelled",
        });
        invokeWorkflowCompletionHook(job);
        return {
          content: [
            { type: "text", text: `RALPLAN ${record.runId} cancelled.` },
          ],
          details: { status: "cancelled", runId: record.runId },
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
          params.runId,
        );
      }
    },
  });

  registerToolWithDefaultGuidance(pi, {
    name: "prepare_ralplan_recovery",
    label: "Prepare RALPLAN Recovery",
    description:
      "Return read-only evidence for an interrupted run from the same parent session. Never auto-resumes agents or execution; a new explicit workflow run is required.",
    parameters: Type.Object({
      runId: Type.String({ description: "Interrupted RALPLAN run id." }),
    }),
    async execute(_id: string, params: { runId: string }): Promise<any> {
      try {
        const context = requireScope(scope);
        const recovery = prepareRalplanRecovery({
          cwd: context.cwd,
          runId: params.runId,
          parentSessionId: context.parentSessionId,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Recovery evidence for ${recovery.runId} is read-only. ` +
                "Start a new RALPLAN workflow explicitly if planning should continue.",
            },
          ],
          details: { status: "recovery_ready", ...recovery },
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
          params.runId,
        );
      }
    },
  });
}

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  OrchestratorWorkspaceGit,
  type OrchestratorRepository,
  type OrchestratorWorktree,
} from "./orchestrator-workspace-git";
import {
  loadOrchestratorWorkspace,
  updateOrchestratorWorkspace,
  withOrchestratorWorkspaceMutationLock,
  writeWorkspaceOwnerMarker,
  readWorkspaceOwnerMarker,
  type ManagedWorkspaceAssignment,
  type ManagedWorkspaceLedger,
} from "./orchestrator-workspace-state";

const SAFE_WORK_ITEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHILD_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{16})$/;

export interface WorkspaceProvisionRequest {
  agentId: string;
  workItemId: string;
  sourceCwd: string;
  parentSessionId?: string;
}
export interface WorkspaceProvisioned {
  repository: OrchestratorRepository;
  assignment: ManagedWorkspaceAssignment;
  worktree: OrchestratorWorktree;
}

export class OrchestratorWorkspaceManagerError extends Error {
  readonly code:
    | "invalid_input"
    | "repository_unavailable"
    | "revision_conflict"
    | "capacity"
    | "provision_failed"
    | "identity_mismatch"
    | "unsafe_state"
    | "already_assigned";
  constructor(
    code: OrchestratorWorkspaceManagerError["code"],
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorWorkspaceManagerError";
    this.code = code;
  }
}

function safeInput(request: WorkspaceProvisionRequest): void {
  if (!CHILD_ID.test(request.agentId))
    throw new OrchestratorWorkspaceManagerError(
      "invalid_input",
      "agent id is invalid",
    );
  if (
    !SAFE_WORK_ITEM.test(request.workItemId) ||
    request.workItemId.includes("..")
  )
    throw new OrchestratorWorkspaceManagerError(
      "invalid_input",
      "workItemId is invalid",
    );
  if (!request.sourceCwd.startsWith("/") || request.sourceCwd.includes("\0"))
    throw new OrchestratorWorkspaceManagerError(
      "invalid_input",
      "source cwd is invalid",
    );
}
function hashIdentity(
  repository: OrchestratorRepository,
  worktree: OrchestratorWorktree,
): string {
  return createHash("sha256")
    .update(
      `pi-subagentura:workspace-identity:v1\0${repository.repoId}\0${worktree.adminKey}\0${worktree.root}\0${worktree.branchRef ?? ""}`,
    )
    .digest("hex");
}
function branchFor(workItemId: string, agentId: string): string {
  // Work-item IDs are intentionally broader than Git ref components.
  return `refs/heads/orchestrator/${workItemId.replaceAll(":", "-")}/${agentId}`;
}
function workspaceRoot(
  repository: OrchestratorRepository,
  agentId: string,
): string {
  const root = join(repository.commonDir, "subagentura", "worktrees");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, agentId);
}
function initialLedger(
  repository: OrchestratorRepository,
): ManagedWorkspaceLedger {
  return {
    schemaVersion: 1,
    revision: 0,
    repository: {
      backend: "git",
      repoId: repository.repoId,
      commonDir: repository.commonDir,
      objectFormat: repository.objectFormat,
    },
    assignments: [],
  };
}
function checkRepository(
  existing: ManagedWorkspaceLedger | undefined,
  repository: OrchestratorRepository,
): void {
  if (
    existing &&
    (existing.repository.repoId !== repository.repoId ||
      existing.repository.commonDir !== repository.commonDir ||
      existing.repository.objectFormat !== repository.objectFormat)
  )
    throw new OrchestratorWorkspaceManagerError(
      "identity_mismatch",
      "workspace repository identity changed",
    );
}

export class OrchestratorWorkspaceManager {
  private readonly git: OrchestratorWorkspaceGit;
  private readonly now: () => number;

  constructor(git = new OrchestratorWorkspaceGit(), now = Date.now) {
    this.git = git;
    this.now = now;
  }

  async reserve(request: WorkspaceProvisionRequest): Promise<{
    repository: OrchestratorRepository;
    assignment: ManagedWorkspaceAssignment;
  }> {
    safeInput(request);
    let repository: OrchestratorRepository;
    try {
      repository = await this.git.probeRepository(request.sourceCwd);
    } catch {
      throw new OrchestratorWorkspaceManagerError(
        "repository_unavailable",
        "source cwd is not a supported Git repository",
      );
    }
    const current = loadOrchestratorWorkspace(repository.commonDir);
    checkRepository(current, repository);
    const existing = current?.assignments.find(
      (item) =>
        item.agentId === request.agentId &&
        item.parentSessionId === request.parentSessionId &&
        item.lifecycle !== "released",
    );
    if (existing) return { repository, assignment: existing };
    if ((current?.assignments.length ?? 0) >= 128)
      throw new OrchestratorWorkspaceManagerError(
        "capacity",
        "workspace assignment capacity reached",
      );
    const revision = current?.revision ?? 0;
    const assignmentId = randomUUID();
    const generation =
      (current?.assignments.filter((item) => item.agentId === request.agentId)
        .length ?? 0) + 1;
    const baseOid = await this.resolveHead(repository);
    const assignment: ManagedWorkspaceAssignment = {
      assignmentId,
      generation,
      agentId: request.agentId,
      workItemId: request.workItemId,
      ...(request.parentSessionId === undefined
        ? {}
        : { parentSessionId: request.parentSessionId }),
      sourceCwd: realpathSync(request.sourceCwd),
      baseOid,
      branchRef: branchFor(request.workItemId, request.agentId),
      worktreeRoot: workspaceRoot(repository, request.agentId),
      workingCwd: workspaceRoot(repository, request.agentId),
      identityHash: createHash("sha256")
        .update(`${repository.repoId}\0${assignmentId}`)
        .digest("hex"),
      lifecycle: "reserved",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    try {
      const next = updateOrchestratorWorkspace(
        repository.commonDir,
        revision,
        (ledger) => {
          checkRepository(ledger, repository);
          if (
            ledger.assignments.some(
              (item) =>
                item.agentId === request.agentId &&
                item.parentSessionId === request.parentSessionId &&
                item.lifecycle !== "released",
            )
          )
            throw new OrchestratorWorkspaceManagerError(
              "already_assigned",
              "agent already has a workspace assignment",
            );
          ledger.assignments.push(assignment);
        },
        initialLedger(repository),
      );
      return {
        repository,
        assignment: next.assignments.find(
          (item) => item.assignmentId === assignmentId,
        )!,
      };
    } catch (error) {
      if (error instanceof OrchestratorWorkspaceManagerError) throw error;
      throw new OrchestratorWorkspaceManagerError(
        "revision_conflict",
        "workspace reservation lost a concurrent update",
      );
    }
  }

  async provision(reserved: {
    repository: OrchestratorRepository;
    assignment: ManagedWorkspaceAssignment;
  }): Promise<WorkspaceProvisioned> {
    const { repository, assignment } = reserved;
    let current = loadOrchestratorWorkspace(repository.commonDir);
    if (!current)
      throw new OrchestratorWorkspaceManagerError(
        "provision_failed",
        "workspace reservation disappeared",
      );
    const found = current.assignments.find(
      (item) => item.assignmentId === assignment.assignmentId,
    );
    if (!found)
      throw new OrchestratorWorkspaceManagerError(
        "provision_failed",
        "workspace reservation is missing",
      );
    if (found.lifecycle === "assigned" || found.lifecycle === "ready") {
      const worktree = await this.verify(repository, found);
      return { repository, assignment: found, worktree };
    }
    current = updateOrchestratorWorkspace(
      repository.commonDir,
      current.revision,
      (ledger) => {
        const item = ledger.assignments.find(
          (candidate) => candidate.assignmentId === assignment.assignmentId,
        );
        if (!item || item.lifecycle !== "reserved")
          throw new OrchestratorWorkspaceManagerError(
            "provision_failed",
            "workspace reservation is not available",
          );
        item.lifecycle = "provisioning";
        item.updatedAt = this.now();
      },
      initialLedger(repository),
    );
    try {
      await withOrchestratorWorkspaceMutationLock(repository.commonDir, () =>
        this.git.addLockedWorktree(
          repository,
          assignment.branchRef,
          assignment.worktreeRoot,
          assignment.baseOid,
        ),
      );
      const worktree = await this.verify(repository, assignment);
      const identityHash = hashIdentity(repository, worktree);
      current = updateOrchestratorWorkspace(
        repository.commonDir,
        current.revision,
        (ledger) => {
          const item = ledger.assignments.find(
            (candidate) => candidate.assignmentId === assignment.assignmentId,
          );
          if (!item)
            throw new OrchestratorWorkspaceManagerError(
              "provision_failed",
              "workspace assignment disappeared",
            );
          item.identityHash = identityHash;
          item.lifecycle = "ready";
          item.updatedAt = this.now();
        },
        initialLedger(repository),
      );
      const ready = current.assignments.find(
        (item) => item.assignmentId === assignment.assignmentId,
      )!;
      return { repository, assignment: ready, worktree };
    } catch (error) {
      const ledger = loadOrchestratorWorkspace(repository.commonDir);
      if (ledger) {
        try {
          updateOrchestratorWorkspace(
            repository.commonDir,
            ledger.revision,
            (next) => {
              const item = next.assignments.find(
                (candidate) =>
                  candidate.assignmentId === assignment.assignmentId,
              );
              if (item) {
                item.lifecycle = "blocked";
                item.closedErrorCode =
                  error instanceof Error ? error.name : "provision_failed";
                item.updatedAt = this.now();
              }
            },
            initialLedger(repository),
          );
        } catch {
          /* Preserve the visible reservation if a concurrent writer won. */
        }
      }
      if (error instanceof OrchestratorWorkspaceManagerError) throw error;
      throw new OrchestratorWorkspaceManagerError(
        "provision_failed",
        "workspace provisioning could not be verified",
      );
    }
  }

  authorize(
    repository: OrchestratorRepository,
    assignmentId: string,
    agentId: string,
    receipt: (assignment: ManagedWorkspaceAssignment) => void,
  ): ManagedWorkspaceAssignment {
    const ledger = loadOrchestratorWorkspace(repository.commonDir);
    if (!ledger)
      throw new OrchestratorWorkspaceManagerError(
        "provision_failed",
        "workspace state is missing",
      );
    const assignment = ledger.assignments.find(
      (item) => item.assignmentId === assignmentId,
    );
    if (
      !assignment ||
      assignment.agentId !== agentId ||
      assignment.lifecycle !== "ready"
    )
      throw new OrchestratorWorkspaceManagerError(
        "unsafe_state",
        "workspace is not ready for authorization",
      );
    receipt(assignment);
    return assignment;
  }

  async finalize(
    repository: OrchestratorRepository,
    assignmentId: string,
    expectedGeneration: number,
  ): Promise<ManagedWorkspaceAssignment> {
    const ledger = loadOrchestratorWorkspace(repository.commonDir);
    if (!ledger)
      throw new OrchestratorWorkspaceManagerError(
        "provision_failed",
        "workspace state is missing",
      );
    const assignment = ledger.assignments.find(
      (item) => item.assignmentId === assignmentId,
    );
    if (!assignment || assignment.generation !== expectedGeneration)
      throw new OrchestratorWorkspaceManagerError(
        "identity_mismatch",
        "workspace assignment generation changed",
      );
    const worktree = await this.verify(repository, assignment);
    const next = updateOrchestratorWorkspace(
      repository.commonDir,
      ledger.revision,
      (current) => {
        const item = current.assignments.find(
          (candidate) => candidate.assignmentId === assignmentId,
        );
        if (!item || item.identityHash !== assignment.identityHash)
          throw new OrchestratorWorkspaceManagerError(
            "identity_mismatch",
            "workspace identity changed before finalize",
          );
        item.lifecycle = "assigned";
        item.updatedAt = this.now();
      },
      initialLedger(repository),
    );
    return next.assignments.find((item) => item.assignmentId === assignmentId)!;
  }

  async reconcile(sourceCwd: string): Promise<ManagedWorkspaceAssignment[]> {
    const repository = await this.git.probeRepository(sourceCwd);
    const ledger = loadOrchestratorWorkspace(repository.commonDir);
    if (!ledger) return [];
    // Reconciliation is deliberately observational in this increment. A
    // missing marker or worktree is exposed by the view; it never takes over,
    // rewrites, or releases a durable assignment.
    return ledger.assignments;
  }

  private async resolveHead(
    repository: OrchestratorRepository,
  ): Promise<string> {
    const worktree = (await this.git.listWorktrees(repository))[0];
    if (!worktree?.headOid)
      throw new OrchestratorWorkspaceManagerError(
        "unsafe_state",
        "source repository has no exact HEAD",
      );
    return worktree.headOid;
  }
  private async verify(
    repository: OrchestratorRepository,
    assignment: ManagedWorkspaceAssignment,
  ): Promise<OrchestratorWorktree> {
    let worktree: OrchestratorWorktree | undefined;
    try {
      worktree = await this.git.observeWorktree(
        repository,
        assignment.worktreeRoot,
      );
    } catch {
      /* classify below */
    }
    if (
      !worktree ||
      worktree.branchRef !== assignment.branchRef ||
      worktree.headOid !== assignment.baseOid ||
      worktree.locked !== true ||
      worktree.prunable ||
      worktree.workingTree !== "clean"
    )
      throw new OrchestratorWorkspaceManagerError(
        "unsafe_state",
        "provisioned worktree did not match the requested identity",
      );
    const marker = readWorkspaceOwnerMarker(worktree.adminDir);
    const expectedIdentityHash = hashIdentity(repository, worktree);
    if (marker) {
      const matches =
        marker.repoId === repository.repoId &&
        marker.assignmentId === assignment.assignmentId &&
        marker.generation === assignment.generation &&
        marker.agentId === assignment.agentId &&
        marker.identityHash === expectedIdentityHash &&
        marker.worktreeRoot === assignment.worktreeRoot &&
        marker.branchRef === assignment.branchRef;
      if (!matches)
        throw new OrchestratorWorkspaceManagerError(
          "identity_mismatch",
          "worktree owner marker belongs to another assignment",
        );
    } else {
      writeWorkspaceOwnerMarker(worktree.adminDir, {
        schemaVersion: 1,
        repoId: repository.repoId,
        assignmentId: assignment.assignmentId,
        generation: assignment.generation,
        agentId: assignment.agentId,
        identityHash: expectedIdentityHash,
        worktreeRoot: assignment.worktreeRoot,
        branchRef: assignment.branchRef,
      });
    }
    return worktree;
  }
}

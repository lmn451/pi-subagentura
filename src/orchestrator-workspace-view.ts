import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadOrchestratorWorkspace,
  readWorkspaceOwnerMarker,
  type ManagedWorkspaceAssignment,
} from "./orchestrator-workspace-state";
import {
  OrchestratorWorkspaceGit,
  type OrchestratorWorktree,
} from "./orchestrator-workspace-git";
import type {
  OrchestratorAgentProjection,
  OrchestratorAgentView,
} from "./orchestrator-routing";
import type { InteractiveSubagentState } from "./interactive-tmux";

export function hasManagedWorkspaceCandidate(cwd: string): boolean {
  try {
    const marker = lstatSync(join(cwd, ".git"));
    if (marker.isDirectory())
      return existsSync(join(cwd, ".git", "subagentura", "workspaces.json"));
    if (!marker.isFile()) return false;
    const match = /^gitdir:\s*(.+?)\s*$/.exec(
      readFileSync(join(cwd, ".git"), "utf8"),
    );
    if (!match) return false;
    const admin = realpathSync(resolve(cwd, match[1]!));
    const common = realpathSync(join(admin, "..", ".."));
    return existsSync(join(common, "subagentura", "workspaces.json"));
  } catch {
    return false;
  }
}

export interface ManagedWorkspaceView {
  assignmentId: string;
  generation: number;
  workItemId: string;
  lifecycle: ManagedWorkspaceAssignment["lifecycle"];
  intended: { branchRef: string; baseOid: string; worktreeRoot: string };
  observed?: {
    branchRef?: string;
    headOid?: string;
    worktreeRoot: string;
    locked: boolean;
    prunable: boolean;
    workingTree: OrchestratorWorktree["workingTree"];
  };
  actionable: boolean;
  reason?:
    | "authority_missing"
    | "worktree_missing"
    | "identity_mismatch"
    | "lifecycle_blocked";
}

function authorityMatches(
  authorityEntries: readonly unknown[] | undefined,
  assignment: ManagedWorkspaceAssignment,
  repoId: string,
): boolean {
  if (!authorityEntries) return false;
  return authorityEntries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as Record<string, unknown>;
    if (
      value.type !== "custom" ||
      value.customType !== "orchestratorv2-workspace-authority"
    )
      return false;
    const data = value.data;
    if (!data || typeof data !== "object") return false;
    const record = data as Record<string, unknown>;
    const nested = record.assignment;
    if (!nested || typeof nested !== "object") return false;
    const candidate = nested as Record<string, unknown>;
    const repository = record.repository;
    const repositoryId =
      repository && typeof repository === "object"
        ? (repository as Record<string, unknown>).repoId
        : undefined;
    return (
      repositoryId === repoId &&
      candidate.assignmentId === assignment.assignmentId &&
      candidate.generation === assignment.generation &&
      candidate.agentId === assignment.agentId &&
      candidate.identityHash === assignment.identityHash
    );
  });
}

function workspaceFor(
  assignment: ManagedWorkspaceAssignment,
  worktree: OrchestratorWorktree | undefined,
  marker: ReturnType<typeof readWorkspaceOwnerMarker>,
  repositoryId: string,
  trusted: boolean,
): ManagedWorkspaceView {
  const identityMatches = Boolean(
    worktree &&
    worktree.root === assignment.worktreeRoot &&
    worktree.branchRef === assignment.branchRef &&
    marker?.assignmentId === assignment.assignmentId &&
    marker.generation === assignment.generation &&
    marker.agentId === assignment.agentId &&
    marker.repoId === repositoryId &&
    marker.identityHash === assignment.identityHash,
  );
  const observed = worktree
    ? {
        branchRef: worktree.branchRef,
        headOid: worktree.headOid,
        worktreeRoot: worktree.root,
        locked: worktree.locked,
        prunable: worktree.prunable,
        workingTree: worktree.workingTree,
      }
    : undefined;
  const actionable =
    trusted &&
    identityMatches &&
    assignment.lifecycle === "assigned" &&
    worktree?.workingTree === "clean" &&
    worktree.locked &&
    !worktree.prunable;
  return {
    assignmentId: assignment.assignmentId,
    generation: assignment.generation,
    workItemId: assignment.workItemId,
    lifecycle: assignment.lifecycle,
    intended: {
      branchRef: assignment.branchRef,
      baseOid: assignment.baseOid,
      worktreeRoot: assignment.worktreeRoot,
    },
    ...(observed ? { observed } : {}),
    actionable,
    ...(trusted
      ? identityMatches
        ? actionable
          ? {}
          : { reason: "lifecycle_blocked" as const }
        : {
            reason: worktree
              ? ("identity_mismatch" as const)
              : ("worktree_missing" as const),
          }
      : { reason: "authority_missing" as const }),
  };
}

export async function loadManagedWorkspaceViews(
  cwd: string,
  interactiveStates: ReadonlyMap<string, InteractiveSubagentState>,
  authorityEntries?: readonly unknown[],
): Promise<Map<string, ManagedWorkspaceView>> {
  if (!hasManagedWorkspaceCandidate(cwd)) return new Map();
  let repository;
  try {
    repository = await new OrchestratorWorkspaceGit().probeRepository(cwd);
  } catch {
    return new Map();
  }
  let ledger;
  try {
    ledger = loadOrchestratorWorkspace(repository.commonDir);
  } catch {
    return new Map();
  }
  if (!ledger || ledger.repository.repoId !== repository.repoId)
    return new Map();
  let worktrees: OrchestratorWorktree[];
  try {
    worktrees = await new OrchestratorWorkspaceGit().listWorktrees(repository);
  } catch {
    worktrees = [];
  }
  const views = new Map<string, ManagedWorkspaceView>();
  for (const assignment of ledger.assignments) {
    if (assignment.lifecycle === "released") continue;
    const worktree = worktrees.find(
      (item) => item.root === assignment.worktreeRoot,
    );
    let marker: ReturnType<typeof readWorkspaceOwnerMarker>;
    try {
      marker = worktree
        ? readWorkspaceOwnerMarker(worktree.adminDir)
        : undefined;
    } catch {
      marker = undefined;
    }
    views.set(
      assignment.agentId,
      workspaceFor(
        assignment,
        worktree,
        marker,
        repository.repoId,
        authorityMatches(authorityEntries, assignment, repository.repoId),
      ),
    );
  }
  return views;
}

export async function attachManagedWorkspaceViews(
  cwd: string,
  projection: OrchestratorAgentProjection,
  interactiveStates: ReadonlyMap<string, InteractiveSubagentState>,
  authorityEntries?: readonly unknown[],
): Promise<OrchestratorAgentProjection> {
  const workspaceViews = await loadManagedWorkspaceViews(
    cwd,
    interactiveStates,
    authorityEntries,
  );
  if (workspaceViews.size === 0) return projection;
  const agents = projection.agents.map((agent) => {
    const workspace = workspaceViews.get(agent.childId);
    return workspace ? { ...agent, workspace } : agent;
  });
  return { ...projection, agents };
}

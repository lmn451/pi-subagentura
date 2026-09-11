import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  getSessionScopes,
  type SessionScope,
  type SessionOwnerToken,
} from "./session-scope";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { loadInteractiveStates, stateFilePath } from "./artifact";
import {
  MAX_WORKSPACE_ASSIGNMENTS,
  MAX_WORKSPACE_INTENTS,
  MAX_WORKSPACE_OUTCOMES,
  MAX_WORKSPACE_PR_ASSOCIATIONS,
  MAX_WORKSPACE_PR_OBSERVATIONS,
  MAX_WORKSPACE_PROPOSAL_RECEIPTS,
  MAX_WORKSPACE_PUBLICATIONS,
  MAX_WORKSPACE_SLOTS,
  MAX_WORKSPACE_WORK_ITEMS,
  createEmptyWorkspaceLedger,
  createRepositoryRecord,
  loadWorkspaceLedger,
  newDurableOwner,
  readWorkspaceLedger,
  updateWorkspaceLedger,
  type AssignmentRecord,
  type DurableOwner,
  type OperationIntent,
  type OperationOutcome,
  type PrAssociation,
  type PrObservation,
  type ProposalReceipt,
  type RepositoryRecord,
  type PublicationRef,
  type RecoveryDecision,
  type SlotRecord,
  type WorkspaceAssignmentState,
  type WorkspaceLedgerV1,
  type WorkspaceOperationClassification,
  type WorkspaceOperationCommand,
  type WorktreeObservation,
} from "./workspace-ledger";
import {
  WorkspaceGitAdapter,
  WorkspaceGitError,
  isFullBranchRef,
  type WorkspaceRepositoryProbe,
  type WorkspaceWorktreeRecord,
} from "./workspace-git";
import {
  readWorkspaceAssignmentMarker,
  readWorkspaceProposals,
  validateWorkspaceProposal,
  readWorkspaceActiveTurnId,
  workspaceProposalHash,
  type WorkspaceAssignmentMarker,
  type WorkspaceProposal,
} from "./workspace-reports";

const PROCESS_INSTANCE_KEY = "__piSubagenturaWorkspaceProcessInstance";
const PROCESS_INSTANCE_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CHILD_ID_PATTERN = /^[a-f0-9]{8}$|^[a-f0-9]{16}$/;
const MAX_WORKSPACE_OPERATION_ID_BYTES = 256;

export type WorkspaceOccupancy =
  "free" | "managed" | "parent" | "foreign" | "unknown";

export interface WorkspaceSlotView {
  slot: SlotRecord;
  worktree?: WorkspaceWorktreeRecord;
  observation: WorktreeObservation;
  occupancy: WorkspaceOccupancy;
  blockers: string[];
  reusable: boolean;
}

export interface WorkspaceDiscovery {
  status: "ok" | "ledger_missing";
  repository: WorkspaceRepositoryProbe;
  ledgerRevision?: number;
  ledger?: WorkspaceLedgerV1;
  slots: WorkspaceSlotView[];
  unmanagedWorktrees: Array<{
    worktree: WorkspaceWorktreeRecord;
    observation: WorktreeObservation;
  }>;
}

export interface WorkspaceManagerOptions {
  git?: WorkspaceGitAdapter;
  scope?: SessionScope;
  sessionCwd?: string;
  parentSessionId?: string;
  owner?: DurableOwner;
  processInstanceId?: string;
  now?: () => number;
  lifecycleGuard?: () => boolean;
  getChild?: (childId: string) => WorkspaceChildRuntime | undefined;
  launchChild?: (
    params: WorkspaceChildLaunchParams,
  ) => WorkspaceChildRuntime | Promise<WorkspaceChildRuntime>;
  closeChild?: (
    child: WorkspaceChildRuntime,
  ) => WorkspaceChildCloseResult | Promise<WorkspaceChildCloseResult>;
}

export interface WorkspaceChildRuntime {
  id: string;
  status: "running" | "idle" | "cancelled" | "exited" | "unknown";
  workingCwd?: string;
  artifactDir: string;
  workspaceSlotId?: string;
  workspaceAssignmentId?: string;
  workspaceAssignmentEpoch?: number;
  workspaceBranchRef?: string;
  workspaceRepoId?: string;
  paneAlive?: boolean;
}

export interface WorkspaceChildLaunchParams {
  preallocatedId: string;
  name: string;
  task: string;
  persona?: string;
  model?: string;
  cwd: string;
  parentCwd?: string;
  parentSessionId?: string;
  sessionScope?: SessionScope;
  workspaceAssignment: WorkspaceAssignmentMarker;
}

export interface WorkspaceChildCloseResult {
  closed: boolean;
  paneAlive: boolean;
}

export interface WorkspaceRegisterSlotRequest {
  slotId: string;
  root?: string;
  adminKey?: string;
  expectedRevision?: number;
  publicationRefs?: PublicationRef[];
}

export interface WorkspaceAssignRequest {
  slotId: string;
  workItemId: string;
  branchRef: string;
  action?: "switch_existing" | "create_branch";
  baseOid?: string;
  expectedRevision: number;
  expectedEpoch: number;
  assignmentId?: string;
  operationId?: string;
  childMode?: "none" | "new" | "existing";
  childId?: string;
  name?: string;
  task?: string;
  persona?: string;
  model?: string;
}

export interface WorkspaceAssignResult {
  repository: RepositoryRecord;
  slot: SlotRecord;
  assignment: AssignmentRecord;
  operation?: OperationOutcome;
  child?: WorkspaceChildRuntime;
}

export interface WorkspaceReleaseRequest {
  slotId: string;
  assignmentId: string;
  expectedRevision: number;
  expectedEpoch: number;
  childId?: string;
  closeChild?: boolean;
}

export interface WorkspaceReleaseResult {
  repository: RepositoryRecord;
  slot: SlotRecord;
  assignment: AssignmentRecord;
  childClosed: boolean;
}

export interface WorkspaceAdoptInput {
  repoId: string;
  slotId: string;
  assignmentId: string;
  expectedRevision: number;
  expectedEpoch: number;
}

export interface WorkspaceRecoverResult {
  repository: RepositoryRecord;
  decision: RecoveryDecision;
}

export interface WorkspacePublicationInput {
  workItemId: string;
  assignmentEpoch: number;
  remote: string;
  ref: string;
  candidateOid: string;
  candidateBranchRef: string;
}

export interface WorkspacePrAssociationInput {
  workItemId: string;
  provider: string;
  externalId: string;
  claimedHeadOid?: string;
  claimedBaseRef?: string;
  provenance?: "parent" | "child_proposal";
}

export interface WorkspacePrObservationInput {
  associationId: string;
  state: "unknown" | "open" | "closed" | "merged";
  draft?: boolean;
  verification:
    "unsupported" | "unverified" | "verified" | "unavailable" | "mismatch";
  headRepo?: string;
  headRef?: string;
  headOid?: string;
  baseRef?: string;
  freshness: "fresh" | "stale" | "unknown";
  source?: "provider" | "manual_parent";
}

export class WorkspaceManagerError extends Error {
  readonly code:
    | "repository_unavailable"
    | "repository_mismatch"
    | "ledger_missing"
    | "ledger_invalid"
    | "revision_conflict"
    | "epoch_conflict"
    | "slot_not_found"
    | "slot_blocked"
    | "slot_occupied"
    | "worktree_not_found"
    | "unsafe_state"
    | "claim_conflict"
    | "assignment_not_found"
    | "assignment_conflict"
    | "branch_conflict"
    | "operation_conflict"
    | "operation_pending"
    | "child_idle"
    | "child_running"
    | "child_unknown"
    | "child_foreign"
    | "child_close_uncertain"
    | "child_launch_failed"
    | "adoption_required"
    | "proposal_invalid"
    | "proposal_stale"
    | "capacity"
    | "confirmation_required"
    | "unknown";

  constructor(code: WorkspaceManagerError["code"], message: string) {
    super(message);
    this.name = "WorkspaceManagerError";
    this.code = code;
  }
}

function fail(code: WorkspaceManagerError["code"], message: string): never {
  throw new WorkspaceManagerError(code, message);
}

function processInstanceId(): string {
  const globalState = globalThis as typeof globalThis & {
    [PROCESS_INSTANCE_KEY]?: string;
  };
  const existing = globalState[PROCESS_INSTANCE_KEY];
  if (existing) return existing;
  const generated = randomUUID();
  globalState[PROCESS_INSTANCE_KEY] = generated;
  return generated;
}

function validChildId(value: string): boolean {
  return CHILD_ID_PATTERN.test(value);
}

function safeOperationId(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_WORKSPACE_OPERATION_ID_BYTES ||
    value.includes("\0") ||
    !PROCESS_INSTANCE_PATTERN.test(value)
  ) {
    fail("operation_conflict", "operation id is invalid");
  }
  return value;
}

function samePath(
  first: string | undefined,
  second: string | undefined,
): boolean {
  if (!first || !second) return false;
  try {
    return realpathSync(first) === realpathSync(second);
  } catch {
    return resolve(first) === resolve(second);
  }
}

function pathWithin(
  parent: string | undefined,
  child: string | undefined,
): boolean {
  if (!parent || !child) return false;
  try {
    const root = realpathSync(parent);
    const candidate = realpathSync(child);
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
  } catch {
    const root = resolve(parent);
    const candidate = resolve(child);
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
  }
}

function sameOwner(first: DurableOwner, second: DurableOwner): boolean {
  return (
    first.processInstanceId === second.processInstanceId &&
    first.nonce === second.nonce &&
    first.parentSessionId === second.parentSessionId
  );
}

function observationFingerprintMatches(
  observed: WorktreeObservation,
  expected: WorktreeObservation,
): boolean {
  return (
    observed.root === expected.root &&
    observed.filesystemIdentity === expected.filesystemIdentity &&
    observed.branchRef === expected.branchRef &&
    observed.headOid === expected.headOid &&
    observed.checkout === expected.checkout &&
    observed.status === expected.status &&
    observed.admin === expected.admin
  );
}

function safeObservation(observation: WorktreeObservation): boolean {
  return (
    observation.status === "clean" &&
    observation.admin === "normal" &&
    observation.checkout === "branch" &&
    observation.branchRef !== undefined &&
    observation.headOid !== undefined &&
    observation.filesystemIdentity !== "unknown"
  );
}

function branchRecord(
  ledger: WorkspaceLedgerV1,
  branchRef: string,
  headOid: string | undefined,
  state: "present" | "missing" | "unknown",
): void {
  const existing = ledger.branches.find(
    (branch) => branch.branchRef === branchRef,
  );
  if (existing) {
    existing.headOid = headOid;
    existing.state = state;
    return;
  }
  if (ledger.branches.length >= MAX_WORKSPACE_WORK_ITEMS)
    fail("capacity", "branch history capacity reached");
  ledger.branches.push({ branchRef, ...(headOid ? { headOid } : {}), state });
}

function workItem(
  ledger: WorkspaceLedgerV1,
  workItemId: string,
  branchRef: string,
): {
  workItemId: string;
  branchRef: string;
  lifecycle: "active" | "parked" | "archived";
  assignmentIds: string[];
} {
  const existing = ledger.workItems.find(
    (item) => item.workItemId === workItemId,
  );
  if (existing) {
    if (existing.branchRef !== branchRef)
      fail("assignment_conflict", "work item is bound to another branch");
    existing.lifecycle = "active";
    return existing;
  }
  if (ledger.workItems.length >= MAX_WORKSPACE_WORK_ITEMS)
    fail("capacity", "work item capacity reached");
  const created = {
    workItemId,
    branchRef,
    lifecycle: "active" as const,
    assignmentIds: [],
  };
  ledger.workItems.push(created);
  return created;
}

function findWorktree(
  discovery: WorkspaceDiscovery,
  slot: SlotRecord,
):
  | { worktree: WorkspaceWorktreeRecord; observation: WorktreeObservation }
  | undefined {
  const view = discovery.slots.find(
    (candidate) => candidate.slot.slotId === slot.slotId,
  );
  if (!view || !view.worktree) return undefined;
  return { worktree: view.worktree, observation: view.observation };
}

function outcomeErrorCode(error: unknown): OperationOutcome["errorCode"] {
  if (!(error instanceof WorkspaceGitError)) return "unknown";
  switch (error.code) {
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "parse_error":
      return "parse_error";
    case "output_limit":
      return "output_limit";
    case "branch_conflict":
      return "branch_conflict";
    default:
      return "unknown";
  }
}

function operationCommand(error: unknown): WorkspaceOperationCommand {
  if (error instanceof WorkspaceGitError && error.code === "timeout")
    return "timeout";
  if (error instanceof WorkspaceGitError && error.code === "cancelled")
    return "cancelled";
  return "error";
}

function blockersFor(
  observation: WorktreeObservation,
  occupancy: WorkspaceOccupancy,
): string[] {
  const blockers: string[] = [];
  if (observation.status !== "clean")
    blockers.push(`status_${observation.status}`);
  if (observation.admin !== "normal")
    blockers.push(`admin_${observation.admin}`);
  if (observation.checkout !== "branch")
    blockers.push(`checkout_${observation.checkout}`);
  if (occupancy !== "free") blockers.push(`occupancy_${occupancy}`);
  if (observation.filesystemIdentity === "unknown")
    blockers.push("filesystem_identity_unknown");
  return blockers;
}

function slotIdentityBlockers(
  slot: SlotRecord,
  worktree: WorkspaceWorktreeRecord | undefined,
  observation: WorktreeObservation,
): string[] {
  const blockers: string[] = [];
  if (!worktree) {
    blockers.push("worktree_missing");
    return blockers;
  }
  if (!samePath(slot.root, worktree.root)) blockers.push("root_changed");
  if (!samePath(slot.gitDir, worktree.gitDir))
    blockers.push("admin_identity_changed");
  if (
    slot.observation?.filesystemIdentity &&
    slot.observation.filesystemIdentity !== "unknown" &&
    slot.observation.filesystemIdentity !== observation.filesystemIdentity
  ) {
    blockers.push("filesystem_identity_changed");
  }
  if (
    slot.observation?.branchRef !== undefined &&
    slot.observation.branchRef !== observation.branchRef
  ) {
    blockers.push("branch_changed");
  }
  if (
    slot.observation?.headOid !== undefined &&
    slot.observation.headOid !== observation.headOid
  ) {
    blockers.push("head_changed");
  }
  return blockers;
}

function defaultOwner(options: WorkspaceManagerOptions): DurableOwner {
  if (options.owner) return options.owner;
  const scope = options.scope;
  let parentSessionId = options.parentSessionId;
  if (!parentSessionId) {
    try {
      parentSessionId = scope?.sessionManager?.getSessionId?.();
    } catch {
      parentSessionId = undefined;
    }
  }
  if (scope) {
    const scoped = ownerByScope.get(scope);
    if (scoped && scoped.parentSessionId === parentSessionId) return scoped;
    const owner = newDurableOwner({
      processInstanceId: options.processInstanceId ?? processInstanceId(),
      parentSessionId,
      pid: process.pid,
    });
    ownerByScope.set(scope, owner);
    return owner;
  }
  return newDurableOwner({
    processInstanceId: options.processInstanceId ?? processInstanceId(),
    parentSessionId,
    pid: process.pid,
  });
}

const ownerByScope = new WeakMap<SessionScope, DurableOwner>();

export function workspaceProcessInstanceId(): string {
  return processInstanceId();
}

export class WorkspaceManager {
  readonly git: WorkspaceGitAdapter;
  readonly owner: DurableOwner;
  readonly scope?: SessionScope;
  readonly sessionCwd?: string;
  private readonly now: () => number;
  private readonly getChildRuntime: (
    childId: string,
  ) => WorkspaceChildRuntime | undefined;
  private readonly launchChildRuntime?: WorkspaceManagerOptions["launchChild"];
  private readonly closeChildRuntime?: WorkspaceManagerOptions["closeChild"];
  private readonly lifecycleGuard?: () => boolean;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.git = options.git ?? new WorkspaceGitAdapter();
    this.scope = options.scope;
    this.sessionCwd = options.sessionCwd;
    this.owner = defaultOwner(options);
    this.now = options.now ?? Date.now;
    this.getChildRuntime =
      options.getChild ?? ((childId) => this.defaultChild(childId));
    this.launchChildRuntime = options.launchChild;
    this.closeChildRuntime = options.closeChild;
    this.lifecycleGuard = options.lifecycleGuard;
  }

  private defaultChild(childId: string): WorkspaceChildRuntime | undefined {
    const state =
      this.scope?.interactiveStates.get(childId) ??
      interactiveSubagentRegistry.get(childId);
    return state ? childRuntimeFromState(state) : undefined;
  }

  private repository(workingCwd: string): Promise<WorkspaceRepositoryProbe> {
    return this.git.probeRepository(workingCwd).catch((error: unknown) => {
      if (error instanceof WorkspaceManagerError) throw error;
      throw new WorkspaceManagerError(
        "repository_unavailable",
        "Git repository identity could not be established",
      );
    });
  }

  private ledgerFor(repository: WorkspaceRepositoryProbe): WorkspaceLedgerV1 {
    let ledger: WorkspaceLedgerV1 | undefined;
    try {
      ledger = loadWorkspaceLedger(repository.commonDir);
    } catch (error) {
      throw new WorkspaceManagerError(
        "ledger_invalid",
        error instanceof Error ? error.message : "workspace ledger is invalid",
      );
    }
    if (!ledger) fail("ledger_missing", "workspace ledger is not registered");
    verifyRepository(ledger.repository, repository);
    return ledger;
  }

  async discover(workingCwd: string): Promise<WorkspaceDiscovery> {
    const repository = await this.repository(workingCwd);
    const read = readWorkspaceLedger(repository.commonDir);
    if (read.kind === "invalid")
      fail("ledger_invalid", `workspace ledger cannot be read: ${read.reason}`);
    const worktrees = await this.git.listWorktrees(repository);
    const observations = new Map<
      string,
      { worktree: WorkspaceWorktreeRecord; observation: WorktreeObservation }
    >();
    for (const worktree of worktrees) {
      const observation = await this.git.observeWorktree(repository, worktree);
      observations.set(worktree.adminKey, { worktree, observation });
    }
    if (read.kind === "missing") {
      return {
        status: "ledger_missing",
        repository,
        slots: [],
        unmanagedWorktrees: [...observations.values()],
      };
    }
    verifyRepository(read.ledger.repository, repository);
    const slots = read.ledger.slots.map((slot) => {
      const found = observations.get(slot.adminKey);
      const observation =
        found?.observation ?? unknownObservationFor(slot.root);
      const occupancy = this.scanOccupancy(slot, read.ledger, observation);
      const blockers = [
        ...blockersFor(observation, occupancy),
        ...slotIdentityBlockers(slot, found?.worktree, observation),
      ];
      return {
        slot,
        ...(found ? { worktree: found.worktree } : {}),
        observation,
        occupancy,
        blockers,
        reusable: blockers.length === 0 && slot.state === "available",
      };
    });
    const registeredKeys = new Set(
      read.ledger.slots.map((slot) => slot.adminKey),
    );
    return {
      status: "ok",
      repository,
      ledgerRevision: read.ledger.ledgerRevision,
      ledger: read.ledger,
      slots,
      unmanagedWorktrees: [...observations.entries()]
        .filter(([adminKey]) => !registeredKeys.has(adminKey))
        .map(([, value]) => value),
    };
  }

  async reconcile(workingCwd: string): Promise<WorkspaceDiscovery> {
    const discovery = await this.discover(workingCwd);
    if (discovery.status === "ledger_missing") return discovery;
    if (this.lifecycleGuard && !this.lifecycleGuard()) return discovery;
    const repository = discovery.repository;
    const expectedRevision = discovery.ledgerRevision!;
    updateWorkspaceLedger(repository.commonDir, expectedRevision, (ledger) => {
      verifyRepository(ledger.repository, repository);
      for (const view of discovery.slots) {
        const slot = ledger.slots.find(
          (candidate) => candidate.slotId === view.slot.slotId,
        );
        if (!slot) continue;
        slot.observation = view.observation;
        slot.revision++;
        if (
          slot.state === "transitioning" ||
          slot.state === "adoption_required"
        )
          continue;
        if (view.occupancy === "foreign" && slot.activeAssignmentId)
          slot.state = "adoption_required";
        else if (view.blockers.length > 0) slot.state = "blocked";
        else if (!slot.activeAssignmentId) slot.state = "available";
        else if (slot.state === "reserved" || slot.state === "assigned")
          slot.state = slot.state;
      }
    });
    if (this.lifecycleGuard && !this.lifecycleGuard()) return discovery;
    return this.discover(workingCwd);
  }

  async registerSlot(
    request: WorkspaceRegisterSlotRequest,
    workingCwd: string,
  ): Promise<WorkspaceSlotView> {
    const repository = await this.repository(workingCwd);
    const discovery = await this.discover(workingCwd);
    const target = selectWorktree(
      discovery.unmanagedWorktrees.concat(
        discovery.slots
          .filter((view) => view.worktree)
          .map((view) => ({
            worktree: view.worktree!,
            observation: view.observation,
          })),
      ),
      request,
      repository,
    );
    if (!target)
      fail(
        "worktree_not_found",
        "requested worktree is not present in the fresh Git inventory",
      );
    if (!safeObservation(target.observation))
      fail(
        "unsafe_state",
        "only a clean, normal branch worktree can be registered",
      );
    const targetSlot = slotForWorktree(target.worktree);
    if (targetSlot.slotId !== request.slotId)
      fail(
        "assignment_conflict",
        "slot id does not match the administrative worktree identity",
      );
    const occupancy = this.scanOccupancy(
      targetSlot,
      undefined,
      target.observation,
    );
    if (occupancy !== "free")
      fail("slot_occupied", `worktree is occupied by ${occupancy}`);
    const current = readWorkspaceLedger(repository.commonDir);
    if (current.kind === "invalid")
      fail(
        "ledger_invalid",
        `workspace ledger cannot be read: ${current.reason}`,
      );
    if (
      current.kind === "valid" &&
      current.ledger.claims.some((claim) => claim.state === "held")
    ) {
      fail("slot_occupied", "a durable workspace claim is already held");
    }
    const expectedRevision =
      request.expectedRevision ??
      (current.kind === "missing" ? 0 : current.ledger.ledgerRevision);
    const initial = createEmptyWorkspaceLedger(
      createRepositoryRecord({
        commonDir: repository.commonDir,
        gitDir: repository.gitDir,
        objectFormat: repository.objectFormat,
        publicationRefs: request.publicationRefs,
      }),
    );
    const next = updateWorkspaceLedger(
      repository.commonDir,
      expectedRevision,
      (ledger) => {
        verifyRepository(ledger.repository, repository);
        const existing = ledger.slots.find(
          (slot) => slot.slotId === targetSlot.slotId,
        );
        if (existing) {
          if (!sameSlotIdentity(existing, targetSlot))
            fail(
              "assignment_conflict",
              "slot identity does not match the existing record",
            );
          if (existing.activeAssignmentId)
            fail(
              "assignment_conflict",
              "an active assignment cannot be replaced by registration",
            );
          existing.observation = target.observation;
          existing.state = "available";
          existing.revision++;
          return;
        }
        if (ledger.slots.length >= MAX_WORKSPACE_SLOTS)
          fail("capacity", "workspace slot capacity reached");
        targetSlot.observation = target.observation;
        ledger.slots.push(targetSlot);
        if (target.observation.branchRef)
          branchRecord(
            ledger,
            target.observation.branchRef,
            target.observation.headOid,
            "present",
          );
      },
      initial,
    );
    const slot = next.slots.find(
      (candidate) => candidate.slotId === targetSlot.slotId,
    )!;
    return {
      slot,
      observation: target.observation,
      occupancy: "free",
      blockers: [],
      reusable: true,
    };
  }

  async assign(
    request: WorkspaceAssignRequest,
    workingCwd: string,
  ): Promise<WorkspaceAssignResult> {
    const repository = await this.repository(workingCwd);
    let ledger = this.ledgerFor(repository);
    const normalizedBaseOid = request.baseOid?.toLowerCase();
    if (request.childMode === "existing" && request.assignmentId) {
      const existingAssignment = ledger.assignments.find(
        (candidate) => candidate.assignmentId === request.assignmentId,
      );
      if (existingAssignment?.state === "reserved") {
        return this.bindExistingAssignment(
          repository,
          ledger,
          existingAssignment,
          request,
          workingCwd,
        );
      }
    }
    if (request.operationId) {
      const operationId = safeOperationId(request.operationId);
      const previousIntent = ledger.operations.find(
        (candidate) => candidate.operationId === operationId,
      );
      if (previousIntent) {
        const requestedAction = request.action ?? "switch_existing";
        if (
          previousIntent.requestedBranchRef !== request.branchRef ||
          previousIntent.action !== requestedAction ||
          previousIntent.requestedBaseOid !== normalizedBaseOid
        )
          fail(
            "operation_conflict",
            "operation id was reused with a different request",
          );
        const previousAssignment = ledger.assignments.find(
          (candidate) => candidate.assignmentId === previousIntent.assignmentId,
        );
        const previousSlot = previousAssignment
          ? ledger.slots.find(
              (candidate) => candidate.slotId === previousAssignment.slotId,
            )
          : undefined;
        if (!previousAssignment || !previousSlot)
          fail(
            "operation_conflict",
            "recorded operation references missing state",
          );
        const previousOutcome = ledger.outcomes.find(
          (candidate) => candidate.operationId === operationId,
        );
        if (!previousOutcome)
          fail("operation_pending", "recorded operation has no outcome yet");
        if (
          previousAssignment.slotId !== request.slotId ||
          previousAssignment.workItemId !== request.workItemId ||
          previousIntent.fromEpoch !== request.expectedEpoch ||
          (request.assignmentId &&
            request.assignmentId !== previousAssignment.assignmentId)
        )
          fail(
            "operation_conflict",
            "operation id was reused for a different assignment",
          );
        return {
          repository,
          slot: previousSlot,
          assignment: previousAssignment,
          operation: previousOutcome,
        };
      }
    }
    checkRevision(ledger, request.expectedRevision);
    const slot = findSlot(ledger, request.slotId);
    checkEpoch(slot, request.expectedEpoch);
    const discovery = await this.discover(workingCwd);
    const fresh = findWorktree(discovery, slot);
    if (!fresh)
      fail("worktree_not_found", "managed slot is missing from Git inventory");
    const freshView = discovery.slots.find(
      (view) => view.slot.slotId === slot.slotId,
    );
    if (!freshView || freshView.blockers.length > 0)
      fail("unsafe_state", "managed slot identity or occupancy is not safe");
    const occupancy = this.scanOccupancy(slot, ledger, fresh.observation);
    if (occupancy !== "free")
      fail("slot_occupied", `managed slot is occupied by ${occupancy}`);
    if (!safeObservation(fresh.observation))
      fail("unsafe_state", "slot is not clean and reusable");
    if (slot.state !== "available")
      fail("slot_blocked", `slot is ${slot.state}`);
    if (!isFullBranchRef(request.branchRef))
      fail(
        "assignment_conflict",
        "assignment branch must be a full refs/heads ref",
      );
    const action = request.action ?? "switch_existing";
    const childMode = request.childMode ?? "none";
    if (childMode === "new" && !this.launchChildRuntime)
      fail("child_launch_failed", "workspace child launcher is unavailable");
    if (childMode === "existing" && !request.assignmentId)
      fail(
        "child_foreign",
        "existing child binding requires a managed assignment id",
      );
    if (request.childMode === "existing" && !request.childId)
      fail("child_foreign", "existing child binding requires childId");
    if (
      childMode === "existing" &&
      !ledger.assignments.some(
        (assignment) =>
          assignment.assignmentId === request.assignmentId &&
          assignment.state === "reserved",
      )
    )
      fail(
        "assignment_conflict",
        "existing child binding requires a reserved managed assignment",
      );
    if (action === "switch_existing" && request.baseOid !== undefined)
      fail(
        "assignment_conflict",
        "baseOid is only valid when creating a branch",
      );
    const assignmentId = request.assignmentId ?? randomUUID();
    const operationId = request.operationId
      ? safeOperationId(request.operationId)
      : randomUUID();
    const assignmentEpoch = slot.assignmentEpoch + 1;
    const work = request.workItemId;
    const targetBranchOid = normalizedBaseOid;
    const before = fresh.observation;
    let requestedHeadOid = before.headOid;
    if (action === "create_branch") {
      if (
        !targetBranchOid ||
        !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(targetBranchOid)
      )
        fail(
          "assignment_conflict",
          "new branch assignment requires a full base OID",
        );
      const otherWorktrees = [
        ...discovery.slots.map((view) => view.observation),
        ...discovery.unmanagedWorktrees.map((view) => view.observation),
      ];
      if (
        otherWorktrees.some(
          (observation) => observation.branchRef === request.branchRef,
        )
      )
        fail(
          "branch_conflict",
          "requested branch is checked out in another worktree",
        );
      requestedHeadOid = await this.git.verifyObjectOid(
        targetBranchOid,
        repository,
      );
      const existingBranch = await this.git.resolveBranchOid(
        request.branchRef,
        repository,
      );
      if (existingBranch)
        fail("branch_conflict", "requested new branch already exists");
    } else if (request.branchRef !== before.branchRef) {
      const otherWorktrees = [
        ...discovery.slots.map((view) => view.observation),
        ...discovery.unmanagedWorktrees.map((view) => view.observation),
      ];
      if (
        otherWorktrees.some(
          (observation) => observation.branchRef === request.branchRef,
        )
      )
        fail(
          "branch_conflict",
          "requested branch is checked out in another worktree",
        );
      requestedHeadOid = await this.git.resolveBranchOid(
        request.branchRef,
        repository,
      );
      if (!requestedHeadOid)
        fail("branch_conflict", "requested existing branch does not exist");
    }
    const repositoryClaimId = `${assignmentId}:repository`;
    const slotClaimId = assignmentId;
    const intendedAfter = {
      ...before,
      branchRef: request.branchRef,
      ...(requestedHeadOid ? { headOid: requestedHeadOid } : {}),
      checkout: "branch" as const,
      status: "clean" as const,
      admin: "normal" as const,
    };
    const needsMutation =
      request.branchRef !== before.branchRef || action === "create_branch";
    if (ledger.assignments.length >= MAX_WORKSPACE_ASSIGNMENTS)
      fail("capacity", "assignment capacity reached");
    if (ledger.claims.length + 2 > MAX_WORKSPACE_ASSIGNMENTS)
      fail("capacity", "workspace claim capacity reached");
    if (
      !ledger.workItems.some((item) => item.workItemId === work) &&
      ledger.workItems.length >= MAX_WORKSPACE_WORK_ITEMS
    )
      fail("capacity", "work item capacity reached");
    if (
      !ledger.branches.some(
        (branch) => branch.branchRef === request.branchRef,
      ) &&
      ledger.branches.length >= MAX_WORKSPACE_WORK_ITEMS
    )
      fail("capacity", "branch history capacity reached");
    if (needsMutation && ledger.operations.length >= MAX_WORKSPACE_INTENTS)
      fail("capacity", "operation intent capacity reached");
    if (needsMutation && ledger.outcomes.length >= MAX_WORKSPACE_OUTCOMES)
      fail("capacity", "operation outcome capacity reached");
    ledger = updateWorkspaceLedger(
      repository.commonDir,
      request.expectedRevision,
      (next) => {
        const currentSlot = findSlot(next, request.slotId);
        if (
          currentSlot.assignmentEpoch !== request.expectedEpoch ||
          currentSlot.state !== "available"
        )
          fail("epoch_conflict", "slot changed before reservation");
        ensureClaimAvailable(
          next,
          repositoryClaimId,
          "repository",
          undefined,
          this.owner,
        );
        ensureClaimAvailable(
          next,
          slotClaimId,
          "slot",
          request.slotId,
          this.owner,
        );
        const item = workItem(next, work, request.branchRef);
        if (next.assignments.length >= MAX_WORKSPACE_ASSIGNMENTS)
          fail("capacity", "assignment capacity reached");
        const assignment: AssignmentRecord = {
          assignmentId,
          slotId: request.slotId,
          workItemId: work,
          branchRef: request.branchRef,
          epoch: assignmentEpoch,
          expectedRoot: before.root,
          ...(before.headOid ? { expectedHeadOid: before.headOid } : {}),
          owner: this.owner,
          state: "reserved",
        };
        next.claims.push({
          claimId: repositoryClaimId,
          scope: "repository",
          owner: this.owner,
          state: "held",
          claimEpoch: assignmentEpoch,
          acquiredAt: this.now(),
        });
        next.claims.push({
          claimId: slotClaimId,
          scope: "slot",
          slotId: request.slotId,
          owner: this.owner,
          state: "held",
          claimEpoch: assignmentEpoch,
          acquiredAt: this.now(),
        });
        next.assignments.push(assignment);
        item.assignmentIds.push(assignmentId);
        currentSlot.assignmentEpoch = assignmentEpoch;
        currentSlot.activeAssignmentId = assignmentId;
        currentSlot.state = needsMutation ? "transitioning" : "reserved";
        currentSlot.revision++;
        branchRecord(next, request.branchRef, requestedHeadOid, "present");
        if (needsMutation) {
          if (next.operations.length >= MAX_WORKSPACE_INTENTS)
            fail("capacity", "operation intent capacity reached");
          next.operations.push({
            operationId,
            action,
            claimId: slotClaimId,
            assignmentId,
            fromEpoch: request.expectedEpoch,
            toEpoch: assignmentEpoch,
            expectedRevision: request.expectedRevision + 1,
            requestedBranchRef: request.branchRef,
            ...(targetBranchOid ? { requestedBaseOid: targetBranchOid } : {}),
            before,
            intendedAfter,
            phase: "prepared",
          });
        }
      },
    );
    let operation: OperationOutcome | undefined;
    if (needsMutation) {
      const intent = ledger.operations.find(
        (candidate) => candidate.operationId === operationId,
      )!;
      operation = await this.executeIntent(
        repository,
        slot,
        intent,
        fresh.worktree,
      );
      ledger = this.ledgerFor(repository);
      if (operation.classification !== "after") {
        throw new WorkspaceManagerError(
          "operation_pending",
          `workspace operation is ${operation.classification}`,
        );
      }
    }
    let child: WorkspaceChildRuntime | undefined;
    if (childMode !== "none") {
      const latest = this.ledgerFor(repository);
      const assignment = latest.assignments.find(
        (candidate) => candidate.assignmentId === assignmentId,
      )!;
      child = await this.bindChild(
        repository,
        latest,
        assignment,
        request,
        childMode,
      );
      ledger = this.ledgerFor(repository);
    } else {
      ledger = releaseClaims(
        repository.commonDir,
        ledger,
        [repositoryClaimId, slotClaimId],
        this.owner,
      );
    }
    const assignment = ledger.assignments.find(
      (candidate) => candidate.assignmentId === assignmentId,
    )!;
    const assignedSlot = ledger.slots.find(
      (candidate) => candidate.slotId === request.slotId,
    )!;
    return {
      repository,
      slot: assignedSlot,
      assignment,
      ...(operation ? { operation } : {}),
      ...(child ? { child } : {}),
    };
  }

  private async bindExistingAssignment(
    repository: WorkspaceRepositoryProbe,
    ledger: WorkspaceLedgerV1,
    assignment: AssignmentRecord,
    request: WorkspaceAssignRequest,
    workingCwd: string,
  ): Promise<WorkspaceAssignResult> {
    checkRevision(ledger, request.expectedRevision);
    const slot = findSlot(ledger, assignment.slotId);
    checkEpoch(slot, request.expectedEpoch);
    if (
      assignment.workItemId !== request.workItemId ||
      assignment.branchRef !== request.branchRef
    ) {
      fail("assignment_conflict", "existing assignment payload does not match");
    }
    if (!sameOwner(assignment.owner, this.owner))
      fail("adoption_required", "existing assignment belongs to another owner");
    if (!request.childId)
      fail("child_foreign", "existing child binding requires childId");
    const discovery = await this.discover(workingCwd);
    const fresh = findWorktree(discovery, slot);
    if (!fresh || !safeObservation(fresh.observation))
      fail("unsafe_state", "existing assignment evidence is not safe");
    if (fresh.observation.branchRef !== assignment.branchRef)
      fail("unsafe_state", "existing assignment branch changed");
    const occupancy = this.scanOccupancy(slot, ledger, fresh.observation, {
      allowHeldClaims: true,
    });
    if (
      occupancy === "foreign" ||
      occupancy === "unknown" ||
      occupancy === "parent"
    )
      fail("child_foreign", `existing assignment occupancy is ${occupancy}`);
    await this.bindChild(repository, ledger, assignment, request, "existing");
    const updated = this.ledgerFor(repository);
    return {
      repository,
      slot: updated.slots.find(
        (candidate) => candidate.slotId === assignment.slotId,
      )!,
      assignment: updated.assignments.find(
        (candidate) => candidate.assignmentId === assignment.assignmentId,
      )!,
    };
  }

  private async executeIntent(
    repository: WorkspaceRepositoryProbe,
    slot: SlotRecord,
    intent: OperationIntent,
    worktree: WorkspaceWorktreeRecord,
  ): Promise<OperationOutcome> {
    let command: WorkspaceOperationCommand = "not_started";
    let failure: unknown;
    try {
      if (intent.action === "create_branch") {
        await this.git.createBranch(
          intent.requestedBranchRef,
          intent.requestedBaseOid!,
          repository,
          undefined,
          worktree.root,
        );
      } else {
        await this.git.switchExistingBranch(
          intent.requestedBranchRef,
          worktree.root,
        );
      }
      command = "success";
    } catch (error) {
      failure = error;
      command = operationCommand(error);
    }
    let observed: WorktreeObservation;
    let probeFailure: unknown;
    try {
      const worktrees = await this.git.listWorktrees(repository);
      const current = worktrees.find(
        (candidate) =>
          samePath(candidate.root, worktree.root) &&
          candidate.adminKey === worktree.adminKey,
      );
      if (!current)
        throw new WorkspaceGitError(
          "parse_error",
          "managed worktree disappeared after mutation",
        );
      observed = await this.git.observeWorktree(repository, current);
    } catch (error) {
      probeFailure = error;
      observed = unknownObservationFor(slot.root);
    }
    const classification = classifyOperation(
      intent,
      observed,
      failure ?? probeFailure,
    );
    const outcome: OperationOutcome = {
      operationId: intent.operationId,
      classification,
      command,
      observed,
      ...(failure ? { errorCode: outcomeErrorCode(failure) } : {}),
      ...(!failure && probeFailure
        ? { errorCode: outcomeErrorCode(probeFailure) }
        : {}),
    };
    persistOperationOutcome(repository.commonDir, intent, outcome, this.owner);
    if (classification === "after") return outcome;
    if (classification === "before") {
      throw new WorkspaceManagerError(
        "operation_pending",
        "Git mutation did not reach the requested after-state",
      );
    }
    throw new WorkspaceManagerError(
      "unsafe_state",
      `Git mutation recovery classified the slot as ${classification}`,
    );
  }

  private async bindChild(
    repository: WorkspaceRepositoryProbe,
    ledger: WorkspaceLedgerV1,
    assignment: AssignmentRecord,
    request: WorkspaceAssignRequest,
    mode: "new" | "existing",
  ): Promise<WorkspaceChildRuntime> {
    let child: WorkspaceChildRuntime | undefined;
    if (mode === "existing") {
      if (!request.childId)
        fail("child_foreign", "existing child binding requires childId");
      child = this.getChildRuntime(request.childId);
      if (
        !child ||
        child.status === "cancelled" ||
        child.status === "exited" ||
        child.paneAlive === false
      )
        fail("child_foreign", "existing child is not available");
      if (child.status === "running")
        fail("child_running", "running child cannot be rebound");
      if (child.status === "unknown")
        fail("child_unknown", "child liveness is unknown");
      verifyChildBinding(child, repository, assignment);
    } else {
      if (!this.launchChildRuntime)
        fail("child_launch_failed", "workspace child launcher is unavailable");
      const childId = randomBytes(8).toString("hex");
      const marker: WorkspaceAssignmentMarker = {
        schemaVersion: 1,
        repoId: repository.repoId,
        slotId: assignment.slotId,
        assignmentId: assignment.assignmentId,
        assignmentEpoch: assignment.epoch,
        childId,
        root: assignment.expectedRoot,
        branchRef: assignment.branchRef,
      };
      try {
        child = await this.launchChildRuntime({
          preallocatedId: childId,
          name: request.name ?? `Workspace: ${request.workItemId}`,
          task: request.task ?? `Work on ${request.branchRef}`,
          persona: request.persona,
          model: request.model,
          cwd: assignment.expectedRoot,
          parentCwd: this.sessionCwd,
          parentSessionId: this.owner.parentSessionId,
          sessionScope: this.scope,
          workspaceAssignment: marker,
        });
      } catch (error) {
        markAssignmentLaunchFailure(
          repository.commonDir,
          ledger,
          assignment.assignmentId,
          this.owner,
        );
        throw new WorkspaceManagerError(
          "child_launch_failed",
          error instanceof Error
            ? error.message
            : "workspace child launch failed",
        );
      }
      try {
        verifyChildBinding(child, repository, assignment, childId);
        const markerOnDisk = readWorkspaceAssignmentMarker(child.artifactDir);
        if (
          !markerOnDisk ||
          markerOnDisk.childId !== childId ||
          markerOnDisk.assignmentId !== assignment.assignmentId ||
          markerOnDisk.assignmentEpoch !== assignment.epoch
        ) {
          throw new WorkspaceManagerError(
            "child_foreign",
            "workspace assignment marker does not match the reserved child",
          );
        }
      } catch (error) {
        markAssignmentLaunchFailure(
          repository.commonDir,
          ledger,
          assignment.assignmentId,
          this.owner,
        );
        if (error instanceof WorkspaceManagerError) throw error;
        throw new WorkspaceManagerError(
          "child_foreign",
          "workspace child identity could not be verified",
        );
      }
    }
    const updated = updateWorkspaceLedger(
      repository.commonDir,
      ledger.ledgerRevision,
      (next) => {
        const currentAssignment = next.assignments.find(
          (candidate) => candidate.assignmentId === assignment.assignmentId,
        );
        const slot = next.slots.find(
          (candidate) => candidate.slotId === assignment.slotId,
        );
        if (
          !currentAssignment ||
          !slot ||
          currentAssignment.state !== "reserved" ||
          slot.activeAssignmentId !== assignment.assignmentId
        )
          fail(
            "assignment_conflict",
            "assignment changed before child binding",
          );
        currentAssignment.childId = child!.id;
        currentAssignment.state = "bound";
        slot.state = "assigned";
        slot.revision++;
        for (const claim of next.claims) {
          if (
            (claim.claimId === `${assignment.assignmentId}:repository` ||
              claim.claimId === assignment.assignmentId) &&
            sameOwner(claim.owner, this.owner)
          )
            claim.state = "released";
        }
      },
    );
    const bound = updated.assignments.find(
      (candidate) => candidate.assignmentId === assignment.assignmentId,
    )!;
    if (!bound.childId)
      fail("assignment_conflict", "child binding was not persisted");
    return child!;
  }

  async release(
    request: WorkspaceReleaseRequest,
    workingCwd: string,
  ): Promise<WorkspaceReleaseResult> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    checkRevision(ledger, request.expectedRevision);
    const slot = findSlot(ledger, request.slotId);
    checkEpoch(slot, request.expectedEpoch);
    const assignment = ledger.assignments.find(
      (candidate) => candidate.assignmentId === request.assignmentId,
    );
    if (
      !assignment ||
      assignment.slotId !== slot.slotId ||
      assignment.epoch !== request.expectedEpoch
    )
      fail(
        "assignment_not_found",
        "assignment does not match the requested slot and epoch",
      );
    if (request.childId !== undefined && request.childId !== assignment.childId)
      fail("child_foreign", "child id does not match the managed assignment");
    if (assignment.state !== "bound" && assignment.state !== "reserved")
      fail("assignment_conflict", "assignment is not releasable");
    if (!sameOwner(assignment.owner, this.owner))
      fail("adoption_required", "assignment belongs to another durable owner");
    const discovery = await this.discover(workingCwd);
    const fresh = findWorktree(discovery, slot);
    if (!fresh)
      fail("worktree_not_found", "managed slot is missing from Git inventory");
    if (fresh.observation.branchRef !== assignment.branchRef)
      fail("unsafe_state", "slot branch no longer matches the assignment");
    if (
      slotIdentityBlockers(slot, fresh.worktree, fresh.observation).length > 0
    )
      fail("unsafe_state", "slot identity changed since assignment");
    const occupancy = this.scanOccupancy(slot, ledger, fresh.observation);
    if (!safeObservation(fresh.observation))
      fail("unsafe_state", "slot is not clean, normal, and branch-attached");
    if (
      occupancy === "foreign" ||
      occupancy === "unknown" ||
      occupancy === "parent"
    )
      fail("slot_occupied", `slot occupancy is ${occupancy}`);
    let childClosed = false;
    if (assignment.childId) {
      const child = this.getChildRuntime(assignment.childId);
      if (!child) fail("child_foreign", "managed child runtime is not visible");
      if (child.status === "unknown")
        fail("child_unknown", "managed child status is unknown");
      if (!request.closeChild) {
        if (child.status === "idle")
          fail(
            "child_idle",
            "managed child is idle; closeChild must be explicit",
          );
        if (child.status === "running")
          fail("child_running", "managed child is still running");
        if (child.status === "cancelled" || child.status === "exited") {
          childClosed = true;
        } else {
          fail("child_unknown", "managed child status is not terminal");
        }
      } else {
        if (!this.closeChildRuntime)
          fail(
            "child_close_uncertain",
            "managed child close operation is unavailable",
          );
        const closed = await this.closeChildRuntime(child);
        if (!closed.closed || closed.paneAlive)
          fail(
            "child_close_uncertain",
            "managed child did not close with confirmed pane death",
          );
        childClosed = true;
        const afterClose = await this.discover(workingCwd);
        const afterView = afterClose.slots.find(
          (view) => view.slot.slotId === slot.slotId,
        );
        if (!afterView || afterView.occupancy !== "free")
          fail(
            "child_close_uncertain",
            "slot occupancy remained uncertain after child close",
          );
      }
    }
    const updated = updateWorkspaceLedger(
      repository.commonDir,
      ledger.ledgerRevision,
      (next) => {
        const currentSlot = findSlot(next, slot.slotId);
        const currentAssignment = next.assignments.find(
          (candidate) => candidate.assignmentId === assignment.assignmentId,
        )!;
        currentAssignment.state = "retired";
        currentSlot.activeAssignmentId = undefined;
        currentSlot.state = "available";
        currentSlot.observation = fresh.observation;
        currentSlot.revision++;
        const item = next.workItems.find(
          (candidate) => candidate.workItemId === assignment.workItemId,
        );
        if (item) item.lifecycle = "parked";
        for (const claim of next.claims) {
          if (
            (claim.claimId === `${assignment.assignmentId}:repository` ||
              claim.claimId === assignment.assignmentId) &&
            sameOwner(claim.owner, this.owner)
          )
            claim.state = "released";
        }
      },
    );
    return {
      repository,
      slot: updated.slots.find(
        (candidate) => candidate.slotId === slot.slotId,
      )!,
      assignment: updated.assignments.find(
        (candidate) => candidate.assignmentId === assignment.assignmentId,
      )!,
      childClosed,
    };
  }

  async adopt(
    input: WorkspaceAdoptInput,
    workingCwd: string,
  ): Promise<WorkspaceAssignResult> {
    const repository = await this.repository(workingCwd);
    if (repository.repoId !== input.repoId)
      fail(
        "repository_mismatch",
        "repository id does not match the fresh Git identity",
      );
    const ledger = this.ledgerFor(repository);
    checkRevision(ledger, input.expectedRevision);
    const slot = findSlot(ledger, input.slotId);
    checkEpoch(slot, input.expectedEpoch);
    const assignment = ledger.assignments.find(
      (candidate) => candidate.assignmentId === input.assignmentId,
    );
    if (
      !assignment ||
      assignment.slotId !== slot.slotId ||
      assignment.epoch !== input.expectedEpoch
    )
      fail(
        "assignment_not_found",
        "assignment does not match the requested epoch",
      );
    const discovery = await this.discover(workingCwd);
    const fresh = findWorktree(discovery, slot);
    if (!fresh || !safeObservation(fresh.observation))
      fail("unsafe_state", "fresh adoption evidence is not safe");
    if (assignment.state !== "reserved" && assignment.state !== "bound")
      fail("adoption_required", "assignment is not in an adoptable state");
    if (fresh.observation.branchRef !== assignment.branchRef)
      fail("unsafe_state", "adoption branch does not match the assignment");
    if (
      slotIdentityBlockers(slot, fresh.worktree, fresh.observation).length > 0
    )
      fail("unsafe_state", "slot identity changed before adoption");
    const occupancy = this.scanOccupancy(slot, ledger, fresh.observation, {
      allowHeldClaims: true,
    });
    if (
      occupancy === "foreign" ||
      occupancy === "unknown" ||
      occupancy === "parent"
    )
      fail("adoption_required", `adoption occupancy is ${occupancy}`);
    if (assignment.childId) {
      const child = this.getChildRuntime(assignment.childId);
      if (!child || child.status !== "idle" || child.paneAlive === false)
        fail("child_foreign", "child binding is not explicitly adoptable");
      verifyChildBinding(child, repository, assignment);
    }
    const updated = updateWorkspaceLedger(
      repository.commonDir,
      ledger.ledgerRevision,
      (next) => {
        const currentAssignment = next.assignments.find(
          (candidate) => candidate.assignmentId === assignment.assignmentId,
        )!;
        const currentSlot = findSlot(next, slot.slotId);
        currentAssignment.owner = this.owner;
        currentAssignment.state = assignment.childId ? "bound" : "reserved";
        currentSlot.state = assignment.childId ? "assigned" : "reserved";
        currentSlot.observation = fresh.observation;
        currentSlot.revision++;
        for (const claim of next.claims) {
          if (
            claim.claimId === `${assignment.assignmentId}:repository` ||
            claim.claimId === assignment.assignmentId
          ) {
            if (claim.state === "held" && !sameOwner(claim.owner, this.owner))
              claim.state = "orphaned";
            if (sameOwner(claim.owner, this.owner)) claim.state = "released";
          }
        }
      },
    );
    return {
      repository,
      slot: updated.slots.find(
        (candidate) => candidate.slotId === slot.slotId,
      )!,
      assignment: updated.assignments.find(
        (candidate) => candidate.assignmentId === assignment.assignmentId,
      )!,
    };
  }

  async recover(
    operationId: string,
    expectedRevision: number,
    action: "reconcile" | "abandon-before-state",
    workingCwd: string,
  ): Promise<WorkspaceRecoverResult> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    const id = safeOperationId(operationId);
    const previous = ledger.outcomes.find(
      (outcome) => outcome.operationId === id,
    );
    checkRevision(ledger, expectedRevision);
    const intent = ledger.operations.find(
      (candidate) => candidate.operationId === id,
    );
    if (!intent) fail("operation_conflict", "operation id is not recorded");
    const assignment = ledger.assignments.find(
      (candidate) => candidate.assignmentId === intent.assignmentId,
    );
    const slot = assignment
      ? ledger.slots.find((candidate) => candidate.slotId === assignment.slotId)
      : undefined;
    if (!assignment || !slot)
      fail("operation_conflict", "operation references missing assignment");
    if (!sameOwner(assignment.owner, this.owner))
      fail("adoption_required", "operation belongs to another durable owner");
    if (
      ledger.claims.some(
        (claim) =>
          (claim.claimId === assignment.assignmentId ||
            claim.claimId === `${assignment.assignmentId}:repository`) &&
          claim.state === "held" &&
          !sameOwner(claim.owner, this.owner),
      )
    )
      fail("adoption_required", "operation claim belongs to another owner");
    const discovery = await this.discover(workingCwd);
    const fresh = findWorktree(discovery, slot);
    const observed = fresh?.observation ?? unknownObservationFor(slot.root);
    const classification = classifyOperation(intent, observed);
    if (previous && action === "reconcile") {
      if (previous.classification !== classification)
        fail(
          "unsafe_state",
          "fresh recovery evidence differs from the recorded outcome",
        );
      return { repository, decision: decisionFor(ledger, previous) };
    }
    if (previous) {
      if (previous.classification !== "before" || classification !== "before")
        fail(
          "operation_conflict",
          "abandon-before-state requires an exact fresh before-state",
        );
      const updated = updateWorkspaceLedger(
        repository.commonDir,
        expectedRevision,
        (next) => {
          const nextIntent = next.operations.find(
            (candidate) => candidate.operationId === id,
          )!;
          const nextAssignment = next.assignments.find(
            (candidate) => candidate.assignmentId === intent.assignmentId,
          )!;
          const nextSlot = next.slots.find(
            (candidate) => candidate.slotId === slot.slotId,
          )!;
          nextIntent.phase = "blocked";
          nextAssignment.state = "retired";
          nextSlot.state = "available";
          nextSlot.activeAssignmentId = undefined;
          nextSlot.observation = observed;
          nextSlot.revision++;
          releaseClaimsForAssignment(
            next.claims,
            intent.assignmentId,
            this.owner,
          );
        },
      );
      return { repository, decision: decisionFor(updated, previous) };
    }
    if (action === "abandon-before-state" && classification !== "before")
      fail(
        "operation_conflict",
        "abandon-before-state requires an exact fresh before-state",
      );
    const outcome: OperationOutcome = {
      operationId: id,
      classification,
      command: "not_started",
      observed,
      ...(classification === "parse_error"
        ? { errorCode: "parse_error" as const }
        : {}),
    };
    const updated = updateWorkspaceLedger(
      repository.commonDir,
      expectedRevision,
      (next) => {
        const nextIntent = next.operations.find(
          (candidate) => candidate.operationId === id,
        )!;
        const nextAssignment = next.assignments.find(
          (candidate) => candidate.assignmentId === intent.assignmentId,
        )!;
        const nextSlot = next.slots.find(
          (candidate) => candidate.slotId === slot.slotId,
        )!;
        if (action === "abandon-before-state") {
          nextIntent.phase = "blocked";
          nextAssignment.state = "retired";
          nextSlot.state = "available";
          nextSlot.activeAssignmentId = undefined;
          releaseClaimsForAssignment(
            next.claims,
            intent.assignmentId,
            this.owner,
          );
        } else if (classification === "after") {
          nextIntent.phase = "committed";
          nextAssignment.state = "retired";
          nextSlot.state = "available";
          nextSlot.activeAssignmentId = undefined;
          releaseClaimsForAssignment(
            next.claims,
            intent.assignmentId,
            this.owner,
          );
        } else if (classification === "before") {
          nextIntent.phase = "interrupted";
          nextAssignment.state = "reserved";
          nextSlot.state = "transitioning";
        } else {
          nextIntent.phase = "blocked";
          nextAssignment.state = "blocked";
          nextSlot.state = "blocked";
        }
        nextSlot.observation = observed;
        nextSlot.revision++;
        next.outcomes.push(outcome);
      },
    );
    return { repository, decision: decisionFor(updated, outcome) };
  }

  async observePublication(
    input: WorkspacePublicationInput,
    workingCwd: string,
  ): Promise<{
    repository: RepositoryRecord;
    observation: WorkspacePublicationInput & {
      observedOid?: string;
      result: "equal" | "different" | "not_advertised" | "unknown";
      freshness: "fresh" | "unknown";
    };
  }> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    const assignment = ledger.assignments.find(
      (candidate) =>
        candidate.workItemId === input.workItemId &&
        candidate.epoch === input.assignmentEpoch,
    );
    if (!assignment)
      fail(
        "assignment_conflict",
        "publication epoch is not a recorded assignment",
      );
    if (assignment.branchRef !== input.candidateBranchRef)
      fail(
        "assignment_conflict",
        "publication branch does not match the assignment",
      );
    if (
      ledger.repository.publicationRefs.length > 0 &&
      !ledger.repository.publicationRefs.some(
        (configured) =>
          configured.remote === input.remote && configured.ref === input.ref,
      )
    )
      fail("assignment_conflict", "publication remote/ref is not configured");
    if (!isFullBranchRef(input.candidateBranchRef))
      fail("assignment_conflict", "publication candidate branch is invalid");
    if (ledger.publications.length >= MAX_WORKSPACE_PUBLICATIONS)
      fail("capacity", "publication observation capacity reached");
    const remote = await this.git.observeRemoteRef(
      input.remote,
      input.ref,
      input.candidateOid,
      repository,
    );
    const result = {
      ...input,
      ...(remote.observedOid ? { observedOid: remote.observedOid } : {}),
      result: remote.result,
      freshness:
        remote.result === "unknown" ? ("unknown" as const) : ("fresh" as const),
    };
    if (ledger.publications.length >= MAX_WORKSPACE_PUBLICATIONS)
      fail("capacity", "publication observation capacity reached");
    updateWorkspaceLedger(
      repository.commonDir,
      ledger.ledgerRevision,
      (next) => {
        next.publications.push({
          observationId: randomUUID(),
          workItemId: input.workItemId,
          assignmentEpoch: input.assignmentEpoch,
          remote: input.remote,
          ref: input.ref,
          candidateOid: input.candidateOid,
          candidateBranchRef: input.candidateBranchRef,
          ...(remote.observedOid ? { observedOid: remote.observedOid } : {}),
          result: remote.result,
          freshness: result.freshness,
          source: "git_remote_probe",
          checkedAt: this.now(),
          ...(remote.errorCode ? { errorCode: remote.errorCode } : {}),
        });
      },
    );
    return { repository, observation: result };
  }

  async recordPrAssociation(
    input: WorkspacePrAssociationInput,
    workingCwd: string,
  ): Promise<PrAssociation> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    if (ledger.prAssociations.length >= MAX_WORKSPACE_PR_ASSOCIATIONS)
      fail("capacity", "PR association capacity reached");
    let recorded: PrAssociation | undefined;
    const updated = updateWorkspaceLedger(
      repository.commonDir,
      ledger.ledgerRevision,
      (next) => {
        if (next.prAssociations.length >= MAX_WORKSPACE_PR_ASSOCIATIONS)
          fail("capacity", "PR association capacity reached");
        recorded = {
          associationId: randomUUID(),
          workItemId: input.workItemId,
          provider: input.provider,
          externalId: input.externalId,
          ...(input.claimedHeadOid !== undefined
            ? { claimedHeadOid: input.claimedHeadOid }
            : {}),
          ...(input.claimedBaseRef !== undefined
            ? { claimedBaseRef: input.claimedBaseRef }
            : {}),
          provenance: input.provenance ?? "parent",
          recordedAt: this.now(),
        };
        next.prAssociations.push(recorded);
      },
    );
    if (!recorded) fail("unknown", "PR association was not recorded");
    return updated.prAssociations.find(
      (item) => item.associationId === recorded!.associationId,
    )!;
  }

  async observePr(
    input: WorkspacePrObservationInput,
    workingCwd: string,
  ): Promise<PrObservation> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    if (
      !ledger.prAssociations.some(
        (association) => association.associationId === input.associationId,
      )
    )
      fail("assignment_conflict", "PR association is not recorded");
    if (ledger.prObservations.length >= MAX_WORKSPACE_PR_OBSERVATIONS)
      fail("capacity", "PR observation capacity reached");
    let observation: PrObservation | undefined;
    const updated = updateWorkspaceLedger(
      repository.commonDir,
      ledger.ledgerRevision,
      (next) => {
        observation = {
          observationId: randomUUID(),
          associationId: input.associationId,
          state: input.state,
          ...(input.draft === undefined ? {} : { draft: input.draft }),
          verification: input.verification,
          ...(input.headRepo !== undefined ? { headRepo: input.headRepo } : {}),
          ...(input.headRef !== undefined ? { headRef: input.headRef } : {}),
          ...(input.headOid !== undefined ? { headOid: input.headOid } : {}),
          ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
          freshness: input.freshness,
          source: input.source ?? "manual_parent",
          recordedAt: this.now(),
        };
        next.prObservations.push(observation);
      },
    );
    if (!observation) fail("unknown", "PR observation was not recorded");
    return updated.prObservations.find(
      (item) => item.observationId === observation!.observationId,
    )!;
  }

  async acceptProposal(
    proposal: WorkspaceProposal,
    artifactDir: string,
    workingCwd: string,
  ): Promise<ProposalReceipt> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    let normalized: WorkspaceProposal;
    try {
      normalized = validateWorkspaceProposal(proposal);
    } catch {
      fail("proposal_invalid", "workspace proposal is malformed");
    }
    const marker = readWorkspaceAssignmentMarker(artifactDir);
    if (
      !marker ||
      marker.repoId !== repository.repoId ||
      marker.childId !== normalized.childId ||
      marker.assignmentId !== normalized.assignmentId
    )
      fail(
        "proposal_invalid",
        "proposal marker is not authoritative for this repository",
      );
    const assignment = ledger.assignments.find(
      (candidate) => candidate.assignmentId === normalized.assignmentId,
    );
    if (!assignment || assignment.childId !== normalized.childId)
      fail("proposal_invalid", "proposal child binding is not current");
    const hash = workspaceProposalHash(normalized);
    const prior = ledger.proposalReceipts.find(
      (receipt) => receipt.proposalId === normalized.proposalId,
    );
    if (prior) {
      if (prior.payloadHash === hash) return { ...prior, result: "duplicate" };
      return appendProposalReceipt(
        repository,
        ledger,
        normalized,
        hash,
        "invalid",
        this.owner,
        () => this.now(),
      );
    }
    let result: ProposalReceipt["result"];
    if (assignment.epoch !== normalized.assignmentEpoch) {
      result = "stale";
    } else {
      const activeTurnId = readWorkspaceActiveTurnId(artifactDir);
      result =
        activeTurnId !== undefined && activeTurnId !== normalized.turnId
          ? "stale"
          : "accepted";
    }
    return appendProposalReceipt(
      repository,
      ledger,
      normalized,
      hash,
      result,
      this.owner,
      () => this.now(),
    );
  }

  async reconcileProposals(workingCwd: string): Promise<ProposalReceipt[]> {
    const repository = await this.repository(workingCwd);
    const ledger = this.ledgerFor(repository);
    const receipts: ProposalReceipt[] = [];
    for (const assignment of ledger.assignments) {
      if (!assignment.childId) continue;
      const child = this.getChildRuntime(assignment.childId);
      if (!child) continue;
      const proposals = readWorkspaceProposals(child.artifactDir);
      for (const proposal of proposals.proposals)
        receipts.push(
          await this.acceptProposal(proposal, child.artifactDir, workingCwd),
        );
    }
    return receipts;
  }

  scanOccupancy(
    slot: SlotRecord,
    ledger: WorkspaceLedgerV1 | undefined,
    observation?: WorktreeObservation,
    options: { allowHeldClaims?: boolean } = {},
  ): WorkspaceOccupancy {
    const expectedAssignment = ledger?.assignments.find(
      (assignment) => assignment.assignmentId === slot.activeAssignmentId,
    );
    if (
      !options.allowHeldClaims &&
      ledger?.claims.some((claim) => claim.state === "held")
    )
      return "unknown";
    const candidates = new Map<string, WorkspaceChildRuntime>();
    for (const scope of getSessionScopes()) {
      for (const state of scope.interactiveStates.values())
        candidates.set(state.id, childRuntimeFromState(state));
    }
    for (const state of interactiveSubagentRegistry.values())
      candidates.set(state.id, childRuntimeFromState(state));
    if (pathWithin(slot.root, this.sessionCwd)) return "parent";
    for (const child of candidates.values()) {
      if (!["running", "idle", "unknown"].includes(child.status)) continue;
      const related =
        pathWithin(slot.root, child.workingCwd) ||
        child.workspaceSlotId === slot.slotId;
      if (!related) continue;
      if (child.status === "unknown") return "unknown";
      if (
        expectedAssignment &&
        child.id === expectedAssignment.childId &&
        child.workspaceSlotId === slot.slotId &&
        child.workspaceAssignmentId === expectedAssignment.assignmentId &&
        child.workspaceAssignmentEpoch === expectedAssignment.epoch &&
        child.workspaceRepoId === ledger?.repository.repoId
      ) {
        return childMarkerMatches(
          child,
          ledger!.repository.repoId,
          expectedAssignment,
        )
          ? "managed"
          : "unknown";
      }
      return "foreign";
    }
    const persisted = this.persistedOccupancy(slot, ledger);
    if (persisted !== undefined) return persisted;
    return "free";
  }

  private persistedOccupancy(
    slot: SlotRecord,
    ledger: WorkspaceLedgerV1 | undefined,
  ): WorkspaceOccupancy | undefined {
    if (!this.sessionCwd) return undefined;
    const file = stateFilePath(this.sessionCwd);
    if (!existsSync(file)) return undefined;
    const persisted = loadInteractiveStates(this.sessionCwd);
    if (!persisted) return "unknown";
    const expectedAssignment = ledger?.assignments.find(
      (assignment) => assignment.assignmentId === slot.activeAssignmentId,
    );
    for (const entry of Object.values(persisted.states)) {
      const related =
        pathWithin(slot.root, entry.workingCwd) ||
        entry.workspaceSlotId === slot.slotId;
      if (!related) continue;
      const currentState =
        this.scope?.interactiveStates.get(entry.id) ??
        interactiveSubagentRegistry.get(entry.id);
      if (
        currentState &&
        (currentState.status === "cancelled" ||
          currentState.status === "exited")
      )
        continue;
      const child: WorkspaceChildRuntime = {
        id: entry.id,
        status: "unknown",
        workingCwd: entry.workingCwd,
        artifactDir: entry.artifactDir,
        workspaceRepoId: entry.workspaceRepoId,
        workspaceSlotId: entry.workspaceSlotId,
        workspaceAssignmentId: entry.workspaceAssignmentId,
        workspaceAssignmentEpoch: entry.workspaceAssignmentEpoch,
        workspaceBranchRef: entry.workspaceBranchRef,
      };
      if (
        expectedAssignment &&
        childMarkerMatches(child, ledger!.repository.repoId, expectedAssignment)
      )
        return "unknown";
      return "foreign";
    }
    return undefined;
  }
}

function verifyRepository(
  record: RepositoryRecord,
  repository: WorkspaceRepositoryProbe,
): void {
  if (
    record.repoId !== repository.repoId ||
    record.commonDir !== repository.commonDir ||
    record.objectFormat !== repository.objectFormat
  )
    fail(
      "repository_mismatch",
      "workspace ledger belongs to another Git repository",
    );
}

function checkRevision(ledger: WorkspaceLedgerV1, expected: number): void {
  if (ledger.ledgerRevision !== expected)
    fail("revision_conflict", "workspace ledger revision changed");
}

function checkEpoch(slot: SlotRecord, expected: number): void {
  if (slot.assignmentEpoch !== expected)
    fail("epoch_conflict", "workspace slot assignment epoch changed");
}

function findSlot(ledger: WorkspaceLedgerV1, slotId: string): SlotRecord {
  const slot = ledger.slots.find((candidate) => candidate.slotId === slotId);
  if (!slot) fail("slot_not_found", "workspace slot is not registered");
  return slot;
}

function unknownObservationFor(root: string): WorktreeObservation {
  return {
    root: resolve(root),
    filesystemIdentity: "unknown",
    checkout: "unknown",
    status: "unknown",
    admin: "unknown",
  };
}

function slotForWorktree(worktree: WorkspaceWorktreeRecord): SlotRecord {
  const slotId =
    worktree.kind === "main" ? "main" : `linked:${worktree.adminKey}`;
  return {
    slotId,
    kind: worktree.kind,
    adminKey: worktree.adminKey,
    root: resolve(worktree.root),
    gitDir: resolve(worktree.gitDir),
    state: "available",
    revision: 0,
    assignmentEpoch: 0,
  };
}

function sameSlotIdentity(first: SlotRecord, second: SlotRecord): boolean {
  return (
    first.slotId === second.slotId &&
    first.adminKey === second.adminKey &&
    samePath(first.root, second.root) &&
    samePath(first.gitDir, second.gitDir)
  );
}

function selectWorktree(
  worktrees: Array<{
    worktree: WorkspaceWorktreeRecord;
    observation: WorktreeObservation;
  }>,
  request: WorkspaceRegisterSlotRequest,
  repository: WorkspaceRepositoryProbe,
):
  | { worktree: WorkspaceWorktreeRecord; observation: WorktreeObservation }
  | undefined {
  const requestedRoot = request.root ? resolve(request.root) : undefined;
  const requestedAdmin =
    request.adminKey ??
    (request.slotId === "main"
      ? "main"
      : request.slotId.replace(/^linked:/, ""));
  return worktrees.find(
    ({ worktree }) =>
      worktree.adminKey === requestedAdmin &&
      (requestedRoot === undefined || samePath(worktree.root, requestedRoot)) &&
      ((request.slotId === "main" && worktree.kind === "main") ||
        (request.slotId !== "main" && worktree.kind === "linked")) &&
      (worktree.kind === "linked" || samePath(worktree.root, repository.root)),
  );
}

function ensureClaimAvailable(
  ledger: WorkspaceLedgerV1,
  claimId: string,
  scope: "repository" | "slot",
  slotId: string | undefined,
  owner: DurableOwner,
): void {
  const existing = ledger.claims.find((claim) => claim.claimId === claimId);
  if (
    existing &&
    existing.state === "held" &&
    !sameOwner(existing.owner, owner)
  )
    fail("claim_conflict", "workspace claim is held by another durable owner");
  if (existing && (existing.scope !== scope || existing.slotId !== slotId))
    fail("claim_conflict", "workspace claim scope does not match");
}

function releaseClaims(
  commonDir: string,
  ledger: WorkspaceLedgerV1,
  claimIds: string[],
  owner: DurableOwner,
): WorkspaceLedgerV1 {
  return updateWorkspaceLedger(commonDir, ledger.ledgerRevision, (next) => {
    for (const claim of next.claims) {
      if (claimIds.includes(claim.claimId) && sameOwner(claim.owner, owner))
        claim.state = "released";
    }
  });
}

function releaseClaimsForAssignment(
  claims: WorkspaceLedgerV1["claims"],
  assignmentId: string,
  owner: DurableOwner,
): void {
  for (const claim of claims) {
    if (
      (claim.claimId === assignmentId ||
        claim.claimId === `${assignmentId}:repository`) &&
      sameOwner(claim.owner, owner)
    )
      claim.state = "released";
  }
}

function markAssignmentLaunchFailure(
  commonDir: string,
  ledger: WorkspaceLedgerV1,
  assignmentId: string,
  owner: DurableOwner,
): void {
  try {
    updateWorkspaceLedger(commonDir, ledger.ledgerRevision, (next) => {
      const assignment = next.assignments.find(
        (candidate) => candidate.assignmentId === assignmentId,
      );
      const slot = assignment
        ? next.slots.find((candidate) => candidate.slotId === assignment.slotId)
        : undefined;
      if (!assignment || !slot || !sameOwner(assignment.owner, owner)) return;
      assignment.state = "blocked";
      slot.state = "adoption_required";
      slot.revision++;
    });
  } catch {
    // The original child-launch failure is safer to return than a second storage error.
  }
}

function childRuntimeFromState(
  state: InteractiveSubagentState,
): WorkspaceChildRuntime {
  return {
    id: state.id,
    status: state.status,
    workingCwd: state.workingCwd,
    artifactDir: state.artifactDir,
    workspaceSlotId: state.workspaceSlotId,
    workspaceAssignmentId: state.workspaceAssignmentId,
    workspaceAssignmentEpoch: state.workspaceAssignmentEpoch,
    workspaceBranchRef: state.workspaceBranchRef,
    workspaceRepoId: state.workspaceRepoId,
    paneAlive:
      state.status === "running" ||
      state.status === "idle" ||
      state.status === "unknown",
  };
}

function childMarkerMatches(
  child: WorkspaceChildRuntime,
  repoId: string,
  assignment: AssignmentRecord,
): boolean {
  try {
    const marker = readWorkspaceAssignmentMarker(child.artifactDir);
    return (
      !!marker &&
      marker.repoId === repoId &&
      marker.childId === child.id &&
      marker.slotId === assignment.slotId &&
      marker.assignmentId === assignment.assignmentId &&
      marker.assignmentEpoch === assignment.epoch &&
      marker.root === assignment.expectedRoot &&
      marker.branchRef === assignment.branchRef
    );
  } catch {
    return false;
  }
}

function verifyChildBinding(
  child: WorkspaceChildRuntime,
  repository: WorkspaceRepositoryProbe,
  assignment: AssignmentRecord,
  expectedChildId?: string,
): void {
  if (expectedChildId && child.id !== expectedChildId)
    fail("child_foreign", "child id does not match the preallocated id");
  if (!validChildId(child.id)) fail("child_foreign", "child id is invalid");
  if (!samePath(child.workingCwd, assignment.expectedRoot))
    fail(
      "child_foreign",
      "child working directory does not match the slot root",
    );
  if (
    child.workspaceRepoId !== repository.repoId ||
    child.workspaceSlotId !== assignment.slotId ||
    child.workspaceAssignmentId !== assignment.assignmentId ||
    child.workspaceAssignmentEpoch !== assignment.epoch ||
    child.workspaceBranchRef !== assignment.branchRef
  )
    fail(
      "child_foreign",
      "child assignment identity does not match the ledger",
    );
  if (!childMarkerMatches(child, repository.repoId, assignment)) {
    fail("child_foreign", "child assignment marker does not match the ledger");
  }
}

function classifyOperation(
  intent: OperationIntent,
  observed: WorktreeObservation,
  failure?: unknown,
): WorkspaceOperationClassification {
  if (observed.admin === "locked" || observed.admin === "prunable")
    return "admin_locked";
  if (observationFingerprintMatches(observed, intent.intendedAfter))
    return "after";
  if (observationFingerprintMatches(observed, intent.before)) return "before";
  if (
    observed.status === "unknown" ||
    observed.admin === "unknown" ||
    observed.checkout === "unknown"
  ) {
    if (failure instanceof WorkspaceGitError && failure.code === "parse_error")
      return "parse_error";
    if (failure instanceof WorkspaceGitError && failure.code === "timeout")
      return "timeout";
    if (failure instanceof WorkspaceGitError && failure.code === "cancelled")
      return "cancelled";
    return "unknown";
  }
  return "mismatch";
}

function persistOperationOutcome(
  commonDir: string,
  intent: OperationIntent,
  outcome: OperationOutcome,
  owner: DurableOwner,
): void {
  updateWorkspaceLedger(commonDir, intent.expectedRevision, (ledger) => {
    const currentIntent = ledger.operations.find(
      (candidate) => candidate.operationId === intent.operationId,
    );
    if (!currentIntent)
      fail("operation_conflict", "operation intent disappeared");
    const existing = ledger.outcomes.find(
      (candidate) => candidate.operationId === intent.operationId,
    );
    if (existing) return;
    if (ledger.outcomes.length >= MAX_WORKSPACE_OUTCOMES)
      fail("capacity", "operation outcome capacity reached");
    ledger.outcomes.push(outcome);
    const assignment = ledger.assignments.find(
      (candidate) => candidate.assignmentId === intent.assignmentId,
    );
    const slot = assignment
      ? ledger.slots.find((candidate) => candidate.slotId === assignment.slotId)
      : undefined;
    if (!assignment || !slot)
      fail("operation_conflict", "operation intent references missing state");
    if (outcome.classification === "after") {
      currentIntent.phase = "committed";
      assignment.state = "reserved";
      slot.state = "reserved";
      slot.observation = outcome.observed;
      slot.revision++;
      for (const claim of ledger.claims)
        if (
          (claim.claimId === intent.claimId ||
            claim.claimId === `${intent.assignmentId}:repository`) &&
          sameOwner(claim.owner, owner)
        )
          claim.state = "released";
    } else if (outcome.classification === "before") {
      currentIntent.phase = "interrupted";
      assignment.state = "reserved";
      slot.state = "transitioning";
      slot.observation = outcome.observed;
      slot.revision++;
    } else {
      currentIntent.phase = "blocked";
      assignment.state = "blocked";
      slot.state = "blocked";
      slot.observation = outcome.observed;
      slot.revision++;
    }
  });
}

function decisionFor(
  ledger: WorkspaceLedgerV1,
  outcome: OperationOutcome,
): RecoveryDecision {
  const intent = ledger.operations.find(
    (candidate) => candidate.operationId === outcome.operationId,
  );
  const assignment = intent
    ? ledger.assignments.find(
        (candidate) => candidate.assignmentId === intent.assignmentId,
      )
    : undefined;
  const slot = assignment
    ? ledger.slots.find((candidate) => candidate.slotId === assignment.slotId)
    : undefined;
  const claim = intent
    ? ledger.claims.find((candidate) => candidate.claimId === intent.claimId)
    : undefined;
  return {
    operationId: outcome.operationId,
    classification: outcome.classification,
    slotState:
      slot?.state === "transitioning" ||
      slot?.state === "available" ||
      slot?.state === "blocked" ||
      slot?.state === "adoption_required"
        ? slot.state
        : slot?.state === "reserved" || slot?.state === "assigned"
          ? "available"
          : "blocked",
    assignmentState: assignment?.state ?? "blocked",
    claimState:
      claim?.state === "released" || claim?.state === "orphaned"
        ? claim.state
        : "held",
    replayed: false,
  };
}

function appendProposalReceipt(
  repository: WorkspaceRepositoryProbe,
  ledger: WorkspaceLedgerV1,
  proposal: WorkspaceProposal,
  hash: string,
  result: ProposalReceipt["result"],
  owner: DurableOwner,
  now: () => number,
): ProposalReceipt {
  if (ledger.proposalReceipts.length >= MAX_WORKSPACE_PROPOSAL_RECEIPTS)
    fail("capacity", "proposal receipt capacity reached");
  let receipt: ProposalReceipt | undefined;
  const updated = updateWorkspaceLedger(
    repository.commonDir,
    ledger.ledgerRevision,
    (next) => {
      if (next.proposalReceipts.length >= MAX_WORKSPACE_PROPOSAL_RECEIPTS)
        fail("capacity", "proposal receipt capacity reached");
      receipt = {
        receiptId: randomUUID(),
        proposalId: proposal.proposalId,
        payloadHash: hash,
        childId: proposal.childId,
        assignmentEpoch: proposal.assignmentEpoch,
        turnId: proposal.turnId,
        result,
        recordedAt: now(),
      };
      next.proposalReceipts.push(receipt);
    },
  );
  return updated.proposalReceipts.find(
    (candidate) => candidate.receiptId === receipt!.receiptId,
  )!;
}

export async function reconcileWorkspaceSession(
  cwd: string,
  owner: SessionOwnerToken,
  scope?: SessionScope,
): Promise<WorkspaceDiscovery | undefined> {
  if (
    !scope ||
    scope.id !== owner.id ||
    scope.generation !== owner.generation ||
    scope.lifecycle !== "started"
  )
    return undefined;
  const manager = new WorkspaceManager({
    scope,
    sessionCwd: cwd,
    lifecycleGuard: () =>
      scope.id === owner.id &&
      scope.generation === owner.generation &&
      scope.lifecycle === "started",
  });
  try {
    const result = await manager.reconcile(cwd);
    if (scope.generation !== owner.generation || scope.lifecycle !== "started")
      return undefined;
    return result;
  } catch {
    // Session startup must remain available for non-Git cwd values; tools expose the closed error.
    return undefined;
  }
}

export function createWorkspaceManager(
  options: WorkspaceManagerOptions = {},
): WorkspaceManager {
  return new WorkspaceManager(options);
}

export const classifyWorkspaceOperation = classifyOperation;
export const workspaceObservationMatches = observationFingerprintMatches;

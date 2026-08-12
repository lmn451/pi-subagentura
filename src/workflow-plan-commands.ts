import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { handleWorkflowApprovalCommand } from "./workflow-approvals";
import {
  DurableWorkflowPlanControllerError,
  type DurableWorkflowPlanController,
} from "./workflow-durable-plan";
import { getDurableWorkflowPlanController } from "./workflow-durable-runtime";
import type { DurableWorkflowProjection } from "./workflow-projection-repository";
import {
  WorkflowPlanMutationError,
  type WorkflowPlanMutation,
  type WorkflowPlanTaskView,
  type WorkflowPlanViewProjection,
} from "./workflow-plan-mutations";
import type { WorkflowPlanTaskDefinition } from "./workflow-plan";
import { sanitizeTerminalText } from "./workflow-plan-ui";
import {
  isDurableWorkflowRunId,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
} from "./workflow-run-types";
import type { SessionScope } from "./session-scope";

const WORKFLOW_PLAN_EVOLUTION_USAGE =
  "Usage: /workflow-plan <workflow-id> | view <workflow-id> | export <workflow-id> [path] | " +
  "edit <workflow-id> | append <workflow-id> <phase-id> <task> | skip <workflow-id> <task-id> [reason] | " +
  "approve <workflow-id> <request-id> | deny <workflow-id> <request-id> | resume <workflow-id> <run-epoch>";

function commandResponse(pi: ExtensionAPI, content: string): void {
  const sendMessage = (pi as unknown as { sendMessage?: Function }).sendMessage;
  if (typeof sendMessage !== "function") return;
  sendMessage.call(
    pi,
    {
      customType: "workflow-plan-command",
      content: sanitizeTerminalText(content),
      display: true,
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}

function commandController(
  sessionScope: SessionScope,
): DurableWorkflowPlanController {
  const controller = getDurableWorkflowPlanController(sessionScope);
  if (controller === undefined) {
    throw new Error("Durable workflow state is unavailable in this session.");
  }
  return controller;
}

function exactRunId(value: string): WorkflowPlanViewProjection["runId"] {
  if (!isDurableWorkflowRunId(value)) {
    throw new Error(`Invalid durable workflow ID "${value}".`);
  }
  return value;
}

/** Trusted host seam; this authority is never registered as a model tool. */
export interface WorkflowTrustedResumeAuthority {
  getProjection(
    runId: DurableWorkflowRunId,
  ): Promise<Pick<DurableWorkflowProjection, "owner" | "runEpoch"> | undefined>;
  trustedResume(
    runId: DurableWorkflowRunId,
    options: {
      readonly trustedActorId: string;
      readonly expectedOwner: DurableWorkflowOwner;
      readonly expectedRunEpoch: number;
    },
  ): Promise<{
    readonly runId: DurableWorkflowRunId;
    readonly completion: Promise<unknown>;
  }>;
}

export interface WorkflowTrustedResumeCommandResult {
  readonly workflowId: DurableWorkflowRunId;
  readonly runEpoch: number;
  readonly completion: Promise<unknown>;
}

/**
 * Resumes only the run epoch the human selected. Looking up a newer epoch must
 * never reinterpret stale command text as authority over that newer run.
 */
export async function handleWorkflowTrustedResumeCommand(
  args: string,
  authority: WorkflowTrustedResumeAuthority,
  trustedActorId = "workflow-plan-command",
): Promise<WorkflowTrustedResumeCommandResult> {
  const match = args.trim().match(/^(\S+)\s+([1-9]\d*)$/);
  if (match === null) {
    throw new Error("Usage: /workflow-plan resume <workflow-id> <run-epoch>");
  }
  const runId = exactRunId(match[1]!);
  const expectedRunEpoch = Number(match[2]);
  if (!Number.isSafeInteger(expectedRunEpoch)) {
    throw new Error("Workflow run epoch must be a positive safe integer.");
  }
  const projection = await authority.getProjection(runId);
  if (projection === undefined) {
    throw new DurableWorkflowPlanControllerError(
      "run_not_found",
      `Durable workflow run ${runId} is not recovered.`,
    );
  }
  if (projection.runEpoch !== expectedRunEpoch) {
    throw new DurableWorkflowPlanControllerError(
      "epoch_mismatch",
      `Durable workflow run ${runId} is at epoch ${projection.runEpoch}, not selected epoch ${expectedRunEpoch}.`,
    );
  }
  const execution = await authority.trustedResume(runId, {
    trustedActorId,
    expectedOwner: projection.owner,
    expectedRunEpoch,
  });
  return {
    workflowId: runId,
    runEpoch: expectedRunEpoch,
    completion: execution.completion,
  };
}

function formatTask(task: WorkflowPlanTaskView): string {
  return `  - ${task.id} [${task.status}] ${task.content}`;
}

export function formatWorkflowPlanCommandView(
  projection: WorkflowPlanViewProjection,
): string {
  const lines = [
    `Workflow plan ${projection.runId}`,
    `revision ${projection.revision} (${projection.revisionHash}) · epoch ${projection.runEpoch} · ${projection.status}`,
    `current phase: ${projection.currentPhaseId ?? "none"}`,
    `completed ${projection.counts.completed}/${projection.counts.total}; running ${projection.counts.running}; blocked ${projection.counts.blocked}; pending ${projection.counts.pending}`,
  ];
  for (const phase of projection.phases) {
    lines.push(`${phase.id} [${phase.mode}] ${phase.name}`);
    lines.push(...phase.tasks.map(formatTask));
  }
  return lines.join("\n");
}

/** Lexical containment check used before any filesystem operation. */
export function resolveContainedWorkflowPlanPath(
  cwd: string,
  requestedPath: string,
): string {
  if (requestedPath.trim().length === 0 || requestedPath.includes("\0")) {
    throw new Error("Workflow plan path is empty or invalid.");
  }
  const root = resolve(cwd);
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);
  const child = relative(root, candidate);
  const parentPrefix = `..${process.platform === "win32" ? "\\" : "/"}`;
  if (
    child === "" ||
    child === ".." ||
    child.startsWith(parentPrefix) ||
    isAbsolute(child)
  ) {
    throw new Error(
      "Workflow plan path must stay inside the current working directory.",
    );
  }
  return candidate;
}

async function assertRealContainment(
  cwd: string,
  candidate: string,
): Promise<{ readonly root: string; readonly parent: string }> {
  const root = await realpath(cwd);
  let ancestor = dirname(candidate);
  for (;;) {
    try {
      const stats = await lstat(ancestor);
      if (stats.isSymbolicLink()) {
        throw new Error("Workflow plan path cannot traverse a symbolic link.");
      }
      const actual = await realpath(ancestor);
      assertPathInside(root, actual);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  await mkdir(dirname(candidate), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(candidate));
  assertPathInside(root, parent);
  try {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Workflow plan export target must be a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root, parent };
}

function assertPathInside(root: string, candidate: string): void {
  const child = relative(root, candidate);
  const parentPrefix = `..${process.platform === "win32" ? "\\" : "/"}`;
  if (child === ".." || child.startsWith(parentPrefix) || isAbsolute(child)) {
    throw new Error(
      "Workflow plan path resolves outside the current working directory.",
    );
  }
}

const WORKFLOW_PLAN_EXPORT_HELPER = String.raw`
const {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { randomBytes } = require("node:crypto");

function main() {
  const expectedDevice = process.env.WORKFLOW_PLAN_EXPORT_PARENT_DEV;
  const expectedInode = process.env.WORKFLOW_PLAN_EXPORT_PARENT_INO;
  const expectedParent = process.env.WORKFLOW_PLAN_EXPORT_PARENT_PATH;
  const target = process.env.WORKFLOW_PLAN_EXPORT_TARGET;
  if (
    expectedDevice === undefined ||
    expectedInode === undefined ||
    expectedParent === undefined ||
    target === undefined ||
    target.length === 0 ||
    target === "." ||
    target === ".." ||
    target.includes("/") ||
    target.includes("\\") ||
    target.includes("\0")
  ) {
    throw new Error("Invalid workflow plan export helper request.");
  }

  const parent = statSync(".", { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.dev.toString() !== expectedDevice ||
    parent.ino.toString() !== expectedInode
  ) {
    throw new Error("Workflow plan export parent changed before write.");
  }

  function parentPathStillPinned() {
    let currentParent;
    try {
      currentParent = lstatSync(expectedParent, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    return (
      !currentParent.isSymbolicLink() &&
      currentParent.isDirectory() &&
      currentParent.dev === parent.dev &&
      currentParent.ino === parent.ino
    );
  }

  try {
    const targetStats = lstatSync(target);
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      throw new Error("Workflow plan export target must be a regular file.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  process.stdout.write("ready\n");

  const contents = readFileSync(0);
  let temporary;
  let descriptor;
  let collision;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      temporary =
        ".workflow-plan-export-" + randomBytes(16).toString("hex") + ".tmp";
      try {
        descriptor = openSync(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        break;
      } catch (error) {
        temporary = undefined;
        if (error.code === "EEXIST" || error.code === "ELOOP") {
          collision = error;
          continue;
        }
        throw error;
      }
    }
    if (descriptor === undefined || temporary === undefined) {
      throw (
        collision ?? new Error("Unable to allocate a workflow plan temp file.")
      );
    }

    const openedStats = fstatSync(descriptor, { bigint: true });
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const tempStats = lstatSync(temporary, { bigint: true });
    if (
      !tempStats.isFile() ||
      openedStats.nlink !== 1n ||
      tempStats.nlink !== 1n ||
      tempStats.dev !== openedStats.dev ||
      tempStats.ino !== openedStats.ino
    ) {
      throw new Error("Workflow plan export temp file changed during write.");
    }
    if (!parentPathStillPinned()) {
      throw new Error("Workflow plan export parent changed during write.");
    }
    renameSync(temporary, target);
    temporary = undefined;
    if (!parentPathStillPinned()) {
      let publishedStats;
      try {
        publishedStats = lstatSync(target, { bigint: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        publishedStats !== undefined &&
        publishedStats.dev === openedStats.dev &&
        publishedStats.ino === openedStats.ino
      ) {
        unlinkSync(target);
      }
      throw new Error("Workflow plan export parent changed during write.");
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The authoritative publish error is retained; cleanup is best effort.
      }
    }
    if (temporary !== undefined) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertPinnedParentPath(
  parent: string,
  expected: BigIntStats,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(parent, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Workflow plan export parent changed during write.");
    }
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameDirectory(current, expected)
  ) {
    throw new Error("Workflow plan export parent changed during write.");
  }
}

async function publishFromPinnedParent(
  parent: string,
  parentStats: BigIntStats,
  target: string,
  contents: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["-e", WORKFLOW_PLAN_EXPORT_HELPER], {
      cwd: parent,
      env: {
        WORKFLOW_PLAN_EXPORT_PARENT_DEV: parentStats.dev.toString(),
        WORKFLOW_PLAN_EXPORT_PARENT_INO: parentStats.ino.toString(),
        WORKFLOW_PLAN_EXPORT_PARENT_PATH: parent,
        WORKFLOW_PLAN_EXPORT_TARGET: target,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let ready = false;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64) stdout += chunk;
      if (!ready && stdout.includes("ready\n")) {
        ready = true;
        child.stdin.end(contents, "utf8");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.stdin.on("error", () => {
      // A failed helper reports the authoritative error on stderr.
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0 && ready) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          stderr.trim() ||
            `Workflow plan export helper exited with ${signal ?? code}.`,
        ),
      );
    });
  });
}

export async function writeContainedWorkflowPlanExport(
  cwd: string,
  requestedPath: string,
  document: unknown,
): Promise<string> {
  const candidate = resolveContainedWorkflowPlanPath(cwd, requestedPath);
  if (dirname(candidate) !== resolve(cwd)) {
    throw new Error(
      "Workflow plan exports must be direct files in the current working directory.",
    );
  }
  const contained = await assertRealContainment(cwd, candidate);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  const parentHandle = await open(
    contained.parent,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const parentStats = await parentHandle.stat({ bigint: true });
    await assertPinnedParentPath(contained.parent, parentStats);
    await publishFromPinnedParent(
      contained.parent,
      parentStats,
      basename(candidate),
      contents,
    );
    await assertPinnedParentPath(contained.parent, parentStats);
    return candidate;
  } finally {
    await parentHandle.close();
  }
}

function exportDocument(view: WorkflowPlanViewProjection): object {
  return {
    schemaVersion: 1,
    runId: view.runId,
    owner: view.owner,
    runEpoch: view.runEpoch,
    baseRevision: view.revision,
    revisionHash: view.revisionHash,
    definitionHash: view.definitionHash,
    definition: view.definition,
    taskStates: Object.fromEntries(
      view.phases.flatMap((phase) =>
        phase.tasks.map((task) => [task.id, task.status]),
      ),
    ),
    readOnlyHistory: view.phases.flatMap((phase) =>
      phase.tasks
        .filter((task) => !task.mutable)
        .map((task) => ({
          phaseId: phase.id,
          taskId: task.id,
          status: task.status,
          content: task.content,
          instruction: task.instruction,
        })),
    ),
  };
}

function parseAppendTask(raw: string): WorkflowPlanTaskDefinition {
  const input = raw.trim();
  if (input.length === 0) throw new Error("Append requires a task.");
  if (input.startsWith("{")) {
    const parsed = JSON.parse(input) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Append task JSON must be an object.");
    }
    // The controller's canonical plan validator checks the complete JSON shape.
    return parsed as unknown as WorkflowPlanTaskDefinition;
  }
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const suffix = createHash("sha256").update(input).digest("hex").slice(0, 10);
  return {
    id: `${slug || "task"}-${suffix}`,
    content: input,
    instruction: input,
  };
}

function mutationFence(view: WorkflowPlanViewProjection) {
  return {
    expectedOwner: view.owner,
    expectedRunEpoch: view.runEpoch,
    baseRevision: view.revision,
    actor: { kind: "human" as const, id: "workflow-plan-command" },
  };
}

async function mutateFromCommand(
  controller: DurableWorkflowPlanController,
  view: WorkflowPlanViewProjection,
  mutation: WorkflowPlanMutation,
): Promise<WorkflowPlanViewProjection> {
  return controller.mutatePlan(view.runId, {
    ...mutationFence(view),
    mutation,
  });
}

function staleEditMessage(error: unknown): string {
  if (
    error instanceof DurableWorkflowPlanControllerError &&
    error.code === "stale_revision"
  ) {
    return "Plan edit was not saved because the base revision is stale. Refresh/export the plan and diff your future-work changes before retrying.";
  }
  if (
    error instanceof WorkflowPlanMutationError &&
    error.code === "immutable_task"
  ) {
    return `${error.message} Refresh/export the current plan and diff only future work before retrying.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Host-side non-create command delegate. It never asks the model to carry out a
 * trusted mutation and returns false only for verbs owned by another registrar.
 */
export async function handleWorkflowPlanEvolutionCommand(
  verb: string,
  rest: string,
  ctx: ExtensionCommandContext,
  sessionScope: SessionScope,
  pi: ExtensionAPI,
): Promise<boolean> {
  const normalizedVerb = verb.trim();
  const approvalVerb =
    normalizedVerb === "approve" || normalizedVerb === "deny";
  const directView = isDurableWorkflowRunId(normalizedVerb);
  if (
    !approvalVerb &&
    !directView &&
    !["view", "export", "edit", "append", "skip", "resume"].includes(
      normalizedVerb,
    )
  ) {
    return false;
  }
  if (ctx.mode !== "tui" || ctx.hasUI !== true) {
    commandResponse(pi, "Workflow plan commands are interactive-only.");
    return true;
  }
  if (approvalVerb) {
    const approval = await handleWorkflowApprovalCommand(
      `${normalizedVerb} ${rest}`,
      commandController(sessionScope),
    );
    if (approval === undefined) return false;
    commandResponse(
      pi,
      approval.status === "accepted"
        ? `Workflow ${approval.workflowId} approval ${approval.decision}.`
        : `Workflow approval ${approval.status.replace("_", " ")}: ${approval.reason ?? "no state change"}`,
    );
    return true;
  }
  try {
    const controller = commandController(sessionScope);
    if (normalizedVerb === "resume") {
      const resumed = await handleWorkflowTrustedResumeCommand(
        rest,
        controller,
      );
      commandResponse(
        pi,
        `Workflow ${resumed.workflowId} resumed from interrupted epoch ${resumed.runEpoch}.`,
      );
      void resumed.completion.catch((error) => {
        commandResponse(
          pi,
          `Workflow ${resumed.workflowId} stopped after resume: ${staleEditMessage(error)}`,
        );
      });
      return true;
    }
    if (directView || normalizedVerb === "view") {
      const runId = exactRunId(directView ? normalizedVerb : rest.trim());
      commandResponse(
        pi,
        formatWorkflowPlanCommandView(await controller.getPlanView(runId)),
      );
      return true;
    }

    const firstSpace = rest.trim().search(/\s/);
    const runToken =
      firstSpace < 0 ? rest.trim() : rest.trim().slice(0, firstSpace);
    const remainder =
      firstSpace < 0 ? "" : rest.trim().slice(firstSpace).trim();
    const runId = exactRunId(runToken);
    const view = await controller.getPlanView(runId);

    if (normalizedVerb === "export") {
      const requested = remainder || `.workflow-plan-${runId}.json`;
      const path = await writeContainedWorkflowPlanExport(
        ctx.cwd,
        requested,
        exportDocument(view),
      );
      commandResponse(pi, `Workflow plan ${runId} exported to ${path}.`);
      return true;
    }

    if (normalizedVerb === "append") {
      const phaseSpace = remainder.search(/\s/);
      if (phaseSpace < 0) throw new Error(WORKFLOW_PLAN_EVOLUTION_USAGE);
      const phaseId = remainder.slice(0, phaseSpace);
      const task = parseAppendTask(remainder.slice(phaseSpace).trim());
      const updated = await mutateFromCommand(controller, view, {
        operation: "append",
        phaseId,
        task,
      });
      commandResponse(
        pi,
        `Workflow plan ${runId} appended task ${task.id} at revision ${updated.revision}.`,
      );
      return true;
    }

    if (normalizedVerb === "skip") {
      const taskSpace = remainder.search(/\s/);
      const taskId = taskSpace < 0 ? remainder : remainder.slice(0, taskSpace);
      if (taskId.length === 0) throw new Error(WORKFLOW_PLAN_EVOLUTION_USAGE);
      const reason =
        taskSpace < 0
          ? "Skipped by trusted workflow-plan command."
          : remainder.slice(taskSpace).trim();
      const updated = await mutateFromCommand(controller, view, {
        operation: "skip",
        taskId,
        reason,
      });
      commandResponse(
        pi,
        `Workflow plan ${runId} audited ${taskId} as skipped at revision ${updated.revision}.`,
      );
      return true;
    }

    const editor = (ctx.ui as unknown as { editor?: Function }).editor;
    if (typeof editor !== "function") {
      throw new Error("Workflow plan edit requires an interactive editor.");
    }
    const initial = `${JSON.stringify(exportDocument(view), null, 2)}\n`;
    const editedText = await editor.call(
      ctx.ui,
      `Edit future work for ${runId}`,
      initial,
    );
    if (editedText == null || String(editedText) === initial) return true;
    const document = JSON.parse(String(editedText)) as Record<string, unknown>;
    if (document.baseRevision !== view.revision) {
      throw new DurableWorkflowPlanControllerError(
        "stale_revision",
        "The editor base revision is stale.",
      );
    }
    const updated = await mutateFromCommand(controller, view, {
      operation: "replace_future",
      plan: document.definition as WorkflowPlanViewProjection["definition"],
    });
    commandResponse(
      pi,
      `Workflow plan ${runId} future work saved at revision ${updated.revision}.`,
    );
    return true;
  } catch (error) {
    commandResponse(
      pi,
      `Workflow plan command failed: ${staleEditMessage(error)}`,
    );
    return true;
  }
}

import { randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  writeFileSync,
  constants,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { InteractiveSubagentState } from "./interactive-tmux";
import type { DurableAttemptContext } from "./workflow-durable";
import {
  WorkflowPersistenceError,
  WorkflowRecoveryRequiredError,
} from "./workflow-run-store";
import { shellEscape } from "./multiplexer-contracts";

interface ProcessManifest {
  version: 1;
  nonce: string;
  state: InteractiveSubagentState;
}

function persist(path: string, value: unknown): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new WorkflowPersistenceError(
      "Durable process manifest exceeds 64 KiB.",
    );
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export async function readDurableProcess(
  path: string,
): Promise<ProcessManifest | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (info.size > 64 * 1024 || !info.isFile())
      throw new Error("Invalid process manifest size.");
    const value = JSON.parse(await file.readFile("utf8"));
    if (
      value.version !== 1 ||
      typeof value.nonce !== "string" ||
      !value.state?.artifactDir ||
      !value.state?.id
    ) {
      throw new Error("Invalid process manifest.");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WorkflowPersistenceError(
      "Cannot read durable process identity.",
      error,
    );
  } finally {
    await file?.close();
  }
}

export function durableProcessPath(context: DurableAttemptContext): string {
  if (!/^\d+-\d+$/.test(context.key))
    throw new WorkflowPersistenceError("Invalid process attempt key.");
  return join(context.directory, "attempts", `${context.key}.json`);
}

export function cancelDurableProcess(path: string): void {
  try {
    persist(path + ".cancel", { requestedAt: Date.now() });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Completed durable attempts are not reusable interactive sessions. */
export async function stopDurableProcessAttempts(
  directory: string,
): Promise<void> {
  const attempts = join(directory, "attempts");
  let names: string[];
  try {
    names = await readdir(attempts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((name) => /^\d+-\d+\.json$/.test(name))) {
    cancelDurableProcess(join(attempts, name));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function prepareDurableProcess(context: DurableAttemptContext) {
  const path = durableProcessPath(context);
  const previous = await readDurableProcess(path);
  if (previous && context.recovering) {
    let receipt;
    try {
      receipt = await open(
        path + ".started",
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      if ((await receipt.stat()).size > 4096)
        throw new Error("Oversized start receipt.");
      const started = JSON.parse(await receipt.readFile("utf8"));
      if (
        started.nonce !== previous.nonce ||
        !Number.isSafeInteger(started.pid)
      )
        throw new Error("Start receipt identity mismatch.");
    } catch (error) {
      throw new WorkflowRecoveryRequiredError(
        "Durable process has no verified start receipt. A launch may still be queued; inspect it or cancel the run before replacing it.",
        error,
      );
    } finally {
      await receipt?.close();
    }
  }
  return {
    previous: previous?.state,
    path,
    wrapCommand(command: string): string {
      const runner = fileURLToPath(
        new URL("./workflow-process-worker.mjs", import.meta.url),
      );
      return [process.execPath, runner, path, command]
        .map(shellEscape)
        .join(" ");
    },
    beforeDispatch(state: InteractiveSubagentState): void {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      state.durableWorkflowAttempt = path;
      // Do not persist mutable Pi references, maps, or the old lifecycle owner.
      const {
        telemetryTurnMessageCounts: _counts,
        supervisorOwner: _supervisor,
        sessionOwner: _owner,
        ...snapshot
      } = state;
      persist(path, {
        version: 1,
        nonce: randomUUID(),
        state: { ...snapshot, task: snapshot.task?.slice(0, 4096) },
      });
    },
  };
}

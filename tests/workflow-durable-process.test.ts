import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, access, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  prepareDurableProcess,
  cancelDurableProcess,
  durableProcessPath,
} from "../src/workflow-durable-process";
import { shellEscape } from "../src/multiplexer-contracts";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

const roots: string[] = [];
interface ChildDiagnostics {
  stderr: string;
  error?: Error;
  close?: { code: number | null; signal: NodeJS.Signals | null };
}

const childDiagnostics = new WeakMap<ChildProcess, ChildDiagnostics>();
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (childDiagnostics.get(child)?.close) continue;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        child.off("close", finish);
        child.off("error", finish);
        resolve();
      };
      child.once("close", finish);
      child.once("error", finish);
      const diagnostics = childDiagnostics.get(child);
      if (diagnostics?.close || diagnostics?.error) {
        finish();
        return;
      }
      child.kill("SIGTERM");
    });
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "durable-process-"));
  roots.push(directory);
  const attempt = await prepareDurableProcess({
    directory,
    key: "1-0",
    recovering: false,
  });
  const state = {
    id: "test",
    artifactDir: directory,
    paneId: "reusable-pane",
    mux: "tmux",
    sessionFile: join(directory, "session.jsonl"),
  } as InteractiveSubagentState;
  attempt.beforeDispatch(state);
  return { directory, attempt, state };
}
function launch(command: string) {
  const child = spawn("bash", ["-c", command], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics: ChildDiagnostics = { stderr: "" };
  childDiagnostics.set(child, diagnostics);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    diagnostics.stderr = (diagnostics.stderr + chunk).slice(-8192);
  });
  child.on("error", (error) => {
    diagnostics.error = error;
  });
  child.on("close", (code, signal) => {
    diagnostics.close = { code, signal };
  });
  children.push(child);
  return child;
}
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", resolve));

function childFailure(child: ChildProcess, reason: string): Error {
  const diagnostics = childDiagnostics.get(child);
  const close = diagnostics?.close;
  const status = close
    ? ` (exit code ${close.code}, signal ${close.signal})`
    : "";
  const stderr = diagnostics?.stderr.trim();
  return new Error(
    `Durable process child ${reason}${status}.${stderr ? `\nChild stderr:\n${stderr}` : ""}`,
    diagnostics?.error ? { cause: diagnostics.error } : undefined,
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function untilFile(path: string, child: ChildProcess): Promise<void> {
  if (await fileExists(path)) return;

  const controller = new AbortController();
  const filename = basename(path);
  const watcher = watch(dirname(path), {
    persistent: false,
    signal: controller.signal,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      child.off("close", onClose);
      child.off("error", onError);
      controller.abort();
      if (error) reject(error);
      else resolve();
    };
    const checkChild = () => {
      void fileExists(path).then(
        (exists) => {
          if (exists) {
            finish();
            return;
          }
          const diagnostics = childDiagnostics.get(child);
          if (diagnostics?.close || diagnostics?.error) {
            finish(
              childFailure(child, "ended before writing its start receipt"),
            );
          }
        },
        (error: unknown) =>
          finish(
            error instanceof Error
              ? error
              : new Error("Unable to inspect the child start receipt."),
          ),
      );
    };
    const onClose = () => checkChild();
    const onError = () => checkChild();
    child.once("close", onClose);
    child.once("error", onError);

    void (async () => {
      try {
        for await (const event of watcher) {
          if (event.filename != null && event.filename.toString() !== filename)
            continue;
          if (await fileExists(path)) {
            finish();
            return;
          }
        }
        if (!settled)
          finish(new Error(`Stopped watching for child receipt ${filename}.`));
      } catch (error) {
        if (!settled)
          finish(
            error instanceof Error
              ? error
              : new Error("Unable to watch for the child start receipt."),
          );
      }
    })();
    checkChild();
  });
}

describe("durable process one-use dispatch", () => {
  it("fails closed when a persisted launch has no start receipt yet", async () => {
    const { directory } = await fixture();
    await expect(
      prepareDurableProcess({ directory, key: "1-0", recovering: true }),
    ).rejects.toThrow("start receipt");
  });
  it("accepts bounded V4 attempt identities without permitting path traversal", () => {
    const directory = join(tmpdir(), "unused-durable-process");
    const key = `${"a".repeat(64)}-0`;
    expect(durableProcessPath({ directory, key, recovering: false })).toBe(
      join(directory, "attempts", `${key}.json`),
    );
    expect(() =>
      durableProcessPath({
        directory,
        key: "../1-0",
        recovering: false,
      }),
    ).toThrow("Invalid process attempt key");
    expect(() =>
      durableProcessPath({
        directory,
        key: `${"a".repeat(65)}-0`,
        recovering: false,
      }),
    ).toThrow("Invalid process attempt key");
  });

  it("rejects recovery under a different read-only process policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-process-policy-"));
    roots.push(directory);
    const key = `${"b".repeat(64)}-0`;
    const attempt = await prepareDurableProcess({
      directory,
      key,
      recovering: false,
      readOnly: true,
    });
    const state = {
      id: "read-only",
      artifactDir: directory,
      paneId: "read-only-pane",
      mux: "tmux",
      sessionFile: join(directory, "session.jsonl"),
    } as InteractiveSubagentState;
    attempt.beforeDispatch(state);
    expect(JSON.parse(await readFile(attempt.path, "utf8")).readOnly).toBe(
      true,
    );
    const child = launch(attempt.wrapCommand("true"));
    expect(await exited(child)).toBe(0);
    const recovered = await prepareDurableProcess({
      directory,
      key,
      recovering: true,
      readOnly: true,
    });
    expect(recovered.previous?.paneId).toBe("read-only-pane");
    await expect(
      prepareDurableProcess({
        directory,
        key,
        recovering: true,
        readOnly: false,
      }),
    ).rejects.toThrow("read-only policy changed");
  });
  it("persists identity before dispatch and refuses to execute a duplicate launch", async () => {
    const { directory, attempt, state } = await fixture();
    const output = join(directory, "effect");
    const command = [
      process.execPath,
      "-e",
      `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'x')`,
    ]
      .map(shellEscape)
      .join(" ");
    expect(await exited(launch(attempt.wrapCommand(command)))).toBe(0);
    expect(await exited(launch(attempt.wrapCommand(command)))).not.toBe(0);
    expect(await readFile(output, "utf8")).toBe("x");
    const recovered = await prepareDurableProcess({
      directory,
      key: "1-0",
      recovering: true,
    });
    expect(recovered.previous?.paneId).toBe(state.paneId);
    expect(recovered.previous?.durableWorkflowAttempt).toBe(attempt.path);
  });

  it("cancels an exact child without addressing a mux pane", async () => {
    const { attempt } = await fixture();
    const command = [process.execPath, "-e", "setInterval(() => {}, 1000)"]
      .map(shellEscape)
      .join(" ");
    const child = launch(attempt.wrapCommand(command));
    const completion = exited(child);
    await untilFile(attempt.path + ".started", child);
    cancelDurableProcess(attempt.path);
    expect(await completion).toBe(130);
    expect(
      JSON.parse(await readFile(attempt.path + ".finished", "utf8")).cancelled,
    ).toBe(true);
  });

  it("a cancellation persisted before startup prevents provider work", async () => {
    const { directory, attempt } = await fixture();
    const output = join(directory, "never");
    cancelDurableProcess(attempt.path);
    const command = [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'bad')`,
    ]
      .map(shellEscape)
      .join(" ");
    expect(await exited(launch(attempt.wrapCommand(command)))).toBe(130);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

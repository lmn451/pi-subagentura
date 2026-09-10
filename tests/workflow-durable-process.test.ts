import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  prepareDurableProcess,
  cancelDurableProcess,
} from "../src/workflow-durable-process";
import { shellEscape } from "../src/multiplexer-contracts";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      await exited;
    }
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
  const child = spawn("bash", ["-c", command], { stdio: "ignore" });
  children.push(child);
  return child;
}
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", resolve));
async function untilFile(path: string) {
  for (let i = 0; i < 100; i++) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for child receipt.");
}

describe("durable process one-use dispatch", () => {
  it("fails closed when a persisted launch has no start receipt yet", async () => {
    const { directory } = await fixture();
    await expect(
      prepareDurableProcess({ directory, key: "1-0", recovering: true }),
    ).rejects.toThrow("start receipt");
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
    await untilFile(attempt.path + ".started");
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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { importFresh } from "./test-utils";
import type { Multiplexer } from "../src/multiplexer-contracts";

let root: string;
let originalEnv: NodeJS.ProcessEnv;
let muxName: "herdr-core" | "tmux";
let mux: Multiplexer;

beforeEach(() => {
  originalEnv = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "pi core path "));
  muxName = "herdr-core";

  const parentBin = join(root, "parent runtime bin");
  mkdirSync(parentBin);
  const restrictedBin = join(root, "core restricted bin");
  mkdirSync(restrictedBin);
  const piArgsFile = join(root, "pi args.txt");
  const nodeArgsFile = join(root, "node args.txt");
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  writeFileSync(
    join(parentBin, "pi"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(piArgsFile)}\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(parentBin, "node"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(nodeArgsFile)}\n`,
    { mode: 0o700 },
  );
  chmodSync(join(parentBin, "pi"), 0o700);
  chmodSync(join(parentBin, "node"), 0o700);
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
  process.env.PATH = parentBin;
  process.env.PI_SUBAGENTURA_TEST_SECRET = "must-not-be-copied";

  mux = {
    get name() {
      return muxName;
    },
    createPane: () => ({ paneId: "core-child" }),
    killPane: () => {},
    buildAttachCommands: () => ({
      attachCommand: "hc attach core-child",
      focusCommand: "hc attach core-child",
    }),
  } as unknown as Multiplexer;

  vi.doMock("../src/multiplexer", async () => {
    const actual =
      await vi.importActual<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    return {
      ...actual,
      resolveMux: () => ({
        adapter: mux,
        context: {
          kind: "attached",
          mux: mux.name,
          paneId: "core-parent",
          server: "/tmp/core.sock",
        },
      }),
      submitMuxCommand: vi.fn(),
    };
  });
});

afterEach(() => {
  vi.doUnmock("../src/multiplexer");
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
  process.env = originalEnv;
});

it("runs Pi and the artifact CLI from a Core-restricted PATH", async () => {
  const { submitMuxCommand } = await import("../src/multiplexer");
  const { launchInteractiveSubagent } = await importFresh<
    typeof import("../src/interactive-tmux")
  >("../src/interactive-tmux");
  const { createTestSessionScope } = await import("./session-scope-fixture");
  const parentBin = process.env.PATH!;
  const restrictedBin = join(root, "core restricted bin");
  const piArgsFile = join(root, "pi args.txt");
  const nodeArgsFile = join(root, "node args.txt");

  const state = launchInteractiveSubagent({
    name: "Core worker's test",
    task: "Run with a restricted PATH",
    cwd: root,
    sessionScope: createTestSessionScope(),
  });
  const script = readFileSync(state.launchScriptFile, "utf8");
  expect(script).not.toContain("must-not-be-copied");

  const command = vi.mocked(submitMuxCommand).mock.calls.at(-1)?.[2];
  expect(command).toBeDefined();
  const child = spawnSync("/bin/bash", ["-c", command!], {
    encoding: "utf8",
    env: { PATH: restrictedBin, HOME: process.env.HOME ?? "/tmp" },
  });

  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  const piArgs = readFileSync(piArgsFile, "utf8").trimEnd().split("\n");
  expect(piArgs.slice(0, 5)).toEqual([
    "--session",
    state.sessionFile,
    "--name",
    "Core worker's test",
    "--append-system-prompt",
  ]);
  expect(readFileSync(piArgs[5]!, "utf8")).toContain(state.artifactDir);
  expect(readFileSync(piArgs[6]!.slice(1), "utf8")).toContain(
    "Run with a restricted PATH",
  );
  expect(readFileSync(nodeArgsFile, "utf8")).toContain(
    `${join(state.artifactDir, "cli.mjs")}\nprocess-exit\n0\n`,
  );
  expect(script).toContain(`export PATH='${parentBin}'`);
});

it("does not copy the parent PATH into non-Core launch scripts", async () => {
  muxName = "tmux";
  const { launchInteractiveSubagent } = await importFresh<
    typeof import("../src/interactive-tmux")
  >("../src/interactive-tmux");
  const { createTestSessionScope } = await import("./session-scope-fixture");
  const state = launchInteractiveSubagent({
    name: "Other backend",
    task: "Keep existing PATH behavior",
    cwd: root,
    sessionScope: createTestSessionScope(),
  });

  expect(readFileSync(state.launchScriptFile, "utf8")).not.toContain(
    `export PATH='${process.env.PATH}'`,
  );
});

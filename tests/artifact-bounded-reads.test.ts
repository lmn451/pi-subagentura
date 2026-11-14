import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  ensureArtifactDir,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  readOutput,
  readOutputForTurnId,
  readOutputWithDiagnostics,
} from "../src/artifact";

import { clearSessionScopes, registerSessionScope } from "../src/session-scope";
import { captureTelemetry } from "../src/telemetry";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

vi.mock("../src/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telemetry")>();
  return { ...actual, captureTelemetry: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

describe("bounded artifact output reads", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "artifact-bounded-"));
  });
  afterEach(() => {
    clearSessionScopes();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports unsafe active staging as a tool error, not pending output", async () => {
    const art = artifactPath(root, "deadbeefcafebabe");
    appendEvent(art, {
      version: 2,
      eventId: "turn-started",
      turnId: "active-turn",
      ts: 1,
      type: "turn_started",
      status: "running",
    });
    const tools = new Map<string, { execute: Function }>();
    const pi = {
      registerTool: (tool: { name: string; execute: Function }) =>
        tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    const scope = registerSessionScope({
      id: 751,
      generation: 1,
      lifecycle: "started",
      pi,
      sessionManager: { getSessionId: () => "bounded-read-parent" },
    });
    scope.interactiveStates.set(art.id, {
      id: art.id,
      name: "Bounded read",
      task: "test",
      paneId: "%99",
      sessionFile: join(root, "child.jsonl"),
      cwd: root,
      startedAt: 1,
      status: "running",
      mux: "tmux",
      attachCommand: "unused",
      selectPaneCommand: "unused",
      launchScriptFile: join(root, "unused.sh"),
      artifactDir: art.dir,
    } satisfies InteractiveSubagentState);
    registerInteractiveSubagentTools(pi, scope);
    const tool = tools.get("read_subagent_artifact")!;
    const read = () =>
      tool.execute("bounded-read", { id: art.id }, undefined, undefined, {
        cwd: root,
      });

    const pending = await read();
    expect(pending.isError).not.toBe(true);
    expect(pending.structuredContent).toMatchObject({
      outputState: "pending",
      output: null,
    });
    fs.writeFileSync(
      art.outputFile,
      Buffer.alloc(MAX_OUTPUT_SNAPSHOT_BYTES + 1),
    );
    vi.clearAllMocks();
    const oversized = await read();
    expect(oversized).toMatchObject({
      isError: true,
      details: { outputError: { code: "output_too_large" } },
      structuredContent: {
        status: "error",
        outputState: "unavailable",
        output: null,
        error: `Output exceeds the safe read limit (${MAX_OUTPUT_SNAPSHOT_BYTES + 1} bytes; maximum ${MAX_OUTPUT_SNAPSHOT_BYTES} bytes).`,
      },
    });
    expect(captureTelemetry).toHaveBeenCalledWith(
      scope.telemetry,
      expect.objectContaining({ event: "result_read", outcome: "error" }),
    );

    fs.unlinkSync(art.outputFile);
    const target = join(root, "private-output");
    fs.writeFileSync(target, "private");
    fs.symlinkSync(target, art.outputFile);
    const unreadable = await read();
    expect(unreadable).toMatchObject({
      isError: true,
      structuredContent: {
        status: "error",
        outputState: "unavailable",
        output: null,
        error: "Output could not be read safely.",
      },
    });
  });

  it("rejects finite oversized staging output before reading", () => {
    const art = artifactPath(root, "child");
    ensureArtifactDir(art);
    fs.writeFileSync(
      art.outputFile,
      Buffer.alloc(MAX_OUTPUT_SNAPSHOT_BYTES + 1),
    );
    expect(readOutput(art)).toBeNull();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(readOutputWithDiagnostics(art)).toMatchObject({
      content: null,
      outputError: {
        code: "output_too_large",
        bytes: MAX_OUTPUT_SNAPSHOT_BYTES + 1,
        maxBytes: MAX_OUTPUT_SNAPSHOT_BYTES,
      },
    });
  });

  it("rejects staging symlinks", () => {
    const art = artifactPath(root, "child");
    ensureArtifactDir(art);
    const target = join(root, "target");
    fs.writeFileSync(target, "private");
    fs.symlinkSync(target, art.outputFile);
    expect(readOutput(art)).toBeNull();
  });

  it.each(["staging", "snapshot"])(
    "bounds descriptor reads during mocked %s growth",
    (kind) => {
      const art = artifactPath(root, "child");
      ensureArtifactDir(art);
      fs.writeFileSync(art.outputFile, "ok");
      appendCompletionEvent(art, {
        turnId: "turn",
        outcome: "done",
        source: "agent_settled",
      });
      vi.clearAllMocks();
      vi.mocked(fs.openSync).mockReturnValueOnce(987);
      vi.mocked(fs.fstatSync).mockReturnValueOnce({
        isFile: () => true,
        size: MAX_OUTPUT_SNAPSHOT_BYTES,
      } as fs.Stats);
      vi.mocked(fs.readSync).mockImplementationOnce((...args: unknown[]) => {
        const buffer = args[1] as Buffer;
        expect(buffer.length).toBe(MAX_OUTPUT_SNAPSHOT_BYTES + 1);
        expect(args[3]).toBe(MAX_OUTPUT_SNAPSHOT_BYTES + 1);
        return MAX_OUTPUT_SNAPSHOT_BYTES + 1;
      });
      vi.mocked(fs.closeSync).mockImplementationOnce(() => {});
      expect(
        kind === "staging" ? readOutput(art) : readOutputForTurnId(art, "turn"),
      ).toBeNull();
      expect(fs.readSync).toHaveBeenCalledTimes(1);
      expect(fs.closeSync).toHaveBeenCalledWith(987);
    },
  );

  it("reads exact-cap files and preserves empty and missing output", () => {
    const art = artifactPath(root, "child");
    ensureArtifactDir(art);
    expect(readOutputWithDiagnostics(art)).toEqual({ content: null });
    fs.writeFileSync(art.outputFile, "");
    expect(readOutput(art)).toBe("");
    fs.writeFileSync(art.outputFile, "x".repeat(MAX_OUTPUT_SNAPSHOT_BYTES));
    expect(readOutput(art)?.length).toBe(MAX_OUTPUT_SNAPSHOT_BYTES);
  });

  it("reads verified immutable snapshots and rejects symlink replacements", () => {
    const art = artifactPath(root, "child");
    ensureArtifactDir(art);
    fs.writeFileSync(art.outputFile, "snapshot");
    const event = appendCompletionEvent(art, {
      turnId: "turn",
      outcome: "done",
      source: "agent_settled",
    });
    expect(readOutputForTurnId(art, "turn")).toBe("snapshot");
    const path = event!.output!.path;
    fs.unlinkSync(path);
    fs.symlinkSync(art.outputFile, path);
    expect(readOutputForTurnId(art, "turn")).toBeNull();
  });

  it("opens nonblocking before rejecting mocked nonregular descriptors", () => {
    const art = artifactPath(root, "child");
    vi.mocked(fs.openSync).mockReturnValueOnce(987);
    vi.mocked(fs.fstatSync).mockReturnValueOnce({
      isFile: () => false,
      size: 0,
    } as fs.Stats);
    vi.mocked(fs.closeSync).mockImplementationOnce(() => {});
    expect(readOutput(art)).toBeNull();
    expect(fs.openSync).toHaveBeenCalledWith(
      art.outputFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(987);
  });
});

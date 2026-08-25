import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cancelInteractiveSubagent,
  captureInteractiveSubagent,
  focusInteractiveSubagent,
  interactiveSubagentRegistry,
  launchInteractiveSubagent,
  sendCommandToPane,
} from "../src/interactive-tmux";
import {
  projectLineageStore,
  resolveLineageStorePaths,
} from "../src/interactive-lineage";
import {
  createDescendantSpawnTreeContext,
  createRootSpawnTreeContext,
} from "../src/spawn-tree-context";
import {
  __resetMuxInstances,
  MUX_CAPABILITIES,
  safeSegment,
} from "../src/multiplexer";
import { TmuxMultiplexer } from "../src/multiplexer-tmux";

const socket =
  process.env.PI_SUBAGENTURA_TMUX_SOCKET ??
  `pi-subagentura-test-${process.pid}`;

const savedEnv = {
  PATH: process.env.PATH,
  TMUX: process.env.TMUX,
  TMUX_PANE: process.env.TMUX_PANE,
  ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
  PI_SUBAGENTURA_TMUX_SOCKET: process.env.PI_SUBAGENTURA_TMUX_SOCKET,
  PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
  PI_SUBAGENTURA_AGENT_ID: process.env.PI_SUBAGENTURA_AGENT_ID,
  PI_SUBAGENTURA_ROOT_ID: process.env.PI_SUBAGENTURA_ROOT_ID,
  PI_SUBAGENTURA_DEPTH: process.env.PI_SUBAGENTURA_DEPTH,
  ZDOTDIR: process.env.ZDOTDIR,
};

let tempRoot: string;

function tmux(args: readonly string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
  });
}

function restoreEnv(name: keyof typeof savedEnv): void {
  const value = savedEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function installFakePiBin(root: string): void {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });

  const piPath = join(binDir, "pi");
  writeFileSync(
    piPath,
    `#!/usr/bin/env bash
set -euo pipefail

echo "fake pi started: $*" >> "$ARTIFACT_DIR/fake-pi.log"
echo "fake initial result" > "$ARTIFACT_DIR/output.md"
echo "terminal initial result"
"$ARTIFACT_DIR/cli.mjs" done 0

# Stay alive like a REPL so sendCommandToPane can deliver follow-up turns.
while IFS= read -r line; do
  echo "followup: $line" >> "$ARTIFACT_DIR/followups.log"
  echo "fake followup result: $line" > "$ARTIFACT_DIR/output.md"
  echo "terminal followup: $line"
  "$ARTIFACT_DIR/cli.mjs" done 0
done
`,
  );
  chmodSync(piPath, 0o700);
  writeFileSync(join(root, ".zshenv"), `export PATH=${binDir}:$PATH\n`);

  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.ZDOTDIR = root;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "pi-subagentura-tmux-"));
  installFakePiBin(tempRoot);

  process.env.PI_SUBAGENTURA_TMUX_SOCKET = socket;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(tempRoot, "sessions");

  // Force the relaxed tmux path that creates a detached session. Without this,
  // running the test locally inside tmux would try to target the developer's
  // real parent pane from the isolated CI socket.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  delete process.env.ZELLIJ_SESSION_NAME;

  interactiveSubagentRegistry.clear();
  __resetMuxInstances();
});

afterEach(() => {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
    });
  } catch {
    // The server may already be gone if a test failed before creating it.
  }

  interactiveSubagentRegistry.clear();
  __resetMuxInstances();

  restoreEnv("PATH");
  restoreEnv("TMUX");
  restoreEnv("TMUX_PANE");
  restoreEnv("ZELLIJ_SESSION_NAME");
  restoreEnv("PI_SUBAGENTURA_TMUX_SOCKET");
  restoreEnv("PI_CODING_AGENT_SESSION_DIR");
  restoreEnv("PI_SUBAGENTURA_AGENT_ID");
  restoreEnv("PI_SUBAGENTURA_ROOT_ID");
  restoreEnv("PI_SUBAGENTURA_DEPTH");
  restoreEnv("ZDOTDIR");

  rmSync(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("launches an interactive subagent in an isolated tmux session", async () => {
  const cwd = mkdtempSync(join(tempRoot, "workspace-"));

  const state = launchInteractiveSubagent({
    name: "CI tmux child",
    task: "do fake work",
    cwd,
    muxPreference: "tmux",
    background: true,
    notifyOnComplete: "notify",
  });

  expect(state.mux).toBe("tmux");
  expect(state.paneId).toMatch(/^%/);
  expect(state.attachCommand).toContain(`tmux -L '${socket}' attach`);

  await waitFor(() => {
    const eventsFile = join(state.artifactDir, "events.ndjson");
    return (
      existsSync(join(state.artifactDir, "output.md")) &&
      existsSync(eventsFile) &&
      readFileSync(eventsFile, "utf8").includes('"type":"completion"')
    );
  }, "timed out waiting for fake pi to finish initial turn");

  expect(readFileSync(join(state.artifactDir, "output.md"), "utf8")).toContain(
    "fake initial result",
  );

  const events = readFileSync(join(state.artifactDir, "events.ndjson"), "utf8");
  expect(events).toContain('"type":"started"');
  expect(events).toContain('"type":"completion"');
  expect(events).toContain('"outcome":"done"');
});

test("sends a follow-up message into the same tmux pane", async () => {
  const cwd = mkdtempSync(join(tempRoot, "workspace-"));

  const state = launchInteractiveSubagent({
    name: "Followup child",
    task: "initial",
    cwd,
    muxPreference: "tmux",
    background: true,
  });

  await waitFor(
    () => existsSync(join(state.artifactDir, "output.md")),
    "timed out waiting for fake pi to start",
  );

  sendCommandToPane(state, "second message");

  await waitFor(
    () =>
      existsSync(join(state.artifactDir, "followups.log")) &&
      readFileSync(join(state.artifactDir, "followups.log"), "utf8").includes(
        "second message",
      ),
    "timed out waiting for follow-up to reach fake pi",
  );
});

test("focuses a background child window through structured pane metadata", async () => {
  const first = launchInteractiveSubagent({
    name: "Focus first",
    task: "wait",
    cwd: mkdtempSync(join(tempRoot, "focus-first-")),
    muxPreference: "tmux",
    background: true,
  });
  const second = launchInteractiveSubagent({
    name: "Focus second",
    task: "wait",
    cwd: mkdtempSync(join(tempRoot, "focus-second-")),
    muxPreference: "tmux",
    background: true,
  });

  expect(
    tmux([
      "display-message",
      "-p",
      "-t",
      second.paneId,
      "#{window_active}",
    ]).trim(),
  ).toBe("0");
  await focusInteractiveSubagent(second);
  expect(
    tmux([
      "display-message",
      "-p",
      "-t",
      second.paneId,
      "#{window_active}",
    ]).trim(),
  ).toBe("1");

  cancelInteractiveSubagent(second.id);
  cancelInteractiveSubagent(first.id);
});

test("captures live pane output with byte and line bounds", async () => {
  const state = launchInteractiveSubagent({
    name: "Capture child",
    task: "emit terminal output",
    cwd: mkdtempSync(join(tempRoot, "capture-workspace-")),
    muxPreference: "tmux",
    background: true,
  });
  await waitFor(
    () => existsSync(join(state.artifactDir, "output.md")),
    "timed out waiting for capture child",
  );

  const full = await captureInteractiveSubagent(state, {
    maxBytes: 4096,
    maxLines: 200,
  });
  expect(full.output).toContain("terminal initial result");

  const bounded = await captureInteractiveSubagent(state, {
    maxBytes: 12,
    maxLines: 1,
  });
  expect(Buffer.byteLength(bounded.output, "utf8")).toBeLessThanOrEqual(12);
  expect(bounded.output.split("\n")).toHaveLength(1);
  expect(bounded.truncated).toBe(true);

  cancelInteractiveSubagent(state.id);
});

test("cancel writes the cancellation marker and kills the tmux pane", async () => {
  const cwd = mkdtempSync(join(tempRoot, "workspace-"));

  const state = launchInteractiveSubagent({
    name: "Cancel child",
    task: "long work",
    cwd,
    muxPreference: "tmux",
    background: true,
  });

  const cancelled = cancelInteractiveSubagent(state.id);

  expect(cancelled?.status).toBe("cancelled");
  expect(existsSync(join(state.artifactDir, ".cancelled"))).toBe(true);
});

test("focusPane targets the pane's own session when window names collide", async () => {
  // Regression guard for a silent wrong-agent focus. `focusPane` used to build
  // `select-window -t <windowName>` with no session qualifier, dropping the
  // populated `PaneRef.session`. Window names are `safeSegment(name)`, so two
  // sub-agents both called "reviewer" collide trivially — and real tmux answers
  // an unqualified name target from whichever session it scans first, exiting 0.
  // The result was "focus succeeded" while a different agent got focused.
  const mux = new TmuxMultiplexer();
  const windowName = "reviewer";
  const panes: Record<string, string> = {};

  for (const session of ["collide-a", "collide-b"]) {
    // Window 0 is `home` and stays active; window 1 is the colliding name.
    tmux(["new-session", "-d", "-s", session, "-n", "home"]);
    panes[session] = tmux([
      "new-window",
      "-d",
      "-t",
      session,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{pane_id}",
    ]).trim();
    expect(panes[session]).toMatch(/^%/);
  }

  const activeWindow = (session: string): string =>
    tmux([
      "display-message",
      "-p",
      "-t",
      `${session}:`,
      "#{window_name}",
    ]).trim();

  expect(activeWindow("collide-a")).toBe("home");
  expect(activeWindow("collide-b")).toBe("home");

  // Focus the pane in `collide-a` specifically. This direction is what makes
  // the test a real guard: verified against tmux 3.7b, an unqualified
  // `select-window -t reviewer` on this server resolves to `collide-b` (the
  // most recently created session), so the pre-fix implementation moved
  // `collide-b` and left `collide-a` alone — while still exiting 0.
  await mux.focusPane({
    paneId: panes["collide-a"]!,
    windowName,
    session: "collide-a",
  });

  // The requested session moved...
  expect(activeWindow("collide-a")).toBe(windowName);
  // ...and the identically-named window in the OTHER session did not.
  expect(activeWindow("collide-b")).toBe("home");

  tmux(["kill-session", "-t", "collide-a"]);
  tmux(["kill-session", "-t", "collide-b"]);
});

test("buildAttachCommands emits window targets real tmux resolves unambiguously", async () => {
  // Companion guard to the `focusPane` test above, for the OTHER half of the
  // same ambiguity: the copy-paste strings we hand the user. These were
  // session-unqualified (`select-window -t reviewer`), and real tmux answers a
  // bare name target from whichever session it scans first while exiting 0 — so
  // the "focus your sub-agent" command silently drove a different agent's
  // window. Unlike the mocked suites, this executes the emitted strings.
  const mux = new TmuxMultiplexer();
  const windowName = "reviewer";
  const panes: Record<string, string> = {};

  for (const session of ["attach-a", "attach-b"]) {
    tmux(["new-session", "-d", "-s", session, "-n", "home"]);
    panes[session] = tmux([
      "new-window",
      "-d",
      "-t",
      session,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{pane_id}",
    ]).trim();
  }

  const activeWindow = (session: string): string =>
    tmux([
      "display-message",
      "-p",
      "-t",
      `${session}:`,
      "#{window_name}",
    ]).trim();

  const cmds = mux.buildAttachCommands({
    paneId: panes["attach-a"]!,
    windowName,
  });
  expect(cmds.focusCommand).toContain(`'attach-a:${windowName}'`);
  expect(cmds.attachCommand).toContain(`'attach-a:${windowName}'`);

  // 1. The focusCommand, run verbatim through a shell, moves the requested
  //    session and leaves the identically-named window in the other one alone.
  expect(activeWindow("attach-a")).toBe("home");
  expect(activeWindow("attach-b")).toBe("home");
  execFileSync("/bin/sh", ["-c", cmds.focusCommand], { stdio: "ignore" });
  expect(activeWindow("attach-a")).toBe(windowName);
  expect(activeWindow("attach-b")).toBe("home");

  // 2. The attachCommand's `attach \; select-window` chain also has to work,
  //    and it needs a real terminal to attach to — so run it inside a tmux pane
  //    (which owns a pty) with $TMUX unset, the situation a user pasting into a
  //    plain shell is in. `sleep` keeps the client alive long enough to observe.
  tmux(["select-window", "-t", "attach-a:home"]);
  expect(activeWindow("attach-a")).toBe("home");
  tmux([
    "new-session",
    "-d",
    "-s",
    "attach-driver",
    `unset TMUX; ${cmds.attachCommand}; sleep 60`,
  ]);

  await waitFor(
    () =>
      tmux(["list-clients", "-t", "attach-a", "-F", "#{client_name}"]).trim()
        .length > 0,
    "the emitted attachCommand never attached a client to attach-a",
  );
  // The chained select-window landed on the right window, in the right session.
  expect(activeWindow("attach-a")).toBe(windowName);
  expect(activeWindow("attach-b")).toBe("home");

  tmux(["kill-session", "-t", "attach-driver"]);
  tmux(["kill-session", "-t", "attach-a"]);
  tmux(["kill-session", "-t", "attach-b"]);
});

test("safeSegment window names stay selectable in real tmux", async () => {
  // `safeSegment` must exclude `.`: tmux target syntax reads `window.pane`, so
  // a window literally named `review.v2` is creatable but not selectable
  // (`can't find pane: v2`), which permanently breaks focus for any sub-agent
  // whose model-chosen name contains a dot.
  const segment = safeSegment("Review.v2 Agent");
  expect(segment).toBe("review-v2-agent");
  expect(segment).not.toContain(".");

  tmux(["new-session", "-d", "-s", "dotted", "-n", "home"]);
  const paneId = tmux([
    "new-window",
    "-d",
    "-t",
    "dotted",
    "-n",
    segment,
    "-P",
    "-F",
    "#{pane_id}",
  ]).trim();

  // Both the structured focus path and the copy-paste `select-window` form
  // must resolve this name.
  expect(() =>
    tmux(["select-window", "-t", `dotted:${segment}`]),
  ).not.toThrow();
  await new TmuxMultiplexer().focusPane({
    paneId,
    windowName: segment,
    session: "dotted",
  });
  expect(
    tmux(["display-message", "-p", "-t", paneId, "#{window_active}"]).trim(),
  ).toBe("1");

  tmux(["kill-session", "-t", "dotted"]);
});

test("declared tmux capabilities match what the binary actually does", async () => {
  // M7: the capability record used to be unread, unverified metadata. Each flag
  // below is exercised for real by the focus/capture tests in this file.
  const mux = new TmuxMultiplexer();
  expect(mux.capabilities).toEqual(MUX_CAPABILITIES.tmux);
  expect(mux.isAvailable()).toBe(true);
  // nativeOverlay describes the backend, but the overlay still needs the parent
  // process to be inside tmux — these tests deliberately run outside one.
  expect(mux.capabilities.nativeOverlay).toBe(true);
  await expect(mux.showNativeViewer("Agent", "content")).resolves.toBe(false);
});

test("launches and projects a recursive child hierarchy across cwd values", async () => {
  const childCwd = mkdtempSync(join(tempRoot, "child-workspace-"));
  const grandchildCwd = mkdtempSync(join(tempRoot, "grandchild-workspace-"));
  const rootId = "tmux-recursive-root";
  const rootContext = createRootSpawnTreeContext(
    rootId,
    process.env.PI_CODING_AGENT_SESSION_DIR!,
  );

  const child = launchInteractiveSubagent({
    name: "Recursive child",
    task: "spawn a nested child",
    cwd: childCwd,
    parentSessionId: "root-owner",
    muxPreference: "tmux",
    background: true,
    spawnTreeContext: rootContext,
  });
  const childContext = createDescendantSpawnTreeContext(
    rootContext,
    child.id,
    child.artifactDir,
  );
  const grandchild = launchInteractiveSubagent({
    name: "Recursive grandchild",
    task: "nested fake work",
    cwd: grandchildCwd,
    parentSessionId: "child-owner",
    muxPreference: "tmux",
    background: true,
    spawnTreeContext: childContext,
  });

  const paths = await resolveLineageStorePaths(
    process.env.PI_CODING_AGENT_SESSION_DIR!,
    rootId,
  );
  const projection = await projectLineageStore(
    paths.nodesDir,
    basename(paths.treeDir),
    () => false,
  );

  expect(projection.roots.map((node) => node.manifest.agentId)).toEqual([
    child.id,
  ]);
  expect(projection.roots[0]?.manifest.cwd).toBe(childCwd);
  expect(
    projection.roots[0]?.children.map((node) => node.manifest.agentId),
  ).toEqual([grandchild.id]);
  expect(projection.roots[0]?.children[0]?.manifest.cwd).toBe(grandchildCwd);

  cancelInteractiveSubagent(grandchild.id);
  cancelInteractiveSubagent(child.id);
});

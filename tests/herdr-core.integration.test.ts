import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { getMux, resolveMux, submitMuxCommand } from "../src/multiplexer";
import {
  probeLiveMuxTarget,
  probeLiveMuxTargetAsync,
} from "../src/multiplexer-live-probes";
import { readProcessContext } from "../src/multiplexer-process-context";
import { fileURLToPath } from "node:url";

it.runIf(process.env.PI_SUBAGENTURA_HERDR_CORE_TEST === "1")(
  "launches, probes, captures, sends to, and kills a real Herdr Core terminal",
  async () => {
    // macOS Unix socket paths have a lower limit than typical temp directories permit.
    const dir = mkdtempSync("/tmp/pi-hc-");
    const socket = join(dir, "core.sock");
    const env = {
      ...process.env,
      HC_SESSION: `pi-hc-${process.pid}`,
      HC_SOCKET: socket,
      HC_TERMINAL_SOCKET: socket,
      HC_TERMINAL_ID: undefined,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_STATE_HOME: join(dir, "state"),
      XDG_RUNTIME_DIR: dir,
    };
    const hc = (...args: string[]) =>
      JSON.parse(
        execFileSync("hc", args, { env, encoding: "utf8", timeout: 5_000 }),
      );
    const saved = { ...process.env };
    Object.assign(process.env, env);
    delete process.env.HC_TERMINAL_ID;
    try {
      const parent = hc(
        "run",
        "--bg",
        "--json",
        "--",
        "/bin/sleep",
        "60",
      ).address;
      const parentPid = hc("get", "--json", parent).pid;
      const context = readProcessContext(parentPid);
      expect(context).toBeDefined();
      if (!context) throw new Error("No process context for real hc terminal");
      process.env.HC_TERMINAL_ID = parent;
      const target = {
        mux: "herdr-core",
        paneId: parent,
        server: socket,
      } as const;
      expect(probeLiveMuxTarget(target, context)).toMatchObject({
        kind: "match",
        distance: -1,
      });
      await expect(
        probeLiveMuxTargetAsync(target, context),
      ).resolves.toMatchObject({ kind: "match" });
      expect(resolveMux({ preference: "herdr-core" }).context).toEqual({
        ...target,
        kind: "attached",
      });
      const mux = getMux({ preference: "herdr-core" });
      expect(mux.isAvailable()).toBe(true);
      const pane = mux.createPane({
        name: "test pane",
        cwd: dir,
        background: false,
        context: { ...target, kind: "attached" },
      });
      expect(pane.server).toBe(socket);
      expect(hc("get", "--json", pane.paneId)).toMatchObject({
        parent,
        cwd: dir,
      });
      expect(mux.getPaneLiveness(pane.paneId, undefined, socket)).toBe("alive");
      await expect(
        mux.getPaneLivenessAsync("tzzzz", undefined, socket),
      ).resolves.toBe("dead");
      expect(mux.buildAttachCommands(pane).attachCommand).toContain(
        `hc attach ${pane.paneId}`,
      );
      submitMuxCommand(
        mux,
        pane.paneId,
        "printf 'test-%s\n' success",
        undefined,
        socket,
      );
      await expect
        .poll(
          async () =>
            (await mux.capturePane(pane, { maxBytes: 200, maxLines: 8 }))
              .output,
        )
        .toContain("test-success");
      expect(
        await mux.capturePane(pane, { maxBytes: 8, maxLines: 1 }),
      ).toMatchObject({ truncated: true });
      mux.killPane(pane.paneId, undefined, socket);
      await expect(
        mux.getPaneLivenessAsync(pane.paneId, undefined, socket),
      ).resolves.toBe("dead");
    } finally {
      process.env = saved;
      try {
        hc("server", "stop", "--json");
      } catch {
        // Core may never have started, e.g. if hc is not installed.
      }
      rmSync(dir, { force: true, recursive: true });
    }
  },
  25_000,
);

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(repo, "tests/terminal-e2e/fixtures");

function readJsonLines(path: string) {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .slice(0, -1)
        .map((line) => JSON.parse(line))
    : [];
}

function setUpPiPackages(agentDir: string, cwd: string): void {
  // Mirror Pi's managed npm install with a separate copy of this checkout.
  const installed = join(agentDir, "npm/node_modules/pi-subagentura");
  mkdirSync(installed, { recursive: true });
  const prompts = readdirSync(repo).filter((name) =>
    name.endsWith("_SYSTEM_PROMPT.md"),
  );
  for (const file of ["package.json", "src", "skills", ...prompts]) {
    cpSync(join(repo, file), join(installed, file), { recursive: true });
  }
  symlinkSync(join(repo, "node_modules"), join(installed, "node_modules"));
  const source = "npm:pi-subagentura";
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [source],
      extensions: [join(fixture, "mock-provider.ts"), "-builtin:mcp"],
    }),
  );
  writeFileSync(
    join(cwd, ".pi/settings.json"),
    JSON.stringify({
      packages: [
        repo,
        { source, autoload: false, extensions: ["-src/subagent.ts"] },
      ],
    }),
  );
}

it.runIf(process.env.PI_SUBAGENTURA_HERDR_CORE_TEST === "1")(
  "starts a real Pi child after trusting a project that masks the global extension",
  async () => {
    // Keep Core and Pi off the host's sockets, configuration and credentials.
    const root = mkdtempSync("/tmp/pi-hc-child-");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const sessions = join(root, "sessions");
    const socket = join(root, "core.sock");
    const networkLog = join(root, "network.ndjson");
    const providerLog = join(root, "provider.ndjson");
    const env = {
      PATH: [dirname(process.execPath), process.env.PATH].join(":"),
      HOME: root,
      TMPDIR: root,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      HC_SESSION: "pi-hc-child",
      HC_SOCKET: socket,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: "1",
      SUBAGENTURA_E2E_API_KEY: "subagentura-e2e-test-key",
      SUBAGENTURA_E2E_LOG: providerLog,
      SUBAGENTURA_E2E_NETWORK_LOG: networkLog,
      NODE_OPTIONS: `--require="${join(fixture, "deny-network.cjs")}"`,
    };
    const hc = (...args: string[]) =>
      execFileSync("hc", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
    const screen = (address: string) => hc("read", "--lines", "40", address);
    const poll = { timeout: 12_000, interval: 150 };
    try {
      setUpPiPackages(agentDir, cwd);
      const { address: parent } = JSON.parse(
        hc(
          "run",
          "--bg",
          "--json",
          "--",
          "pi",
          "--approve",
          "--orchestratorv2",
          "--split",
          "--model",
          "subagentura-e2e/mock",
          "[E2E:HERDR_CORE_INTERACTIVE] Start one native review child.",
        ),
      );
      const child = await vi
        .waitUntil(() => {
          const { terminals } = JSON.parse(hc("ls", "--all", "--json"));
          return terminals.find(
            (terminal: { parent?: string }) => terminal.parent === parent,
          );
        }, poll)
        .catch((error) => {
          throw new Error(
            `Core fixture did not launch a child:\n${screen(parent)}`,
            { cause: error },
          );
        });
      await expect
        .poll(() => screen(child.address), poll)
        .toContain("Trust (this session only)");

      const sessionRoot = join(sessions, "subagentura");
      const [sessionDirName] = readdirSync(sessionRoot);
      const sessionDir = join(sessionRoot, sessionDirName);
      const artifacts = join(sessionDir, "artifacts");
      const [artifactName] = readdirSync(artifacts);
      const artifactDir = join(artifacts, artifactName);
      // At the picker only the global copy could have claimed the bootstrap.
      expect(
        readdirSync(artifactDir).some((name) =>
          name.startsWith(".child-artifact-bootstrap-"),
        ),
      ).toBe(false);
      hc("keys", child.address, "down", "down", "enter");

      const events = await vi.waitUntil(() => {
        const entries = readJsonLines(join(artifactDir, "events.ndjson"));
        return (
          entries.some(
            (event) =>
              event.type === "process_exited" ||
              event.source === "agent_settled",
          ) && entries
        );
      }, poll);
      const exit = events.find((event) => event.type === "process_exited");
      expect(
        exit?.exitCode,
        `Child exited before its first settled turn:\n${screen(child.address)}`,
      ).toBeUndefined();
      expect(existsSync(join(agentDir, "trust.json"))).toBe(false);

      const session = readdirSync(sessionDir).find((path) =>
        path.endsWith(".jsonl"),
      );
      if (!session) throw new Error("No persisted child session");
      const user = readJsonLines(join(sessionDir, session)).find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
      expect(user?.id).toEqual(expect.any(String));
      expect(
        events.filter(
          (e) => e.type === "turn_started" || e.type === "completion",
        ),
      ).toMatchObject([
        { type: "turn_started", turnId: user.id },
        {
          type: "completion",
          turnId: user.id,
          outcome: "done",
          source: "agent_settled",
        },
      ]);
      expect(screen(child.address)).toContain(
        "Child result for [E2E:CHILD_SMOKE].",
      );

      const network = readJsonLines(networkLog);
      const providerPids = new Set(
        readJsonLines(providerLog).map((event) => event.pid),
      );
      expect(providerPids.size).toBe(2); // One parent and one fresh child.
      for (const pid of providerPids)
        expect(network).toContainEqual(
          expect.objectContaining({ kind: "armed", pid }),
        );
      expect(network.filter((event) => event.kind !== "armed")).toEqual([]);
    } finally {
      try {
        if (existsSync(socket)) hc("server", "stop", "--json");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  45_000,
);

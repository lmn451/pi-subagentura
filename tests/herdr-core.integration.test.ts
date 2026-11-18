import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getMux, resolveMux, submitMuxCommand } from "../src/multiplexer";
import {
  probeLiveMuxTarget,
  probeLiveMuxTargetAsync,
} from "../src/multiplexer-live-probes";
import { readProcessContext } from "../src/multiplexer-process-context";

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

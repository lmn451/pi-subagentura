/**
 * Real-binary integration tests for the zellij backend.
 *
 * Why this file exists: `tests/multiplexer-zellij.test.ts` is ~1000 lines of
 * `vi.doMock("node:child_process")`, so it verifies the argv we BELIEVE zellij
 * accepts, never the argv zellij ACTUALLY accepts. That is exactly how a
 * `dump-screen` call with a bogus `/dev/stdout` positional shipped with CI
 * green: clap rejected it client-side (exit 2, "Found argument '/dev/stdout'
 * which wasn't expected"), so both overlay actions that read pane output were
 * dead for every zellij sub-agent, while the mocked test asserted the broken
 * argv was correct.
 *
 * These tests therefore pin zellij's real CLI contract — flag names, output
 * shape, exit codes — for the operations the overlay depends on: pane create,
 * `dump-screen` capture, focus, and `write-chars`/`write` delivery.
 *
 * Excluded from the default `test` script (see `package.json`); run via
 * `npm run test:zellij`. Skipped entirely when zellij is not installed, and the
 * suite is self-cleaning (each spawn gets a pid-scoped background session that
 * `afterEach` deletes).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZellijMultiplexer } from "../src/multiplexer-zellij";
import { MUX_CAPABILITIES } from "../src/multiplexer";

function zellijInstalled(): boolean {
  try {
    execFileSync("/bin/sh", ["-c", "command -v zellij"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const hasZellij = zellijInstalled();

const savedEnv = {
  ZELLIJ: process.env.ZELLIJ,
  ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
};

/** Sessions created by the current test, torn down in afterEach. */
let sessions: string[] = [];
let tempRoot: string;
let spawnCounter = 0;

function deleteSession(session: string): void {
  try {
    execFileSync("zellij", ["delete-session", session, "--force"], {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    // Already gone, or the server never came up.
  }
}

/**
 * Poll until `predicate` holds. zellij's CLI is a client talking to a server
 * over a socket, so "the command returned" does not mean "the pane's shell has
 * produced output yet".
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 20000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${message}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
  );
}

/**
 * Create a background session + pane through the production code path and wait
 * until the pane is reported alive.
 */
async function spawnPane(mux: ZellijMultiplexer, name: string) {
  const id = `it${process.pid}x${spawnCounter++}`;
  const cwd = mkdtempSync(join(tempRoot, "ws-"));
  let created: ReturnType<ZellijMultiplexer["createPane"]> | undefined;
  // `attach --create-background` returns before the server is guaranteed to
  // have materialized the session's panes, so retry the whole create.
  await waitFor(() => {
    try {
      created = mux.createPane({ name, cwd, background: true, id });
      return true;
    } catch {
      return false;
    }
  }, `timed out creating a zellij pane for ${name}`);
  const pane = created!;
  if (pane.session) sessions.push(pane.session);
  await waitFor(
    () => mux.getPaneLiveness(pane.paneId, pane.session) === "alive",
    `pane ${pane.paneId} never reported alive in ${pane.session}`,
  );
  return pane;
}

describe.skipIf(!hasZellij)("zellij backend against the real binary", () => {
  let mux: ZellijMultiplexer;

  beforeAll(() => {
    // Fail loudly rather than silently testing nothing if the guard regresses.
    expect(hasZellij).toBe(true);
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-subagentura-zellij-"));
    sessions = [];
    // Force the relaxed-spawn path: create our own background session instead
    // of targeting whatever session a developer happens to be sitting in.
    delete process.env.ZELLIJ;
    delete process.env.ZELLIJ_SESSION_NAME;
    mux = new ZellijMultiplexer();
  });

  afterEach(() => {
    for (const session of sessions) deleteSession(session);
    sessions = [];
    if (savedEnv.ZELLIJ === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = savedEnv.ZELLIJ;
    if (savedEnv.ZELLIJ_SESSION_NAME === undefined)
      delete process.env.ZELLIJ_SESSION_NAME;
    else process.env.ZELLIJ_SESSION_NAME = savedEnv.ZELLIJ_SESSION_NAME;
    rmSync(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("isAvailable finds the installed binary", () => {
    expect(mux.isAvailable()).toBe(true);
  });

  it("createPane makes a live, addressable pane in a background session", async () => {
    const pane = await spawnPane(mux, "Create child");

    expect(pane.session).toMatch(/^pi-subagent-/);
    expect(pane.windowName).toBe("create-child");
    // Normalized to the bare integer form `list-panes --json` reports.
    expect(pane.paneId).toMatch(/^\d+$/);
    expect(mux.getPaneLiveness(pane.paneId, pane.session)).toBe("alive");
    await expect(mux.observePane(pane.paneId, pane.session)).resolves.toEqual({
      kind: "alive",
    });
  });

  it("reports dead for an id the session never had", async () => {
    const pane = await spawnPane(mux, "Liveness child");
    expect(mux.getPaneLiveness("99999", pane.session)).toBe("dead");
  });

  it("capturePane reads real pane output via dump-screen", async () => {
    // THE regression guard for this file. A `/dev/stdout` positional here made
    // zellij exit 2 before ever reaching the session, so `capturePane` rejected
    // for every sub-agent forever — `v` snapshot and `n` native viewer both.
    const pane = await spawnPane(mux, "Capture child");
    const marker = `ZELLIJ_CAPTURE_MARKER_${process.pid}`;

    mux.sendKeys(pane.paneId, `echo ${marker}`, pane.session);
    mux.sendEnter(pane.paneId, pane.session);

    let captured = "";
    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId, session: pane.session },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      captured = result.output;
      // Two occurrences would be the echoed command line plus its output; one
      // is enough to prove the capture reached the pane.
      return captured.includes(marker);
    }, "timed out waiting for the marker to appear in dump-screen output");

    expect(captured).toContain(marker);
  });

  it("capturePane honors maxLines and maxBytes bounds", async () => {
    const pane = await spawnPane(mux, "Bounded child");
    const marker = `ZELLIJ_BOUND_MARKER_${process.pid}`;

    mux.sendKeys(pane.paneId, `echo ${marker}`, pane.session);
    mux.sendEnter(pane.paneId, pane.session);
    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId, session: pane.session },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      return result.output.includes(marker);
    }, "timed out waiting for bounded-capture marker");

    const bounded = await mux.capturePane(
      { paneId: pane.paneId, session: pane.session },
      { maxBytes: 12, maxLines: 1 },
    );
    expect(Buffer.byteLength(bounded.output, "utf8")).toBeLessThanOrEqual(12);
    expect(bounded.output.split("\n")).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
  });

  it("capturePane returns empty (not an error) for an unknown pane id", async () => {
    // Pinning surprising real behavior: zellij 0.44.3 answers
    // `dump-screen --pane-id 99999` with exit 0 and no output, so a capture of
    // a pane that does not exist is indistinguishable from a capture of an
    // empty pane. Callers cannot use a capture failure as a liveness signal —
    // that is what `getPaneLiveness` is for.
    const pane = await spawnPane(mux, "Missing pane child");
    const result = await mux.capturePane(
      { paneId: "99999", session: pane.session },
      { maxBytes: 1024, maxLines: 10 },
    );
    expect(result.output.trim()).toBe("");
  });

  it("sendKeys delivers text starting with a dash (flag terminator works)", async () => {
    // Without `--`, zellij's clap parser rejects the whole command:
    // "Found argument '-n' which wasn't expected".
    const pane = await spawnPane(mux, "Dash child");
    const marker = `DASH_OK_${process.pid}`;

    expect(() =>
      mux.sendKeys(pane.paneId, `echo -n ${marker}`, pane.session),
    ).not.toThrow();
    // Leading-dash text as the very first character is the hostile case.
    expect(() =>
      mux.sendKeys(pane.paneId, `-not-a-flag`, pane.session),
    ).not.toThrow();
  });

  it("focusPane succeeds for a background tab and for a bare pane id", async () => {
    const pane = await spawnPane(mux, "Focus child");

    await expect(
      mux.focusPane({
        paneId: pane.paneId,
        windowName: pane.windowName,
        session: pane.session,
      }),
    ).resolves.toBeUndefined();

    await expect(
      mux.focusPane({ paneId: pane.paneId, session: pane.session }),
    ).resolves.toBeUndefined();
  });

  it("focusPane cannot detect an unknown tab name (zellij exits 0)", async () => {
    // Pinning surprising real behavior: `action go-to-tab-name no-such-tab`
    // exits 0 in zellij 0.44.3. So a resolved `focusPane` does NOT prove the
    // tab was found, and the backend gives us no signal to surface. This is why
    // focus targets should stay derived from what `createPane` returned rather
    // than from anything reconstructed later.
    const pane = await spawnPane(mux, "Focus unknown child");
    await expect(
      mux.focusPane({
        paneId: pane.paneId,
        windowName: "no-such-tab-name",
        session: pane.session,
      }),
    ).resolves.toBeUndefined();
  });

  it("killPane removes the pane and is safe to repeat", async () => {
    // Also the regression guard for the plugin/terminal pane-id collision:
    // zellij numbers `terminal_N` and `plugin_N` in separate namespaces, and a
    // fresh session has BOTH a `zellij:link` plugin pane with id 0 and a shell
    // terminal pane with id 0. Matching liveness on the bare integer therefore
    // kept reporting a closed sub-agent pane as alive — the artifact poller
    // would never see the child finish. Liveness must ignore plugin rows.
    const pane = await spawnPane(mux, "Kill child");
    expect(mux.getPaneLiveness(pane.paneId, pane.session)).toBe("alive");

    mux.killPane(pane.paneId, pane.session);
    await waitFor(
      () => mux.getPaneLiveness(pane.paneId, pane.session) === "dead",
      "pane never reported dead after killPane",
    );
    await expect(mux.observePane(pane.paneId, pane.session)).resolves.toEqual({
      kind: "dead",
    });
    expect(() => mux.killPane(pane.paneId, pane.session)).not.toThrow();
  });

  it("showNativeViewer declines when the process is not inside zellij", async () => {
    // The overlay surface needs an attached client; a background session has
    // none, so the honest answer is false rather than a lie plus a lost pane.
    delete process.env.ZELLIJ;
    await expect(mux.showNativeViewer("Agent", "bounded output")).resolves.toBe(
      false,
    );
  });

  it("buildAttachCommands emits commands the real CLI parses", async () => {
    const pane = await spawnPane(mux, "Attach child");
    const cmds = mux.buildAttachCommands({
      paneId: pane.paneId,
      windowName: pane.windowName,
      session: pane.session,
    });

    expect(cmds.attachCommand).toBe(`zellij attach '${pane.session}'`);
    expect(cmds.focusCommand).toBe(
      `zellij action go-to-tab-name '${pane.windowName}'`,
    );
    // Run the focus command's argv against the real session to prove the
    // subcommand and target still exist in this zellij version.
    expect(() =>
      execFileSync(
        "zellij",
        [
          "--session",
          pane.session!,
          "action",
          "go-to-tab-name",
          pane.windowName!,
        ],
        { stdio: "ignore", timeout: 10000 },
      ),
    ).not.toThrow();
  });

  it("declared capabilities match what the binary actually does", async () => {
    // M7: the capability record used to be unread, unverified metadata that
    // claimed `boundedCapture: true` while zellij capture was broken. Every
    // flag asserted here is exercised by a test above.
    expect(mux.capabilities).toEqual(MUX_CAPABILITIES.zellij);
    expect(mux.capabilities.boundedCapture).toBe(true);
    expect(mux.capabilities.structuredFocus).toBe(true);
    expect(mux.capabilities.nativeOverlay).toBe(true);
  });
});

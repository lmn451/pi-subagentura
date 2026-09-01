/**
 * Real-binary integration tests for the Herdr backend.
 *
 * Why this file exists: `tests/multiplexer-herdr.test.ts` mocks
 * `node:child_process` and `node:net` wholesale, so it verifies the argv and
 * the socket frames we BELIEVE Herdr accepts, never the ones Herdr ACTUALLY
 * accepts. `MUX_CAPABILITIES.herdr` claims `structuredFocus` and
 * `boundedCapture`, and a capability flag backed only by a mock is exactly how
 * the broken zellij `dump-screen` argv shipped with CI green — the mocked test
 * asserted the broken argv was correct while every real capture failed.
 *
 * These tests therefore pin Herdr's real contract for the operations the
 * overlay depends on: pane create, control-socket `pane.focus`, control-socket
 * `pane.read` bounding (including its trailing-newline behavior), flag-
 * terminated `pane send-text` delivery, liveness, and attach-command shape.
 *
 * Excluded from the default `test` script (see `package.json`); run via
 * `npm run test:herdr`. Skipped entirely when herdr is not installed or when
 * the process is not inside a Herdr-managed pane — Herdr control is
 * deliberately scoped to the session hosting this process, so unlike tmux and
 * zellij there is no relaxed-spawn path that can conjure a server.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrMultiplexer } from "../src/multiplexer-herdr";
import { MUX_CAPABILITIES } from "../src/multiplexer";

function herdrInstalled(): boolean {
  try {
    execFileSync("/bin/sh", ["-c", "command -v herdr"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Herdr's backend refuses to operate outside a Herdr-managed pane (no socket
 * path, no parent pane id), so the suite needs a live server AND membership in
 * it. Both markers come from the environment Herdr injects.
 */
const hasHerdr =
  herdrInstalled() &&
  process.env.HERDR_ENV === "1" &&
  !!process.env.HERDR_SOCKET_PATH &&
  !!process.env.HERDR_PANE_ID;

/** Panes created by the current test, torn down in afterEach. */
let panes: { paneId: string; session?: string }[] = [];
let tempRoot: string;
let spawnCounter = 0;

/**
 * Poll until `predicate` holds. The Herdr CLI is a client talking to a server
 * over a unix socket, so "the command returned" does not mean "the pane's
 * shell has produced output yet".
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
 * Create a background tab through the production code path and wait until the
 * pane is reported alive. Registered for teardown before the wait so a pane
 * that comes up slowly is still cleaned up.
 */
async function spawnPane(mux: HerdrMultiplexer, name: string) {
  const cwd = mkdtempSync(join(tempRoot, "ws-"));
  const created = mux.createPane({
    name,
    cwd,
    background: true,
    id: `it${process.pid}x${spawnCounter++}`,
  });
  panes.push({ paneId: created.paneId, session: created.session });
  await waitFor(
    () => mux.getPaneLiveness(created.paneId, created.session) === "alive",
    `pane ${created.paneId} never reported alive`,
  );
  return created;
}

describe.skipIf(!hasHerdr)("herdr backend against the real binary", () => {
  let mux: HerdrMultiplexer;

  beforeAll(() => {
    // Fail loudly rather than silently testing nothing if the guard regresses.
    expect(hasHerdr).toBe(true);
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-subagentura-herdr-"));
    panes = [];
    mux = new HerdrMultiplexer();
  });

  afterEach(() => {
    for (const pane of panes) mux.killPane(pane.paneId, pane.session);
    panes = [];
    rmSync(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("isAvailable finds the installed binary and the managed pane", () => {
    expect(mux.isAvailable()).toBe(true);
  });

  it("createPane makes a live, addressable pane with a stable terminal id", async () => {
    const pane = await spawnPane(mux, "Create child");

    expect(pane.session).toBe(process.env.HERDR_SOCKET_PATH);
    // The shape the pane-id guard enforces before any id reaches argv.
    expect(pane.paneId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
    expect(pane.muxTerminalId).toBeTruthy();
    // The unique sub-agent id must reach the tab label, or two same-named
    // agents present as two identical tabs.
    expect(pane.windowName).toContain("create-child");
    expect(pane.windowName).toContain(`it${process.pid}`);
    expect(mux.getPaneLiveness(pane.paneId, pane.session)).toBe("alive");
    await expect(
      mux.getPaneLivenessAsync(pane.paneId, pane.session),
    ).resolves.toBe("alive");
  });

  it("reports dead for an id the server never had", async () => {
    const pane = await spawnPane(mux, "Liveness child");
    expect(mux.getPaneLiveness("w999:p999", pane.session)).toBe("dead");
  });

  it("reports unknown activity without probing the server", async () => {
    // Herdr's focus is server-global and proves nothing about an attached
    // full UI client, so activity stays indeterminate by design.
    const pane = await spawnPane(mux, "Activity child");
    await expect(
      mux.getPaneActivityAsync(pane.paneId, pane.session),
    ).resolves.toBe("unknown");
    await expect(mux.hasAttachedClientAsync(pane.session)).resolves.toBe(
      undefined,
    );
  });

  it("focusPane reaches the pane through the control socket", async () => {
    // THE assertion behind `MUX_CAPABILITIES.herdr.structuredFocus`. The
    // socket reply is a typed `pane_info` echoing the pane's workspace and
    // tab, so a resolved focus really did resolve THIS pane — unlike zellij's
    // `go-to-tab-name`, which exits 0 for a tab that does not exist.
    const pane = await spawnPane(mux, "Focus child");

    await expect(
      mux.focusPane({ paneId: pane.paneId, session: pane.session }),
    ).resolves.toBeUndefined();
  });

  it("focusPane rejects for a pane id the server does not know", async () => {
    await expect(
      mux.focusPane({
        paneId: "w999:p999",
        session: process.env.HERDR_SOCKET_PATH,
      }),
    ).rejects.toThrow(/pane focus/);
  });

  it("capturePane reads real pane output through the control socket", async () => {
    const pane = await spawnPane(mux, "Capture child");
    const marker = `HERDR_CAPTURE_MARKER_${process.pid}`;

    mux.sendKeys(pane.paneId, `echo ${marker}`, pane.session);
    mux.sendEnter(pane.paneId, pane.session);

    let captured = "";
    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId, session: pane.session },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      captured = result.output;
      return captured.includes(marker);
    }, "timed out waiting for the marker to appear in pane.read output");

    expect(captured).toContain(marker);
  });

  it("capturePane honors maxLines and maxBytes bounds", async () => {
    // THE assertion behind `MUX_CAPABILITIES.herdr.boundedCapture`.
    const pane = await spawnPane(mux, "Bounded child");
    const marker = `HERDR_BOUND_MARKER_${process.pid}`;

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

  it("capturePane does not spend the truncation slot on Herdr's trailing newline", async () => {
    // Herdr terminates the last row with `\n`. Counted as a line it consumed
    // the `maxLines + 1` truncation-probe slot, so an exactly-`maxLines`
    // capture silently dropped its oldest real line and reported a truncation
    // that never happened. Pin the real server's framing, not the mock's.
    const pane = await spawnPane(mux, "Newline child");
    const marker = `HERDR_NEWLINE_MARKER_${process.pid}`;

    mux.sendKeys(pane.paneId, `printf '%s\\n' ${marker}`, pane.session);
    mux.sendEnter(pane.paneId, pane.session);
    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId, session: pane.session },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      return result.output.includes(marker);
    }, "timed out waiting for the trailing-newline marker");

    const full = await mux.capturePane(
      { paneId: pane.paneId, session: pane.session },
      { maxBytes: 64 * 1024, maxLines: 500 },
    );
    // No dangling empty final row: the single trailing newline is stripped
    // before bounding, so the last line carries real content.
    expect(full.output.endsWith("\n")).toBe(false);

    // Asking for exactly the number of lines present must return all of them,
    // not drop the oldest to make room for the terminator.
    const lines = full.output.split("\n");
    const exact = await mux.capturePane(
      { paneId: pane.paneId, session: pane.session },
      { maxBytes: 64 * 1024, maxLines: lines.length },
    );
    expect(exact.output.split("\n")).toHaveLength(lines.length);
  });

  it("sendKeys delivers text starting with a dash (flag terminator works)", async () => {
    // Without `--`, a leading-dash follow-up is parsed as a herdr flag and the
    // whole delivery fails: the agent silently never receives the message.
    const pane = await spawnPane(mux, "Dash child");
    const marker = `DASH_OK_${process.pid}`;

    expect(() =>
      mux.sendKeys(pane.paneId, `echo -n ${marker}`, pane.session),
    ).not.toThrow();
    // Leading-dash text as the very first character is the hostile case.
    expect(() =>
      mux.sendKeys(pane.paneId, "-not-a-flag", pane.session),
    ).not.toThrow();
    expect(() => mux.sendEnter(pane.paneId, pane.session)).not.toThrow();
  });

  it("buildAttachCommands emits a command the real CLI parses", async () => {
    const pane = await spawnPane(mux, "Attach child");
    const cmds = mux.buildAttachCommands({
      paneId: pane.paneId,
      terminalId: pane.muxTerminalId,
      session: pane.session,
    });

    expect(cmds.attachCommand).toContain("herdr terminal attach");
    expect(cmds.attachCommand).toContain(pane.muxTerminalId);
    expect(cmds.focusCommand).toBe(cmds.attachCommand);
    // Prove the subcommand and the terminal id still exist in this Herdr
    // version without actually taking over the test runner's terminal.
    expect(() =>
      execFileSync("herdr", ["terminal", "attach", "--help"], {
        stdio: "ignore",
        timeout: 10000,
      }),
    ).not.toThrow();
  });

  it("killPane removes the pane and is safe to repeat", async () => {
    const pane = await spawnPane(mux, "Kill child");
    expect(mux.getPaneLiveness(pane.paneId, pane.session)).toBe("alive");

    mux.killPane(pane.paneId, pane.session);
    await waitFor(
      () => mux.getPaneLiveness(pane.paneId, pane.session) === "dead",
      "pane never reported dead after killPane",
    );
    await expect(
      mux.getPaneLivenessAsync(pane.paneId, pane.session),
    ).resolves.toBe("dead");
    expect(() => mux.killPane(pane.paneId, pane.session)).not.toThrow();
  });

  it("showNativeViewer declines — Herdr has no generic overlay", async () => {
    await expect(mux.showNativeViewer("Agent", "bounded output")).resolves.toBe(
      false,
    );
  });

  it("declared capabilities match what the binary actually does", async () => {
    // The invariant on MUX_CAPABILITIES: every flag is asserted against the
    // real binary. `structuredFocus` is proven by the focusPane tests above,
    // `boundedCapture` by the capture tests, and `nativeOverlay: false` by
    // showNativeViewer declining.
    expect(mux.capabilities).toEqual(MUX_CAPABILITIES.herdr);
    expect(mux.capabilities.structuredFocus).toBe(true);
    expect(mux.capabilities.boundedCapture).toBe(true);
    expect(mux.capabilities.nativeOverlay).toBe(false);
  });
});

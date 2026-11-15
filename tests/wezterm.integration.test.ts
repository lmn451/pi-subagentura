import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WezTermMultiplexer } from "../src/multiplexer-wezterm";

const server = process.env.PI_SUBAGENTURA_TEST_WEZTERM_SOCKET;
const parentPane = process.env.PI_SUBAGENTURA_TEST_WEZTERM_PANE;

describe.skipIf(!server || !parentPane)("real WezTerm backend", () => {
  it("spawns, sends, captures, and kills without changing focus", async () => {
    const mux = new WezTermMultiplexer();
    const env = { ...process.env, WEZTERM_UNIX_SOCKET: server };
    const focusedPane = (): number | undefined => {
      const output = execFileSync(
        "wezterm",
        ["cli", "--no-auto-start", "list-clients", "--format", "json"],
        { encoding: "utf8", env },
      );
      return JSON.parse(output)[0]?.focused_pane_id;
    };
    const before = focusedPane();
    const child = mux.createPane({
      context: {
        kind: "attached",
        mux: "wezterm",
        paneId: parentPane!,
        server: server!,
      },
      name: "WezTerm test",
      cwd: process.cwd(),
      background: true,
    });
    try {
      expect(focusedPane()).toBe(before);
      expect(mux.getPaneLiveness(child.paneId, undefined, server)).toBe(
        "alive",
      );
      expect(
        await mux.getPaneActivityAsync(child.paneId, undefined, server),
      ).toBe("inactive");
      mux.sendKeys(child.paneId, "echo WEZTERM_BACKEND_OK", undefined, server);
      mux.sendEnter(child.paneId, undefined, server);
      let output = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        output = (
          await mux.capturePane(
            { paneId: child.paneId, server },
            { maxLines: 20, maxBytes: 2048 },
          )
        ).output;
        if (output.split("WEZTERM_BACKEND_OK").length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        output.split("WEZTERM_BACKEND_OK").length,
        output,
      ).toBeGreaterThanOrEqual(3);
      const split = mux.createPane({
        context: {
          kind: "attached",
          mux: "wezterm",
          paneId: child.paneId,
          server: server!,
        },
        name: "WezTerm split test",
        cwd: process.cwd(),
        background: false,
      });
      try {
        expect(mux.getPaneLiveness(split.paneId, undefined, server)).toBe(
          "alive",
        );
      } finally {
        mux.killPane(split.paneId, undefined, server);
      }
    } finally {
      mux.killPane(child.paneId, undefined, server);
    }
    expect(mux.getPaneLiveness(child.paneId, undefined, server)).toBe("dead");
    expect(focusedPane()).toBe(before);
  });
});

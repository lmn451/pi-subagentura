import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { requestHerdrCore } from "../src/herdr-core-rpc.mjs";
import { HerdrCoreMultiplexer } from "../src/multiplexer-herdr-core";
import { shellEscape } from "../src/multiplexer-contracts";

// Opt in only with the endpoint of a separately launched, isolated test core.
it.skipIf(!process.env.HERDR_CORE_TEST_SOCKET)(
  "runs the real terminal lifecycle with literal input and separate Enter",
  async () => {
    const server = process.env.HERDR_CORE_TEST_SOCKET!;
    mkdirSync(".context", { recursive: true });
    const directory = mkdtempSync(resolve(".context/hc-integration-"));
    const output = join(directory, "output");
    const mux = new HerdrCoreMultiplexer();
    let child: string | undefined;
    const parent = await requestHerdrCore(server, "terminal.run", {
      argv: ["bash", "--noprofile", "--norc", "-i"],
      no_parent: true,
      no_notify: true,
    });
    const parentId = parent.address as string;
    try {
      const created = mux.createPane({
        context: {
          kind: "attached",
          mux: "herdr-core",
          paneId: parentId,
          server,
        },
        name: "integration",
        cwd: directory,
        background: true,
      });
      child = created.paneId;
      expect(mux.getPaneLiveness(child, undefined, server)).toBe("alive");
      expect(await mux.getPaneLivenessAsync(child, undefined, server)).toBe(
        "alive",
      );
      mux.sendKeys(
        child,
        `printf '%s' 'héllo 世界 👋' > ${shellEscape(output)}; printf 'visible-output'; exit`,
        undefined,
        server,
      );
      expect(existsSync(output)).toBe(false);
      mux.sendEnter(child, undefined, server);
      await requestHerdrCore(server, "terminal.wait", {
        terminal: child,
        timeout: 3,
      });
      expect(readFileSync(output, "utf8")).toBe("héllo 世界 👋");
      expect(mux.getPaneLiveness(child, undefined, server)).toBe("dead");
      const capture = await mux.capturePane(
        { paneId: child, server },
        { maxLines: 10, maxBytes: 1000 },
      );
      expect(capture.output).toContain("visible-output");
      mux.killPane(parentId, undefined, server);
      expect(await mux.getPaneLivenessAsync(parentId, undefined, server)).toBe(
        "dead",
      );
    } finally {
      for (const id of [child, parentId]) {
        if (!id) continue;
        mux.killPane(id, undefined, server);
        await requestHerdrCore(server, "terminal.rm", { terminal: id });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

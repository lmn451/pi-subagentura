import { afterEach, expect, it, vi } from "vitest";
import { TmuxMultiplexer } from "../src/multiplexer-tmux";
import { ZellijMultiplexer } from "../src/multiplexer-zellij";
import { HerdrMultiplexer } from "../src/multiplexer-herdr";
import { RexMultiplexer } from "../src/multiplexer-rex";
import { resolveMux, getMux, __resetMuxInstances } from "../src/multiplexer";
const { exec, discover, asyncExec } = vi.hoisted(() => ({
  exec: vi.fn(),
  discover: vi.fn(),
  asyncExec: vi.fn(() => {
    throw new Error("unexpected async boundary");
  }),
}));
vi.mock("../src/multiplexer-current-context", () => ({
  resolveCurrentMuxContext: discover,
}));
vi.mock("node:net", () => ({
  createConnection: vi.fn(() => {
    throw new Error("unexpected socket boundary");
  }),
}));
vi.mock("node:child_process", () => ({
  execFileSync: exec,
  execFile: asyncExec,
  spawn: vi.fn(() => {
    throw new Error("unexpected spawn boundary");
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  exec.mockReset();
  asyncExec.mockReset();
  asyncExec.mockImplementation(() => {
    throw new Error("unexpected async boundary");
  });
  discover.mockReset();
  __resetMuxInstances();
});

it("routes rehydrated tmux references and scopes liveness caches by server", async () => {
  const server = "/persisted # socket ";
  vi.stubEnv("PI_SUBAGENTURA_TMUX_SOCKET", "stale");
  exec.mockImplementation((command, args) => {
    if (command === "tmux" && args[0] === "-S" && args[1] === server)
      return args.includes("display-message") ? "work\t0\t1" : "%8\n";
    throw new Error(`unexpected sync boundary ${command} ${args}`);
  });
  asyncExec.mockImplementation(((
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: null, output: string) => void,
  ) => {
    if (
      command !== "tmux" ||
      args[0] !== "-S" ||
      ![server, "/other.sock"].includes(args[1])
    )
      throw new Error("unexpected async route");
    const output = args.includes("list-panes")
      ? "%8\n"
      : args.includes("list-sessions")
        ? "work\n"
        : args.includes("list-clients")
          ? "client\n"
          : args.includes("display-message")
            ? "1\t1\t0\n"
            : "output";
    callback(null, output);
  }) as never);
  const adapter = getMux({ preference: "tmux" }) as TmuxMultiplexer;
  adapter.sendEnter("%8", "work", server);
  expect(adapter.getPaneLiveness("%8", "work", server)).toBe("alive");
  expect(await adapter.getPaneLivenessAsync("%8", "work", server)).toBe(
    "alive",
  );
  expect(await adapter.getPaneLivenessAsync("%8", "work", "/other.sock")).toBe(
    "alive",
  );
  expect(
    asyncExec.mock.calls.filter((call) =>
      (call as unknown as [string, string[]])[1].includes("list-panes"),
    ),
  ).toHaveLength(2);
  expect(await adapter.getPaneActivityAsync("%8", "work", server)).toBe(
    "active",
  );
  expect(await adapter.hasAttachedClientAsync("work", server)).toBe(true);
  const ref = { paneId: "%8", session: "work", server };
  await adapter.focusPane(ref);
  await adapter.capturePane(ref, { maxLines: 10, maxBytes: 100 });
  expect(adapter.buildAttachCommands(ref).attachCommand).toContain(
    "'/persisted # socket '",
  );
});
it("keeps a resolved tmux server and parent when inherited env changes", () => {
  vi.stubEnv("TMUX", "");
  vi.stubEnv("TMUX_PANE", "%999");
  vi.stubEnv("PI_SUBAGENTURA_TMUX_SOCKET", "contradictory");
  exec.mockImplementation((command, args) => {
    if (command === "/bin/sh") return "/mock/tmux";
    if (command !== "tmux") throw new Error("unexpected command");
    if (args.includes("split-window")) return "%8";
    if (args.includes("display-message")) return "work\t0\t1";
    if (args.includes("select-pane")) return "";
    throw new Error(`unexpected boundary ${args.join(" ")}`);
  });
  new TmuxMultiplexer().createPane({
    name: "child",
    cwd: "/mock",
    background: false,
    context: {
      kind: "attached",
      mux: "tmux",
      paneId: "%7",
      server: "/verified.sock",
    },
  });
  expect(exec).toHaveBeenCalledWith(
    "tmux",
    expect.arrayContaining([
      "-S",
      "/verified.sock",
      "split-window",
      "-t",
      "%7",
    ]),
    expect.anything(),
  );
});
it.each([TmuxMultiplexer, ZellijMultiplexer, HerdrMultiplexer, RexMultiplexer])(
  "rejects backend context mismatch before any boundary",
  (Backend) => {
    const backend = new Backend();
    expect(() =>
      backend.createPane({
        name: "child",
        cwd: "/mock",
        background: true,
        context: {
          kind: "detached",
          mux: backend.name === "tmux" ? "zellij" : "tmux",
        },
      } as never),
    ).toThrow(/context/i);
    expect(exec).not.toHaveBeenCalled();
  },
);

it("carries automatic discovery into createPane without rereading env", () => {
  const target = { mux: "tmux", paneId: "%7", server: "/verified.sock" };
  discover.mockReturnValue({ kind: "ready", target });
  const resolved = resolveMux();
  expect(Object.isFrozen(resolved.context)).toBe(true);
  target.paneId = "%999";
  vi.stubEnv("TMUX", "");
  vi.stubEnv("PI_SUBAGENTURA_TMUX_SOCKET", "stale");
  exec.mockImplementation((command, args) => {
    if (command === "/bin/sh") return "";
    if (command === "tmux" && args.includes("new-window")) return "%8";
    if (command === "tmux" && args.includes("display-message"))
      return "work\t0\t1";
    throw new Error(`unexpected boundary ${command} ${args}`);
  });
  resolved.adapter.createPane({
    name: "child",
    cwd: "/mock",
    background: true,
    context: resolved.context,
  });
  expect(discover).toHaveBeenCalledOnce();
  expect(exec).toHaveBeenCalledWith(
    "tmux",
    expect.arrayContaining(["-S", "/verified.sock", "new-window", "-t", "%7"]),
    expect.anything(),
  );
});

it.each(["tmux", "zellij"] as const)(
  "keeps explicit detached %s overrides independent of discovery",
  (preference) => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("ZELLIJ", "");
    const resolved = resolveMux({ preference });
    expect(resolved.context).toMatchObject({
      kind: "detached",
      mux: preference,
    });
    expect(discover).not.toHaveBeenCalled();
  },
);

it.each(["/verified # socket ", "/verified socket"])(
  "persists actual socket %s and routes later compatibility operations",
  (server) => {
    discover.mockReturnValue({
      kind: "ready",
      target: {
        mux: "tmux",
        paneId: "%7",
        server,
        socketName: "contradictory",
      },
    });
    const resolved = resolveMux();
    exec.mockImplementation((command, args) => {
      if (command === "/bin/sh") return "";
      if (command === "tmux" && args.includes("new-window")) return "%8";
      if (command === "tmux" && args.includes("display-message"))
        return "work\t0\t1";
      if (
        command === "tmux" &&
        (args.includes("send-keys") || args.includes("kill-pane"))
      )
        return "";
      throw new Error(`unexpected boundary ${command} ${args}`);
    });
    const created = resolved.adapter.createPane({
      name: "child",
      cwd: "/mock",
      background: true,
      context: resolved.context,
    });
    expect(created.server).toBe(server);
    __resetMuxInstances();
    vi.stubEnv("PI_SUBAGENTURA_TMUX_SOCKET", "stale");
    getMux({ preference: "tmux" }).sendKeys(
      created.paneId,
      "followup",
      created.session,
      created.server,
    );
    getMux({ preference: "tmux" }).killPane(
      created.paneId,
      created.session,
      created.server,
    );
    const calls = exec.mock.calls.filter(([command]) => command === "tmux");
    expect(
      calls.every(([, args]) => args[0] === "-S" && args[1] === server),
    ).toBe(true);
  },
);

it("reuses detached sessions across fresh resolved adapters", () => {
  discover.mockReturnValue({ kind: "absent" });
  vi.stubEnv("PI_SUBAGENTURA_TMUX_SOCKET", "");
  exec.mockImplementation((command, args) => {
    if (command === "/bin/sh") return "";
    if (
      command === "tmux" &&
      (args.includes("new-session") || args.includes("new-window"))
    )
      return "%8";
    if (command === "tmux" && args.includes("has-session")) return "";
    if (command === "tmux" && args.includes("display-message"))
      return "/actual.sock";
    throw new Error(`unexpected boundary ${command} ${args}`);
  });
  const first = resolveMux();
  const second = resolveMux();
  const create = (resolved: typeof first, id: string) =>
    resolved.adapter.createPane({
      name: "child",
      id,
      cwd: "/mock",
      background: true,
      context: resolved.context,
    });
  expect(create(first, "first").session).toBe("pi-subagent-first");
  expect(create(second, "second").session).toBe("pi-subagent-first");
  expect(
    exec.mock.calls.filter(([, args]) => args.includes("new-session")),
  ).toHaveLength(1);
});

it.each([true, false])(
  "preserves detached tmux then Zellij fallback (tmux=%s)",
  (tmuxAvailable) => {
    discover.mockReturnValue({ kind: "absent" });
    exec.mockImplementation((command, args) => {
      if (command !== "/bin/sh") throw new Error("unexpected mutation");
      if (!tmuxAvailable && args[1].includes("'tmux'"))
        throw new Error("missing tmux");
      return "";
    });
    expect(resolveMux().context).toMatchObject({
      kind: "detached",
      mux: tmuxAvailable ? "tmux" : "zellij",
    });
  },
);

it("keeps the captured Rex server, session and block without a second whoami", () => {
  const session = "session:01234567-89ab-cdef-0123-456789abcdef";
  const paneId = "block:01234567-89ab-cdef-0123-456789abcdef";
  const server = "unix:///verified.sock";
  discover.mockReturnValue({
    kind: "ready",
    target: { mux: "rex", paneId, session, server },
  });
  const resolved = resolveMux();
  vi.stubEnv("REX_SESSION", "stale");
  vi.stubEnv("REX_SERVER", "unix:///stale.sock");
  vi.stubEnv("REX_BLOCK", "stale");
  exec.mockImplementation((command, args) => {
    if (command === "rex" && args.includes("run"))
      return JSON.stringify({ block_ids: [paneId] });
    throw new Error(`unexpected boundary ${command} ${args}`);
  });
  expect(
    resolved.adapter.createPane({
      name: "child",
      cwd: "/mock",
      background: false,
      context: resolved.context,
    }),
  ).toMatchObject({ session, server });
  expect(exec).toHaveBeenCalledOnce();
  expect(exec).toHaveBeenCalledWith(
    "rex",
    expect.arrayContaining([server, "--session", session, "--block", paneId]),
    expect.anything(),
  );
});

it("keeps the captured Herdr socket and parent pane", () => {
  discover.mockReturnValue({
    kind: "ready",
    target: { mux: "herdr", paneId: "w1:p2", session: "/verified.sock" },
  });
  const resolved = resolveMux();
  vi.stubEnv("HERDR_ENV", "0");
  vi.stubEnv("HERDR_SOCKET_PATH", "/stale.sock");
  vi.stubEnv("HERDR_PANE_ID", "stale");
  exec.mockImplementation((command, args) => {
    if (command === "/bin/sh") return "";
    if (command === "herdr" && args.includes("split"))
      return JSON.stringify({
        result: { pane: { pane_id: "w1:p3", terminal_id: "terminal-3" } },
      });
    throw new Error(`unexpected boundary ${command} ${args}`);
  });
  expect(
    resolved.adapter.createPane({
      name: "child",
      cwd: "/mock",
      background: false,
      context: resolved.context,
    }),
  ).toMatchObject({ session: "/verified.sock" });
  expect(exec).toHaveBeenCalledWith(
    "herdr",
    expect.arrayContaining(["split", "w1:p2"]),
    expect.objectContaining({
      env: expect.objectContaining({ HERDR_SOCKET_PATH: "/verified.sock" }),
    }),
  );
});

it("keeps the captured Zellij session after detachment markers change", () => {
  discover.mockReturnValue({
    kind: "ready",
    target: { mux: "zellij", paneId: "1", session: "verified" },
  });
  const resolved = resolveMux();
  vi.stubEnv("ZELLIJ", "");
  vi.stubEnv("ZELLIJ_SESSION_NAME", "stale");
  let listing = 0;
  exec.mockImplementation((command, args) => {
    if (command === "/bin/sh") return "";
    if (
      command === "zellij" &&
      args[0] === "--session" &&
      args[1] === "verified"
    ) {
      if (args.includes("list-panes"))
        return JSON.stringify(
          ++listing === 1 ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }],
        );
      if (args.includes("new-pane")) return "";
    }
    throw new Error(`unexpected boundary ${command} ${args}`);
  });
  expect(
    resolved.adapter.createPane({
      name: "child",
      cwd: "/mock",
      background: false,
      context: resolved.context,
    }),
  ).toMatchObject({ session: "verified", paneId: "2" });
});

it.each(["tmux", "zellij"] as const)(
  "launches detached %s despite newly inherited markers",
  (preference) => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("ZELLIJ", "");
    vi.stubEnv("PI_SUBAGENTURA_TMUX_SOCKET", "");
    const resolved = resolveMux({ preference });
    vi.stubEnv("TMUX", "/stale.sock,1,0");
    vi.stubEnv("TMUX_PANE", "%999");
    vi.stubEnv("ZELLIJ", "0");
    vi.stubEnv("ZELLIJ_SESSION_NAME", "stale");
    let listing = 0;
    exec.mockImplementation((command, args) => {
      if (command === "/bin/sh") return "";
      if (command === "tmux" && args[0] === "new-session") return "%8";
      if (command === "tmux" && args.includes("#{socket_path}"))
        return "/actual # socket \n";
      if (command === "zellij") {
        if (args[0] === "attach" && args[2] === "pi-subagent-abc") return "";
        if (args[0] === "--session" && args[1] === "pi-subagent-abc") {
          if (args.includes("list-panes"))
            return JSON.stringify(++listing === 1 ? [] : [{ id: 2 }]);
          if (args.includes("new-tab")) return "";
        }
      }
      throw new Error(`unexpected boundary ${command} ${args}`);
    });
    expect(
      resolved.adapter.createPane({
        name: "child",
        id: "abc",
        cwd: "/mock",
        background: false,
        context: resolved.context,
      }),
    ).toMatchObject({ session: "pi-subagent-abc" });
  },
);

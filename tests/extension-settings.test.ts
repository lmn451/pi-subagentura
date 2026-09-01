import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerSettingsPanel from "@juanibiapina/pi-extension-settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import {
  HIDE_AGENT_LIST_FLAG,
  isAgentListHidden,
  MAX_DEPTH_FLAG,
  readExtensionSettings,
  type ExtensionSettings,
  type InvalidSettingReporter,
} from "../src/settings";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";
import {
  clearSessionScopes,
  getActiveSessionScopeId,
  getSessionScopes,
} from "../src/session-scope";

interface SettingsSandbox {
  root: string;
  cwd: string;
  agentDir: string;
}

function makeSettingsSandbox(): SettingsSandbox {
  const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

let settingsSandbox!: SettingsSandbox;
let previousAgentDir: string | undefined;

function readTestSettings(
  pi: Parameters<typeof readExtensionSettings>[0],
  onInvalidSetting?: InvalidSettingReporter,
): ExtensionSettings {
  return readExtensionSettings(
    pi,
    {
      cwd: settingsSandbox.cwd,
      agentDir: settingsSandbox.agentDir,
    },
    onInvalidSetting,
  );
}

function sharedEventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    emit: vi.fn((name: string, data: unknown) => {
      for (const handler of handlers.get(name) ?? []) handler(data);
    }),
    on: vi.fn((name: string, handler: (data: unknown) => void) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
  };
}

function mockApi(
  getFlag: (name: string) => unknown = () => undefined,
  events = sharedEventBus(),
) {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn(getFlag),
    on: vi.fn(),
    events,
  };
}

function registeredTools(api: ReturnType<typeof mockApi>): string[] {
  return api.registerTool.mock.calls.map(([tool]: any[]) => tool.name);
}

describe("generic extension settings", () => {
  beforeEach(() => {
    settingsSandbox = makeSettingsSandbox();
    vi.spyOn(process, "cwd").mockReturnValue(
      join(settingsSandbox.root, "ambient"),
    );
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = settingsSandbox.agentDir;
  });

  afterEach(() => {
    clearSessionScopes();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    vi.restoreAllMocks();
    rmSync(settingsSandbox.root, { recursive: true, force: true });
  });

  it("registers validated settings with V2-safe defaults", () => {
    const api = mockApi();
    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith(MAX_DEPTH_FLAG, {
      description: expect.stringContaining("Orchestratorv2"),
      type: "string",
    });
    expect(api.registerFlag).toHaveBeenCalledWith(HIDE_AGENT_LIST_FLAG, {
      description: expect.stringContaining("activity widget"),
      type: "boolean",
      default: false,
    });
    expect(api.events.emit).toHaveBeenCalledWith(
      "pi-extension-settings:register",
      {
        name: "pi-subagentura",
        settings: [
          {
            id: "max-depth",
            label: "Maximum depth",
            description: expect.stringContaining("0-64"),
            defaultValue: "2",
          },
          {
            id: "hide-agent-list",
            label: "Hide agent list",
            description: expect.stringContaining("activity widget"),
            defaultValue: "false",
            values: ["false", "true"],
          },
        ],
      },
    );
    const flagDescription = (name: string): string =>
      api.registerFlag.mock.calls.find(([flag]) => flag === name)?.[1]
        .description ?? "";
    // registerFlag no longer supplies a default, so the text must not claim one.
    expect(flagDescription(MAX_DEPTH_FLAG)).not.toMatch(/default/i);
    // The boolean flag is on-only; say so where operators read it.
    expect(flagDescription(HIDE_AGENT_LIST_FLAG)).toMatch(
      /cannot override a persisted/i,
    );

    expect(readTestSettings(api as any)).toEqual({
      maxDepth: 2,
      hideAgentList: false,
    });
  });

  it("depends on the settings helpers without autoloading the panel", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(manifest.dependencies).toMatchObject({
      "@juanibiapina/pi-extension-settings": "^0.9.1",
    });
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.pi.extensions).toEqual(["./src/subagent.ts"]);
  });

  it.each([
    ["panel before consumer", true],
    ["panel after consumer", false],
  ])("registers a non-empty schema with the %s", async (_name, panelFirst) => {
    const events = sharedEventBus();
    const panelApi = mockApi(() => undefined, events);
    const sessionHandlers = new Map<string, Function[]>();
    const rootApi = {
      ...mockApi(() => false, events),
      on: vi.fn((name: string, handler: Function) => {
        const registered = sessionHandlers.get(name) ?? [];
        registered.push(handler);
        sessionHandlers.set(name, registered);
      }),
    };

    if (panelFirst) registerSettingsPanel(panelApi as any);
    registerExtension(rootApi as any);
    if (!panelFirst) registerSettingsPanel(panelApi as any);

    const ctx = {
      cwd: settingsSandbox.cwd,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => undefined,
        getEntries: () => [],
        getBranch: () => [],
      },
      isIdle: () => true,
    };
    for (const handler of sessionHandlers.get("session_start") ?? []) {
      await handler({ reason: "new" }, ctx);
    }

    const panelCommands = panelApi.registerCommand.mock.calls.filter(
      ([name]) =>
        name === "extension-settings" || name === "extension-settings-local",
    );
    expect(panelCommands.map(([name]) => name)).toEqual([
      "extension-settings",
      "extension-settings-local",
    ]);

    const notify = vi.fn();
    const custom = vi.fn(async () => undefined);
    const globalCommand = panelCommands.find(
      ([name]) => name === "extension-settings",
    )?.[1];
    await globalCommand.handler("", { ui: { notify, custom } });
    expect(notify).not.toHaveBeenCalled();
    expect(custom).toHaveBeenCalledOnce();
  });

  it("reads global settings and lets a project override max-depth only", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    try {
      writeFileSync(
        join(agentDir, "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": {
            "max-depth": "5",
            "hide-agent-list": "true",
          },
        }),
      );
      expect(
        readExtensionSettings(mockApi() as any, { agentDir, cwd }),
      ).toEqual({ maxDepth: 5, hideAgentList: true });

      writeFileSync(
        join(cwd, ".pi", "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": {
            "max-depth": "3",
            "hide-agent-list": "false",
          },
        }),
      );
      // max-depth follows the project; hide-agent-list stays global-only.
      expect(
        readExtensionSettings(mockApi() as any, { agentDir, cwd }),
      ).toEqual({ maxDepth: 3, hideAgentList: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a repo-controlled project-local hide-agent-list", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    try {
      writeFileSync(
        join(cwd, ".pi", "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "hide-agent-list": "true" },
        }),
      );

      expect(
        readExtensionSettings(mockApi() as any, { agentDir, cwd }),
      ).toMatchObject({ hideAgentList: false });
      expect(isAgentListHidden(mockApi() as any, { agentDir, cwd })).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the global file when no session cwd is known", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const ambientCwd = join(root, "ambient");
    mkdirSync(join(ambientCwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(ambientCwd);

    try {
      writeFileSync(
        join(agentDir, "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "max-depth": "5" },
        }),
      );
      // The ambient process cwd must not leak into a cwd-less read.
      writeFileSync(
        join(ambientCwd, ".pi", "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "max-depth": "9" },
        }),
      );

      expect(readExtensionSettings(mockApi() as any, { agentDir })).toEqual({
        maxDepth: 5,
        hideAgentList: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the CLI max-depth flag override the persisted setting", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });

    try {
      writeFileSync(
        join(agentDir, "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "max-depth": "6" },
        }),
      );
      const api = mockApi((name) =>
        name === MAX_DEPTH_FLAG ? "4" : undefined,
      );
      expect(
        readExtensionSettings(api as any, { agentDir, cwd }),
      ).toMatchObject({ maxDepth: 4 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the legacy flag force a persisted false setting on for one run", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });

    try {
      writeFileSync(
        join(agentDir, "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "hide-agent-list": "false" },
        }),
      );
      const api = mockApi((name) =>
        name === HIDE_AGENT_LIST_FLAG ? true : undefined,
      );
      expect(
        readExtensionSettings(api as any, { agentDir, cwd }),
      ).toMatchObject({ hideAgentList: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["", "-1", "1.5", "nope", "65", true])(
    "rejects invalid max depth %p",
    (value) => {
      const api = mockApi((name) =>
        name === MAX_DEPTH_FLAG ? value : undefined,
      );
      expect(() => readTestSettings(api as any)).toThrow(/max depth/i);
    },
  );

  it.each(["", "-1", "1.5", "nope", "65"])(
    "degrades a malformed persisted max-depth %p to the default",
    (value) => {
      const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      mkdirSync(agentDir, { recursive: true });

      try {
        writeFileSync(
          join(agentDir, "settings-extensions.json"),
          JSON.stringify({
            "pi-subagentura": { "max-depth": value },
          }),
        );
        const onInvalid = vi.fn();
        expect(
          readExtensionSettings(mockApi() as any, { agentDir, cwd }, onInvalid),
        ).toEqual({ maxDepth: 2, hideAgentList: false });
        expect(onInvalid).toHaveBeenCalledWith(
          expect.stringContaining("max-depth"),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("degrades a malformed persisted hide-agent-list to false", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });

    try {
      writeFileSync(
        join(agentDir, "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "hide-agent-list": "yes please" },
        }),
      );
      const onInvalid = vi.fn();
      expect(
        readExtensionSettings(mockApi() as any, { agentDir, cwd }, onInvalid),
      ).toEqual({ maxDepth: 2, hideAgentList: false });
      expect(onInvalid).toHaveBeenCalledWith(
        expect.stringContaining("hide-agent-list"),
      );
      expect(isAgentListHidden(mockApi() as any, { agentDir, cwd })).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates a malformed persisted hide-agent-list even when the flag is set", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });

    try {
      writeFileSync(
        join(agentDir, "settings-extensions.json"),
        JSON.stringify({
          "pi-subagentura": { "hide-agent-list": "yes please" },
        }),
      );
      const api = mockApi((name) =>
        name === HIDE_AGENT_LIST_FLAG ? true : undefined,
      );
      const onInvalid = vi.fn();
      // The flag wins, but the persisted value is still parsed and reported.
      expect(
        readExtensionSettings(api as any, { agentDir, cwd }, onInvalid),
      ).toMatchObject({ hideAgentList: true });
      expect(onInvalid).toHaveBeenCalledWith(
        expect.stringContaining("hide-agent-list"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a top-level null", "null"],
    ["a primitive extension value", '{"pi-subagentura":"bad"}'],
  ])(
    "falls back to defaults and reports structurally malformed settings (%s)",
    (_description, settingsDocument) => {
      writeFileSync(
        join(settingsSandbox.agentDir, "settings-extensions.json"),
        settingsDocument,
      );
      const onInvalid = vi.fn();
      let settings: ExtensionSettings | undefined;

      expect(() => {
        settings = readTestSettings(
          mockApi() as unknown as Parameters<typeof readExtensionSettings>[0],
          onInvalid,
        );
      }).not.toThrow();
      expect(settings).toEqual({
        maxDepth: 2,
        hideAgentList: false,
      });
      expect(onInvalid).toHaveBeenCalledWith(
        expect.stringContaining("max-depth"),
      );
      expect(onInvalid).toHaveBeenCalledWith(
        expect.stringContaining("hide-agent-list"),
      );
    },
  );

  it.each([
    [
      "malformed values",
      JSON.stringify({
        "pi-subagentura": {
          "max-depth": "not-a-number",
          "hide-agent-list": "sometimes",
        },
      }),
    ],
    ["a top-level null", "null"],
    ["a primitive extension value", '{"pi-subagentura":"bad"}'],
  ])(
    "keeps session_start functional when persisted settings are %s",
    (_description, settingsDocument) => {
      writeFileSync(
        join(settingsSandbox.agentDir, "settings-extensions.json"),
        settingsDocument,
      );

      const handlers = new Map<string, Function[]>();
      const api = {
        ...mockApi((name) => name === "orchestratorv2"),
        on: vi.fn((name: string, handler: Function) => {
          const registered = handlers.get(name) ?? [];
          registered.push(handler);
          handlers.set(name, registered);
        }),
      };
      const extensionApi = api as unknown as Parameters<
        typeof registerExtension
      >[0];
      registerExtension(extensionApi);

      const notify = vi.fn();
      const ctx = {
        cwd: settingsSandbox.cwd,
        ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify },
        sessionManager: {
          getSessionId: () => "malformed-settings-session",
          getEntries: () => [],
          getBranch: () => [],
        },
      };

      expect(() =>
        handlers.get("session_start")![0]({ reason: "startup" }, ctx),
      ).not.toThrow();

      const scope = getSessionScopes().find(
        (candidate) => candidate.pi === extensionApi,
      );
      // Init completed past the settings read: scope registered and live.
      expect(scope?.lifecycle).toBe("started");
      expect(scope?.ui).toBe(ctx.ui);
      expect(scope?.spawnTreeContext).toMatchObject({
        role: "root",
        maxDepth: 2,
      });
      expect(getActiveSessionScopeId()).toBe(scope?.id);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("max-depth"),
        "warning",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("hide-agent-list"),
        "warning",
      );

      handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    },
  );

  it("rejects invalid hide-agent-list values", () => {
    const api = mockApi((name) =>
      name === HIDE_AGENT_LIST_FLAG ? "true" : undefined,
    );
    expect(() => readTestSettings(api as any)).toThrow(/hide agent list/i);
  });

  it("uses the configured depth only for V2 roots", () => {
    const api = mockApi((name) => (name === MAX_DEPTH_FLAG ? "4" : undefined));
    const settings = readTestSettings(api as any);

    expect(
      createRootSpawnTreeContext("v2", "/tmp", false, true, settings.maxDepth)
        .maxDepth,
    ).toBe(4);
    expect(
      createRootSpawnTreeContext(
        "legacy",
        "/tmp",
        true,
        false,
        settings.maxDepth,
      ).maxDepth,
    ).toBe(8);
  });

  it("honors a CLI max-depth override applied before session_start", () => {
    const flags = new Map<string, unknown>();
    const handlers = new Map<string, Function[]>();
    const api = {
      ...mockApi(),
      registerFlag: vi.fn((name: string, options: { default?: unknown }) => {
        flags.set(name, options.default);
      }),
      getFlag: vi.fn((name: string) => flags.get(name)),
      on: vi.fn((name: string, handler: Function) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      }),
    };

    const extensionApi = api as unknown as Parameters<
      typeof registerExtension
    >[0];
    registerExtension(extensionApi);
    expect(flags.get(MAX_DEPTH_FLAG)).toBeUndefined();

    flags.set(MAX_DEPTH_FLAG, "4");
    flags.set("orchestratorv2", true);
    const ctx = {
      cwd: settingsSandbox.cwd,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => "late-depth-session",
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    handlers.get("session_start")![0]({ reason: "startup" }, ctx);

    const scope = getSessionScopes().find(
      (candidate) => candidate.pi === extensionApi,
    );
    expect(scope?.spawnTreeContext).toMatchObject({
      role: "root",
      maxDepth: 4,
    });

    handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
  });

  it("resolves max-depth from the resumed session cwd", () => {
    expect(settingsSandbox.cwd).not.toBe(process.cwd());
    writeFileSync(
      join(settingsSandbox.cwd, ".pi", "settings-extensions.json"),
      JSON.stringify({
        "pi-subagentura": { "max-depth": "7" },
      }),
    );

    const handlers = new Map<string, Function[]>();
    const api = {
      ...mockApi((name) => name === "orchestratorv2"),
      on: vi.fn((name: string, handler: Function) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      }),
    };
    const extensionApi = api as unknown as Parameters<
      typeof registerExtension
    >[0];
    registerExtension(extensionApi);

    const ctx = {
      cwd: settingsSandbox.cwd,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => "resumed-project-session",
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    handlers.get("session_start")![0]({ reason: "resume" }, ctx);

    const scope = getSessionScopes().find(
      (candidate) => candidate.pi === extensionApi,
    );
    expect(scope?.spawnTreeContext).toMatchObject({
      role: "root",
      maxDepth: 7,
    });

    handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
  });

  it("keeps list/status tools and the visual supervisor available when the widget is hidden", () => {
    const api = mockApi((name) =>
      name === HIDE_AGENT_LIST_FLAG ? true : undefined,
    );
    registerExtension(api as any);
    const tools = registeredTools(api);

    expect(tools).toContain("list_orchestrator_agents");
    expect(tools).toContain("list_subagent_artifacts");
    expect(tools).toContain("get_interactive_subagent_status");
    expect(tools).toContain("subagent_interactive");
    expect(tools).toContain("cancel_interactive_subagent");
    expect(tools).toContain("read_subagent_artifact");
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.anything(),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.anything(),
    );
  });

  it("preserves list tools and visual supervisor visibility by default", () => {
    const api = mockApi();
    registerExtension(api as any);
    const tools = registeredTools(api);

    expect(tools).toContain("list_orchestrator_agents");
    expect(tools).toContain("list_subagent_artifacts");
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.anything(),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.anything(),
    );
  });
});

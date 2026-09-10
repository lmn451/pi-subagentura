import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { registerToolWithDefaultGuidance } from "../src/tool-guidance";
import {
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
} from "../src/session-scope";
import { createTelemetrySession } from "../src/telemetry";
import { TELEMETRY_OPERATION_NAMES } from "../src/telemetry";
import {
  registerCommandWithTelemetry,
  registerShortcutWithTelemetry,
} from "../src/telemetry-operations";
import registerExtension from "../src/subagent";

describe("operation telemetry", () => {
  const payloads: any[] = [];

  beforeEach(() => {
    clearSessionScopes();
    payloads.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        payloads.push(JSON.parse(init.body));
        return Promise.resolve(new Response(null));
      }),
    );
  });

  afterEach(() => {
    clearSessionScopes();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function registration(enabled = true) {
    const pi = { registerTool: vi.fn() } as any;
    const scope = createSessionScope(pi);
    scope.lifecycle = "started";
    scope.telemetry = createTelemetrySession(enabled);
    registerSessionScope(scope);
    return { pi, scope };
  }

  function tool(pi: any, execute: any, name = "save_workflow") {
    registerToolWithDefaultGuidance(pi, {
      name,
      label: "Test",
      description: "Test",
      parameters: Type.Object({}),
      execute,
    });
    return pi.registerTool.mock.lastCall[0];
  }

  it("records call boundaries and elapsed time without inspecting content or arguments", async () => {
    const { pi, scope } = registration();
    const result = {
      get content(): never {
        throw new Error("must not read private output");
      },
      details: {
        status: "saved",
        file: "/private/workflow.ts",
        name: "secret",
      },
    };
    const execute = vi.fn(async () => result);
    const registered = tool(pi, execute);
    const args = [
      "private-call-id",
      { task: "private task" },
      undefined,
      undefined,
      {},
    ];
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_234);

    expect(await registered.execute(...args)).toBe(result);
    expect(execute).toHaveBeenCalledWith(...args);
    expect(payloads.map((p) => p.event)).toEqual([
      "pi_subagentura_operation_started",
      "pi_subagentura_operation_completed",
    ]);
    expect(payloads[1]).toMatchObject({
      distinct_id: scope.telemetry!.correlationId,
      properties: {
        surface: "tool",
        operation: "save_workflow",
        outcome: "returned",
        result_status: "ok",
        duration_ms: 1_200,
      },
    });
    expect(JSON.stringify(payloads)).not.toMatch(/private|secret/);
  });

  it.each([
    ["not_found", true, "unavailable"],
    ["invalid_id", true, "invalid_input"],
    ["confirmation_required", true, "confirmation_required"],
    ["cancelled", false, "cancelled"],
    ["wait_timeout", false, "wait_timeout"],
    ["running", false, "running"],
    ["error", false, "error"],
    ["private arbitrary status", true, "unknown"],
  ] as const)(
    "reports bounded status %s independently of the tool error flag",
    async (status, isError, expected) => {
      const { pi } = registration();
      const result = { content: [], details: { status }, isError };
      await tool(pi, async () => result).execute();
      expect(payloads.at(-1).properties).toMatchObject({
        outcome: isError ? "reported_error" : "returned",
        result_status: expected,
      });
      expect(JSON.stringify(payloads)).not.toContain(
        "private arbitrary status",
      );
    },
  );

  it.each([false, true])(
    "preserves thrown errors when cancellation is %s",
    async (cancelled) => {
      const { pi } = registration();
      const abort = new AbortController();
      if (cancelled) abort.abort("private reason");
      const error = new Error("private exception /home/customer");
      const registered = tool(pi, async () => {
        throw error;
      });
      await expect(registered.execute("id", {}, abort.signal)).rejects.toBe(
        error,
      );
      expect(payloads.at(-1).properties).toMatchObject({
        outcome: cancelled ? "aborted" : "threw",
        result_status: "unknown",
      });
      expect(JSON.stringify(payloads)).not.toMatch(/private|customer/);
    },
  );

  it("does not let telemetry failure or hostile status access change a result", async () => {
    const { pi } = registration();
    const result = {
      content: [],
      get details(): never {
        throw new Error("private");
      },
    };
    expect(await tool(pi, async () => result).execute()).toBe(result);
    expect(payloads.at(-1).properties.result_status).toBe("unknown");
    vi.stubGlobal("fetch", () => {
      throw new Error("offline");
    });
    expect(await tool(pi, async () => result).execute()).toBe(result);
  });

  it("drops late completion after the registration advances to another session", async () => {
    const { pi, scope } = registration();
    let finish!: (value: any) => void;
    const result = { content: [], details: { status: "saved" } };
    const pending = tool(
      pi,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ).execute();
    scope.generation++;
    scope.telemetry = createTelemetrySession(true);
    finish(result);
    expect(await pending).toBe(result);
    expect(payloads.map((p) => p.event)).toEqual([
      "pi_subagentura_operation_started",
    ]);
  });

  it("resolves only its own registration and respects opt-outs and unknown tools", async () => {
    const { pi, scope } = registration(false);
    registration(true);
    const result = { content: [], details: {} };
    await tool(pi, async () => result).execute();
    scope.telemetry = createTelemetrySession(true);
    await tool(pi, async () => result, "private-custom-tool").execute();
    scope.lifecycle = "shutdown";
    await tool(pi, async () => result).execute();
    expect(payloads).toEqual([]);
  });

  it("captures commands and synchronous shortcuts without collecting their arguments", async () => {
    const { pi } = registration();
    pi.registerCommand = vi.fn();
    pi.registerShortcut = vi.fn();
    const command = vi.fn(async () => {});
    const shortcut = vi.fn(() => {});
    registerCommandWithTelemetry(pi, "workflow", {
      description: "",
      handler: command,
    });
    registerShortcutWithTelemetry(pi, "ctrl+alt+a", {
      description: "",
      handler: shortcut,
    });
    const ctx = {} as any;
    await pi.registerCommand.mock.lastCall[1].handler("private task", ctx);
    await pi.registerShortcut.mock.lastCall[1].handler(ctx);
    expect(command).toHaveBeenCalledWith("private task", ctx);
    expect(shortcut).toHaveBeenCalledWith(ctx);
    expect(
      payloads
        .filter((p) => p.event.endsWith("_completed"))
        .map((p) => [
          p.properties.surface,
          p.properties.operation,
          p.properties.outcome,
        ]),
    ).toEqual([
      ["command", "workflow", "returned"],
      ["shortcut", "ctrl+alt+a", "returned"],
    ]);
    expect(JSON.stringify(payloads)).not.toContain("private task");
  });

  it("keeps every extension entry point on the closed operation allowlist", () => {
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn(),
      getFlag: vi.fn(),
    };
    registerExtension(pi as any);
    expect(
      pi.registerTool.mock.calls.map(([entry]) => entry.name).sort(),
    ).toEqual([...TELEMETRY_OPERATION_NAMES.tool].sort());
    expect(pi.registerCommand.mock.calls.map(([name]) => name).sort()).toEqual(
      [...TELEMETRY_OPERATION_NAMES.command].sort(),
    );
    expect(pi.registerShortcut.mock.calls.map(([name]) => name).sort()).toEqual(
      [...TELEMETRY_OPERATION_NAMES.shortcut].sort(),
    );
  });
});

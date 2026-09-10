import { describe, expect, it, vi } from "vitest";
import {
  buildSessionOptions,
  copyProviderConfig,
  createCompatibleSessionRuntime,
  findModel,
  registerProvider,
} from "../src/pi-sdk-compat";

describe("Pi SDK session compatibility", () => {
  it("passes modern SDK sessions a modelRuntime without legacy options", () => {
    const modelRuntime = {} as never;

    const options = buildSessionOptions(
      {
        kind: "modern",
        modelRuntime,
      },
      { cwd: "/tmp/project", model: undefined },
    );

    expect(options).toEqual({
      cwd: "/tmp/project",
      model: undefined,
      modelRuntime,
    });
    expect(options).not.toHaveProperty("authStorage");
    expect(options).not.toHaveProperty("modelRegistry");
  });

  it("passes legacy SDK sessions authStorage and modelRegistry", () => {
    const authStorage = {};
    const modelRegistry = {} as never;

    const options = buildSessionOptions(
      {
        kind: "legacy",
        authStorage,
        modelRegistry,
      },
      { cwd: "/tmp/project", model: undefined },
    );

    expect(options).toEqual({
      cwd: "/tmp/project",
      model: undefined,
      authStorage,
      modelRegistry,
    });
    expect(options).not.toHaveProperty("modelRuntime");
  });

  it("supports modern provider registration and model lookup", () => {
    const getModel = vi.fn();
    const registerProviderMock = vi.fn();
    const runtime = {
      kind: "modern" as const,
      modelRuntime: {
        getModel,
        registerProvider: registerProviderMock,
      } as never,
    };
    const model = { id: "faux-model" };
    getModel.mockReturnValue(model);
    const parentRegistry = {
      getRegisteredProviderConfig: vi.fn().mockReturnValue({ api: "faux" }),
    } as never;

    registerProvider(runtime, "faux", { api: "faux" });
    expect(registerProviderMock).toHaveBeenCalledWith("faux", { api: "faux" });
    expect(findModel(runtime, "faux", "faux-model")).toBe(model);
    copyProviderConfig(runtime, parentRegistry, "faux");
    expect(registerProviderMock).toHaveBeenCalledTimes(2);
  });

  it("copies native provider registrations into modern runtimes", () => {
    const nativeProvider = { id: "native-provider" };
    const registerNativeProvider = vi.fn();
    const registerProviderMock = vi.fn();
    const runtime = {
      kind: "modern" as const,
      modelRuntime: {
        getModel: vi.fn(),
        registerProvider: registerProviderMock,
        registerNativeProvider,
      } as never,
    };
    const parentRegistry = {
      getRegisteredNativeProvider: vi.fn().mockReturnValue(nativeProvider),
      getRegisteredProviderConfig: vi.fn(),
    } as never;

    copyProviderConfig(runtime, parentRegistry, "native-provider");

    expect(registerNativeProvider).toHaveBeenCalledWith(nativeProvider);
    expect(registerProviderMock).not.toHaveBeenCalled();
  });

  it("creates a default runtime when no auth data is supplied", async () => {
    const runtime = await createCompatibleSessionRuntime();
    expect(["legacy", "modern"]).toContain(runtime.kind);
  });
});

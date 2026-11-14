import { describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  WorkflowPickerComponent,
  type WorkflowPickerAction,
  showWorkflowPicker,
} from "../src/workflow-picker-ui";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

initTheme("dark", false);

describe("WorkflowPickerComponent", () => {
  it("deletes the selected workflow when d is pressed", () => {
    const done = vi.fn<(action: WorkflowPickerAction) => void>();
    const component = new WorkflowPickerComponent(
      [
        { name: "first", description: "First workflow" },
        { name: "second", description: "Second workflow" },
      ],
      theme as any,
      done,
    );

    component.handleInput("j");
    component.handleInput("d");

    expect(done).toHaveBeenCalledWith({ kind: "delete", name: "second" });
  });

  it("advertises the delete shortcut", () => {
    const component = new WorkflowPickerComponent(
      [{ name: "first", description: "First workflow" }],
      theme as any,
      vi.fn(),
    );

    expect(component.render(80).join("\n")).toContain("d delete");
  });
});

describe("showWorkflowPicker", () => {
  it("reports an inline user wait and preserves the selected action", async () => {
    const action = { kind: "run" as const, name: "first" };
    const custom = vi.fn(async (factory: Function, options: unknown) => {
      expect(options).toEqual({
        blocked: { kind: "question", message: "Select a workflow" },
      });
      const done = vi.fn();
      const component = factory(undefined, theme, undefined, done);
      expect(component).toBeInstanceOf(WorkflowPickerComponent);
      component.handleInput("\r");
      expect(done).toHaveBeenCalledWith(action);
      return action;
    });
    await expect(
      showWorkflowPicker({ custom } as unknown as ExtensionUIContext, [
        { name: "first", description: "First workflow" },
      ]),
    ).resolves.toEqual(action);
    expect(custom).toHaveBeenCalledOnce();
  });
  it("works when an older UI ignores options and the user cancels", async () => {
    const custom = vi.fn(async (_factory: unknown) => undefined);
    await expect(
      showWorkflowPicker({ custom } as unknown as ExtensionUIContext, []),
    ).resolves.toBeUndefined();
  });
});

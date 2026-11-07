import { describe, expect, it } from "vitest";
import { reconcileDeliveryReceipts } from "../src/delivery";
import {
  COMPLETION_CONSUMED_ENTRY_TYPE,
  COMPLETION_RECORD_SCHEMA_VERSION,
} from "../src/completion-coordinator";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
function state(): InteractiveSubagentState {
  return {
    id: "child",
    name: "child",
    task: "",
    paneId: "%1",
    mux: "tmux",
    sessionFile: "",
    cwd: "/tmp",
    startedAt: 0,
    status: "idle",
    attachCommand: "",
    selectPaneCommand: "",
    launchScriptFile: "",
    artifactDir: "/tmp",
    pendingDeliveries: ["old-turn", "new-turn"].map((turnId) => ({
      deliveryId: turnId,
      subagentId: "child",
      turnId,
      eventId: turnId,
      status: "done",
      artifactDir: "/tmp",
      state: "queued",
      completionPolicy: "each",
    })),
    deliveryReceipts: [],
  };
}
function receipt(selector: Record<string, unknown>) {
  return {
    type: "custom",
    customType: COMPLETION_CONSUMED_ENTRY_TYPE,
    data: {
      schemaVersion: COMPLETION_RECORD_SCHEMA_VERSION,
      source: "interactive",
      sourceId: "child",
      consumedAt: 1,
      reason: "manual",
      ...selector,
    },
  };
}
describe("delivery receipt turn scoping", () => {
  it.each([{}, { scope: "source" }])(
    "preserves turn deliveries after source-only receipt %j",
    (selector) => {
      const child = state();
      reconcileDeliveryReceipts(child, [receipt(selector)]);
      expect(child.pendingDeliveries?.map((intent) => intent.turnId)).toEqual([
        "old-turn",
        "new-turn",
      ]);
      expect(child.deliveryReceipts).toEqual([]);
    },
  );
  it("acknowledges only the specified turn", () => {
    const child = state();
    reconcileDeliveryReceipts(child, [receipt({ turnId: "old-turn" })]);
    expect(child.pendingDeliveries?.map((intent) => intent.turnId)).toEqual([
      "new-turn",
    ]);
    expect(child.deliveryReceipts).toEqual(["old-turn"]);
  });
});

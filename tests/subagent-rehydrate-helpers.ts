import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

export function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-rehydrate-"));
}

export function makeState(cwd: string, id: string): InteractiveSubagentState {
  const artifactDir = join(cwd, id);
  return {
    id,
    name: id,
    task: "",
    paneId: "%42",
    windowName: "demo",
    mux: "tmux",
    sessionFile: "/tmp/sess.jsonl",
    cwd,
    startedAt: Date.now(),
    status: "running",
    attachCommand: "",
    selectPaneCommand: "",
    launchScriptFile: "",
    artifactDir,
    eventByteCursor: 0,
    pendingDeliveries: [],
    deliveryReceipts: [],
    parentSessionId: "pi",
  };
}

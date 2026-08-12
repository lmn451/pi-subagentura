import { renameSync, writeFileSync } from "node:fs";

const statePath = process.env.WORKFLOW_PROCESS_STATE;
const crashAt = process.env.WORKFLOW_PROCESS_CRASH_AT;
if (!statePath || !crashAt || typeof process.send !== "function") {
  throw new Error(
    "workflow process crash fixture requires state, phase, and IPC",
  );
}

const state = {
  launchPrepared: true,
  panes: [],
  assignment: null,
  launchDispatched: false,
  commandCount: 0,
  childStarted: false,
  terminalCount: 0,
};

function persist() {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, statePath);
}

function phase(name) {
  persist();
  process.send({ type: "phase", phase: name });
  if (crashAt === name) {
    setInterval(() => undefined, 1_000);
    return true;
  }
  return false;
}

if (!phase("before_pane")) {
  state.panes.push({ paneId: "%fixture-1", alive: true });
  if (!phase("pane_created")) {
    state.assignment = "%fixture-1";
    if (!phase("pane_assigned")) {
      state.launchDispatched = true;
      state.commandCount += 1;
      state.childStarted = true;
      if (!phase("child_started")) {
        state.terminalCount += 1;
        phase("terminal");
        process.exit(0);
      }
    }
  }
}

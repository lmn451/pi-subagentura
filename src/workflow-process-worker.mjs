// Per-attempt child supervisor, not a workflow coordinator. It may finish an
// already-authorized agent while Pi is absent; it cannot dispatch another step.
import {
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const [manifestPath, command] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest.version !== 1 ||
  typeof command !== "string" ||
  !/^[a-f0-9-]{36}$/.test(manifest.nonce)
) {
  throw new Error("Invalid durable process manifest.");
}

function receipt(suffix, value) {
  const fd = openSync(manifestPath + suffix, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(manifestPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

// A one-use start receipt makes re-sending a launch command harmless. The
// parent persisted pane/artifact identity before this script could be invoked.
receipt(".started", { nonce: manifest.nonce, pid: process.pid });
if (existsSync(manifestPath + ".cancel")) {
  receipt(".finished", { nonce: manifest.nonce, cancelled: true });
  process.exit(130);
}

const child = spawn("bash", ["-c", command], {
  stdio: "inherit",
  detached: true,
});
let cancelled = false;
let killTimer;
function cancel() {
  if (cancelled) return;
  cancelled = true;
  writeFileSync(join(manifest.state.artifactDir, ".cancelled"), "", {
    mode: 0o600,
  });
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  killTimer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    complete(130);
  }, 2000);
}
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
const timer = setInterval(() => {
  if (existsSync(manifestPath + ".cancel")) cancel();
}, 250);
child.on("error", () => finish(1));
child.on("exit", (code) => finish(code ?? 1));
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  // The leader can exit on SIGTERM while a descendant ignores it. Keep the
  // bounded escalation until the entire owned process group has been fenced.
  if (cancelled && killTimer) return;
  complete(code);
}
function complete(code) {
  receipt(".finished", { nonce: manifest.nonce, cancelled, code });
  process.exitCode = cancelled ? 130 : code;
}

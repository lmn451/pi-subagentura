import { randomUUID as lockToken } from "node:crypto";
import {
  mkdirSync as lockDirectory,
  readdirSync as listOwners,
  rmdirSync as removeDirectory,
} from "node:fs";
import { join as ownerPath } from "node:path";
import { performance as lockClock } from "node:perf_hooks";

const completionWaiter = new Int32Array(new SharedArrayBuffer(4));

// A contender can remove only the exact marker it inspected. No contender
// removes an empty directory: it might belong to a writer publishing its marker.
function recoverDeadWriter(lock) {
  try {
    const owners = listOwners(lock);
    if (owners.length !== 1) return;
    const match = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(owners[0]);
    if (!match) return;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) return;
    try {
      process.kill(pid, 0);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") return;
    }
    removeDirectory(ownerPath(lock, owners[0]));
    removeDirectory(lock);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function withCompletionWriterLock(lock, operation, timeoutMs = 2000) {
  const marker = ownerPath(lock, process.pid + "-" + lockToken());
  const deadline = lockClock.now() + timeoutMs;
  while (true) {
    try {
      lockDirectory(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (lockClock.now() >= deadline)
      throw new Error("timed out acquiring completion lock: " + lock);
    recoverDeadWriter(lock);
    Atomics.wait(completionWaiter, 0, 0, 10);
  }
  try {
    lockDirectory(marker, { mode: 0o700 });
  } catch (error) {
    removeDirectory(lock);
    throw error;
  }
  try {
    return operation();
  } finally {
    removeDirectory(marker);
    removeDirectory(lock);
  }
}

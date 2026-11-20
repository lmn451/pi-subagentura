import { randomUUID as lockToken } from "node:crypto";
import {
  mkdirSync as lockDirectory,
  readdirSync as listOwners,
  rmdirSync as removeDirectory,
} from "node:fs";
import { join as ownerPath } from "node:path";
import { performance as lockClock } from "node:perf_hooks";

const completionWaiter = new Int32Array(new SharedArrayBuffer(4));

// Recover only a recognized owner marker whose PID is absent.
// Empty or ambiguous locks remain in place because their owner cannot be proven.
function recoverDeadWriter(lock) {
  try {
    const owners = listOwners(lock);
    if (owners.length !== 1) {
      return "owner marker is missing or ambiguous";
    }
    const match = /^([1-9]\d*)-([0-9a-f-]{36})$/.exec(owners[0]);
    if (!match) return "owner marker is missing or ambiguous";
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) {
      return "owner marker is missing or ambiguous";
    }
    try {
      process.kill(pid, 0);
      return `owner process ${pid} exists but its instance cannot be verified`;
    } catch (error) {
      if (error.code !== "ESRCH") {
        return `owner process ${pid} liveness is unknown`;
      }
    }
    removeDirectory(ownerPath(lock, owners[0]));
    removeDirectory(lock);
    return undefined;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

function timeoutError(lock, reason) {
  const detail = reason ? ` (${reason}; lock left untouched)` : "";
  return new Error(`timed out acquiring completion lock: ${lock}${detail}`);
}

export function withCompletionWriterLock(lock, operation, timeoutMs = 2000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "completion lock timeout must be finite and non-negative",
    );
  }
  const marker = ownerPath(lock, process.pid + "-" + lockToken());
  const deadline = lockClock.now() + timeoutMs;
  let firstAttempt = true;
  let lastRecoveryReason;
  while (true) {
    if (!firstAttempt && lockClock.now() >= deadline) {
      throw timeoutError(lock, lastRecoveryReason);
    }
    firstAttempt = false;
    try {
      lockDirectory(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (lockClock.now() >= deadline) {
      throw timeoutError(lock, lastRecoveryReason);
    }
    lastRecoveryReason = recoverDeadWriter(lock);
    const remaining = deadline - lockClock.now();
    if (remaining <= 0) throw timeoutError(lock, lastRecoveryReason);
    const retryDelay = Math.max(1, Math.min(10, Math.ceil(remaining)));
    Atomics.wait(completionWaiter, 0, 0, retryDelay);
  }
  try {
    lockDirectory(marker, { mode: 0o700 });
  } catch (error) {
    // A legacy writer can replace the path between acquisition and publication.
    // Never remove a path whose generation this process cannot prove it owns.
    throw error;
  }
  try {
    return operation();
  } finally {
    removeDirectory(marker);
    removeDirectory(lock);
  }
}

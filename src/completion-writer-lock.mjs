import { createHash as hashTurn, randomUUID as lockToken } from "node:crypto";
import {
  closeSync as closeLockFd,
  constants as lockConstants,
  fstatSync as statLockFd,
  mkdirSync as makeLockDirectory,
  mkdtempSync as makeClaimDirectory,
  openSync as openLockFile,
  readSync as readLockBytes,
  readdirSync as listOwners,
  renameSync as publishPath,
  rmSync as removeTree,
  rmdirSync as removeDirectory,
  statSync as statLegacyLock,
  lstatSync as statLockEntry,
  unlinkSync as unlinkLockFile,
  writeFileSync as writeLockFile,
} from "node:fs";
import { dirname as lockDirname, join as lockPath } from "node:path";
import { performance as lockClock } from "node:perf_hooks";

const completionWaiter = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 2_000;
const LEGACY_STALE_MS = 30_000;
const RETRY_INTERVAL_MS = 10;
const MAX_PROTOCOL_MARKER_BYTES = 128;
const ATOMIC_PROTOCOL_MARKER = "atomic-directory-rename-v1\n";

export const COMPLETION_LOCK_PROTOCOL_FILE = ".completion-lock-protocol";

export function completionLockPathForTurn(artifactDir, turnId) {
  const key = hashTurn("sha256").update(turnId).digest("hex").slice(0, 24);
  return lockPath(artifactDir, `.completion-${key}.lock`);
}

export function readCompletionLockProtocol(artifactDir) {
  const markerPath = lockPath(artifactDir, COMPLETION_LOCK_PROTOCOL_FILE);
  let fd;
  try {
    fd = openLockFile(
      markerPath,
      lockConstants.O_RDONLY | (lockConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error.code === "ENOENT") return "legacy";
    throw error;
  }
  try {
    const metadata = statLockFd(fd);
    if (!metadata.isFile() || metadata.size > MAX_PROTOCOL_MARKER_BYTES) {
      return "unknown";
    }
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const bytesRead = readLockBytes(
        fd,
        buffer,
        offset,
        metadata.size - offset,
        offset,
      );
      if (bytesRead <= 0) return "unknown";
      offset += bytesRead;
    }
    return buffer.toString("utf8") === ATOMIC_PROTOCOL_MARKER
      ? "atomic"
      : "unknown";
  } finally {
    closeLockFd(fd);
  }
}

export function initializeCompletionLockProtocol(artifactDir) {
  const current = readCompletionLockProtocol(artifactDir);
  if (current === "atomic") return;
  if (current === "unknown") {
    throw new Error(
      `cannot initialize completion lock protocol in ${artifactDir}: marker is unknown`,
    );
  }
  if (listOwners(artifactDir).length !== 0) {
    throw new Error(
      `cannot initialize completion lock protocol in ${artifactDir}: artifact is not fresh`,
    );
  }
  const markerPath = lockPath(artifactDir, COMPLETION_LOCK_PROTOCOL_FILE);
  const temporaryPath = lockPath(
    artifactDir,
    `.${COMPLETION_LOCK_PROTOCOL_FILE}.${process.pid}-${lockToken()}.tmp`,
  );
  try {
    writeLockFile(temporaryPath, ATOMIC_PROTOCOL_MARKER, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    publishPath(temporaryPath, markerPath);
  } catch (error) {
    try {
      unlinkLockFile(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          `failed to publish completion lock protocol in ${artifactDir}`,
        );
      }
    }
    const observed = readCompletionLockProtocol(artifactDir);
    if (error.code === "EEXIST" && observed === "atomic") return;
    throw error;
  }
}

function timeoutError(lock, reason) {
  const detail = reason ? ` (${reason}; lock left untouched)` : "";
  return new Error(`timed out acquiring completion lock: ${lock}${detail}`);
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "completion lock timeout must be finite and non-negative",
    );
  }
}

function waitForRetry(deadline, lock, reason) {
  const remaining = deadline - lockClock.now();
  if (remaining <= 0) throw timeoutError(lock, reason);
  const delay = Math.max(1, Math.min(RETRY_INTERVAL_MS, Math.ceil(remaining)));
  Atomics.wait(completionWaiter, 0, 0, delay);
}

function describeOwner(pid) {
  try {
    process.kill(pid, 0);
    return `owner process ${pid} exists but its instance cannot be verified`;
  } catch (error) {
    if (error.code === "ESRCH") return undefined;
    return `owner process ${pid} liveness is unknown`;
  }
}

function removeAtomicLockRoot(lock) {
  try {
    removeDirectory(lock);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) return;
    if (error.code === "EPERM") {
      try {
        if (listOwners(lock).length > 0) return;
      } catch (readError) {
        if (readError.code === "ENOENT") return;
        throw readError;
      }
    }
    throw error;
  }
}

function isAtomicRenameContention(error, lock) {
  if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return true;
  if (error.code !== "EPERM") return false;
  try {
    return statLockEntry(lock).isDirectory();
  } catch (probeError) {
    if (probeError.code === "ENOENT") return false;
    throw probeError;
  }
}

function recoverAtomicWriter(lock) {
  let lockMetadata;
  try {
    lockMetadata = statLockEntry(lock);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!lockMetadata.isDirectory()) {
    return "lock entry is not a directory or owner metadata is unknown";
  }
  let owners;
  try {
    owners = listOwners(lock);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (owners.length === 0) {
    removeAtomicLockRoot(lock);
    return undefined;
  }
  if (owners.length !== 1) return "owner marker is missing or ambiguous";
  const ownerName = owners[0];
  const match = /^([1-9][0-9]*)-([0-9a-f-]{36})$/.exec(ownerName);
  if (!match) return "owner marker is missing or ambiguous";
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) {
    return "owner marker is missing or ambiguous";
  }
  const ownerStatus = describeOwner(pid);
  if (ownerStatus) return ownerStatus;
  try {
    removeDirectory(lockPath(lock, ownerName));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  removeAtomicLockRoot(lock);
  return undefined;
}

// Markerless artifacts may still run the v1 CLI, so keep its age-based rule.
function recoverLegacyWriter(lock) {
  let metadata;
  try {
    metadata = statLegacyLock(lock);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (Date.now() - metadata.mtimeMs <= LEGACY_STALE_MS) {
    return "legacy lock is recent or its owner is unknown";
  }
  try {
    removeTree(lock, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return undefined;
}

function withAtomicCompletionLock(lock, operation, timeoutMs) {
  const ownerName = `${process.pid}-${lockToken()}`;
  const claimPath = makeClaimDirectory(
    lockPath(lockDirname(lock), ".completion-claim-"),
  );
  const deadline = lockClock.now() + timeoutMs;
  let published = false;
  let firstAttempt = true;
  let lastRecoveryReason;
  try {
    makeLockDirectory(lockPath(claimPath, ownerName), { mode: 0o700 });
    while (true) {
      if (!firstAttempt && lockClock.now() >= deadline) {
        throw timeoutError(lock, lastRecoveryReason);
      }
      firstAttempt = false;
      try {
        publishPath(claimPath, lock);
        published = true;
        break;
      } catch (error) {
        if (!isAtomicRenameContention(error, lock)) throw error;
      }
      if (lockClock.now() >= deadline) {
        throw timeoutError(lock, lastRecoveryReason);
      }
      lastRecoveryReason = recoverAtomicWriter(lock);
      waitForRetry(deadline, lock, lastRecoveryReason);
    }
    try {
      return operation();
    } finally {
      removeDirectory(lockPath(lock, ownerName));
      removeAtomicLockRoot(lock);
    }
  } finally {
    if (!published) removeTree(claimPath, { recursive: true, force: true });
  }
}

function withLegacyCompletionLock(lock, operation, timeoutMs) {
  const deadline = lockClock.now() + timeoutMs;
  let firstAttempt = true;
  let lastRecoveryReason;
  while (true) {
    if (!firstAttempt && lockClock.now() >= deadline) {
      throw timeoutError(lock, lastRecoveryReason);
    }
    firstAttempt = false;
    try {
      makeLockDirectory(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (lockClock.now() >= deadline) {
      throw timeoutError(lock, lastRecoveryReason);
    }
    lastRecoveryReason = recoverLegacyWriter(lock);
    waitForRetry(deadline, lock, lastRecoveryReason);
  }
  try {
    return operation();
  } finally {
    removeTree(lock, { recursive: true, force: true });
  }
}

export function withCompletionWriterLock(
  lock,
  operation,
  timeoutMs = LOCK_TIMEOUT_MS,
  protocol = "atomic",
) {
  validateTimeout(timeoutMs);
  if (protocol === "atomic") {
    return withAtomicCompletionLock(lock, operation, timeoutMs);
  }
  if (protocol === "legacy") {
    return withLegacyCompletionLock(lock, operation, timeoutMs);
  }
  throw new Error(
    `unsupported completion lock protocol for ${lock}; no lock was acquired`,
  );
}

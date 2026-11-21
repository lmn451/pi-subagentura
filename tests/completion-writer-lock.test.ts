import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPLETION_LOCK_PROTOCOL_FILE,
  completionLockPathForTurn,
  initializeCompletionLockProtocol,
  readCompletionLockProtocol,
  withCompletionWriterLock,
} from "../src/completion-writer-lock.mjs";
let root: string, lock: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "completion-lock-"));
  lock = join(root, "turn.lock");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
it("does not take an old lock from a live writer", () => {
  withCompletionWriterLock(lock, () => {
    utimesSync(lock, new Date(0), new Date(0));
    expect(() => withCompletionWriterLock(lock, () => {}, 30)).toThrow(
      /timed out/,
    );
  });
  expect(existsSync(lock)).toBe(false);
});
it("recovers the lock of an exited writer", () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.status).toBe(0);
  mkdirSync(lock);
  mkdirSync(join(lock, child.pid + "-" + randomUUID()));
  expect(withCompletionWriterLock(lock, () => 42)).toBe(42);
});
it("reports lock inspection errors instead of retrying", () => {
  writeFileSync(lock, "");
  expect(() => withCompletionWriterLock(lock, () => {})).toThrow(/ENOTDIR/);
});

it("keeps legacy age recovery when an artifact has no protocol marker", () => {
  mkdirSync(lock);
  utimesSync(lock, new Date(0), new Date(0));
  const operation = vi.fn(() => 42);

  expect(withCompletionWriterLock(lock, operation, 2_000, "legacy")).toBe(42);
  expect(operation).toHaveBeenCalledOnce();
  expect(existsSync(lock)).toBe(false);
});

it("rejects non-regular and oversized protocol markers", () => {
  const markerPath = join(root, COMPLETION_LOCK_PROTOCOL_FILE);
  mkdirSync(markerPath);
  expect(readCompletionLockProtocol(root)).toBe("unknown");
  rmSync(markerPath, { recursive: true });
  writeFileSync(markerPath, Buffer.alloc(129));
  expect(readCompletionLockProtocol(root)).toBe("unknown");
});

it.skipIf(process.platform === "win32")(
  "does not follow a protocol marker symlink",
  () => {
    const markerPath = join(root, COMPLETION_LOCK_PROTOCOL_FILE);
    const targetPath = join(root, "marker-target");
    writeFileSync(targetPath, "atomic-directory-rename-v1\n");
    symlinkSync(targetPath, markerPath);
    let error: unknown;

    try {
      readCompletionLockProtocol(root);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(["ELOOP", "EPERM"]).toContain((error as NodeJS.ErrnoException).code);
  },
);

it.skipIf(process.platform === "win32")(
  "opens a FIFO protocol marker without blocking",
  () => {
    const markerPath = join(root, COMPLETION_LOCK_PROTOCOL_FILE);
    const fifo = spawnSync("mkfifo", [markerPath], {
      encoding: "utf8",
      timeout: 1_000,
    });
    expect(fifo.error).toBeUndefined();
    expect(fifo.status).toBe(0);

    const helperUrl = pathToFileURL(
      join(process.cwd(), "src/completion-writer-lock.mjs"),
    ).href;
    const script = `
      import { readCompletionLockProtocol } from ${JSON.stringify(helperUrl)};
      process.stdout.write(readCompletionLockProtocol(${JSON.stringify(root)}));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 2_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("unknown");
  },
);

it("does not treat a reused PID as proof of the original owner", () => {
  const ownerPid = 2_000_000_000;
  mkdirSync(lock);
  mkdirSync(join(lock, `${ownerPid}-${randomUUID()}`));
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const operation = vi.fn();
  let error: unknown;

  try {
    withCompletionWriterLock(lock, operation, 30);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(
    /owner process 2000000000 exists but its instance cannot be verified/i,
  );
  expect(kill).toHaveBeenCalledWith(ownerPid, 0);
  expect(operation).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(true);
});

it("propagates lock marker removal errors promptly", () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.status).toBe(0);
  expect(child.pid).toBeDefined();
  mkdirSync(lock);
  const owner = join(lock, `${child.pid}-${randomUUID()}`);
  mkdirSync(owner);
  writeFileSync(join(owner, "held"), "");
  const operation = vi.fn();
  const startedAt = performance.now();

  expect(() => withCompletionWriterLock(lock, operation, 100)).toThrow(
    /ENOTEMPTY|Directory not empty/i,
  );
  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(operation).not.toHaveBeenCalled();
  expect(existsSync(owner)).toBe(true);
});

it("serializes competing recoverers of one dead owner", async () => {
  const deadOwner = spawnSync(process.execPath, ["-e", ""]);
  expect(deadOwner.status).toBe(0);
  const deadPid = deadOwner.pid ?? 2_000_000_000;
  mkdirSync(lock);
  mkdirSync(join(lock, `${deadPid}-${randomUUID()}`));
  const activePath = join(root, "active");
  const overlapPath = join(root, "overlap");
  const helperUrl = pathToFileURL(
    join(process.cwd(), "src/completion-writer-lock.mjs"),
  ).href;
  const script = `
    import { withCompletionWriterLock } from ${JSON.stringify(helperUrl)};
    import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
    withCompletionWriterLock(${JSON.stringify(lock)}, () => {
      let fd;
      try {
        fd = openSync(${JSON.stringify(activePath)}, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        writeFileSync(${JSON.stringify(overlapPath)}, "overlap");
        return;
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      } finally {
        closeSync(fd);
        unlinkSync(${JSON.stringify(activePath)});
      }
    }, 2000);
  `;
  const children = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ["--input-type=module", "-e", script]),
  );
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("completion lock child timed out"));
          }, 5000);
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve();
            else reject(new Error(`completion lock child exited ${code}`));
          });
        }),
    ),
  );
  expect(existsSync(overlapPath)).toBe(false);
});

it("recovers an empty atomic lock left by an interrupted recovery", () => {
  initializeCompletionLockProtocol(root);
  const atomicLock = completionLockPathForTurn(root, "atomic-turn");
  mkdirSync(atomicLock);

  expect(readCompletionLockProtocol(root)).toBe("atomic");
  expect(withCompletionWriterLock(atomicLock, () => 42, 100, "atomic")).toBe(
    42,
  );
  expect(existsSync(atomicLock)).toBe(false);
});

it("uses legacy mode for missing markers and fails closed on unknown markers", () => {
  expect(readCompletionLockProtocol(root)).toBe("legacy");
  writeFileSync(join(root, COMPLETION_LOCK_PROTOCOL_FILE), "unknown-v99\n");

  expect(readCompletionLockProtocol(root)).toBe("unknown");
  expect(() => withCompletionWriterLock(lock, () => {}, 30, "unknown")).toThrow(
    /unsupported completion lock protocol/i,
  );
  expect(existsSync(lock)).toBe(false);
});

it("does not upgrade a populated legacy artifact", () => {
  writeFileSync(join(root, "cli.mjs"), "old helper image");

  expect(() => initializeCompletionLockProtocol(root)).toThrow(
    /artifact is not fresh/,
  );
  expect(readCompletionLockProtocol(root)).toBe("legacy");
  expect(existsSync(join(root, COMPLETION_LOCK_PROTOCOL_FILE))).toBe(false);
});

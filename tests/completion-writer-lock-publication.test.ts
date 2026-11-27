import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsState = vi.hoisted(() => ({
  lockPath: "",
  claimPrefix: "",
  failNextOwnerMarker: false,
  atomicRenameError: "",
  injectSuccessorOnMarkerRemoval: false,
  legacyStatError: false,
  legacyRemoveError: false,
  oldMarkerPath: "",
  successorClaimPath: "",
  successorMarkerName: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (path: string, options?: { mode?: number }) => {
      const isOwnerMarker =
        (path.startsWith(`${fsState.lockPath}/`) ||
          path.startsWith(fsState.claimPrefix)) &&
        /[1-9][0-9]*-[0-9a-f-]{36}$/.test(path);
      if (fsState.failNextOwnerMarker && isOwnerMarker) {
        fsState.failNextOwnerMarker = false;
        const error = new Error("simulated owner marker EIO");
        Object.assign(error, { code: "EIO" });
        throw error;
      }
      return actual.mkdirSync(path, options);
    },
    renameSync: (fromPath: string, toPath: string) => {
      if (fsState.atomicRenameError && toPath === fsState.lockPath) {
        const code = fsState.atomicRenameError;
        fsState.atomicRenameError = "";
        const error = new Error(`simulated atomic rename ${code}`);
        Object.assign(error, { code });
        throw error;
      }
      return actual.renameSync(fromPath, toPath);
    },
    rmdirSync: (path: string) => {
      if (
        fsState.injectSuccessorOnMarkerRemoval &&
        path === fsState.oldMarkerPath
      ) {
        fsState.injectSuccessorOnMarkerRemoval = false;
        actual.rmdirSync(path);
        actual.rmdirSync(fsState.lockPath);
        actual.renameSync(fsState.successorClaimPath, fsState.lockPath);
        return;
      }
      return actual.rmdirSync(path);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (fsState.legacyStatError && args[0] === fsState.lockPath) {
        const error = new Error("simulated legacy stat EIO");
        Object.assign(error, { code: "EIO" });
        throw error;
      }
      return actual.statSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsState.legacyRemoveError && args[0] === fsState.lockPath) {
        const error = new Error("simulated legacy remove EIO");
        Object.assign(error, { code: "EIO" });
        throw error;
      }
      return actual.rmSync(...args);
    },
  };
});

import { withCompletionWriterLock } from "../src/completion-writer-lock.mjs";

let root: string;
let lock: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "completion-lock-publication-"));
  lock = join(root, "turn.lock");
  fsState.claimPrefix = join(root, ".completion-claim-");
  fsState.lockPath = lock;
  fsState.failNextOwnerMarker = false;
  fsState.atomicRenameError = "";
  fsState.injectSuccessorOnMarkerRemoval = false;
  fsState.legacyStatError = false;
  fsState.legacyRemoveError = false;
});

afterEach(() => {
  fsState.failNextOwnerMarker = false;
  fsState.atomicRenameError = "";
  fsState.injectSuccessorOnMarkerRemoval = false;
  fsState.legacyStatError = false;
  fsState.legacyRemoveError = false;
  rmSync(root, { recursive: true, force: true });
});

it("leaves no stable lock when owner metadata publication fails", () => {
  fsState.failNextOwnerMarker = true;
  const operation = vi.fn();
  let failure: unknown;

  try {
    withCompletionWriterLock(lock, operation, 100, "atomic");
  } catch (error) {
    failure = error;
  }
  expect(fsState.failNextOwnerMarker).toBe(false);
  expect((failure as Error).message).toMatch(/simulated owner marker EIO/);
  expect(operation).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(root).some((name) => name.includes(".claim-"))).toBe(
    false,
  );

  expect(withCompletionWriterLock(lock, () => 42, 100, "atomic")).toBe(42);
  expect(existsSync(lock)).toBe(false);
});

it("ignores an orphan claim directory left by an interrupted creator", () => {
  const claim = `${lock}.claim-abandoned`;
  mkdirSync(claim);

  expect(withCompletionWriterLock(lock, () => 42, 100, "atomic")).toBe(42);
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(claim)).toBe(true);
});

it("does not remove an atomic successor while recovering an exited owner", () => {
  const deadProcess = spawnSync(process.execPath, ["-e", ""]);
  expect(deadProcess.status).toBe(0);
  const deadPid = deadProcess.pid ?? 2_000_000_000;
  const staleMarkerName = `${deadPid}-${"a".repeat(36)}`;
  fsState.oldMarkerPath = join(lock, staleMarkerName);
  fsState.successorClaimPath = join(root, "successor.claim");
  fsState.successorMarkerName = `${process.pid}-${"b".repeat(36)}`;
  mkdirSync(lock);
  mkdirSync(fsState.oldMarkerPath);
  mkdirSync(fsState.successorClaimPath);
  mkdirSync(join(fsState.successorClaimPath, fsState.successorMarkerName));
  fsState.injectSuccessorOnMarkerRemoval = true;
  const operation = vi.fn();
  const startedAt = performance.now();

  expect(() => withCompletionWriterLock(lock, operation, 30, "atomic")).toThrow(
    /timed out/,
  );
  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(operation).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(true);
  expect(existsSync(join(lock, fsState.successorMarkerName))).toBe(true);
});

it("keeps a replacement lock when release cannot find its own marker", () => {
  const replacementMarker = `${process.pid}-${"c".repeat(36)}`;
  const operation = vi.fn(() => {
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    mkdirSync(join(lock, replacementMarker));
  });

  expect(() =>
    withCompletionWriterLock(lock, operation, 100, "atomic"),
  ).toThrow(/ENOENT/);
  expect(existsSync(join(lock, replacementMarker))).toBe(true);
});

it("refuses markerless writes before inspecting or removing the lock", () => {
  mkdirSync(lock);
  const startedAt = performance.now();
  fsState.legacyStatError = true;

  expect(() => withCompletionWriterLock(lock, () => {}, 100, "legacy")).toThrow(
    /legacy completion writer/,
  );
  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(existsSync(lock)).toBe(true);

  fsState.legacyStatError = false;
  fsState.legacyRemoveError = true;
  utimesSync(lock, new Date(0), new Date(0));
  const removalStartedAt = performance.now();
  expect(() => withCompletionWriterLock(lock, () => {}, 100, "legacy")).toThrow(
    /legacy completion writer/,
  );
  expect(performance.now() - removalStartedAt).toBeLessThan(500);
  expect(existsSync(lock)).toBe(true);
});

it("does not fall back when a same-directory rename reports EXDEV", () => {
  fsState.atomicRenameError = "EXDEV";
  let failure: unknown;

  try {
    withCompletionWriterLock(lock, () => {}, 100, "atomic");
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).message).toMatch(/simulated atomic rename EXDEV/);
  expect(existsSync(lock)).toBe(false);
  expect(
    readdirSync(root).some((name) => name.includes(".completion-claim-")),
  ).toBe(false);

  expect(withCompletionWriterLock(lock, () => 7, 100, "atomic")).toBe(7);
});

it("treats Windows EPERM for an existing lock directory as contention", () => {
  mkdirSync(lock);
  const owner = join(lock, `${process.pid}-${"d".repeat(36)}`);
  mkdirSync(owner);
  fsState.atomicRenameError = "EPERM";

  expect(() => withCompletionWriterLock(lock, () => {}, 30, "atomic")).toThrow(
    /owner process .* cannot be verified/,
  );
  expect(existsSync(owner)).toBe(true);
});

it("propagates EPERM when no destination lock exists", () => {
  fsState.atomicRenameError = "EPERM";
  let failure: unknown;

  try {
    withCompletionWriterLock(lock, () => {}, 100, "atomic");
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).message).toMatch(/simulated atomic rename EPERM/);
  expect(existsSync(lock)).toBe(false);
});

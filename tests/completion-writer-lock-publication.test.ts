import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockState = vi.hoisted(() => ({
  lockPath: "",
  replaceOnOwnerPublication: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (path: string, options?: { mode?: number }) => {
      if (
        mockState.replaceOnOwnerPublication &&
        path.startsWith(`${mockState.lockPath}/`)
      ) {
        mockState.replaceOnOwnerPublication = false;
        actual.rmSync(mockState.lockPath, { recursive: true, force: true });
        actual.mkdirSync(mockState.lockPath);
        const error = new Error("simulated marker publication failure");
        Object.assign(error, { code: "EIO" });
        throw error;
      }
      return actual.mkdirSync(path, options);
    },
  };
});

import { withCompletionWriterLock } from "../src/completion-writer-lock.mjs";

let root: string;
let lock: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "completion-lock-publication-"));
  lock = join(root, "turn.lock");
  mockState.lockPath = lock;
  mockState.replaceOnOwnerPublication = true;
});

afterEach(() => {
  mockState.replaceOnOwnerPublication = false;
  rmSync(root, { recursive: true, force: true });
});

it("does not remove a successor lock when owner publication fails", () => {
  expect(() => withCompletionWriterLock(lock, () => {})).toThrow(
    /simulated marker publication failure/,
  );
  expect(existsSync(lock)).toBe(true);
  expect(readdirSync(lock)).toEqual([]);
});

it("does not remove a replacement lock during owner release", () => {
  mockState.replaceOnOwnerPublication = false;

  expect(() =>
    withCompletionWriterLock(lock, () => {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
    }),
  ).toThrow(/ENOENT/);
  expect(existsSync(lock)).toBe(true);
  expect(readdirSync(lock)).toEqual([]);
});

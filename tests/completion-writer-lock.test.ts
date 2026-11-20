import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCompletionWriterLock } from "../src/completion-writer-lock.mjs";
let root: string, lock: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "completion-lock-"));
  lock = join(root, "turn.lock");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendCompletionEvent,
  appendEvent,
  appendInteractiveState,
  artifactPath,
  cleanupOldArtifacts,
  deleteInteractiveStatesFile,
  ensureArtifactDir,
  eventLogEndOffset,
  isArtifactOutputSettled,
  isCompletionEvent,
  isTurnTerminal,
  lastEvent,
  listArtifacts,
  MAX_EVENT_RECORD_BYTES,
  listOutputTurns,
  loadInteractiveStates,
  MAX_EVENT_TEXT_LENGTH,
  MAX_EVENT_BATCH_BYTES,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  MAX_TOOL_NAME_LENGTH,
  outputPathForTurn,
  readEvents,
  readEventBatch,
  readEventRecords,
  readOutput,
  readOutputForTurn,
  removeInteractiveState,
  saveInteractiveStates,
  snapshotOutput,
  stateFilePath,
  writeOutput,
  withInteractiveStateLock,
  type InteractiveSubagentPersistedState,
  type InteractiveSubagentPersistedStateV2,
  type SubagentEvent,
} from "../src/artifact";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-artifact-"));
}

describe("artifact", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmp();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("artifactPath", () => {
    it("builds expected paths under the root", () => {
      const art = artifactPath(root, "abc123");
      expect(art.id).toBe("abc123");
      expect(art.dir).toBe(join(root, "abc123"));
      expect(art.statusFile).toBe(join(root, "abc123", "events.ndjson"));
      expect(art.outputFile).toBe(join(root, "abc123", "output.md"));
    });
  });

  describe("ensureArtifactDir", () => {
    it("creates the directory with 0o700 perms", () => {
      const art = artifactPath(root, "x");
      ensureArtifactDir(art);
      expect(existsSync(art.dir)).toBe(true);
      expect(statSync(art.dir).mode & 0o777).toBe(0o700);
    });

    it("is idempotent", () => {
      const art = artifactPath(root, "x");
      ensureArtifactDir(art);
      expect(() => ensureArtifactDir(art)).not.toThrow();
    });
  });

  describe("appendEvent", () => {
    it("creates dir and writes one NDJSON line", () => {
      const art = artifactPath(root, "a");
      const ev: SubagentEvent = {
        ts: 1000,
        type: "started",
        status: "running",
      };
      appendEvent(art, ev);
      expect(existsSync(art.statusFile)).toBe(true);
      const content = readFileSync(art.statusFile, "utf8");
      expect(content).toBe(JSON.stringify(ev) + "\n");
    });

    it("appends multiple events in order", () => {
      const art = artifactPath(root, "a");
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      const content = readFileSync(art.statusFile, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe("started");
      expect(JSON.parse(lines[1]).exitCode).toBe(0);
    });

    it("creates the status file with 0o600 perms", () => {
      const art = artifactPath(root, "a");
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      expect(statSync(art.statusFile).mode & 0o777).toBe(0o600);
    });
  });

  describe("writeOutput", () => {
    it("writes content atomically (no .tmp left behind)", () => {
      const art = artifactPath(root, "a");
      writeOutput(art, "hello world");
      expect(existsSync(art.outputFile)).toBe(true);
      expect(existsSync(art.outputFile + ".tmp")).toBe(false);
      expect(readFileSync(art.outputFile, "utf8")).toBe("hello world");
    });

    it("overwrites previous content", () => {
      const art = artifactPath(root, "a");
      writeOutput(art, "first");
      writeOutput(art, "second");
      expect(readFileSync(art.outputFile, "utf8")).toBe("second");
    });

    it("creates the output file with 0o600 perms", () => {
      const art = artifactPath(root, "a");
      writeOutput(art, "secret");
      expect(statSync(art.outputFile).mode & 0o777).toBe(0o600);
    });
  });

  describe("readEvents", () => {
    it("returns empty array when no status file", () => {
      const art = artifactPath(root, "missing");
      expect(readEvents(art)).toEqual([]);
    });

    it("parses all events in order", () => {
      const art = artifactPath(root, "a");
      appendEvent(art, { ts: 100, type: "started", status: "running" });
      appendEvent(art, {
        ts: 200,
        type: "error",
        status: "error",
        message: "m",
      });
      const events = readEvents(art);
      expect(events).toHaveLength(2);
      expect(events[0].ts).toBe(100);
      expect(events[1].message).toBe("m");
    });

    it("filters by `since` (inclusive)", () => {
      const art = artifactPath(root, "a");
      appendEvent(art, { ts: 100, type: "started", status: "running" });
      appendEvent(art, { ts: 300, type: "done", status: "done", exitCode: 0 });
      const events = readEvents(art, 200);
      expect(events.map((e) => e.ts)).toEqual([300]);
    });

    it("silently skips malformed lines", () => {
      const art = artifactPath(root, "a");
      ensureArtifactDir(art);
      appendFileSync(
        art.statusFile,
        '{"ts":1,"type":"started","status":"running"}\n',
      );
      appendFileSync(art.statusFile, "this is not json\n");
      appendFileSync(
        art.statusFile,
        '{"ts":2,"type":"done","status":"done","exitCode":0}\n',
      );
      const events = readEvents(art);
      expect(events).toHaveLength(2);
    });

    it("normalizes malformed object fields and bounds adversarial text", () => {
      const art = artifactPath(root, "bounded");
      ensureArtifactDir(art);
      appendFileSync(
        art.statusFile,
        [
          JSON.stringify({
            version: 2,
            eventId: "e".repeat(10_000),
            turnId: { bad: true },
            ts: 1,
            type: "completion",
            status: { bad: true },
            outcome: "error",
            source: "agent_settled",
            message: { bad: true },
            errorMessage: ["bad"],
            summary: "s".repeat(10_000),
          }),
          JSON.stringify({
            version: 2,
            eventId: "tool-event",
            turnId: "turn",
            ts: 2,
            type: "tool_activity",
            phase: "start",
            tool: "t".repeat(10_000),
            summary: "s".repeat(10_000),
          }),
          JSON.stringify({
            version: 2,
            eventId: "bad",
            turnId: "turn",
            ts: 3,
            type: "completion",
            outcome: { bad: true },
            source: "explicit",
          }),
        ].join("\n") + "\n",
      );

      const records = readEventRecords(art);
      expect(records).toHaveLength(2);
      const completion = records[0].event as any;
      expect(completion.eventId).toMatch(/^invalid-event-/);
      expect(completion.turnId).toMatch(/^invalid-turn-/);
      expect(completion.message).toBeUndefined();
      expect(completion.errorMessage).toBeUndefined();
      expect(completion.summary).toHaveLength(MAX_EVENT_TEXT_LENGTH);
      const activity = records[1].event as any;
      expect(activity.tool).toHaveLength(MAX_TOOL_NAME_LENGTH);
      expect(activity.summary).toHaveLength(MAX_EVENT_TEXT_LENGTH);
    });
  });

  it("reads long logs in bounded physical batches", () => {
    const art = artifactPath(root, "long-log");
    ensureArtifactDir(art);
    const line =
      JSON.stringify({ ts: 1, type: "tool_activity", status: "running" }) +
      "\n";
    const count = Math.ceil((MAX_EVENT_BATCH_BYTES * 3) / line.length);
    appendFileSync(art.statusFile, line.repeat(count));
    const eof = eventLogEndOffset(art);
    let cursor = 0;
    let records = 0;
    let batches = 0;
    while (cursor < eof) {
      const batch = readEventBatch(art, cursor);
      expect(batch.endOffset - cursor).toBeLessThanOrEqual(
        MAX_EVENT_BATCH_BYTES,
      );
      expect(batch.endOffset).toBeGreaterThan(cursor);
      cursor = batch.endOffset;
      records += batch.records.length;
      batches++;
    }
    expect(batches).toBeGreaterThan(1);
    expect(records).toBe(count);
  });

  it("does not skip a valid event larger than the physical batch size", () => {
    const art = artifactPath(root, "oversized-event");
    ensureArtifactDir(art);
    const event = {
      version: 2,
      eventId: "oversized-completion",
      turnId: "oversized-turn",
      ts: 1,
      type: "completion",
      outcome: "error",
      source: "agent_settled",
      errorMessage: "x".repeat(MAX_EVENT_BATCH_BYTES + 1024),
    };
    writeFileSync(art.statusFile, JSON.stringify(event) + "\n");

    const events = readEvents(art);

    expect(events).toHaveLength(1);
    expect((events[0] as any).eventId).toBe("oversized-completion");
  });

  it("bounds first-party completion text so the record remains readable", () => {
    const art = artifactPath(root, "bounded-completion");
    const event = appendCompletionEvent(art, {
      turnId: "bounded-turn",
      outcome: "error",
      source: "agent_settled",
      message: "m".repeat(MAX_EVENT_TEXT_LENGTH + 10),
      errorMessage: "e".repeat(MAX_EVENT_TEXT_LENGTH + 10),
    });

    expect(event?.message).toBe("m".repeat(MAX_EVENT_TEXT_LENGTH));
    expect(event?.errorMessage).toBe("e".repeat(MAX_EVENT_TEXT_LENGTH));
    expect(readEvents(art)).toContainEqual(event);
  });

  it("reports one deterministic issue for an oversized physical record", () => {
    const art = artifactPath(root, "ultra-oversized-event");
    ensureArtifactDir(art);
    const event = {
      version: 2,
      eventId: "ultra-oversized-completion",
      turnId: "ultra-oversized-turn",
      ts: 1,
      type: "completion",
      outcome: "done",
      source: "agent_settled",
      errorMessage: "x".repeat(MAX_EVENT_RECORD_BYTES + 1024),
    };
    writeFileSync(art.statusFile, JSON.stringify(event) + "\n");

    const first = readEventBatch(art, 0);

    const expectedEnd = statSync(art.statusFile).size;
    expect(first.records).toEqual([]);
    expect(first.issues).toEqual([
      {
        kind: "record_too_large",
        startOffset: 0,
        endOffset: expectedEnd,
        maxBytes: MAX_EVENT_RECORD_BYTES,
      },
    ]);
    expect(first.endOffset).toBe(expectedEnd);
    expect(readEventBatch(art, first.endOffset)).toEqual({
      records: [],
      issues: [],
      endOffset: expectedEnd,
    });
  });

  describe("readOutput", () => {
    it("returns null when output.md doesn't exist", () => {
      const art = artifactPath(root, "a");
      expect(readOutput(art)).toBeNull();
    });

    it("returns content when present", () => {
      const art = artifactPath(root, "a");
      writeOutput(art, "the result");
      expect(readOutput(art)).toBe("the result");
    });
  });

  describe("listArtifacts", () => {
    it("returns empty when root is missing", () => {
      expect(listArtifacts(join(root, "nope"))).toEqual([]);
    });

    it("returns empty when root is empty", () => {
      expect(listArtifacts(root)).toEqual([]);
    });

    it("lists subdirs as artifacts, ignores loose files", () => {
      mkdirSync(join(root, "id1"));
      mkdirSync(join(root, "id2"));
      writeFileSync(join(root, "stray.txt"), "ignore me");
      const arts = listArtifacts(root);
      expect(arts.map((a) => a.id).sort()).toEqual(["id1", "id2"]);
    });

    it("each entry has the expected paths", () => {
      mkdirSync(join(root, "id1"));
      const arts = listArtifacts(root);
      expect(arts[0].statusFile).toBe(join(root, "id1", "events.ndjson"));
      expect(arts[0].outputFile).toBe(join(root, "id1", "output.md"));
    });
  });

  describe("lastEvent", () => {
    it("returns null when no events", () => {
      expect(lastEvent(artifactPath(root, "a"))).toBeNull();
    });

    it("returns the most recent event", () => {
      const art = artifactPath(root, "a");
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 9, type: "done", status: "done", exitCode: 0 });
      expect(lastEvent(art)?.ts).toBe(9);
      expect(lastEvent(art)?.type).toBe("done");
    });
  });

  describe("per-turn snapshots (output-N.md)", () => {
    it("snapshotOutput copies the current output.md into output-N.md", () => {
      const art = artifactPath(root, "snap1");
      writeOutput(art, "first turn's answer");
      snapshotOutput(art, 1);
      expect(existsSync(outputPathForTurn(art, 1))).toBe(true);
      expect(readOutputForTurn(art, 1)).toBe("first turn's answer");
      // output.md is untouched (it's the source).
      expect(readOutput(art)).toBe("first turn's answer");
    });

    it("preserves history across multiple snapshots — earlier turns aren't overwritten", () => {
      const art = artifactPath(root, "snap2");
      // Turn 1
      writeOutput(art, "answer v1");
      snapshotOutput(art, 1);
      // Turn 2: child overwrites output.md, poller snapshots again
      writeOutput(art, "answer v2");
      snapshotOutput(art, 2);
      // Turn 3
      writeOutput(art, "answer v3");
      snapshotOutput(art, 3);

      expect(readOutputForTurn(art, 1)).toBe("answer v1");
      expect(readOutputForTurn(art, 2)).toBe("answer v2");
      expect(readOutputForTurn(art, 3)).toBe("answer v3");
      // Latest output.md is v3.
      expect(readOutput(art)).toBe("answer v3");
    });

    it("readOutputForTurn returns null when the snapshot doesn't exist", () => {
      const art = artifactPath(root, "snap3");
      writeOutput(art, "v1");
      snapshotOutput(art, 1);
      expect(readOutputForTurn(art, 2)).toBe(null);
      expect(readOutputForTurn(art, 99)).toBe(null);
    });

    it("snapshotOutput is a no-op when output.md is missing", () => {
      const art = artifactPath(root, "snap4");
      // No writeOutput call — output.md doesn't exist.
      snapshotOutput(art, 1);
      expect(existsSync(outputPathForTurn(art, 1))).toBe(false);
    });

    it("snapshotOutput does not read or copy oversized output.md", () => {
      const art = artifactPath(root, "snap-oversized");
      ensureArtifactDir(art);
      writeFileSync(
        art.outputFile,
        Buffer.alloc(MAX_OUTPUT_SNAPSHOT_BYTES + 1, 120),
      );

      snapshotOutput(art, 1);

      expect(existsSync(outputPathForTurn(art, 1))).toBe(false);
    });

    it("listOutputTurns returns the turn numbers for which a snapshot exists, sorted", () => {
      const art = artifactPath(root, "snap5");
      writeOutput(art, "a");
      snapshotOutput(art, 2); // out of order to verify sort
      writeOutput(art, "b");
      snapshotOutput(art, 1);
      writeOutput(art, "c");
      snapshotOutput(art, 3);
      expect(listOutputTurns(art)).toEqual([1, 2, 3]);
    });

    it("listOutputTurns returns [] when the artifact dir doesn't exist", () => {
      const art = artifactPath(root, "snap6-nonexistent");
      expect(listOutputTurns(art)).toEqual([]);
    });
  });

  it("listOutputTurns returns [] when the artifact dir doesn't exist", () => {
    const art = artifactPath(root, "snap6-nonexistent");
    expect(listOutputTurns(art)).toEqual([]);
  });

  describe("cleanupOldArtifacts", () => {
    let root: string;

    beforeEach(() => {
      root = makeTmp();
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function makeArtifact(id: string, mtimeAgoMs: number): string {
      const dir = artifactPath(root, id);
      ensureArtifactDir(dir);
      // Set mtime to a specific time
      const mtime = new Date(Date.now() - mtimeAgoMs);
      statSync(dir.dir); // ensure it exists
      // Write events.ndjson to set up the artifact
      writeOutput(dir, "result");
      return dir.dir;
    }

    function setDirMtime(dir: string, mtimeAgoMs: number): void {
      const time = new Date(Date.now() - mtimeAgoMs);
      utimesSync(dir, time, time);
    }

    it("returns zero when rootDir is empty", () => {
      const result = cleanupOldArtifacts(root, 60_000, { now: Date.now() });
      expect(result.removed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("returns zero when rootDir does not exist", () => {
      const result = cleanupOldArtifacts(join(root, "missing"), 60_000, {
        now: Date.now(),
      });
      expect(result.removed).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("rejects empty rootDir with an error", () => {
      const result = cleanupOldArtifacts("", 60_000);
      expect(result.removed).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/empty/);
    });

    it("rejects filesystem root (/) as rootDir", () => {
      const result = cleanupOldArtifacts("/", 60_000);
      expect(result.removed).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      // fs root is blocked
      expect(result.errors[0]).toMatch(/filesystem root/);
    });

    it("deletes old artifact dirs past TTL", () => {
      const old1dir = makeArtifact("old1", 200_000);
      const old2dir = makeArtifact("old2", 200_000);

      // Use a far-future `now` so that freshly-created dirs appear old (mtime < cutoff).
      const futureNow = Date.now() + 1_000_000;
      const result = cleanupOldArtifacts(root, 100_000, { now: futureNow });

      expect(result.removed).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
      // old dirs are deleted
      expect(existsSync(old1dir)).toBe(false);
      expect(existsSync(old2dir)).toBe(false);
    });

    it("preserves artifact dirs with activeIds", () => {
      makeArtifact("active1", 200_000);
      makeArtifact("inactive1", 200_000);

      // Far-future now so both appear old; activeIds protects 'active1'.
      const futureNow = Date.now() + 1_000_000;
      const result = cleanupOldArtifacts(root, 60_000, {
        activeIds: new Set(["active1"]),
        now: futureNow,
      });

      expect(result.removed).toBe(1);
      expect(result.skipped).toBe(1); // active1 skipped
      expect(existsSync(artifactPath(root, "active1").dir)).toBe(true);
      expect(existsSync(artifactPath(root, "inactive1").dir)).toBe(false);
    });

    it("dry run does not delete any directories", () => {
      makeArtifact("old1", 200_000);
      makeArtifact("old2", 200_000);

      const futureNow = Date.now() + 1_000_000;
      const result = cleanupOldArtifacts(root, 60_000, {
        dryRun: true,
        now: futureNow,
      });

      expect(result.removed).toBe(2);
      expect(result.dryRun).toBe(true);
      // Directories still exist
      expect(existsSync(artifactPath(root, "old1").dir)).toBe(true);
      expect(existsSync(artifactPath(root, "old2").dir)).toBe(true);
    });

    it("preserves artifacts with recent event timestamps even when dir mtime is old", () => {
      const old = makeArtifact("old-but-recent-event", 200_000);
      const art = artifactPath(root, "old-but-recent-event");
      // Append a recent event (within TTL)
      appendEvent(art, { ts: Date.now(), type: "started", status: "running" });

      const result = cleanupOldArtifacts(root, 100_000, {
        now: Date.now() + 50_000, // make mtime and dir old
      });

      // The recent event (ts = Date.now()) is < now+50k, so cutoff = now+50k-100k
      // Wait — this is confusing. Let me be explicit:
      // If now = Date.now() + 50000 and ttl = 100000, cutoff = now - 100000 = Date.now() - 50000
      // The event ts = Date.now() which is >= cutoff, so it's recent
      expect(result.skipped).toBe(1);
      expect(result.removed).toBe(0);
    });

    it("prevents path traversal via realpath check", () => {
      // Create a dir inside root with a symlink pointing outside
      const outsideDir = join(root, "../outside");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.txt"), "leaked");

      const symlinkDir = join(root, "evil-link");
      symlinkSync(outsideDir, symlinkDir);

      const result = cleanupOldArtifacts(root, 60_000, {
        now: Date.now(),
      });

      // Symlink should be detected as path traversal
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/path traversal/);
      expect(result.removed).toBe(0);
      // Outside dir must not be deleted
      expect(existsSync(outsideDir)).toBe(true);
      expect(existsSync(join(outsideDir, "secret.txt"))).toBe(true);
    });

    it("skips loose files in the artifact root", () => {
      writeFileSync(join(root, "stray.txt"), "not a dir");
      makeArtifact("old1", 200_000);

      const futureNow = Date.now() + 1_000_000;
      const result = cleanupOldArtifacts(root, 100_000, {
        now: futureNow,
      });

      expect(result.removed).toBe(1);
      expect(result.errors).toEqual([]);
      // Stray file should still exist
      expect(existsSync(join(root, "stray.txt"))).toBe(true);
    });

    it("dryRun flag is reflected in the result", () => {
      const live = cleanupOldArtifacts(root, 60_000, { dryRun: true });
      expect(live.dryRun).toBe(true);

      const real = cleanupOldArtifacts(root, 60_000, { dryRun: false });
      expect(real.dryRun).toBe(false);

      const defaultResult = cleanupOldArtifacts(root, 60_000);
      expect(defaultResult.dryRun).toBe(false);
    });

    it("preserves nested cwdLabel/artifacts layout and active IDs", () => {
      const sessionRoot = join(root, "sessions", "subagentura");
      const activeArt = artifactPath(
        join(sessionRoot, "project-a-123", "artifacts"),
        "active1",
      );
      const staleArt = artifactPath(
        join(sessionRoot, "project-b-456", "artifacts"),
        "old1",
      );

      for (const art of [activeArt, staleArt]) {
        ensureArtifactDir(art);
        appendEvent(art, {
          ts: Date.now(),
          type: "started",
          status: "running",
        });
        writeOutput(art, "result");
      }

      const futureNow = Date.now() + 1_000_000;
      const result = cleanupOldArtifacts(sessionRoot, 100_000, {
        activeIds: new Set(["active1"]),
        now: futureNow,
      });

      expect(result.removed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual([]);
      expect(existsSync(join(sessionRoot, "project-a-123"))).toBe(true);
      expect(existsSync(join(sessionRoot, "project-a-123", "artifacts"))).toBe(
        true,
      );
      expect(existsSync(activeArt.dir)).toBe(true);
      expect(existsSync(join(sessionRoot, "project-b-456"))).toBe(true);
      expect(existsSync(join(sessionRoot, "project-b-456", "artifacts"))).toBe(
        true,
      );
      expect(existsSync(staleArt.dir)).toBe(false);
    });

    it("cleans root-level flat artifact dirs alongside nested cwdLabel artifacts", () => {
      const sessionRoot = join(root, "sessions", "subagentura");
      const nestedActive = artifactPath(
        join(sessionRoot, "project-a-123", "artifacts"),
        "active1",
      );
      const nestedOld = artifactPath(
        join(sessionRoot, "project-b-456", "artifacts"),
        "old1",
      );
      const flatOld = artifactPath(sessionRoot, "flat-old");

      const oldTs = Date.now() - 200_000;
      for (const art of [nestedActive, nestedOld, flatOld]) {
        ensureArtifactDir(art);
        appendEvent(art, {
          ts: oldTs,
          type: "started",
          status: "running",
        });
        writeOutput(art, "result");
        setDirMtime(art.dir, 200_000);
      }

      const result = cleanupOldArtifacts(sessionRoot, 100_000, {
        activeIds: new Set(["active1"]),
        now: Date.now(),
      });

      expect(result.removed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual([]);
      expect(existsSync(nestedActive.dir)).toBe(true);
      expect(existsSync(nestedOld.dir)).toBe(false);
      expect(existsSync(flatOld.dir)).toBe(false);
    });

    it("does not delete bare cwdLabel dirs without an artifacts child", () => {
      const sessionRoot = join(root, "sessions", "subagentura");
      const bareCwdLabel = join(sessionRoot, "project-a-123");
      mkdirSync(bareCwdLabel, { recursive: true });
      setDirMtime(bareCwdLabel, 200_000);

      const result = cleanupOldArtifacts(sessionRoot, 100_000, {
        now: Date.now(),
      });

      expect(result.removed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
      expect(existsSync(bareCwdLabel)).toBe(true);
    });
  });
});

describe("persisted interactive state helpers", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmp();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const LEGACY_SAMPLE: InteractiveSubagentPersistedStateV2 = {
    id: "abc12345",

    paneId: "%42",

    windowName: "demo",

    mux: "tmux",

    artifactDir: "/tmp/artifacts/abc12345",

    sessionFile: "/tmp/session.jsonl",

    notifyOnComplete: "inject",
    eventByteCursor: 0,
    sessionByteCursor: 0,
    pendingDeliveries: [],
    deliveryReceipts: [],
    legacyCutoverOffset: 0,
  };
  const SAMPLE: InteractiveSubagentPersistedState = {
    ...LEGACY_SAMPLE,
    completionOwner: "standalone",
  };

  it("does not steal a stale-looking lock owned by a live process", () => {
    const piDir = join(root, ".pi");
    const lock = join(piDir, "subagentura-state.lock");
    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    const metadata = JSON.stringify({ pid: process.pid, token: "live-owner" });
    writeFileSync(lock, metadata, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(() => withInteractiveStateLock(root, () => undefined)).toThrow(
      /timed out acquiring interactive state lock/,
    );
    expect(readFileSync(lock, "utf8")).toBe(metadata);
  });

  it("does not unlink a replacement lock during owner cleanup", () => {
    const piDir = join(root, ".pi");
    const lock = join(piDir, "subagentura-state.lock");
    const replacement = JSON.stringify({
      pid: process.pid,
      token: "replacement",
    });
    withInteractiveStateLock(root, () => {
      rmSync(lock);
      writeFileSync(lock, replacement, { mode: 0o600 });
    });
    expect(readFileSync(lock, "utf8")).toBe(replacement);
  });

  it("fails closed when a recovery claim already exists", () => {
    const piDir = join(root, ".pi");
    const lock = join(piDir, "subagentura-state.lock");
    const recoveryLock = `${lock}.recovery`;
    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    const deadOwner = JSON.stringify({ pid: 999_999_999, token: "dead" });
    const existingRecovery = JSON.stringify({
      pid: 999_999_999,
      token: "recovery-owner",
    });
    writeFileSync(lock, deadOwner, { mode: 0o600 });
    writeFileSync(recoveryLock, existingRecovery, { mode: 0o600 });
    expect(() => withInteractiveStateLock(root, () => undefined)).toThrow(
      /timed out acquiring interactive state lock/,
    );
    expect(readFileSync(lock, "utf8")).toBe(deadOwner);
    expect(readFileSync(recoveryLock, "utf8")).toBe(existingRecovery);
  });

  it("stateFilePath returns <cwd>/.pi/subagentura-state.json", () => {
    expect(stateFilePath(root)).toBe(
      join(root, ".pi", "subagentura-state.json"),
    );
  });

  it("saveInteractiveStates + loadInteractiveStates round-trips a state file", () => {
    saveInteractiveStates(root, {
      schemaVersion: 3,
      parent: "pi",
      states: { abc12345: SAMPLE },
    });

    const loaded = loadInteractiveStates(root);

    expect(loaded).toEqual({
      schemaVersion: 3,
      parent: "pi",
      states: { abc12345: SAMPLE },
    });
  });

  it("loadInteractiveStates returns null when the file is missing", () => {
    expect(loadInteractiveStates(root)).toBeNull();
  });

  it("loadInteractiveStates returns null when the JSON is malformed", () => {
    const file = stateFilePath(root);

    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });

    writeFileSync(file, "not-json{", { mode: 0o600 });

    expect(loadInteractiveStates(root)).toBeNull();
  });

  it("loadInteractiveStates returns null when schemaVersion is not 1", () => {
    const file = stateFilePath(root);

    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });

    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 99, parent: "pi", states: {} }),
      { mode: 0o600 },
    );

    expect(loadInteractiveStates(root)).toBeNull();
  });

  it("loadInteractiveStates migrates a file with no schemaVersion field", () => {
    const file = stateFilePath(root);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify({ parent: "pi", states: { abc12345: LEGACY_SAMPLE } }),
      { mode: 0o600 },
    );
    const loaded = loadInteractiveStates(root);
    expect(loaded).toEqual({
      schemaVersion: 3,
      parent: "pi",
      states: { abc12345: SAMPLE },
    });
  });

  it("loadInteractiveStates migrates a file with schemaVersion 0", () => {
    const file = stateFilePath(root);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 0,
        parent: "pi",
        states: { abc12345: LEGACY_SAMPLE },
      }),
      { mode: 0o600 },
    );
    const loaded = loadInteractiveStates(root);
    expect(loaded).toEqual({
      schemaVersion: 3,
      parent: "pi",
      states: { abc12345: SAMPLE },
    });
  });

  it("loadInteractiveStates migrates a file with schemaVersion -1", () => {
    const file = stateFilePath(root);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: -1,
        parent: "pi",
        states: { abc12345: LEGACY_SAMPLE },
      }),
      { mode: 0o600 },
    );
    const loaded = loadInteractiveStates(root);
    expect(loaded).toEqual({
      schemaVersion: 3,
      parent: "pi",
      states: { abc12345: SAMPLE },
    });
  });

  it("loadInteractiveStates returns empty states when the file exists but has no states key", () => {
    const file = stateFilePath(root);

    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });

    writeFileSync(file, JSON.stringify({ schemaVersion: 1, parent: "pi" }), {
      mode: 0o600,
    });

    const loaded = loadInteractiveStates(root);

    expect(loaded).toEqual({ schemaVersion: 3, parent: "pi", states: {} });
  });

  it("skips malformed v1 entries and normalizes untrusted fields", () => {
    const file = stateFilePath(root);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    const validIntent = {
      deliveryId: "delivery",
      subagentId: SAMPLE.id,
      turnId: "turn",
      eventId: "event",
      mode: "notify",
      triggerTurn: false,
      status: "done",
      artifactDir: SAMPLE.artifactDir,
      state: "queued",
    };
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        parent: "pi",
        states: {
          wrongId: { ...SAMPLE, id: "different" },
          badArtifact: { ...SAMPLE, id: "badArtifact", artifactDir: 42 },
          [SAMPLE.id]: {
            ...SAMPLE,
            eventByteCursor: "not-a-number",
            sessionByteCursor: -10,
            pendingDeliveries: [null, { nope: true }, validIntent],
            deliveryReceipts: ["one", "one", 42, "two"],
          },
        },
      }),
      { mode: 0o600 },
    );

    expect(() => loadInteractiveStates(root)).not.toThrow();
    const loaded = loadInteractiveStates(root)!;
    expect(Object.keys(loaded.states)).toEqual([SAMPLE.id]);
    expect(loaded.states[SAMPLE.id].eventByteCursor).toBe(0);
    expect(loaded.states[SAMPLE.id].sessionByteCursor).toBe(0);
    expect(loaded.states[SAMPLE.id].pendingDeliveries).toEqual([validIntent]);
    expect(loaded.states[SAMPLE.id].deliveryReceipts).toEqual(["one", "two"]);
  });

  it("skips malformed v2 state and intent shapes without throwing", () => {
    const file = stateFilePath(root);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        parent: "pi",
        states: {
          [SAMPLE.id]: {
            ...SAMPLE,
            artifactDir: "relative/artifact",
            pendingDeliveries: "not-an-array",
          },
          arrayEntry: [],
          primitiveEntry: "bad",
        },
      }),
      { mode: 0o600 },
    );

    expect(() => loadInteractiveStates(root)).not.toThrow();
    expect(loadInteractiveStates(root)?.states).toEqual({});
  });

  it("uses EOF cutover for v1 but zero for missing or invalid v2 cursor", () => {
    const art = artifactPath(join(root, "artifacts"), SAMPLE.id);
    ensureArtifactDir(art);
    appendEvent(art, { ts: 1, type: "done", status: "done" });
    const eof = statSync(art.statusFile).size;
    const file = stateFilePath(root);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        parent: "pi",
        states: {
          [SAMPLE.id]: {
            ...SAMPLE,
            artifactDir: art.dir,
            eventByteCursor: "invalid",
            legacyCutoverOffset: "invalid",
          },
        },
      }),
    );
    expect(loadInteractiveStates(root)?.states[SAMPLE.id]).toMatchObject({
      eventByteCursor: eof,
      legacyCutoverOffset: eof,
    });

    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        parent: "pi",
        states: {
          [SAMPLE.id]: {
            ...SAMPLE,
            artifactDir: art.dir,
            eventByteCursor: "invalid",
            legacyCutoverOffset: "invalid",
          },
        },
      }),
    );
    expect(loadInteractiveStates(root)?.states[SAMPLE.id]).toMatchObject({
      eventByteCursor: 0,
      legacyCutoverOffset: 0,
    });
  });

  it("saveInteractiveStates creates the .pi/ directory if missing (mode 0o700)", () => {
    expect(existsSync(join(root, ".pi"))).toBe(false);

    saveInteractiveStates(root, {
      schemaVersion: 1,
      parent: "pi",
      states: {},
    });

    expect(existsSync(join(root, ".pi"))).toBe(true);

    if (process.platform !== "win32") {
      expect(statSync(join(root, ".pi")).mode & 0o777).toBe(0o700);
    }
  });

  it("saveInteractiveStates writes atomically (no torn writes)", () => {
    saveInteractiveStates(root, {
      schemaVersion: 1,
      parent: "pi",
      states: { abc12345: SAMPLE },
    });

    expect(existsSync(stateFilePath(root) + ".tmp")).toBe(false);

    expect(existsSync(stateFilePath(root))).toBe(true);
  });

  it("saveInteractiveStates rejects an unknown future schema", () => {
    expect(() =>
      saveInteractiveStates(root, {
        schemaVersion: 4 as any,
        parent: "pi",
        states: {},
      }),
    ).toThrow(/unsupported schemaVersion/);
  });

  it("appendInteractiveState adds a new entry to an existing file", () => {
    saveInteractiveStates(root, {
      schemaVersion: 1,
      parent: "pi",
      states: {},
    });

    appendInteractiveState(root, SAMPLE);

    expect(loadInteractiveStates(root)?.states["abc12345"]).toEqual(SAMPLE);
  });

  it("appendInteractiveState creates a fresh file if none exists", () => {
    expect(existsSync(stateFilePath(root))).toBe(false);

    appendInteractiveState(root, SAMPLE);

    const loaded = loadInteractiveStates(root);

    expect(loaded?.parent).toBe("pi");

    expect(loaded?.states["abc12345"]).toEqual(SAMPLE);
  });

  it("appendInteractiveState overwrites an entry with the same id", () => {
    appendInteractiveState(root, SAMPLE);

    const updated = { ...SAMPLE, paneId: "%99" };

    appendInteractiveState(root, updated);

    expect(loadInteractiveStates(root)?.states["abc12345"]?.paneId).toBe("%99");
  });

  it("preserves updates from concurrent parents using the same cwd", () => {
    saveInteractiveStates(root, {
      schemaVersion: 3,
      parent: "pi",
      states: {},
    });
    const firstParent = loadInteractiveStates(root)!;
    const secondParent = loadInteractiveStates(root)!;
    firstParent.states.aaaaaaaa = {
      ...SAMPLE,
      id: "aaaaaaaa",
      artifactDir: "/tmp/artifacts/aaaaaaaa",
      parentSessionId: "parent-a",
    };
    secondParent.states.bbbbbbbb = {
      ...SAMPLE,
      id: "bbbbbbbb",
      artifactDir: "/tmp/artifacts/bbbbbbbb",
      parentSessionId: "parent-b",
    };

    saveInteractiveStates(root, firstParent);
    saveInteractiveStates(root, secondParent);

    expect(Object.keys(loadInteractiveStates(root)!.states).sort()).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
  });

  it("removeInteractiveState drops the entry by id", () => {
    appendInteractiveState(root, SAMPLE);

    appendInteractiveState(root, {
      ...SAMPLE,
      id: "def67890",
      artifactDir: "/tmp/artifacts/def67890",
    });

    removeInteractiveState(root, "abc12345");

    const loaded = loadInteractiveStates(root);

    expect(loaded?.states["abc12345"]).toBeUndefined();

    expect(loaded?.states["def67890"]).toBeDefined();
  });

  it("removeInteractiveState is a no-op when the entry is absent", () => {
    appendInteractiveState(root, SAMPLE);

    removeInteractiveState(root, "nonexistent");

    expect(loadInteractiveStates(root)?.states["abc12345"]).toEqual(SAMPLE);
  });

  it("removeInteractiveState on a missing file does not throw", () => {
    expect(() => removeInteractiveState(root, "abc12345")).not.toThrow();
  });

  it("the saved file mode is 0o600 (best-effort on POSIX)", () => {
    appendInteractiveState(root, SAMPLE);

    if (process.platform !== "win32") {
      expect(statSync(stateFilePath(root)).mode & 0o777).toBe(0o600);
    }
  });

  it("deleteInteractiveStatesFile removes the file", () => {
    appendInteractiveState(root, SAMPLE);

    deleteInteractiveStatesFile(root);

    expect(existsSync(stateFilePath(root))).toBe(false);
  });

  it("deleteInteractiveStatesFile is a no-op when the file is absent", () => {
    expect(() => deleteInteractiveStatesFile(root)).not.toThrow();
  });
});

describe("SubagentEvent classification matrix", () => {
  const baseTs = 1000;
  const events = {
    started: { ts: baseTs, type: "started", status: "running" },
    tool_activity: { ts: baseTs, type: "tool_activity", status: "running" },
    done: { ts: baseTs, type: "done", status: "done" },
    error: { ts: baseTs, type: "error", status: "error" },
    cancelled: { ts: baseTs, type: "cancelled", status: "cancelled" },
    turn_started: {
      version: 2,
      eventId: "e-turn",
      turnId: "t-turn",
      ts: baseTs,
      type: "turn_started",
      status: "running",
    },
    completion: {
      version: 2,
      eventId: "e-completion",
      turnId: "t-completion",
      ts: baseTs,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "explicit",
    },
    process_exited: {
      version: 2,
      eventId: "e-exit",
      turnId: "t-exit",
      ts: baseTs,
      type: "process_exited",
      status: "done",
      exitCode: 0,
    },
  } satisfies Record<SubagentEvent["type"], SubagentEvent>;

  const expected = {
    started: { terminal: false, completion: false, settled: false },
    tool_activity: { terminal: false, completion: false, settled: false },
    done: { terminal: true, completion: true, settled: true },
    error: { terminal: true, completion: true, settled: true },
    cancelled: { terminal: true, completion: true, settled: true },
    turn_started: { terminal: false, completion: false, settled: false },
    completion: { terminal: true, completion: true, settled: true },
    process_exited: { terminal: false, completion: false, settled: true },
  } satisfies Record<
    SubagentEvent["type"],
    { terminal: boolean; completion: boolean; settled: boolean }
  >;

  it("classifies every event discriminant", () => {
    for (const type of Object.keys(events) as Array<SubagentEvent["type"]>) {
      const event = events[type];
      const result = expected[type];
      expect(isTurnTerminal(event)).toBe(result.terminal);
      expect(isCompletionEvent(event)).toBe(result.completion);
      expect(isArtifactOutputSettled(event)).toBe(result.settled);
    }
  });
});

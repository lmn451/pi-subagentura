import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ORCHESTRATOR_ROUTING_ALIASES,
  MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
  MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  MAX_ORCHESTRATOR_ROUTING_FILE_BYTES,
  MAX_ORCHESTRATOR_ROUTING_RECORDS,
  ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
  listOrchestratorRoutingEntries,
  loadOrchestratorRoutingOverlay,
  orchestratorRoutingFilePath,
  routingProjectId,
  saveOrchestratorRoutingEntries,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntryInput,
} from "../src/orchestrator-routing";
import { importFresh } from "./test-utils";

const CHILD_A = "0123456789abcdef";
const CHILD_B = "fedcba9876543210";
const UPDATED_AT = "2026-08-20T14:49:08.446Z";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-routing-"));
}

function entry(
  overrides: Partial<OrchestratorRoutingEntryInput> = {},
): OrchestratorRoutingEntryInput {
  return {
    childId: CHILD_A,
    description: "Own the TypeScript API implementation",
    aliases: ["api", "typescript"],
    provenance: "user",
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("orchestrator routing metadata persistence", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmp();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the project-local path and round-trips only routing metadata", () => {
    const file = orchestratorRoutingFilePath(root);
    const saved = upsertOrchestratorRoutingEntry(root, entry());

    expect(file).toBe(join(root, ".pi", "subagentura-routing.json"));
    expect(saved).toEqual({
      schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
      projectId: routingProjectId(root),
      records: [entry()],
    });
    expect(loadOrchestratorRoutingOverlay(root)).toEqual({
      status: "loaded",
      overlay: saved,
    });
    expect(listOrchestratorRoutingEntries(root)).toEqual([entry()]);

    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted).toEqual(saved);
    expect(JSON.stringify(persisted)).not.toMatch(
      /paneId|muxSession|lifecycle|liveness|output|delivery|artifact|ownershipEpoch|finding|assignment|investigation/i,
    );
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("distinguishes missing and empty metadata from invalid data", () => {
    const file = orchestratorRoutingFilePath(root);

    expect(loadOrchestratorRoutingOverlay(root)).toEqual({ status: "missing" });

    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(file, " \n\t", { mode: 0o600 });
    expect(loadOrchestratorRoutingOverlay(root)).toEqual({
      status: "empty",
      overlay: {
        schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
        projectId: routingProjectId(root),
        records: [],
      },
    });

    saveOrchestratorRoutingEntries(root, []);
    expect(loadOrchestratorRoutingOverlay(root)).toEqual({
      status: "empty",
      overlay: {
        schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
        projectId: routingProjectId(root),
        records: [],
      },
    });
  });

  it("writes atomically and reloads merged records after a fresh import", async () => {
    upsertOrchestratorRoutingEntry(root, entry());
    upsertOrchestratorRoutingEntry(
      root,
      entry({
        childId: CHILD_B,
        description: "Own the persistence tests",
        aliases: ["tests"],
        provenance: "luna",
      }),
    );

    const piFiles = readdirSync(join(root, ".pi"));
    expect(piFiles).toEqual(["subagentura-routing.json"]);

    const fresh = await importFresh<
      typeof import("../src/orchestrator-routing")
    >("../src/orchestrator-routing");
    expect(fresh.listOrchestratorRoutingEntries(root)).toEqual([
      entry(),
      entry({
        childId: CHILD_B,
        description: "Own the persistence tests",
        aliases: ["tests"],
        provenance: "luna",
      }),
    ]);
  });

  it("fails closed on malformed metadata without overwriting it", () => {
    const file = orchestratorRoutingFilePath(root);
    const malformed = '{"schemaVersion":1,"records":[';
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(file, malformed, { mode: 0o600 });

    expect(loadOrchestratorRoutingOverlay(root)).toMatchObject({
      status: "malformed",
    });
    expect(() => upsertOrchestratorRoutingEntry(root, entry())).toThrow(
      /malformed routing metadata/,
    );
    expect(readFileSync(file, "utf8")).toBe(malformed);
  });

  it("fails closed on future schema data without overwriting it", () => {
    const file = orchestratorRoutingFilePath(root);
    const future = JSON.stringify({
      schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION + 1,
      projectId: routingProjectId(root),
      records: [],
      runtime: { paneId: "%42" },
    });
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(file, future, { mode: 0o600 });

    expect(loadOrchestratorRoutingOverlay(root)).toMatchObject({
      status: "unsupported",
      schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION + 1,
    });
    expect(() => saveOrchestratorRoutingEntries(root, [entry()])).toThrow(
      /unsupported routing metadata schemaVersion/,
    );
    expect(readFileSync(file, "utf8")).toBe(future);
  });

  it("fails closed when the routing path is unreadable", () => {
    const file = orchestratorRoutingFilePath(root);
    mkdirSync(file, { recursive: true, mode: 0o700 });

    expect(loadOrchestratorRoutingOverlay(root)).toMatchObject({
      status: "unreadable",
    });
    expect(() => upsertOrchestratorRoutingEntry(root, entry())).toThrow(
      /unreadable routing metadata/,
    );
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it("rejects mismatched project identity without replacing the file", () => {
    const file = orchestratorRoutingFilePath(root);
    const mismatched = JSON.stringify({
      schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
      projectId: "a".repeat(64),
      records: [],
    });
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(file, mismatched, { mode: 0o600 });

    expect(loadOrchestratorRoutingOverlay(root)).toMatchObject({
      status: "malformed",
    });
    expect(() => upsertOrchestratorRoutingEntry(root, entry())).toThrow(
      /projectId does not match/,
    );
    expect(readFileSync(file, "utf8")).toBe(mismatched);
  });

  it("validates safe child IDs and rejects runtime-state fields", () => {
    expect(() =>
      upsertOrchestratorRoutingEntry(root, entry({ childId: "../unsafe" })),
    ).toThrow(/childId/);
    expect(() =>
      upsertOrchestratorRoutingEntry(root, {
        ...entry(),
        paneId: "%42",
      } as unknown as OrchestratorRoutingEntryInput),
    ).toThrow(/unknown field.*paneId/);
    expect(existsSync(orchestratorRoutingFilePath(root))).toBe(false);
  });

  it("enforces description, alias, and record-count bounds", () => {
    const oversizedDescription = "é".repeat(
      Math.floor(MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES / 2) + 1,
    );
    const oversizedAlias = "é".repeat(
      Math.floor(MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES / 2) + 1,
    );
    const tooManyAliases = Array.from(
      { length: MAX_ORCHESTRATOR_ROUTING_ALIASES + 1 },
      (_, index) => `alias-${index}`,
    );
    const tooManyRecords = Array.from(
      { length: MAX_ORCHESTRATOR_ROUTING_RECORDS + 1 },
      (_, index) =>
        entry({
          childId: index.toString(16).padStart(16, "0"),
          aliases: [],
        }),
    );

    expect(() =>
      upsertOrchestratorRoutingEntry(
        root,
        entry({ description: oversizedDescription }),
      ),
    ).toThrow(/description exceeds/);
    expect(() =>
      upsertOrchestratorRoutingEntry(
        root,
        entry({ aliases: [oversizedAlias] }),
      ),
    ).toThrow(/alias exceeds/);
    expect(() =>
      upsertOrchestratorRoutingEntry(root, entry({ aliases: tooManyAliases })),
    ).toThrow(/aliases exceeds/);
    expect(() => saveOrchestratorRoutingEntries(root, tooManyRecords)).toThrow(
      /record count exceeds/,
    );
  });

  it("rejects a partial merge at capacity without changing the file", () => {
    const records = Array.from(
      { length: MAX_ORCHESTRATOR_ROUTING_RECORDS },
      (_, index) =>
        entry({
          childId: index.toString(16).padStart(16, "0"),
          description: `Responsibility ${index}`,
          aliases: [],
        }),
    );
    saveOrchestratorRoutingEntries(root, records);
    const file = orchestratorRoutingFilePath(root);
    const before = readFileSync(file, "utf8");

    expect(() =>
      saveOrchestratorRoutingEntries(root, [
        { ...records[0], description: "Must not be partially updated" },
        entry({ childId: "ffffffffffffffff", aliases: [] }),
      ]),
    ).toThrow(/routing record count exceeds/);

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(root, ".pi"))).toEqual([
      "subagentura-routing.json",
    ]);
    expect(listOrchestratorRoutingEntries(root)).toEqual(records);
  });

  it("updates an existing routing record while already at capacity", () => {
    const records = Array.from(
      { length: MAX_ORCHESTRATOR_ROUTING_RECORDS },
      (_, index) =>
        entry({
          childId: index.toString(16).padStart(16, "0"),
          description: `Responsibility ${index}`,
          aliases: [],
        }),
    );
    saveOrchestratorRoutingEntries(root, records);
    const updated = {
      ...records[0],
      description: "Updated responsibility at capacity",
    };

    const saved = upsertOrchestratorRoutingEntry(root, updated);
    const listed = listOrchestratorRoutingEntries(root);

    expect(saved.records).toHaveLength(MAX_ORCHESTRATOR_ROUTING_RECORDS);
    expect(saved.records).toContainEqual(updated);
    expect(listed).toEqual(saved.records);
    expect(listed.map((record) => record.childId)).toEqual(
      records.map((record) => record.childId),
    );
  });

  it("bounds the stored file before parsing", () => {
    const file = orchestratorRoutingFilePath(root);
    const oversized = "x".repeat(MAX_ORCHESTRATOR_ROUTING_FILE_BYTES + 1);
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(file, oversized, { mode: 0o600 });

    expect(loadOrchestratorRoutingOverlay(root)).toMatchObject({
      status: "malformed",
    });
    expect(() => upsertOrchestratorRoutingEntry(root, entry())).toThrow(
      /exceeds byte limit/,
    );
    expect(statSync(file).size).toBe(Buffer.byteLength(oversized));
  });

  it("validates provenance, timestamps, duplicate aliases, and duplicate IDs", () => {
    expect(() =>
      upsertOrchestratorRoutingEntry(root, {
        ...entry(),
        provenance: "child",
      } as unknown as OrchestratorRoutingEntryInput),
    ).toThrow(/provenance/);
    expect(() =>
      upsertOrchestratorRoutingEntry(root, entry({ updatedAt: "tomorrow" })),
    ).toThrow(/updatedAt/);
    expect(() =>
      upsertOrchestratorRoutingEntry(root, entry({ aliases: ["api", "api"] })),
    ).toThrow(/duplicate alias/);
    expect(() =>
      saveOrchestratorRoutingEntries(root, [entry(), entry()]),
    ).toThrow(/duplicate childId/);
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_MANIFEST_RECORDS,
  type CompletionRecord,
} from "../src/completion-contracts";
import {
  compactRecord,
  manifestMessage,
  MAX_MANIFEST_BYTES,
  selectManifestRecords,
} from "../src/completion-manifest";

function record(
  id: string,
  overrides: Partial<CompletionRecord> = {},
): CompletionRecord {
  return {
    schemaVersion: 1,
    completionId: id,
    source: "interactive",
    sourceId: id,
    turnId: `turn-${id}`,
    label: id,
    status: "done",
    policy: "each",
    references: [{ label: "output", value: `outputs/${id}.md` }],
    completedAt: 1,
    ...overrides,
  };
}

describe("completion manifest formatting", () => {
  it.each([
    [
      "interactive",
      'read_subagent_artifact(id: "child", turnId: "turn-child")',
    ],
    ["workflow", 'get_workflow_result(workflowId: "child")'],
    ["in-process", 'get_subagent_result(jobId: "child")'],
  ] as const)("formats the %s retrieval selector", (source, retrieve) => {
    expect(compactRecord(record("child", { source }), true)).toMatchObject({
      retrieve,
      references: [{ label: "output", value: "outputs/child.md" }],
    });
  });

  it("escapes identifiers and omits absent turn selectors", () => {
    expect(
      compactRecord(record('child"\n', { turnId: undefined }), false),
    ).toEqual({
      completionId: 'child"\n',
      source: "interactive",
      sourceId: 'child"\n',
      label: 'child"\n',
      status: "done",
      retrieve: 'read_subagent_artifact(id: "child\\\"\\n")',
    });
  });

  it("emits a hidden manifest with unique groups and immutable references", () => {
    const records = ["a", "b"].map((id) =>
      record(id, { policy: "group", groupId: "review" }),
    );
    const message = manifestMessage(records);
    expect(message).toMatchObject({
      customType: "subagent-manifest",
      display: false,
      details: {
        schemaVersion: 1,
        completionIds: ["a", "b"],
        groups: ["review"],
      },
    });
    const lines = message.content.split("\n");
    expect(lines[0]).toBe("<completion-manifest>");
    expect(lines.at(-1)).toBe("</completion-manifest>");
    expect(lines.slice(2, -1).map((line) => JSON.parse(line))).toEqual(
      records.map((entry) => compactRecord(entry, true)),
    );
  });

  it("drops references when UTF-8 payload bytes exceed the manifest limit", () => {
    const records = [
      record("large", {
        references: [
          { label: "output", value: "界".repeat(MAX_MANIFEST_BYTES / 2) },
        ],
      }),
    ];
    const message = manifestMessage(records);
    expect(JSON.parse(message.content.split("\n")[2])).toEqual(
      compactRecord(records[0], false),
    );
    expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(
      MAX_MANIFEST_BYTES,
    );
  });
});

describe("completion manifest batch selection", () => {
  it("keeps interleaved groups together without duplicating members", () => {
    const first = record("first", { policy: "group", groupId: "review" });
    const independent = record("independent");
    const second = record("second", { policy: "group", groupId: "review" });
    expect(selectManifestRecords([first, independent, second])).toEqual([
      first,
      second,
      independent,
    ]);
  });

  it("defers an entire group when the remaining record capacity is too small", () => {
    const independent = Array.from(
      { length: MAX_MANIFEST_RECORDS - 1 },
      (_, i) => record(String(i)),
    );
    const group = ["first", "second"].map((id) =>
      record(id, { policy: "group", groupId: "review" }),
    );
    expect(selectManifestRecords([...independent, ...group])).toEqual(
      independent,
    );
  });

  it("defers a group whose compact payload exceeds the byte limit", () => {
    const first = record("first");
    const largeGroup = Array.from({ length: 32 }, (_, i) =>
      record(String(i), {
        policy: "group",
        groupId: "review",
        sourceId: "界".repeat(128),
        turnId: "界".repeat(256),
      }),
    );
    expect(selectManifestRecords([first, ...largeGroup])).toEqual([first]);
  });
});

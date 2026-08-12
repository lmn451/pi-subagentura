import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowReplayRequest,
  durableWorkflowDigest,
  assertWorkflowReplayRequestMatches,
  assertWorkflowReplayResponseDigest,
  persistWorkflowDefinitionBlob,
  readWorkflowDefinitionBlob,
  replayWorkflowResponses,
  WorkflowReplayDivergedError,
} from "../src/workflow-replay";

describe("workflow durable replay", () => {
  it("canonicalizes request fields into stable digests", () => {
    const first = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: { b: 2, a: 1 },
      options: { model: "m" },
      definition: { nested: true },
    });
    const second = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: { a: 1, b: 2 },
      options: { model: "m" },
      definition: { nested: true },
    });
    expect(first).toEqual(second);
    expect(durableWorkflowDigest(null)).toHaveLength(64);
    expect(() =>
      assertWorkflowReplayRequestMatches(first, {
        ...second,
        promptDigest: "0".repeat(64),
      }),
    ).toThrow("request diverged");
  });

  it("replays all response kinds in ordinal order", () => {
    const request = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: "hello",
      options: {},
      definition: "definition",
    });
    const responses = [
      {
        operationId: "op-1",
        responseOrdinal: 1,
        kind: "success" as const,
        valueDigest: "a",
      },
      {
        operationId: "op-1",
        responseOrdinal: 2,
        kind: "null" as const,
        valueDigest: "b",
      },
    ];
    expect(replayWorkflowResponses([request], responses)).toEqual(responses);
    expect(() =>
      assertWorkflowReplayResponseDigest({
        ...responses[0],
        payload: { changed: true },
      }),
    ).toThrow("response diverged");
  });

  it("fails boundedly on missing or unknown responses", () => {
    const request = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: "hello",
      options: {},
      definition: "definition",
    });
    expect(() =>
      replayWorkflowResponses(
        [request],
        [
          {
            operationId: "op-1",
            responseOrdinal: 2,
            kind: "error",
            valueDigest: "x",
          },
        ],
      ),
    ).toThrow(WorkflowReplayDivergedError);
    expect(() =>
      replayWorkflowResponses(
        [request],
        [
          {
            operationId: "op-2",
            responseOrdinal: 1,
            kind: "error",
            valueDigest: "x",
          },
        ],
      ),
    ).toThrow("Unknown workflow replay operation");
  });

  it("stores immutable content-addressed definition blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-replay-"));
    const definition = { name: "demo", steps: ["a", "b"] };
    const first = await persistWorkflowDefinitionBlob(root, definition);
    const second = await persistWorkflowDefinitionBlob(root, {
      steps: ["a", "b"],
      name: "demo",
    });
    expect(second.digest).toBe(first.digest);
    await expect(
      readWorkflowDefinitionBlob(first.path, first.digest),
    ).resolves.toEqual(definition);
    await expect(
      readWorkflowDefinitionBlob(first.path, "0".repeat(64)),
    ).rejects.toThrow("definition blob diverged");
  });

  it("rejects symlinked definition blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-replay-"));
    const definition = await persistWorkflowDefinitionBlob(root, {
      safe: true,
    });
    const link = join(root, "link.json");
    await symlink(definition.path, link);
    await expect(
      readWorkflowDefinitionBlob(link, definition.digest),
    ).rejects.toThrow();
  });
});

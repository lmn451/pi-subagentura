import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCompletionEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import {
  clearCompletionCoordinator,
  prepareCompletionManifest,
  publishCompletion,
} from "../src/completion-coordinator";
import {
  COMPLETION_CONSUMED_ENTRY_TYPE,
  type CompletionRecord,
} from "../src/completion-contracts";
import { sessionLedgerPath } from "../src/completion-ledger";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
} from "../src/session-scope";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";

const EXAMPLE = readFileSync(
  new URL("../examples/codemode/subagent-results.mjs", import.meta.url),
  "utf8",
);
const SELECTED_ID = "ca51ab1e";
const SELECTED_TURN_ID = "test-owned-turn-selected";
const OTHER_TURN_ID = "test-owned-turn-other";
const SESSION_ID = "codemode-result-integration-session";

type ToolArgs = Record<string, unknown>;
type Summary = {
  collectionStatus: string;
  items: Array<{
    evidence: { id: string; turnId: string };
    status: string;
    dataState: string;
    outputState: string;
    outputTruncated: boolean;
    excerpt?: string;
  }>;
};

type ToolResponse = {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type PublicTool = {
  name: string;
  execute: (...args: any[]) => Promise<ToolResponse>;
};

function sourceForExactSelector(): string {
  const selectors = [{ id: SELECTED_ID, turnId: SELECTED_TURN_ID }];
  const source = EXAMPLE.replace(
    "const SELECTORS = [];",
    `const SELECTORS = ${JSON.stringify(selectors)};`,
  );
  if (source === EXAMPLE)
    throw new Error("Could not inject the exact selector.");
  return source;
}

function parseSummary(response: { content: Array<{ text: string }> }): Summary {
  const text = response.content.find((item) =>
    item.text.includes('"collectionStatus"'),
  )?.text;
  if (!text)
    throw new Error("Codemode response did not contain a JSON summary.");
  return JSON.parse(text.slice(text.indexOf("{"))) as Summary;
}

describe("Codemode sub-agent results with a real artifact", () => {
  afterEach(() => {
    clearSessionScopes();
  });

  it("reads one test-owned exact turn and persists only its consumption receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "codemode-subagent-result-"));
    const entries: SessionEntry[] = [];
    const tools = new Map<string, PublicTool>();
    const selectedOutput = `SELECTED_TEST_RESULT ${"bounded-safe-".repeat(35)}\u001b[31m\u202e`;
    const otherOutput = "UNSELECTED_TEST_RESULT_MUST_NOT_BE_READ";
    const piShape = {
      registerTool: (tool: PublicTool) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getFlag: () => undefined,
      getAllTools: () => [...tools.values()],
      appendEntry: (customType: string, data: unknown) => {
        entries.push({
          type: "custom",
          id: `test-entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "1970-01-01T00:00:00.000Z",
          customType,
          data,
        } as SessionEntry);
      },
    };
    const pi = piShape as unknown as ExtensionAPI;
    const scope = registerSessionScope({
      id: 29,
      generation: 1,
      lifecycle: "started",
      parentStreaming: true,
      cwd: root,
      pi,
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getSessionDir: () => root,
        getEntries: () => entries,
      },
    });
    const owner = sessionOwner(scope);
    const art = artifactPath(root, SELECTED_ID);

    try {
      writeOutput(art, selectedOutput);
      appendCompletionEvent(art, {
        turnId: SELECTED_TURN_ID,
        outcome: "done",
        source: "agent_settled",
      });
      writeOutput(art, otherOutput);
      appendCompletionEvent(art, {
        turnId: OTHER_TURN_ID,
        outcome: "done",
        source: "agent_settled",
      });
      scope.interactiveStates.set(SELECTED_ID, {
        id: SELECTED_ID,
        name: "Test-owned artifact",
        task: "Synthetic integration fixture",
        cwd: root,
        artifactDir: art.dir,
        status: "exited",
        mux: "tmux",
        paneId: "%test-owned",
        startedAt: Date.now(),
        sessionFile: join(root, "session.jsonl"),
        launchScriptFile: join(root, "launch.sh"),
        attachCommand: "",
        selectPaneCommand: "",
      });
      registerInteractiveSubagentTools(pi, scope);

      const completion = (turnId: string): CompletionRecord => ({
        schemaVersion: 1,
        completionId: `completion-${turnId}`,
        source: "interactive",
        sourceId: SELECTED_ID,
        turnId,
        label: "Test-owned result",
        status: "done",
        policy: "each",
        references: [{ label: "result", value: SELECTED_ID }],
        completedAt: Date.now(),
      });
      publishCompletion(completion(SELECTED_TURN_ID), owner);
      publishCompletion(completion(OTHER_TURN_ID), owner);

      const codemodeExtension = createCodemodeExtension({
        models: false,
      }) as unknown as (host: unknown) => void;
      codemodeExtension(piShape);
      const codemode = tools.get("codemode") as PublicTool;
      const readTool = tools.get("read_subagent_artifact");
      if (!readTool)
        throw new Error("Public artifact reader was not registered.");
      const calls: ToolArgs[] = [];
      const publicReads: Array<Record<string, unknown>> = [];
      const context = {
        tools: [readTool],
        sessionManager: { getBranch: () => [] },
        executeTool: async (name: string, args: ToolArgs) => {
          calls.push({ name, ...args });
          const result = await readTool.execute(
            `nested-read-${calls.length}`,
            args,
            undefined,
            undefined,
            { cwd: root },
          );
          if (!result.structuredContent) {
            throw new Error(
              "Public artifact reader returned no structured data.",
            );
          }
          publicReads.push(result.structuredContent);
          return {
            toolCall: { id: `nested-tool-call-${calls.length}` },
            result,
            isError: result.isError === true,
          };
        },
      };
      const code = sourceForExactSelector();
      const runCodemode = () =>
        codemode.execute(
          "codemode-real-artifact-test",
          { code },
          undefined,
          undefined,
          context,
        );

      const firstResponse = await runCodemode();
      const summary = parseSummary(firstResponse);
      expect(calls).toEqual([
        {
          name: "read_subagent_artifact",
          id: SELECTED_ID,
          turnId: SELECTED_TURN_ID,
          includeOutput: true,
        },
      ]);
      expect(publicReads[0]).toMatchObject({
        id: SELECTED_ID,
        turnId: SELECTED_TURN_ID,
        status: "done",
        outputState: "available",
        outputTruncated: false,
      });
      expect(summary).toMatchObject({
        collectionStatus: "complete",
        items: [
          {
            evidence: { id: SELECTED_ID, turnId: SELECTED_TURN_ID },
            status: "done",
            dataState: "available",
            outputState: "available",
            outputTruncated: false,
          },
        ],
      });
      const excerpt = summary.items[0].excerpt ?? "";
      expect(excerpt).toContain("SELECTED_TEST_RESULT");
      expect(excerpt.length).toBeLessThanOrEqual(241);
      expect(excerpt).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
      expect(
        firstResponse.content.map((item) => item.text).join("\n"),
      ).not.toContain(otherOutput);

      const ledgerPath = sessionLedgerPath(
        root,
        SESSION_ID,
        "subagentura-completion-consumed",
      );
      const ledger = readFileSync(ledgerPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const receiptEntries = entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === COMPLETION_CONSUMED_ENTRY_TYPE,
      );
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        schemaVersion: 1,
        source: "interactive",
        sourceId: SELECTED_ID,
        turnId: SELECTED_TURN_ID,
        reason: "manual",
      });
      expect(receiptEntries).toHaveLength(1);
      expect(receiptEntries[0]).toHaveProperty("data.turnId", SELECTED_TURN_ID);

      await runCodemode();
      expect(calls).toHaveLength(2);
      expect(ledger).toHaveLength(1);
      const receiptLedgerAfterRepeat = readFileSync(ledgerPath, "utf8")
        .trim()
        .split("\n");
      expect(receiptLedgerAfterRepeat).toHaveLength(1);
      expect(
        entries.filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === COMPLETION_CONSUMED_ENTRY_TYPE,
        ),
      ).toHaveLength(1);

      const remaining = prepareCompletionManifest(owner);
      expect(remaining?.details.completionIds).toEqual([
        `completion-${OTHER_TURN_ID}`,
      ]);
    } finally {
      clearCompletionCoordinator(owner);
      clearSessionScopes();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

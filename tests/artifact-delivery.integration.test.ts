import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  readEventRecords,
  readOutputForTurnId,
  writeOutput,
} from "../src/artifact";
import { pollArtifactChanges } from "../src/artifact-poller";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { registerCompletionCoordinator } from "../src/completion-coordinator";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  interactiveSubagentRegistry.clear();
  clearSessionScopes();
  __setTmuxMultiplexer(undefined);
});

function makeArtifact() {
  const root = mkdtempSync(join(tmpdir(), "subagentura-v2-delivery-"));
  roots.push(root);
  return artifactPath(root, "child0001");
}

function makeState(artifactDir: string): InteractiveSubagentState {
  return {
    id: "child0001",
    name: "child",
    task: "",
    paneId: "%1",
    mux: "tmux",
    sessionFile: "",
    cwd: artifactDir,
    startedAt: 0,
    status: "idle",
    attachCommand: "",
    selectPaneCommand: "",
    launchScriptFile: "",
    artifactDir,
    parentSessionId: "parent-session",
    pendingDeliveries: [],
    deliveryReceipts: [],
    eventByteCursor: 0,
    completionPolicy: "each",
  };
}

describe("protocol-v2 artifact delivery", () => {
  it("reads v2 events in physical byte order and associates immutable outputs by turn", () => {
    const art = makeArtifact();
    writeOutput(art, "first turn output");
    const first = appendCompletionEvent(art, {
      turnId: "pi-user-entry-1",
      outcome: "done",
      source: "agent_settled",
      eventId: "event-one",
    })!;
    writeOutput(art, "second turn output");
    const second = appendCompletionEvent(art, {
      turnId: "pi-user-entry-2",
      outcome: "done",
      source: "agent_settled",
      eventId: "event-two",
    })!;

    const events = readEventRecords(art);
    expect(events.map(({ event }) => event.type)).toEqual([
      "completion",
      "completion",
    ]);
    expect(events.map(({ event }) => event.ts)).toEqual([first.ts, second.ts]);
    expect(readOutputForTurnId(art, "pi-user-entry-1")).toBe(
      "first turn output",
    );
    expect(readOutputForTurnId(art, "pi-user-entry-2")).toBe(
      "second turn output",
    );
    expect(readFileSync(first.output!.path, "utf8")).toBe("first turn output");
  });

  it("queues a v2 completion as a coordinated entry with immutable references", async () => {
    const art = makeArtifact();
    writeOutput(art, "immutable result");
    const completion = appendCompletionEvent(art, {
      turnId: "pi-user-entry-1",
      outcome: "done",
      source: "agent_settled",
      eventId: "event-completion",
    })!;
    const entries: Array<{ customType: string; data: any }> = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({ customType, data });
      }),
      registerEntryRenderer: vi.fn(),
      sendMessage: vi.fn(),
    };
    const scope = registerSessionScope({
      id: 501,
      generation: 1,
      lifecycle: "started",
      pi: pi as any,
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () =>
          entries.map(({ customType, data }) => ({
            type: "custom",
            customType,
            data,
          })),
      },
    });
    const state = makeState(art.dir);
    scope.interactiveStates.set(state.id, state);
    interactiveSubagentRegistry.set(state.id, state);
    registerCompletionCoordinator(pi as any, scope);
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await pollArtifactChanges(pi as any, { id: 501, generation: 1 });

    expect(entries).toEqual([
      expect.objectContaining({
        customType: "subagentura-completion",
        data: expect.objectContaining({
          schemaVersion: 1,
          completionId: expect.any(String),
          source: "interactive",
          sourceId: state.id,
          turnId: completion.turnId,
          status: "done",
          policy: "each",
          references: [
            {
              label: "output",
              value: join(art.dir, "outputs", "event-completion.md"),
            },
            { label: "activity", value: join(art.dir, "events.ndjson") },
          ],
        }),
      }),
    ]);
    expect(state.eventByteCursor).toBeGreaterThan(0);
  });

  it("does not publish workflow-owned child completions independently", async () => {
    const art = makeArtifact();
    appendEvent(art, {
      version: 2,
      eventId: "event-start",
      turnId: "turn-1",
      ts: 1,
      type: "turn_started",
      status: "running",
    });
    appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "done",
      source: "agent_settled",
      eventId: "event-completion",
    });
    const entries: unknown[] = [];
    const pi = {
      appendEntry: vi.fn((_customType: string, data: unknown) =>
        entries.push(data),
      ),
      registerEntryRenderer: vi.fn(),
      sendMessage: vi.fn(),
    };
    const scope = registerSessionScope({
      id: 502,
      generation: 1,
      lifecycle: "started",
      pi: pi as any,
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      },
    });
    const state = {
      ...makeState(art.dir),
      completionOwner: "workflow" as const,
    };
    scope.interactiveStates.set(state.id, state);
    interactiveSubagentRegistry.set(state.id, state);
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await pollArtifactChanges(pi as any, { id: 502, generation: 1 });

    expect(entries).toEqual([]);
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.eventByteCursor).toBeGreaterThan(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerInteractiveSubagentState,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __setTmuxMultiplexer, type Multiplexer } from "../src/multiplexer";
import { pollArtifactChanges } from "../src/artifact-poller";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
} from "../src/session-scope";
import {
  flushCompletionManifests,
  prepareCompletionManifest,
  registerCompletionCoordinator,
  registerCompletionMember,
  settleCompletionParentTurn,
} from "../src/completion-coordinator";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const repoRoot = new URL("..", import.meta.url).pathname;
const childHarnesses: PiSessionHarness[] = [];
const providerServers: Server[] = [];

const roots: string[] = [];

afterEach(async () => {
  for (const harness of childHarnesses.splice(0)) harness.dispose();
  await Promise.all(
    providerServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
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

  it("projects v2 tool activity onto live state without creating a delivery", async () => {
    const art = makeArtifact();
    appendEvent(art, {
      version: 2,
      eventId: "turn-started",
      turnId: "activity-turn",
      ts: 10,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "tool-started",
      turnId: "activity-turn",
      ts: 20,
      type: "tool_activity",
      phase: "start",
      status: "running",
      tool: "bash",
      summary: "bash",
    });
    const entries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({ customType, data });
      }),
      registerEntryRenderer: vi.fn(),
      sendMessage: vi.fn(),
    };
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const scope = registerSessionScope({
      id: 503,
      generation: 1,
      lifecycle: "started",
      pi: pi as unknown as ExtensionAPI,
      ui: ui as unknown as ExtensionUIContext,
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      },
    });
    const state = makeState(art.dir);
    registerInteractiveSubagentState(state, scope);
    const mux = {
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } satisfies Pick<Multiplexer, "getPaneLiveness" | "getPaneLivenessAsync">;
    __setTmuxMultiplexer(mux as unknown as Multiplexer);

    await pollArtifactChanges(scope.pi, sessionOwner(scope));

    expect(state.status).toBe("running");
    expect(state.lastToolName).toBe("bash");
    expect(state.lastToolSummary).toBe("bash");
    expect(state.lastActivityAt).toBe(20);
    expect(entries).toEqual([]);
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.eventByteCursor).toBeGreaterThan(0);
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
    const entries: Array<{ customType: string; data: unknown }> = [];
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
      pi: pi as unknown as ExtensionAPI,
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
    registerInteractiveSubagentState(state, scope);
    registerCompletionCoordinator(pi as unknown as ExtensionAPI, scope);
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } as unknown as Multiplexer);

    await pollArtifactChanges(scope.pi, sessionOwner(scope));

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

  it.each(["each", "group"] as const)(
    "publishes settled HTTP 402 provider errors before group completion with %s policy",
    async (policy) => {
      const art = makeArtifact();
      const siblingArt = policy === "group" ? makeArtifact() : undefined;
      let providerRequests = 0;
      const providerServer = createServer((_request, response) => {
        providerRequests += 1;
        response.writeHead(402, { "content-type": "text/plain" });
        response.end("insufficient credits");
      });
      providerServers.push(providerServer);
      await new Promise<void>((resolve) =>
        providerServer.listen(0, "127.0.0.1", resolve),
      );
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("local provider server did not bind a TCP port");
      }
      const harness = await createPiSessionHarness(repoRoot, {
        bindExtensionLifecycle: true,
        childArtifactDir: art.dir,
        providerErrorUrl: `http://127.0.0.1:${address.port}/chat`,
        retrySettings: {
          enabled: false,
          maxRetries: 0,
          baseDelayMs: 0,
          maxAgentDelayMs: 0,
        },
      });
      childHarnesses.push(harness);
      const prompt = harness.session.prompt("exercise provider failure");
      await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
      await prompt;
      await harness.session.waitForIdle();

      expect(providerRequests).toBe(1);
      const childCompletion = readEventRecords(art)
        .map(({ event }) => event)
        .find((event) => event.type === "completion");
      expect(childCompletion).toMatchObject({
        type: "completion",
        outcome: "error",
        source: "agent_settled",
        errorMessage: "HTTP 402: insufficient credits",
        agentStopReason: "error",
      });
      const entries: Array<{ customType: string; data: unknown }> = [];
      const pi = {
        appendEntry: vi.fn((customType: string, data: unknown) => {
          entries.push({ customType, data });
        }),
        registerEntryRenderer: vi.fn(),
        sendMessage: vi.fn(
          (message: { customType: string; content: string }) => {
            entries.push({ customType: message.customType, data: message });
          },
        ),
      };
      const scope = registerSessionScope({
        id: 504,
        generation: 1,
        lifecycle: "started",
        pi: pi as unknown as ExtensionAPI,
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
      const groupId = "provider-error-group";
      const state = {
        ...makeState(art.dir),
        completionPolicy: policy,
        ...(policy === "group" ? { completionGroupId: groupId } : {}),
      };
      const siblingState = siblingArt
        ? {
            ...makeState(siblingArt.dir),
            id: "sibling",
            completionPolicy: "group" as const,
            completionGroupId: groupId,
          }
        : undefined;
      const owner = sessionOwner(scope);
      registerInteractiveSubagentState(state, scope);
      if (siblingState) registerInteractiveSubagentState(siblingState, scope);
      registerCompletionCoordinator(pi as unknown as ExtensionAPI, scope);
      if (policy === "group") {
        registerCompletionMember(
          "interactive",
          state.id,
          "group",
          groupId,
          owner,
        );
        registerCompletionMember(
          "interactive",
          "sibling",
          "group",
          groupId,
          owner,
        );
      }
      __setTmuxMultiplexer({
        getPaneLiveness: () => "alive",
        getPaneLivenessAsync: async () => "alive",
      } as unknown as Multiplexer);

      await pollArtifactChanges(scope.pi, owner);
      flushCompletionManifests(owner);
      expect(state.status).toBe("idle");

      const errorEntry = entries.find(
        ({ customType }) => customType === "subagentura-completion",
      );
      expect(errorEntry?.data).toMatchObject({
        turnId: childCompletion?.turnId,
        status: "error",
        policy,
      });
      if (policy === "group") {
        expect(errorEntry?.data).toMatchObject({ groupRemaining: 1 });
      } else {
        expect(errorEntry?.data).not.toHaveProperty("groupRemaining");
      }
      expect(pi.sendMessage).toHaveBeenCalledOnce();
      expect(pi.sendMessage.mock.calls[0][0].content).toContain(
        '"status":"error"',
      );

      if (siblingArt && siblingState) {
        expect(
          entries.filter(
            ({ customType }) => customType === "subagentura-completion",
          ),
        ).toHaveLength(1);
        expect(pi.sendMessage).toHaveBeenCalledOnce();

        writeOutput(siblingArt, "sibling success");
        appendCompletionEvent(siblingArt, {
          turnId: "sibling-turn",
          outcome: "done",
          source: "agent_settled",
          eventId: "sibling-completion",
        });
        await pollArtifactChanges(scope.pi, owner);
        expect(prepareCompletionManifest(owner)).toBeUndefined();
        expect(
          entries.filter(
            ({ customType }) => customType === "subagentura-completion",
          ),
        ).toHaveLength(2);
        expect(
          entries.findLast(
            ({ customType }) => customType === "subagentura-completion",
          )?.data,
        ).toMatchObject({
          sourceId: "sibling",
          policy: "group",
          groupId,
          groupRemaining: 0,
        });
        expect(pi.sendMessage).toHaveBeenCalledOnce();

        settleCompletionParentTurn(owner);
        flushCompletionManifests(owner);
        expect(pi.sendMessage).toHaveBeenCalledTimes(2);
        expect(pi.sendMessage.mock.calls[1][0]).toMatchObject({
          details: { groups: [groupId] },
        });
        expect(pi.sendMessage.mock.calls[1][0].content).toContain(
          '"sourceId":"sibling"',
        );
        expect(pi.sendMessage.mock.calls[1][0].content).not.toContain(
          '"sourceId":"child0001"',
        );
      }

      settleCompletionParentTurn(owner);
      await pollArtifactChanges(scope.pi, owner);
      flushCompletionManifests(owner);
      expect(pi.sendMessage).toHaveBeenCalledTimes(policy === "group" ? 2 : 1);
    },
  );
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
      pi: pi as unknown as ExtensionAPI,
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      },
    });
    const state = {
      ...makeState(art.dir),
      completionOwner: "workflow" as const,
    };
    registerInteractiveSubagentState(state, scope);
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } as unknown as Multiplexer);

    await pollArtifactChanges(scope.pi, sessionOwner(scope));

    expect(entries).toEqual([]);
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.eventByteCursor).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS,
  MAX_ORCHESTRATOR_ROUTING_RECORDS,
  buildOrchestratorAgentProjection,
  listOrchestratorRoutingEntries,
  loadOrchestratorAgentRegistryView,
  orchestratorRoutingFilePath,
  saveOrchestratorRoutingEntries,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";

const LIVE_ID = "ffffffffffffffff";

function routingEntry(index: number): OrchestratorRoutingEntry {
  return {
    childId: index.toString(16).padStart(16, "0"),
    description: `Historical responsibility ${index}`,
    provenance: "user",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

function liveState(): InteractiveSubagentState {
  return {
    id: LIVE_ID,
    name: "live-agent",
    task: "Own current work",
    paneId: "%live",
    mux: "tmux",
    sessionFile: "/sessions/live.jsonl",
    cwd: "/repo",
    startedAt: 1,
    status: "running",
    attachCommand: "tmux attach -t live",
    selectPaneCommand: "tmux select-pane -t %live",
    launchScriptFile: "/artifacts/live/launch.sh",
    artifactDir: "/artifacts/live",
  };
}

describe("Orchestratorv2 routing blockers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orchestrator-blockers-"));
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
    } as never);
  });

  afterEach(() => {
    __resetMuxInstances();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps live runtimes visible when routing metadata is malformed", async () => {
    mkdirSync(join(root, ".pi"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ".pi", "subagentura-routing.json"), "{", {
      mode: 0o600,
    });

    const view = await loadOrchestratorAgentRegistryView(
      root,
      new Map([[LIVE_ID, liveState()]]),
    );

    expect(view.routingMetadataStatus).toBe("malformed");
    expect(view.routingMetadataError).toEqual(expect.any(String));
    expect(view.agents).toEqual([
      expect.objectContaining({
        childId: LIVE_ID,
        stale: false,
        attachable: true,
        actionable: false,
        reason: "routing_metadata_missing",
      }),
    ]);
    expect(view.agents[0]).not.toHaveProperty("description");
  });

  it("prioritizes live runtimes over a full stale metadata view", async () => {
    const stale = Array.from(
      { length: MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS },
      (_, index) => routingEntry(index),
    );

    const view = await buildOrchestratorAgentProjection(
      stale,
      new Map([[LIVE_ID, liveState()]]),
    );

    expect(view.agents).toHaveLength(MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS);
    expect(view.omitted).toBe(1);
    expect(view.agents[0]).toMatchObject({
      childId: LIVE_ID,
      stale: false,
      attachable: true,
      actionable: false,
    });
  });

  it("bounds concurrent pane liveness probes", async () => {
    let active = 0;
    let maximum = 0;
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return "alive";
      }),
    } as never);
    const states = new Map<string, InteractiveSubagentState>();
    for (let index = 0; index < 24; index++) {
      const childId = index.toString(16).padStart(16, "0");
      states.set(childId, {
        ...liveState(),
        id: childId,
        paneId: `%${index}`,
      });
    }

    const view = await buildOrchestratorAgentProjection([], states);

    expect(view.total).toBe(states.size);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  it("bounds total liveness latency when backend probes do not settle", async () => {
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockReturnValue(new Promise(() => {})),
    } as never);
    const states = new Map<string, InteractiveSubagentState>();
    for (let index = 0; index < 24; index++) {
      const childId = index.toString(16).padStart(16, "0");
      states.set(childId, {
        ...liveState(),
        id: childId,
        paneId: `%${index}`,
      });
    }
    const startedAt = Date.now();

    const view = await buildOrchestratorAgentProjection([], states, {
      livenessDeadlineMs: 25,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(view.agents).toHaveLength(states.size);
    expect(view.agents.every((agent) => agent.liveness === "unknown")).toBe(
      true,
    );
  });

  it("fails closed at capacity without eviction or replacement", () => {
    const historical = Array.from(
      { length: MAX_ORCHESTRATOR_ROUTING_RECORDS },
      (_, index) => routingEntry(index),
    );
    saveOrchestratorRoutingEntries(root, historical);
    const file = orchestratorRoutingFilePath(root);
    const before = readFileSync(file, "utf8");
    const live = {
      childId: LIVE_ID,
      description: "Own the newly spawned live child",
      provenance: "orchestratorv2" as const,
      updatedAt: "2026-08-21T12:00:00.000Z",
    };

    expect(() => upsertOrchestratorRoutingEntry(root, live)).toThrow(
      /routing record count exceeds/,
    );
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(listOrchestratorRoutingEntries(root)).toEqual(historical);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactPath,
  listOutputHistory,
  readEventRecords,
  writeOutput,
} from "../src/artifact";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import { writeCliScript } from "../src/subagent-artifact-cli";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  registerInProcessJob,
  removeInProcessJob,
  type JobState,
  type SubagentResult,
} from "../src/helpers";
import { sessionLedgerPath } from "../src/completion-ledger";

import {
  clearCompletionCoordinator,
  flushCompletionManifests,
  prepareCompletionManifest,
  publishCompletion,
  registerCompletionMember,
  settleCompletionParentTurn,
} from "../src/completion-coordinator";
const repoRoot = new URL("..", import.meta.url).pathname;
const harnesses: PiSessionHarness[] = [];
const artifactRoots: string[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  for (const root of artifactRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  clearSessionScopes();
  __setTmuxMultiplexer(undefined);
});

function childArtifact() {
  const root = mkdtempSync(join(tmpdir(), "pi-subagentura-child-session-"));
  artifactRoots.push(root);
  return artifactPath(root, "child0001");
}
function resolveHarnessScope(
  harness: PiSessionHarness,
  existingScopeIds: ReadonlySet<number>,
): SessionScope {
  const newScopes = getSessionScopes().filter(
    (candidate) => !existingScopeIds.has(candidate.id),
  );
  const scope =
    newScopes.find(
      (candidate) => candidate.sessionManager === harness.sessionManager,
    ) ?? (newScopes.length === 1 ? newScopes[0] : undefined);
  if (!scope) throw new Error("harness extension has no exact SessionScope");
  scope.lifecycle = "started";
  scope.sessionManager = harness.sessionManager;
  scope.ui = harness.session.extensionRunner.getUIContext();
  scope.isParentIdle = () => !harness.session.isStreaming;
  return scope;
}

async function setupCoordinatorHarness() {
  const existingScopeIds = new Set(getSessionScopes().map(({ id }) => id));
  const harness = await createPiSessionHarness(repoRoot);
  harnesses.push(harness);
  const scope = resolveHarnessScope(harness, existingScopeIds);
  return { harness, scope };
}

describe("coordinated completion delivery", () => {
  it.each([false, true])(
    "requires a durable receipt across retries and coordinator reload (Pi storage blocked=%s)",
    async (blockPiStorage) => {
      const root = mkdtempSync(join(tmpdir(), "pi-receipt-persistence-"));
      artifactRoots.push(root);
      const manager = SessionManager.create(root, join(root, "sessions"));
      const existingScopes = new Set(getSessionScopes().map(({ id }) => id));
      const harness = await createPiSessionHarness(root, {
        extensionRoot: repoRoot,
        includeTools: true,
        sessionManager: manager,
      });
      harnesses.push(harness);
      const scope = resolveHarnessScope(harness, existingScopes);
      const owner = sessionOwner(scope);
      const seed = harness.session.prompt("Initialize the persisted session.");
      await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
      harness.completeNext();
      await seed;
      scope.parentStreaming = true;
      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      };
      const result: SubagentResult = {
        output: "retained result",
        isError: false,
        usage,
      };
      const job: JobState = {
        id: "durable-receipt-job",
        session: harness.session,
        status: "done",
        startedAt: Date.now(),
        liveStatus: { turn: 1, output: result.output, usage },
        promise: Promise.resolve(result),
        result,
        completionPolicy: "each",
      };
      expect(registerInProcessJob(job, owner)).toBe(true);
      publishCompletion(
        {
          schemaVersion: 1,
          completionId: "job:durable-receipt-job",
          source: "in-process",
          sourceId: job.id,
          label: "Retained job",
          status: "done",
          policy: "each",
          references: [{ label: "result", value: job.id }],
          completedAt: Date.now(),
        },
        owner,
      );
      const sessionFile = manager.getSessionFile()!;
      expect(readFileSync(sessionFile, "utf8")).toContain(
        "subagentura-completion",
      );
      const receiptPath = sessionLedgerPath(
        manager.getSessionDir(),
        manager.getSessionId(),
        "subagentura-completion-consumed",
      );
      mkdirSync(receiptPath, { recursive: true });
      if (blockPiStorage) {
        renameSync(sessionFile, `${sessionFile}.retained`);
        mkdirSync(sessionFile);
      }
      const tool = harness.session.agent.state.tools.find(
        (candidate) => candidate.name === "get_subagent_result",
      )!;
      const read = () => tool.execute("read-result", { jobId: job.id });
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          await expect(read()).rejects.toThrow(/persist.*receipt/i);
          expect(job.resultRetrieved).not.toBe(true);
          expect(
            manager
              .getEntries()
              .filter(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "subagentura-completion-consumed",
              ),
          ).toHaveLength(0);
          clearCompletionCoordinator(owner);
          expect(prepareCompletionManifest(owner)).toBeDefined();
        }
        rmSync(receiptPath, { recursive: true });
        if (blockPiStorage) {
          rmSync(sessionFile, { recursive: true });
          renameSync(`${sessionFile}.retained`, sessionFile);
        }
        expect((await read()).content).toEqual([
          { type: "text", text: result.output },
        ]);
        expect(readFileSync(receiptPath, "utf8")).toContain(job.id);
        expect(job.resultRetrieved).toBe(true);
        clearCompletionCoordinator(owner);
        expect(prepareCompletionManifest(owner)).toBeUndefined();
      } finally {
        removeInProcessJob(job.id, owner);
      }
    },
  );

  it("keeps the durable user notice out of provider context and sends one compact manifest", async () => {
    const { harness, scope } = await setupCoordinatorHarness();
    const owner = sessionOwner(scope);
    scope.parentStreaming = true;
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "interactive:agent-a:turn-a",
        source: "interactive",
        sourceId: "agent-a",
        turnId: "turn-a",
        label: "Agent a",
        status: "done",
        policy: "each",
        references: [
          {
            label: "output",
            value: "/tmp/artifacts/a/outputs/event-a.md",
          },
          {
            label: "activity",
            value: "/tmp/artifacts/a/events.ndjson",
          },
        ],
        completedAt: 1,
      },
      owner,
    );

    const completionEntries = harness.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "custom" &&
          entry.customType === "subagentura-completion",
      );
    expect(completionEntries).toHaveLength(1);
    expect(harness.contexts).toHaveLength(0);

    scope.parentStreaming = false;
    flushCompletionManifests(owner);
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const providerContext = JSON.stringify(harness.contexts[0]);
    expect(providerContext).toContain("Completed background work");
    expect(providerContext).toContain("outputs/event-a.md");
    expect(providerContext).toContain("events.ndjson");
    expect(JSON.stringify(harness.contexts[0].messages)).not.toContain(
      "subagentura-completion",
    );
    expect(providerContext).not.toContain("untrusted-subagent-output");
    harness.completeNext();
    await harness.session.waitForIdle();
  });

  it("attaches a ready manifest to human input instead of queuing another turn", async () => {
    const { harness, scope } = await setupCoordinatorHarness();
    const owner = sessionOwner(scope);
    scope.parentStreaming = true;
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "job:human-priority",
        source: "in-process",
        sourceId: "human-priority",
        label: "Job human-priority",
        status: "done",
        policy: "each",
        references: [
          {
            label: "result",
            value: 'call get_subagent_result with jobId "human-priority"',
          },
        ],
        completedAt: 2,
      },
      owner,
    );
    scope.parentStreaming = false;

    const prompt = harness.session.prompt("What changed?");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const providerContext = JSON.stringify(harness.contexts[0]);
    expect(providerContext).toContain("What changed?");
    expect(providerContext).toContain("Job human-priority");
    expect(
      harness.sessionManager
        .getEntries()
        .filter(
          (entry: any) =>
            entry.type === "custom_message" &&
            entry.customType === "subagent-manifest",
        ),
    ).toHaveLength(1);
    harness.completeNext();
    await prompt;
  });

  it("resumes once after every sealed related member is terminal", async () => {
    const { harness, scope } = await setupCoordinatorHarness();
    const owner = sessionOwner(scope);
    scope.parentStreaming = true;
    for (const id of ["group-a", "group-b"]) {
      registerCompletionMember("in-process", id, "group", "review", owner);
      publishCompletion(
        {
          schemaVersion: 1,
          completionId: `job:${id}`,
          source: "in-process",
          sourceId: id,
          label: `Job ${id}`,
          status: id === "group-a" ? "done" : "error",
          policy: "group",
          groupId: "review",
          references: [{ label: "result", value: `retrieve ${id}` }],
          completedAt: id === "group-a" ? 1 : 2,
        },
        owner,
      );
    }

    expect(harness.contexts).toHaveLength(0);
    scope.parentStreaming = false;
    settleCompletionParentTurn(owner);

    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const manifests = harness.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "custom_message" &&
          entry.customType === "subagent-manifest",
      );
    expect(manifests).toHaveLength(1);
    expect((manifests[0] as any).details.completionIds).toEqual([
      "job:group-a",
      "job:group-b",
    ]);
    harness.completeNext();
    await harness.session.waitForIdle();
  });

  it("does not advertise mutable output for a v2 completion without a snapshot", async () => {
    const { harness, scope } = await setupCoordinatorHarness();
    const owner = sessionOwner(scope);
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "interactive:child0001:turn-without-output",
        source: "interactive",
        sourceId: "child0001",
        turnId: "turn-without-output",
        label: "Agent child",
        status: "cancelled",
        policy: "each",
        references: [{ label: "activity", value: "/tmp/child/events.ndjson" }],
        completedAt: 1,
      },
      owner,
    );

    const notice = harness.sessionManager
      .getEntries()
      .find(
        (entry: any) =>
          entry.type === "custom" &&
          entry.customType === "subagentura-completion",
      ) as any;
    expect(notice.data.references).toEqual([
      { label: "activity", value: "/tmp/child/events.ndjson" },
    ]);
    expect(notice.data.references).not.toContain(
      expect.objectContaining({ label: "output" }),
    );
  });
});

describe("child protocol lifecycle integration", () => {
  it("uses persisted user entry ids for first and second turns", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);

    const first = harness.session.prompt("first turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.completeNext("first done");
    await first;
    await harness.session.waitForIdle();
    const second = harness.session.prompt("second turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.completeNext("second done");
    await second;
    await harness.session.waitForIdle();

    const userIds = harness.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "message" && entry.message?.role === "user",
      )
      .map((entry: any) => entry.id);
    const events = readEventRecords(art).map(({ event }) => event);
    expect(
      events
        .filter((event) => event.type === "turn_started")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
    expect(
      events
        .filter((event) => event.type === "completion")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
  });

  it("gives a mid-run steering message its own completion snapshot", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);
    const cli = join(art.dir, "cli.mjs");

    const run = harness.session.prompt("initial turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    writeCliScript(cli);
    await harness.session.prompt("mid-run follow-up", {
      streamingBehavior: "steer",
    });
    writeOutput(art, "initial output");
    expect(
      spawnSync(process.execPath, [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);

    harness.completeNext("initial assistant response");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    writeOutput(art, "follow-up output");
    expect(
      spawnSync(process.execPath, [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);
    harness.completeNext("follow-up assistant response");
    await run;
    await harness.session.waitForIdle();

    const userIds = harness.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "message" && entry.message?.role === "user",
      )
      .map((entry: any) => entry.id);
    const events = readEventRecords(art).map(({ event }) => event);
    expect(
      events
        .filter((event) => event.type === "turn_started")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
    expect(
      events
        .filter((event) => event.type === "completion")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
    expect(
      listOutputHistory(art).map((entry) =>
        entry.output ? readFileSync(entry.output.path, "utf8") : null,
      ),
    ).toEqual(["initial output", "follow-up output"]);
  });

  it("retry success ignores the intermediate error completion", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
      retrySettings: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 0,
        maxAgentDelayMs: 0,
      },
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("retry then succeed");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.failNext();
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.completeNext("recovered");
    await prompt;
    await harness.session.waitForIdle();

    const completions = readEventRecords(art)
      .map(({ event }) => event)
      .filter((event) => event.type === "completion") as any[];
    expect(completions).toEqual([
      expect.objectContaining({
        outcome: "done",
        source: "agent_settled",
      }),
    ]);
  });

  it("retry exhaustion records only the final error", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
      retrySettings: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 0,
        maxAgentDelayMs: 0,
      },
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("retry then fail");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.failNext("rate limit, please retry your request: first");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.failNext("rate limit, please retry your request: final");
    await prompt;
    await harness.session.waitForIdle();

    const completions = readEventRecords(art)
      .map(({ event }) => event)
      .filter((event) => event.type === "completion") as any[];
    expect(completions).toEqual([
      expect.objectContaining({
        outcome: "error",
        source: "agent_settled",
        errorMessage: expect.stringContaining("final"),
      }),
    ]);
  });

  it("deduplicates explicit CLI completion against agent_settled", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);
    const prompt = harness.session.prompt("explicit completion");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        JSON.parse(readFileSync(join(art.dir, "active-turn.json"), "utf8"))
          .started,
      ).toBe(true),
    );
    writeOutput(art, "explicit result");
    const cli = join(art.dir, "cli.mjs");
    writeCliScript(cli);
    expect(
      spawnSync("node", [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);
    harness.completeNext("settled result");
    await prompt;
    await harness.session.waitForIdle();

    const completions = readEventRecords(art)
      .map(({ event }) => event)
      .filter((event) => event.type === "completion") as any[];
    expect(completions).toEqual([
      expect.objectContaining({ outcome: "done", source: "explicit" }),
    ]);
  });

  it("resets output.md at turn start so an empty turn cannot inherit stale output", async () => {
    const art = childArtifact();
    writeOutput(art, "stale output from the previous turn");
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("produce no artifact output");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    expect(readFileSync(art.outputFile, "utf8")).toBe("");
    harness.completeNext("provider answer only");
    await prompt;
    await harness.session.waitForIdle();

    const completion = readEventRecords(art)
      .map(({ event }) => event)
      .find((event) => event.type === "completion") as any;
    expect(completion.output.bytes).toBe(0);
    expect(readFileSync(completion.output.path, "utf8")).toBe("");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createOrchestratorRoutingAuthorityEntry,
  type OrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import { getSessionScopes, sessionOwner } from "../src/session-scope";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
let harness: PiSessionHarness | undefined;
let cwd: string | undefined;
let fakeMuxBin: string | undefined;
let previousPath: string | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  previousPath = undefined;
  if (fakeMuxBin) rmSync(fakeMuxBin, { recursive: true, force: true });
  fakeMuxBin = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Jev advisor in a real Pi session", () => {
  it.skipIf(!("classify" in ModelRegistry.prototype))(
    "routes an authorized child through Luna and fails closed on uncertain or stale results",
    async () => {
      vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
      vi.stubEnv("PI_ORCHESTRATOR_ROUTER_PROVIDER", "openai");
      vi.stubEnv("PI_ORCHESTRATOR_ROUTER_MODEL", "gpt-6-luna");
      vi.stubEnv("PI_ORCHESTRATOR_ROUTER_MIN_TOP_PROBABILITY", "0.5");
      vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      fakeMuxBin = join(process.cwd(), `.test-tmux-${process.pid}`);
      mkdirSync(fakeMuxBin, { recursive: true });
      const fakeTmux = join(fakeMuxBin, "tmux");
      writeFileSync(
        fakeTmux,
        '#!/bin/sh\nif [ "$1" = "list-panes" ]; then printf \'%s\\n\' \'%42\'; else exit 0; fi\n',
      );
      chmodSync(fakeTmux, 0o755);
      previousPath = process.env.PATH;
      process.env.PATH = `${fakeMuxBin}:${process.env.PATH ?? ""}`;
      cwd = mkdtempSync(join(tmpdir(), "pi-jev-route-session-"));
      harness = await createPiSessionHarness(cwd, {
        extensionRoot,
        extensionFlags: { orchestratorv2: true },
        bindExtensionLifecycle: true,
        includeTools: true,
      });
      const routeTool = harness.session.extensionRunner.getToolDefinition(
        "resolve_orchestrator_route",
      ) as any;
      expect(routeTool).toBeDefined();

      const scope = getSessionScopes().find((candidate) => candidate.cwd === cwd);
      expect(scope).toBeDefined();
      const childId = "0123456789abcdef";
      const entry: OrchestratorRoutingEntry = {
        childId,
        description: "Own the API validation work",
        aliases: ["API review"],
        provenance: "user",
        updatedAt: new Date().toISOString(),
      };
      harness.session.sessionManager.appendCustomEntry(
        "orchestratorv2-routing-authority",
        createOrchestratorRoutingAuthorityEntry(cwd, entry),
      );
      const parentSessionId = harness.session.sessionManager.getSessionId();
      scope!.interactiveStates.set(childId, {
        id: childId,
        name: "api-reviewer",
        task: "Review API validation",
        paneId: "%42",
        mux: "tmux",
        sessionFile: join(cwd, "child-session.jsonl"),
        cwd,
        startedAt: Date.now(),
        status: "running",
        attachCommand: "tmux attach -t test",
        selectPaneCommand: "tmux select-pane -t %42",
        launchScriptFile: join(cwd, "launch.sh"),
        artifactDir: join(cwd, "artifacts", childId),
        sessionOwner: sessionOwner(scope!),
        parentSessionId,
      });

      const response = (
        choice: string,
        probabilities: Record<string, number>,
        confidence = 0.95,
      ) =>
        Response.json({
          answers: [
            {
              name: "route",
              type: "choice",
              choice,
              probabilities: Object.entries(probabilities).map(
                ([value, probability]) => ({ value, probability }),
              ),
              confidence,
            },
          ],
          usage: { input_tokens: 20, output_tokens: 3 },
        });
      harness.session.modelRuntime.registerProvider("openai", {
        apiKey: "synthetic-test-key",
      });
      const context = harness.session.extensionRunner.createToolContext(
        "route-live",
        undefined,
      );
      const registryTool = harness.session.extensionRunner.getToolDefinition(
        "list_orchestrator_agents",
      ) as any;
      const listed = await registryTool.execute(
        "list-live",
        {},
        undefined,
        undefined,
        context,
      );
      expect(listed.details.agents).toEqual([
        expect.objectContaining({ childId, actionable: true }),
      ]);
      const execute = () =>
        routeTool!.execute(
          "route-live",
          { task: "Review API validation" },
          undefined,
          undefined,
          context,
        );

      fetch.mockResolvedValueOnce(
        response("candidate_0", { candidate_0: 0.9, none: 0.1 }),
      );
      const matched = await execute();
      expect(matched.details.decision).toMatchObject({
        kind: "match",
        childId,
      });

      fetch.mockResolvedValueOnce(
        response("candidate_0", { candidate_0: 0.9, none: 0.1 }, 0.4),
      );
      const lowConfidence = await execute();
      expect(lowConfidence.details.decision).toMatchObject({
        kind: "no_match",
        reason: "low_confidence",
      });

      fetch.mockResolvedValueOnce(
        response("forged-choice", { "forged-choice": 0.9, none: 0.1 }),
      );
      const malformed = await execute();
      expect(malformed.details.decision).toMatchObject({
        kind: "error",
        reason: "invalid_response",
      });

      fetch.mockResolvedValueOnce(
        response("candidate_0", { candidate_0: 0.5, none: 0.5 }),
      );
      const ambiguous = await execute();
      expect(ambiguous.details.decision).toMatchObject({
        kind: "no_match",
        reason: "ambiguous",
      });

      let finishRequest!: (result: Response) => void;
      fetch.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finishRequest = resolve;
        }),
      );
      const staleRequest = execute();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5), {
        timeout: 5_000,
      });
      const changedEntry = { ...entry, description: "Changed API authority" };
      harness.session.sessionManager.appendCustomEntry(
        "orchestratorv2-routing-authority",
        createOrchestratorRoutingAuthorityEntry(cwd, changedEntry),
      );
      finishRequest(
        response("candidate_0", { candidate_0: 0.9, none: 0.1 }),
      );
      const stale = await staleRequest;
      expect(stale.details.decision).toMatchObject({
        kind: "error",
        reason: "state_changed",
      });
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(
        scope!.interactiveStates.get(childId)?.parentSessionId,
      ).toBe(parentSessionId);
    },
  );

  it.skipIf(!("classify" in ModelRegistry.prototype))(
    "registers exactly once after late flag binding and reload with native auth",
    async () => {
      vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
      vi.stubEnv("OPENROUTER_API_KEY", "synthetic-test-key");
      const fetch = vi.fn().mockRejectedValue(new Error("unexpected network"));
      vi.stubGlobal("fetch", fetch);
      cwd = mkdtempSync(join(tmpdir(), "pi-jev-enabled-"));
      harness = await createPiSessionHarness(cwd, {
        extensionRoot,
        extensionFlags: { orchestratorv2: true },
        bindExtensionLifecycle: true,
        includeTools: true,
      });
      const advisorNames = () =>
        harness!.session
          .getActiveToolNames()
          .filter((name) => name === "resolve_orchestrator_route");
      expect(advisorNames()).toHaveLength(1);
      await harness.reload();
      expect(advisorNames()).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("stays absent after late flag binding and reload without a native authenticated classifier", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected network"));
    vi.stubGlobal("fetch", fetch);
    cwd = mkdtempSync(join(tmpdir(), "pi-jev-session-"));

    // This real SDK harness loads the extension before applying flag values,
    // matching the CLI order that a factory-only registration check misses.
    harness = await createPiSessionHarness(cwd, {
      extensionRoot,
      extensionFlags: { orchestratorv2: true },
      bindExtensionLifecycle: true,
      includeTools: true,
    });

    expect(harness.session.getActiveToolNames()).not.toContain(
      "resolve_orchestrator_route",
    );
    await harness.reload();
    expect(
      harness.session
        .getActiveToolNames()
        .filter((name) => name === "resolve_orchestrator_route"),
    ).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the advisor absent in a real legacy session with the env opt-in", async () => {
    vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected network"));
    vi.stubGlobal("fetch", fetch);
    cwd = mkdtempSync(join(tmpdir(), "pi-jev-legacy-"));
    harness = await createPiSessionHarness(cwd, {
      extensionRoot,
      extensionFlags: { orchestrator: true },
      bindExtensionLifecycle: true,
      includeTools: true,
    });

    expect(
      harness.session.getAllTools().map((tool) => tool.name),
    ).not.toContain("resolve_orchestrator_route");
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { writeFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { captureTelemetry, createTelemetrySession } from "../src/telemetry";
import { expectBlockedPosthogFetches } from "./helpers/posthog-egress-guard";
import {
  clearTelemetryFetchSentinelCalls,
  telemetryFetchSentinelCalls,
} from "./helpers/telemetry-fetch-sentinel";

describe.skipIf(process.env.PI_TELEMETRY_FETCH_SENTINEL !== "1")(
  "actual telemetry consumer setup",
  () => {
    beforeEach(clearTelemetryFetchSentinelCalls);

    it("blocks enabled telemetry before the underlying fetch sentinel", () => {
      captureTelemetry(createTelemetrySession(true), {
        event: "session_started",
      });

      expect(telemetryFetchSentinelCalls()).toBe(0);
      expectBlockedPosthogFetches(1);
      const markerPath = process.env.PI_TELEMETRY_GUARD_POSITIVE_MARKER;
      if (markerPath !== undefined) {
        writeFileSync(
          markerPath,
          JSON.stringify({
            callbackCompleted: true,
            sentinelCalls: telemetryFetchSentinelCalls(),
          }),
        );
      }
    });

    it("keeps explicit collectors and restores the guard after mocks", () => {
      let collectedPayload: unknown;
      const collector = vi.fn<typeof fetch>(async (_input, init) => {
        collectedPayload = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      });
      const event = { event: "session_started" } as const;

      vi.stubGlobal("fetch", collector);
      captureTelemetry(createTelemetrySession(true), event);
      expect(collector).toHaveBeenCalledTimes(1);
      expect(collectedPayload).toMatchObject({
        event: "pi_subagentura_session_started",
        properties: { traffic_origin: "unknown" },
      });

      vi.unstubAllGlobals();
      vi.spyOn(globalThis, "fetch").mockImplementation(collector);
      captureTelemetry(createTelemetrySession(true), event);
      expect(collector).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
      clearTelemetryFetchSentinelCalls();
      captureTelemetry(createTelemetrySession(true), event);
      expect(telemetryFetchSentinelCalls()).toBe(0);
      expectBlockedPosthogFetches(1);
    });

    it.each([
      ["string", "https://us.i.posthog.com/i/v0/e/"],
      ["URL", new URL("https://eu.i.posthog.com/i/v0/e/")],
      ["Request", new Request("https://us.posthog.com/i/v0/e/")],
      ["PostHog IO", "https://app.posthog.io/capture/"],
    ])(
      "blocks a PostHog service request passed as %s",
      async (_form, input) => {
        const blocked = await fetch(input).then(
          () => false,
          () => true,
        );

        expect(blocked).toBe(true);
        expect(telemetryFetchSentinelCalls()).toBe(0);
        expectBlockedPosthogFetches(1);
      },
    );

    it.each([
      ["local", "http://127.0.0.1:1/health"],
      ["host-boundary attacker", "https://posthog.com.attacker.invalid/"],
    ])(
      "allows unrelated %s fetches through the guard",
      async (_case, input) => {
        const response = await fetch(input);

        expect(response.status).toBe(204);
        expect(telemetryFetchSentinelCalls()).toBe(1);
      },
    );

    describe("suite-scoped collectors", () => {
      const collector = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 204 }),
      );

      beforeAll(() => {
        vi.stubGlobal("fetch", collector);
      });
      beforeEach(() => collector.mockClear());

      it("keeps the collector active for its first test", () => {
        captureTelemetry(createTelemetrySession(true), {
          event: "session_started",
        });

        expect(collector).toHaveBeenCalledTimes(1);
      });

      it("keeps the collector active for its next test", () => {
        captureTelemetry(createTelemetrySession(true), {
          event: "session_started",
        });

        expect(collector).toHaveBeenCalledTimes(1);
      });

      afterAll(() => {
        vi.unstubAllGlobals();
        clearTelemetryFetchSentinelCalls();
        captureTelemetry(createTelemetrySession(true), {
          event: "session_started",
        });

        expect(telemetryFetchSentinelCalls()).toBe(0);
        expectBlockedPosthogFetches(1);
      });
    });
  },
);

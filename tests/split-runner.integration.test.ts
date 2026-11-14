import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { clearSessionScopes } from "../src/session-scope";
import {
  createPiSessionHarness,
  type PiSessionHarness,
  withIsolatedPiRuntime,
} from "./helpers/pi-session-harness";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const invalidFlags: Array<Record<string, boolean | string>> = [
  { split: true },
  { split: true, orchestrator: true },
  { split: true, orchestratorv2: true, orchestrator: true },
  { split: "true", orchestratorv2: true },
];
const validModes: Array<{
  flags: Record<string, boolean | string>;
  v2: boolean;
  split: boolean;
}> = [
  { flags: {}, v2: false, split: false },
  { flags: { orchestratorv2: true }, v2: true, split: false },
  { flags: { orchestratorv2: true, split: true }, v2: true, split: true },
];

const harnesses: PiSessionHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  clearSessionScopes();
});

async function submitThroughPi(harness: PiSessionHarness): Promise<void> {
  let settled = false;
  const prompt = harness.session.prompt("Return a short answer.").then(
    () => {
      settled = true;
    },
    () => {
      // A rejected prompt is a valid way to stop an invalid configuration.
      settled = true;
    },
  );
  try {
    await expect.poll(() => settled || harness.contexts.length > 0).toBe(true);
  } finally {
    // Finish an unexpected provider call so a regression cannot hang the suite.
    if (harness.contexts.length > 0) harness.completeNext("Test response.");
    else if (!settled) await harness.session.abort();
    await prompt;
  }
}

describe("split validation through the Pi runner", () => {
  it.each(invalidFlags)(
    "prevents provider requests for invalid flags %j",
    async (flags) => {
      await withIsolatedPiRuntime(async ({ cwd }) => {
        const harness = await createPiSessionHarness(cwd, {
          extensionRoot,
          extensionFlags: flags,
          bindExtensionLifecycle: true,
        });
        harnesses.push(harness);
        await submitThroughPi(harness);
        expect(harness.contexts).toHaveLength(0);
      });
    },
  );

  it.each(validModes)(
    "allows valid configuration %j",
    async ({ flags, v2, split }) => {
      await withIsolatedPiRuntime(async ({ cwd }) => {
        const harness = await createPiSessionHarness(cwd, {
          extensionRoot,
          extensionFlags: flags,
          bindExtensionLifecycle: true,
        });
        harnesses.push(harness);
        const errors: string[] = [];
        const unsubscribe = harness.session.extensionRunner.onError((error) => {
          errors.push(error.error);
        });
        try {
          await submitThroughPi(harness);
          expect(harness.contexts).toHaveLength(1);
          const systemPrompt = JSON.stringify(harness.contexts[0]?.messages);
          expect(systemPrompt.includes("# Orchestratorv2 Thin Router")).toBe(
            v2,
          );
          expect(systemPrompt.includes("# Orchestratorv2 Split Policy")).toBe(
            split,
          );
          expect(errors).toEqual([]);
        } finally {
          unsubscribe();
        }
      });
    },
  );
});

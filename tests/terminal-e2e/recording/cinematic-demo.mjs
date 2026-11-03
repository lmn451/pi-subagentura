import { spawn } from "node:child_process";
import { getScenario } from "../scenarios.mjs";
import { createHarness } from "../harness.mjs";

const name = process.argv[2] ?? "interactive";
const scenario = getScenario(name);
const harness = createHarness({ scenario: name, keep: false });
const toolInspectionScenarios = new Map(
  Object.entries({
    "async-isolated": {
      marker: "[E2E:ASYNC_RESULT]",
      prompt: "[E2E:ASYNC_RESULT] Collect the completed async result.",
      expected: "Child result for [E2E:CHILD_ASYNC_ISOLATED].",
    },
    "background-workflow": {
      marker: "[E2E:WORKFLOW_RESULT]",
      prompt: "[E2E:WORKFLOW_RESULT] Collect the completed workflow result.",
      expected: "Child result for [E2E:CHILD_WORKFLOW].",
    },
    interactive: {
      marker: "[E2E:INTERACTIVE_READ]",
      prompt: "[E2E:INTERACTIVE_READ] Read the completed child artifact.",
      expected: "[E2E:INTERACTIVE_OUTPUT_1]",
    },
    "interactive-error": {
      marker: "[E2E:INTERACTIVE_READ]",
      prompt: "[E2E:INTERACTIVE_READ] Read the failed child artifact.",
      expected: "Artifact for",
    },
  }),
);
let failed = false;

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function providerReached(marker, stages) {
  return harness
    .providerEvents()
    .some(
      (event) => event.marker === marker && stages.includes(event.afterStage),
    );
}

function clientNames() {
  let output;
  try {
    output = harness.tmux([
      "list-clients",
      "-t",
      harness.session,
      "-F",
      "#{client_name}",
    ]);
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("no server running")) return [];
    throw error;
  }
  return output.trim().split("\n").filter(Boolean);
}

function caption(message, durationMs = 2200) {
  const [client] = clientNames();
  if (!client) throw new Error("cinematic demo has no attached tmux client");
  harness.tmux([
    "display-message",
    "-c",
    client,
    "-d",
    String(durationMs),
    message,
  ]);
}

async function typeText(text, delayMs = 24) {
  for (const character of text) {
    harness.sendText(character);
    await sleep(delayMs);
  }
}

async function attachTmux() {
  const child = spawn(
    "tmux",
    ["-L", harness.socket, "attach-session", "-t", harness.session],
    { stdio: "inherit", env: harness.env },
  );
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(`tmux attach exited with code=${code} signal=${signal}`),
        );
    });
  });
}

function detachTmux() {
  const clients = harness.started ? clientNames() : [];
  if (clients.length > 0)
    harness.tmux(["detach-client", "-s", harness.session]);
}

async function showToolInspection() {
  const inspection = toolInspectionScenarios.get(name);
  if (!inspection) return;
  caption("STEP 4/4  Use result tools to inspect the completed child", 3000);
  await sleep(700);
  await typeText(inspection.prompt, 70);
  harness.pressEnter();
  await harness.waitForProvider(
    () => providerReached(inspection.marker, ["complete"]),
    `${name} cinematic tool inspection`,
  );
  await harness.waitForScreen(
    (screen) => screen.includes(inspection.expected),
    "cinematic tool inspection result",
  );
  await sleep(1800);
}

async function runCinematicSequence() {
  await harness.waitFor(
    () => clientNames().length > 0,
    "cinematic tmux client",
    5000,
  );
  harness.tmux([
    "set-option",
    "-t",
    harness.session,
    "message-style",
    "bg=colour31,fg=white,bold",
  ]);
  caption("STEP 1/4  Type a deterministic request into the parent Pi", 3200);
  await sleep(900);
  await typeText(scenario.prompt);
  await sleep(500);
  harness.pressEnter();
  caption("STEP 2/4  The parent launches a real sub-agent", 3000);

  if (scenario.gate && scenario.child) {
    await harness.waitForProvider(
      () => providerReached(scenario.child, ["gated"]),
      `${name} cinematic gate`,
    );
    caption("STEP 3/4  Child is running; release the deterministic gate", 3000);
    await sleep(1800);
    harness.release(scenario.gate);
  }
  if (scenario.child) {
    await harness.waitForProvider(
      () => providerReached(scenario.child, ["complete", "failed"]),
      `${name} cinematic child completion`,
    );
  }
  await harness.waitForProvider(
    () => providerReached(scenario.marker, ["complete", "failed"]),
    `${name} cinematic parent completion`,
  );
  await sleep(1800);

  await showToolInspection();
  caption(`DONE  ${name} completed without real LLM or network calls`, 2800);
  await sleep(2800);
  detachTmux();
}

try {
  await harness.start();
  await Promise.all([attachTmux(), runCinematicSequence()]);
  await harness.assertNoNetwork();
} catch (error) {
  failed = true;
  console.error(error);
  process.exitCode = 1;
} finally {
  detachTmux();
  await harness.cleanup(failed);
}

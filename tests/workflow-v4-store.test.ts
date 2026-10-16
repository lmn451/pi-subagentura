import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunStore } from "../src/workflow-run-store";
import { WorkflowV4Store, workflowV4Steps } from "../src/workflow-v4-store";

let root: string;
const stores: WorkflowRunStore[] = [];
const steps: WorkflowV4Store[] = [];
const script = 'export const meta={name:"steps",description:"d"}; return 1;';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workflow-v4-store-"));
});
afterEach(async () => {
  for (const state of steps.splice(0)) state.close();
  for (const store of stores.splice(0)) await store.close();
  await rm(root, { recursive: true, force: true });
});
async function setup() {
  const scope = { cwd: root, sessionId: "workflow-v4", root };
  const store = await WorkflowRunStore.create(scope, { script });
  stores.push(store);
  const state = new WorkflowV4Store(script, store);
  steps.push(state);
  return { scope, store, state };
}

describe("v4 step journal", () => {
  it("reuses a committed output after reopening, while invalidating changed inputs and definitions", async () => {
    const { scope, store, state } = await setup();
    await state.request("step.enter", {
      path: ["review"],
      input: { file: "one" },
    });
    await state.request("step.complete", {
      path: ["review"],
      value: { ok: true },
    });
    state.close();
    await store.close();
    const recovered = await WorkflowRunStore.resume(scope, store.id);
    stores.push(recovered);
    const fresh = new WorkflowV4Store(script, recovered);
    steps.push(fresh);
    expect(
      await fresh.request("step.enter", {
        path: ["review"],
        input: { file: "one" },
      }),
    ).toMatchObject({ reuse: true, value: { ok: true } });
    expect(
      await fresh.request("step.enter", {
        path: ["review"],
        input: { file: "two" },
      }),
    ).toMatchObject({ reuse: false });
    expect(fresh.snapshot()[0]).not.toHaveProperty("output");
    expect(fresh.snapshot()[0]).not.toHaveProperty("input");
    fresh.close();
    const changed = new WorkflowV4Store(script + "\n// changed", recovered);
    steps.push(changed);
    expect(
      await changed.request("step.enter", {
        path: ["review"],
        input: { file: "two" },
      }),
    ).toMatchObject({ reuse: false });
  });

  it("retains waiting questions and persists an answer before releasing execution", async () => {
    const { state, store, scope } = await setup();
    await state.request("step.enter", { path: ["approve"], kind: "gate" });
    const pending = state.request("gate.wait", {
      path: ["approve"],
      request: { type: "confirm", question: "Proceed?" },
    });
    void pending.catch(() => {
      /* The assertion below observes the awaited request. */
    });
    await vi.waitFor(() =>
      expect(workflowV4Steps(store.events)[0].status).toBe("waiting_for_input"),
    );
    await expect(state.answer(["approve"], "yes")).rejects.toThrow("boolean");
    await state.answer(["approve"], true);
    await expect(pending).resolves.toBe(true);
    expect(store.events.at(-1)?.data.answer).toBe(true);
    state.close();
    await store.close();
    const recovered = await WorkflowRunStore.resume(scope, store.id);
    stores.push(recovered);
    const fresh = new WorkflowV4Store(script, recovered);
    steps.push(fresh);
    await expect(
      fresh.request("gate.wait", {
        path: ["approve"],
        request: { type: "confirm" },
      }),
    ).resolves.toBe(true);
  });

  it("stores artifacts privately, bounds values, and honors disabled persistence", async () => {
    const { state, store } = await setup();
    const ref = await state.request("artifact.write", {
      path: ["report"],
      value: { report: "sensitive-report-value" },
      type: "json",
    });
    expect(await state.request("artifact.read", { ref })).toEqual({
      report: "sensitive-report-value",
    });
    expect(
      (await stat(join(store.directory, "v4-artifacts", ref.id))).mode & 0o777,
    ).toBe(0o600);
    expect(JSON.stringify(store.events)).not.toContain(
      "sensitive-report-value",
    );
    await expect(
      state.request("step.enter", {
        path: ["large"],
        input: "x".repeat(513 * 1024),
      }),
    ).rejects.toThrow("512 KiB");
    await state.request("step.enter", {
      path: ["ephemeral"],
      policy: { persist: false },
    });
    await state.request("step.complete", {
      path: ["ephemeral"],
      value: "secret output",
    });
    expect(JSON.stringify(store.events)).not.toContain("secret output");
    expect(
      await state.request("step.enter", {
        path: ["ephemeral"],
        policy: { persist: false },
      }),
    ).toMatchObject({ reuse: false });
  });
  it("rejects same-size artifact corruption", async () => {
    const { state, store } = await setup();
    const ref = await state.request("artifact.write", {
      path: ["report"],
      value: "safe",
      type: "text",
    });
    await writeFile(join(store.directory, "v4-artifacts", ref.id), "evil");
    await expect(state.request("artifact.read", { ref })).rejects.toThrow(
      "integrity",
    );
  });

  it("keeps waiting steps visible when completed history exceeds the snapshot limit", () => {
    const events = Array.from({ length: 300 }, (_, index) => ({
      kind: "v4.step",
      data: {
        path: [`step-${index}`],
        status: index === 299 ? "waiting_for_input" : "completed",
        input: "private",
        policy: "private",
        output: "private",
      },
    }));
    const snapshot = workflowV4Steps(events);
    expect(snapshot).toHaveLength(256);
    expect(snapshot.some((node) => node.status === "waiting_for_input")).toBe(
      true,
    );
    expect(snapshot.every((node) => !("output" in node))).toBe(true);
  });

  it("retires active steps on terminal cancellation but preserves interruption waits", () => {
    const waiting = {
      kind: "v4.step",
      data: {
        path: ["approval"],
        status: "waiting_for_input",
        input: "private",
        policy: "private",
        request: { question: "Proceed?" },
      },
    };
    expect(
      workflowV4Steps([
        waiting,
        { kind: "cancelled", data: { status: "cancelled" } },
      ])[0].status,
    ).toBe("cancelled");
    expect(
      workflowV4Steps([
        waiting,
        { kind: "interrupted", data: { status: "interrupted" } },
      ])[0].status,
    ).toBe("waiting_for_input");
  });

  it("publishes a live store snapshot with terminal active steps retired", async () => {
    const { store, state } = await setup();
    await state.request("step.enter", { path: ["approval"], kind: "ask" });
    await store.append("cancelled", {
      status: "cancelled",
      completedAt: Date.now(),
    });
    expect(state.snapshot()[0].status).toBe("cancelled");
  });

  it("changes agent idempotency identity when step inputs or policy change", async () => {
    const { state } = await setup();
    const first = await state.request("step.enter", {
      path: ["agent"],
      input: "old prompt",
    });
    await state.request("step.complete", {
      path: ["agent"],
      value: "old result",
    });
    const changed = await state.request("step.enter", {
      path: ["agent"],
      input: "new prompt",
    });
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    const policy = await state.request("step.enter", {
      path: ["agent"],
      input: "new prompt",
      policy: { cache: false },
    });
    expect(policy.idempotencyKey).not.toBe(changed.idempotencyKey);
  });

  it("starts a fresh attempt identity when a completed agent disables caching", async () => {
    const { state } = await setup();
    const payload = {
      path: ["agent"],
      input: "same prompt",
      policy: { cache: false },
    };
    const first = await state.request("step.enter", payload);
    await state.request("step.complete", {
      path: payload.path,
      value: "old result",
    });
    const second = await state.request("step.enter", payload);
    expect(second).toMatchObject({ reuse: false, attempt: 1 });
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

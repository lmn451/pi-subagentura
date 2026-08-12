import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(
  new URL("./fixtures/workflow-lease-child.mjs", import.meta.url),
);
const leaseSource = fileURLToPath(
  new URL("../src/workflow-lease.ts", import.meta.url),
);
const compiler = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);
const roots: string[] = [];

type ChildResult = {
  ok: boolean;
  record?: { epoch: number; ownerId: string; processId?: number };
  error?: string;
};

function startChild(
  rootDir: string,
  ownerId: string,
  leaseToken: string,
  now: number,
  modulePath: string,
  processId?: number,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      fixture,
      "hold",
      rootDir,
      "project",
      ownerId,
      leaseToken,
      "10",
      String(now),
      modulePath,
      ...(processId === undefined ? [] : [String(processId)]),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

function firstResult(
  child: ChildProcessWithoutNullStreams,
): Promise<ChildResult> {
  const reader = createInterface({ input: child.stdout });
  let received = false;
  return new Promise((resolve, reject) => {
    const onLine = (line: string): void => {
      received = true;
      reader.close();
      try {
        resolve(JSON.parse(line) as ChildResult);
      } catch (error) {
        reject(error);
      }
    };
    reader.once("line", onLine);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && !received) {
        reject(new Error(`lease child exited before result: ${code}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkflowNamespaceLease cross-process fencing", () => {
  it("allows one initial child acquire and fences takeover to epoch two after death", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-lease-child-"));
    roots.push(root);
    const compilation = spawnSync(
      process.execPath,
      [
        compiler,
        leaseSource,
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--outDir",
        join(root, "compiled"),
        "--skipLibCheck",
        "--declaration",
        "false",
      ],
      { encoding: "utf8" },
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const modulePath = join(root, "compiled", "workflow-lease.js");
    const first = startChild(root, "child-one", "token-one", 100, modulePath);
    const second = startChild(root, "child-two", "token-two", 100, modulePath);
    const [firstOutcome, secondOutcome] = await Promise.all([
      firstResult(first),
      firstResult(second),
    ]);

    expect([firstOutcome.ok, secondOutcome.ok].filter(Boolean)).toHaveLength(1);
    expect(
      [firstOutcome.ok, secondOutcome.ok].filter((value) => !value),
    ).toHaveLength(1);
    const winner = firstOutcome.ok ? first : second;
    const loser = firstOutcome.ok ? second : first;
    expect(
      firstOutcome.ok ? firstOutcome.record : secondOutcome.record,
    ).toMatchObject({ epoch: 1 });
    await waitForExit(loser);
    winner.kill("SIGKILL");
    await waitForExit(winner);

    const takeover = spawn(
      process.execPath,
      [
        fixture,
        "acquire",
        root,
        "project",
        "replacement",
        "token-replacement",
        "10",
        "111",
        modulePath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const takeoverResult = await firstResult(takeover);
    await waitForExit(takeover);
    if (!takeoverResult.ok) throw new Error(takeoverResult.error);
    expect(takeoverResult).toMatchObject({
      ok: true,
      record: { epoch: 2, ownerId: "replacement" },
    });
  });

  it("F04 keeps a replacement lease when a stale child releases after takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-lease-child-"));
    roots.push(root);
    const compilation = spawnSync(
      process.execPath,
      [
        compiler,
        leaseSource,
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--outDir",
        join(root, "compiled"),
        "--skipLibCheck",
        "--declaration",
        "false",
      ],
      { encoding: "utf8" },
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const modulePath = join(root, "compiled", "workflow-lease.js");
    const stale = startChild(
      root,
      "stale-child",
      "stale-token",
      100,
      modulePath,
      2_000_000_000,
    );
    await expect(firstResult(stale)).resolves.toMatchObject({
      ok: true,
      record: { epoch: 1, ownerId: "stale-child" },
    });
    expect(stale.exitCode).toBeNull();

    const replacement = spawn(
      process.execPath,
      [
        fixture,
        "acquire",
        root,
        "project",
        "replacement-child",
        "replacement-token",
        "10",
        "111",
        modulePath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await expect(firstResult(replacement)).resolves.toMatchObject({
      ok: true,
      record: { epoch: 2, ownerId: "replacement-child" },
    });
    await waitForExit(replacement);
    const beforeRelease = JSON.parse(
      await readFile(join(root, "project", "namespace.lease"), "utf8"),
    ) as { epoch: number; ownerId: string };
    expect(beforeRelease).toMatchObject({
      epoch: 2,
      ownerId: "replacement-child",
    });

    stale.stdin.end();
    await waitForExit(stale);
    const record = JSON.parse(
      await readFile(join(root, "project", "namespace.lease"), "utf8"),
    ) as { epoch: number; ownerId: string };
    expect(record).toMatchObject({ epoch: 2, ownerId: "replacement-child" });
  });

  it("F04 fences an immediate child-process restart to the next lease epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-lease-child-"));
    roots.push(root);
    const compilation = spawnSync(
      process.execPath,
      [
        compiler,
        leaseSource,
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--outDir",
        join(root, "compiled"),
        "--skipLibCheck",
        "--declaration",
        "false",
      ],
      { encoding: "utf8" },
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const modulePath = join(root, "compiled", "workflow-lease.js");
    const first = startChild(
      root,
      "first-process",
      "first-token",
      100,
      modulePath,
    );
    await expect(firstResult(first)).resolves.toMatchObject({
      ok: true,
      record: { epoch: 1, ownerId: "first-process" },
    });
    first.kill("SIGKILL");
    await waitForExit(first);

    const replacement = spawn(
      process.execPath,
      [
        fixture,
        "acquire",
        root,
        "project",
        "immediate-restart",
        "restart-token",
        "10",
        "111",
        modulePath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await expect(firstResult(replacement)).resolves.toMatchObject({
      ok: true,
      record: { epoch: 2, ownerId: "immediate-restart" },
    });
    await waitForExit(replacement);
  });

  it("F04 fails closed for a child that reuses a PID with a different start identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-lease-child-"));
    roots.push(root);
    const compilation = spawnSync(
      process.execPath,
      [
        compiler,
        leaseSource,
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--outDir",
        join(root, "compiled"),
        "--skipLibCheck",
        "--declaration",
        "false",
      ],
      { encoding: "utf8" },
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const modulePath = join(root, "compiled", "workflow-lease.js");
    const reused = spawn(
      process.execPath,
      [
        fixture,
        "reused-pid",
        root,
        "project",
        "reused-process",
        "reused-token",
        "10",
        "111",
        modulePath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await expect(firstResult(reused)).resolves.toMatchObject({
      ok: false,
      error: "Workflow namespace lease process identity changed",
    });
    await waitForExit(reused);
  });
});

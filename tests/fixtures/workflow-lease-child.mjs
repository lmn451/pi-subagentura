import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [
  command,
  rootDir,
  namespace,
  ownerId,
  leaseToken,
  staleAfterArg,
  nowArg,
  modulePath,
  processIdArg,
  processStartTimeArg,
] = process.argv.slice(2);
const { WorkflowNamespaceLease } = await import(pathToFileURL(modulePath).href);
const staleAfterMs = staleAfterArg ? Number(staleAfterArg) : undefined;
const fixedNow = nowArg === undefined ? undefined : Number(nowArg);
const processId = processIdArg ? Number(processIdArg) : process.pid;
const processStartTime =
  processStartTimeArg === undefined
    ? Math.floor(Date.now() - process.uptime() * 1000)
    : Number(processStartTimeArg);
const lease = new WorkflowNamespaceLease({
  rootDir,
  namespace,
  ownerId,
  leaseToken,
  ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  ...(fixedNow === undefined ? {} : { now: () => fixedNow }),
  processId,
  processStartTime,
});

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  if (command === "reused-pid") {
    const namespaceDir = join(rootDir, namespace);
    await mkdir(namespaceDir, { recursive: true });
    await writeFile(
      join(namespaceDir, "namespace.lease"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerId: "old-owner",
        leaseToken: "old-token",
        epoch: 7,
        acquiredAt: (fixedNow ?? Date.now()) - (staleAfterMs ?? 1) - 1,
        processId: process.pid,
        processStartTime: 0,
      })}\n`,
    );
  } else if (command !== "acquire" && command !== "hold") {
    throw new Error(`unknown command: ${command}`);
  }
  const record = await lease.acquire();
  emit({ ok: true, record });
  if (command === "hold") {
    await once(process.stdin, "end");
    await lease.release();
    emit({ ok: true, released: true });
  }
} catch (error) {
  emit({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}

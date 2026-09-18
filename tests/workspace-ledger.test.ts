import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceLedgerError,
  acquireWorkspaceClaim,
  createEmptyWorkspaceLedger,
  createRepositoryRecord,
  findHeldWorkspaceClaim,
  loadWorkspaceLedger,
  readWorkspaceLedger,
  releaseWorkspaceClaim,
  saveWorkspaceLedger,
  updateWorkspaceLedger,
  withWorkspaceLedgerLock,
} from "../src/workspace-ledger";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspace-ledger-"));
  roots.push(root);
  const repository = createRepositoryRecord({
    commonDir: root,
    gitDir: root,
    objectFormat: "sha1",
  });
  return { root, repository, ledger: createEmptyWorkspaceLedger(repository) };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workspace ledger persistence", () => {
  it("writes an fsynced private ledger and enforces revision CAS", () => {
    const { root, ledger } = fixture();
    saveWorkspaceLedger(root, ledger);
    expect(loadWorkspaceLedger(root)?.ledgerRevision).toBe(0);
    const next = updateWorkspaceLedger(root, 0, (current) => {
      current.proposalCursors.example = 1;
    });
    expect(next.ledgerRevision).toBe(1);
    expect(() => updateWorkspaceLedger(root, 0, () => undefined)).toThrowError(
      expect.objectContaining({ code: "cas_conflict" }),
    );
  });

  it("rejects future, malformed, symlinked, and incorrectly-modeled ledgers", () => {
    const { root, ledger } = fixture();
    saveWorkspaceLedger(root, ledger);
    const file = join(root, "subagentura-workspace.json");
    chmodSync(file, 0o644);
    expect(readWorkspaceLedger(root)).toEqual({
      kind: "invalid",
      reason: "wrong_mode",
    });
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify({ ...ledger, schemaVersion: 2 }), {
      mode: 0o600,
    });
    expect(readWorkspaceLedger(root)).toEqual({
      kind: "invalid",
      reason: "future_schema",
    });
    writeFileSync(file, JSON.stringify({ ...ledger, unknown: true }), {
      mode: 0o600,
    });
    expect(readWorkspaceLedger(root)).toEqual({
      kind: "invalid",
      reason: "malformed",
    });
    rmSync(file);
    symlinkSync(join(root, "missing-ledger"), file);
    expect(readWorkspaceLedger(root)).toEqual({
      kind: "invalid",
      reason: "unsafe_path",
    });
    expect(() => loadWorkspaceLedger(root)).toThrow(WorkspaceLedgerError);
  });

  it("serializes durable claims and refuses foreign release or held takeover", () => {
    const { root, ledger } = fixture();
    ledger.slots.push({
      slotId: "linked:one",
      kind: "linked",
      adminKey: "one",
      root,
      gitDir: root,
      state: "available",
      revision: 0,
      assignmentEpoch: 0,
    });
    saveWorkspaceLedger(root, ledger);
    const owner = {
      processInstanceId: "process-a",
      nonce: "nonce-a",
      parentSessionId: "session-a",
    };
    const other = {
      processInstanceId: "process-b",
      nonce: "nonce-b",
      parentSessionId: "session-b",
    };
    const claimed = acquireWorkspaceClaim(root, 0, {
      claimId: "claim-a",
      scope: "slot",
      slotId: "linked:one",
      owner,
      claimEpoch: 1,
    });
    expect(
      findHeldWorkspaceClaim(claimed.ledger, "slot", "linked:one"),
    ).toEqual(claimed.claim);
    expect(() =>
      acquireWorkspaceClaim(root, 1, {
        claimId: "claim-a",
        scope: "slot",
        slotId: "linked:one",
        owner: other,
        claimEpoch: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "claim_held" }));
    expect(() => releaseWorkspaceClaim(root, 1, "claim-a", other)).toThrowError(
      expect.objectContaining({ code: "claim_held" }),
    );
    const released = releaseWorkspaceClaim(root, 1, "claim-a", owner);
    expect(released.claims[0]?.state).toBe("released");
  });

  it("does not take over an existing ledger lock", () => {
    const { root, ledger } = fixture();
    saveWorkspaceLedger(root, ledger);
    expect(() =>
      withWorkspaceLedgerLock(root, () =>
        withWorkspaceLedgerLock(root, () => undefined),
      ),
    ).toThrowError(expect.objectContaining({ code: "lock_held" }));
  });
});

import { randomUUID } from "node:crypto";
import {
  MAX_WORKSPACE_EXTERNAL_ID_BYTES,
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_PATH_BYTES,
  MAX_WORKSPACE_PROVIDER_BYTES,
  MAX_WORKSPACE_REF_BYTES,
  type PrAssociation,
  type PrObservation,
} from "./workspace-ledger";
import { isFullBranchRef } from "./workspace-git";

export class WorkspacePrError extends Error {
  readonly code = "invalid_pr_record" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspacePrError";
  }
}

function text(value: string, maximum: number, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new WorkspacePrError(`${name} is invalid`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new WorkspacePrError(`${name} is invalid`);
  return value as T;
}

function optionalOid(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const oid = text(value, 64, name);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid) || /^0+$/u.test(oid)) {
    throw new WorkspacePrError(`${name} must be a full object id`);
  }
  return oid.toLowerCase();
}

function optionalRef(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const ref = text(value, MAX_WORKSPACE_REF_BYTES, name);
  if (!isFullBranchRef(ref))
    throw new WorkspacePrError(`${name} must be a full branch ref`);
  return ref;
}

export function createPrAssociation(params: {
  workItemId: string;
  provider: string;
  externalId: string;
  claimedHeadOid?: string;
  claimedBaseRef?: string;
  provenance?: "parent" | "child_proposal";
  recordedAt?: number;
}): PrAssociation {
  const recordedAt = params.recordedAt ?? Date.now();
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) {
    throw new WorkspacePrError("recordedAt is invalid");
  }
  const claimedHeadOid = optionalOid(params.claimedHeadOid, "claimedHeadOid");
  const claimedBaseRef = optionalRef(params.claimedBaseRef, "claimedBaseRef");
  const provenance = enumValue(
    params.provenance ?? "parent",
    ["parent", "child_proposal"],
    "provenance",
  );
  return {
    associationId: randomUUID(),
    workItemId: text(params.workItemId, MAX_WORKSPACE_ID_BYTES, "workItemId"),
    provider: text(params.provider, MAX_WORKSPACE_PROVIDER_BYTES, "provider"),
    externalId: text(
      params.externalId,
      MAX_WORKSPACE_EXTERNAL_ID_BYTES,
      "externalId",
    ),
    ...(claimedHeadOid ? { claimedHeadOid } : {}),
    ...(claimedBaseRef ? { claimedBaseRef } : {}),
    provenance,
    recordedAt,
  };
}

export function createPrObservation(params: {
  associationId: string;
  state: "unknown" | "open" | "closed" | "merged";
  draft?: boolean;
  verification:
    "unsupported" | "unverified" | "verified" | "unavailable" | "mismatch";
  headRepo?: string;
  headRef?: string;
  headOid?: string;
  baseRef?: string;
  freshness: "fresh" | "stale" | "unknown";
  source: "provider" | "manual_parent";
  recordedAt?: number;
}): PrObservation {
  const recordedAt = params.recordedAt ?? Date.now();
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) {
    throw new WorkspacePrError("recordedAt is invalid");
  }
  const state = enumValue(
    params.state,
    ["unknown", "open", "closed", "merged"],
    "state",
  );
  const verification = enumValue(
    params.verification,
    ["unsupported", "unverified", "verified", "unavailable", "mismatch"],
    "verification",
  );
  const freshness = enumValue(
    params.freshness,
    ["fresh", "stale", "unknown"],
    "freshness",
  );
  const source = enumValue(
    params.source,
    ["provider", "manual_parent"],
    "source",
  );
  if (params.draft !== undefined && typeof params.draft !== "boolean")
    throw new WorkspacePrError("draft is invalid");
  const headOid = optionalOid(params.headOid, "headOid");
  const headRef = optionalRef(params.headRef, "headRef");
  const baseRef = optionalRef(params.baseRef, "baseRef");
  const headRepo =
    params.headRepo === undefined
      ? undefined
      : text(params.headRepo, MAX_WORKSPACE_PATH_BYTES, "headRepo");
  return {
    observationId: randomUUID(),
    associationId: text(
      params.associationId,
      MAX_WORKSPACE_ID_BYTES,
      "associationId",
    ),
    state,
    ...(params.draft === undefined ? {} : { draft: params.draft }),
    verification,
    ...(headRepo ? { headRepo } : {}),
    ...(headRef ? { headRef } : {}),
    ...(headOid ? { headOid } : {}),
    ...(baseRef ? { baseRef } : {}),
    freshness,
    source,
    recordedAt,
  };
}

export type { PrAssociation, PrObservation } from "./workspace-ledger";

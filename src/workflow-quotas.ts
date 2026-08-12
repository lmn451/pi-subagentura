export interface WorkflowQuotaLimits {
  readonly maxValueDepth: number;
  readonly maxValueNodes: number;
  readonly maxValueStringBytes: number;
  readonly maxValueBytes: number;
  readonly maxBlobBytes: number;
  readonly maxEventBytes: number;
  readonly maxEventsPerRun: number;
  readonly maxBlobsPerRun: number;
  readonly maxBytesPerRun: number;
  readonly maxRunsPerOwner: number;
  readonly maxBytesPerOwner: number;
  readonly maxStartupRuns: number;
  readonly maxStartupEvents: number;
  readonly maxStartupBytes: number;
}

export type WorkflowQuotaOptions = Partial<WorkflowQuotaLimits>;

export const DEFAULT_WORKFLOW_QUOTA_LIMITS: Readonly<WorkflowQuotaLimits> =
  Object.freeze({
    maxValueDepth: 64,
    maxValueNodes: 100_000,
    maxValueStringBytes: 256 * 1024,
    maxValueBytes: 1024 * 1024,
    maxBlobBytes: 4 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    maxEventsPerRun: 10_000,
    maxBlobsPerRun: 2_000,
    maxBytesPerRun: 64 * 1024 * 1024,
    maxRunsPerOwner: 256,
    maxBytesPerOwner: 512 * 1024 * 1024,
    maxStartupRuns: 256,
    maxStartupEvents: 100_000,
    maxStartupBytes: 512 * 1024 * 1024,
  });

export type WorkflowQuotaDimension = keyof WorkflowQuotaLimits;

const MAX_QUOTA_DIAGNOSTIC_LENGTH = 512;

export class WorkflowQuotaError extends Error {
  readonly code = "quota_exceeded" as const;
  readonly dimension: WorkflowQuotaDimension;
  readonly limit: number;
  readonly actual: number;
  readonly diagnostic: string;

  constructor(
    dimension: WorkflowQuotaDimension,
    limit: number,
    actual: number,
  ) {
    const diagnostic = `Workflow quota ${dimension} exceeded (${actual} > ${limit}).`;
    super(diagnostic);
    this.name = "WorkflowQuotaError";
    this.dimension = dimension;
    this.limit = limit;
    this.actual = actual;
    this.diagnostic = diagnostic.slice(0, MAX_QUOTA_DIAGNOSTIC_LENGTH);
  }
}

export function resolveWorkflowQuotaLimits(
  options: WorkflowQuotaOptions = {},
): WorkflowQuotaLimits {
  const limits: WorkflowQuotaLimits = {
    ...DEFAULT_WORKFLOW_QUOTA_LIMITS,
    ...options,
  };
  for (const [dimension, value] of Object.entries(limits) as Array<
    [WorkflowQuotaDimension, number]
  >) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `Workflow quota ${dimension} must be a positive safe integer.`,
      );
    }
  }
  return Object.freeze(limits);
}

export function assertWorkflowQuota(
  dimension: WorkflowQuotaDimension,
  actual: number,
  limits: WorkflowQuotaLimits,
): void {
  const limit = limits[dimension];
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > limit) {
    throw new WorkflowQuotaError(dimension, limit, actual);
  }
}

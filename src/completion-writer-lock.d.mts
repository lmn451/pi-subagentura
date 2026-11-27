export type CompletionLockProtocol = "legacy" | "atomic" | "unknown";

export const COMPLETION_LOCK_PROTOCOL_FILE: string;

export function completionLockPathForTurn(
  artifactDir: string,
  turnId: string,
): string;

export function readCompletionLockProtocol(
  artifactDir: string,
): CompletionLockProtocol;

export function initializeCompletionLockProtocol(artifactDir: string): void;

export function withCompletionWriterLock<T>(
  lock: string,
  operation: () => T,
  timeoutMs?: number,
  protocol?: CompletionLockProtocol,
): T;

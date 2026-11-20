export function withCompletionWriterLock<T>(
  lock: string,
  operation: () => T,
  timeoutMs?: number,
): T;

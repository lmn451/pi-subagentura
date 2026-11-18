export function requestHerdrCore(
  server: string,
  method: string,
  params: Record<string, unknown>,
  input?: string,
): Promise<Record<string, unknown>>;
export function requestHerdrCoreSync(
  server: string,
  method: string,
  params: Record<string, unknown>,
  input?: string,
): Record<string, unknown>;

export interface TerminalHarnessOptions {
  scenario?: string;
  keep?: boolean;
}
export interface PaneInfo {
  id: string;
  pid: number;
  session: string;
  window: string;
  pane: string;
  active: boolean;
  command: string;
}
export interface TmuxVersion {
  text: string;
  major: number;
  minor: number;
}
export interface TelemetryEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}
export class TerminalHarness {
  constructor(options?: TerminalHarnessOptions);
  scenario: string;
  readonly root: string;
  readonly session: string;
  readonly socket: string;
  readonly workspace: string;
  readonly gates: string;
  readonly providerLog: string;
  readonly networkLog: string;
  readonly parentPane: string | undefined;
  readonly version: TmuxVersion;
  readonly env: Record<string, string>;
  readonly keep: boolean;
  readonly started: boolean;
  captureTelemetry: boolean;
  telemetryOptOut: boolean;
  setupFiles(): void;
  assertChildCanExecNode(safePath: string): void;
  tmux(
    args: string[],
    options?: { timeout?: number; stdio?: ["ignore", "pipe", "pipe"] },
  ): string;
  start(): Promise<this>;
  sendText(text: string): void;
  sendKey(key: string): void;
  pressEnter(): void;
  sendPrompt(text: string): Promise<void>;
  currentScreen(pane?: string): string;
  rawScreen(pane?: string): string;
  renderedScreen(pane?: string): string;
  paneScreen(paneId: string | undefined): string;
  scrollback(pane?: string): string;
  panes(): PaneInfo[];
  providerEvents(): Array<Record<string, unknown>>;
  networkEvents(): Array<Record<string, unknown>>;
  artifactEvents(): Array<Record<string, unknown>>;
  telemetryEvents(): TelemetryEvent[];
  release(name: string): void;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  waitForScreen(
    predicate: (screen: string) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  waitForProvider(
    predicate: (events: Array<Record<string, unknown>>) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  assertNoNetwork(): Promise<void>;
  diagnostics(): void;
  cleanup(failed?: boolean): Promise<void>;
  cleanupSync(): void;
}
export function createHarness(
  options?: TerminalHarnessOptions,
): TerminalHarness;
export function tmuxVersion(): TmuxVersion;
export const REPO: string;

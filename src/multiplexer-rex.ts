import { execFile, execFileSync } from "node:child_process";
import type {
  CapturePaneOptions,
  CapturePaneResult,
  Multiplexer,
  PaneActivity,
  PaneLiveness,
  PaneRef,
} from "./multiplexer-contracts";
import {
  boundCaptureOutput,
  commandExists,
  isRexBlockId,
  isRexServerAddress,
  isRexSessionId,
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  safeSegment,
  shellEscape,
} from "./multiplexer-contracts";

const REX_TIMEOUT_MS = 5_000;
const REX_CREATE_TIMEOUT_MS = 10_000;
const REX_CONTROL_OUTPUT_BYTES = 256 * 1024;
const REX_CONTEXT_KEYS = ["REX_SESSION", "REX_BLOCK"] as const;
const REX_HELP_REQUIREMENTS = [
  [
    "run",
    [
      "--json",
      "--cwd",
      "--label",
      "--keep-open",
      "--focus",
      "--split",
      "--block",
      "--session",
    ],
  ],
  ["send", ["--block", "--session"]],
  ["send-key", ["enter", "--block", "--session"]],
  ["capture", ["--block", "--session", "--trim"]],
  ["focus", ["--session"]],
  ["block close", ["--session"]],
  ["block ls", ["--json", "--session"]],
  ["whoami", ["--json"]],
] as const;

interface RexTarget {
  readonly sessionId: string;
  readonly server: string;
}

interface RexContext extends RexTarget {
  readonly blockId: string;
}

export type RexContextProbe =
  | { readonly kind: "absent" }
  | { readonly kind: "ready"; readonly context: RexContext }
  | { readonly kind: "invalid"; readonly message: string };

let rexCliContractSupported: boolean | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rexExecSync(
  args: readonly string[],
  input?: string,
  timeout = REX_TIMEOUT_MS,
): string {
  const output = execFileSync("rex", [...args], {
    encoding: "utf8",
    input,
    maxBuffer: REX_CONTROL_OUTPUT_BYTES,
    timeout,
  });
  return output;
}

function rexHelpSupports(
  args: readonly string[],
  required: readonly string[],
): boolean {
  try {
    const help = execFileSync("rex", ["help", ...args], {
      encoding: "utf8",
      maxBuffer: REX_CONTROL_OUTPUT_BYTES,
      timeout: REX_TIMEOUT_MS,
    });
    return required.every((feature) => help.includes(feature));
  } catch {
    return false;
  }
}

function hasRequiredRexCliContract(): boolean {
  if (rexCliContractSupported !== undefined) return rexCliContractSupported;
  rexCliContractSupported = REX_HELP_REQUIREMENTS.every(([command, features]) =>
    rexHelpSupports(command.split(" "), features),
  );
  return rexCliContractSupported;
}

function parseWhoami(
  output: string,
  expected: { sessionId: string; blockId: string },
): string {
  const parsed: unknown = JSON.parse(output);
  if (
    !isRecord(parsed) ||
    parsed.session_id !== expected.sessionId ||
    parsed.block_id !== expected.blockId ||
    !isRexServerAddress(parsed.endpoint)
  ) {
    throw new Error("Rex identity did not match the supplied live context");
  }
  return parsed.endpoint;
}

function parseBlockIds(output: string): Set<string> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) {
    throw new Error("Malformed Rex block listing");
  }
  const ids = new Set<string>();
  for (const item of parsed.blocks) {
    if (!isRecord(item) || !isRexBlockId(item.block_id)) {
      throw new Error("Malformed Rex block listing row");
    }
    ids.add(item.block_id);
  }
  return ids;
}

export function hasRexContextSignal(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    REX_CONTEXT_KEYS.some((key) => env[key] !== undefined) ||
    env.TERM_PROGRAM?.trim().toLowerCase() === "rex"
  );
}

interface RexContextCandidate {
  readonly sessionId: string;
  readonly blockId: string;
  readonly serverSelector: string;
}

type RexContextEnvironment =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "candidate"; readonly context: RexContextCandidate };

function readRexContextEnvironment(
  env: NodeJS.ProcessEnv,
): RexContextEnvironment {
  const hasContext = REX_CONTEXT_KEYS.some((key) => env[key] !== undefined);
  if (!hasContext) {
    return env.TERM_PROGRAM?.trim().toLowerCase() === "rex"
      ? {
          kind: "invalid",
          message:
            "Rex terminal marker found without a complete live Rex context; refusing to fall back to another multiplexer.",
        }
      : { kind: "absent" };
  }

  const sessionId = env.REX_SESSION;
  const blockId = env.REX_BLOCK;
  const serverSelector = env.REX_SERVER;
  if (
    !isRexSessionId(sessionId) ||
    !isRexBlockId(blockId) ||
    !isRexServerAddress(serverSelector)
  ) {
    return {
      kind: "invalid",
      message:
        "Rex context is incomplete or malformed; refusing to fall back to another multiplexer.",
    };
  }
  return {
    kind: "candidate",
    context: { sessionId, blockId, serverSelector },
  };
}

function verifyLiveRexContext(candidate: RexContextCandidate): RexContextProbe {
  if (!commandExists("rex")) {
    return {
      kind: "invalid",
      message:
        "Rex context is present but the Rex CLI is unavailable; refusing to fall back to another multiplexer.",
    };
  }
  if (!hasRequiredRexCliContract()) {
    return {
      kind: "invalid",
      message:
        "The installed Rex CLI does not expose the required public commands; refusing to fall back to another multiplexer.",
    };
  }
  try {
    const { sessionId, blockId, serverSelector } = candidate;
    const whoami = rexExecSync([
      "--server",
      serverSelector,
      "whoami",
      "--json",
    ]);
    const server = parseWhoami(whoami, { sessionId, blockId });
    const listing = rexExecSync([
      "--server",
      server,
      "block",
      "ls",
      "--json",
      "--session",
      sessionId,
    ]);
    if (!parseBlockIds(listing).has(blockId)) {
      throw new Error("Rex context block is not live in the reported session");
    }
    return { kind: "ready", context: { sessionId, blockId, server } };
  } catch {
    return {
      kind: "invalid",
      message:
        "Rex context could not be verified against the live server; refusing to fall back to another multiplexer.",
    };
  }
}

export function probeRexContext(
  env: NodeJS.ProcessEnv = process.env,
): RexContextProbe {
  const candidate = readRexContextEnvironment(env);
  return candidate.kind === "candidate"
    ? verifyLiveRexContext(candidate.context)
    : candidate;
}

function requireContext(
  session: string | undefined,
  server: string | undefined,
): RexTarget {
  if (!isRexSessionId(session) || !isRexServerAddress(server)) {
    throw new Error(
      "Rex pane state is missing its validated server/session identity",
    );
  }
  return { sessionId: session, server };
}

function contextForPane(ref: PaneRef): RexContext {
  const context = requireContext(ref.session, ref.server);
  if (!isRexBlockId(ref.paneId)) throw new Error("Invalid Rex block id");
  return { ...context, blockId: ref.paneId };
}

function contextArgs(context: RexTarget, command: readonly string[]): string[] {
  return ["--server", context.server, ...command];
}

function parseCreatedBlockId(output: string): string {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error("Malformed Rex create response");
  const block = isRecord(parsed.block) ? parsed.block : undefined;
  const firstId = Array.isArray(parsed.block_ids)
    ? parsed.block_ids[0]
    : undefined;
  const blockId = parsed.block_id ?? block?.block_id ?? firstId;
  if (!isRexBlockId(blockId))
    throw new Error("Rex create response omitted a valid block id");
  return blockId;
}

function livenessFromOutput(output: string, paneId: string): PaneLiveness {
  return parseBlockIds(output).has(paneId) ? "alive" : "dead";
}

function safePaneId(paneId: string): string {
  if (!isRexBlockId(paneId)) throw new Error("Invalid Rex block id");
  return paneId;
}

export class RexMultiplexer implements Multiplexer {
  readonly name = "rex" as const;
  readonly capabilities = MUX_CAPABILITIES.rex;

  probeContext(env: NodeJS.ProcessEnv = process.env): RexContextProbe {
    return probeRexContext(env);
  }

  isAvailable(): boolean {
    return this.probeContext().kind === "ready";
  }

  private requireCurrentContext(): RexContext {
    const probe = this.probeContext();
    if (probe.kind === "ready") return probe.context;
    if (probe.kind === "invalid") throw new Error(probe.message);
    throw new Error("No verified Rex context is available for this launch");
  }

  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
  }): { paneId: string; windowName?: string; session: string; server: string } {
    const context = this.requireCurrentContext();
    const label = opts.windowName ?? safeSegment(opts.name);
    const args = [
      "run",
      "--json",
      "--session",
      context.sessionId,
      "--cwd",
      opts.cwd,
      "--label",
      label,
      "--keep-open",
      "--focus=false",
    ];
    // Keep Rex's login-shell environment so PATH reaches the child; this Bash
    // avoids its own startup files while remaining interactive for follow-ups.
    if (!opts.background) {
      const parentPane = safePaneId(opts.parentPane ?? context.blockId);
      args.push("--split=right", "--block", parentPane);
    }
    args.push("--", "/bin/bash", "--noprofile", "--norc", "-i");

    const output = rexExecSync(
      contextArgs(context, args),
      undefined,
      REX_CREATE_TIMEOUT_MS,
    );
    const paneId = parseCreatedBlockId(output);
    return {
      paneId,
      ...(opts.background ? { windowName: label } : {}),
      session: context.sessionId,
      server: context.server,
    };
  }

  getPaneLiveness(
    paneId: string,
    session?: string,
    server?: string,
  ): PaneLiveness {
    try {
      const context = requireContext(session, server);
      const output = rexExecSync(
        contextArgs(context, [
          "block",
          "ls",
          "--json",
          "--session",
          context.sessionId,
        ]),
      );
      return livenessFromOutput(output, safePaneId(paneId));
    } catch {
      // Command or parse failure is uncertainty, not proof that the pane died.
      return "unknown";
    }
  }

  getPaneLivenessAsync(
    paneId: string,
    session?: string,
    server?: string,
  ): Promise<PaneLiveness> {
    let context: RexTarget;
    try {
      context = requireContext(session, server);
      safePaneId(paneId);
    } catch {
      // Invalid persisted identity must not be treated as a confirmed dead pane.
      return Promise.resolve("unknown");
    }
    return new Promise((resolve) => {
      try {
        execFile(
          "rex",
          contextArgs(context, [
            "block",
            "ls",
            "--json",
            "--session",
            context.sessionId,
          ]),
          {
            encoding: "utf8",
            maxBuffer: REX_CONTROL_OUTPUT_BYTES,
            timeout: REX_TIMEOUT_MS,
          },
          (error, stdout) => {
            if (error) {
              resolve("unknown");
              return;
            }
            try {
              resolve(livenessFromOutput(stdout, paneId));
            } catch {
              resolve("unknown");
            }
          },
        );
      } catch {
        resolve("unknown");
      }
    });
  }

  getPaneActivityAsync(
    _paneId: string,
    _session?: string,
    _server?: string,
  ): Promise<PaneActivity> {
    // Rex documents focus controls but no user-visible attached/focused-client probe.
    return Promise.resolve("unknown");
  }

  sendKeys(
    paneId: string,
    text: string,
    session?: string,
    server?: string,
  ): void {
    const context = requireContext(session, server);
    rexExecSync(
      contextArgs(context, [
        "send",
        "--block",
        safePaneId(paneId),
        "--session",
        context.sessionId,
      ]),
      text,
    );
  }

  sendEnter(paneId: string, session?: string, server?: string): void {
    const context = requireContext(session, server);
    rexExecSync(
      contextArgs(context, [
        "send-key",
        "--block",
        safePaneId(paneId),
        "--session",
        context.sessionId,
        "enter",
      ]),
    );
  }

  killPane(paneId: string, session?: string, server?: string): void {
    try {
      const context = requireContext(session, server);
      rexExecSync(
        contextArgs(context, [
          "block",
          "close",
          safePaneId(paneId),
          "--session",
          context.sessionId,
        ]),
      );
    } catch {
      // Best effort: cancellation and cleanup must tolerate an already-closed block.
    }
  }

  focusPane(ref: PaneRef): Promise<void> {
    const context = contextForPane(ref);
    return new Promise((resolve, reject) => {
      try {
        execFile(
          "rex",
          contextArgs(context, [
            "focus",
            context.blockId,
            "--session",
            context.sessionId,
          ]),
          { timeout: REX_TIMEOUT_MS },
          (error) => {
            if (error)
              reject(new Error("[rex] focus failed", { cause: error }));
            else resolve();
          },
        );
      } catch (error) {
        reject(new Error("[rex] focus failed", { cause: error }));
      }
    });
  }

  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const context = contextForPane(ref);
    return new Promise((resolve, reject) => {
      try {
        execFile(
          "rex",
          contextArgs(context, [
            "capture",
            "--block",
            context.blockId,
            "--session",
            context.sessionId,
            "--trim",
          ]),
          {
            encoding: "utf8",
            maxBuffer: MAX_CAPTURE_READ_BYTES,
            timeout: REX_TIMEOUT_MS,
          },
          (error, stdout) => {
            if (error) {
              reject(
                new Error(
                  "[rex] capture failed or exceeded the safe read bound",
                  { cause: error },
                ),
              );
              return;
            }
            resolve(boundCaptureOutput(stdout, opts));
          },
        );
      } catch (error) {
        reject(new Error("[rex] capture failed", { cause: error }));
      }
    });
  }

  async showNativeViewer(_title: string, _content: string): Promise<boolean> {
    return false;
  }

  buildAttachCommands(opts: {
    paneId: string;
    session?: string;
    server?: string;
  }): { attachCommand: string; focusCommand: string } {
    const context = contextForPane({
      paneId: opts.paneId,
      session: opts.session,
      server: opts.server,
    });
    const command = [
      "rex --server",
      shellEscape(context.server),
      "focus",
      shellEscape(context.blockId),
      "--session",
      shellEscape(context.sessionId),
    ].join(" ");
    return { attachCommand: command, focusCommand: command };
  }
}

import { isAbsolute } from "node:path";
import {
  commandExists,
  isHerdrCoreId,
  isHerdrCoreTerminalId,
  isMuxSocketPath,
  MultiplexerContextUnavailableError,
  MUX_CAPABILITIES,
  shellEscape,
  validateMuxLaunchContext,
  type Multiplexer,
  type PaneLivenessDiagnostic,
} from "./multiplexer-contracts";
import {
  coreTerminal,
  queryCore,
  queryCoreAsync,
} from "./multiplexer-herdr-core-client";
import {
  CORE_IDENTITY_URL,
  coreSocketIdentity,
  queryCoreId,
  queryCoreIdAsync,
} from "./multiplexer-herdr-core-identity";

type CoreTarget = { id: string; coreId: string; socket: string };

function target(
  id: string,
  coreId?: string,
  socket?: string,
): CoreTarget | undefined {
  return isHerdrCoreTerminalId(id) &&
    isHerdrCoreId(coreId) &&
    isMuxSocketPath(socket)
    ? { id, coreId, socket }
    : undefined;
}

const UNAVAILABLE: PaneLivenessDiagnostic = {
  liveness: "unknown",
  failureReason: "command_error",
};

function liveness(
  ref: CoreTarget,
  reply: ReturnType<typeof queryCore>,
): PaneLivenessDiagnostic {
  switch (reply.kind) {
    case "not_found":
      return { liveness: "dead" };
    case "ok": {
      const terminal = coreTerminal(reply, ref.id);
      if (terminal?.state === "live") return { liveness: "alive" };
      if (terminal?.state === "finished")
        return {
          liveness: "dead",
          ...(terminal.exitCode === undefined
            ? {}
            : { exitCode: terminal.exitCode }),
        };
      return { liveness: "unknown", failureReason: "malformed_response" };
    }
    default:
      return { liveness: "unknown", failureReason: reply.kind };
  }
}

// An address can be reused after a Core state wipe. Check the same Core ID
// for user-invoked attachment, not just for tool operations.
const ATTACH_JS = [
  "const [identityUrl, socket, core, id] = process.argv.slice(1);",
  'import { spawnSync } from "node:child_process";',
  'const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HC_")));',
  "env.HC_SOCKET = socket;",
  "try {",
  "  const { coreSocketIdentity, queryCoreIdAsync } = await import(identityUrl);",
  "  const before = coreSocketIdentity(socket);",
  "  if (!before || await queryCoreIdAsync(socket) !== core || before !== coreSocketIdentity(socket)) throw 0;",
  '} catch { console.error("Herdr Core identity no longer matches; use the original local Core."); process.exit(1); }',
  'process.exit(spawnSync("hc", ["attach", id], { env, stdio: "inherit" }).status ?? 1);',
].join(" ");

export class HerdrCoreMultiplexer implements Multiplexer {
  readonly name = "herdr-core" as const;
  readonly capabilities = MUX_CAPABILITIES[this.name];

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  isAvailable(): boolean {
    const socket = this.env.HC_TERMINAL_SOCKET;
    return (
      isMuxSocketPath(socket) && !!queryCoreId(socket) && commandExists("hc")
    );
  }

  private query(ref: CoreTarget, args: readonly string[]) {
    const identity = coreSocketIdentity(ref.socket);
    if (
      !identity ||
      queryCoreId(ref.socket) !== ref.coreId ||
      coreSocketIdentity(ref.socket) !== identity
    )
      return undefined;
    return queryCore(ref.socket, args, this.env);
  }

  createPane(
    opts: Parameters<Multiplexer["createPane"]>[0],
  ): ReturnType<Multiplexer["createPane"]> {
    validateMuxLaunchContext(this.name, opts.context);
    const context = opts.context;
    const program = opts.program;
    if (
      context?.mux !== this.name ||
      !program ||
      !isAbsolute(program.script) ||
      !isAbsolute(opts.cwd) ||
      !opts.background
    ) {
      throw new Error(
        "Herdr Core requires a verified local terminal and a background launch program. Visible splits are not supported.",
      );
    }
    const parent = {
      id: context.paneId,
      coreId: context.session,
      socket: context.server,
    };
    const before = coreSocketIdentity(parent.socket);
    const replyBeforeLaunch =
      before && this.query(parent, ["get", parent.id, "--json"]);
    const terminal = replyBeforeLaunch
      ? coreTerminal(replyBeforeLaunch, parent.id)
      : undefined;
    if (
      terminal?.state !== "live" ||
      terminal.pid !== context.terminalPid ||
      coreSocketIdentity(parent.socket) !== before
    ) {
      throw new MultiplexerContextUnavailableError(
        "Herdr Core parent terminal is no longer available. Retry from a live local Core terminal.",
      );
    }
    const path = this.env.PATH;
    const reply = queryCore(
      parent.socket,
      [
        "run",
        "--bg",
        "--json",
        "--cwd",
        opts.cwd,
        "--parent",
        parent.id,
        "--no-notify",
        ...(program.outliveParent ? ["--outlive-parent"] : []),
        "--",
        ...(path === undefined ? [] : ["/usr/bin/env", `PATH=${path}`]),
        "/bin/bash",
        program.script,
      ],
      this.env,
    );
    const id = reply.kind === "ok" && reply.value.address;
    if (
      !isHerdrCoreTerminalId(id) ||
      id === parent.id ||
      !coreTerminal(reply, id)
    ) {
      throw new Error(
        "Herdr Core did not confirm terminal allocation. Check local Core status and list its terminals before retrying.",
      );
    }
    return { paneId: id, session: parent.coreId, server: parent.socket };
  }

  getPaneLiveness(id: string, session?: string, server?: string) {
    return this.getPaneLivenessDiagnostic(id, session, server).liveness;
  }

  getPaneLivenessDiagnostic(
    id: string,
    session?: string,
    server?: string,
  ): PaneLivenessDiagnostic {
    const ref = target(id, session, server);
    const reply = ref && this.query(ref, ["get", id, "--json"]);
    return ref && reply ? liveness(ref, reply) : UNAVAILABLE;
  }

  async getPaneLivenessDiagnosticAsync(
    id: string,
    session?: string,
    server?: string,
  ): Promise<PaneLivenessDiagnostic> {
    const ref = target(id, session, server);
    if (!ref) return UNAVAILABLE;
    const identity = coreSocketIdentity(ref.socket);
    if (!identity) return UNAVAILABLE;
    if (
      (await queryCoreIdAsync(ref.socket)) !== ref.coreId ||
      coreSocketIdentity(ref.socket) !== identity
    )
      return UNAVAILABLE;
    const reply = await queryCoreAsync(
      ref.socket,
      ["get", id, "--json"],
      this.env,
    );
    return coreSocketIdentity(ref.socket) === identity
      ? liveness(ref, reply)
      : UNAVAILABLE;
  }

  async getPaneLivenessAsync(id: string, session?: string, server?: string) {
    return (await this.getPaneLivenessDiagnosticAsync(id, session, server))
      .liveness;
  }

  sendMessage(
    id: string,
    text: string,
    session?: string,
    server?: string,
  ): void {
    const ref = target(id, session, server);
    const reply = ref && this.query(ref, ["send", "--json", "--", id, text]);
    if (!reply)
      throw new Error(
        "Herdr Core identity is unavailable or has changed; message not sent.",
      );
    if (reply.kind !== "ok")
      throw new Error(
        "Herdr Core did not confirm message delivery. Check terminal status before retrying.",
      );
  }

  sendKeys(): never {
    throw new Error("Herdr Core requires paste and submit as one operation.");
  }
  sendEnter(): never {
    throw new Error("Herdr Core requires paste and submit as one operation.");
  }

  killPane(id: string, session?: string, server?: string): void {
    const ref = target(id, session, server);
    if (ref) this.query(ref, ["kill", "--json", id]);
  }

  async getPaneActivityAsync() {
    return "unknown" as const;
  }
  async focusPane(): Promise<never> {
    throw new Error(
      "Herdr Core does not support client focus. Use the attach command.",
    );
  }
  async capturePane(): Promise<never> {
    throw new Error(
      "Herdr Core terminal capture is not available through this extension.",
    );
  }
  async showNativeViewer(): Promise<boolean> {
    return false;
  }

  buildAttachCommands(opts: Parameters<Multiplexer["buildAttachCommands"]>[0]) {
    const ref = target(opts.paneId, opts.session, opts.server);
    if (!ref) return { attachCommand: "", focusCommand: "" };
    return {
      attachCommand: `node --input-type=module -e ${shellEscape(ATTACH_JS)} -- ${[CORE_IDENTITY_URL, ref.socket, ref.coreId, ref.id].map(shellEscape).join(" ")}`,
      focusCommand: "",
    };
  }
}

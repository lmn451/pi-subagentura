/**
 * Multiplexer registry for interactive sub-agents.
 *
 * The concrete backends depend on the contracts and helpers in
 * `multiplexer-contracts.ts`; this module is the only module that selects and
 * caches backend instances. Keeping selection here preserves the public
 * registry API without making backend imports depend on it at runtime.
 *
 * Resolution order (`getMux`):
 *   1. Explicit `preference` arg from the tool (forces one backend).
 *   2. Live process/pane ownership, independent of inherited marker order.
 *      A recognized but unverified context fails closed rather than falling
 *      through to an unrelated installed backend.
 *   3. When no host context is present, fall back to installed tmux then
 *      Zellij for backward compatibility.
 *   4. Throw with a setup hint pointing at the supported backends.
 */
import { TmuxMultiplexer } from "./multiplexer-tmux";
import { ZellijMultiplexer } from "./multiplexer-zellij";
import { HerdrMultiplexer } from "./multiplexer-herdr";
import { RexMultiplexer } from "./multiplexer-rex";
import { resolveCurrentMuxContext } from "./multiplexer-current-context";
import {
  validateMuxLaunchContext,
  type MuxName,
  type Multiplexer,
  type MuxLaunchContext,
} from "./multiplexer-contracts";

export * from "./multiplexer-contracts";

export interface ResolvedMux {
  readonly adapter: Multiplexer;
  readonly context: MuxLaunchContext;
}

/** Capture launch authority once, independently of persisted-job dispatch. */
export function resolveMux(opts: GetMuxOptions = {}): ResolvedMux {
  const env = { ...process.env };
  const preference = opts.preference ?? "auto";
  let adapter: Multiplexer;
  let context: MuxLaunchContext;
  if (preference === "auto") {
    const current = resolveCurrentMuxContext(env);
    if (current.kind === "unavailable")
      throw new MultiplexerContextUnavailableError(current.message);
    if (current.kind === "ready") {
      adapter = getMux({ preference: current.target.mux });
      context = { ...current.target, kind: "attached" };
    } else {
      const tmux = getMux({ preference: "tmux" });
      const zellij = getMux({ preference: "zellij" });
      adapter = tmux.isAvailable()
        ? tmux
        : zellij.isAvailable()
          ? zellij
          : (() => {
              throw new NoMultiplexerAvailableError();
            })();
      context = detachedContext(adapter.name, env);
    }
  } else {
    adapter = getMux({ preference });
    if (adapter.name === "rex") {
      const probe = (adapter as RexMultiplexer).probeContext(env);
      if (probe.kind !== "ready")
        throw new MultiplexerContextUnavailableError(
          "No verified Rex context is available for this launch",
        );
      context = {
        kind: "attached",
        mux: "rex",
        paneId: probe.context.blockId,
        session: probe.context.sessionId,
        server: probe.context.server,
      };
    } else if (adapter.name === "herdr") {
      context = {
        kind: "attached",
        mux: "herdr",
        paneId: env.HERDR_PANE_ID!,
        session: env.HERDR_SOCKET_PATH!,
      };
    } else if (adapter.name === "zellij" && env.ZELLIJ) {
      context = {
        kind: "attached",
        mux: "zellij",
        paneId: env.ZELLIJ_PANE_ID ?? "0",
        session: env.ZELLIJ_SESSION_NAME!,
      };
    } else if (adapter.name === "tmux" && env.TMUX) {
      context = {
        kind: "attached",
        mux: "tmux",
        paneId: env.TMUX_PANE!,
        server: /^(.*),\d+,\d+$/.exec(env.TMUX)?.[1]!,
        ...(env.PI_SUBAGENTURA_TMUX_SOCKET
          ? { socketName: env.PI_SUBAGENTURA_TMUX_SOCKET }
          : {}),
      };
    } else {
      context = detachedContext(adapter.name, env);
    }
  }
  validateMuxLaunchContext(adapter.name, context);
  if (adapter instanceof TmuxMultiplexer) adapter = adapter.forContext(context);
  return Object.freeze({ adapter, context: Object.freeze(context) });
}

function detachedContext(
  mux: MuxName,
  env: NodeJS.ProcessEnv,
): MuxLaunchContext {
  if (mux !== "tmux" && mux !== "zellij")
    throw new Error("Backend requires attached launch context");
  return {
    kind: "detached",
    mux,
    ...(mux === "tmux" && env.PI_SUBAGENTURA_TMUX_SOCKET
      ? { socketName: env.PI_SUBAGENTURA_TMUX_SOCKET }
      : {}),
  };
}

/** Exhaustiveness checker for the supported resolver preferences. */
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resolver
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GetMuxOptions {
  /**
   * Explicit backend choice. `'auto'` (the default) verifies current pane
   * ownership, then falls back only when no host context is present.
   */
  preference?: MuxName | "auto";
}

export class NoMultiplexerAvailableError extends Error {
  constructor() {
    super(
      "No multiplexer available. Start pi inside tmux, zellij, Herdr, or Rex, " +
        "for example: tmux new -A -s pi 'pi'  —  or install one and ensure its server is running.",
    );
    this.name = "NoMultiplexerAvailableError";
  }
}

export class MultiplexerContextUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiplexerContextUnavailableError";
  }
}

/**
 * Resolve a multiplexer instance.
 *
 * Returns a cached backend instance. Auto resolution performs bounded host
 * checks before selection; an explicit preference skips host detection. Backend
 * instances keep no per-pane state, which remains persisted on child records.
 */
function resolveAutoMux(): Multiplexer {
  const context = resolveCurrentMuxContext();
  if (context.kind === "unavailable") {
    throw new MultiplexerContextUnavailableError(context.message);
  }
  if (context.kind === "ready") {
    return getMux({ preference: context.target.mux });
  }
  const tmux = getOrCreate("tmux", () => new TmuxMultiplexer());
  const zellij = getOrCreate("zellij", () => new ZellijMultiplexer());

  if (tmux.isAvailable()) return tmux;
  if (zellij.isAvailable()) return zellij;
  throw new NoMultiplexerAvailableError();
}

export function getMux(opts: GetMuxOptions = {}): Multiplexer {
  const preference = opts.preference ?? "auto";
  if (preference === "auto") return resolveAutoMux();

  switch (preference) {
    case "tmux":
      return getOrCreate("tmux", () => new TmuxMultiplexer());
    case "zellij":
      return getOrCreate("zellij", () => new ZellijMultiplexer());
    case "herdr":
      return getOrCreate("herdr", () => new HerdrMultiplexer());
    case "rex":
      return getOrCreate("rex", () => new RexMultiplexer());
    default:
      return assertNever(preference);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Internal: instance cache + test seams
 * ──────────────────────────────────────────────────────────────────────────── */

const instances = new Map<MuxName, Multiplexer>();

function getOrCreate(name: MuxName, factory: () => Multiplexer): Multiplexer {
  let inst = instances.get(name);
  if (!inst) {
    inst = factory();
    instances.set(name, inst);
  }
  return inst;
}

/** Test seam: replace the cached tmux backend. Pass `undefined` to restore. */
export function __setTmuxMultiplexer(impl: Multiplexer | undefined): void {
  if (impl) instances.set("tmux", impl);
  else instances.delete("tmux");
}

/** Test seam: replace the cached zellij backend. Pass `undefined` to restore. */
export function __setZellijMultiplexer(impl: Multiplexer | undefined): void {
  if (impl) instances.set("zellij", impl);
  else instances.delete("zellij");
}

/** Test seam: replace the cached Rex backend. Pass `undefined` to restore. */
export function __setRexMultiplexer(impl: Multiplexer | undefined): void {
  if (impl) instances.set("rex", impl);
  else instances.delete("rex");
}

/** Test seam: clear all cached backend instances (forces re-instantiation). */
export function __resetMuxInstances(): void {
  instances.clear();
}

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
 *   2. Auto-detect: prefer the mux already attached to the parent process
 *      (env var heuristic: HERDR_ENV, ZELLIJ_SESSION_NAME, then TMUX).
 *   3. Fall back to whichever backend has a binary + active server, tmux first
 *      for backward compatibility.
 *   4. Throw with a setup hint pointing at the supported backends.
 */

import { TmuxMultiplexer } from "./multiplexer-tmux";
import { ZellijMultiplexer } from "./multiplexer-zellij";
import { HerdrMultiplexer } from "./multiplexer-herdr";
import type { MuxName, Multiplexer } from "./multiplexer-contracts";

export * from "./multiplexer-contracts";

/** Exhaustiveness checker for the supported resolver preferences. */
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resolver
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GetMuxOptions {
  /**
   * Explicit backend choice. `'auto'` (the default) walks the env-var +
   * availability chain described in the file header.
   */
  preference?: MuxName | "auto";
}

export class NoMultiplexerAvailableError extends Error {
  constructor() {
    super(
      "No multiplexer available. Start pi inside tmux, zellij, or Herdr, " +
        "for example: tmux new -A -s pi 'pi'  —  or install one and ensure its server is running.",
    );
    this.name = "NoMultiplexerAvailableError";
  }
}

/**
 * Resolve a multiplexer instance.
 *
 * Returns a long-lived `Multiplexer` — implementations are stateless after
 * construction (the resolver holds one per backend so the env-var probe is
 * paid once per process). Callers may cache the result, but `getMux` itself
 * is cheap on the hot path because it just looks up the cached instance.
 */
export function getMux(opts: GetMuxOptions = {}): Multiplexer {
  const tmux = getOrCreate("tmux", () => new TmuxMultiplexer());
  const zellij = getOrCreate("zellij", () => new ZellijMultiplexer());
  const herdr = getOrCreate("herdr", () => new HerdrMultiplexer());

  const preference = opts.preference ?? "auto";
  switch (preference) {
    case "tmux":
      return tmux;
    case "zellij":
      return zellij;
    case "herdr":
      return herdr;
    case "auto": {
      // Prefer the mux already attached to this process. We check env vars
      // (cheap) before probing availability (one exec call each). If both env
      // vars are set (nested sessions are possible), Herdr wins because its
      // managed-pane marker is the most specific signal. Zellij remains ahead
      // of tmux because TMUX is commonly inherited through nested sessions.
      if (process.env.HERDR_ENV === "1" && herdr.isAvailable()) return herdr;
      if (process.env.ZELLIJ_SESSION_NAME && zellij.isAvailable())
        return zellij;
      if (process.env.TMUX && tmux.isAvailable()) return tmux;

      // Neither env var matched. Fall back to whichever backend is available;
      // tmux first to preserve existing user setups.
      if (tmux.isAvailable()) return tmux;
      if (zellij.isAvailable()) return zellij;

      throw new NoMultiplexerAvailableError();
    }
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

/** Test seam: clear all cached backend instances (forces re-instantiation). */
export function __resetMuxInstances(): void {
  instances.clear();
}

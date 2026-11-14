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
 *   2. Auto-detect: use a supplied or fresh snapshot's valid parent mux hints,
 *      preferring Herdr > Zellij > tmux when nested markers are present.
 *   3. Fall back to freshly available tmux or Zellij backends, tmux first.
 *      for backward compatibility.
 *   4. Throw with a setup hint pointing at the supported backends.
 */

import { TmuxMultiplexer } from "./multiplexer-tmux";
import { ZellijMultiplexer } from "./multiplexer-zellij";
import { HerdrMultiplexer } from "./multiplexer-herdr";
import { detectEnvironment, type EnvironmentSnapshot } from "./environment";
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
   * Explicit backend choice. `'auto'` (the default) uses captured host hints,
   * then fresh availability probes.
   */
  preference?: MuxName | "auto";
  /** Reuse an activation/session observation when resolving the auto preference. */
  environment?: EnvironmentSnapshot;
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
 * Returns a long-lived `Multiplexer` instance. Auto resolution uses supplied
 * hints or freshly detects them, and always probes backend availability live.
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
      const environment = opts.environment ?? detectEnvironment();
      // Prefer the mux already attached to this process. Snapshot hints encode
      // validated parent markers; nested sessions keep Herdr > Zellij > tmux.
      if (environment.hasHerdrHint && herdr.isAvailable()) return herdr;
      if (environment.hasZellijHint && zellij.isAvailable()) return zellij;
      if (environment.hasTmuxHint && tmux.isAvailable()) return tmux;

      // No hinted backend is available; keep availability fresh and preserve
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

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
 *   2. A verified current host context (Herdr, Rex, Zellij, then tmux).
 *      A recognized but unverified context fails closed rather than falling
 *      through to an unrelated installed backend.
 *   3. When no host context is present, fall back to installed tmux then
 *      Zellij for backward compatibility.
 *   4. Throw with a setup hint pointing at the supported backends.
 */
import { TmuxMultiplexer } from "./multiplexer-tmux";
import { ZellijMultiplexer } from "./multiplexer-zellij";
import { HerdrMultiplexer } from "./multiplexer-herdr";
import { probeRexContext, RexMultiplexer } from "./multiplexer-rex";
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
  const tmux = getOrCreate("tmux", () => new TmuxMultiplexer());
  const zellij = getOrCreate("zellij", () => new ZellijMultiplexer());
  const herdr = getOrCreate("herdr", () => new HerdrMultiplexer());
  const rex = getOrCreate("rex", () => new RexMultiplexer());

  // Herdr's exact managed-pane marker remains the most specific legacy signal.
  if (process.env.HERDR_ENV === "1") {
    if (herdr.isAvailable()) return herdr;
    throw new MultiplexerContextUnavailableError(
      "Herdr context is present but unavailable; refusing to fall back to another multiplexer.",
    );
  }

  const rexContext = probeRexContext();
  if (rexContext.kind === "invalid") {
    throw new MultiplexerContextUnavailableError(rexContext.message);
  }
  if (rexContext.kind === "ready") return rex;

  if (process.env.ZELLIJ_SESSION_NAME) {
    if (zellij.isAvailable()) return zellij;
    throw new MultiplexerContextUnavailableError(
      "Zellij context is present but unavailable; refusing to fall back to another multiplexer.",
    );
  }
  if (process.env.ZELLIJ) {
    throw new MultiplexerContextUnavailableError(
      "Zellij context marker is present without a session identity; refusing to fall back.",
    );
  }
  if (process.env.TMUX) {
    if (tmux.isAvailable()) return tmux;
    throw new MultiplexerContextUnavailableError(
      "tmux context is present but unavailable; refusing to fall back to another multiplexer.",
    );
  }

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

import {
  isRexBlockId,
  isRexServerAddress,
  isRexSessionId,
} from "./multiplexer-contracts";
import {
  probeLiveMuxTarget,
  probeLiveMuxTargetAsync,
  type LiveMuxProbe,
  type LiveMuxTarget,
} from "./multiplexer-live-probes";
import {
  closestMuxAncestor,
  readProcessContext,
  readProcessContextAsync,
  type ProcessContext,
} from "./multiplexer-process-context";

export type CurrentMuxContext =
  | { readonly kind: "absent" }
  | { readonly kind: "ready"; readonly target: LiveMuxTarget }
  | { readonly kind: "unavailable"; readonly message: string };

function safeSelector(value: string | undefined): value is string {
  return (
    !!value &&
    value.length <= 4096 &&
    !value.startsWith("-") &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function contextCandidates(env: NodeJS.ProcessEnv): {
  names: string[];
  targets: LiveMuxTarget[];
} {
  const names: string[] = [];
  const targets: LiveMuxTarget[] = [];
  if (env.TMUX !== undefined || env.TMUX_PANE !== undefined) {
    names.push("tmux");
    if (safeSelector(env.TMUX) && /^%\d+$/.test(env.TMUX_PANE ?? "")) {
      targets.push({ mux: "tmux", paneId: env.TMUX_PANE! });
    }
  }
  if (
    env.ZELLIJ !== undefined ||
    env.ZELLIJ_SESSION_NAME !== undefined ||
    env.ZELLIJ_PANE_ID !== undefined
  ) {
    names.push("Zellij");
    if (
      safeSelector(env.ZELLIJ_SESSION_NAME) &&
      /^\d+$/.test(env.ZELLIJ_PANE_ID ?? "")
    ) {
      targets.push({
        mux: "zellij",
        paneId: env.ZELLIJ_PANE_ID!,
        session: env.ZELLIJ_SESSION_NAME,
      });
    }
  }
  if (env.HERDR_ENV === "1" || env.HERDR_PANE_ID !== undefined) {
    names.push("Herdr");
    if (
      env.HERDR_ENV === "1" &&
      safeSelector(env.HERDR_SOCKET_PATH) &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(env.HERDR_PANE_ID ?? "")
    ) {
      targets.push({
        mux: "herdr",
        paneId: env.HERDR_PANE_ID!,
        session: env.HERDR_SOCKET_PATH,
      });
    }
  }
  if (
    env.REX_SESSION !== undefined ||
    env.REX_BLOCK !== undefined ||
    env.TERM_PROGRAM?.trim().toLowerCase() === "rex"
  ) {
    names.push("Rex");
    if (
      isRexSessionId(env.REX_SESSION) &&
      isRexBlockId(env.REX_BLOCK) &&
      isRexServerAddress(env.REX_SERVER)
    ) {
      targets.push({
        mux: "rex",
        paneId: env.REX_BLOCK,
        session: env.REX_SESSION,
        server: env.REX_SERVER,
      });
    }
  }
  return { names, targets };
}

/** Resolve ownership, not focus or an inherited environment-marker priority. */
export function resolveCurrentMuxContext(
  env: NodeJS.ProcessEnv = process.env,
): CurrentMuxContext {
  const { names, targets } = contextCandidates(env);
  if (names.length === 0) return { kind: "absent" };
  const context = readProcessContext();
  if (!context) return unavailableContext(names);
  return selectCurrentMuxContext(
    names,
    context,
    targets.map((target) => probeLiveMuxTarget(target, context, env)),
  );
}

/** Advisory status checks must not block Pi while host commands are pending. */
export async function resolveCurrentMuxContextAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CurrentMuxContext> {
  const observation = { ...env };
  const { names, targets } = contextCandidates(observation);
  if (names.length === 0) return { kind: "absent" };
  const context = await readProcessContextAsync();
  if (!context) return unavailableContext(names);
  const probes = await Promise.all(
    targets.map((target) =>
      probeLiveMuxTargetAsync(target, context, observation),
    ),
  );
  return selectCurrentMuxContext(names, context, probes);
}

function unavailableContext(names: string[]): CurrentMuxContext {
  return {
    kind: "unavailable",
    message: `${names.join("/")} context is unavailable or cannot be tied to this process; refusing to guess. Use an explicit mux preference to override.`,
  };
}

function selectCurrentMuxContext(
  names: string[],
  context: ProcessContext,
  probes: LiveMuxProbe[],
): CurrentMuxContext {
  const unavailable = unavailableContext(names);
  const matches = probes
    .filter((probe) => probe.kind === "match")
    .sort((a, b) => a.distance - b.distance);
  const winner = matches[0];
  if (!winner || matches[1]?.distance === winner.distance) return unavailable;
  // A verified outer pane is not proof of ownership past a nearer mux whose
  // API or inherited pane selector could not be verified.
  const nearest = closestMuxAncestor(context);
  const nearestDistance = nearest
    ? context.ancestors.findIndex((ancestor) => ancestor.pid === nearest.pid)
    : -1;
  if (
    nearest &&
    nearest.mux !== winner.target.mux &&
    nearestDistance >= 0 &&
    nearestDistance < winner.distance
  )
    return unavailable;
  return { kind: "ready", target: winner.target };
}

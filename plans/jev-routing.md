# Optional Jev routing implementation plan

Status: implemented and validated on `feat/jev-routing` after independent
Luna / max review. Plan clarifications and runtime review fixes are incorporated.

## Accepted behavior

With `--orchestratorv2`, `PI_ORCHESTRATOR_ROUTER=jev`, and
`TYPESAFE_API_KEY`, the parent lists its agents, asks Jev to select an existing
child for the user's task, and uses `send_interactive_subagent_message` to send
the task. Jev supplies advice only. The parent remains responsible for sending,
creating, attaching, and asking questions. Configuration explicitly opts into
sending the task and bounded responsibility metadata to TypeSafe. A key alone
does not enable the feature.

Default and legacy orchestration behavior stay unchanged. There is currently
no deterministic semantic resolver to wrap, and aliases alone never authorize
reuse. Explicit new-child, explicit child identity, and attach instructions
continue through existing parent policy. Ambiguous action/scope still requires
clarification; routing confidence never grants new permissions.

## Architecture and executable contract

1. Add `src/routing-engine.ts` for provider-neutral candidate, input, evidence,
   and decision types and a pure confidence/margin policy. An input contains a
   bounded task and trusted, live candidates with child ID, description,
   optional aliases, and status. Decisions are `reuse`, `ask`, or `cancelled`.
   `ask` has a closed reason and candidate IDs; scores are optional on failures.
   There is no model-driven `create` in this release.
2. Add `src/jev-routing.ts` for environment-only configuration and native fetch.
   Use the fixed `https://api.typesafe.ai/v1/systemone` endpoint, bearer token,
   `jev-latest`, and one Choice question named `route`. Map request-local
   `candidate_0` tokens back to runtime child IDs, with an explicit `none`
   option. Send task and allowlisted metadata only, never serialize the whole
   registry or include paths, runtime commands, outputs, or transcripts.
3. Validate response question/type, exact option set, finite probabilities in
   `[0,1]`, approximately unit sum, winner/argmax consistency, and confidence.
   Preserve provider confidence, winning probability, runner-up probability,
   and margin for host policy. Conservative initial defaults are confidence
   `0.8`, winning probability `0.8`, margin `0.2`; environment overrides must
   be finite and in range. These are initial policy settings, not a claim of
   calibrated accuracy. Bound candidates, fields, total request and response
   bytes. Use one request, a short bounded deadline, no automatic retries,
   composed cancellation, and safe closed failure reasons.
4. Add `src/tools/orchestrator-router.ts`, registered through existing
   orchestrator tools only in opted-in v2 mode. Expose
   `resolve_orchestrator_route({ task })`.
   Registration is idempotent at session start because the real Pi SDK applies
   CLI flag values after the extension factory; also allow immediate
   registration when flags are already bound. A real-SDK startup/reload test
   must prove the tool becomes active in the opted-in mode.
   It builds its own fresh registry view from current parent authority, rather
   than trusting model-supplied agents.
   Filter to actionable, alive, non-stale, direct children with trusted
   responsibility metadata. Capture parent session generation and candidate
   identity/metadata; after the network call, refresh and reject changed
   identity, working directory, responsibility, ownership, or liveness. Final
   liveness probes bypass cached observations and older in-flight probes in all
   three multiplexer backends. On cancellation, produce
   no route or clarification side effects. The tool never sends or spawns.
5. Return structured advice with child ID and evidence. The parent sends the
   original task with existing messaging tools, whose existing runtime guards
   remain authoritative. This is an advisory tool, not a new dispatch protocol
   or atomic authorization token. A returned route does not reserve a child.
6. Append enabled-only prompt guidance in `src/subagent.ts`. It explicitly
   overrides the base instruction to ask when several children plausibly match:
   if action, scope, deliverable, and access are clear and only child identity
   is ambiguous, list agents and call the advisor. On `reuse`, send the original
   task to its returned child ID; on `ask`, ask one concise question; on
   `cancelled`, stop. Explicit identity/new/attach requests bypass the advisor.
   Unclear action/scope/access still asks. Keep the default bundled prompt
   unchanged.

## Data and failure policy

- Missing or invalid configuration, no eligible candidates, incomplete bounded
  registry projections, timeout, HTTP errors, malformed responses, `none`, low
  confidence, or changed state never guess a child. Return an actionable closed
  reason to the parent. A disabled router makes zero network calls.
- User cancellation or a replaced parent session invalidates late results.
- Redact known credential formats, the configured API key, credential-bearing
  URLs, and obvious sensitive paths from every transmitted free-text field.
  Bound lengths before transport. Document that free text can contain sensitive
  content and redaction cannot guarantee arbitrary-secret detection.
- Enabling the feature is explicit consent for the documented external payload;
  no additional modal is required for this environment-configured integration.
- Do not upload routing telemetry. Tool results contain only bounded evidence
  and closed reasons; never return upstream error bodies or authorization data.

## Parallel implementation ownership

Shared interfaces for the workers:

```ts
interface RoutingCandidate {
  childId: string;
  description: string;
  aliases?: string[];
  status: string;
}
interface RoutingInput {
  task: string;
  candidates: readonly RoutingCandidate[];
}
interface RoutingEvidence {
  confidence: number;
  topProbability: number;
  runnerUpProbability: number;
  margin: number;
}
type RoutingDecision =
  | { kind: "reuse"; childId: string; evidence: RoutingEvidence }
  | {
      kind: "ask";
      reason: RoutingAskReason;
      candidateIds: string[];
      evidence?: RoutingEvidence;
    }
  | { kind: "cancelled" };
interface RoutingEngine {
  decide(input: RoutingInput, signal?: AbortSignal): Promise<RoutingDecision>;
}
```

`RoutingAskReason` is a closed union including `disabled`, `missing_key`,
`invalid_config`, `no_candidates`, `invalid_input`, `payload_too_large`,
`timeout`, `unavailable`, `invalid_response`, `no_match`, `low_confidence`,
`ambiguous`, `state_changed`, and `incomplete_registry`. The adapter exports
`isJevRoutingEnabled(env = process.env): boolean` (checks the explicit mode),
and `createJevRoutingEngine(options?: { env?: NodeJS.ProcessEnv; fetch?: typeof
fetch }): RoutingEngine`. Configuration is validated inside the engine before
any request. Integration may use the shared decision type for local failures.

- Luna / max worker A: routing types, pure policy, Jev transport/configuration,
  and focused behavioral unit tests.
- Luna / max worker B: runtime advisor tool, registration, and mocked integration
  tests covering authoritative candidate construction and stale/cancelled work.
- Parent: reviewed plan, enabled-only prompt wiring, user documentation, package
  allowlist, integration review, and final validation.

Workers must agree on exported interfaces before depending on each other's
files, read AGENTS.md and RTK.md, preserve unrelated changes, and not commit or
publish independently. Independent Luna / max review follows implementation.

## Validation and delivery

Execute focused tests with mocked fetch: correct request, healthy reuse,
ambiguous/none/zero-candidate cases, malformed and unknown options, missing key,
HTTP failures, bounded timeout/abort, secret scrubbing, and size bounds. Tool
tests exercise actual registered tools, authoritative filtering, changed
metadata/runtime/session, and zero dispatch/spawn side effects. Verify default
and legacy modes have no new behavior or network calls. Test emitted enabled
prompt guidance as an intentional interface, not as proof of model judgment.
The registration matrix must exercise flag-only, env-only, key-only, invalid
router values, and legacy-only mode: none registers the advisor or performs
network calls. Only v2 plus exact `PI_ORCHESTRATOR_ROUTER=jev` registers it;
missing/invalid credentials then produce safe advice without a request.

Run repository typecheck, full default test suite, format check, and pack dry-run;
inspect packaged module inclusion. A live API smoke test is optional only when
an API key is available, with synthetic non-sensitive candidates; never dump
environment values. Do not claim real-world routing quality from mocked tests.
Document a small offline evaluation set and metrics for subsequent calibration.

Deliver the implementation on `feat/jev-routing` in the task worktree, with a
concise validation report. Publishing, deployment, and merging are separate
from implementing and checking this feature.

## Implementation validation

Final runtime review identified missing working-directory snapshots and cached
final liveness probes. Both findings were fixed and covered by regression tests
before the final validation below.

- `npm run typecheck`: passed.
- `npm test -- --maxWorkers=2`: all 98 files and 2299 tests passed. Limiting
  workers avoids contention with timing-sensitive existing regression tests.
- `npm run format:check`: passed.
- `npm run pack:check`: passed; new runtime modules and setup documentation
  are included in the package allowlist.
- Real Pi SDK startup and reload, plus a clean installed-tarball consumer,
  exercise opt-in tool registration. Tests isolate routing environment values
  and mock provider transport.
- Independent Luna / max review of the adapter and confidence policy found
  no actionable issues.
- Fresh liveness and out-of-order completion regressions pass for tmux,
  zellij, and Herdr. Independent mutations of `cwd` and `workingCwd`, plus
  the end-to-end stale-liveness routing case, are covered.
- `git diff --check`: passed.

No live Jev request was made because `TYPESAFE_API_KEY` was absent. The mocked
tests validate integration contracts, not real-world selection accuracy.

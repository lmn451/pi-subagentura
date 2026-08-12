# PR #84 X01–X06 boundary matrix

Status: **X01 partial implementation; X02–X06 deferred**.

This document is separate from the F01–F20 acceptance contract. It records only
claims backed by the current production path. A helper API or unit test is not
counted as production closure unless a registered workflow path exercises it.

## X01 — durable process-child launch and adoption

### Proven in this worktree

- Declarative durable plans may request `isolation: "process"`.
- The durable runner preserves that requested isolation when invoking its
  registered `runAgent` implementation.
- Before invoking the agent, the runner appends a claim-bound
  `process_launch_intent` event containing the run/task/attempt identity,
  attempt number, lease epoch, nonce, launch marker, requested/effective
  isolation, and fallback mode.
- The registered `start_durable_workflow` path has admitted a real process task,
  persisted the launch intent after `task_started`, and reached validated child
  startup without depending on model completion.
- The process runner propagates the exact `launchMarker`, `nonce`, `attemptId`,
  and `epoch` to the child environment.
- The registered process path persists child-start evidence atomically, rejects
  incomplete or mismatched identity, and publishes `process_launch_dispatched`
  only after the runner callback and exact child-start evidence.

Evidence:

- `src/workflow-durable-plan-runner.ts`
- `src/workflow-plan.ts`
- `src/workflow-run-store.ts`
- `src/workflow-process-handshake.ts`
- `src/child-protocol.ts`
- `src/interactive-tmux.ts`
- `src/workflow-tool.ts`
- `tests/workflow-durable-plan-runner.test.ts` — intent ordering and payload
- `tests/workflow-process-handshake.test.ts` — exact identity and fencing
- `tests/child-protocol.test.ts` — child startup persistence and rejection
- `tests/workflow-contract-foundation.test.ts` — plan admission
- `tests/workflow-acceptance-lifecycle-compatibility.test.ts` — F18 real
  `start_durable_workflow` process lane

### Still deferred

The following are not claimed: pane adoption after coordinator restart;
ambiguous command dispatch probing and retry fencing; exactly-one-child
OS-level enforcement; dead-child accounting with complete-vs-lower-bound usage;
reattachment across coordinator restart; and reconciliation across a different
host or multiplexer namespace. Exact artifact identity rejection is not a claim
of full OS process lifecycle or replacement-pane fencing.

## X02 — durable arbitrary-JavaScript replay

**Deferred.** Durable declarative process-task admission is not durable replay of
arbitrary JavaScript. Stable call IDs, immutable root/nested definition
snapshots, independent dispatch/response ordinals, ordered response replay,
`replay_diverged` handling, missing-ordinal failure, and definition/options
fingerprinting are not claimed for the legacy JavaScript workflow path.

## X03 — host-forced routing

**Deferred.** Routing policy remains opt-in. Local routing helpers and measured
policy tests do not prove host enforcement for every listed context, nor do they
prove environment compliance when the selected multiplexer is unavailable.
`routing_unconfirmed` remains the honest result for unmeasured compliance.

## X04 — autonomous wake after mutation

**Deferred.** Mutations and approval/budget changes remain durable and
owner/epoch/revision fenced, but an eligible mutation does not yet wake a
single existing executor automatically. Explicit resume remains required; the
mutation path does not claim to start model work.

## X05 — exactly-once execution and notification

**Deferred.** The journal and delivery identifiers support idempotent recovery
and at-least-once-oriented accounting. They do not establish exactly-once model
execution or exactly-once external notification across crashes, process death,
transport retries, or coordinator failover.

## X06 — same-user path-race containment

**Deferred.** Existing storage checks reject malformed/non-regular paths and
exercise helper-level symlink/substitution defenses. This worktree makes no
`openat2`-class claim against a malicious same-user parent-directory rename or
substitution race. Closing that boundary requires a platform-specific native
primitive (or an equivalently strong verified implementation), plus adversarial
multi-process evidence.

## Verdict rule

Only the proven subset above may be described as implemented. X01–X06 must not
be summarized as all PASS until each deferred subsection has direct production
and adversarial evidence.

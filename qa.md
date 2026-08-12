# Workflow redesign QA checklist

This document is the question set for validating the Milestones 3–8 workflow slice. Every answer should include the test, fixture, or persisted evidence that supports it.

## 1. Frozen plan scope in practice

| Item                           | Scope status                  |
| ------------------------------ | ----------------------------- |
| X01–X05 (out-of-scope this PR) | Deferred                      |
| X06 (security boundary)        | Deferred / helper-only checks |
| 1–21, 22*, 39–47, 54+, 55+     | In-scope for PR-84            |

The PR-84 foundation is **declarative in-process** durability only. Supported production behavior:

- durable run creation + restart recovery;
- trusted-command resume and explicit trust boundaries;
- at-least-once terminal delivery with receipts;
- manual resume and explicit trust boundaries;
- helper-only support for process-isolated launch, durable JS replay, and notification semantics.

Out of scope in this frozen scope:

- **X01:** process-isolated durable task launch + handshake/adoption/dead-child accounting;
- **X02:** durable arbitrary JS replay / process-replay stability guarantees;
- **X03:** host-forced routing enforcement; routing remains opt-in.
- **X04:** autonomous wake after mutation/approval/budget change (explicit resume action remains required);
- **X05:** exactly-once execution/notification claims.
- **X06:** defense against same-user same-directory rename/substitution races; no native `openat2`-class containment claim.

## Durable authority and outbox

1. Does a newly created run persist `run_created` before any agent or process dispatch?
2. Does `get_workflow_result` return the folded terminal result after the in-memory registry and all live Promises are gone?
3. If result, terminal event, delivery intent, and parent receipt are written at separate crash boundaries, does recovery repair each gap without losing the result?
4. Can a stale same-run or old-generation callback change a terminal projection?
5. Is terminal delivery identified by a deterministic ID, and is duplicate dispatch limited to the dispatch-before-receipt window?
6. Does cancellation remain idempotent across repeated calls and session reloads?
7. Are interrupted, blocked, and awaiting-budget states actionable and queryable after restart?

## Ownership, leases, and storage safety

8. Can two Pi processes write the same owner namespace at once?
9. Does stale lease takeover verify process identity when available, fail closed when ambiguous, and increment the lease epoch exactly once?
10. Does every append, acknowledgement, approval, delivery, prune, and mutation revalidate owner, token, and epoch?
11. Do traversal paths, symlink substitution, rename races, hardlinks, and non-regular files fail safely?
12. Do malformed complete event lines stop recovery instead of being guessed through?
13. Does a torn final line get truncated only at a verified complete-line boundary?
14. Are ENOSPC and configured byte/run/event quotas surfaced as explicit workflow errors while preserving prior valid evidence?
15. Does retention protect running, blocked, approval-pending, interrupted, and undelivered runs?

## Parallel execution and accounting

16. After a crash with one committed, one running, and one undispatched sibling, does recovery replay only the committed evidence, retry the interrupted attempt with a new attempt number, and start the undispatched task once?
17. Are process and in-process concurrency caps enforced by one shared dispatcher rather than only by scheduler eligibility?
18. Does stop-on-failure close new dispatch while draining already-running siblings deterministically?
19. Is each committed attempt counted exactly once, including after replay?
20. Is interrupted provider usage marked as an explicit lower bound rather than presented as exact?
21. Is terminal task and result ordering stable across runs and reloads?

## Process-child handshake and adoption (DEFERRED — PR #84 foundation scope)

22. Is the launch intent persisted before pane creation?
23. Are attempt, nonce, epoch, launch marker, and effective fallback mode persisted before use?
24. Is `launch_dispatched` durable before command send, and is child `started` validated before model work?
25. After a crash before pane assignment, can startup find and fence the intended pane without creating a duplicate?
26. After ambiguous command dispatch, does recovery probe and fence before retrying rather than blindly resending?
27. Can stale nonce, attempt, or epoch artifacts settle a replacement attempt?
28. Is a dead child’s partial usage surfaced as lower-bound evidence when billing cannot be observed exactly?

## Durable JavaScript replay (DEFERRED — PR #84 foundation scope)

29. Does `durable: true` require explicit stable IDs for `agent()` and nested `workflow()` boundaries?
30. Are root and nested saved definitions snapshotted immutably before the first durable acknowledgement?
31. Are dispatch and response ordinals persisted independently of worker epoch and transcript arrival order?
32. Do success, null, error, cancellation, and schema-retry responses replay in their original worker-visible order?
33. Do Promise race, concurrent awaits, shared post-await mutation, and nested calls either replay deterministically or fail boundedly as `replay_diverged`?
34. Does a missing ordinal fail boundedly instead of deadlocking?
35. Do changed prompt, options, schema, model, isolation, or definition bytes produce `replay_diverged`?
36. Do non-durable scripts without IDs retain their existing behavior and result shape?
37. Are unsupported durable concurrency shapes rejected before `run_created`?

## Plan mutations and human editing (X04 deferred: explicit resume action)

38. Does every mutation require the exact owner, lease epoch, and base revision?
39. Can only pending or blocked future tasks be block, unblock, skip, or append targets?
40. Are running and terminal task definitions and history immutable?
41. Does skip preserve an audited event rather than deleting future work?
42. Does every valid mutation produce a monotonic revision and content hash?
43. Does an eligible mutation wake the single executor without itself starting or completing model work?
44. Do view and export preserve stable task IDs, phase modes, and read-only completed history?
45. Does stale editor save return a refresh/diff error and leave the authoritative plan unchanged?
46. Are export and edit paths contained, owner-only, and restricted to interactive human commands?

## Context, reminders, and approvals

47. After supported reload or compaction, is injected context bounded, factual, and labeled non-authoritative?
48. Does the context include run ID, revision, status, phase, running/blocked/next tasks, and completed counts without dumping outputs?
49. Are reminders suppressed while active work will wake the parent, all open work is blocked, or user input is pending?
50. Are reminders capped per turn/generation, and does real progress reset suppression?
51. Is there exactly one durable approval record bound to request ID, policy hash, plan revision, owner generation, lease epoch, and single-consume version?
52. Is approval reachable only through trusted command, tree, or UI paths, with no model-callable grant operation?
53. Do stale, wrong-owner, duplicate, and post-reload approval decisions become no-ops?
54. Does approval wake the correct continuation once, and does denial follow the declared stop/skip policy?

## Release and compatibility gates

55. Do minimum and latest supported Pi SDK lanes pass parameter validation, sync/async compatibility, routing capability, and same-turn behavior checks?
56. Do packed-consumer smoke tests include all new runtime files and public types while excluding stores, fixtures, temporary plans, and secrets?
57. Does automatic routing remain opt-in until measured false-positive, suppression, host-lane, and minimum-SDK policy-lane gates pass?
58. Under `preferred`, do simple work, questions, plan-only requests, child contexts, active continuations, and user-input waits stay direct or suppressed?
59. When host tool choice cannot be forced, is observed compliance or `routing_unconfirmed` reported without claiming enforcement?
60. Are legacy non-durable `script` and `name` calls unchanged, and are durable requests rejected rather than silently downgraded when unsupported?

## Required command set

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
```

A milestone is not complete when only unit tests pass. The crash boundaries, restart/recovery behavior, packed package, and compatibility matrix must also be exercised.

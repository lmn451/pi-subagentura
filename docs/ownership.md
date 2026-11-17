---
title: "Interactive Child Artifact Ownership"
keywords:
  [
    interactive children,
    artifact identity,
    child processes,
    completions,
    troubleshooting,
  ]
---

# Interactive Child Artifact Ownership

## Why this matters

An interactive sub-agent runs in a separate Pi process. Before this fix, a nested
`pi --no-session` process could inherit the outer child's artifact directory and
child-mode marker. The extension treated those values as authority. Its lifecycle
hooks could then clear the outer child's output, replace its active turn, and
append a false completion with empty output. A `done` completion did not prove
that the nested process had produced an answer.

## How ownership works

Each interactive launch creates a private, one-use credential for its exact
artifact directory. The launcher passes the credential path to the child. The
child claims and removes the credential before it registers artifact lifecycle
hooks. The child also removes the credential variable from its environment, so a
later nested Pi process inherits no artifact authority. Every interactive child
gets a separate credential.

The artifact credential does not expire by clock. A delayed child startup can
still claim it. If the credential file is missing when the launch wrapper starts,
the wrapper exits with an error. If the extension rejects a credential, it
reports a load error and does not register child hooks or fall back to parent
mode. `PI_SUBAGENTURA_CHILD=1` and `ARTIFACT_DIR` alone do not authorize child
hooks.

Lineage authority is separate. Its bootstrap expires after 60 seconds. If that
bootstrap expires, the current child can continue to use its own artifact, but it
cannot recursively spawn interactive children until it starts with valid lineage
context.

## Investigate a suspicious completion

1. In the parent session, identify the interactive child with the status and
   artifact tools. Use the child session reference recorded for that child.
2. In the child Pi session, check that the user entry and assistant response are
   present for the turn.
3. Compare the child session's persisted user-entry identity with the `turnId` in
   the artifact's `turn_started` and `completion` events. Read events in physical
   file order. Timestamps are display metadata, not ordering authority.
4. Inspect the captured output as well as the completion outcome. `done` can
   accompany an empty output; it is not proof of a useful answer.

A completion with no matching child turn is evidence of an artifact-identity or
lifecycle issue. Do not infer a model failure from an empty snapshot alone.

## Limits

The one-use credential prevents accidental environment inheritance. It is not an
OS security boundary against malicious code running as the same user. Such code
can already access the user's files and multiplexer.

A crash during the atomic claim can leave a claim file. Cleanup preserves it while
the recorded owner process is alive. If that process exits after the first cleanup
pass, the residue remains until a later cancellation, fresh-session, or artifact
cleanup pass. The claimed filename cannot authorize lifecycle hooks.

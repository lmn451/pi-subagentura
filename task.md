# Orchestratorv2 design-compliance fixes

## Goal

Bring `feat/orchestratorv2-thin-router-omp` into exact alignment with the approved thin-router design while preserving existing interactive-agent behavior and the legacy `--orchestrator` path.

## Required changes

1. Add an explicit zero-match policy: a narrow, exact, continuation, or delegation request with no matching child must be surfaced to the user and must not silently spawn or fan out. Broad user-originated requests may still be decomposed into new children.
2. Expose exactly two new routing tools:
   - `list_orchestrator_agents`
   - `update_orchestrator_agent_description`

   Remove the public metadata-removal tool and its docs/tests. Capacity exhaustion must fail closed without eviction, deletion, rollback, replacement, or respawn.

3. Make persisted routing records complete:
   - child/session ID;
   - responsibility description;
   - optional exact aliases;
   - required provenance: `user` or `orchestratorv2`;
   - required update timestamp;
   - project identity and schema version.

   Initial metadata authored during Orchestratorv2 child creation uses `orchestratorv2` provenance. Confirmed updates must provide provenance explicitly.

4. Preserve routability of safe legacy interactive IDs. Accept both historical 8-character and current 16-character lowercase hexadecimal IDs everywhere an existing interactive child ID is validated. New IDs remain 16 characters.
5. Preserve the approved Phase 1 boundaries:
   - prompt policy, not a host-level allowlist;
   - workflow and in-process tools remain registered but forbidden by the Orchestratorv2 prompt;
   - interactive children may create nested interactive children owned by their immediate parent;
   - launch precedes initial metadata persistence; persistence failure leaves the child live and returns an explicit warning;
   - routing metadata never becomes a lifecycle registry or semantic resolver.
6. Update README and focused tests to describe and enforce the final contract. Delete obsolete removal/capacity-recovery code rather than retaining aliases or compatibility shims for the unapproved API.

## Acceptance

- TypeScript typecheck passes.
- Focused Orchestratorv2, schema, rehydrate, extension, and interactive tests pass.
- Full test suite passes.
- Formatting and package dry-run checks pass for tracked project files.
- Final review finds no extra routing tool, no provenance-less persisted record, no false-actionable legacy ID, and no missing zero-match prompt rule.

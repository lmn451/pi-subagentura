# Orchestratorv2 Split Policy

This additional policy is enabled by `--orchestratorv2 --split`.

Every broad user-originated request must be decomposed into the smallest practical independent parts, then spawn or route exactly one interactive child for each part with a distinct, explicit responsibility. Apply this after the exact-match and ambiguity safeguards in the base Orchestratorv2 prompt; do not combine independent parts or leave a part handled by the router.

Honor the base prompt's execution-surface precedence, user-selected targets,
authority checks, read-only boundaries, and implementation handoff completeness
gate. Apply this decomposition policy through the selected surface and its
actual identities; never invent native IDs for host-managed agents.

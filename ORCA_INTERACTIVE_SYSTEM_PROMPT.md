# Orca Interactive Delegation Guidance

## Scope and precedence

Apply this guidance whenever this Pi session is choosing or coordinating an interactive Pi delegation, whether it is an ordinary parent, an Orchestratorv2 parent, an interactive child, or a nested context. It is not gated by an orchestration flag or by the user naming Orca. This is prompt policy, not runtime enforcement.

This guidance governs only interactive delegation and its execution surface. It does not turn an ordinary parent into a thin router or prohibit repository work the parent owns. It does not select workflows or in-process jobs, alter their selection or registration, or change the native Subagentura backend.

Choose the interactive surface using the verified current-session proof below. Existing native interactive children remain native, including when Pi is inside Orca: keep their native identities, registry, artifacts, receipts, lifecycle, and completion handling in Subagentura. Do not translate them into Orca identities or dual-dispatch their work. Orca-managed Pi specialists are distinct skill-managed terminal agents; never invent native IDs, artifacts, receipts, turns, notices, or wakeups for them, or promise native Subagentura completion for their work.

When Pi is verified inside Orca and the request does not explicitly select a
target, these shared instructions choose the host-managed surface as the
default for a new interactive delegate, ahead of native-only defaults or
advisors. Every explicit user-selected target still wins, including native
`subagent_interactive` or a requested mux. Native routing, authority, schema,
artifact, and completion rules continue to apply to existing native children.
Nested Orca work follows its live skill/dispatch authority and remains owned by
its immediate coordinator.

## Verify the interactive execution surface

Only use Orca skills or invoke the Orca CLI after current-session/runtime evidence verifies that this Pi caller and terminal belong to the running Orca instance, or when the user explicitly selects Orca. An explicit Orca request permits loading the skills to verify the requested target and detect a mismatch before launch; it does not prove the caller is inside Orca.

An installed CLI or skill, inherited environment marker, cwd, or active UI tab alone is not proof. Do not use Orca tools to bootstrap unverified host detection. If positively outside Orca, do not use Orca skills or tools unless the user explicitly selected Orca; Rex is one example of a distinct, non-Orca host. If host or surface is ambiguous, ask before launching; do not silently switch or fall back.

After Orca is positively verified or explicitly requested, load the installed `orca-cli` and `orchestration` skills before selecting or using that surface. Follow their discovery stubs to resolve one Orca executable, fetch its version-matched guides (including conditional references when applicable) before command discovery, and use that executable throughout. The skills are authoritative for exact commands, flags, launch and submission receipts, role classification, and recovery; do not maintain a duplicate CLI manual. Report a failure rather than switching binaries.

Use current-session/runtime proof that is independent of Orca skill/CLI availability to verify the caller and terminal belong to this running Orca session before loading the skills for an unrequested default. Once authorized, use the guides' runtime status and terminal discovery to confirm that proof, and bind the exact current checkout/workspace and execution host. An explicit Orca request authorizes the skills for this same verification and mismatch check. If positively outside Orca and Orca was not explicitly selected, keep the existing supported native path and do not invoke Orca tools. If an explicit Orca request conflicts with verified outside topology, report the mismatch and ask; do not silently fall back. If proof is unavailable or ambiguous, ask before launch and do not select either surface, spawn on either surface, or dual-spawn.

## Orca specialist roles and ownership

When the current session is verified inside Orca and the user has not
explicitly selected another target, use Orca's skills to coordinate new Pi
specialists in Orca terminal tabs instead of creating new native interactive
children. Use `orchestration` for explicitly supervised coordination, result
tracking, DAGs, and ask/reply; honor a live dispatched-worker preamble when
present. Use `orca-cli` for ordinary terminal prompts and full ownership
handoffs. Do not create Run/Task/Dispatch lifecycle state for ordinary terminal
prompts or full ownership handoffs. A full handoff ends after verified delivery
and reporting the owned identity; do not monitor it as supervised work.

Use the same checkout and exact discovered workspace by default; do not create a worktree unless requested. If sharing would create a conflict, pause and ask rather than silently isolating the work. Request the terminal surface explicitly through documented launch controls so specialists open as terminal tabs, not Chat UI. Verify the launch receipt; if the installed version cannot honor the terminal surface, report that limitation before spawning.

Prefer Pi in the terminal and the same model and reasoning effort as the parent when the version-matched skill and installed agent support them and the effective parent settings are verified. Respect explicit user choices. Do not guess flags, model IDs, or effort syntax: load the relevant launch reference/help and verify the effective launch receipt. If parity is unsupported or unverified, disclose that and ask before substituting another agent or configuration.

Before reuse or fanout, discover agents through the skills. Bind each specialist's explicit responsibility, allowed read/write scope, deliverables, and parent ownership to its current runtime identity: exact workspace/host and agent session/terminal handle, plus the active Task/Dispatch when supervised. Ground assignments in actual launch or discovery receipts and keep them in the parent conversation; after lost context, recover ownership or ask. Titles, labels, agent type, and workspace membership are not ownership. A responsibility proposal from a worker requires explicit user approval before changing its assignment.

Reuse only a freshly verified live, owned agent for an exact continuation covering the requested relationship, action, deliverable, and access. A live PTY alone does not prove a live agent. Unknown or stale ownership/liveness is not routable; surface it without replacement, and never treat lost contact or stale/unknown ownership as proof that no owner exists. Shared domain words do not authorize a read-only reviewer to design or implement; scope expansion requires a new, explicitly approved responsibility. Honor new-thread requests. When fresh authoritative registry/discovery establishes that no suitable exact, live, authorized owner exists, a clear request with a definite action, scope, deliverable, and access authorizes exactly one new specialist without asking again. This includes narrow read-only investigation; ask only when the action, scope, deliverable, or access is genuinely unclear, or a choice among plausible owners remains unresolved. Nested work remains owned by its immediate coordinator.

Use the skills' correct terminal or supervised messaging path for the owned target. Rediscover stale handles after a runtime restart or stale-handle error; use only the freshly proven replacement and never dual-send. After an ambiguous launch or send failure, inspect the receipt and current runtime without injecting input, then follow only the documented same-operation recovery. Do not switch to native tools, launch a duplicate, send via another channel, or respawn or resend on silence. For an attach request, focus or switch only; do not also send a task.

## Delivery, supervision, and preservation

Idle state, timeout, input acceptance, or mailbox enqueue is not completion or proof that a turn started. Follow skill-defined submission receipts and bounded read/wait/inbox flows. For supervised work, validate reports against the active Task/Dispatch, process messages before acknowledgment, and keep pending work pending until authoritative settlement. For ordinary work, retrieve the actual report attributable to the requested task and report gaps rather than inferring success from a quiet terminal. Do not promise automatic Subagentura completion, artifacts, manifests, parent wakeups, or reload recovery for Orca specialists.

Preserve visible terminals and user work. Follow the skills' completion accounting for supervised work and obtain a user decision at settlement when needed; do not require a separate lifecycle decision before a requested launch. Ordinary handoffs end after verified delivery and reporting. Do not delete visible tabs by default; destructive cleanup requires user approval. Never substitute terminal closure for an uncertain release or treat contact loss as permission to stop.

## Complete report handoffs

When implementation follows completed scout/planner work, retrieve the actual
report/output for every completed scout/planner from this request before
deciding which findings matter. For Orca reports, use the skills' report/output
retrieval bound to the verified owned terminal/session and active Task/Dispatch
when supervised. For native Subagentura children, use the existing native
artifact/retrieval path and exact child/turn selector; do not translate
identities, selectors, or receipts between surfaces. In either case, retrieve
referenced report files, not just a completion receipt. A manifest, completion
summary, task preview, remembered context, or presumed sibling-session
visibility is only a pointer, not a substitute for the actual report. If a
report is unavailable, truncated, or ambiguous, do not guess or hand off
implementation; obtain the exact result or surface the coverage gap.

Draft one self-contained initial brief for an implementer. Include the approved
implementation scope; all relevant verified findings; a repository map with
exact files, symbols, tests, and conventions; settled decisions, constraints,
and non-goals; unresolved questions and version uncertainties; acceptance
criteria and expected checks; and real source references. For Orca reports,
include task/dispatch, session/message/report selectors, and file paths or line
ranges where available. For native reports, include the actual native child/turn
selector. Do not invent native child or turn IDs.

Before dispatch, compare the brief against every retrieved report one by one.
Carry forward each relevant finding, constraint, risk, open question, and test
expectation, or explicitly mark it out of scope with a reason. Do not omit
information merely because it seems duplicative. Do not rely on implicit
sibling transcript visibility: pass the complete handoff explicitly in the
initial task/brief. Avoid repeating broad scouting or planning or asking the
user to restate settled information; resolve a concrete contradiction or
blocker and report any new scope or decision needed.

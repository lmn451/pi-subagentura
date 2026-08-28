---
name: pi-session-recovery
description: Recover Pi/subagentura incidents involving lost/closed tmux panes or Zellij tabs, dead Pi child processes, orphaned/partial session recovery, or requested session reattachment. Do not use for normal agent spawning, ordinary workflow reuse, or routine /resume.
---

# Pi session recovery

Use this runbook only for an actual lost-runtime incident.

## Trigger

Activate for:

- an accidentally closed/lost tmux pane/window or Zellij pane/tab;
- a dead Pi child process whose session/worktree may remain;
- orphaned/partial session recovery;
- an explicit request to reattach or resume a lost subagent session.

Do not activate for normal agent spawning, ordinary workflow reuse, routine
`/resume`, healthy live panes, or speculative cleanup.

## Safety rules

- Treat the JSONL, artifacts, and worktree as durable evidence. A closed mux pane
  kills the live Pi process but normally does not delete them.
- Do not run `git reset`, `git clean`, checkout over changes, delete a worktree,
  edit session JSONL, or remove artifacts during preflight.
- Do not launch a second Pi writer until the recorded pane is conclusively dead
  and process checks show no runtime already using the session file.
- Present the recovery plan and obtain explicit confirmation before launching a
  replacement or performing any destructive cleanup.
- Unknown liveness is not dead. Stop and ask the user to inspect the mux/process.

## Preflight

Set placeholders from subagentura status/artifact metadata, never by guessing:

```bash
CHILD_ID='<subagent-runtime-id>'
SESSION_FILE='<absolute-child-session.jsonl>'
ARTIFACT_DIR='<absolute-artifact-dir>'
WORKTREE='<absolute-worktree>'
```

1. Confirm paths and preserve the worktree:

   ```bash
   test -f "$SESSION_FILE" && test -d "$ARTIFACT_DIR"
   git -C "$WORKTREE" status --short --branch
   git -C "$WORKTREE" worktree list
   ```

   Do not start another editor/agent in the worktree while recovery is pending.

2. Read the true Pi session identity from the first JSONL header:

   ```bash
   python3 - "$SESSION_FILE" <<'PY'
   import json, pathlib, sys
   path = pathlib.Path(sys.argv[1])
   with path.open() as handle:
       header = json.loads(handle.readline())
   assert header.get("type") == "session", "missing Pi session header"
   print("pi_session_id=", header.get("id"))
   print("cwd=", header.get("cwd"))
   PY
   ```

   `CHILD_ID` is the subagent runtime/registry identity. The JSONL header `id` is
   the Pi session ID used by `pi --session`; they are normally different.

3. Check for duplicates before launch:

   ```bash
   ps -axo pid=,ppid=,command= | grep -F -- "$SESSION_FILE"
   tmux list-panes -a -F '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'
   zellij list-sessions 2>/dev/null || true
   ```

   For a known Zellij session, inspect terminal panes with
   `zellij --session '<name>' action list-panes --json`. Do not recover when the
   recorded pane is alive, liveness is unknown, or another Pi command references
   the same `SESSION_FILE`.

## Preferred subagentura reattachment

If `recover_interactive_subagent` is available, use it before manual shell
recovery. It must:

1. preflight the exact direct interactive child;
2. show a native confirmation with child ID, Pi session ID, worktree, JSONL,
   artifact, owner, lineage, and old pane;
3. recover only after the user confirms;
4. preserve the child ID, delivery cursors/receipts, artifacts, and routing
   authority while rebinding only the dead runtime/pane pointers.

After successful rebind, wait until status is `idle`, then continue with an
explicit child-ID follow-up. Never infer routing authority from liveness alone.

## Manual conversation recovery

Manual recovery reopens the child conversation/worktree but does **not** reattach
subagentura registry/lineage/artifact ownership to the parent.

Prefer the exact path from the recorded state:

```bash
cd "$WORKTREE"
pi --session "$SESSION_FILE"
```

Use ID lookup only with the full JSONL header ID and the directory containing the
file directly:

```bash
PI_SESSION_ID='<header-id>'
pi --session-dir "$(dirname "$SESSION_FILE")" --session "$PI_SESSION_ID"
```

`--session-dir` controls lookup and storage for later new/branched sessions. An
exact `--session <path>` opens that file directly and is safer for nested
subagentura session layouts.

Use `--fork` only when the source must remain untouched, a duplicate writer may
still exist, or recovery intentionally becomes a separate Pi session:

```bash
cd "$WORKTREE"
pi --fork "$SESSION_FILE"
```

Forking creates a new Pi session ID and cannot rebind the original child runtime.
Do not use `--session-id` for lookup; when missing, Pi creates a new session.

For tmux or Zellij, create one new pane/tab only after confirmation, then run the
exact `pi --session` command inside it. Closing the old tab cannot resurrect its
process; recovery creates a new process around the same JSONL and worktree.

## Recovery boundaries

| Runtime                        | startup/reload/resume/quit             | new/fork                   | crash/dead pane                       |
| ------------------------------ | -------------------------------------- | -------------------------- | ------------------------------------- |
| Direct interactive             | Matching persisted state can rehydrate | Intentionally not restored | Explicit validated rebind is feasible |
| Workflow child                 | Runtime-only; do not rehydrate/rebind  | Not restored               | Manual conversation recovery only     |
| In-process/background workflow | Process-scoped; not rehydrated         | Not restored               | Cannot reconstruct the runtime        |

Conversation recovery is not parent-session grafting. A manually reopened child
remains a separate Pi session. The parent can consume retained artifacts or future
explicit follow-up/manifests after an authoritative extension rebind, but Pi does
not natively merge the child transcript into the parent conversation.

## Cleanup

Only after successful recovery and explicit user confirmation may stale empty
panes, obsolete launch scripts, or duplicate forks be removed. Never delete the
source JSONL, artifact directory, or partial worktree merely because reattachment
failed; report the validated paths and the exact unsupported boundary instead.

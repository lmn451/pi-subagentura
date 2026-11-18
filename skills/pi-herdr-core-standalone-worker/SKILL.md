---
name: pi-herdr-core-standalone-worker
description: Guide an explicitly requested standalone Pi worker in Herdr Core. Use only when the user selects this separate terminal path, not for native pi-subagentura delegation.
disable-model-invocation: true
---

# Standalone Pi workers in Herdr Core

Use this guide only after the user explicitly asks for a standalone worker in
Herdr Core, or invokes this skill by name. A general request to delegate does
not select this path. Do not change the default host, choose a backend, or
silently reroute a native delegation request.

## Know the boundary

A Core terminal runs an independent Pi process. It is not a registered
pi-subagentura child. It does not appear in native sub-agent status or routing
lists and has no pi-subagentura artifact, completion manifest, follow-up,
cancellation, wake, or delivery guarantees. Do not describe it as a native
sub-agent or promise that its result will return to the parent automatically.

This skill adds no runtime backend, bootstrap, state file, or messaging
protocol. It does not require or install pi-intercom. The user can inspect the
worker in Herdr Core and bring its result back to the parent themselves.

## Check the installed interface

This guide was checked with `hc` 0.1.21 on macOS (Darwin 24.6.0). Herdr Core
is not the classic `herdr` multiplexer used by `mux=herdr`. If `hc` is missing
or the local version or OS is unverified, report the limitation and stop.

Read `hc --version`, `hc --skill`, and `hc run --help` for the installed
version and syntax. These commands do not start Core. They do not prove which
live Core a later command will reach. Do not use inherited `HC_*` markers, a
socket path, or a CLI status or terminal query as proof. In a scratch check,
`hc get` started a new Core after socket replacement.

Ask the user to confirm that the intended local Core is already open in their
Herdr window or Core terminal. If they cannot confirm it, stop. Do not search
other Core sessions or machines, start or restart Core, or switch hosts.

## Prepare a launch for the user

Confirm the task and the exact local working directory. Prepare a command
from the installed `hc` guide for the user to run from their confirmed Core
session. Do not execute it yourself: the tested interface cannot guarantee
that a launch will reach that same running Core without starting another one.

Use a new, distinct terminal name, an explicit working directory, and a
direct interactive Pi launch in the background. Do not use Pi print mode, a
remote machine, a resume flag, or Core's keep recovery. Select the installed
option for no parent so Core does not infer a terminal to notify or tie the
worker's lifetime to it. Quote paths and arguments as data. Have the user
enter the scoped task in the worker once Pi is ready; tell the worker not to
start more agents or send terminal messages.

Core supplies its own launch environment. A local launch exited 127 because
Core could not find Node; passing only the necessary caller `PATH` on a
fresh launch let Pi start. This does not explain failures in other backends.
If the same failure occurs, ask the user to inspect the terminal and correct
only the launch `PATH` needed for Pi and Node. Do not copy credentials,
bootstrap variables, or the whole environment. If launch or allocation is
uncertain, do not retry. Ask the user to check the current Core for the
terminal before deciding whether to start another one.

## Report and inspect results safely

Ask the user to select the new terminal by its launch name in Core's terminal
picker (see `hc --help`) and confirm that it shows the expected Pi session.
The installed `herdr-app --skill` explains how the desktop window differs:
an `hc` launch without layout labels does not appear as a tab automatically.
If the user wants a visible tab, they can instead open one in the intended
local Herdr window and start interactive Pi there.

Ask the worker to leave its result or blocker in its own Pi terminal. The
user can copy it back from there. Core documents tagged reports to a parent
terminal and optional status notes; this skill does not use them. They are
not Pi results or a guaranteed parent wake. The user controls any follow-up
or stop action in the verified terminal. An address can refer to a replacement
program after recovery. Do not read, send, attach, or kill by address, or
generate a native focus command. If the worker's identity is unclear, stop.

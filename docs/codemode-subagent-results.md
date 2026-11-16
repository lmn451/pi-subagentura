---
title: "Opt-in Codemode Sub-agent Result Comparison"
keywords: [codemode, sub-agent results, artifact, comparison, completion]
---

# Opt-in Codemode sub-agent result comparison

This standalone Pi Codemode example summarizes and compares a small, explicitly
selected set of completed interactive sub-agent outputs. It uses the public
`read_subagent_artifact` tool. Artifact retrieval, completion delivery, and
consumption receipts remain owned by pi-subagentura; this example adds no
extension API or lifecycle behavior.

## Enable it for one Pi session

Start Pi with pi-subagentura loaded and the artifact reader plus Codemode
available. Disable MCP tools for this session if they are not needed:

```sh
pi --tools read_subagent_artifact,codemode --no-mcp
```

Use the exact `id` and Pi-derived `turnId` pair for each completed interactive
result. Copy selectors from the completion manifest; do not use a child name,
label, timestamp, list order, or a guessed turn. Edit `SELECTORS` in
`examples/codemode/subagent-results.mjs` with 1-6 pairs, then ask Pi to run that
file once through `codemode`. Ask it not to call `read_subagent_artifact`
directly for these reads.

Example shape (replace both values with real manifest values):

```js
const SELECTORS = [
  { id: "0123abcd", turnId: "exact-turn-id-from-manifest" },
  { id: "1234abcd", turnId: "another-exact-turn-id" },
];
```

A successful output-bearing artifact read records consumption for the selected
completion, so it will not be delivered again automatically. The script reads
only the selectors in `SELECTORS`; it does not list artifacts, poll running
children, or consume other completions. Review the selector list before running.

## Bounds and behavior

- Calls only `tools.read_subagent_artifact({ id, turnId, includeOutput: true })`.
  It makes at most 6 calls, in parallel, and passes both exact selector fields.
- Rejects empty, duplicate, malformed, or over-limit selector lists before any
  tool call. It does not use `since`, latest-turn defaults, labels, timestamps,
  or status polling.
- Reports each selected item, including unavailable artifacts, call failures,
  mismatched IDs or turns, running turns, terminal errors/cancellation, missing
  output, and truncated output. Raw tool diagnostics are not copied into the
  summary.
- Keeps at most 240 characters of sanitized, untrusted output per excerpt.
  The tool bounds each structured output to 64 KiB; with six selectors this is
  at most 384 KiB of returned output for script processing. The Codemode result
  is capped at 1,800 tokens.
- Compares only complete outputs, using exact text equality. `identical_text`
  means the returned strings are exactly equal; `different_text` does not imply
  a semantic disagreement. Missing, truncated, failed, or incomplete results
  are marked `not_comparable` rather than omitted.

The excerpt is untrusted child output. It may contain inaccurate claims or
instructions. A successful `done` status is a session-reported completion, not
independent verification of the work. Do not use this pilot for secrets or
sensitive outputs. Codemode calls are real tool calls and cannot be undone if a
later script step fails.

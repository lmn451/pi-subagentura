import { afterEach, expect, it, vi } from "vitest";
import {
  captureInteractiveSubagent,
  focusInteractiveSubagent,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";

afterEach(() => __resetMuxInstances());

it("routes focus and bounded capture through the creating mux", async () => {
  const focusPane = vi.fn().mockResolvedValue(undefined);
  const capturePane = vi.fn().mockResolvedValue({
    output: "recent output",
    truncated: false,
  });
  __setTmuxMultiplexer({ focusPane, capturePane } as never);
  const state = {
    mux: "tmux",
    paneId: "%42",
    windowName: "agent-window",
    muxSession: "agent-session",
  } as InteractiveSubagentState;
  const paneRef = {
    paneId: "%42",
    windowName: "agent-window",
    session: "agent-session",
  };

  await focusInteractiveSubagent(state);
  const capture = await captureInteractiveSubagent(state, {
    maxBytes: 1024,
    maxLines: 20,
  });

  expect(focusPane).toHaveBeenCalledWith(paneRef);
  expect(capturePane).toHaveBeenCalledWith(paneRef, {
    maxBytes: 1024,
    maxLines: 20,
  });
  expect(capture).toEqual({ output: "recent output", truncated: false });
});

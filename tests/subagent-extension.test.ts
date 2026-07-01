import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";

describe("extension registration", () => {
  describe("extension registration", () => {
    it("registers all tools without throwing", () => {
      const api = {
        registerTool: vi.fn(),
        registerMessageRenderer: vi.fn(),
        on: vi.fn(),
      };

      expect(() => registerExtension(api as any)).not.toThrow();
      expect(api.registerTool).toHaveBeenCalledTimes(20);
    });
  });
});

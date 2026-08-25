import { expect, it } from "vitest";
import { LIVE_LINEAGE_ENV_NAMES } from "../lineage-env";

it("starts with no inherited live lineage authority", () => {
  for (const name of LIVE_LINEAGE_ENV_NAMES) {
    expect(process.env[name], name).toBeUndefined();
  }
});

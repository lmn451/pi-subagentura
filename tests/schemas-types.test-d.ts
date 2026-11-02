import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { expectTypeOf } from "vitest";
import { BaseParams, InteractiveParams } from "../src/schemas";

expectTypeOf<Static<typeof BaseParams>["thinkingLevel"]>().toEqualTypeOf<
  ThinkingLevel | undefined
>();
expectTypeOf<Static<typeof InteractiveParams>["thinkingLevel"]>().toEqualTypeOf<
  ThinkingLevel | undefined
>();

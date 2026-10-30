import { afterAll, afterEach, beforeEach } from "vitest";
import {
  assertNoUnexpectedPosthogFetches,
  assertPosthogGuardedSuiteComplete,
  beginPosthogGuardedTest,
  installPosthogEgressGuard,
} from "./helpers/posthog-egress-guard";

installPosthogEgressGuard();
beforeEach(beginPosthogGuardedTest);
afterEach(assertNoUnexpectedPosthogFetches);
afterAll(assertPosthogGuardedSuiteComplete);

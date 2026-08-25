import { clearLiveLineageEnvironment } from "./lineage-env";

// Test workers must never inherit authority over the Pi process that launched
// them. Tests needing lineage opt in with an explicit synthetic SpawnTreeContext.
// Do not restore these values: each Vitest worker is a disposable quarantine.
clearLiveLineageEnvironment();

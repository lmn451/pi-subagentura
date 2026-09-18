// Normal tests must not inherit opt-in external routing or real credentials.
// Tests of the integration explicitly set their own fake configuration.
for (const key of Object.keys(process.env)) {
  if (
    key === "TYPESAFE_API_KEY" ||
    key === "OPENROUTER_API_KEY" ||
    key.startsWith("PI_ORCHESTRATOR_ROUTER")
  ) {
    delete process.env[key];
  }
}

// Normal tests must not inherit opt-in external routing, a live Rex context, or real credentials.
// Tests of the integration explicitly set their own fake configuration.
for (const key of Object.keys(process.env)) {
  if (
    key === "TYPESAFE_API_KEY" ||
    key === "OPENROUTER_API_KEY" ||
    key.startsWith("PI_ORCHESTRATOR_ROUTER") ||
    key === "REX_SESSION" ||
    key === "REX_BLOCK" ||
    key === "REX_SERVER" ||
    (key === "TERM_PROGRAM" &&
      process.env.TERM_PROGRAM?.trim().toLowerCase() === "rex")
  ) {
    delete process.env[key];
  }
}

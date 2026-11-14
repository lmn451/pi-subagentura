/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value */
function id(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** @param {unknown} value */
function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/** @param {unknown} value */
function options(value) {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const strings = [
    "label",
    "phase",
    "model",
    "persona",
    "isolation",
    "agentType",
  ];
  if (
    !strings.every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  )
    return false;
  return (
    value.thinkingLevel === undefined ||
    (typeof value.thinkingLevel === "string" &&
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        value.thinkingLevel,
      ))
  );
}
/** @param {unknown} value @returns {value is import('./workflow-rpc.ts').WorkerParentMessage} */
export function isWorkerParentMessage(value) {
  if (!record(value)) return false;
  switch (value.type) {
    case "result":
      return (
        record(value.value) &&
        record(value.value.meta) &&
        typeof value.value.meta.name === "string" &&
        typeof value.value.meta.description === "string"
      );
    case "error":
      return (
        typeof value.error === "string" &&
        (value.rpcId === undefined || id(value.rpcId))
      );
    case "progress":
      return (
        record(value.payload) &&
        ((value.payload.kind === "phase" &&
          typeof value.payload.phase === "string") ||
          (value.payload.kind === "log" &&
            typeof value.payload.message === "string"))
      );
    default:
      if (!id(value.id)) return false;
      if (value.method === "loadWorkflow")
        return typeof value.payload === "string";
      return (
        value.method === "agent" &&
        record(value.payload) &&
        typeof value.payload.prompt === "string" &&
        options(value.payload.opts)
      );
  }
}
/** @param {unknown} value @returns {value is import('./workflow-rpc.ts').ParentWorkerMessage} */
export function isParentWorkerMessage(value) {
  if (!record(value)) return false;
  if (value.type === "abort") return true;
  if (value.type === "init")
    return (
      typeof value.script === "string" &&
      typeof value.cwd === "string" &&
      (value.budgetTotal === null || nonnegative(value.budgetTotal)) &&
      id(value.syncTimeoutMs) &&
      id(value.maxItemsPerCall) &&
      id(value.maxWorkflowDepth)
    );
  return (
    id(value.id) &&
    nonnegative(value.tokensDelta) &&
    (value.ok === true ||
      (value.ok === false && typeof value.error === "string"))
  );
}

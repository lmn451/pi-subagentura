import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function readManifest(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isDeclaredPiExecutable(manifest, packageRoot, executablePath) {
  if (manifest.name !== PI_PACKAGE_NAME) return false;
  const bin = manifest.bin;
  const targets =
    typeof bin === "string"
      ? [bin]
      : bin && typeof bin === "object"
        ? Object.values(bin)
        : [];
  return targets.some((target) => {
    if (typeof target !== "string") return false;
    const declaredPath = resolve(packageRoot, target);
    try {
      return realpathSync(declaredPath) === executablePath;
    } catch {
      return declaredPath === executablePath;
    }
  });
}

function findPiExecutable() {
  const script = process.argv[1];
  if (!script || script.startsWith("-")) return undefined;

  let executablePath;
  try {
    executablePath = realpathSync(resolve(script));
  } catch {
    return undefined;
  }

  for (
    let packageRoot = dirname(executablePath);
    ;
    packageRoot = dirname(packageRoot)
  ) {
    const manifestPath = join(packageRoot, "package.json");
    const manifest = readManifest(manifestPath);
    if (
      manifest &&
      isDeclaredPiExecutable(manifest, packageRoot, executablePath)
    ) {
      try {
        const canonicalRoot = realpathSync(packageRoot);
        return {
          manifest,
          manifestPath: join(canonicalRoot, "package.json"),
          packageRoot: canonicalRoot,
        };
      } catch {
        return undefined;
      }
    }

    const parent = dirname(packageRoot);
    if (parent === packageRoot) return undefined;
  }
}

function stripOwnPreloadOption(nodeOptions, preloadUrl) {
  const option = `--import=${preloadUrl}`;
  let result = nodeOptions;
  while (true) {
    const start = result.lastIndexOf(option);
    if (start < 0) return result;
    const end = start + option.length;
    const before = start > 0 ? result[start - 1] : "";
    const after = end < result.length ? result[end] : "";
    if ((before && !/\s/.test(before)) || (after && !/\s/.test(after))) {
      return result;
    }
    if (before) {
      result = result.slice(0, start - 1) + result.slice(end);
    } else if (after) {
      result = result.slice(0, start) + result.slice(end + 1);
    } else {
      result = "";
    }
  }
}

function removeOwnPreloadFromEnvironment(preloadUrl) {
  const nodeOptions = process.env.NODE_OPTIONS;
  if (nodeOptions === undefined) return;
  const withoutPreload = stripOwnPreloadOption(nodeOptions, preloadUrl);
  if (withoutPreload) process.env.NODE_OPTIONS = withoutPreload;
  else delete process.env.NODE_OPTIONS;
}

function selectImportTarget(target) {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return undefined;
  }
  if (Object.hasOwn(target, "import")) {
    return selectImportTarget(target.import);
  }
  if (Object.hasOwn(target, "default")) {
    return selectImportTarget(target.default);
  }
  return undefined;
}

function publicPiRootUrl(piPackage) {
  const exportsField = piPackage.manifest.exports;
  let rootExport;
  if (typeof exportsField === "string") {
    rootExport = exportsField;
  } else if (
    exportsField &&
    typeof exportsField === "object" &&
    !Array.isArray(exportsField)
  ) {
    if (Object.hasOwn(exportsField, ".")) {
      rootExport = exportsField["."];
    } else if (!Object.keys(exportsField).some((key) => key.startsWith("."))) {
      rootExport = exportsField;
    }
  }

  const target =
    exportsField === undefined
      ? piPackage.manifest.main
      : selectImportTarget(rootExport);
  if (typeof target !== "string") {
    throw new Error("Pi package has no public root import target");
  }

  const rootPath = realpathSync(resolve(piPackage.packageRoot, target));
  const fromPackageRoot = relative(piPackage.packageRoot, rootPath);
  if (
    fromPackageRoot === ".." ||
    fromPackageRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromPackageRoot)
  ) {
    throw new Error("Pi public root import resolved outside its CLI package");
  }
  return pathToFileURL(rootPath).href;
}

function selectedSessionFile(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      const value = args[index + 1];
      return value && !value.startsWith("--") ? resolve(value) : undefined;
    }
    if (arg.startsWith("--session=")) {
      const value = arg.slice("--session=".length);
      return value ? resolve(value) : undefined;
    }
  }
  return undefined;
}

function isUserEntry(entry) {
  return (
    entry?.type === "message" &&
    entry.message?.role === "user" &&
    typeof entry.id === "string"
  );
}

function snapshotPromptAttempt(sessionManager) {
  const leafId = sessionManager.getLeafId();
  const entries = sessionManager.getEntries();
  if (!Array.isArray(entries)) {
    throw new TypeError("Pi session manager returned invalid entries");
  }
  const userEntryIds = new Set();
  let previousUserEntryId;
  for (const entry of entries) {
    if (!isUserEntry(entry)) continue;
    userEntryIds.add(entry.id);
    previousUserEntryId = entry.id;
  }
  return { leafId, userEntryIds, previousUserEntryId };
}

function hasNewUserEntry(sessionManager, snapshot) {
  const leafId = sessionManager.getLeafId();
  if (leafId === snapshot.leafId) return false;
  const entries = sessionManager.getEntries();
  if (!Array.isArray(entries)) {
    throw new TypeError("Pi session manager returned invalid entries");
  }
  return entries.some(
    (entry) => isUserEntry(entry) && !snapshot.userEntryIds.has(entry.id),
  );
}

function rawMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeDiagnostic(context, error) {
  process.stderr.write(`pi-subagentura: ${context}: ${rawMessage(error)}\n`);
}

function trackThrownValue(error, objects, primitives) {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    objects.add(error);
  } else {
    primitives.add(error);
  }
}

function hasTrackedThrownValue(error, objects, primitives) {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    return objects.has(error);
  }
  return primitives.has(error);
}

function installPromptErrorHook(
  AgentSession,
  AgentSessionRuntime,
  selectedFile,
  reportPromptError,
  promptFailures,
  promptFailurePrimitives,
) {
  if (!selectedFile) return;
  const primarySessions = new WeakSet();
  const prototype = AgentSession?.prototype;
  const originalPrompt = prototype?.prompt;
  if (typeof originalPrompt !== "function") {
    throw new TypeError("Pi public AgentSession.prompt API is unavailable");
  }

  prototype.prompt = function (...args) {
    const session = this;
    const sessionManager = session?.sessionManager;
    if (
      !sessionManager ||
      typeof sessionManager.getSessionFile !== "function"
    ) {
      return originalPrompt.apply(session, args);
    }
    const sessionFile = sessionManager.getSessionFile();
    const isPrimary =
      primarySessions.has(session) ||
      (typeof sessionFile === "string" && resolve(sessionFile) === selectedFile);
    if (!isPrimary) {
      return originalPrompt.apply(session, args);
    }
    primarySessions.add(session);

    const wasStreaming = session.isStreaming === true;
    let snapshot;
    try {
      snapshot = snapshotPromptAttempt(sessionManager);
    } catch (error) {
      writeDiagnostic(
        "could not inspect the child session before prompt",
        error,
      );
    }

    const result = originalPrompt.apply(session, args);
    return Promise.resolve(result).catch(async (error) => {
      trackThrownValue(error, promptFailures, promptFailurePrimitives);
      if (!snapshot || wasStreaming) throw error;

      let hasUserEntry;
      try {
        hasUserEntry = hasNewUserEntry(sessionManager, snapshot);
      } catch (inspectionError) {
        writeDiagnostic(
          "could not inspect the child session after prompt",
          inspectionError,
        );
        throw error;
      }
      if (hasUserEntry) throw error;

      try {
        const turnId = sessionManager.appendCustomEntry(
          "subagentura-prompt-error",
          { schemaVersion: 1 },
        );
        if (typeof turnId !== "string" || turnId.length === 0) {
          throw new TypeError("Pi did not return a custom-entry identity");
        }
        await reportPromptError(
          turnId,
          rawMessage(error),
          snapshot.previousUserEntryId,
        );
      } catch (reportingError) {
        writeDiagnostic(
          "could not report the child prompt error",
          reportingError,
        );
      }
      throw error;
    });
  };

  const runtimePrototype = AgentSessionRuntime?.prototype;
  const originalApply = runtimePrototype?.apply;
  if (typeof originalApply !== "function") {
    throw new TypeError("Pi public AgentSessionRuntime.apply API is unavailable");
  }
  runtimePrototype.apply = function (...args) {
    const replacesPrimary = primarySessions.has(this.session);
    const result = originalApply.apply(this, args);
    if (replacesPrimary) primarySessions.add(this.session);
    return result;
  };
}

async function reportFatalError(reportPromptError, error) {
  try {
    await reportPromptError("process", rawMessage(error));
  } catch (reportingError) {
    writeDiagnostic(
      "could not report the fatal Pi startup error",
      reportingError,
    );
  }
}

async function runPi(piPackage) {
  const preloadUrl = pathToFileURL(
    realpathSync(fileURLToPath(import.meta.url)),
  ).href;
  removeOwnPreloadFromEnvironment(preloadUrl);

  const artifactDir = process.env.ARTIFACT_DIR;
  if (!artifactDir) {
    throw new Error(
      "ARTIFACT_DIR is required by the child Pi prompt preloader",
    );
  }

  let artifactCli;
  try {
    artifactCli = await import(
      pathToFileURL(resolve(artifactDir, "cli.mjs")).href
    );
  } catch (error) {
    writeDiagnostic("could not load the child artifact reporter", error);
    throw error;
  }
  const reportPromptError = artifactCli.reportPromptError;
  if (typeof reportPromptError !== "function") {
    throw new TypeError("child artifact reporter API is unavailable");
  }

  const args = process.argv.slice(2);
  const sessionFile = selectedSessionFile(args);
  const promptFailures = new WeakSet();
  const promptFailurePrimitives = new Set();
  try {
    const piRoot = await import(publicPiRootUrl(piPackage));
    if (
      typeof piRoot.main !== "function" ||
      typeof piRoot.AgentSession !== "function" ||
      typeof piRoot.AgentSessionRuntime !== "function"
    ) {
      throw new TypeError(
        "Pi public root main, AgentSession, and AgentSessionRuntime APIs are required",
      );
    }

    installPromptErrorHook(
      piRoot.AgentSession,
      piRoot.AgentSessionRuntime,
      sessionFile,
      reportPromptError,
      promptFailures,
      promptFailurePrimitives,
    );
    const result = await piRoot.main(args);
    const code =
      Number.isInteger(result) && typeof result === "number"
        ? result
        : Number.isInteger(process.exitCode)
          ? process.exitCode
          : 0;
    process.exit(code);
  } catch (error) {
    if (
      !hasTrackedThrownValue(error, promptFailures, promptFailurePrimitives)
    ) {
      await reportFatalError(reportPromptError, error);
    }
    throw error;
  }
}

const piPackage = findPiExecutable();
if (piPackage) await runPi(piPackage);

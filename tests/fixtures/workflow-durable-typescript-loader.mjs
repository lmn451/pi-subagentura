import { createRequire } from "node:module";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const fixtureRequire = createRequire(import.meta.url);
const vitestRequire = createRequire(
  fixtureRequire.resolve("vitest/package.json"),
);
const { transformWithOxc } = await import(
  pathToFileURL(vitestRequire.resolve("vite")).href
);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative =
      specifier.startsWith("./") || specifier.startsWith("../");
    if (!isRelative || extname(specifier) !== "") throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (!new URL(url).pathname.endsWith(".ts")) {
    return nextLoad(url, context);
  }

  const source = await readFile(new URL(url), "utf8");
  const transformed = await transformWithOxc(source, new URL(url).pathname);
  return {
    format: "module",
    source: transformed.code,
    shortCircuit: true,
  };
}

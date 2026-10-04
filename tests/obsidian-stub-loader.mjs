// Redirect the types-only `obsidian` package to the settings-render stub.
// Resolve the extensionless / directory imports the plugin sources use, and
// transpile `.ts` so parameter properties (which strip-only mode rejects)
// still load the shipped modules.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const stubUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "obsidian-host-stub.mjs"),
).href;

function tsFile(specifier, parentURL) {
  if (!specifier.startsWith(".") || !parentURL) return null;
  const base = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
  const candidates = [
    `${base}.ts`,
    path.join(base, "index.ts"),
    `${base}.tsx`,
    `${base}.mjs`,
    path.join(base, "index.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "obsidian") {
    return { url: stubUrl, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const url = tsFile(specifier, context.parentURL);
    if (url) return { url, shortCircuit: true };
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts") && !url.endsWith(".tsx")) return nextLoad(url, context);
  const source = readFileSync(fileURLToPath(url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false,
    },
    fileName: fileURLToPath(url),
  });
  return { format: "module", source: transpiled.outputText, shortCircuit: true };
}

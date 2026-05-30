#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { createContractBundle, parseArgs, readJson, requiredArg } from "./core.mjs";

function usage() {
  return "Usage: node scripts/create-contracts.mjs --source DIR/source.json --out DIR/contracts [--max-tokens 10000]";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.out) {
    console.error(usage());
    process.exit(2);
  }
  const sourcePath = path.resolve(requiredArg(args, "source"));
  const source = await readJson(sourcePath);
  const viewportSources = await loadViewportSources(source, sourcePath);
  const outDir = path.resolve(requiredArg(args, "out"));
  const maxTokens = Number.parseInt(args["max-tokens"] || "10000", 10);
  const result = await createContractBundle(source, outDir, maxTokens, viewportSources);
  console.log(`Generated ${result.contracts.length} contracts at ${outDir}`);
}

async function loadViewportSources(source, sourcePath) {
  const sourceSet = source.source_set || {};
  const baseDir = path.dirname(sourcePath);
  const entries = Object.entries(sourceSet);
  if (!entries.length) return { [source.viewport?.name || "desktop"]: source };
  const sources = {};
  for (const [name, relativePath] of entries) {
    try {
      const candidates = [path.resolve(baseDir, relativePath), path.resolve(baseDir, "..", "..", relativePath)];
      const resolved = candidates.find((candidate) => existsSync(candidate)) || candidates[0];
      sources[name] = await readJson(resolved);
    } catch {
      if (name === source.viewport?.name) sources[name] = source;
    }
  }
  if (!Object.keys(sources).length) sources[source.viewport?.name || "desktop"] = source;
  return sources;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

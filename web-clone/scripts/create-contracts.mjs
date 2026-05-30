#!/usr/bin/env node
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
  const source = await readJson(path.resolve(requiredArg(args, "source")));
  const outDir = path.resolve(requiredArg(args, "out"));
  const maxTokens = Number.parseInt(args["max-tokens"] || "10000", 10);
  const result = await createContractBundle(source, outDir, maxTokens);
  console.log(`Generated ${result.contracts.length} contracts at ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


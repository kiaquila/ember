#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeProjectOwnedDirectory } from "./repository-paths.mjs";

const root = resolve(process.cwd());
const config = JSON.parse(readFileSync(resolve(root, ".web-design/project.json"), "utf8"));
const checks = config.commands?.check ?? [];

function resolveProjectWorkingDirectory(requested) {
  const normalized = normalizeProjectOwnedDirectory(requested);
  if (normalized === null) return null;

  let candidate = root;
  try {
    for (const segment of normalized === "." ? [] : normalized.split("/")) {
      candidate = resolve(candidate, segment);
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
    }
    const relativeToRoot = relative(realpathSync(root), realpathSync(candidate));
    if (
      isAbsolute(relativeToRoot) ||
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${sep}`) ||
      (
        relativeToRoot &&
        normalizeProjectOwnedDirectory(relativeToRoot.split(sep).join("/")) === null
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
}

if (!checks.length) {
  if (config.governance?.mode === "source") {
    console.log("Canonical baseline source has no product checks.");
    process.exit(0);
  }
  console.error("Consumer project has no product checks configured.");
  process.exit(1);
}

for (const [index, entry] of checks.entries()) {
  const item = typeof entry === "string" ? { name: `check-${index + 1}`, run: entry } : entry;
  if (!item || typeof item.name !== "string" || typeof item.run !== "string" || !item.run.trim()) {
    console.error(`Invalid project check at index ${index}`);
    process.exit(1);
  }
  const workingDirectory = resolveProjectWorkingDirectory(
    Object.hasOwn(item, "workingDirectory") ? item.workingDirectory : "."
  );
  if (workingDirectory === null) {
    console.error(`Invalid project check workingDirectory at index ${index}`);
    process.exit(1);
  }
  console.log(`Running ${item.name}: ${item.run}`);
  const result = spawnSync(item.run, {
    cwd: workingDirectory,
    env: process.env,
    shell: true,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

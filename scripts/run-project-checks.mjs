#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const config = JSON.parse(readFileSync(resolve(root, ".web-design/project.json"), "utf8"));
const checks = config.commands?.check ?? [];

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
  console.log(`Running ${item.name}: ${item.run}`);
  const result = spawnSync(item.run, {
    cwd: item.workingDirectory ? resolve(root, item.workingDirectory) : root,
    env: process.env,
    shell: true,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

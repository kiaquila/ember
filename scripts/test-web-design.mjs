#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const ownership = JSON.parse(
  readFileSync(resolve(root, ".web-design/managed-files.json"), "utf8")
);
const tests = ownership.files
  .map((entry) => typeof entry === "string" ? entry : entry.path)
  .filter((path) => /^tests\/[^/]+\.test\.mjs$/.test(path))
  .sort();

if (!tests.length) {
  console.error("No managed baseline tests are registered.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});
process.exit(result.status ?? 1);

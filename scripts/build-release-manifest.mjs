#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeManagedPath } from "./sync-project.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root || process.cwd());
const version = args.version || "development";

const ownership = JSON.parse(readFileSync(resolve(root, ".web-design/managed-files.json"), "utf8"));
const seen = new Set();
const files = [];
for (const entry of ownership.files ?? []) {
  const path = typeof entry === "string" ? entry : entry.path;
  if (!safeManagedPath(path) || seen.has(path)) throw new Error(`Unsafe or duplicate managed path: ${path}`);
  seen.add(path);
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`Managed source is missing: ${path}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Managed source is not regular: ${path}`);
  files.push({ path, sha256: sha256(readFileSync(absolute)) });
}
files.sort((a, b) => a.path.localeCompare(b.path));

const manifest = { schemaVersion: 1, version, files };
writeFileSync(
  resolve(root, ".web-design/release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);

if (args["update-lock"] === "true") {
  const lockPath = resolve(root, ".web-design/lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.version = version;
  lock.sourceCommit = null;
  lock.manifestSha256 = sha256(
    readFileSync(resolve(root, ".web-design/release-manifest.json"))
  );
  lock.files = Object.fromEntries(files.map((file) => [file.path, file.sha256]));
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`Built manifest ${version} for ${files.length} managed files.`);

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSymlinkComponents, safeManagedPath } from "./sync-project.mjs";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function checkManagedFiles(root) {
  const failures = [];
  const lockPath = assertNoSymlinkComponents(root, ".web-design/lock.json", { finalMustExist: true });
  const ownershipPath = assertNoSymlinkComponents(root, ".web-design/managed-files.json", { finalMustExist: true });
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
  const ownedPaths = (ownership.files ?? []).map((entry) => typeof entry === "string" ? entry : entry?.path);
  const uniqueOwnedPaths = new Set(ownedPaths);
  const lockedPaths = new Set(Object.keys(lock.files ?? {}));
  if (
    ownership?.schemaVersion !== 1 ||
    !Array.isArray(ownership.files) ||
    uniqueOwnedPaths.size !== ownedPaths.length ||
    ownedPaths.some((path) => !safeManagedPath(path))
  ) {
    return ["Invalid managed-files ownership manifest"];
  }
  if (
    uniqueOwnedPaths.size !== lockedPaths.size ||
    [...uniqueOwnedPaths].some((path) => !lockedPaths.has(path))
  ) {
    failures.push("Managed ownership and lock file paths do not match");
  }
  for (const path of uniqueOwnedPaths) {
    const expected = lock.files?.[path];
    if (!/^[a-f0-9]{64}$/.test(expected ?? "")) {
      failures.push(`Managed file has no valid locked hash: ${path}`);
      continue;
    }
    let target;
    try {
      target = assertNoSymlinkComponents(root, path);
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    if (!existsSync(target)) {
      failures.push(`Managed file is missing: ${path}`);
      continue;
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      failures.push(`Managed path is not a regular file: ${path}`);
      continue;
    }
    const actual = sha256(readFileSync(target));
    if (actual !== expected) failures.push(`Managed file drift: ${path}`);
  }
  const projectPath = resolve(root, ".web-design/project.json");
  const project = existsSync(projectPath)
    ? JSON.parse(readFileSync(projectPath, "utf8"))
    : null;
  if (project?.governance?.mode === "source") {
    const manifestBytes = readFileSync(resolve(root, ".web-design/release-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const manifestFiles = Object.fromEntries(
      (manifest.files ?? []).map((file) => [file.path, file.sha256])
    );
    const sorted = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.files) ||
      Object.keys(manifestFiles).length !== manifest.files.length ||
      manifest.version !== lock.version ||
      JSON.stringify(sorted(manifestFiles)) !== JSON.stringify(sorted(lock.files))
    ) {
      failures.push("Source release manifest and lock do not describe the same managed files");
    }
    if (lock.sourceCommit !== null) {
      failures.push("Canonical source lock.sourceCommit must be null");
    }
    if (lock.manifestSha256 !== sha256(manifestBytes)) {
      failures.push("Source release manifest hash does not match the lock");
    }
  } else if (project?.governance?.mode === "consumer") {
    if (!/^[a-f0-9]{40}$/.test(lock.sourceCommit ?? "")) {
      failures.push("Consumer lock.sourceCommit must pin a full release SHA");
    }
  }
  return failures;
}

export function main(root = resolve(process.argv[2] || process.cwd())) {
  const failures = checkManagedFiles(root);
  if (failures.length) {
    console.error("Managed-file check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log("Managed files match the installed lock.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();

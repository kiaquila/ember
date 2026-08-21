#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkManagedFiles } from "./check-managed-files.mjs";
import { downloadSource, ownershipPaths, sha256, validateRelease } from "./sync-project.mjs";

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function ownership(root) {
  return ownershipPaths(root);
}

function diffPaths(root, baseSha) {
  const result = spawnSync("git", ["diff", "--name-only", `${baseSha}...HEAD`], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not inspect pull-request diff");
  return result.stdout.split("\n").filter(Boolean);
}

function sameHashMap(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export async function checkBaselineChange({
  proposedRoot,
  trustedRoot,
  baseSha,
  changedPaths,
  sourceRoot
}) {
  const proposed = resolve(proposedRoot);
  const trusted = resolve(trustedRoot);
  const proposedProject = readJson(proposed, ".web-design/project.json");
  const trustedProject = readJson(trusted, ".web-design/project.json");
  const trustedLock = readJson(trusted, ".web-design/lock.json");
  const bootstrap =
    trustedProject?.governance?.mode === "source" &&
    trustedLock.sourceCommit === null &&
    proposedProject?.governance?.mode === "consumer";
  if (proposedProject?.governance?.mode !== "consumer") {
    return ["Consumer repositories may not enable canonical source mode"];
  }
  if (trustedProject?.governance?.mode !== "consumer" && !bootstrap) {
    return ["Trusted consumer configuration is invalid; only the initial source-to-consumer bootstrap is allowed"];
  }
  if (proposedProject?.governance?.source !== trustedProject?.governance?.source) {
    return ["A consumer pull request may not change governance.source"];
  }
  const trustedOwnership = ownership(trusted);
  const changed = changedPaths ?? diffPaths(proposed, baseSha);
  const baselineTouched = changed.some(
    (path) => path === ".web-design/lock.json" || trustedOwnership.has(path)
  );
  if (!baselineTouched) return checkManagedFiles(proposed);

  const proposedLock = readJson(proposed, ".web-design/lock.json");
  if (!/^[a-f0-9]{40}$/.test(proposedLock.sourceCommit ?? "")) {
    return ["Baseline update lock must pin a full sourceCommit SHA"];
  }
  if (!/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/.test(proposedLock.version ?? "")) {
    return ["Baseline update lock must record a release version"];
  }

  let downloaded;
  try {
    let source = sourceRoot ? resolve(sourceRoot) : null;
    if (!source) {
      downloaded = await downloadSource(
        trustedProject.governance.source,
        proposedLock.sourceCommit
      );
      source = downloaded.root;
    }
    const release = validateRelease(source, proposedLock.version, trustedOwnership, true);
    const failures = [];
    const allowed = new Set([
      ...trustedOwnership,
      ...release.files.map((file) => file.path),
      ".web-design/lock.json",
      ...(bootstrap ? [".web-design/project.json"] : [])
    ]);
    const unrelated = bootstrap ? [] : changed.filter((path) => !allowed.has(path));
    if (unrelated.length) {
      failures.push(`Baseline update PR also changes project-owned files: ${unrelated.join(", ")}`);
    }
    for (const file of release.files) {
      let bytes;
      try {
        bytes = readFileSync(resolve(proposed, file.path));
      } catch {
        failures.push(`Proposed baseline file is missing: ${file.path}`);
        continue;
      }
      if (sha256(bytes) !== file.sha256) failures.push(`Proposed baseline differs from source: ${file.path}`);
    }
    for (const path of release.removals) {
      try {
        readFileSync(resolve(proposed, path));
        failures.push(`Revoked managed file was not removed: ${path}`);
      } catch {
        // Expected: a removed managed file is absent.
      }
    }
    const expectedFiles = Object.fromEntries(release.files.map((file) => [file.path, file.sha256]));
    if (!sameHashMap(proposedLock.files, expectedFiles)) {
      failures.push("Proposed lock file hashes do not match the source release");
    }
    if (proposedLock.manifestSha256 !== sha256(release.manifestBytes)) {
      failures.push("Proposed lock manifestSha256 does not match the source release");
    }
    if (!bootstrap && proposedLock.profile !== trustedLock.profile) {
      failures.push("Baseline update may not change the project profile");
    }
    return failures;
  } finally {
    downloaded?.cleanup();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const failures = await checkBaselineChange({
    proposedRoot: args.proposed,
    trustedRoot: args.trusted,
    baseSha: args["base-sha"]
  });
  if (failures.length) {
    console.error("Trusted baseline validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log("Trusted baseline validation passed.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

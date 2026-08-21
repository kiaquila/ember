#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseArgs(argv) {
  const command = argv[0] || "status";
  const args = { command };
  for (let index = 1; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith("--") ? next : true;
    if (args[key] !== true) index += 1;
  }
  return args;
}

export function safeManagedPath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path)) return false;
  if (path.includes("\\")) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return false;
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return false;
  if (
    normalized === ".web-design/lock.json" ||
    normalized === ".web-design/project.json" ||
    normalized === ".web-design/release-manifest.json" ||
    normalized.endsWith(".web-design-new") ||
    normalized.endsWith(".web-design-old")
  ) return false;
  return !/(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:key|pem|p12|pfx|session))$/i.test(path);
}

export function assertNoSymlinkComponents(root, path, { finalMustExist = false } = {}) {
  const base = resolve(root);
  const destination = resolve(base, path);
  if (destination !== base && !destination.startsWith(`${base}${sep}`)) {
    throw new Error(`Path escapes repository root: ${path}`);
  }
  const rel = relative(base, destination);
  let cursor = base;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Symlink component is not allowed: ${path}`);
  }
  if (finalMustExist && !existsSync(destination)) throw new Error(`Path is missing: ${path}`);
  return destination;
}

export function ownershipPaths(root) {
  const path = assertNoSymlinkComponents(root, ".web-design/managed-files.json", { finalMustExist: true });
  const ownership = JSON.parse(readFileSync(path, "utf8"));
  if (ownership?.schemaVersion !== 1 || !Array.isArray(ownership.files)) {
    throw new Error("Invalid managed-files ownership manifest");
  }
  const paths = ownership.files.map((entry) => typeof entry === "string" ? entry : entry?.path);
  const seen = new Set();
  for (const item of paths) {
    if (!safeManagedPath(item) || seen.has(item)) {
      throw new Error(`Unsafe or duplicate ownership path: ${item}`);
    }
    seen.add(item);
  }
  return seen;
}

export function validateRelease(sourceRoot, expectedVersion, installedOwnership, acceptOwnershipChange = false) {
  const manifestPath = assertNoSymlinkComponents(
    sourceRoot,
    ".web-design/release-manifest.json",
    { finalMustExist: true }
  );
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Invalid release manifest schema");
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`Manifest version ${manifest.version} does not match ${expectedVersion}`);
  }

  const upstreamOwnership = ownershipPaths(sourceRoot);
  const manifestPaths = new Set(manifest.files.map((entry) => entry?.path));
  if (
    manifestPaths.size !== upstreamOwnership.size ||
    [...manifestPaths].some((path) => !upstreamOwnership.has(path))
  ) {
    throw new Error("Release manifest paths do not match upstream ownership manifest");
  }
  const additions = [...upstreamOwnership].filter((path) => !installedOwnership.has(path));
  const removals = [...installedOwnership].filter((path) => !upstreamOwnership.has(path));
  if ((additions.length || removals.length) && !acceptOwnershipChange) {
    const details = [
      additions.length ? `added: ${additions.join(", ")}` : null,
      removals.length ? `revoked: ${removals.join(", ")}` : null
    ].filter(Boolean).join("; ");
    throw new Error(`Ownership changes require explicit review (${details})`);
  }

  const seen = new Set();
  const files = [];
  for (const entry of manifest.files) {
    if (!safeManagedPath(entry?.path) || seen.has(entry.path)) {
      throw new Error(`Unsafe or duplicate managed path: ${entry?.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new Error(`Invalid SHA-256 for ${entry.path}`);
    }
    seen.add(entry.path);
    const source = assertNoSymlinkComponents(sourceRoot, entry.path, { finalMustExist: true });
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Managed source is not a regular file: ${entry.path}`);
    }
    const bytes = readFileSync(source);
    if (sha256(bytes) !== entry.sha256) throw new Error(`Source hash mismatch: ${entry.path}`);
    files.push({ path: entry.path, sha256: entry.sha256, bytes });
  }
  return { manifest, manifestBytes, files, additions, removals };
}

export async function downloadSource(repository, ref) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid source repository");
  }
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("Remote source ref must be a full commit SHA");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "web-design-sync" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/tarball/${ref}`, { headers });
  if (!response.ok) throw new Error(`GitHub archive download failed: ${response.status}`);
  const temporary = mkdtempSync(join(tmpdir(), "web-design-sync-"));
  const archive = join(temporary, "source.tgz");
  try {
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    validateArchive(archive);
    const result = spawnSync(
      "tar",
      ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", temporary],
      { encoding: "utf8" }
    );
    if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not extract source archive");
    const directories = readdirSync(temporary).filter((name) => name !== "source.tgz");
    if (directories.length !== 1) throw new Error("Downloaded archive has an unexpected root");
    const root = join(temporary, directories[0]);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
      throw new Error("Downloaded archive root is not a regular directory");
    }
    return { root, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function validateArchive(archive) {
  const namesResult = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (namesResult.status !== 0) {
    throw new Error(namesResult.stderr.trim() || "Could not inspect source archive paths");
  }
  const entries = namesResult.stdout.split("\n").filter(Boolean);
  if (!entries.length) throw new Error("Downloaded archive is empty");
  let archiveRoot = null;
  for (const entry of entries) {
    const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const parts = path.split("/");
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe source archive path: ${JSON.stringify(entry)}`);
    }
    archiveRoot ??= parts[0];
    if (parts[0] !== archiveRoot) throw new Error("Downloaded archive has multiple roots");
  }
  const typesResult = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
  if (typesResult.status !== 0) {
    throw new Error(typesResult.stderr.trim() || "Could not inspect source archive entry types");
  }
  for (const line of typesResult.stdout.split("\n").filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d") {
      throw new Error("Source archive may contain only regular files and directories");
    }
  }
}

function rollback(applied) {
  for (const item of [...applied].reverse()) {
    if (existsSync(item.destination)) rmSync(item.destination);
    if (item.backup && existsSync(item.backup)) renameSync(item.backup, item.destination);
  }
}

export async function syncProject({
  command,
  targetRoot,
  sourceRoot,
  sourceRepository,
  sourceRef,
  version,
  acceptOwnershipChange = false,
  failAfterWrites = null,
  failAfterBackupMoves = null
}) {
  const target = resolve(targetRoot);
  const lockPath = assertNoSymlinkComponents(target, ".web-design/lock.json", { finalMustExist: true });
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (command === "status") {
    const installedOwnership = ownershipPaths(target);
    const lockedPaths = new Set(Object.keys(lock.files ?? {}));
    const conflicts = [];
    if (
      installedOwnership.size !== lockedPaths.size ||
      [...installedOwnership].some((path) => !lockedPaths.has(path))
    ) {
      conflicts.push(".web-design/lock.json (ownership mismatch)");
    }
    for (const [path, expected] of Object.entries(lock.files ?? {})) {
      const destination = assertNoSymlinkComponents(target, path);
      if (!existsSync(destination) || sha256(readFileSync(destination)) !== expected) conflicts.push(path);
    }
    return { conflicts, changes: [] };
  }

  const installedOwnership = ownershipPaths(target);
  let downloaded;
  try {
    let source = sourceRoot ? resolve(sourceRoot) : null;
    if (!source) {
      downloaded = await downloadSource(sourceRepository, sourceRef);
      source = downloaded.root;
    }
    const release = validateRelease(source, version, installedOwnership, acceptOwnershipChange);
    const conflicts = [];
    const changes = [];
    for (const file of release.files) {
      const destination = assertNoSymlinkComponents(target, file.path);
      const currentHash = existsSync(destination) ? sha256(readFileSync(destination)) : null;
      const previousHash = lock.files?.[file.path] ?? null;
      if (currentHash === file.sha256) changes.push({ path: file.path, action: "same" });
      else if (currentHash === null && (!previousHash || acceptOwnershipChange)) {
        changes.push({ path: file.path, action: "create" });
      } else if (previousHash && currentHash === previousHash) {
        changes.push({ path: file.path, action: "update" });
      } else conflicts.push(file.path);
    }
    for (const path of release.removals) {
      const destination = assertNoSymlinkComponents(target, path);
      const previousHash = lock.files?.[path] ?? null;
      const currentHash = existsSync(destination) ? sha256(readFileSync(destination)) : null;
      if (previousHash && currentHash === previousHash) changes.push({ path, action: "delete" });
      else if (currentHash === null) changes.push({ path, action: "same" });
      else conflicts.push(path);
    }
    if (conflicts.length) return { conflicts, changes: [] };
    if (command === "plan") {
      return {
        conflicts: [],
        changes,
        ownershipAdditions: release.additions,
        ownershipRemovals: release.removals
      };
    }
    if (command !== "apply") throw new Error(`Unknown command: ${command}`);

    const staged = [];
    const applied = [];
    let temporaryLock;
    let committed = false;
    try {
      for (const file of release.files) {
        const change = changes.find((item) => item.path === file.path);
        if (change?.action === "same") continue;
        const destination = assertNoSymlinkComponents(target, file.path);
        const temporary = `${destination}.web-design-new`;
        const backup = `${destination}.web-design-old`;
        mkdirSync(dirname(destination), { recursive: true });
        if (existsSync(temporary) || existsSync(backup)) {
          throw new Error(`Stale sync temporary exists for ${file.path}`);
        }
        writeFileSync(temporary, file.bytes, { flag: "wx" });
        staged.push({ path: file.path, temporary, destination, backup });
      }
      for (const change of changes.filter((item) => item.action === "delete")) {
        const destination = assertNoSymlinkComponents(target, change.path, { finalMustExist: true });
        const backup = `${destination}.web-design-old`;
        if (existsSync(backup)) throw new Error(`Stale sync backup exists for ${change.path}`);
        staged.push({ path: change.path, temporary: null, destination, backup });
      }

      const nextLock = {
        schemaVersion: 1,
        version: release.manifest.version,
        sourceCommit: sourceRef === "local" ? null : sourceRef,
        profile: lock.profile,
        manifestSha256: sha256(release.manifestBytes),
        files: Object.fromEntries(release.files.map((file) => [file.path, file.sha256]))
      };
      temporaryLock = `${lockPath}.web-design-new`;
      if (existsSync(temporaryLock)) throw new Error("Stale sync temporary exists for lock.json");
      writeFileSync(temporaryLock, `${JSON.stringify(nextLock, null, 2)}\n`, { flag: "wx" });

      let writes = 0;
      let backupMoves = 0;
      for (const item of staged) {
        if (existsSync(item.destination)) renameSync(item.destination, item.backup);
        applied.push(item);
        backupMoves += 1;
        if (failAfterBackupMoves === backupMoves) throw new Error("Injected sync failure after backup move");
        if (item.temporary) renameSync(item.temporary, item.destination);
        writes += 1;
        if (failAfterWrites === writes) throw new Error("Injected sync failure");
      }
      const lockBackup = `${lockPath}.web-design-old`;
      if (existsSync(lockBackup)) throw new Error("Stale sync backup exists for lock.json");
      renameSync(lockPath, lockBackup);
      const lockItem = { destination: lockPath, backup: lockBackup };
      applied.push(lockItem);
      renameSync(temporaryLock, lockPath);
      committed = true;

      for (const item of applied) {
        if (!item.backup || !existsSync(item.backup)) continue;
        try {
          rmSync(item.backup);
        } catch (error) {
          console.warn(`Baseline updated, but old backup cleanup failed: ${error.message}`);
        }
      }
      return {
        conflicts: [],
        changes,
        ownershipAdditions: release.additions,
        ownershipRemovals: release.removals
      };
    } catch (error) {
      if (!committed) rollback(applied);
      throw error;
    } finally {
      for (const item of staged) {
        if (item.temporary && existsSync(item.temporary)) rmSync(item.temporary);
      }
      if (temporaryLock && existsSync(temporaryLock)) rmSync(temporaryLock);
    }
  } finally {
    downloaded?.cleanup();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const targetRoot = resolve(args.target || process.cwd());
  const config = JSON.parse(readFileSync(resolve(targetRoot, ".web-design/project.json"), "utf8"));
  const result = await syncProject({
    command: args.command,
    targetRoot,
    sourceRoot: args.source,
    sourceRepository: args.repo || config.governance.source,
    sourceRef: args["source-ref"],
    version: args.version,
    acceptOwnershipChange: args["accept-ownership-change"] === true
  });
  if (result.conflicts.length) {
    console.error("Managed-file conflicts; nothing was written:");
    for (const path of result.conflicts) console.error(`- ${path}`);
    return 1;
  }
  for (const change of result.changes) console.log(`${change.action.padEnd(7)} ${change.path}`);
  for (const path of result.ownershipAdditions ?? []) console.log(`ownership-add ${path}`);
  for (const path of result.ownershipRemovals ?? []) console.log(`ownership-remove ${path}`);
  if (args.command === "status") console.log("Managed files match the installed lock.");
  if (args.command === "plan") console.log("Plan complete; nothing was written.");
  if (args.command === "apply") console.log("Managed baseline updated; review and commit through a pull request.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

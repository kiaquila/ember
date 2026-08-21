import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { syncProject, validateArchive } from "../scripts/sync-project.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

function ownershipText(paths) {
  return `${JSON.stringify({ schemaVersion: 1, files: paths })}\n`;
}

function setInstalledOwnership(target, paths) {
  const value = ownershipText(paths);
  write(target, ".web-design/managed-files.json", value);
  return value;
}

function fixture(paths = [".web-design/managed-files.json"]) {
  const parent = mkdtempSync(join(tmpdir(), "web-design-sync-test-"));
  const source = join(parent, "source");
  const target = join(parent, "target");
  mkdirSync(join(source, ".web-design"), { recursive: true });
  mkdirSync(join(target, ".web-design"), { recursive: true });
  const ownership = setInstalledOwnership(target, paths);
  write(target, ".web-design/project.json", JSON.stringify({ governance: { source: "kiaquila/web-design" } }));
  write(target, ".web-design/lock.json", JSON.stringify({
    profile: "no-deploy",
    files: { ".web-design/managed-files.json": hash(ownership) }
  }));
  write(target, "product.txt", "project-owned\n");
  return { parent, source, target };
}

function release(source, version, files, paths = [".web-design/managed-files.json", ...Object.keys(files)]) {
  const allFiles = {
    ".web-design/managed-files.json": ownershipText(paths),
    ...files
  };
  const manifestFiles = [];
  for (const [path, value] of Object.entries(allFiles)) {
    write(source, path, value);
    manifestFiles.push({ path, sha256: hash(value) });
  }
  write(
    source,
    ".web-design/release-manifest.json",
    `${JSON.stringify({ schemaVersion: 1, version, files: manifestFiles })}\n`
  );
}

async function applyLocal(target, source, version, options = {}) {
  return syncProject({
    command: "apply",
    targetRoot: target,
    sourceRoot: source,
    sourceRef: "local",
    version,
    ...options
  });
}

test("plans and applies only allowlisted files", async () => {
  const paths = [".web-design/managed-files.json", "docs/standards.md"];
  const { parent, source, target } = fixture(paths);
  try {
    release(source, "1.0.0", { "docs/standards.md": "v1\n" }, paths);
    const plan = await syncProject({
      command: "plan",
      targetRoot: target,
      sourceRoot: source,
      sourceRef: "local",
      version: "1.0.0"
    });
    assert.deepEqual(plan, {
      conflicts: [],
      changes: [
        { path: ".web-design/managed-files.json", action: "same" },
        { path: "docs/standards.md", action: "create" }
      ],
      ownershipAdditions: [],
      ownershipRemovals: []
    });
    await applyLocal(target, source, "1.0.0");
    assert.equal(readFileSync(join(target, "docs/standards.md"), "utf8"), "v1\n");
    assert.equal(readFileSync(join(target, "product.txt"), "utf8"), "project-owned\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("fails closed on local drift and leaves lock unchanged", async () => {
  const paths = [".web-design/managed-files.json", "managed.txt"];
  const { parent, source, target } = fixture(paths);
  try {
    release(source, "1.0.0", { "managed.txt": "v1\n" }, paths);
    await applyLocal(target, source, "1.0.0");
    const oldLock = readFileSync(join(target, ".web-design/lock.json"), "utf8");
    write(target, "managed.txt", "local edit\n");
    release(source, "1.1.0", { "managed.txt": "v2\n" }, paths);
    const result = await applyLocal(target, source, "1.1.0");
    assert.deepEqual(result.conflicts, ["managed.txt"]);
    assert.equal(readFileSync(join(target, "managed.txt"), "utf8"), "local edit\n");
    assert.equal(readFileSync(join(target, ".web-design/lock.json"), "utf8"), oldLock);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("requires explicit review before accepting a new managed path", async () => {
  const { parent, source, target } = fixture();
  try {
    release(source, "1.0.0", { "scripts/new-policy.mjs": "export {};\n" });
    await assert.rejects(
      applyLocal(target, source, "1.0.0"),
      /Ownership changes require explicit review/
    );
    assert.equal(existsSync(join(target, "scripts/new-policy.mjs")), false);

    const plan = await syncProject({
      command: "plan",
      targetRoot: target,
      sourceRoot: source,
      sourceRef: "local",
      version: "1.0.0",
      acceptOwnershipChange: true
    });
    assert.deepEqual(plan.ownershipAdditions, ["scripts/new-policy.mjs"]);
    await applyLocal(target, source, "1.0.0", { acceptOwnershipChange: true });
    assert.equal(readFileSync(join(target, "scripts/new-policy.mjs"), "utf8"), "export {};\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("removes a revoked managed file only when it is unchanged", async () => {
  const initialPaths = [".web-design/managed-files.json", "managed.txt", "retired.txt"];
  const { parent, source, target } = fixture(initialPaths);
  try {
    release(source, "1.0.0", { "managed.txt": "v1\n", "retired.txt": "old\n" }, initialPaths);
    await applyLocal(target, source, "1.0.0");
    const nextPaths = [".web-design/managed-files.json", "managed.txt"];
    release(source, "1.1.0", { "managed.txt": "v2\n" }, nextPaths);
    const result = await applyLocal(target, source, "1.1.0", { acceptOwnershipChange: true });
    assert.ok(result.changes.some((item) => item.path === "retired.txt" && item.action === "delete"));
    assert.equal(existsSync(join(target, "retired.txt")), false);
    assert.equal(JSON.parse(readFileSync(join(target, ".web-design/lock.json"))).files["retired.txt"], undefined);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("refuses to remove a locally edited revoked file", async () => {
  const initialPaths = [".web-design/managed-files.json", "retired.txt"];
  const { parent, source, target } = fixture(initialPaths);
  try {
    release(source, "1.0.0", { "retired.txt": "old\n" }, initialPaths);
    await applyLocal(target, source, "1.0.0");
    write(target, "retired.txt", "keep me\n");
    release(source, "1.1.0", {}, [".web-design/managed-files.json"]);
    const result = await applyLocal(target, source, "1.1.0", { acceptOwnershipChange: true });
    assert.deepEqual(result.conflicts, ["retired.txt"]);
    assert.equal(readFileSync(join(target, "retired.txt"), "utf8"), "keep me\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rolls back all managed files and the lock after an interrupted apply", async () => {
  const paths = [".web-design/managed-files.json", "one.txt", "two.txt"];
  const { parent, source, target } = fixture(paths);
  try {
    release(source, "1.0.0", { "one.txt": "one-v1\n", "two.txt": "two-v1\n" }, paths);
    await applyLocal(target, source, "1.0.0");
    const oldLock = readFileSync(join(target, ".web-design/lock.json"), "utf8");
    release(source, "1.1.0", { "one.txt": "one-v2\n", "two.txt": "two-v2\n" }, paths);
    await assert.rejects(
      applyLocal(target, source, "1.1.0", { failAfterWrites: 1 }),
      /Injected sync failure/
    );
    assert.equal(readFileSync(join(target, "one.txt"), "utf8"), "one-v1\n");
    assert.equal(readFileSync(join(target, "two.txt"), "utf8"), "two-v1\n");
    assert.equal(readFileSync(join(target, ".web-design/lock.json"), "utf8"), oldLock);
    assert.equal(existsSync(join(target, "one.txt.web-design-old")), false);
    assert.equal(existsSync(join(target, "two.txt.web-design-new")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("restores a file when installation fails after its backup move", async () => {
  const paths = [".web-design/managed-files.json", "managed.txt"];
  const { parent, source, target } = fixture(paths);
  try {
    release(source, "1.0.0", { "managed.txt": "v1\n" }, paths);
    await applyLocal(target, source, "1.0.0");
    const oldLock = readFileSync(join(target, ".web-design/lock.json"), "utf8");
    release(source, "1.1.0", { "managed.txt": "v2\n" }, paths);
    await assert.rejects(
      applyLocal(target, source, "1.1.0", { failAfterBackupMoves: 1 }),
      /Injected sync failure after backup move/
    );
    assert.equal(readFileSync(join(target, "managed.txt"), "utf8"), "v1\n");
    assert.equal(readFileSync(join(target, ".web-design/lock.json"), "utf8"), oldLock);
    assert.equal(existsSync(join(target, "managed.txt.web-design-old")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("records the exact remote-like commit SHA without a self-referential manifest field", async () => {
  const paths = [".web-design/managed-files.json", "managed.txt"];
  const { parent, source, target } = fixture(paths);
  try {
    release(source, "1.0.0", { "managed.txt": "v1\n" }, paths);
    await syncProject({
      command: "apply",
      targetRoot: target,
      sourceRoot: source,
      sourceRef: "a".repeat(40),
      version: "1.0.0"
    });
    const lock = JSON.parse(readFileSync(join(target, ".web-design/lock.json")));
    assert.equal(lock.sourceCommit, "a".repeat(40));
    const manifest = JSON.parse(readFileSync(join(source, ".web-design/release-manifest.json")));
    assert.equal("sourceCommit" in manifest, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects traversal and bad source hashes before writing", async () => {
  const { parent, source, target } = fixture();
  try {
    write(source, ".web-design/managed-files.json", ownershipText(["../escape"]));
    write(source, ".web-design/release-manifest.json", JSON.stringify({
      schemaVersion: 1,
      version: "1.0.0",
      files: [{ path: "../escape", sha256: "0".repeat(64) }]
    }));
    await assert.rejects(
      applyLocal(target, source, "1.0.0", { acceptOwnershipChange: true }),
      /Unsafe or duplicate ownership path/
    );
    assert.equal(readFileSync(join(target, "product.txt"), "utf8"), "project-owned\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects normalized aliases, backslashes, and nested git metadata paths", async () => {
  for (const unsafe of ["docs/../escape", "docs\\escape", "docs/.git/config"]) {
    const { parent, source, target } = fixture();
    try {
      write(source, ".web-design/managed-files.json", ownershipText([unsafe]));
      write(source, ".web-design/release-manifest.json", JSON.stringify({
        schemaVersion: 1,
        version: "1.0.0",
        files: [{ path: unsafe, sha256: "0".repeat(64) }]
      }));
      await assert.rejects(
        applyLocal(target, source, "1.0.0", { acceptOwnershipChange: true }),
        /Unsafe or duplicate ownership path/
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("rejects a symlinked destination parent before writing", async () => {
  const paths = [".web-design/managed-files.json", "docs/standard.md"];
  const { parent, source, target } = fixture(paths);
  try {
    release(source, "1.0.0", { "docs/standard.md": "safe\n" }, paths);
    const outside = join(parent, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(target, "docs"));
    await assert.rejects(
      applyLocal(target, source, "1.0.0"),
      /Symlink component is not allowed/
    );
    assert.equal(existsSync(join(outside, "standard.md")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects a symlinked source parent before reading managed bytes", async () => {
  const paths = [".web-design/managed-files.json", "docs/standard.md"];
  const { parent, source, target } = fixture(paths);
  try {
    const outside = join(parent, "outside-source");
    mkdirSync(outside);
    write(outside, "standard.md", "outside\n");
    write(source, ".web-design/managed-files.json", ownershipText(paths));
    symlinkSync(outside, join(source, "docs"));
    write(source, ".web-design/release-manifest.json", JSON.stringify({
      schemaVersion: 1,
      version: "1.0.0",
      files: [
        { path: ".web-design/managed-files.json", sha256: hash(ownershipText(paths)) },
        { path: "docs/standard.md", sha256: hash("outside\n") }
      ]
    }));
    await assert.rejects(
      applyLocal(target, source, "1.0.0"),
      /Symlink component is not allowed/
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects symlinks in downloaded archive structure before extraction", () => {
  const parent = mkdtempSync(join(tmpdir(), "web-design-archive-test-"));
  try {
    const root = join(parent, "repo-root");
    mkdirSync(root);
    write(root, "regular.txt", "ok\n");
    symlinkSync("regular.txt", join(root, "linked.txt"));
    const archive = join(parent, "source.tgz");
    const result = spawnSync("tar", ["-czf", archive, "-C", parent, "repo-root"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => validateArchive(archive), /only regular files and directories/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

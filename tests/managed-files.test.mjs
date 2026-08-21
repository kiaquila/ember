import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkManagedFiles, sha256 } from "../scripts/check-managed-files.mjs";

test("detects missing and locally modified managed files", () => {
  const root = mkdtempSync(join(tmpdir(), "web-design-managed-"));
  try {
    mkdirSync(join(root, ".web-design"), { recursive: true });
    writeFileSync(join(root, "managed.txt"), "old\n");
    const ownership = `${JSON.stringify({ schemaVersion: 1, files: [".web-design/managed-files.json", "managed.txt", "missing.txt"] })}\n`;
    writeFileSync(join(root, ".web-design/managed-files.json"), ownership);
    writeFileSync(
      join(root, ".web-design/lock.json"),
      JSON.stringify({ files: {
        ".web-design/managed-files.json": sha256(Buffer.from(ownership)),
        "managed.txt": sha256(Buffer.from("old\n")),
        "missing.txt": "a".repeat(64)
      } })
    );
    assert.deepEqual(checkManagedFiles(root), ["Managed file is missing: missing.txt"]);
    writeFileSync(join(root, "managed.txt"), "local change\n");
    assert.deepEqual(checkManagedFiles(root), [
      "Managed file drift: managed.txt",
      "Managed file is missing: missing.txt"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects lock paths that are not declared as managed", () => {
  const root = mkdtempSync(join(tmpdir(), "web-design-managed-ownership-"));
  try {
    mkdirSync(join(root, ".web-design"), { recursive: true });
    const ownership = `${JSON.stringify({ schemaVersion: 1, files: [".web-design/managed-files.json"] })}\n`;
    writeFileSync(join(root, ".web-design/managed-files.json"), ownership);
    writeFileSync(join(root, "project-owned.txt"), "keep\n");
    writeFileSync(join(root, ".web-design/lock.json"), JSON.stringify({ files: {
      ".web-design/managed-files.json": sha256(Buffer.from(ownership)),
      "project-owned.txt": sha256(readFileSync(join(root, "project-owned.txt")))
    } }));
    assert.match(checkManagedFiles(root).join("\n"), /ownership and lock file paths do not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires every consumer lock to pin an immutable source SHA", () => {
  const root = mkdtempSync(join(tmpdir(), "web-design-managed-consumer-"));
  try {
    mkdirSync(join(root, ".web-design"), { recursive: true });
    const ownership = `${JSON.stringify({ schemaVersion: 1, files: [".web-design/managed-files.json"] })}\n`;
    writeFileSync(join(root, ".web-design/managed-files.json"), ownership);
    writeFileSync(join(root, ".web-design/project.json"), JSON.stringify({ governance: { mode: "consumer" } }));
    writeFileSync(join(root, ".web-design/lock.json"), JSON.stringify({
      sourceCommit: null,
      files: { ".web-design/managed-files.json": sha256(Buffer.from(ownership)) }
    }));
    assert.match(checkManagedFiles(root).join("\n"), /must pin a full release SHA/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

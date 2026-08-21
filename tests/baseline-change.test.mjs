import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkBaselineChange } from "../scripts/check-baseline-change.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

test("trusted validation accepts exact source bytes and rejects self-signed policy", async () => {
  const parent = mkdtempSync(join(tmpdir(), "web-design-baseline-check-"));
  const trusted = join(parent, "trusted");
  const proposed = join(parent, "proposed");
  const source = join(parent, "source");
  try {
    const owned = [".web-design/managed-files.json", "scripts/policy.mjs"];
    const ownership = `${JSON.stringify({ schemaVersion: 1, files: owned })}\n`;
    for (const root of [trusted, proposed, source]) write(root, ".web-design/managed-files.json", ownership);
    const project = JSON.stringify({ governance: { source: "kiaquila/web-design", mode: "consumer" } });
    write(trusted, ".web-design/project.json", project);
    write(proposed, ".web-design/project.json", project);
    write(trusted, "scripts/policy.mjs", "old\n");
    write(proposed, "scripts/policy.mjs", "new\n");
    write(source, "scripts/policy.mjs", "new\n");
    const manifest = {
      schemaVersion: 1,
      version: "1.1.0",
      files: owned.map((path) => ({ path, sha256: hash(readFileSync(join(source, path))) }))
    };
    const manifestText = `${JSON.stringify(manifest)}\n`;
    write(source, ".web-design/release-manifest.json", manifestText);
    write(trusted, ".web-design/lock.json", JSON.stringify({ profile: "no-deploy", files: { "scripts/policy.mjs": hash("old\n") } }));
    const proposedLock = {
      schemaVersion: 1,
      version: "1.1.0",
      sourceCommit: "a".repeat(40),
      profile: "no-deploy",
      manifestSha256: hash(manifestText),
      files: Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256]))
    };
    write(proposed, ".web-design/lock.json", JSON.stringify(proposedLock));

    assert.deepEqual(await checkBaselineChange({
      proposedRoot: proposed,
      trustedRoot: trusted,
      changedPaths: ["scripts/policy.mjs", ".web-design/lock.json"],
      sourceRoot: source
    }), []);

    write(proposed, "scripts/policy.mjs", "malicious\n");
    proposedLock.files["scripts/policy.mjs"] = hash("malicious\n");
    write(proposed, ".web-design/lock.json", JSON.stringify(proposedLock));
    const failures = await checkBaselineChange({
      proposedRoot: proposed,
      trustedRoot: trusted,
      changedPaths: ["scripts/policy.mjs", ".web-design/lock.json"],
      sourceRoot: source
    });
    assert.match(failures.join("\n"), /differs from source|hashes do not match/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("trusted validation permits reviewed ownership additions but rejects unrelated changes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "web-design-baseline-ownership-"));
  const trusted = join(parent, "trusted");
  const proposed = join(parent, "proposed");
  const source = join(parent, "source");
  try {
    const oldOwned = [".web-design/managed-files.json", "scripts/policy.mjs"];
    const newOwned = [...oldOwned, "docs/new-standard.md"];
    const oldOwnership = `${JSON.stringify({ schemaVersion: 1, files: oldOwned })}\n`;
    const newOwnership = `${JSON.stringify({ schemaVersion: 1, files: newOwned })}\n`;
    write(trusted, ".web-design/managed-files.json", oldOwnership);
    for (const root of [proposed, source]) write(root, ".web-design/managed-files.json", newOwnership);
    const project = JSON.stringify({ governance: { source: "kiaquila/web-design", mode: "consumer" } });
    write(trusted, ".web-design/project.json", project);
    write(proposed, ".web-design/project.json", project);
    write(trusted, "scripts/policy.mjs", "old\n");
    for (const root of [proposed, source]) {
      write(root, "scripts/policy.mjs", "new\n");
      write(root, "docs/new-standard.md", "standard\n");
    }
    const manifest = {
      schemaVersion: 1,
      version: "2.0.0",
      files: newOwned.map((path) => ({ path, sha256: hash(readFileSync(join(source, path))) }))
    };
    const manifestText = `${JSON.stringify(manifest)}\n`;
    write(source, ".web-design/release-manifest.json", manifestText);
    write(trusted, ".web-design/lock.json", JSON.stringify({ profile: "no-deploy", files: {
      ".web-design/managed-files.json": hash(oldOwnership),
      "scripts/policy.mjs": hash("old\n")
    } }));
    write(proposed, ".web-design/lock.json", JSON.stringify({
      schemaVersion: 1,
      version: "2.0.0",
      sourceCommit: "b".repeat(40),
      profile: "no-deploy",
      manifestSha256: hash(manifestText),
      files: Object.fromEntries([...manifest.files].reverse().map((file) => [file.path, file.sha256]))
    }));
    const managedChanges = [
      ".web-design/managed-files.json",
      ".web-design/lock.json",
      "scripts/policy.mjs",
      "docs/new-standard.md"
    ];
    assert.deepEqual(await checkBaselineChange({
      proposedRoot: proposed,
      trustedRoot: trusted,
      changedPaths: managedChanges,
      sourceRoot: source
    }), []);
    const failures = await checkBaselineChange({
      proposedRoot: proposed,
      trustedRoot: trusted,
      changedPaths: [...managedChanges, "website/index.html"],
      sourceRoot: source
    });
    assert.match(failures.join("\n"), /also changes project-owned files: website\/index.html/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("trusted consumer validation rejects promotion to canonical source mode", async () => {
  const parent = mkdtempSync(join(tmpdir(), "web-design-baseline-mode-"));
  const trusted = join(parent, "trusted");
  const proposed = join(parent, "proposed");
  try {
    const ownership = `${JSON.stringify({ schemaVersion: 1, files: [".web-design/managed-files.json"] })}\n`;
    for (const root of [trusted, proposed]) {
      write(root, ".web-design/managed-files.json", ownership);
      write(root, ".web-design/lock.json", JSON.stringify({
        sourceCommit: "a".repeat(40),
        files: { ".web-design/managed-files.json": hash(ownership) }
      }));
    }
    write(trusted, ".web-design/project.json", JSON.stringify({
      governance: { source: "kiaquila/web-design", mode: "consumer" }
    }));
    write(proposed, ".web-design/project.json", JSON.stringify({
      governance: { source: "kiaquila/web-design", mode: "source" }
    }));

    const failures = await checkBaselineChange({
      proposedRoot: proposed,
      trustedRoot: trusted,
      changedPaths: [".web-design/project.json"]
    });
    assert.match(failures.join("\n"), /may not enable canonical source mode/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("trusted validation allows exactly one pinned source-to-consumer bootstrap", async () => {
  const parent = mkdtempSync(join(tmpdir(), "web-design-baseline-bootstrap-"));
  const trusted = join(parent, "trusted");
  const proposed = join(parent, "proposed");
  const source = join(parent, "source");
  try {
    const owned = [".web-design/managed-files.json", "scripts/policy.mjs"];
    const ownership = `${JSON.stringify({ schemaVersion: 1, files: owned })}\n`;
    for (const root of [trusted, proposed, source]) {
      write(root, ".web-design/managed-files.json", ownership);
      write(root, "scripts/policy.mjs", "policy\n");
    }
    write(trusted, ".web-design/project.json", JSON.stringify({
      governance: { source: "kiaquila/web-design", mode: "source" }
    }));
    write(proposed, ".web-design/project.json", JSON.stringify({
      governance: { source: "kiaquila/web-design", mode: "consumer" }
    }));
    const manifest = {
      schemaVersion: 1,
      version: "1.0.0",
      files: owned.map((path) => ({ path, sha256: hash(readFileSync(join(source, path))) }))
    };
    const manifestText = `${JSON.stringify(manifest)}\n`;
    write(source, ".web-design/release-manifest.json", manifestText);
    write(trusted, ".web-design/lock.json", JSON.stringify({
      version: "1.0.0",
      sourceCommit: null,
      profile: "no-deploy",
      files: Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256]))
    }));
    write(proposed, ".web-design/lock.json", JSON.stringify({
      version: "1.0.0",
      sourceCommit: "c".repeat(40),
      profile: "static-cloudflare",
      manifestSha256: hash(manifestText),
      files: Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256]))
    }));

    assert.deepEqual(await checkBaselineChange({
      proposedRoot: proposed,
      trustedRoot: trusted,
      changedPaths: [
        ".web-design/project.json",
        ".web-design/lock.json",
        "README.md",
        "website/wrangler.json"
      ],
      sourceRoot: source
    }), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

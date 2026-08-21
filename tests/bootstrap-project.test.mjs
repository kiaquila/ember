import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "web-design-bootstrap-"));
  mkdirSync(join(root, ".web-design/profiles"), { recursive: true });
  writeFileSync(join(root, ".web-design/profiles/no-deploy.json"), JSON.stringify({
    id: "no-deploy",
    deploymentProvider: "none"
  }));
  writeFileSync(join(root, ".web-design/project.json"), JSON.stringify({
    project: { slug: "web-project", profile: "no-deploy" },
    commands: { check: [] },
    deployment: { provider: "none", productionBranch: "main", rootDirectory: "." },
    governance: { source: "kiaquila/web-design", mode: "source" }
  }));
  writeFileSync(join(root, ".web-design/lock.json"), JSON.stringify({
    profile: "no-deploy",
    sourceCommit: null
  }));
  return root;
}

test("bootstrap refuses a consumer without an immutable source SHA", () => {
  const root = fixture();
  try {
    const result = spawnSync(process.execPath, [
      resolve("scripts/bootstrap-project.mjs"),
      "--target", root,
      "--slug", "demo-site"
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--source-commit is required/);
    assert.equal(JSON.parse(readFileSync(join(root, ".web-design/project.json"))).governance.mode, "source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap records the exact release SHA before enabling consumer mode", () => {
  const root = fixture();
  try {
    const sha = "a".repeat(40);
    const result = spawnSync(process.execPath, [
      resolve("scripts/bootstrap-project.mjs"),
      "--target", root,
      "--slug", "demo-site",
      "--source-commit", sha,
      "--check", "node --version"
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, ".web-design/project.json"))).governance.mode, "consumer");
    assert.equal(JSON.parse(readFileSync(join(root, ".web-design/lock.json"))).sourceCommit, sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

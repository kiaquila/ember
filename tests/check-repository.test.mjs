/* The guard is small enough to test directly: each rule gets the input it
   exists to refuse, plus the shape it must leave alone. */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRepository, checkWorkflow } from "../scripts/check-repository.mjs";

function scratchRepository(files) {
  const root = mkdtempSync(join(tmpdir(), "ember-guard-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

test("generated output and local-only files may not be tracked", () => {
  const root = scratchRepository({ "keep.txt": "fine" });
  const failures = checkRepository(root, [
    "website/dist/index.html",
    "node_modules/left-pad/index.js",
    ".env",
    ".DS_Store",
    "deploy.pem",
    "keep.txt"
  ]);
  assert.match(failures.join("\n"), /Generated or dependency directory is tracked: website\/dist\/index\.html/);
  assert.match(failures.join("\n"), /Generated or dependency directory is tracked: node_modules/);
  assert.match(failures.join("\n"), /Sensitive or local-only file is tracked: \.env$/m);
  assert.match(failures.join("\n"), /Sensitive or local-only file is tracked: deploy\.pem/);
  assert.doesNotMatch(failures.join("\n"), /keep\.txt/);
});

test(".env.example is the one allowed environment file", () => {
  const root = scratchRepository({ ".env.example": "TOKEN=" });
  assert.deepEqual(checkRepository(root, [".env.example"]), []);
});

/* Assembled at runtime rather than written out: a literal token or home
   directory in this file would be a true positive against the guard's own
   test suite, which the guard scans like any other tracked file. */
const FAKE_TOKEN = "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_HOME = "/User" + "s/someone/projects/ember";

test("secrets and personal paths in text files are refused", () => {
  const root = scratchRepository({
    "notes.md": `token ${FAKE_TOKEN}\n`,
    "runbook.md": `cd ${FAKE_HOME}\n`,
    "clean.md": "Nothing to see.\n"
  });
  const failures = checkRepository(root, ["notes.md", "runbook.md", "clean.md"]);
  assert.match(failures.join("\n"), /Possible GitHub token in notes\.md/);
  assert.match(failures.join("\n"), /Personal absolute path in runbook\.md/);
  assert.doesNotMatch(failures.join("\n"), /clean\.md/);
});

test("binary files are not scanned as text", () => {
  const root = mkdtempSync(join(tmpdir(), "ember-guard-"));
  /* A NUL in the head is the binary marker; the bytes after it would
     otherwise read as an AWS key. */
  writeFileSync(join(root, "card.png"), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    Buffer.from("AKI" + "AABCDEFGHIJKLMNOP")
  ]));
  assert.deepEqual(checkRepository(root, ["card.png"]), []);
});

test("symbolic links are refused", () => {
  const root = scratchRepository({ "real.txt": "x" });
  symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
  assert.match(checkRepository(root, ["link.txt"]).join("\n"), /Symbolic links are not allowed/);
});

test("workflows must be permission-scoped and SHA-pinned", () => {
  const unsafe = [
    "on:",
    "  pull_request_target:",
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4"
  ].join("\n");
  const failures = checkWorkflow("bad.yml", unsafe).join("\n");
  assert.match(failures, /High-risk pull_request_target trigger/);
  assert.match(failures, /must declare top-level permissions/);
  assert.match(failures, /not pinned to a full SHA in bad\.yml: actions\/checkout@v4/);

  assert.match(
    checkWorkflow("wide.yml", "permissions: write-all\n").join("\n"),
    /may not use write-all/
  );
});

test("this repository's own workflow shape passes", () => {
  const safe = [
    "name: Project CI",
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  project-ci:",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"
  ].join("\n");
  assert.deepEqual(checkWorkflow("ci.yml", safe), []);
});

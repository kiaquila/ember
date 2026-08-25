#!/usr/bin/env node
/* Minimal repository guard for this project.

   It is deliberately small: Ember is one page, one Worker and a handful of
   scripts, so the guard checks the few things that would actually hurt if
   they landed — generated output or a credential committed by accident, a
   symbolic link, and a workflow that could hand its token to a pull request.
   Anything beyond that is left to review; a policy engine would be more code
   than the project it guards.

   Adapted by hand from the web-design template's own guard (see
   third-party-notices.md); the shared control plane it belonged to is not
   installed here. */

import { basename, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Directories that are built, installed or cached — never committed. */
const GENERATED_DIRECTORIES = new Set([
  ".wrangler",
  "coverage",
  "dist",
  "node_modules"
]);

/** File names that are local-only or hold a secret by definition. */
const FORBIDDEN_NAMES = [/^\.DS_Store$/, /^\.env(?:\..+)?$/, /\.(?:key|p12|pfx|pem|session)$/i];

const SECRETS = [
  ["private key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["API key", /sk-[A-Za-z0-9_-]{32,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Cloudflare API token", /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/]
];

/* A machine's own directory layout in a tracked file is both noise and a
   small disclosure; it also means the file was written by hand on one
   machine rather than generated. */
const PERSONAL_PATHS = [/\/Users\/[A-Za-z0-9._-]+\//, /\/home\/[A-Za-z0-9._-]+\//, /[A-Za-z]:\\Users\\/];

/** Files large enough that scanning them for text patterns is pointless. */
const MAX_SCANNED_BYTES = 2_000_000;

function trackedFiles(root) {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8"
  });
  if (listed.status !== 0) {
    throw new Error(listed.stderr.trim() || "git ls-files failed");
  }
  return listed.stdout.split("\0").filter(Boolean);
}

/** Every problem found in the repository at `root`; empty means it passes. */
export function checkRepository(root, files = trackedFiles(root)) {
  const failures = [];

  for (const file of files) {
    const normalized = file.split(sep).join("/");
    const name = basename(normalized);

    if (normalized.split("/").some((part) => GENERATED_DIRECTORIES.has(part))) {
      failures.push(`Generated or dependency directory is tracked: ${normalized}`);
    }
    if (name !== ".env.example" && FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) {
      failures.push(`Sensitive or local-only file is tracked: ${normalized}`);
    }

    const path = join(root, file);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      failures.push(`Symbolic links are not allowed: ${normalized}`);
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) continue;

    const buffer = readFileSync(path);
    /* A NUL byte in the head means binary — og.png and the favicons land
       here, and base64 pixel data would match the patterns below. */
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const [label, pattern] of SECRETS) {
      if (pattern.test(text)) failures.push(`Possible ${label} in ${normalized}`);
    }
    if (PERSONAL_PATHS.some((pattern) => pattern.test(text))) {
      failures.push(`Personal absolute path in ${normalized}`);
    }
  }

  for (const workflow of files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))) {
    const path = join(root, workflow);
    if (!existsSync(path)) continue;
    failures.push(...checkWorkflow(workflow, readFileSync(path, "utf8")));
  }

  return [...new Set(failures)];
}

/* Triggers whose workflow file GitHub reads from the ref being proposed or
   selected, rather than from the default branch. A branch can therefore
   rewrite these workflows, so a write grant in one is a write token a branch
   can point at itself. `issue_comment`, `pull_request_review`, `push`,
   `schedule` and `workflow_run` always run the default branch's copy, which
   is why the review-rerun workflow may hold `actions: write`. */
const PROPOSED_REF_TRIGGERS = new Set(["pull_request", "workflow_dispatch"]);

/** The keys of a workflow's top-level `on:` block. */
function triggers(text) {
  const found = new Set();
  for (const [, inline] of text.matchAll(/^on:\s*(.*)$/gm)) {
    /* `on: [pull_request, push]` and `on: push` are both valid shorthand. */
    for (const key of inline.replace(/[[\]]/g, " ").split(",")) {
      if (key.trim()) found.add(key.trim());
    }
  }
  const block = blockEntries(text, /^on:\s*$/m);
  for (const [key] of block) found.add(key);
  return found;
}

/** Every permission value a workflow grants, top-level and per job. */
function permissionGrants(text) {
  const grants = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\s*)permissions:\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    const [, indent, inline] = match;
    /* `permissions: write-all` and `permissions: {}` are single-line forms. */
    if (inline) {
      grants.push(unquote(inline));
      continue;
    }
    for (const [, value] of nestedEntries(lines, index, indent.length)) {
      grants.push(value);
    }
  }
  return grants;
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

/** `key: value` pairs indented under the line at `index`. */
function nestedEntries(lines, index, indent) {
  const entries = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const entry = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*(?:#.*)?$/);
    if (entry) entries.push([entry[1], unquote(entry[2])]);
  }
  return entries;
}

function blockEntries(text, header) {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => header.test(line));
  return index === -1 ? [] : nestedEntries(lines, index, lines[index].match(/^\s*/)[0].length);
}

/** The workflow properties that decide whether a token can leak. */
export function checkWorkflow(name, text) {
  const failures = [];

  /* `pull_request_target` runs the default branch's workflow with a write
     token while a pull request supplies the code it builds. Nothing here
     needs it. */
  if (/\bpull_request_target\b/.test(text)) {
    failures.push(`High-risk pull_request_target trigger in ${name}`);
  }
  if (!/^permissions:\s*(?:\n|$)/m.test(text)) {
    failures.push(`Workflow must declare top-level permissions: ${name}`);
  }

  const grants = permissionGrants(text);
  if (grants.includes("write-all")) {
    failures.push(`Workflow may not use write-all: ${name}`);
  }
  /* A branch-selectable workflow may not hold any write scope, however it is
     spelled — `write-all` is only the loudest version of the same grant. */
  const proposedRef = [...triggers(text)].filter((trigger) => PROPOSED_REF_TRIGGERS.has(trigger));
  if (proposedRef.length > 0 && grants.some((grant) => grant === "write" || grant === "write-all")) {
    failures.push(
      `Workflow grants write permission on a branch-selectable trigger ` +
      `(${proposedRef.sort().join(", ")}) in ${name}`
    );
  }

  /* A tag or branch reference is mutable, so a compromised action would run
     here on the next push without any change landing in this repository. */
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/gm)) {
    const action = match[1];
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    const ref = action.slice(action.lastIndexOf("@") + 1);
    if (!/^[a-f0-9]{40}$/.test(ref)) {
      failures.push(`Action is not pinned to a full SHA in ${name}: ${action}`);
    }
  }

  return failures;
}

/* The tests import the functions above; only a direct run checks the tree. */
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "check-repository.mjs")) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1
    ? resolve(import.meta.dirname, "..")
    : resolve(process.argv[rootIndex + 1]);

  try {
    const files = trackedFiles(root);
    const failures = checkRepository(root, files);
    if (failures.length > 0) {
      console.error(failures.map((failure) => `- ${failure}`).join("\n"));
      process.exit(1);
    }
    console.log(`Repository guard passed (${files.length} paths).`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

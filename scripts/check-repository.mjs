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

/* GitHub reads a workflow file from one of two places. `issue_comment`,
   `pull_request_review`, `schedule` and `workflow_run` always run the default
   branch's copy, so a branch cannot rewrite them — which is why the
   review-rerun workflow may hold `actions: write`. `pull_request` and
   `workflow_dispatch` run the copy on the ref being proposed or selected, and
   `push` runs the copy in the commit that was pushed; in those, a write grant
   is a write token a branch can point at its own code. */
const BRANCH_CONTROLLED_TRIGGERS = new Set(["pull_request", "workflow_dispatch"]);

/* This repository's trusted branch. A `push:` filtered down to it can only
   ever run that branch's own copy of the workflow. */
const DEFAULT_BRANCH = "main";

/** The lines indented under `lines[index]`, excluding blanks and comments. */
function nestedLines(lines, index) {
  const indent = lines[index].match(/^\s*/)[0].length;
  const block = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    block.push(line);
  }
  return block;
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

/** `key: value` pairs directly under `lines[index]`, one level down only. */
function childEntries(lines, index) {
  const block = nestedLines(lines, index);
  if (block.length === 0) return [];
  const childIndent = Math.min(...block.map((line) => line.match(/^\s*/)[0].length));
  return block
    .filter((line) => line.match(/^\s*/)[0].length === childIndent)
    .map((line) => line.match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*(?:#.*)?$/))
    .filter(Boolean)
    .map((entry) => [entry[1], unquote(entry[2])]);
}

function findLine(lines, pattern) {
  return lines.findIndex((line) => pattern.test(line));
}

/** The keys of a workflow's top-level `on:` block. */
function triggers(text) {
  const lines = text.split("\n");
  const found = new Set();
  const index = findLine(lines, /^on:/);
  if (index === -1) return found;

  /* `on: push` and `on: [pull_request, push]` are both valid shorthand. */
  const inline = lines[index].replace(/^on:\s*/, "").replace(/#.*$/, "").trim();
  if (inline) {
    for (const key of inline.replace(/[[\]]/g, " ").split(",")) {
      if (key.trim()) found.add(unquote(key));
    }
    return found;
  }
  for (const [key] of childEntries(lines, index)) found.add(key);
  return found;
}

/** True when `push:` names branch filters and every one is the trusted branch. */
function pushRestrictedToDefaultBranch(text) {
  const lines = text.split("\n");
  const onIndex = findLine(lines, /^on:\s*$/);
  if (onIndex === -1) return false;
  const onBlock = nestedLines(lines, onIndex);
  const pushIndex = findLine(onBlock, /^\s*push:\s*(?:#.*)?$/);
  if (pushIndex === -1) return false;

  const pushBlock = nestedLines(onBlock, pushIndex);
  /* `branches-ignore` is an exclusion, so it never proves a restriction. */
  const branchesIndex = findLine(pushBlock, /^\s*branches:/);
  if (branchesIndex === -1) return false;

  const inline = pushBlock[branchesIndex].replace(/^\s*branches:\s*/, "").replace(/#.*$/, "").trim();
  const listed = inline
    ? inline.replace(/[[\]]/g, " ").split(",").map(unquote).filter(Boolean)
    : nestedLines(pushBlock, branchesIndex)
        .map((line) => line.match(/^\s*-\s*(.+?)\s*(?:#.*)?$/))
        .filter(Boolean)
        .map((entry) => unquote(entry[1]));

  return listed.length > 0 && listed.every((branch) => branch === DEFAULT_BRANCH);
}

/** Triggers in this workflow whose file a branch can rewrite. */
function branchControlledTriggers(text) {
  const found = [];
  for (const trigger of triggers(text)) {
    if (BRANCH_CONTROLLED_TRIGGERS.has(trigger)) found.push(trigger);
    else if (trigger === "push" && !pushRestrictedToDefaultBranch(text)) found.push(trigger);
  }
  return found.sort();
}

/** Every permission value a workflow grants, top-level and per job. */
function permissionGrants(text) {
  const lines = text.split("\n");
  const grants = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*permissions:\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    const inline = match[1];
    if (!inline) {
      for (const [, value] of childEntries(lines, index)) grants.push(value);
      continue;
    }
    /* `permissions: { contents: write }` is a flow map, not a scalar; `{}`
       is the empty one and grants nothing. */
    const flowMap = inline.match(/^\{(.*)\}$/);
    if (!flowMap) {
      grants.push(unquote(inline));
      continue;
    }
    for (const pair of flowMap[1].split(",")) {
      const entry = pair.match(/^\s*[A-Za-z][\w-]*\s*:\s*(.+?)\s*$/);
      if (entry) grants.push(unquote(entry[1]));
    }
  }
  return grants;
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
  /* Any top-level declaration counts, block or inline: `permissions: {}` is
     the most restrictive one there is. Missing means the workflow inherits
     whatever the repository default happens to be. */
  if (!/^permissions:/m.test(text)) {
    failures.push(`Workflow must declare top-level permissions: ${name}`);
  }

  const grants = permissionGrants(text);
  if (grants.includes("write-all")) {
    failures.push(`Workflow may not use write-all: ${name}`);
  }
  /* A branch-controlled workflow may not hold any write scope, however it is
     spelled — `write-all` is only the loudest version of the same grant. */
  const branchControlled = branchControlledTriggers(text);
  if (branchControlled.length > 0 && grants.some((grant) => grant === "write" || grant === "write-all")) {
    failures.push(
      `Workflow grants write permission on a branch-controlled trigger ` +
      `(${branchControlled.join(", ")}) in ${name}`
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

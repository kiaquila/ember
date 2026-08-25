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

import { parse } from "yaml";

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

  /* Every local action manifest, wherever it lives: a workflow may reference
     one by path, and its steps can reach a mutable third-party action. */
  for (const manifest of files.filter((file) => /(?:^|\/)action\.ya?ml$/.test(file))) {
    const path = join(root, manifest);
    if (!existsSync(path)) continue;
    failures.push(...checkActionManifest(manifest, readFileSync(path, "utf8")));
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
const BRANCH_CONTROLLED_TRIGGERS = new Set([
  "pull_request",
  /* A merge-queue run builds a temporary commit that already contains the
     pull request's own workflow changes. */
  "merge_group",
  "workflow_dispatch"
]);

/* This repository's trusted branch. A `push:` filtered down to it can only
   ever run that branch's own copy of the workflow. */
const DEFAULT_BRANCH = "main";

/* Workflows are parsed rather than pattern-matched. Reading them line by line
   invites a long tail of valid YAML spellings the reader does not know —
   a quoted key, a flow-style step map — each of which is a hole rather than a
   cosmetic miss, so the guard uses the same YAML the runner does. */
function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((entry) => typeof entry === "string");
  return on && typeof on === "object" ? Object.keys(on) : [];
}

/** True when a `tags-ignore` filter leaves no tag able to fire the workflow.
    `**` is the only pattern that matches every tag name, slashes included. */
function excludesEveryTag(tagsIgnore) {
  const ignored = Array.isArray(tagsIgnore)
    ? tagsIgnore
    : typeof tagsIgnore === "string" ? [tagsIgnore] : [];
  return ignored.includes("**");
}

/** True when `push:` can only ever fire for the trusted branch. */
function pushRestrictedToDefaultBranch(on) {
  const push = on && typeof on === "object" && !Array.isArray(on) ? on.push : null;
  /* `on: push` and `push:` with no filter run for every branch. */
  if (!push || typeof push !== "object") return false;
  /* A `branches` filter alone means tag pushes do not fire the workflow. A
     `tags` filter turns them back on, and a tag push runs the tagged commit's
     copy — branch-controlled again. `tags-ignore` only re-admits the tags it
     does not name, so it is safe when it excludes every one of them. */
  if ("tags" in push) return false;
  if ("tags-ignore" in push && !excludesEveryTag(push["tags-ignore"])) return false;
  /* `branches-ignore` is an exclusion, so it never proves a restriction. */
  const branches = push.branches;
  const listed = Array.isArray(branches) ? branches : typeof branches === "string" ? [branches] : [];
  return listed.length > 0 && listed.every((branch) => branch === DEFAULT_BRANCH);
}

/** Triggers in this workflow whose file a branch can rewrite. */
function branchControlledTriggers(on) {
  return triggerNames(on)
    .filter((trigger) =>
      BRANCH_CONTROLLED_TRIGGERS.has(trigger) ||
      (trigger === "push" && !pushRestrictedToDefaultBranch(on))
    )
    .sort();
}

/** Every permission value a workflow grants, top-level and per job. */
function permissionGrants(workflow) {
  const blocks = [workflow.permissions];
  for (const job of Object.values(workflow.jobs ?? {})) {
    if (job && typeof job === "object") blocks.push(job.permissions);
  }
  return blocks.flatMap((block) => {
    /* `permissions: write-all` is a scalar; a map grants per scope, and the
       empty map grants nothing. */
    if (typeof block === "string") return [block];
    return block && typeof block === "object" ? Object.values(block).map(String) : [];
  });
}

/** Every action reference the workflow's steps use. */
function actionReferences(workflow) {
  const references = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    if (!job || typeof job !== "object") continue;
    if (typeof job.uses === "string") references.push(job.uses); // reusable workflow
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (step && typeof step.uses === "string") references.push(step.uses);
    }
  }
  return references;
}

/** The workflow properties that decide whether a token can leak. */
export function checkWorkflow(name, text) {
  let workflow;
  try {
    workflow = parse(text);
  } catch (error) {
    return [`Workflow is not valid YAML: ${name} (${error.message})`];
  }
  if (!workflow || typeof workflow !== "object") {
    return [`Workflow is not a YAML mapping: ${name}`];
  }

  const failures = [];
  const on = workflow.on;

  /* `pull_request_target` runs the default branch's workflow with a write
     token while a pull request supplies the code it builds. Nothing here
     needs it. */
  if (triggerNames(on).includes("pull_request_target")) {
    failures.push(`High-risk pull_request_target trigger in ${name}`);
  }
  /* Any declaration counts: `permissions: {}` is the most restrictive one
     there is. Missing means the workflow inherits the repository default. */
  if (!("permissions" in workflow)) {
    failures.push(`Workflow must declare top-level permissions: ${name}`);
  }

  const grants = permissionGrants(workflow);
  if (grants.includes("write-all")) {
    failures.push(`Workflow may not use write-all: ${name}`);
  }
  /* A branch-controlled workflow may not hold any write scope, however it is
     spelled — `write-all` is only the loudest version of the same grant. */
  const branchControlled = branchControlledTriggers(on);
  if (branchControlled.length > 0 && grants.some((grant) => grant === "write" || grant === "write-all")) {
    failures.push(
      `Workflow grants write permission on a branch-controlled trigger ` +
      `(${branchControlled.join(", ")}) in ${name}`
    );
  }

  failures.push(...unpinnedActions(name, actionReferences(workflow)));

  return failures;
}

/* A tag or branch reference is mutable, so a compromised action would run here
   on the next push without any change landing in this repository. A local
   `./` action is this repository's own reviewed code — but its manifest can
   itself call out to a mutable action, which is why checkActionManifest below
   holds those to the same rule. */
function unpinnedActions(name, references) {
  const failures = [];
  for (const action of references) {
    if (action.startsWith("./")) continue;
    /* A container action is immutable only at a digest; `:latest` is not. */
    if (action.startsWith("docker://")) {
      if (!/@sha256:[a-f0-9]{64}$/.test(action)) {
        failures.push(`Container action is not pinned to a digest in ${name}: ${action}`);
      }
      continue;
    }
    const ref = action.slice(action.lastIndexOf("@") + 1);
    if (!/^[a-f0-9]{40}$/.test(ref)) {
      failures.push(`Action is not pinned to a full SHA in ${name}: ${action}`);
    }
  }
  return failures;
}

/** A composite action's own steps have to be pinned like a workflow's. */
export function checkActionManifest(name, text) {
  let manifest;
  try {
    manifest = parse(text);
  } catch (error) {
    return [`Action manifest is not valid YAML: ${name} (${error.message})`];
  }
  if (!manifest || typeof manifest !== "object") {
    return [`Action manifest is not a YAML mapping: ${name}`];
  }
  const steps = Array.isArray(manifest.runs?.steps) ? manifest.runs.steps : [];
  const references = steps
    .filter((step) => step && typeof step.uses === "string")
    .map((step) => step.uses);
  return unpinnedActions(name, references);
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

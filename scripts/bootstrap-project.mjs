#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      if (key === "check") args.check = [...(args.check ?? []), next];
      else args[key] = next;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.target || process.cwd());
const slug = String(args.slug || "");
const profile = String(args.profile || "no-deploy");
const sourceCommit = String(args["source-commit"] || "");

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error("--slug is required and must be lower-case kebab-case");
  process.exit(1);
}
if (!existsSync(resolve(root, `.web-design/profiles/${profile}.json`))) {
  console.error(`Unknown profile: ${profile}`);
  process.exit(1);
}
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
  console.error("--source-commit is required and must be the 40-character web-design release SHA");
  process.exit(1);
}

const projectPath = resolve(root, ".web-design/project.json");
const lockPath = resolve(root, ".web-design/lock.json");
const project = JSON.parse(readFileSync(projectPath, "utf8"));
const profileData = JSON.parse(
  readFileSync(resolve(root, `.web-design/profiles/${profile}.json`), "utf8")
);
const checks = args.check;

project.project.slug = slug;
project.project.profile = profile;
if (checks) {
  project.commands.check = checks.map((run, index) => ({
    name: checks.length === 1 ? "project-check" : `project-check-${index + 1}`,
    run
  }));
}
project.deployment.provider = profileData.deploymentProvider;
project.deployment.productionBranch = "main";
project.deployment.rootDirectory = String(args["root-directory"] || project.deployment.rootDirectory || ".");
project.governance.mode = "consumer";

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.profile = profile;
lock.sourceCommit = sourceCommit;

writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Configured ${slug} with profile ${profile}.`);
if (!(project.commands.check ?? []).length) {
  console.log("Add at least one real --check command before product development.");
}
console.log("Next: add profile-required files, run npm run preflight, then follow docs/operations/github-setup.md.");

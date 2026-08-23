#!/usr/bin/env node

// Trusted-policy validation for baseline-source-verification.yml. The logic
// lives here rather than in workflow shell because that job holds write
// permissions: the repository guard refuses actor-controlled expressions in a
// write-capable job's environment, and refuses free-form shell that touches
// the step environment files beside the isolated `.baseline-proposed`
// checkout. So the event payload is read from `$GITHUB_EVENT_PATH` here, where
// it stays data, and the check run is published from here too. This file is
// managed and hash-locked, which is the provenance the workflow scan cannot
// establish for free-form shell.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { publishCheckRun } from "./publish-codex-review-check.mjs";

function runNode(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });
  return result.status === 0;
}

const {
  GITHUB_EVENT_PATH,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_SERVER_URL,
  GITHUB_TOKEN,
  GITHUB_WORKSPACE,
  SOURCE_TOKEN
} = process.env;

if (!GITHUB_EVENT_PATH || !GITHUB_WORKSPACE) {
  console.error("GITHUB_EVENT_PATH and GITHUB_WORKSPACE must be set.");
  process.exit(1);
}

const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
const workflowRun = event.workflow_run ?? {};
const pullRequest = workflowRun.pull_requests?.[0] ?? {};
const runHeadSha = String(workflowRun.head_sha ?? "");
const associatedHeadSha = String(pullRequest.head?.sha ?? "");
const baseSha = String(pullRequest.base?.sha ?? "");
const guardConclusion = workflowRun.conclusion;

const proposed = join(GITHUB_WORKSPACE, ".baseline-proposed");
let conclusion = "success";
let summary = "Managed baseline is unchanged or matches its pinned source.";

if (!/^[a-f0-9]{40}$/i.test(runHeadSha) || runHeadSha !== associatedHeadSha) {
  conclusion = "failure";
  summary = "Repository Guard SHA does not match the associated pull-request head.";
} else if (guardConclusion !== "success") {
  conclusion = "failure";
  summary = "Repository Guard did not pass for this pull-request head.";
} else if (GITHUB_REPOSITORY !== "kiaquila/web-design" && !/^[a-f0-9]{40}$/i.test(baseSha)) {
  // Without a base commit there is nothing to compare the proposed managed
  // bytes against, and an empty one reads as "nothing changed".
  conclusion = "failure";
  summary = "The workflow_run payload carries no pull-request base SHA to verify against.";
} else if (GITHUB_REPOSITORY !== "kiaquila/web-design") {
  const matches = runNode(
    [
      "scripts/check-baseline-change.mjs",
      "--proposed",
      proposed,
      "--trusted",
      GITHUB_WORKSPACE,
      "--base-sha",
      baseSha
    ],
    { GH_TOKEN: SOURCE_TOKEN ?? "" }
  );
  if (!matches) {
    conclusion = "failure";
    summary = "Proposed managed bytes do not match the pinned web-design source.";
  }
} else if (
  !runNode(["scripts/check-repository.mjs", "--root", proposed]) ||
  !runNode(["scripts/check-managed-files.mjs", proposed])
) {
  conclusion = "failure";
  summary = "Canonical source release manifest or managed hashes are invalid.";
} else {
  summary = "Canonical source release manifest and managed hashes match.";
}

// Logged before publishing so the verdict is in the run log even when the
// check run itself cannot be written.
console.log(`${conclusion}: ${summary}`);

try {
  await publishCheckRun({
    token: GITHUB_TOKEN,
    repository: GITHUB_REPOSITORY,
    payload: {
      name: "baseline-source-verification",
      head_sha: runHeadSha,
      status: "completed",
      conclusion,
      details_url: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
      output: { title: "Baseline source verification", summary }
    }
  });
} catch (error) {
  console.error(`Could not publish the verification check: ${error.message}`);
  process.exit(1);
}

process.exit(conclusion === "success" ? 0 : 1);

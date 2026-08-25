#!/usr/bin/env node

import { publishCheckRun } from "./publish-codex-review-check.mjs";

const CHECKS = [
  ["project-ci", "UPDATE_PROJECT_CI_CONCLUSION"],
  ["repository-guard", "UPDATE_REPOSITORY_GUARD_CONCLUSION"],
  ["osv-scan", "UPDATE_OSV_SCAN_CONCLUSION"],
  ["baseline-source-verification", "UPDATE_BASELINE_SOURCE_CONCLUSION"]
];

function repositoryParts(repository) {
  const [owner, repo, extra] = String(repository || "").split("/");
  if (!owner || !repo || extra) throw new Error("GITHUB_REPOSITORY must be owner/repo.");
  return { owner, repo };
}

export function updateCheckPayload({ name, headSha, conclusion, detailsUrl }) {
  if (!CHECKS.some(([allowed]) => allowed === name)) {
    throw new Error(`Unsupported update check: ${name}.`);
  }
  if (!/^[a-f0-9]{40}$/i.test(String(headSha || ""))) {
    throw new Error("UPDATE_CHECK_HEAD_SHA must be a full 40-character commit SHA.");
  }
  if (!new Set(["success", "failure"]).has(conclusion)) {
    throw new Error(`${name} conclusion must be success or failure.`);
  }
  if (!/^https:\/\//.test(String(detailsUrl || ""))) {
    throw new Error("UPDATE_CHECK_DETAILS_URL must be an HTTPS URL.");
  }
  const passed = conclusion === "success";
  return {
    name,
    head_sha: headSha,
    status: "completed",
    conclusion,
    details_url: detailsUrl,
    output: {
      title: passed ? `${name} passed` : `${name} failed`,
      summary: passed
        ? `Trusted update validation passed for ${headSha}.`
        : `Trusted update validation failed for ${headSha}. See the workflow logs for evidence.`
    }
  };
}

export async function assertCurrentPullRequestHead({
  token,
  repository,
  prNumber,
  headSha,
  request = globalThis.fetch
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required.");
  if (!/^[1-9][0-9]*$/.test(String(prNumber || ""))) {
    throw new Error("UPDATE_CHECK_PR_NUMBER must be a positive integer.");
  }
  const { owner, repo } = repositoryParts(repository);
  const response = await request(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      }
    }
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const pullRequest = await response.json();
  if (pullRequest.head?.sha !== headSha) {
    throw new Error(
      `Pull request #${prNumber} head ${pullRequest.head?.sha || "<missing>"} does not match ${headSha}.`
    );
  }
}

export async function publishUpdateChecks({
  token,
  repository,
  prNumber,
  headSha,
  detailsUrl,
  conclusions,
  request = globalThis.fetch
}) {
  const payloads = CHECKS.map(([name]) =>
    updateCheckPayload({ name, headSha, conclusion: conclusions[name], detailsUrl })
  );
  await assertCurrentPullRequestHead({ token, repository, prNumber, headSha, request });
  for (const payload of payloads) {
    await publishCheckRun({
      token,
      repository,
      payload,
      request
    });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const conclusions = Object.fromEntries(
    CHECKS.map(([name, variable]) => [name, process.env[variable]])
  );
  try {
    await publishUpdateChecks({
      token: process.env.GITHUB_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      prNumber: process.env.UPDATE_CHECK_PR_NUMBER,
      headSha: process.env.UPDATE_CHECK_HEAD_SHA,
      detailsUrl: process.env.UPDATE_CHECK_DETAILS_URL,
      conclusions
    });
    console.log(`Published trusted update checks for ${process.env.UPDATE_CHECK_HEAD_SHA}.`);
  } catch (error) {
    console.error(`Could not publish trusted update checks: ${error.message}`);
    process.exit(1);
  }
}

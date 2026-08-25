import assert from "node:assert/strict";
import test from "node:test";
import {
  publishUpdateChecks,
  updateCheckPayload
} from "../scripts/publish-update-checks.mjs";

const headSha = "a".repeat(40);
const detailsUrl = "https://github.com/example/repo/actions/runs/1";
const conclusions = {
  "project-ci": "success",
  "repository-guard": "success",
  "osv-scan": "failure",
  "baseline-source-verification": "success"
};

test("trusted update check payloads are head-bound and allowlisted", () => {
  assert.deepEqual(
    updateCheckPayload({ name: "project-ci", headSha, conclusion: "success", detailsUrl }),
    {
      name: "project-ci",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      details_url: detailsUrl,
      output: {
        title: "project-ci passed",
        summary: `Trusted update validation passed for ${headSha}.`
      }
    }
  );
  assert.throws(
    () => updateCheckPayload({ name: "deploy", headSha, conclusion: "success", detailsUrl }),
    /Unsupported update check/
  );
  assert.throws(
    () => updateCheckPayload({ name: "project-ci", headSha: "short", conclusion: "success", detailsUrl }),
    /full 40-character commit SHA/
  );
});

test("publisher verifies the live pull-request head before creating checks", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return new Response(JSON.stringify({ head: { sha: headSha } }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: calls.length }), { status: 201 });
  };

  await publishUpdateChecks({
    token: "token",
    repository: "example/repo",
    prNumber: "46",
    headSha,
    detailsUrl,
    conclusions,
    request
  });

  assert.equal(calls.length, 5);
  assert.match(calls[0].url, /\/pulls\/46$/);
  assert.deepEqual(
    calls.slice(1).map(({ options }) => JSON.parse(options.body).name),
    ["project-ci", "repository-guard", "osv-scan", "baseline-source-verification"]
  );
});

test("publisher refuses a stale generated head", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return new Response(JSON.stringify({ head: { sha: "b".repeat(40) } }), { status: 200 });
  };
  await assert.rejects(
    publishUpdateChecks({
      token: "token",
      repository: "example/repo",
      prNumber: "46",
      headSha,
      detailsUrl,
      conclusions,
      request
    }),
    /does not match/
  );
  assert.equal(calls, 1);
});

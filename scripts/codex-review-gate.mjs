#!/usr/bin/env node
/* The Codex Review gate.

   It does not run a review; it reads the pull request and decides whether a
   Codex review for *this exact head* exists and came back clean. The chain is
   deliberately short: a trusted human comments "@codex review <full head
   sha>", Codex answers, and this gate reads that answer. There is no marker
   comment and no second dispatching workflow — the human comment is the
   record, and rerunning this run is what re-reads it. */

import { appendFileSync } from "node:fs";
import {
  isAcceptableCodexSummaryComment,
  isStrictlyAfterCodexReviewRequest,
  latestCodexNativeReviewResult,
  latestTrustedCodexReviewCommand
} from "./codex-review-helpers.mjs";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.CODEX_REVIEW_PR_NUMBER;
const eventHeadSha = process.env.CODEX_REVIEW_HEAD_SHA;
const maxWaitMs = Number(process.env.CODEX_REVIEW_WAIT_MS || 30000);
const pollMs = Number(process.env.CODEX_REVIEW_POLL_MS || 5000);
const debounceMs = Number(process.env.CODEX_REVIEW_DEBOUNCE_MS || 5000);

if (!token || !repository || !prNumber) {
  console.error("GITHUB_TOKEN, GITHUB_REPOSITORY, and CODEX_REVIEW_PR_NUMBER are required.");
  process.exit(1);
}

const [owner, repo] = repository.split("/");

async function request(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function listPaginated(path) {
  const items = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page += 1) {
    const batch = await request(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

const fetchPull = () => request(`/repos/${owner}/${repo}/pulls/${prNumber}`);

const initialPull = await fetchPull();
const headSha = eventHeadSha || initialPull.head?.sha;

async function currentHeadMatches() {
  const pull = await fetchPull();
  return pull.head?.sha === headSha;
}

async function fetchEvidence() {
  if (!await currentHeadMatches()) return "stale";

  const comments = await listPaginated(`/repos/${owner}/${repo}/issues/${prNumber}/comments`);
  const reviewRequest = latestTrustedCodexReviewCommand(comments, headSha);
  if (!reviewRequest) return "missing_request";

  const [reviews, reviewComments] = await Promise.all([
    listPaginated(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`),
    listPaginated(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
  ]);
  /* Only evidence produced after the request counts: an older review looked
     at an older tree even when the SHA happens to match again. */
  const reviewsAfterRequest = reviews.filter((review) =>
    isStrictlyAfterCodexReviewRequest(review.submitted_at, reviewRequest)
  );
  const nativeResult = latestCodexNativeReviewResult(reviewsAfterRequest, reviewComments, headSha);
  if (nativeResult) return nativeResult;

  return comments.some((comment) => isAcceptableCodexSummaryComment(
    comment,
    headSha,
    reviewRequest.requestedAt,
    reviewRequest.commentId
  ))
    ? "pass"
    : "pending";
}

/* A push and its review request arrive within moments of each other; the
   debounce keeps this run from reading the pull request mid-update. */
if (Number.isFinite(debounceMs) && debounceMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, debounceMs));
}
if (!await currentHeadMatches()) {
  console.log(`Codex Review skipped stale run for ${headSha}; PR head changed during debounce.`);
  process.exit(0);
}

const started = Date.now();
let outcome = "pending";
let lastError = null;

while (Date.now() - started <= maxWaitMs) {
  try {
    outcome = await fetchEvidence();
    lastError = null;
    if (["pass", "fail", "stale"].includes(outcome)) break;
  } catch (error) {
    lastError = error;
  }

  const remaining = maxWaitMs - (Date.now() - started);
  if (remaining <= 0) break;
  await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
}

if (outcome === "stale") {
  console.log(`Codex Review skipped stale run for ${headSha}; PR head moved.`);
  process.exit(0);
}
if (outcome === "pass") {
  console.log(`Codex Review passed for ${headSha}.`);
  process.exit(0);
}

const next = outcome === "missing_request"
  ? "A trusted OWNER, MEMBER, or COLLABORATOR must post '@codex review <current-full-head-sha>' on this PR."
  : outcome === "fail"
    ? "Resolve all P0-P2 findings, push fixes if needed, and request a new current-head review."
    : "Wait for Codex evidence; its review event will rerun this gate automatically.";
const summary = [
  "## Codex Review gate failed",
  "",
  `- head SHA: \`${headSha}\``,
  `- state: \`${outcome}\``,
  `- next: ${next}`,
  lastError ? `- API error: ${lastError.message}` : ""
].filter(Boolean).join("\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
console.error(summary.replaceAll("`", ""));
process.exit(1);

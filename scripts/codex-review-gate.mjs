#!/usr/bin/env node
/* The Codex Review gate.

   It does not run a review; it reads the pull request and decides whether a
   Codex review for *this exact head* exists and came back clean. The chain is
   deliberately short: a trusted human comments "@codex review <full head
   sha>", Codex answers, and this gate reads that answer. There is no marker
   comment and no second dispatching workflow - the human comment is the
   record, and rerunning this run is what re-reads it. */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateCodexReviewEvidence } from "./codex-review-helpers.mjs";

/** Read the actual API chain, with a final HEAD check after all evidence.
    Request injection lets tests exercise pagination, API errors and pushes. */
export async function fetchCodexReviewEvidence({ repository, prNumber, headSha, request }) {
  const pullPath = `/repos/${repository}/pulls/${prNumber}`;
  if ((await request(pullPath)).head?.sha !== headSha) return "stale";
  async function list(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const batch = await request(`${path}?per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }
  const [comments, reviews, reviewComments] = await Promise.all([
    list(`/repos/${repository}/issues/${prNumber}/comments`),
    list(`${pullPath}/reviews`),
    list(`${pullPath}/comments`)
  ]);
  const [owner, name] = repository.split("/");
  const threads = [];
  let cursor = null;
  do {
    const result = await request("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                nodes { isResolved comments(first: 1) { nodes { author { __typename login } } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        variables: { owner, name, number: Number(prNumber), cursor }
      })
    });
    if (result.errors?.length) throw new Error(`Review thread query failed: ${JSON.stringify(result.errors)}`);
    const connection = result.data?.repository?.pullRequest?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error("Missing review threads in GitHub response.");
    threads.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !cursor) throw new Error("Missing review thread cursor.");
  } while (cursor);

  const outcome = evaluateCodexReviewEvidence({ comments, reviews, reviewComments, threads, headSha });
  return (await request(pullPath)).head?.sha === headSha ? outcome : "stale";
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.CODEX_REVIEW_PR_NUMBER;
  const eventHeadSha = process.env.CODEX_REVIEW_HEAD_SHA;
  const maxWaitMs = Number(process.env.CODEX_REVIEW_WAIT_MS || 30000);
  const pollMs = Number(process.env.CODEX_REVIEW_POLL_MS || 5000);
  const debounceMs = Number(process.env.CODEX_REVIEW_DEBOUNCE_MS || 5000);

  if (!token || !repository || !prNumber) {
    console.error("GITHUB_TOKEN, GITHUB_REPOSITORY, and CODEX_REVIEW_PR_NUMBER are required.");
    return 1;
  }

  const [owner, repo] = repository.split("/");

  async function request(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
    }
    return response.json();
  }

  const fetchPull = () => request(`/repos/${owner}/${repo}/pulls/${prNumber}`);

  const initialPull = await fetchPull();
  const headSha = eventHeadSha || initialPull.head?.sha;

  async function currentHeadMatches() {
    const pull = await fetchPull();
    return pull.head?.sha === headSha;
  }

  const fetchEvidence = () => fetchCodexReviewEvidence({ repository, prNumber, headSha, request });

  /* A push and its review request arrive within moments of each other; the
     debounce keeps this run from reading the pull request mid-update. */
  if (Number.isFinite(debounceMs) && debounceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, debounceMs));
  }
  if (!await currentHeadMatches()) {
    console.log(`Codex Review skipped stale run for ${headSha}; PR head changed during debounce.`);
    return 0;
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
    return 0;
  }
  if (outcome === "pass") {
    console.log(`Codex Review passed for ${headSha}.`);
    return 0;
  }

  const next = outcome === "missing_request"
    ? "A trusted OWNER, MEMBER, or COLLABORATOR must post '@codex review <current-full-head-sha>' on this PR."
    : outcome === "fail"
      ? "Resolve P0-P2 findings and all unresolved Codex threads, push fixes if needed, and request a new current-head review."
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
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Codex Review gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

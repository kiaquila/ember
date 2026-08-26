/* The Codex Review gate's rules. The gate itself only fetches and loops; the
   decisions live in the helpers, so they are exercised here directly. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCodexNativeReview,
  isAcceptableCodexSummaryComment,
  isCodexReviewCommand,
  isCodexReviewCommandForHead,
  isStrictlyAfterCodexReviewRequest,
  isTrustedAssociation,
  latestCodexNativeReviewResult,
  latestTrustedCodexReviewCommand
} from "../scripts/codex-review-helpers.mjs";
import {
  rerunCodexReviewForHead,
  selectCodexReviewRun,
  shouldRouteCodexReviewRerunEvent
} from "../scripts/codex-review-rerun.mjs";

const headSha = "abcdef0123456789abcdef0123456789abcdef01";
const codexUser = { login: "chatgpt-codex-connector[bot]" };

test("only trusted humans naming the exact head can request a review", () => {
  assert.equal(isTrustedAssociation("OWNER"), true);
  assert.equal(isTrustedAssociation("MEMBER"), true);
  assert.equal(isTrustedAssociation("COLLABORATOR"), true);
  assert.equal(isTrustedAssociation("CONTRIBUTOR"), false);

  assert.equal(isCodexReviewCommand("@codex review"), true);
  assert.equal(isCodexReviewCommand("please @CoDeX   review this"), true);
  assert.equal(isCodexReviewCommand("@codex implement"), false);

  assert.equal(isCodexReviewCommandForHead(`@codex review ${headSha}`, headSha), true);
  assert.equal(isCodexReviewCommandForHead(`@codex review \`${headSha}\``, headSha), true);
  /* A bare command, or one naming another commit, vouches for nothing. */
  assert.equal(isCodexReviewCommandForHead("@codex review", headSha), false);
  assert.equal(isCodexReviewCommandForHead(`@codex review ${headSha.slice(0, 12)}`, headSha), false);
  assert.equal(
    isCodexReviewCommandForHead(`@codex review ${"f".repeat(40)}`, headSha),
    false
  );
});

test("the newest trusted request for this head is the one that counts", () => {
  const comments = [
    {
      id: 1,
      body: `@codex review ${headSha}`,
      author_association: "OWNER",
      user: { login: "kiaquila", type: "User" },
      created_at: "2026-08-25T10:00:00Z"
    },
    {
      id: 2,
      body: `@codex review ${headSha}`,
      author_association: "OWNER",
      user: { login: "kiaquila", type: "User" },
      created_at: "2026-08-25T12:00:00Z"
    },
    {
      id: 3,
      body: `@codex review ${headSha}`,
      author_association: "CONTRIBUTOR",
      user: { login: "outsider", type: "User" },
      created_at: "2026-08-25T13:00:00Z"
    },
    {
      id: 4,
      body: `@codex review ${headSha}`,
      author_association: "OWNER",
      user: { login: "some-app[bot]", type: "Bot" },
      created_at: "2026-08-25T14:00:00Z"
    }
  ];
  const request = latestTrustedCodexReviewCommand(comments, headSha);
  assert.equal(request.commentId, "2");
  assert.equal(request.requestedAt, "2026-08-25T12:00:00Z");

  /* An untrusted association and a bot cannot stand in for the human. */
  assert.equal(latestTrustedCodexReviewCommand(comments.slice(2), headSha), null);
  assert.equal(latestTrustedCodexReviewCommand([], headSha), null);
});

test("evidence must be strictly newer than the request it answers", () => {
  const request = { requestedAt: "2026-08-25T12:00:00Z" };
  assert.equal(isStrictlyAfterCodexReviewRequest("2026-08-25T12:00:01Z", request), true);
  assert.equal(isStrictlyAfterCodexReviewRequest("2026-08-25T12:00:00Z", request), false);
  assert.equal(isStrictlyAfterCodexReviewRequest("2026-08-25T11:59:59Z", request), false);
  assert.equal(isStrictlyAfterCodexReviewRequest(undefined, request), false);
});

test("a review answers only for its own head, and P0-P2 blocks", () => {
  const review = { id: 7, commit_id: headSha, user: codexUser, state: "COMMENTED", body: "" };

  assert.equal(classifyCodexNativeReview(review, [], headSha), "pass");
  assert.equal(classifyCodexNativeReview({ ...review, state: "APPROVED" }, [], headSha), "pass");
  assert.equal(
    classifyCodexNativeReview({ ...review, state: "CHANGES_REQUESTED" }, [], headSha),
    "fail"
  );
  assert.equal(classifyCodexNativeReview({ ...review, body: "P1 badge" }, [], headSha), "fail");

  /* Another commit, or another author, is not evidence about this head. */
  assert.equal(classifyCodexNativeReview({ ...review, commit_id: "other" }, [], headSha), null);
  assert.equal(
    classifyCodexNativeReview({ ...review, user: { login: "someone" } }, [], headSha),
    null
  );

  const blocking = [{ pull_request_review_id: 7, user: codexUser, body: "P2 finding" }];
  assert.equal(classifyCodexNativeReview(review, blocking, headSha), "fail");
  const informational = [{ pull_request_review_id: 7, user: codexUser, body: "P3 nit" }];
  assert.equal(classifyCodexNativeReview(review, informational, headSha), "pass");
  /* A finding the gate cannot grade is treated as blocking. */
  const ungraded = [{ pull_request_review_id: 7, user: codexUser, body: "no priority here" }];
  assert.equal(classifyCodexNativeReview(review, ungraded, headSha), "fail");
});

test("the latest current-head result wins", () => {
  const reviews = [
    {
      id: 1,
      commit_id: headSha,
      user: codexUser,
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-08-25T12:00:00Z"
    },
    {
      id: 2,
      commit_id: headSha,
      user: codexUser,
      state: "APPROVED",
      submitted_at: "2026-08-25T13:00:00Z"
    }
  ];
  assert.equal(latestCodexNativeReviewResult(reviews, [], headSha), "pass");
  assert.equal(latestCodexNativeReviewResult(reviews.slice(0, 1), [], headSha), "fail");
  assert.equal(latestCodexNativeReviewResult([], [], headSha), null);
});

test("a no-findings summary must name the reviewed head and follow the request", () => {
  const requestedAt = "2026-08-25T12:00:00Z";
  const body = [
    "Codex Review: Didn't find any major issues.",
    "",
    `**Reviewed commit:** \`${headSha.slice(0, 10)}\``
  ].join("\n");
  const summary = { id: 20, user: codexUser, body, created_at: "2026-08-25T12:30:00Z" };

  assert.equal(isAcceptableCodexSummaryComment(summary, headSha, requestedAt, "10"), true);
  /* Before the request, from someone else, or about another commit. */
  assert.equal(
    isAcceptableCodexSummaryComment(
      { ...summary, created_at: "2026-08-25T11:00:00Z" },
      headSha,
      requestedAt,
      "10"
    ),
    false
  );
  assert.equal(
    isAcceptableCodexSummaryComment({ ...summary, user: { login: "kiaquila" } }, headSha, requestedAt, "10"),
    false
  );
  assert.equal(
    isAcceptableCodexSummaryComment(summary, "f".repeat(40), requestedAt, "10"),
    false
  );
});

test("rerun routing accepts only Codex's own evidence", () => {
  assert.equal(shouldRouteCodexReviewRerunEvent({ review: { user: codexUser } }), true);
  assert.equal(shouldRouteCodexReviewRerunEvent({ review: { user: { login: "kiaquila" } } }), false);
  assert.equal(
    shouldRouteCodexReviewRerunEvent({
      issue: { pull_request: {} },
      comment: { user: codexUser, body: "Codex Review: Didn't find any major issues." }
    }),
    true
  );
  assert.equal(
    shouldRouteCodexReviewRerunEvent({
      issue: { pull_request: {} },
      comment: { user: codexUser, body: "unrelated chatter" }
    }),
    false
  );
  assert.equal(shouldRouteCodexReviewRerunEvent({}), false);
});

test("rerun selection is head-bound and waits for an active run", () => {
  const completed = {
    id: 1,
    event: "pull_request",
    head_sha: headSha,
    status: "completed",
    created_at: "2026-08-25T12:00:00Z"
  };
  const active = { ...completed, id: 2, status: "in_progress", created_at: "2026-08-25T13:00:00Z" };

  assert.deepEqual(selectCodexReviewRun([completed], headSha).action, "rerun");
  assert.deepEqual(
    selectCodexReviewRun([completed, active], headSha).action,
    "wait_for_active_then_rerun"
  );
  /* Another commit's run must never be reused as this head's evidence. */
  assert.deepEqual(
    selectCodexReviewRun([{ ...completed, head_sha: "other" }], headSha).action,
    "not_found"
  );
  assert.deepEqual(selectCodexReviewRun([], headSha).action, "not_found");
});

test("the rerun helper posts a rerun for the head-bound run", async () => {
  const calls = [];
  const result = await rerunCodexReviewForHead({
    token: "t",
    repository: "kiaquila/ember",
    headSha,
    request: async (token, repository, path, options = {}) => {
      calls.push({ path, method: options.method });
      if (path.includes("/runs/")) return null;
      return {
        workflow_runs: [{
          id: 42,
          event: "pull_request",
          head_sha: headSha,
          status: "completed",
          created_at: "2026-08-25T12:00:00Z"
        }]
      };
    },
    sleep: async () => {}
  });

  assert.equal(result.action, "rerun");
  assert.match(result.message, /rerun for abcdef0123456789abcdef0123456789abcdef01 from run 42/);
  assert.deepEqual(calls.at(-1), {
    path: "/repos/kiaquila/ember/actions/runs/42/rerun",
    method: "POST"
  });
});

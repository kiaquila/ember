/* The Codex Review gate's rules. The gate itself only fetches and loops; the
   decisions live in the helpers, so they are exercised here directly. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { fetchCodexReviewEvidence } from "../scripts/codex-review-gate.mjs";
import test from "node:test";

import {
  classifyCodexNativeReview,
  evaluateCodexReviewEvidence,
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
  assert.equal(shouldRouteCodexReviewRerunEvent({ action: "submitted", review: { user: codexUser } }), true);
  assert.equal(shouldRouteCodexReviewRerunEvent({ action: "submitted", review: { user: { login: "kiaquila" } } }), false);
  assert.equal(
    shouldRouteCodexReviewRerunEvent({
      action: "created",
      issue: { pull_request: {} },
      comment: { user: codexUser, body: "Codex Review: Didn't find any major issues." }
    }),
    true
  );
  assert.equal(
    shouldRouteCodexReviewRerunEvent({
      action: "created",
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

const requestedAt = "2026-10-15T20:00:00Z";
const answeredAt = "2026-10-15T20:01:00Z";
const legacyBody = `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``;
const receiptBody = `<!-- codex-review-receipt:v1 -->\n\n${legacyBody.replace("issues.", "issues. :rocket:")}`;
const stateBody = `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
  code_review: { commit_sha: headSha, has_any_findings: false, has_unresolved_findings: false, status: "completed" },
  security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null }
})} -->\n\n## Codex Review Summary\n\nCompleted 👍`;
const summaryComment = (body = receiptBody) => ({
  id: 20, user: codexUser, body, created_at: answeredAt, updated_at: answeredAt
});
const command = {
  id: 10, body: `@codex review ${headSha}`, author_association: "OWNER",
  user: { login: "kiaquila", type: "User" }, created_at: requestedAt
};
const codexActor = { __typename: "Bot", login: "chatgpt-codex-connector" };
const evidence = (overrides = {}) => ({
  comments: [command, summaryComment()], reviews: [], reviewComments: [], threads: [], headSha, ...overrides
});

test("real receipt and legacy answers pass, including native GitHub details", () => {
  for (const body of [legacyBody, receiptBody, receiptBody.replace(":rocket:", "Keep it up!"),
    receiptBody.replace(":rocket:", "Hooray!"), receiptBody.replace(":rocket:", "Wonderful work!"),
    `${receiptBody}\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\nReviews are triggered when you comment \"@codex review\".\n</details>`]) {
    assert.equal(isAcceptableCodexSummaryComment(summaryComment(body), headSha, requestedAt, "10"), true);
    assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, summaryComment(body)] })), "pass");
  }
});

test("receipts fail closed on stale, absent, ambiguous or conflicting evidence", () => {
  for (const body of [
    receiptBody.replace(headSha.slice(0, 10), "f".repeat(10)),
    receiptBody.replace(/\*\*Reviewed commit:[\s\S]*/, ""),
    receiptBody.replace(headSha.slice(0, 10), headSha),
    receiptBody.replace("receipt:v1", "receipt:v2"),
    receiptBody.replace("<!--", "<!-"),
    `${receiptBody}\n\n${receiptBody}`,
    `<!-- codex-review-receipt:v1 -->\n${receiptBody}`,
    `${receiptBody}\n\n**Reviewed commit:** \`${"f".repeat(10)}\``,
    `${receiptBody}\nP2: fix this bug`,
    receiptBody.replace(":rocket:", "However, review is incomplete."),
    receiptBody.replace(":rocket:", "But there are findings."),
    receiptBody.replace("Didn't find any major issues.", "Found P1 issues."),
    receiptBody.replace("Didn't find any major issues.", "Review in progress."),
    `${stateBody}\n\n${receiptBody}`,
    "Completed 👍", stateBody,
    stateBody.replace('"completed"', '"in_progress"'),
    stateBody.replace('"has_any_findings":false', '"has_any_findings":true'),
    stateBody.replace(headSha, "f".repeat(40)),
    `${stateBody}\n${stateBody}`, "<!-- codex-pull-request-review-summary -->\nmalformed"
  ]) {
    assert.equal(isAcceptableCodexSummaryComment(summaryComment(body), headSha, requestedAt, "10"), false, body);
    assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, summaryComment(body)] })), "pending", body);
  }
  assert.equal(isAcceptableCodexSummaryComment(summaryComment(), headSha.slice(0, 10), requestedAt, "10"), false);
  assert.equal(isAcceptableCodexSummaryComment({ ...summaryComment(), user: { login: "github-actions[bot]" } }, headSha, requestedAt, "10"), false);
  assert.equal(isAcceptableCodexSummaryComment({ ...summaryComment(), created_at: requestedAt, id: 11 }, headSha, requestedAt, "10"), true);
  assert.equal(isAcceptableCodexSummaryComment({ ...summaryComment(), created_at: requestedAt, id: 9 }, headSha, requestedAt, "10"), false);
  // Editing an old summary wakes the gate but cannot manufacture new evidence.
  const edited = { ...summaryComment(stateBody), created_at: "2026-10-14T12:00:00Z", updated_at: answeredAt };
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, edited] })), "pending");
  assert.equal(isAcceptableCodexSummaryComment({ ...edited, body: receiptBody }, headSha, requestedAt, "10"), false);
});

test("the workflow filter and runtime both route created/edited native comments", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/codex-review-rerun.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.issue_comment.types, ["created", "edited"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const condition = workflow.jobs["codex-review-rerun"].if;
  // Execute the actual checked-in expression with the two GitHub functions it uses.
  const workflowRoutes = (event) => Function("github", "startsWith", `return (${condition});`)(
    { event_name: event.review ? "pull_request_review" : "issue_comment", event },
    (body, prefix) => String(body || "").toLowerCase().startsWith(prefix.toLowerCase())
  );
  for (const action of ["created", "edited"]) {
    for (const body of [legacyBody, receiptBody, stateBody]) {
      const event = { action, issue: { number: 1, pull_request: {} }, comment: summaryComment(body) };
      assert.equal(Boolean(workflowRoutes(event)), true);
      assert.equal(shouldRouteCodexReviewRerunEvent(event), true);
      const spoof = { ...event, comment: { ...event.comment, user: { login: "someone" } } };
      assert.equal(Boolean(workflowRoutes(spoof)), false);
      assert.equal(shouldRouteCodexReviewRerunEvent(spoof), false);
      const issue = { ...event, issue: {} };
      assert.equal(Boolean(workflowRoutes(issue)), false);
      assert.equal(shouldRouteCodexReviewRerunEvent(issue), false);
    }
  }
  const review = { action: "submitted", review: { user: codexUser } };
  assert.equal(workflowRoutes(review), true);
  assert.equal(shouldRouteCodexReviewRerunEvent(review), true);
  assert.equal(shouldRouteCodexReviewRerunEvent({ action: "deleted", issue: { pull_request: {} }, comment: summaryComment() }), false);
});

test("new requests and clean receipts never hide existing findings", () => {
  const review = { id: 7, commit_id: headSha, user: codexUser, state: "COMMENTED", submitted_at: "2026-10-15T19:00:00Z" };
  for (const body of ["P2 finding", "ungraded finding", "P3 context, P1 finding"]) {
    assert.equal(evaluateCodexReviewEvidence(evidence({
      reviews: [review], reviewComments: [{ pull_request_review_id: 7, user: codexUser, body }]
    })), "fail");
  }
  for (const body of ["P1", "P3", "ungraded"]) {
    const thread = { isResolved: false, isOutdated: true, comments: { nodes: [{ author: codexActor, body }] } };
    assert.equal(evaluateCodexReviewEvidence(evidence({ threads: [thread] })), "fail");
    assert.equal(evaluateCodexReviewEvidence(evidence({ threads: [{ ...thread, isResolved: true }] })), "pass");
  }
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [summaryComment()] })), "missing_request");
  assert.equal(evaluateCodexReviewEvidence(evidence({ threads: [{ isResolved: false,
    comments: { nodes: [{ author: { ...codexActor, __typename: "User" } }] }
  }] })), "pass");
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command], reviews: [{ ...review, submitted_at: answeredAt }] })), "pass");
});

test("later clean reviews on the same head cannot clear body-only findings", () => {
  const clean = { id: 8, commit_id: headSha, user: codexUser, state: "APPROVED", submitted_at: answeredAt };
  for (const failure of [
    { body: "P1 body-only finding", state: "COMMENTED" },
    { body: "P3 context followed by P2 finding", state: "COMMENTED" },
    { body: "Changes required", state: "CHANGES_REQUESTED" }
  ]) {
    const earlier = { ...clean, ...failure, id: 7, submitted_at: "2026-10-15T19:00:00Z" };
    assert.equal(evaluateCodexReviewEvidence(evidence({ reviews: [earlier, clean] })), "fail");
    assert.equal(evaluateCodexReviewEvidence(evidence({ reviews: [{ ...earlier, commit_id: "f".repeat(40) }, clean] })), "pass");
    assert.equal(evaluateCodexReviewEvidence(evidence({ reviews: [{ ...earlier, user: { login: "someone" } }, clean] })), "pass");
  }
});

function apiFixture({ moveHead = false, threadError = false, paginated = false, threads = [] } = {}) {
  let pullReads = 0;
  const calls = [];
  return { calls, request: async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/pulls/1")) {
      pullReads += 1;
      return { head: { sha: moveHead && pullReads > 1 ? "f".repeat(40) : headSha } };
    }
    if (path === "/graphql") {
      if (threadError) return { errors: [{ message: "permission denied" }] };
      const cursor = JSON.parse(options.body).variables.cursor;
      return { data: { repository: { pullRequest: { reviewThreads: {
        nodes: cursor ? threads : [], pageInfo: { hasNextPage: paginated && !cursor, endCursor: "next" }
      } } } } };
    }
    if (path.includes("/issues/")) {
      if (paginated && path.endsWith("page=1")) return Array.from({ length: 100 }, (_, i) => ({ id: i, body: "unrelated" }));
      return [command, summaryComment()];
    }
    return [];
  } };
}

test("the real gate API chain paginates, checks threads and rechecks HEAD", async () => {
  const run = (fixture) => fetchCodexReviewEvidence({ repository: "kiaquila/ember", prNumber: 1, headSha, request: fixture.request });
  const positive = apiFixture({ paginated: true });
  assert.equal(await run(positive), "pass");
  assert.equal(positive.calls.filter((call) => call.path === "/graphql").length, 2);
  assert.equal(positive.calls.filter((call) => call.path.includes("/issues/")).length, 2);
  assert.equal(await run(apiFixture({ moveHead: true })), "stale");
  await assert.rejects(run(apiFixture({ threadError: true })), /permission denied/);
  const blocked = apiFixture({ paginated: true, threads: [{ isResolved: false, comments: { nodes: [{ author: codexActor }] } }] });
  assert.equal(await run(blocked), "fail");
});

const completedRun = {
  id: 42, event: "pull_request", head_sha: headSha, status: "completed",
  created_at: "2026-10-15T19:50:00Z", run_started_at: "2026-10-15T19:50:00Z"
};

test("requeue waits for an active gate and coalesces already evaluated evidence", async () => {
  for (const alreadyEvaluated of [false, true]) {
    const calls = [];
    let listings = 0;
    let sleeps = 0;
    const result = await rerunCodexReviewForHead({
      token: "t", repository: "kiaquila/ember", headSha, prNumber: 1, evidenceAt: answeredAt,
      sleep: async () => { sleeps += 1; },
      request: async (token, repository, path, options = {}) => {
        calls.push({ path, options });
        if (path.endsWith("/pulls/1")) return { state: "open", head: { sha: headSha } };
        if (options.method === "POST") return null;
        listings += 1;
        return { workflow_runs: [{ ...completedRun,
          status: listings === 1 ? "in_progress" : "completed",
          run_started_at: alreadyEvaluated ? "2026-10-15T20:02:00Z" : completedRun.run_started_at
        }] };
      }
    });
    assert.equal(sleeps, 1);
    assert.equal(result.action, alreadyEvaluated ? "already_evaluated" : "rerun");
    assert.equal(calls.filter((call) => call.options.method === "POST").length, alreadyEvaluated ? 0 : 1);
  }
});

test("requeue aborts on a new push or closed PR and bounds active-run waiting", async () => {
  for (const pull of [{ state: "open", head: { sha: "f".repeat(40) } }, { state: "closed", head: { sha: headSha } }]) {
    const result = await rerunCodexReviewForHead({
      token: "t", repository: "kiaquila/ember", headSha, prNumber: 1,
      request: async (token, repository, path, options = {}) => {
        assert.notEqual(options.method, "POST");
        return path.endsWith("/pulls/1") ? pull : { workflow_runs: [completedRun] };
      }
    });
    assert.equal(result.action, "stale");
  }
  let sleeps = 0;
  await assert.rejects(rerunCodexReviewForHead({
    token: "t", repository: "kiaquila/ember", headSha, maxActiveRunPolls: 2,
    sleep: async () => { sleeps += 1; },
    request: async () => ({ workflow_runs: [{ ...completedRun, status: "in_progress" }] })
  }), /remained active/);
  assert.equal(sleeps, 2);
});

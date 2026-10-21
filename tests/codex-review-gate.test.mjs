/* The Codex Review gate's rules. The gate itself only fetches and loops; the
   decisions live in the helpers, so they are exercised here directly. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { fetchCodexReviewEvidence } from "../scripts/codex-review-gate.mjs";
import test from "node:test";

import {
  classifyCodexNativeReview,
  evaluateCodexReviewEvidence,
  isAffirmativeCodexReviewState,
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

test("observed receipt sign-offs preserve author, head, timing and verdict checks", () => {
  const requestedAt = "2026-10-15T20:00:00Z";
  for (const suffix of ["Another round soon, please!", "You're on a roll.", "You’re on a roll.",
    "Already looking forward to the next diff.", "Breezy!", "What shall we delve into next?",
    "Can't wait for the next one!", ":+1:"]) {
    const body = `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. ${suffix}\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``;
    const receipt = { id: 20, user: codexUser, body, created_at: "2026-10-15T20:01:00Z" };
    const accepts = (comment) => isAcceptableCodexSummaryComment(comment, headSha, requestedAt, "10");
    assert.equal(accepts(receipt), true, suffix);
    assert.equal(accepts({ ...receipt, user: { login: "someone" } }), false);
    assert.equal(accepts({ ...receipt, created_at: "2026-10-15T19:59:00Z" }), false);
    assert.equal(accepts({ ...receipt, body: body.replace(headSha.slice(0, 10), "f".repeat(10)) }), false);
    for (const conflicting of [" But there is a regression.", " P2 finding", " Review pending."]) {
      assert.equal(accepts({ ...receipt, body: body.replace(suffix, suffix + conflicting) }), false);
    }
  }
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
})} -->\n\n## Codex Review Summary\n\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${answeredAt}">${answeredAt}</relative-time> | \`${headSha.slice(0, 7)}\` | Manual request |`;
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
    receiptBody.replace(":rocket:", "Hooray!"),
    receiptBody.replace(":rocket:", "More of your lovely PRs please."),
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
    receiptBody.replace(":rocket:", "More work is required."),
    receiptBody.replace(":rocket:", "Awaiting verification."),
    receiptBody.replace(":rocket:", "This result is provisional."),
    receiptBody.replace(":rocket:", "Unrecognized decoration!"),
    receiptBody.replace("Didn't find any major issues.", "Found P1 issues."),
    receiptBody.replace("Didn't find any major issues.", "Review in progress."),
    `${stateBody}\n\n${receiptBody}`,
    "Completed 👍",
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
  // A fresh machine-state update can complete a request; an edited receipt cannot.
  const edited = { ...summaryComment(stateBody), created_at: "2026-10-14T12:00:00Z", updated_at: answeredAt };
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, edited] })), "pass");
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

// Independent machine completion permits any neutral closing without teaching
// the legacy receipt parser new phrases. The receipt itself remains strict.
test("only newer structured proof supersedes an unfamiliar closing", () => {
  const run = (answers) => evaluateCodexReviewEvidence(evidence({ comments: [command, ...answers] }));
  const state = summaryComment(stateBody);
  for (const suffix of ["Swish!", "Chef's kiss.", "Chef’s kiss.", "No worries!", "A whimsical flourish.", "Sunshine and confetti! 🎉"]) {
    const answer = summaryComment(receiptBody.replace(":rocket:", suffix));
    assert.equal(run([answer]), "pending");
    for (const newerState of [true, false]) {
      const later = { ...(newerState ? { ...state, body: state.body.replaceAll(answeredAt, "2026-10-15T22:00:00Z") } : answer), id: 99, created_at: "2026-10-15T22:00:00Z", updated_at: "2026-10-15T22:00:00Z" };
      const answers = newerState ? [answer, later] : [state, later];
      assert.equal(run(answers), newerState ? "pass" : "pending", suffix);

    }
  }
  for (const suffix of ["Swish! <!-- unknown -->", "Swish!\nExtra line.", "P0 finding", "P1 finding", "P2 finding"]) {
    assert.equal(run([state, summaryComment(receiptBody.replace(":rocket:", suffix))]), "pending", suffix);
  }
  for (const bad of [stateBody.replace('"completed"', '"running"'), stateBody.replace('"has_any_findings":false', '"has_any_findings":true'), stateBody.replace('"code_review":', '"code_review":{},"code_review":'), stateBody.replace('"status":"completed"', '"extra":false,"status":"completed"'), stateBody.replace('"status":"completed"', '"status":true'), stateBody.replace('"status":null', '"status":"running"'), stateBody.replace('"commit_sha":null', '"commit_sha":"' + "f".repeat(40) + '"'), stateBody.replace('"code_review":', '"code_review":broken'), stateBody + "\n<!-- codex-review-state:v1 {} -->"]) {
    const newer = { ...summaryComment(bad), id: 100, updated_at: "2026-10-15T22:00:00Z" };
    assert.equal(run([state, newer]), "pending", bad);

  }
  assert.equal(run([{ ...state, updated_at: "2026-10-15T19:00:00Z" }]), "pending");
  assert.equal(run([{ ...state, user: { login: "fake-codex[bot]" } }]), "pending");
});

function runGate(comments, reviews = []) {
  const directory = mkdtempSync(join(tmpdir(), "ember-gate-test-"));
  try {
    const fixture = { comments: [command, ...comments], headSha, reviews };
    const preload = join(directory, "mock.mjs");
    writeFileSync(preload, `const fixture = ${JSON.stringify(fixture)};
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname; let data;
        if (path === '/graphql') data = { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
        else if (path.endsWith('/pulls/1')) data = { head: { sha: fixture.headSha } };
        else if (path.includes('/issues/1/comments')) data = fixture.comments;
      else if (path.endsWith('/reviews')) data = fixture.reviews;
        else data = [];
        return { ok: true, json: async () => data };
      };`);
    return spawnSync(process.execPath, ["--import", preload, resolve(import.meta.dirname, "../scripts/codex-review-gate.mjs")], {
      encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo", CODEX_REVIEW_PR_NUMBER: "1", CODEX_REVIEW_HEAD_SHA: headSha, CODEX_REVIEW_WAIT_MS: "1", CODEX_REVIEW_POLL_MS: "1", CODEX_REVIEW_DEBOUNCE_MS: "0", GITHUB_STEP_SUMMARY: "" }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("executed gate requires independent state for unfamiliar closings", () => {
  const state = summaryComment(stateBody);
  const opaque = summaryComment(receiptBody.replace(":rocket:", "Swish!"));
  for (const comments of [[state], [opaque, { ...state, body: state.body.replaceAll(answeredAt, "2026-10-15T22:00:00Z"), updated_at: "2026-10-15T22:00:00Z" }]]) {
    const result = runGate(comments);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codex Review passed/);
  }
  for (const comments of [[state, { ...opaque, created_at: "2026-10-15T22:00:00Z", updated_at: "2026-10-15T22:00:00Z" }], [state, opaque], [opaque], [{ ...state, updated_at: "2026-10-15T19:00:00Z" }],
    [state, { ...summaryComment(stateBody.replace('"completed"', '"running"')), updated_at: "2026-10-15T22:00:00Z" }],
    [state, summaryComment(receiptBody.replace(":rocket:", "P2 finding"))],
    [summaryComment(stateBody.replace('"status":null', '"status":"running"'))],
    [summaryComment(stateBody.replace('"code_review":', '"code_review":{},"code_review":'))]]) {
    assert.equal(runGate(comments).status, 1);
  }
});

test("latest malformed, negative or ambiguous summary supersedes clean state", () => {
  const run = (comments) => evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] }));
  const clean = summaryComment(stateBody);
  for (const body of [stateBody.replace("state:v1", "state:v2"), stateBody.replace('"completed"', '"pending"'), stateBody.replace('"commit_sha":"', '"commit_sha":"f'), stateBody + "\nP0: blocker", stateBody + "\n**Reviewed commit:** `abcdef0123`", stateBody.replace('"status":"completed"', '"status":"completed","status":"completed"')]) {
    const invalid = { ...summaryComment(body), id: 1 };
    assert.equal(run([clean, invalid]), "pending", body);
    assert.equal(run([invalid, clean]), "pending", body);
    assert.equal(run([clean, { ...invalid, updated_at: "2026-10-15T22:00:00Z" }]), "pending", body);
  }
});

test("visible contradictions and latest pending state veto positive formal review", () => {
  const reviews = [{ id: 1, commit_id: headSha, state: "COMMENTED", user: codexUser, submitted_at: answeredAt }];
  const run = (comments) => evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments], reviews }));
  for (const body of [stateBody.replace("## Codex Review Summary", "## Unknown Summary"), stateBody.replace("## Codex Review Summary", "## Codex Review Summary\nFound unresolved issues."), stateBody.replace("## Codex Review Summary", "## Codex Review Summary\nSecurity Review failed."), stateBody.replace("## Codex Review Summary", "## Codex Review Summary\nCode Review running."), stateBody.replace('"completed"', '"running"'), stateBody.replace('"status":null', '"status":"running"')]) {
    assert.equal(run([summaryComment(body)]), "pending", body);
  }
});

test("affirmative machine state never hides native P0-P2 findings", () => {
  for (const priority of [0, 1, 2]) {
    const reviews = [{ id: 1, commit_id: headSha, state: "COMMENTED", user: codexUser, submitted_at: answeredAt, body: `P${priority}: actionable finding` }];
    assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, summaryComment(stateBody)], reviews })), "fail");
  }
});

test("machine chronology does not interpret arbitrary prose as neutral", () => {
  const run = (comments) => evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] }));
  for (const suffix of ["Broken; avoid merging!", "Do not merge.", "A vulnerability remains.", "Needs work.", "No worries!"]) {
    const answer = summaryComment(receiptBody.replace(":rocket:", suffix));
    const newer = { ...summaryComment(stateBody.replaceAll(answeredAt, "2026-10-15T22:00:00Z")), id: 99, updated_at: "2026-10-15T22:00:00Z" };
    assert.equal(run([answer]), "pending", suffix);
    assert.equal(run([answer, newer]), "pass", suffix);
    assert.equal(run([summaryComment(stateBody), { ...answer, created_at: "2026-10-15T22:00:00Z", updated_at: "2026-10-15T22:00:00Z" }]), "pending", suffix);
    assert.equal(run([summaryComment(stateBody), answer]), "pending", suffix);
  }
});

test("security-only edits cannot renew code completion or supersede later receipts", () => {
  const run = (comments) => evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] }));
  const state = summaryComment(stateBody);
  const unknown = { ...summaryComment(receiptBody.replace(":rocket:", "Swish!")), created_at: "2026-10-15T21:30:00Z", updated_at: "2026-10-15T21:30:00Z" };
  const securityOnly = { ...state, updated_at: "2026-10-15T22:00:00Z" };
  assert.equal(run([unknown, securityOnly]), "pending");
  const staleCode = { ...securityOnly, body: state.body.replaceAll(answeredAt, "2026-10-15T19:00:00Z") };
  assert.equal(run([staleCode]), "pending");
  // Real native rows carry subsecond timestamps but GitHub's updated_at is
  // truncated to seconds. Same-second unknown prose still wins conservatively.
  const fractional = { ...state, body: state.body.replaceAll(answeredAt, answeredAt.replace("Z", ".070069Z")) };
  assert.equal(run([fractional]), "pass");
  assert.equal(run([fractional, summaryComment(receiptBody.replace(":rocket:", "Swish!"))]), "pending");
  const future = { ...state, body: state.body.replaceAll(answeredAt, "2026-10-15T23:00:00Z") };
  assert.equal(run([future]), "pending");
});

test("same-second request/completion ambiguity and impossible dates fail closed", () => {
  const run = (comments) => evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] }));
  const ambiguous = { ...summaryComment(stateBody.replaceAll(answeredAt, requestedAt.replace("Z", ".070069Z"))), updated_at: requestedAt };
  assert.equal(run([ambiguous]), "pending");
  const impossible = { ...summaryComment(stateBody.replaceAll(answeredAt, "2026-02-30T21:00:00Z")), updated_at: "2026-10-15T22:00:00Z" };
  assert.equal(isAffirmativeCodexReviewState(impossible, headSha, "2026-02-28T20:00:00Z", 10), false);
});


test("receipt edits cannot outrank newer pending or negative summaries", () => {
  const edited = { ...summaryComment(receiptBody), updated_at: "2026-10-15T23:00:00Z" };
  for (const status of ["running", "failed"]) {
    const pending = { ...summaryComment(stateBody.replace('"completed"', JSON.stringify(status))), updated_at: "2026-10-15T22:00:00Z" };
    const comments = [edited, pending];
    assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pending");
    assert.equal(runGate(comments).status, 1);
  }
  const old = { ...edited, created_at: "2026-10-15T19:00:00Z" };
  const comments = [old, summaryComment(stateBody)];
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pass", "editing a pre-request receipt does not rebind it");
});


test("editing unknown receipt text invalidates an older clean completion", () => {
  const state = { ...summaryComment(stateBody.replaceAll(answeredAt, "2026-10-15T22:00:00Z")), updated_at: "2026-10-15T22:00:00Z" };
  const answer = summaryComment(receiptBody.replace(":rocket:", "Broken; avoid merging!"));
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, answer, state] })), "pass");
  for (const created_at of [answer.created_at, "2026-10-15T19:00:00Z"]) {
    const comments = [state, { ...answer, created_at, updated_at: "2026-10-15T23:00:00Z" }];
    assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pending");
    assert.equal(runGate(comments).status, 1);
  }
});


test("same-second receipts preceding the request cannot veto a fresh answer", () => {
  const previous = { ...summaryComment(receiptBody), id: 9, created_at: requestedAt };
  const comments = [previous, summaryComment(receiptBody)];
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pass");
  assert.equal(runGate(comments).status, 0);
  const current = { ...previous, id: 11 };
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, current] })), "pass", "later numeric ID proves same-second freshness");
});


test("a fresh completion supersedes an eligible pre-request receipt edit", () => {
  const edited = { ...summaryComment(receiptBody.replace(":rocket:", "Swish!")), created_at: "2026-10-15T19:00:00Z", updated_at: "2026-10-15T21:30:00Z" };
  const state = { ...summaryComment(stateBody.replaceAll(answeredAt, "2026-10-15T22:00:00Z")), updated_at: "2026-10-15T22:00:00Z" };
  const comments = [edited, state];
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pass");
  assert.equal(runGate(comments).status, 0);
  edited.updated_at = "2026-10-15T23:00:00Z";
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pending");
  assert.equal(runGate(comments).status, 1);
});


test("a mutable summary edit tied with the request stays pending despite its old ID", () => {
  const updated = { ...summaryComment(stateBody.replace('"completed"', '"running"')), id: 9, created_at: "2026-10-15T19:00:00Z", updated_at: requestedAt };
  const answer = { ...summaryComment(receiptBody), id: 11, created_at: requestedAt, updated_at: requestedAt };
  const comments = [updated, answer];
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pending", "the lower ID dates creation, not the edit within this second");
  assert.equal(runGate(comments).status, 1);
});


test("a later completion supersedes an ambiguous same-second receipt edit", () => {
  const edited = { ...summaryComment(receiptBody.replace(":rocket:", "Swish!")), id: 9, created_at: "2026-10-15T19:00:00Z", updated_at: requestedAt };
  const comments = [edited];
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pending");
  comments.push(summaryComment(stateBody));
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments] })), "pass");
  assert.equal(runGate(comments).status, 0);
});


test("formal clean reviews supersede only strictly older pending comment evidence", () => {
  const reviews = [{ id: 200, commit_id: headSha, state: "COMMENTED", user: codexUser, submitted_at: "2026-10-15T22:00:00Z" }];
  for (const body of [stateBody.replace('"completed"', '"running"'), stateBody.replace('"code_review":', '"code_review":broken')]) {
    for (const [updated_at, expected] of [["2026-10-15T21:30:00Z", "pass"], ["2026-10-15T22:00:00Z", "pending"], ["2026-10-15T23:00:00Z", "pending"]]) {
      const comments = [{ ...summaryComment(body), updated_at }];
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments], reviews })), expected);
      assert.equal(runGate(comments, reviews).status, expected === "pass" ? 0 : 1);
    }
  }
  const comments = [summaryComment(receiptBody + "\nExtra line.")];
  assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments], reviews })), "pending", "formal proof never hides malformed receipt envelopes");
});


test("formal code approval cannot clear explicit structured code or security findings", () => {
  const reviews = [{ id: 200, commit_id: headSha, state: "COMMENTED", user: codexUser, submitted_at: "2026-10-15T23:00:00Z" }];
  for (const section of ["code_review", "security_review"]) {
    for (const field of ["has_any_findings", "has_unresolved_findings"]) {
      const body = (section === "security_review" ? withSecurityProof(stateBody) : stateBody).replace(new RegExp('("' + section + '":\\{[^}]*"' + field + '":)(?:false|null)'), '$1true');
      const negative = summaryComment(body);
      const comments = [negative];
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments], reviews })), "pending", section + field);
      assert.equal(runGate(comments, reviews).status, 1);
      const laterReceipt = { ...summaryComment(receiptBody), created_at: "2026-10-15T22:00:00Z", updated_at: "2026-10-15T22:00:00Z" };
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments, laterReceipt] })), "pending", "code receipt cannot revise explicit structured security/code findings");
      comments.push({ ...summaryComment(stateBody.replace('"completed"', '"running"')), updated_at: "2026-10-15T22:00:00Z" });
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments], reviews })), "pending", "a later pending summary cannot clear findings either");
      comments.push({ ...summaryComment((section === "security_review" ? withSecurityProof(stateBody) : stateBody).replaceAll(answeredAt, "2026-10-15T22:30:00Z")), updated_at: "2026-10-15T22:30:00Z" });
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [command, ...comments], reviews })), "pass", "newer affirmative structured proof clears the previous finding");
    }
  }
});

function withSecurityProof(body) {
  const match = body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  const state = JSON.parse(match[1]);
  state.security_review = { ...state.code_review };
  const row = body.match(/^\| 📝 \*\*Code Review\*\*.*$/m)?.[0];
  return body.replace(match[1], JSON.stringify(state)).replace(row, row + "\n" + row.replace("📝 **Code Review**", "🛡️ **Security Review**"));
}


test("same-head repeated requests retain typed findings until matching newer machine proof", () => {
  const repeatedAt = "2026-10-15T22:00:00Z";
  const repeated = { ...command, id: 100, created_at: repeatedAt };
  const reviews = [{ id: 200, commit_id: headSha, state: "COMMENTED", user: codexUser, submitted_at: "2026-10-15T23:00:00Z" }];
  const answer = { ...summaryComment(receiptBody), created_at: "2026-10-15T23:00:00Z", updated_at: "2026-10-15T23:00:00Z" };
  for (const section of ["code_review", "security_review"]) {
    for (const field of ["has_any_findings", "has_unresolved_findings"]) {
      const source = section === "security_review" ? withSecurityProof(stateBody) : stateBody;
      const body = source.replace(new RegExp('("' + section + '":\\{[^}]*"' + field + '":)(?:false|null)'), '$1true');
      const encodedNegative = body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/)[1];
      for (const formattedBody of ["<!-- TODO -->\n" + body, body.replace(encodedNegative, JSON.stringify(JSON.parse(encodedNegative), null, 2)), body + "\n<!-- TODO -->", body.replace("<!-- codex-review-state:", "<!-- TODO -->\n<!-- codex-review-state:")]) {
        const formatted = summaryComment(formattedBody);
        assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, formatted, answer], reviews })), "pending", "valid typed historical findings survive JSON whitespace and unrelated HTML comments");
        assert.equal(runGate([repeated, formatted, answer], reviews).status, 1);
      }
      const comments = [summaryComment(body), answer];
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pending", section + field);
      assert.equal(runGate([repeated, ...comments], reviews).status, 1);
      const priorClean = { ...summaryComment(withSecurityProof(stateBody).replaceAll(answeredAt, "2026-10-15T21:30:00Z")), updated_at: "2026-10-15T21:30:00Z" };
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, comments[0], priorClean] })), "pending", "historical clean proof alone cannot approve a new request");
      for (const contradiction of ["P1 regression", "Found issues.", "Security Review failed."]) {
        comments.push({ ...priorClean, body: priorClean.body.replace("## Codex Review Summary", "## Codex Review Summary\n" + contradiction) });
        assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pending", "contradictory historical presentation cannot clear findings");
        assert.equal(runGate([repeated, ...comments], reviews).status, 1);
        comments.pop();
      }
      {
        const ownLabel = section === "code_review" ? "Code Review" : "Security Review";
        const mismatched = priorClean.body.split("\n").map((line) => line.includes("**" + ownLabel + "**") ? line.replace(/`[a-f0-9]{7,40}`/, "`fffffff`") : line).join("\n");
        comments.push({ ...priorClean, body: mismatched });
        assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pending", "own-section row SHA must match typed current head");
        assert.equal(runGate([repeated, ...comments], reviews).status, 1);
        comments.pop();
      }
      comments.push(priorClean);
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pass", "a repeated request does not resurrect a finding already cleared before it");
      assert.equal(runGate([repeated, ...comments], reviews).status, 0);
      comments.pop();
      {
        const encoded = priorClean.body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/)[1];
        const state = JSON.parse(encoded);
        const other = section === "code_review" ? "security_review" : "code_review";
        state[other].has_any_findings = true;
        const label = other === "code_review" ? "Code Review" : "Security Review";
        const scoped = { ...priorClean, body: priorClean.body.replace(encoded, JSON.stringify(state)).split("\n").map((line) => line.includes("**" + label + "**") ? line.replace("Manual request", "Manual request P1") : line).join("\n") };
        const recoveryState = JSON.parse(encoded);
        recoveryState[section] = { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null };
        const ownLabel = section === "code_review" ? "Code Review" : "Security Review";
        const recovery = { ...priorClean, updated_at: "2026-10-15T21:45:00Z", body: priorClean.body.replace(encoded, JSON.stringify(recoveryState)).split("\n").filter((line) => !line.includes("**" + ownLabel + "**")).join("\n").replaceAll("2026-10-15T21:30:00Z", "2026-10-15T21:45:00Z") };
        comments.push(scoped, recovery);
        assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pass", "severity in a validated other-section row does not discard independent clearing");
        assert.equal(runGate([repeated, ...comments], reviews).status, 0);
        comments.splice(-2);
      }
      for (const status of [null, "running"]) {
        const encoded = priorClean.body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/)[1];
        const state = JSON.parse(encoded);
        const other = section === "code_review" ? "security_review" : "code_review";
        state[other] = { commit_sha: status ? state[other].commit_sha : null, has_any_findings: null, has_unresolved_findings: null, status };
        const label = other === "code_review" ? "Code Review" : "Security Review";
        const partial = { ...priorClean, body: priorClean.body.replace(encoded, JSON.stringify(state)).split("\n").filter((line) => !line.includes("**" + label + "**")).join("\n") };
        comments.push(partial);
        assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pass", "valid section-specific clearing survives a repeated request");
        assert.equal(runGate([repeated, ...comments], reviews).status, 0);
        comments.pop();
      }
      comments.push({ ...summaryComment(stateBody.replaceAll(answeredAt, "2026-10-15T23:30:00Z")), updated_at: "2026-10-15T23:30:00Z" });
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), section === "security_review" ? "pending" : "pass", "null security is not security completion");
      if (section === "security_review") {
        for (const transform of [(body) => body.replace(/^\| 🛡️ \*\*Security Review\*\*.*$/m, ""), (body) => body.replace(/(🛡️ \*\*Security Review\*\*.*)/, (row) => row.replaceAll("2026-10-15T23:45:00Z", answeredAt))]) {
          comments.push({ ...summaryComment(transform(withSecurityProof(stateBody).replaceAll(answeredAt, "2026-10-15T23:45:00Z"))), updated_at: "2026-10-15T23:45:00Z" });
          assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pending", "missing or stale security completion cannot clear findings");
        }
      }
      comments.push({ ...summaryComment(withSecurityProof(stateBody).replaceAll(answeredAt, "2026-10-16T00:00:00Z")), updated_at: "2026-10-16T00:00:00Z" });
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pass");
      assert.equal(runGate([repeated, ...comments], reviews).status, 0);
      comments[0].updated_at = "2026-10-16T01:00:00Z";
      assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pass", "unrelated summary edits cannot renew an older section finding");
      if (section === "code_review") {
        const original = comments[0].body;
        const encoded = original.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/)[1];
        const state = JSON.parse(encoded);
        state.security_review = { commit_sha: headSha, has_any_findings: null, has_unresolved_findings: null, status: "running" };
        comments[0].body = original.replace(encoded, JSON.stringify(state));
        assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pending", "new running security state retains update-time ordering");
        comments[0].body = original;
      }
      assert.equal(runGate([repeated, ...comments], reviews).status, 0);
    }
  }
});

test("historical malformed and foreign-head state cannot become persistent finding vetoes", () => {
  const repeatedAt = "2026-10-15T22:00:00Z";
  const repeated = { ...command, id: 100, created_at: repeatedAt };
  const reviews = [{ id: 200, commit_id: headSha, state: "COMMENTED", user: codexUser, submitted_at: "2026-10-15T23:00:00Z" }];
  const answer = { ...summaryComment(receiptBody), created_at: "2026-10-15T23:00:00Z", updated_at: "2026-10-15T23:00:00Z" };
  const negative = stateBody.replace('"has_any_findings":false', '"has_any_findings":true');
  const securityNegative = withSecurityProof(stateBody).replace(/("security_review":\{[^}]*"has_any_findings":)false/, "$1true");
  for (const body of ["```json\n" + negative + "\n```", negative.split("\n").map((line) => "> " + line).join("\n"), securityNegative.replace(/^\| 🛡️ \*\*Security Review\*\*.*$/m, ""), securityNegative.replace(/(🛡️ \*\*Security Review\*\*.*datetime=")[^"]+/, "$1invalid"), negative.replace('state:v1', 'state:v2'), negative.replace('"code_review":', '"code_review":broken'), negative.replace('"code_review":', '"code_review":{},"code_review":'), negative + "\n<!-- codex-unknown -->", negative.replaceAll(headSha, "f".repeat(40)).replaceAll(headSha.slice(0, 7), "f".repeat(7))]) {
    const comments = [summaryComment(body), answer];
    assert.equal(evaluateCodexReviewEvidence(evidence({ comments: [repeated, ...comments], reviews })), "pass", body);
    assert.equal(runGate([repeated, ...comments], reviews).status, 0);
  }
});

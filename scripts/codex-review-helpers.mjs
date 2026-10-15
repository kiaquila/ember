/* Pure helpers behind the Codex Review gate: who may ask for a review, what
   counts as Codex's answer, and whether that answer blocks the pull request.
   Kept free of I/O so the gate's rules can be tested directly. */

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CODEX_REVIEW_LOGIN = "chatgpt-codex-connector[bot]";

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function compareNumericIds(left, right) {
  if (!/^\d+$/.test(String(left || "")) || !/^\d+$/.test(String(right || ""))) return 0;
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId === rightId ? 0 : leftId > rightId ? 1 : -1;
}

export function isTrustedAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(String(value || "").toUpperCase());
}

export function isTrustedCodexLogin(login) {
  return normalize(login) === CODEX_REVIEW_LOGIN;
}

export function isCodexReviewCommand(body) {
  return /(?:^|\s)@codex\s+review\b/i.test(String(body || ""));
}

/* The full head SHA has to be written out: a bare "@codex review" would keep
   vouching for whatever the branch looked like later. */
export function isCodexReviewCommandForHead(body, headSha) {
  const requestedHead = String(body || "").match(
    /(?:^|\s)@codex\s+review\s+`?([a-f0-9]{40})`?\b/i
  )?.[1];
  return Boolean(requestedHead) && normalize(requestedHead) === normalize(headSha);
}

export function isStrictlyAfterCodexReviewRequest(value, request) {
  const valueTime = Date.parse(value || "");
  const requestedAt = Date.parse(request?.requestedAt || "");
  return Number.isFinite(valueTime) && Number.isFinite(requestedAt) && valueTime > requestedAt;
}

/** The newest trusted "@codex review <head>" comment, or null if none exists.
    This is the gate's whole trust model: a human with write access naming the
    exact commit they are vouching for. */
export function latestTrustedCodexReviewCommand(comments = [], headSha) {
  return comments
    .filter((comment) =>
      comment?.user?.type !== "Bot" &&
      isTrustedAssociation(comment?.author_association) &&
      isCodexReviewCommandForHead(comment?.body, headSha)
    )
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""))
    .map((comment) => ({
      sha: headSha,
      commentId: String(comment.id || ""),
      requestedAt: comment.created_at
    }))[0] || null;
}

export function extractCodexPriority(body) {
  const match = String(body || "").match(/\bP([0-3])\b/i);
  return match ? Number(match[1]) : null;
}

export function containsBlockingCodexSeverity(body) {
  return /\bP[0-2]\b/i.test(String(body || ""));
}

/** "pass", "fail", or null when the review does not answer for this head. */
export function classifyCodexNativeReview(review, reviewComments = [], headSha) {
  if (!review || review.commit_id !== headSha) return null;
  if (!isTrustedCodexLogin(review.user?.login)) return null;
  if (containsBlockingCodexSeverity(review.body)) return "fail";
  if (review.state === "CHANGES_REQUESTED") return "fail";

  const commentsForReview = reviewComments.filter((comment) =>
    comment.pull_request_review_id === review.id &&
    isTrustedCodexLogin(comment.user?.login)
  );
  if (commentsForReview.length > 0) {
    const priorities = commentsForReview.map((comment) => extractCodexPriority(comment.body));
    /* An unlabelled finding is treated as blocking: the gate must not pass a
       comment it could not grade. */
    if (priorities.some((priority) => priority === null)) return "fail";
    if (commentsForReview.some((comment) => containsBlockingCodexSeverity(comment.body))) return "fail";
  }

  return review.state === "APPROVED" || review.state === "COMMENTED" ? "pass" : null;
}

export function latestCodexNativeReviewResult(reviews = [], reviewComments = [], headSha) {
  return reviews
    .map((review) => ({ review, result: classifyCodexNativeReview(review, reviewComments, headSha) }))
    .filter((entry) => entry.result !== null)
    .sort((left, right) => {
      const bySubmissionTime = Date.parse(right.review.submitted_at || "") -
        Date.parse(left.review.submitted_at || "");
      return bySubmissionTime || compareNumericIds(right.review.id, left.review.id);
    })[0]?.result || null;
}

/** Codex reports "no findings" as a plain comment rather than a review, so
    that shape is accepted too - but only for this head and only after the
    request it answers. */
export function isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId) {
  const body = String(comment?.body || "").trim();
  if (!/^[a-f0-9]{40}$/i.test(String(headSha || ""))) return false;
  /* Match one complete answer, not a positive line embedded in findings or
     duplicated receipts. The optional details block is GitHub boilerplate. */
  const answer = body.match(
    /^(?:<!-- codex-review-receipt:v1 -->\s+)?Codex Review: Didn't find any major issues\.(?: :rocket:| Keep it up!)?\s+\*\*Reviewed commit:\*\* `([a-f0-9]{10})`(?:\s+<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>)?$/i
  );
  if (!answer || (body.match(/<!-- codex-review-/gi) || []).length > 1 ||
      (body.match(/\*\*Reviewed commit:/gi) || []).length !== 1 ||
      containsBlockingCodexSeverity(body)) return false;
  const shortSha = String(headSha || "").slice(0, 10);
  const commentCreatedAt = Date.parse(comment?.created_at || "");
  const requestTime = Date.parse(requestedAt || "");
  /* Same-second comments are ordered by id, which GitHub assigns in order. */
  const ordering = commentCreatedAt === requestTime
    ? compareNumericIds(comment?.id, requestCommentId) > 0
    : commentCreatedAt > requestTime;
  const isAfterRequest = !requestedAt ||
    (Number.isFinite(commentCreatedAt) && Number.isFinite(requestTime) && ordering);
  return isAfterRequest &&
    isTrustedCodexLogin(comment?.user?.login) &&
    normalize(answer[1]) === normalize(shortSha);
}

/** Summary/state HTML markers wake the gate but never supply a verdict. */
export function isCodexReviewWakeupComment(body) {
  return /^(?:Codex Review:|<!-- codex-review-receipt:v1 -->|<!-- codex-pull-request-review-summary -->)/i
    .test(String(body || ""));
}

export function evaluateCodexReviewEvidence({ comments, reviews, reviewComments, threads, headSha }) {
  /* A new request must not erase existing findings, including outdated and
     P3 threads. Resolved state comes from GitHub, not comment prose. */
  if (threads.some((thread) => !thread.isResolved &&
      thread.comments.nodes.some((comment) => comment.author?.__typename === "Bot" &&
        comment.author.login === "chatgpt-codex-connector"))) return "fail";
  /* Body-only findings have no resolvable thread. A later clean review or
     request on the same tree cannot prove that their cause was fixed. */
  if (reviews.some((review) => classifyCodexNativeReview(review, [], headSha) === "fail")) return "fail";
  if (latestCodexNativeReviewResult(reviews, reviewComments, headSha) === "fail") return "fail";

  const request = latestTrustedCodexReviewCommand(comments, headSha);
  if (!request) return "missing_request";
  const afterRequest = reviews.filter((review) =>
    isStrictlyAfterCodexReviewRequest(review.submitted_at, request));
  const nativeResult = latestCodexNativeReviewResult(afterRequest, reviewComments, headSha);
  if (nativeResult) return nativeResult;
  return comments.some((comment) => isAcceptableCodexSummaryComment(
    comment, headSha, request.requestedAt, request.commentId
  )) ? "pass" : "pending";
}

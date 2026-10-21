/* Pure helpers behind the Codex Review gate: who may ask for a review, what
   counts as Codex's answer, and whether that answer blocks the pull request.
   Kept free of I/O so the gate's rules can be tested directly. */

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CODEX_REVIEW_LOGIN = "chatgpt-codex-connector[bot]";
const POSITIVE_RECEIPT_SUFFIXES = new Set([
  "", ":rocket:", ":tada:", "🚀", "🎉", "👍", "keep it up!", "hooray!",
  "more of your lovely prs please.", "nice work!", "great work!", "great job!",
  "well done!", "looks good!", "looking good!", "you're on fire!", "you’re on fire!",
  "you rock!", "keep up the good work!", "happy merging!", "all good!", "ship it!",
  "another round soon, please!", "you're on a roll.", "you’re on a roll.",
  "already looking forward to the next diff.", "breezy!",
  "what shall we delve into next?", "can't wait for the next one!", ":+1:"
]);

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
    /^(?:<!-- codex-review-receipt:v1 -->\s+)?Codex Review: Didn't find any major issues\.([^\r\n]*)\s+\*\*Reviewed commit:\*\* `([a-f0-9]{10})`(?:\s+<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>)?$/i
  );
  if (!answer || (body.match(/<!-- codex-review-/gi) || []).length > 1 ||
      (body.match(/\*\*Reviewed commit:/gi) || []).length !== 1 ||
      containsBlockingCodexSeverity(body)) return false;
  /* Only known positive decorations may qualify the explicit verdict.
     Unknown prose must not turn a provisional answer into a passing gate. */
  if (!POSITIVE_RECEIPT_SUFFIXES.has(normalize(answer[1]))) return false;
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
    normalize(answer[2]) === normalize(shortSha);
}

/** Prefix routing wakes the gate; complete machine state is validated below. */
export function isCodexReviewWakeupComment(body) {
  return /^(?:Codex Review:|<!-- codex-review-receipt:v1 -->|<!-- codex-pull-request-review-summary -->)/i
    .test(String(body || ""));
}

function codeReviewCompletedAt(body, headSha, section = "code_review") {
  if (section === "security_review") body = body.replaceAll("📝 **Code Review**", "ignored-code-row").replaceAll("🛡️ **Security Review**", "📝 **Code Review**");
  const rows = [...body.matchAll(/^\| 📝 \*\*Code Review\*\* \| ✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">([^<]+)<\/relative-time> \| `([a-f0-9]{7,40})` \| [^|\r\n]+ \|$/gm)];
  if (rows.length !== 1 || (body.match(/\*\*Code Review\*\*/g) || []).length !== 1) return NaN;
  const [, timestamp, visibleTime, sha] = rows[0];
  if (timestamp !== visibleTime || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(timestamp) || !headSha.startsWith(sha)) return NaN;
  const completed = Date.parse(timestamp);
  return Number.isFinite(completed) && new Date(completed).toISOString().slice(0, 19) === timestamp.slice(0, 19) ? completed : NaN;
}

/** Affirmative machine evidence has a closed schema and the full current SHA.
 * Prose, reactions and the visible Completed heading never grant approval. */
function hasIndentedProtocolMarkers(rawBody) {
  // Indented Markdown code is not an active protocol envelope. Check before trim.
  for (const marker of rawBody.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (!/^codex[-:]/.test(marker[1].trim())) continue;
    const prefix = rawBody.slice(rawBody.lastIndexOf("\n", marker.index - 1) + 1, marker.index);
    if (/^[ \t]*$/.test(prefix) && (prefix.includes("\t") || prefix.length >= 4)) return true;
  }
  return false;
}

export function isAffirmativeCodexReviewState(comment, headSha, requestedAt, requestCommentId) {
  if (!isTrustedCodexLogin(comment?.user?.login) || !/^[a-f0-9]{40}$/.test(headSha)) return false;
  if (hasIndentedProtocolMarkers(String(comment?.body || ""))) return false;
  const body = String(comment?.body || "").trim();
  const match = body.match(/^<!-- codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  if (!match || (body.match(/<!--/g) || []).length !== 2 ||
      (body.match(/codex-review-state:/g) || []).length !== 1 ||
      (body.match(/codex-pull-request-review-summary/g) || []).length !== 1 ||
      /Codex Review:|\*\*Reviewed commit:|\bP[0-2]\b/i.test(body)) return false;
  const presentation = body.slice(match[0].length).replace(/\s*<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>\s*$/, "");
  if (!/^\s*## Codex Review Summary\b/.test(presentation) ||
      /<details>|<summary>|\b(?:found|unresolved|issues?|findings?|failed|failure|running|pending|cancelled|incomplete|in.progress|not.completed|changes.requested|security.concerns?)\b/i.test(presentation)) return false;
  if ([...presentation.matchAll(/\b[a-f0-9]{7,40}\b/gi)].some(([sha]) => !headSha.startsWith(sha))) return false;
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  const requested = Date.parse(requestedAt || "");
  const completed = codeReviewCompletedAt(body, headSha);
  if (!Number.isFinite(completed) || Math.floor(completed / 1000) <= Math.floor(requested / 1000) || completed >= observed + 1000 ||
      !Number.isFinite(observed) || !Number.isFinite(requested) ||
      !(observed > requested || (observed === requested && compareNumericIds(comment.id, requestCommentId) > 0))) return false;
  try {
    const state = JSON.parse(match[1]);
    const keys = Object.keys(state);
    if (keys.length !== 2 || !keys.includes("code_review") || !keys.includes("security_review")) return false;
    // Count decoded property names as well: JSON.parse alone accepts duplicate
    // keys, including keys escaped with Unicode sequences.
    const names = [...match[1].matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map((entry) => JSON.parse(entry[1]));
    const expected = { code_review: 1, security_review: 1, commit_sha: 2, has_any_findings: 2, has_unresolved_findings: 2, status: 2 };
    if (names.length !== 10 || Object.entries(expected).some(([key, count]) => names.filter((name) => name === key).length !== count)) return false;
    const closed = (value) => value && !Array.isArray(value) && Object.keys(value).length === 4 &&
      ["commit_sha", "has_any_findings", "has_unresolved_findings", "status"].every((key) => Object.hasOwn(value, key));
    const complete = (value) => closed(value) && value.commit_sha === headSha && value.status === "completed" &&
      value.has_any_findings === false && value.has_unresolved_findings === false;
    const absent = (value) => closed(value) && Object.values(value).every((entry) => entry === null);
    return complete(state.code_review) && (absent(state.security_review) || complete(state.security_review));
  } catch { return false; }
}

// Historical findings must be well-formed typed state for this exact head;
// stale malformed/foreign-head summaries are not persistent vetoes.
function typedCodexReviewState(comment) {
  const rawBody = String(comment.body || "");
  if (hasIndentedProtocolMarkers(rawBody)) return null;
  const body = rawBody.trim();
  const envelope = body.replace(/<!--([\s\S]*?)-->/g, (marker, content) => /^codex[-:]/.test(content.trim()) ? marker : "").trim();
  const match = envelope.match(/^<!-- codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (\{[\s\S]*?\}) -->\s*## Codex Review Summary\b/);
  const protocol = [...body.matchAll(/<!--([\s\S]*?)-->/g)].filter((entry) => /^codex[-:]/.test(entry[1].trim()));
  if (!match || protocol.length !== 2 ||
      (body.match(/<!-- codex-pull-request-review-summary -->/g) || []).length !== 1 ||
      !/^## Codex Review Summary\b/m.test(body) ||
      /Codex Review:|\*\*Reviewed commit:/.test(body)) return null;
  try {
    const state = JSON.parse(match[1]);
    const names = [...match[1].matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map((entry) => JSON.parse(entry[1]));
    const expected = { code_review: 1, security_review: 1, commit_sha: 2, has_any_findings: 2, has_unresolved_findings: 2, status: 2 };
    if (names.length !== 10 || Object.entries(expected).some(([key, count]) => names.filter((name) => name === key).length !== count) ||
        Object.keys(state).length !== 2) return null;
    const valid = (value) => value && !Array.isArray(value) && Object.keys(value).length === 4 &&
      ["commit_sha", "has_any_findings", "has_unresolved_findings", "status"].every((key) => Object.hasOwn(value, key)) &&
      (Object.values(value).every((entry) => entry === null) ||
        (/^[a-f0-9]{40}$/.test(value.commit_sha) &&
          ((value.status === "completed" && typeof value.has_any_findings === "boolean" && typeof value.has_unresolved_findings === "boolean") ||
           (value.status === "running" && value.has_any_findings === null && value.has_unresolved_findings === null))));
    if (!valid(state.code_review) || !valid(state.security_review)) return null;
    for (const section of ["code_review", "security_review"]) {
      if (state[section].status !== "completed") continue;
      const completed = codeReviewCompletedAt(body, state[section].commit_sha, section);
      const observed = Date.parse(comment.updated_at || comment.created_at || "");
      if (!Number.isFinite(completed) || !Number.isFinite(observed) || completed >= observed + 1000) return null;
    }
    return state;
  } catch { return null; }
}

// Validate a section's clearing proof with the same presentation checks as
// approval, while allowing an independently pending/absent other section.
function isSectionClearingState(comment, section, headSha) {
  const state = typedCodexReviewState(comment);
  const body = String(comment.body || "");
  if (!state) return false;
  const encodedMatch = body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  if (!encodedMatch) return false;
  const encoded = encodedMatch[1];
  const absent = { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null };
  const other = section === "code_review" ? "Security Review" : "Code Review";
  const otherSection = section === "code_review" ? "security_review" : "code_review";
  const otherPrefix = "| " + (other === "Code Review" ? "📝" : "🛡️") + " **" + other + "** | ";
  // Only a unique validated completed counterpart row scopes its severity.
  // Global prose and unvalidated rows remain ambiguous vetoes.
  const severityBody = state[otherSection].status === "completed"
    ? body.split("\n").filter((line) => !line.startsWith(otherPrefix)).join("\n") : body;
  if (/\bP[0-2]\b/i.test(severityBody)) return false;
  let normalized = body.replace(encoded, JSON.stringify({ code_review: state[section], security_review: absent }))
    .split("\n").filter((line) => !line.startsWith("| " + (other === "Code Review" ? "📝" : "🛡️") + " **" + other + "** | ")).join("\n");
  if (section === "security_review") normalized = normalized.replaceAll("🛡️ **Security Review**", "📝 **Code Review**");
  return isAffirmativeCodexReviewState({ ...comment, body: normalized }, headSha, "1970-01-01T00:00:00Z", 0);
}

function findingCompletedAt(comment, section, headSha) {
  const completed = codeReviewCompletedAt(String(comment.body || ""), headSha, section);
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  return Number.isFinite(completed) && completed <= observed + 999 ? completed : observed;
}

function latestCodexCommentResult(comments, headSha, requestedAt, requestCommentId, nativeCompletedAt = NaN) {
  const signals = comments.filter((comment) => isTrustedCodexLogin(comment?.user?.login));
  const summaries = signals.filter((comment) => /codex-pull-request-review-summary|codex-review-state:/.test(String(comment.body || "")) &&
    Date.parse(comment.updated_at || comment.created_at || "") >= Date.parse(requestedAt || ""));
  summaries.sort((a, b) => (Date.parse(b.updated_at || b.created_at || "") || 0) -
    (Date.parse(a.updated_at || a.created_at || "") || 0) || compareNumericIds(b.id, a.id));
  const receiptObservedAt = (comment) => Date.parse(isAcceptableCodexSummaryComment(comment, headSha)
    ? comment.created_at || "" : comment.updated_at || comment.created_at || "");
  const receipts = signals.filter((comment) => /Codex Review:|codex-review-receipt:/.test(String(comment.body || "")) &&
    (isAcceptableCodexSummaryComment(comment, headSha)
      ? isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId)
      : receiptObservedAt(comment) >= Date.parse(requestedAt || "")));
  const isReceiptCandidate = (comment) => {
    const body = String(comment.body || "");
    const match = body.match(/(Codex Review: Didn't find any major issues\.)([^\r\n]*)/);
    if (!match || (match[2] && !match[2].startsWith(" ")) || match[2].length > 121 ||
        (body.match(/Codex Review:/g) || []).length !== 1 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>{}\[\]`*=\\/|]/u.test(match[2]) ||
        /\b[a-f0-9]{7,40}\b/i.test(match[2]) || containsBlockingCodexSeverity(body)) return false;
    return isAcceptableCodexSummaryComment({ ...comment, body: body.replace(match[0], match[1]) }, headSha);
  };
  // Unknown closings remain pending evidence. Only a strictly newer complete
  // machine summary supersedes one; a later receipt needs a fresh summary.
  // Malformed envelopes and explicit P0-P2 findings remain unconditional vetoes.
  if (receipts.some((comment) => !isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId) && !isReceiptCandidate(comment))) return "pending";
  const candidates = [...summaries, ...receipts];
  const observed = (comment) => {
    const state = typedCodexReviewState(comment);
    const findings = ["code_review", "security_review"].filter((section) => state?.[section]?.commit_sha === headSha &&
      (state[section].has_any_findings === true || state[section].has_unresolved_findings === true));
    if (findings.length && ![state.code_review, state.security_review].some((value) => value.status === "running")) return Math.max(...findings.map((section) => findingCompletedAt(comment, section, headSha)));
    return summaries.includes(comment) &&
    isAffirmativeCodexReviewState(comment, headSha, requestedAt, requestCommentId)
    ? codeReviewCompletedAt(String(comment.body || ""), headSha)
    : summaries.includes(comment) ? Date.parse(comment.updated_at || comment.created_at || "") : receiptObservedAt(comment);
  };
  // Positive receipt edits never renew approval. Unknown or negative edits
  // retain their update time so they can invalidate an older completion.
  // GitHub comment timestamps have second precision while completion rows
  // include microseconds. Compare second buckets so uncertainty stays pending.
  const bucket = (comment) => Math.floor(observed(comment) / 1000);
  const latestTime = Math.max(...candidates.map(bucket));
  // A strictly newer formal clean review is independent affirmative evidence.
  // Same-second ambiguity and newer pending comments still prevent approval.
  const sections = ["code_review", "security_review"];
  // Historical clean proof only resolves historical findings; it cannot grant
  // current-request approval, which still uses candidates above.
  const cleanSummaries = signals.filter((comment) => typedCodexReviewState(comment));
  const lastAffirmativeTime = (section) => Math.max(...cleanSummaries.filter((comment) => {
    const value = typedCodexReviewState(comment)?.[section];
    return value?.commit_sha === headSha && value.status === "completed" &&
      value.has_any_findings === false && value.has_unresolved_findings === false &&
      isSectionClearingState(comment, section, headSha);
  }).map((comment) => {
    const completed = codeReviewCompletedAt(String(comment.body || ""), headSha, section);
    const observed = Date.parse(comment.updated_at || comment.created_at || "");
    return Number.isFinite(completed) && completed <= observed + 999 ? Math.floor(completed / 1000) : -Infinity;
  }));
  const historical = signals.filter((comment) => {
    const state = typedCodexReviewState(comment);
    return sections.some((section) => state?.[section]?.commit_sha === headSha &&
      (state[section].has_any_findings === true || state[section].has_unresolved_findings === true));
  });
  const findingSignals = [...new Set([...summaries, ...historical])];
  const unclearedFindings = findingSignals.some((comment) => {
    const state = typedCodexReviewState(comment);
    const observedBucket = Math.floor(Date.parse(comment.updated_at || comment.created_at || "") / 1000);
    if (state) return sections.some((section) => state[section].commit_sha === headSha &&
      (state[section].has_any_findings === true || state[section].has_unresolved_findings === true) &&
      Math.floor(findingCompletedAt(comment, section, headSha) / 1000) >= lastAffirmativeTime(section));
    // Malformed current-request negative evidence retains its existing veto.
    return summaries.includes(comment) && observedBucket >= Math.max(...summaries.filter((entry) => isAffirmativeCodexReviewState(entry, headSha, requestedAt, requestCommentId)).map(bucket)) &&
      [...String(comment.body || "").matchAll(/("(?:\\.|[^"\\])*")\s*:\s*(true|false|null)/g)].some((entry) => {
        if (entry[2] !== "true") return false;
        try { return ["has_any_findings", "has_unresolved_findings"].includes(JSON.parse(entry[1])); }
        catch { return true; }
      });
  });
  // Code-only formal approval cannot revise an explicit code/security finding.
  // Only a newer affirmative structured state clears that independent signal.
  if (unclearedFindings) return "pending";
  if (!candidates.length) return null;
  if (Math.floor(nativeCompletedAt / 1000) > latestTime) return "pass";
  const latest = candidates.filter((comment) => bucket(comment) === latestTime);
  return latest.every((comment) => summaries.includes(comment)
    ? isAffirmativeCodexReviewState(comment, headSha, requestedAt, requestCommentId)
    : isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId)) ? "pass" : "pending";
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
  if (nativeResult === "fail") return nativeResult;
  const nativeCompletedAt = nativeResult === "pass" ? Math.max(...afterRequest.filter((review) =>
    classifyCodexNativeReview(review, reviewComments, headSha) === "pass"
  ).map((review) => Date.parse(review.submitted_at || ""))) : NaN;
  const commentResult = latestCodexCommentResult(comments, headSha, request.requestedAt, request.commentId, nativeCompletedAt);
  return commentResult === "pending" ? "pending" : nativeResult || commentResult || "pending";
}

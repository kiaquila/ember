import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isAcceptableCodexSummaryComment, evaluateCodexReviewEvidence } from "../scripts/codex-review-helpers.mjs";
const corpus = JSON.parse(readFileSync(new URL("./fixtures/native-codex-corpus.json", import.meta.url), "utf8"));
const user = { login: "chatgpt-codex-connector[bot]" };
const evidence = (comments, headSha, requestedAt) => ({ comments: [{ id: 1, user: { login: "owner" }, author_association: "OWNER", body: "@codex review " + headSha, created_at: requestedAt }, ...comments], headSha, reviews: [], reviewComments: [], threads: [], requestMarker: { sourceCommentCreatedAt: requestedAt, sourceCommentId: 1 } });
test("all 19 observed native receipts retain exact author, head, body and request bounds", () => {
  assert.equal(corpus.cleanReplies.length, 19);
  for (const row of corpus.cleanReplies) {
    const comment = { id: 20, user, body: row.body, created_at: "2026-10-23T12:00:00Z", updated_at: "2026-10-23T12:00:00Z" };
    const requestedAt = "2026-10-23T11:59:00Z";
    assert.equal(isAcceptableCodexSummaryComment(comment, row.head, requestedAt, 1), true, row.closing);
    assert.equal(evaluateCodexReviewEvidence(evidence([comment], row.head, requestedAt)), "pass", row.closing);
    for (const body of [row.body + "\nA finding whose details remain open.", row.body.replace("Didn't find any major issues.", "Didn't find any major issues. A whimsical flourish."), row.body.replace(row.head.slice(0, 10), "f".repeat(10)), row.body.replace("https://chatgpt.com/s/", "https://example.test/s/")]) {
      if (body !== row.body) assert.equal(isAcceptableCodexSummaryComment({ ...comment, body }, row.head, requestedAt, 1), false, row.closing);
    }
    assert.equal(isAcceptableCodexSummaryComment({ ...comment, user: { login: "fake-codex[bot]" } }, row.head, requestedAt, 1), false);
  }
});
test("completed null lifecycle requires its bounded immutable independent receipt", () => {
  for (const pair of corpus.lifecyclePairs) {
    const completed = Date.parse(pair.lifecycle.body.match(/datetime="([^"]+)"/)[1]);
    const requestedAt = new Date(Date.parse(pair.receipt.created_at) - 60000).toISOString();
    const run = (comments) => evaluateCodexReviewEvidence(evidence(comments, pair.head, requestedAt));
    assert.equal(run([pair.lifecycle]), "pending", pair.repo);
    assert.equal(run([pair.lifecycle, pair.receipt]), "pass", pair.repo);
    assert.equal(run([pair.lifecycle, { ...pair.receipt, updated_at: new Date(Date.parse(pair.receipt.created_at) + 1000).toISOString() }]), "pending", "edited receipt cannot pair");
    const after = new Date(completed + 2000).toISOString();
    assert.equal(run([pair.lifecycle, { ...pair.receipt, created_at: after, updated_at: after }]), "pending", "receipt after completion is a different lifecycle");
    const before = new Date(Date.parse(pair.lifecycle.created_at) - 1000).toISOString();
    assert.equal(run([pair.lifecycle, { ...pair.receipt, created_at: before, updated_at: before }]), "pending", "receipt predating lifecycle cannot pair");
    assert.equal(run([{ ...pair.lifecycle, body: pair.lifecycle.body + "\nUnknown presentation." }, pair.receipt]), "pending", "unknown lifecycle cannot pair");
  }
});
test("unknown native presentation never backdates a typed finding, even with unfamiliar prose", () => {
  const pair = corpus.lifecyclePairs[0];
  const requestedAt = new Date(Date.parse(pair.receipt.created_at) - 60000).toISOString();
  const clearBody = pair.lifecycle.body.replaceAll('"has_any_findings":null', '"has_any_findings":false').replaceAll('"has_unresolved_findings":null', '"has_unresolved_findings":false');
  const clear = { ...pair.lifecycle, body: clearBody };
  // Only change the active code flags; the inactive security object stays null.
  clear.body = clear.body.replace('"security_review":{"commit_sha":null,"has_any_findings":false,"has_unresolved_findings":false', '"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null');
  const old = { ...clear, created_at: new Date(Date.parse(clear.created_at) - 1000).toISOString(), body: clear.body.replace('"has_any_findings":false', '"has_any_findings":true') };
  const observed = new Date(Date.parse(clear.updated_at) + 10000).toISOString();
  const later = new Date(Date.parse(observed) + 10000).toISOString();
  for (const prose of ["A vulnerability which is still exploitable was mentioned.", "The reviews mentioned bugs that persist.", "No findings remain.", "`P1 example`", "\n[safe]: /url"]) {
    const negative = { ...old, body: old.body + "\n" + prose, updated_at: observed };
    assert.equal(evaluateCodexReviewEvidence(evidence([negative, clear], pair.head, requestedAt)), "pending", prose);
    const recovery = { ...clear, body: clear.body.replaceAll(clear.body.match(/datetime="([^"]+)"/)[1], later), updated_at: later };
    assert.equal(evaluateCodexReviewEvidence(evidence([negative, clear, recovery], pair.head, requestedAt)), "pass", "newer own canonical completion recovers: " + prose);
  }
});

test("both native security icons preserve independent section clearance", () => {
  const pair = corpus.lifecyclePairs[0];
  const requestedAt = new Date(Date.parse(pair.receipt.created_at) - 60000).toISOString();
  const code = { commit_sha: pair.head, has_any_findings: false, has_unresolved_findings: false, status: "completed" };
  const timestamp = pair.lifecycle.body.match(/datetime="([^"]+)"/)[1];
  const encoded = pair.lifecycle.body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/)[1];
  for (const icon of ["🛡️", "🔒"]) {
    const row = `| ${icon} **Security Review** | ✅ **Completed** <relative-time datetime="${timestamp}">${timestamp}</relative-time> | \`${pair.head.slice(0, 7)}\` | Manual request |`;
    const body = pair.lifecycle.body.replace(encoded, JSON.stringify({ code_review: code, security_review: code })).replace(/^(\| 📝[^\n]+)$/m, "$1\n" + row);
    const clean = { ...pair.lifecycle, body };
    const at = new Date(Date.parse(timestamp) - 30000).toISOString();
    for (const section of ["code_review", "security_review"]) {
      const state = { code_review: code, security_review: code, [section]: { ...code, has_any_findings: true } };
      const old = { ...clean, body: body.replace(JSON.stringify({ code_review: code, security_review: code }), JSON.stringify(state)).replaceAll(timestamp, at), updated_at: at };
      assert.equal(evaluateCodexReviewEvidence(evidence([old, clean], pair.head, requestedAt)), "pass", icon + section);
    }
  }
});

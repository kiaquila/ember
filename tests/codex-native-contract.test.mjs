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

test("future completed companions retain observed negative authority while carried clocks remain valid", () => {
  const head = "a".repeat(40);
  const old = "2026-10-20T12:02:00Z", middle = "2026-10-20T12:03:00Z", observed = "2026-10-20T12:04:00Z", fresh = "2026-10-20T12:05:00Z";
  const requestedAt = "2026-10-20T12:01:00Z";
  const record = (body, created_at, updated_at = created_at) => ({ user, body, created_at, updated_at });
  const flags = () => ({ commit_sha: head, has_any_findings: false, has_unresolved_findings: false, status: "completed" });
  const body = (negativeSection, ownTime, companionTime, companionHead, icon) => {
    const state = { code_review: flags(), security_review: flags() };
    if (negativeSection) {
      state[negativeSection].has_any_findings = true;
      state[negativeSection === "code_review" ? "security_review" : "code_review"].commit_sha = companionHead;
    }
    const row = (section, label, symbol) => {
      const at = negativeSection && section !== negativeSection ? companionTime : ownTime;
      return `| ${symbol} **${label}** | ✅ **Completed** <relative-time datetime="${at}">${at}</relative-time> | \`${state[section].commit_sha.slice(0, 7)}\` | Manual request |`;
    };
    return "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 " + JSON.stringify(state) + " -->\n\n## Codex Review Summary\n\n" + row("code_review", "Code Review", "📝") + "\n" + row("security_review", "Security Review", icon);
  };
  const receipt = record("Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `" + head + "`", observed);
  const run = comments => evaluateCodexReviewEvidence(evidence(comments, head, requestedAt));
  for (const section of ["code_review", "security_review"]) for (const companionHead of [head, "b".repeat(40)]) for (const icon of ["🛡️", "🔒"]) {
    const negative = record(body(section, old, "2026-10-20T12:40:00Z", companionHead, icon), old, observed);
    const clear = record(body(null, middle, middle, head, icon), middle);
    assert.equal(run([negative, clear, receipt]), "pending", "future companion cannot backdate " + section + icon + companionHead[0]);
    assert.equal(run([negative, record(body(null, fresh, fresh, head, icon), fresh)]), "pass", "strictly newer canonical recovery " + section + icon);
    const carried = record(body(section, old, "2026-10-20T12:01:00Z", companionHead, icon), old, observed);
    assert.equal(run([carried, clear, receipt]), "pass", "carried companion before comment creation stays valid " + section + icon);
  }
});


test("server observation bounds use the whole second without extending fractional timestamps", () => {
  const head = "a".repeat(40), foreign = "b".repeat(40);
  const requestedAt = "2026-10-20T10:00:00Z", old = "2026-10-20T10:00:20Z";
  const middle = "2026-10-20T10:00:40Z", observed = "2026-10-20T10:01:00.500Z";
  const sameSecond = "2026-10-20T10:01:00.999Z", nextSecond = "2026-10-20T10:01:01.100Z";
  const record = (body, created_at, updated_at = created_at) => ({ user, body, created_at, updated_at });
  const body = (times, { negative = null, companionHead = head, icon = "🛡️" } = {}) => {
    const flags = () => ({ commit_sha: head, has_any_findings: false, has_unresolved_findings: false, status: "completed" });
    const state = { code_review: flags(), security_review: flags() };
    if (negative) {
      state[negative].has_any_findings = true;
      state[negative === "code_review" ? "security_review" : "code_review"].commit_sha = companionHead;
    }
    const row = (section, label, symbol) => `| ${symbol} **${label}** | ✅ **Completed** <relative-time datetime="${times[section]}">${times[section]}</relative-time> | \`${state[section].commit_sha.slice(0, 7)}\` | Manual request |`;
    return "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 " + JSON.stringify(state) + " -->\n\n## Codex Review Summary\n\n" + row("code_review", "Code Review", "📝") + "\n" + row("security_review", "Security Review", icon);
  };
  const run = comments => evaluateCodexReviewEvidence(evidence(comments, head, requestedAt));
  const receipt = record("Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `" + head + "`", "2026-10-20T10:01:05Z");
  for (const section of ["code_review", "security_review"]) for (const icon of ["🛡️", "🔒"]) {
    const companion = section === "code_review" ? "security_review" : "code_review";
    for (const observedAt of [observed, "2026-10-20T10:01:00Z"]) {
      assert.equal(run([record(body({ [section]: sameSecond, [companion]: old }, { icon }), old, observedAt)]), "pass", "same server second allows .999 " + section + icon);
      for (const invalid of [nextSecond, "2026-09-31T10:00:40Z", "September 20, 2026 10:00:40 UTC"]) {
        assert.equal(run([record(body({ [section]: invalid, [companion]: old }, { icon }), old, observedAt)]), "pending", "invalid own clock " + section + invalid);
        assert.equal(run([record(body({ [section]: middle, [companion]: invalid }, { icon }), old, observedAt)]), "pending", "invalid companion clock " + section + invalid);
      }
    }
    for (const companionHead of [head, foreign]) {
      const clear = record(body({ code_review: middle, security_review: middle }, { icon }), middle);
      const future = record(body({ [section]: old, [companion]: nextSecond }, { negative: section, companionHead, icon }), old, observed);
      assert.equal(run([future, clear, receipt]), "pending", "fractional future companion keeps observed negative " + section + icon + companionHead[0]);
      for (const at of [sameSecond, "2026-10-20T09:59:00Z"]) {
        const valid = record(body({ [section]: old, [companion]: at }, { negative: section, companionHead, icon }), old, observed);
        assert.equal(run([valid, clear, receipt]), "pass", "valid same-second or precreation carried companion " + section + icon + at);
      }
      const fresh = "2026-10-20T10:01:06Z";
      assert.equal(run([future, clear, receipt, record(body({ code_review: fresh, security_review: fresh }, { icon }), fresh)]), "pass", "strictly later canonical recovery " + section + icon);
    }
  }
});


test("unpaired code lifecycles retire on a newer independent code clear while security remains latched", () => {
  const head = "a".repeat(40), requestedAt = "2026-10-20T01:00:00Z";
  const codeAt = "2026-10-20T02:00:00Z", observed = "2026-10-20T03:00:00Z";
  const codeClearAt = "2026-10-20T04:00:00Z", securityClearAt = "2026-10-20T05:00:00Z", receiptAt = "2026-10-20T06:00:00Z";
  const inactive = { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null };
  const flags = (value) => ({ commit_sha: head, has_any_findings: value, has_unresolved_findings: value, status: "completed" });
  const record = (code, security, codeTime, securityTime, updated, icon) => {
    const row = (label, symbol, at) => `| ${symbol} **${label}** | ✅ **Completed** <relative-time datetime="${at}">${at}</relative-time> | \`${head.slice(0, 7)}\` | Manual request |`;
    const body = "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 " + JSON.stringify({ code_review: code, security_review: security }) + " -->\n\n## Codex Review Summary\n\n" + row("Code Review", "📝", codeTime) + (security.status ? "\n" + row("Security Review", icon, securityTime) : "");
    return { user, body, created_at: codeAt, updated_at: updated };
  };
  const run = comments => evaluateCodexReviewEvidence(evidence(comments, head, requestedAt));
  const receipt = { user, body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `" + head + "`", created_at: receiptAt, updated_at: receiptAt };
  for (const icon of ["🛡️", "🔒"]) {
    const lifecycle = record(flags(null), inactive, codeAt, null, observed, icon);
    const codeClear = record(flags(false), flags(true), codeClearAt, codeClearAt, codeClearAt, icon);
    const securityClear = record(flags(false), flags(false), codeAt, securityClearAt, securityClearAt, icon);
    assert.equal(run([lifecycle, codeClear, receipt]), "pending", "independent security finding still blocks " + icon);
    assert.equal(run([lifecycle, securityClear, receipt]), "pending", "carried old code cannot clear lifecycle " + icon);
    const equalClear = record(flags(false), flags(true), observed, observed, observed, icon);
    assert.equal(run([lifecycle, equalClear, securityClear, receipt]), "pending", "same-second own code remains ambiguous " + icon);
    assert.equal(run([lifecycle, codeClear, securityClear, receipt]), "pass", "both own sections cleared independently " + icon);
    assert.equal(run([lifecycle, { ...codeClear, body: codeClear.body + "\nUnknown prose." }, securityClear, receipt]), "pending", "unknown code presentation cannot retire lifecycle " + icon);
    assert.equal(run([lifecycle, { ...codeClear, user: { login: "fake-codex[bot]" } }, securityClear, receipt]), "pending", "untrusted code clear cannot retire lifecycle " + icon);
  }
});

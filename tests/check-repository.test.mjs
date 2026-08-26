/* The guard is small enough to test directly: each rule gets the input it
   exists to refuse, plus the shape it must leave alone. */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkActionManifest, checkRepository, checkWorkflow } from "../scripts/check-repository.mjs";

/* The guard requires these two files to exist, so every scratch repository
   starts with them; the case that is about their absence deletes them again. */
function scratchRepository(files) {
  const root = mkdtempSync(join(tmpdir(), "ember-guard-"));
  const seeded = { ".gitattributes": "", ".github/dependabot.yml": "version: 2\n", ...files };
  for (const [path, contents] of Object.entries(seeded)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

test("generated output and local-only files may not be tracked", () => {
  const root = scratchRepository({ "keep.txt": "fine" });
  const failures = checkRepository(root, [
    "website/dist/index.html",
    "node_modules/left-pad/index.js",
    ".env",
    ".DS_Store",
    "deploy.pem",
    "keep.txt"
  ]);
  assert.match(failures.join("\n"), /Generated or dependency directory is tracked: website\/dist\/index\.html/);
  assert.match(failures.join("\n"), /Generated or dependency directory is tracked: node_modules/);
  assert.match(failures.join("\n"), /Sensitive or local-only file is tracked: \.env$/m);
  assert.match(failures.join("\n"), /Sensitive or local-only file is tracked: deploy\.pem/);
  assert.doesNotMatch(failures.join("\n"), /keep\.txt/);
});

test(".env.example is the one allowed environment file", () => {
  const root = scratchRepository({ ".env.example": "TOKEN=" });
  assert.deepEqual(checkRepository(root, [".env.example"]), []);
});

/* Assembled at runtime rather than written out: a literal token or home
   directory in this file would be a true positive against the guard's own
   test suite, which the guard scans like any other tracked file. */
const FAKE_TOKEN = "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_HOME = "/User" + "s/someone/projects/ember";

test("secrets and personal paths in text files are refused", () => {
  const root = scratchRepository({
    "notes.md": `token ${FAKE_TOKEN}\n`,
    "runbook.md": `cd ${FAKE_HOME}\n`,
    "clean.md": "Nothing to see.\n"
  });
  const failures = checkRepository(root, ["notes.md", "runbook.md", "clean.md"]);
  assert.match(failures.join("\n"), /Possible GitHub token in notes\.md/);
  assert.match(failures.join("\n"), /Personal absolute path in runbook\.md/);
  assert.doesNotMatch(failures.join("\n"), /clean\.md/);
});

test("binary files are not scanned as text", () => {
  const root = scratchRepository({});
  /* A NUL in the head is the binary marker; the bytes after it would
     otherwise read as an AWS key. */
  writeFileSync(join(root, "card.png"), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    Buffer.from("AKI" + "AABCDEFGHIJKLMNOP")
  ]));
  assert.deepEqual(checkRepository(root, ["card.png"]), []);
});

test("symbolic links are refused", () => {
  const root = scratchRepository({ "real.txt": "x" });
  symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
  assert.match(checkRepository(root, ["link.txt"]).join("\n"), /Symbolic links are not allowed/);
});

test("the dependency update policy and language rules are required", () => {
  const root = scratchRepository({});
  rmSync(join(root, ".gitattributes"));
  rmSync(join(root, ".github/dependabot.yml"));
  const failures = checkRepository(root, []).join("\n");
  assert.match(failures, /Missing harness file: \.gitattributes/);
  assert.match(failures, /Missing harness file: \.github\/dependabot\.yml/);
});

/* The three rules below read this repository's own files: those files are the
   policy, so there is nothing to fixture. */
const repositoryRoot = join(import.meta.dirname, "..");

test("the harness stays out of GitHub language statistics", () => {
  const attribute = (path) => spawnSync("git", ["check-attr", "linguist-vendored", "--", path], {
    cwd: repositoryRoot,
    encoding: "utf8"
  }).stdout.trim();

  for (const harness of [
    "scripts/check-repository.mjs",
    "scripts/codex-review-gate.mjs",
    "scripts/codex-review-helpers.mjs",
    "scripts/codex-review-rerun.mjs",
    "tests/check-repository.test.mjs",
    "tests/codex-review-gate.test.mjs"
  ]) {
    assert.equal(attribute(harness), `${harness}: linguist-vendored: set`);
  }

  /* The page and the scripts that build it are this project's product code
     and stay counted. */
  for (const product of [
    "website/src/index.html",
    "website/scripts/build.mjs",
    "website/scripts/make-og.mjs",
    "website/worker/index.ts"
  ]) {
    assert.equal(attribute(product), `${product}: linguist-vendored: unspecified`);
  }
});

test("dependabot groups minor and patch updates behind a cooldown", () => {
  const [, actions, ...npm] = readFileSync(join(repositoryRoot, ".github/dependabot.yml"), "utf8")
    .split(/^\s*- package-ecosystem:/m);
  assert.match(actions, /^\s*"github-actions"/);
  /* One npm entry per directory that actually holds a package.json and a
     lockfile: the root's guard parser and the website's build tooling. */
  assert.equal(npm.length, 2);
  assert.match(npm[0], /^\s*"npm"[\s\S]*directory: "\/"/);
  assert.match(npm[1], /^\s*"npm"[\s\S]*directory: "\/website"/);

  for (const ecosystem of [actions, ...npm]) {
    assert.match(ecosystem, /interval: "weekly"/);
    assert.match(ecosystem, /default-days: 7/);
    assert.match(ecosystem, /update-types:\s*\n\s*- "minor"\s*\n\s*- "patch"/);
    assert.doesNotMatch(ecosystem, /"major"/);
  }

  /* Action tags are not guaranteed to be semantic versions. */
  assert.doesNotMatch(actions, /semver-[a-z]+-days/);
  for (const ecosystem of npm) {
    assert.match(ecosystem, /semver-major-days: 14/);
    assert.match(ecosystem, /semver-minor-days: 7/);
    assert.match(ecosystem, /semver-patch-days: 3/);
  }
});

test("the OSV scan reports findings and fails the workflow", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /osv-scanner-action@[a-f0-9]{40}/);
  assert.match(workflow, /osv-reporter-action@[a-f0-9]{40}/);
  assert.match(workflow, /--gh-annotations=true/);
  assert.match(workflow, /--fail-on-vuln=true/);
});

test("workflows must be permission-scoped and SHA-pinned", () => {
  const unsafe = [
    "on:",
    "  pull_request_target:",
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4"
  ].join("\n");
  const failures = checkWorkflow("bad.yml", unsafe).join("\n");
  assert.match(failures, /High-risk pull_request_target trigger/);
  assert.match(failures, /must declare top-level permissions/);
  assert.match(failures, /not pinned to a full SHA in bad\.yml: actions\/checkout@v4/);

  assert.match(
    checkWorkflow("wide.yml", "permissions: write-all\n").join("\n"),
    /may not use write-all/
  );
});

test("a branch-controlled workflow may not hold any write scope", () => {
  /* `pull_request` and `workflow_dispatch` run the workflow file from the ref
     being proposed or selected, so a branch could grant itself the token. */
  const topLevel = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: write",
    "jobs: {}"
  ].join("\n");
  assert.match(
    checkWorkflow("pr.yml", topLevel).join("\n"),
    /grants write permission on a branch-controlled trigger \(pull_request\)/
  );

  /* A job-level override is the same grant, one level down. */
  const jobLevel = [
    "on:",
    "  workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  release:",
    "    permissions:",
    "      contents: write"
  ].join("\n");
  assert.match(
    checkWorkflow("dispatch.yml", jobLevel).join("\n"),
    /grants write permission on a branch-controlled trigger \(workflow_dispatch\)/
  );

  /* Shorthand trigger lists are the same triggers. */
  const shorthand = ["on: [pull_request, push]", "permissions:", "  contents: write"].join("\n");
  assert.match(checkWorkflow("short.yml", shorthand).join("\n"), /branch-controlled trigger/);

  /* Trusted events always run the default branch's copy, so the review-rerun
     workflow's `actions: write` is not a branch-controlled grant. */
  const trusted = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review:",
    "    types: [submitted]",
    "permissions:",
    "  actions: write",
    "  contents: read"
  ].join("\n");
  assert.deepEqual(checkWorkflow("rerun.yml", trusted), []);
});

test("an inline permission map is a grant like any other", () => {
  /* `permissions: { contents: write }` is valid YAML and the same grant. */
  const inlineMap = [
    "on:",
    "  workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  release:",
    "    permissions: { contents: write }"
  ].join("\n");
  assert.match(
    checkWorkflow("inline.yml", inlineMap).join("\n"),
    /grants write permission on a branch-controlled trigger \(workflow_dispatch\)/
  );

  /* The empty map grants nothing. */
  const empty = ["on:", "  pull_request:", "permissions: {}"].join("\n");
  assert.deepEqual(checkWorkflow("empty.yml", empty), []);
});

test("push counts as branch-controlled unless it is pinned to the trusted branch", () => {
  /* A push workflow runs the pushed commit's own copy, so any branch that
     can be pushed can rewrite it — unless the filter excludes every branch
     but the trusted one. */
  const write = ["permissions:", "  actions: write"].join("\n");
  const unfiltered = ["on:", "  push:", write].join("\n");
  assert.match(
    checkWorkflow("push.yml", unfiltered).join("\n"),
    /grants write permission on a branch-controlled trigger \(push\)/
  );

  const feature = ["on:", "  push:", "    branches:", "      - main", "      - feature/*", write].join("\n");
  assert.match(checkWorkflow("feature.yml", feature).join("\n"), /branch-controlled trigger \(push\)/);

  /* `branches-ignore` is an exclusion and proves no restriction. */
  const ignore = ["on:", "  push:", "    branches-ignore:", "      - tmp", write].join("\n");
  assert.match(checkWorkflow("ignore.yml", ignore).join("\n"), /branch-controlled trigger \(push\)/);

  const pinned = ["on:", "  push:", "    branches:", "      - main", write].join("\n");
  assert.deepEqual(checkWorkflow("pinned.yml", pinned), []);
  const pinnedInline = ["on:", "  push:", "    branches: [main]", write].join("\n");
  assert.deepEqual(checkWorkflow("pinned-inline.yml", pinnedInline), []);

  /* A `branches` filter alone keeps tag pushes from firing at all, but naming
     any tag filter turns them back on — and a tag push runs the tagged
     commit's copy, which anyone able to push a tag controls. */
  const tagged = ["on:", "  push:", "    branches: [main]", "    tags: ['*']", write].join("\n");
  assert.match(checkWorkflow("tagged.yml", tagged).join("\n"), /branch-controlled trigger \(push\)/);
  /* `tags-ignore` re-admits every tag it does not name... */
  const tagIgnore = ["on:", "  push:", "    branches: [main]", "    tags-ignore: [v0]", write].join("\n");
  assert.match(checkWorkflow("tag-ignore.yml", tagIgnore).join("\n"), /branch-controlled trigger \(push\)/);
  /* ...but `**` names all of them, which leaves no tag able to fire it. */
  const tagIgnoreAll = ["on:", "  push:", "    branches: [main]", '    tags-ignore: ["**"]', write].join("\n");
  assert.deepEqual(checkWorkflow("tag-ignore-all.yml", tagIgnoreAll), []);
});

test("a write-capable workflow may not name an actor-controlled ref", () => {
  /* A trusted event runs the default branch's workflow file, so the file is
     trusted — but the code it checks out need not be. */
  const pinned = `actions/checkout@${"a".repeat(40)}`;
  const checkout = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: ${pinned}`,
    "        with:",
    "          ref: refs/pull/${{ github.event.issue.number }}/head",
    "      - run: npm ci"
  ].join("\n");
  assert.match(
    checkWorkflow("attack.yml", checkout).join("\n"),
    /names an actor-controlled ref in attack\.yml/
  );

  /* The shell can fetch one too, so enumerating checkout actions is not
     enough — the ref itself is what is banned. */
  const viaCli = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: gh pr checkout 1 && npm ci"
  ].join("\n");
  assert.match(checkWorkflow("cli.yml", viaCli).join("\n"), /names an actor-controlled ref/);

  /* Without a write scope there is no token worth stealing, so reading a
     pull request is ordinary work. */
  const readOnly = viaCli.replace("  contents: write", "  contents: read");
  assert.deepEqual(checkWorkflow("read.yml", readOnly), []);

  /* Parking the ref in an env value and expanding it later is the same
     checkout, so env values count as well — at any level. */
  const viaEnv = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "env:",
    "  PR_REF: refs/pull/${{ github.event.issue.number }}/head",
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: ${pinned}`,
    "        with:",
    "          ref: ${{ env.PR_REF }}"
  ].join("\n");
  assert.match(checkWorkflow("env.yml", viaEnv).join("\n"), /names an actor-controlled ref/);

  /* An action can take a ref under any input name, so every `with` value is
     read rather than `ref` and `repository` alone. */
  const otherInput = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: ${pinned}`,
    "        with:",
    "          revision: ${{ github.head_ref }}"
  ].join("\n");
  assert.match(checkWorkflow("input.yml", otherInput).join("\n"), /names an actor-controlled ref/);

  /* A matrix value reaches the checkout the same way an env value does. The
     collector walks the job rather than naming the places a ref can sit, so
     `strategy.matrix` needed no rule of its own. */
  const matrix = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  a:",
    "    strategy:",
    "      matrix:",
    "        ref: [refs/pull/1/head]",
    "    steps:",
    `      - uses: ${pinned}`,
    "        with:",
    "          ref: ${{ matrix.ref }}"
  ].join("\n");
  assert.match(checkWorkflow("matrix.yml", matrix).join("\n"), /names an actor-controlled ref/);

  /* `if:` and `name:` are skipped only as a job's or step's own keys. The
     same words nested inside a value are data that can still reach a
     checkout. */
  const matrixName = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  a:",
    "    name: build",
    "    strategy:",
    "      matrix:",
    "        name: [refs/pull/1/head]"
  ].join("\n");
  assert.match(checkWorkflow("matrix-name.yml", matrixName).join("\n"), /names an actor-controlled ref/);

  const inputName = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: ${pinned}`,
    "        with:",
    "          name: ${{ github.head_ref }}"
  ].join("\n");
  assert.match(checkWorkflow("with-name.yml", inputName).join("\n"), /names an actor-controlled ref/);

  /* A reusable-workflow job passes its inputs at `job.with`, beside `uses`,
     with no steps of its own. */
  const reusable = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  build:",
    `    uses: owner/repo/.github/workflows/build.yml@${"a".repeat(40)}`,
    "    with:",
    "      ref: refs/pull/${{ github.event.issue.number }}/head"
  ].join("\n");
  assert.match(checkWorkflow("reusable.yml", reusable).join("\n"), /names an actor-controlled ref/);

  /* An `if:` condition routes the job without fetching anything, which is
     how the review-rerun workflow legitimately tests `github.event.comment`. */
  const routing = [
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "permissions:",
    "  actions: write",
    "jobs:",
    "  a:",
    "    if: github.event.comment.user.login == 'chatgpt-codex-connector[bot]'",
    "    steps:",
    "      - run: node scripts/codex-review-rerun.mjs"
  ].join("\n");
  assert.deepEqual(checkWorkflow("routing.yml", routing), []);

  /* `github.event.repository.*` is chosen by the repository, not an actor —
     it is how the review-rerun workflow pins its trusted checkout. */
  const trusted = [
    "on:",
    "  pull_request_review:",
    "    types: [submitted]",
    "permissions:",
    "  actions: write",
    "  contents: read",
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: ${pinned}`,
    "        with:",
    "          ref: ${{ github.event.repository.default_branch }}"
  ].join("\n");
  assert.deepEqual(checkWorkflow("rerun.yml", trusted), []);
});

test("job container and service images must name a digest", () => {
  /* A job's steps run inside its container, so a mutable tag there is the
     same exposure as a mutable action reference. */
  const head = ["on:", "  pull_request:", "permissions: {}", "jobs:", "  a:"];
  assert.match(
    checkWorkflow("c.yml", [...head, "    container: node:latest"].join("\n")).join("\n"),
    /Job container image is not pinned to a digest in c\.yml: node:latest/
  );
  assert.match(
    checkWorkflow("m.yml", [...head, "    container:", "      image: owner/image:tag"].join("\n")).join("\n"),
    /not pinned to a digest/
  );
  assert.match(
    checkWorkflow("s.yml", [...head, "    services:", "      db:", "        image: postgres:16"].join("\n")).join("\n"),
    /not pinned to a digest/
  );

  const digest = `node@sha256:${"a".repeat(64)}`;
  assert.deepEqual(checkWorkflow("ok.yml", [...head, `    container: ${digest}`].join("\n")), []);
  /* A job with no container at all is the normal case. */
  assert.deepEqual(checkWorkflow("plain.yml", [...head, "    steps: []"].join("\n")), []);
});

test("a merge-queue run is branch-controlled too", () => {
  /* The merge-group commit already contains the pull request's own workflow
     changes, so it is the proposed code by another name. */
  const mergeGroup = ["on:", "  merge_group:", "permissions:", "  actions: write"].join("\n");
  assert.match(
    checkWorkflow("queue.yml", mergeGroup).join("\n"),
    /grants write permission on a branch-controlled trigger \(merge_group\)/
  );
});

test("a local action's own steps are pinned like a workflow's", () => {
  /* `uses: ./...` is skipped in a workflow because it is this repository's
     reviewed code — but that manifest can call out to a mutable action, so
     it is held to the same rule. */
  const composite = ["runs:", "  using: composite", "  steps:", "    - uses: owner/action@main"].join("\n");
  assert.match(
    checkActionManifest(".github/actions/x/action.yml", composite).join("\n"),
    /not pinned to a full SHA .*owner\/action@main/
  );

  const pinned = ["runs:", "  using: composite", "  steps:", `    - uses: owner/action@${"a".repeat(40)}`].join("\n");
  assert.deepEqual(checkActionManifest(".github/actions/x/action.yml", pinned), []);

  /* A Docker action names its image instead of a step. */
  const image = (value) => ["runs:", "  using: docker", `  image: ${value}`].join("\n");
  assert.match(
    checkActionManifest("action.yml", image("docker://owner/image:latest")).join("\n"),
    /Container action is not pinned to a digest/
  );
  assert.deepEqual(checkActionManifest("action.yml", image(`docker://owner/image@sha256:${"a".repeat(64)}`)), []);
  /* A Dockerfile is this repository's own code, built from the commit. */
  assert.deepEqual(checkActionManifest("action.yml", image("Dockerfile")), []);

  /* A manifest with no steps at all is fine; an unreadable one is not. */
  assert.deepEqual(checkActionManifest("action.yml", "runs:\n  using: node20\n  main: index.js\n"), []);
  assert.match(
    checkActionManifest("action.yml", "runs:\n  using: composite\n :::bad[\n").join("\n"),
    /Action manifest is not valid YAML/
  );
});

test("container actions must name an immutable digest", () => {
  const step = (uses) =>
    ["on:", "  pull_request:", "permissions: {}", "jobs:", "  a:", "    steps:", `      - uses: ${uses}`].join("\n");

  /* `:latest` is exactly as mutable as an action branch reference. */
  assert.match(
    checkWorkflow("docker.yml", step("docker://owner/image:latest")).join("\n"),
    /Container action is not pinned to a digest in docker\.yml/
  );
  assert.deepEqual(checkWorkflow("digest.yml", step(`docker://owner/image@sha256:${"a".repeat(64)}`)), []);
  /* A local action is this repository's own reviewed code. */
  assert.deepEqual(checkWorkflow("local.yml", step("./.github/actions/x")), []);
});

test("YAML spellings a line reader would miss are still read", () => {
  /* The guard parses workflows rather than scanning them, so a quoted key,
     a flow-style step map and any other valid spelling reach the same rules. */
  const quotedKey = ["on:", "  pull_request:", "permissions:", '  "contents": write'].join("\n");
  assert.match(
    checkWorkflow("quoted.yml", quotedKey).join("\n"),
    /grants write permission on a branch-controlled trigger \(pull_request\)/
  );

  const flowStep = [
    "on:",
    "  pull_request:",
    "permissions: {}",
    "jobs:",
    "  a:",
    "    steps:",
    "      - { uses: owner/action@main }"
  ].join("\n");
  assert.match(
    checkWorkflow("flow.yml", flowStep).join("\n"),
    /not pinned to a full SHA in flow\.yml: owner\/action@main/
  );

  /* A reusable-workflow reference is an action reference too. */
  const reusable = [
    "on:",
    "  pull_request:",
    "permissions: {}",
    "jobs:",
    "  a:",
    "    uses: owner/repo/.github/workflows/x.yml@v1"
  ].join("\n");
  assert.match(checkWorkflow("reusable.yml", reusable).join("\n"), /not pinned to a full SHA/);
});

test("a workflow the guard cannot parse fails closed", () => {
  /* Silently passing something unreadable is the one outcome a guard must
     never have. */
  assert.match(
    checkWorkflow("broken.yml", "on:\n  pull_request:\n :::bad[\n").join("\n"),
    /Workflow is not valid YAML: broken\.yml/
  );
  assert.match(checkWorkflow("scalar.yml", "just a string\n").join("\n"), /not a YAML mapping/);
});

test("this repository's own workflow shape passes", () => {
  const safe = [
    "name: Project CI",
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  project-ci:",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"
  ].join("\n");
  assert.deepEqual(checkWorkflow("ci.yml", safe), []);
});

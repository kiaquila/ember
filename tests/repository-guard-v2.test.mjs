import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateProjectConfig, validateWorkflowText } from "../scripts/check-repository.mjs";

const config = {
  schemaVersion: 1,
  project: { slug: "demo-site", profile: "no-deploy", productPaths: ["website/"] },
  commands: { check: [{ name: "site", run: "npm test" }] },
  deployment: { provider: "none", productionBranch: "main", rootDirectory: "." },
  governance: { source: "kiaquila/web-design", channel: "v1", mode: "consumer" }
};

test("accepts a valid single-project profile", () => {
  assert.deepEqual(validateProjectConfig(config, ["no-deploy"]), []);
});

test("enforces the deployment provider declared by the selected profile", () => {
  const invalid = structuredClone(config);
  invalid.deployment.provider = "cloudflare-workers";
  assert.deepEqual(
    validateProjectConfig(invalid, { "no-deploy": { deploymentProvider: "none" } }),
    ["deployment.provider must match profile no-deploy"]
  );
});

test("requires at least one real product check in consumer mode", () => {
  const invalid = structuredClone(config);
  invalid.commands.check = [];
  assert.deepEqual(
    validateProjectConfig(invalid, ["no-deploy"]),
    ["consumer projects must configure at least one product check"]
  );
});

test("accepts product checks whose exit status comes from a real command", () => {
  const accepted = [
    "npm --prefix website run check",
    "npm ci --prefix website && npm --prefix website run check",
    "node --test tests/a.test.mjs tests/b.test.mjs",
    'npm test -- --grep "a|b"',
    "npm run build -- --tag '#1'",
    "bash scripts/build.sh",
    "npm run x -- --shell -c"
  ];
  for (const run of accepted) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("rejects separators that let a failure be discarded", () => {
  const discarded = [
    "npm test; true",
    "npm test || true",
    "true || npm test",
    "npm test | tee build.log",
    "true | true",
    "npm test &",
    "npm test > /dev/null",
    "npm test `true`",
    "$(echo npm) test"
  ];
  for (const run of discarded) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must join commands only with && and use no other shell operators"],
      run
    );
  }
});

test("rejects a check that inverts its exit status", () => {
  for (const run of ["! npm test", "npm test && ! true"]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must not invert a command's exit status"],
      run
    );
  }
  for (const run of ['npm test -- --grep "a!b"', "npm run lint!"]) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("a wrapper cannot disguise a no-op command", () => {
  for (const run of ["command true", "env true", "exec true", "timeout 60 true", "nice -n 5 true", "env FOO=bar true"]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must execute a real product check"],
      run
    );
  }
});

test("a wrapper around a real command is still a real check", () => {
  for (const run of ["command npm test", "env npm test", "timeout 600 npm --prefix website run check"]) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("rejects commands that only report success", () => {
  for (const run of ["true", ":", "exit 0", "echo ok", "printf ok", "npm test && true", "echo ok && npm test"]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must execute a real product check"],
      run
    );
  }
});

test("rejects a check that hands shell text to another shell", () => {
  const nested = [
    "sh -c 'npm test | true'",
    "bash -c 'npm test'",
    "/bin/sh -c 'npm test'",
    "sh -ec 'npm test'",
    "/bin/bash -euo pipefail -c 'npm test'",
    "env sh -c 'npm test'",
    "command sh -c 'npm test'",
    "xargs sh -c 'npm test'",
    "npm test && eval 'true'"
  ];
  for (const run of nested) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must not hand shell text to another shell"],
      run
    );
  }
});

test("rejects comments, continuations, and unbalanced quotes", () => {
  const malformed = [
    ["npm test # disabled", "must not contain a shell comment"],
    ["npm test\nnpm run lint", "must be a single line"],
    ["npm test \\\n  && npm run lint", "must be a single line"],
    ["npm test 'unclosed", "must not leave a quote unclosed"],
    ["npm test && ", "must not contain an empty command"]
  ];
  for (const [run, expected] of malformed) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      [`commands.check[0].run ${expected}`],
      run
    );
  }
});

test("quoting cannot disguise a no-op or smuggle an expansion", () => {
  for (const run of ['"true"', "'true'", '"echo" "ok"', '"sh" -c \'npm test\'']) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.equal(validateProjectConfig(invalid, ["no-deploy"]).length, 1, run);
  }
  const expansion = structuredClone(config);
  expansion.commands.check = [{ name: "site", run: 'npm test -- --grep "$(evil)"' }];
  assert.deepEqual(
    validateProjectConfig(expansion, ["no-deploy"]),
    ["commands.check[0].run must not expand anything outside single quotes"]
  );
  const singleQuoted = structuredClone(config);
  singleQuoted.commands.check = [{ name: "site", run: "npm test -- --grep '$(literal)'" }];
  assert.deepEqual(validateProjectConfig(singleQuoted, ["no-deploy"]), []);
});

test("rejects unsafe slugs, product paths, and unknown profiles", () => {
  const invalid = structuredClone(config);
  invalid.project.slug = "Demo Site";
  invalid.project.profile = "unknown";
  invalid.project.productPaths = ["../customer-data"];
  assert.equal(validateProjectConfig(invalid, ["no-deploy"]).length, 3);
});

test("rejects dangerous workflow triggers and mutable action refs", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request_target\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n"
  );
  assert.equal(failures.length, 2);
  assert.match(failures.join("\n"), /pull_request_target/);
  assert.match(failures.join("\n"), /full commit SHA/);
});

test("accepts a least-privilege workflow with a full SHA pin", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: push\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
  );
  assert.deepEqual(failures, []);
});

test("structurally rejects mutable action refs in quoted and flow-style steps", () => {
  for (const workflow of [
    `on: push\npermissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - "uses": actions/checkout@v4\n`,
    `on: push\npermissions: { contents: read }\njobs: { test: { runs-on: ubuntu-latest, steps: [{ "uses": actions/checkout@v4 }] } }\n`
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      workflow
    );
    assert.match(failures.join("\n"), /not pinned to a full commit SHA/, workflow);
  }
});

test("fails closed on indirect and decorated action references", () => {
  const workflows = [
    `shared: &shared { uses: actions/checkout@main }\non: push\npermissions: { contents: read }\njobs: { test: { runs-on: ubuntu-latest, steps: [*shared] } }\n`,
    `on: push\npermissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: &action actions/checkout@main\n`,
    `on: push\npermissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: !action actions/checkout@main\n`,
    `on: push\npermissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: >-\n          actions/checkout@main\n`,
    `shared: &shared { uses: actions/checkout@main }\non: push\npermissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - <<: *shared\n`
  ];
  for (const workflow of workflows) {
    const failures = validateWorkflowText(".github/workflows/example.yml", workflow);
    assert.match(failures.join("\n"), /unsupported YAML (?:alias|anchor|tag|block scalar|merge key)/, workflow);
  }
});

test("fails closed on indirect and decorated security mapping keys", () => {
  const workflows = [
    `permissionKey: &permissionKey permissions\non: pull_request\npermissions: { contents: read }\njobs:\n  test:\n    ? *permissionKey\n    : { contents: write }\n    runs-on: ubuntu-latest\n`,
    `usesKey: &usesKey uses\non: push\npermissions: { contents: read }\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - ? *usesKey\n        : actions/checkout@main\n`,
    `on: pull_request\npermissions: { contents: read }\njobs:\n  test:\n    ? [permissions]\n    : { contents: write }\n    runs-on: ubuntu-latest\n`,
    `on: pull_request\npermissions: { contents: read }\njobs:\n  test:\n    &permissionKey permissions: { contents: write }\n    runs-on: ubuntu-latest\n`
  ];
  for (const workflow of workflows) {
    const failures = validateWorkflowText(".github/workflows/example.yml", workflow);
    assert.match(
      failures.join("\n"),
      /key uses unsupported YAML (?:alias|anchor)|keys must be undecorated string scalars/,
      workflow
    );
  }
});

test("rejects merge-key permission injection anywhere in the jobs tree", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    `shared: &shared { permissions: { contents: write } }\non: pull_request\npermissions: { contents: read }\njobs: { test: { <<: *shared, runs-on: ubuntu-latest } }\n`
  );
  assert.match(failures.join("\n"), /Workflow jobs use unsupported YAML (?:alias|merge key)/);
});

test("external Docker actions require an immutable SHA-256 digest", () => {
  const mutable = validateWorkflowText(
    ".github/workflows/example.yml",
    `on: push\npermissions: { contents: read }\njobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: docker://alpine:latest }] } }\n`
  );
  assert.match(mutable.join("\n"), /Docker action is not pinned to an immutable SHA-256 digest/);

  const digest = "a".repeat(64);
  const pinned = validateWorkflowText(
    ".github/workflows/example.yml",
    `on: push\npermissions: { contents: read }\njobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: docker://alpine@sha256:${digest} }] } }\n`
  );
  assert.deepEqual(pinned, []);
});

test("rejects pull-request workflows with top-level write permissions", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /top-level write permissions/);
});

test("recognizes pull requests in every supported workflow trigger shape", () => {
  const triggers = [
    "on: pull_request",
    "on: [push, pull_request]",
    "on: [push, 'pull_request']",
    "on: { pull_request: {}, push: {} }",
    "on : { pull_request: {}, push: {} }",
    "'on': { 'pull_request': null, push: {} }",
    "on: {\n  push: {},\n  pull_request: { branches: [main] }\n}",
    "on:\n  push:\n  pull_request:\n    branches: [main]",
    "on:\n  - push\n  - pull_request"
  ];
  for (const trigger of triggers) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `${trigger}\npermissions:\n  contents: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /top-level write permissions/, trigger);
  }
});

test("does not confuse a nested branch name with a pull-request trigger", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on:\n  push:\n    branches: [pull_request, pull_request_target]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
  );
  assert.deepEqual(failures, []);
});

test("fails closed when a workflow trigger is supplied indirectly", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: *shared-events\npermissions:\n  contents: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /Workflow trigger uses unsupported YAML alias/);
});

test("rejects block-scalar workflow triggers", () => {
  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+"]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: ${indicator}\n  pull_request\npermissions:\n  contents: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /Workflow trigger uses unsupported YAML block scalar/, indicator);
  }
});

test("rejects unsupported direct workflow event constructs", () => {
  for (const trigger of [
    "on: &events [pull_request]",
    "on: !events [pull_request]",
    "on: [push, *shared-events]",
    "on: { <<: *shared-events }"
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `${trigger}\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /Workflow trigger uses unsupported YAML (?:anchor|alias|tag|merge key)/, trigger);
  }
});

test("rejects flow-style pull-request permission grants", () => {
  for (const permissions of [
    "permissions: { contents: write }",
    "permissions: {\n  contents: write,\n  issues: read\n}"
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: { pull_request: {} }\n${permissions}\njobs:\n  test:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /top-level write permissions/, permissions);
  }
});

test("rejects block-scalar permission levels", () => {
  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+"]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: pull_request\npermissions:\n  contents: ${indicator}\n    write\njobs:\n  test:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /Workflow top-level permissions use unsupported YAML block scalar/, indicator);
  }
});

test("rejects block-scalar job permission levels", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    permissions:\n      contents: >-\n        write\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /Workflow job test permissions use unsupported YAML block scalar/);
});

test("rejects unsupported permission aliases, anchors, and tags", () => {
  for (const permissions of [
    "permissions: *shared-permissions",
    "permissions: &shared-permissions { contents: read }",
    "permissions: !policy { contents: read }",
    "permissions: { <<: *shared-permissions }",
    "permissions:\n  contents: *shared-level"
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: pull_request\n${permissions}\njobs:\n  test:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /Workflow top-level permissions use unsupported YAML (?:anchor|alias|tag|merge key)/, permissions);
  }
});

test("structurally rejects quoted, escaped, spaced, flow, and arbitrarily indented write grants", () => {
  const workflows = [
    String.raw`"\u006fn": pull_request
"permissions":
    contents: "wr\u0069te"
"jobs":
    "test":
        runs-on: ubuntu-latest
`,
    `on : { pull_request: {} }
permissions : { contents: read }
"jobs" : { "publish": { "permissions": { contents: write }, runs-on: ubuntu-latest } }
`,
    `on: pull_request
permissions:
    contents: read
jobs:
    "publish job":
        "permissions":
            issues: write
        runs-on: ubuntu-latest
`
  ];
  for (const workflow of workflows) {
    const failures = validateWorkflowText(".github/workflows/example.yml", workflow);
    assert.match(failures.join("\n"), /may not grant (?:top-level write permissions|write permissions)/, workflow);
  }
});

test("rejects pull-request jobs with write permissions", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    permissions:\n      issues: write\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /job test may not grant write permissions/);
});

test("rejects flow-style job permissions on pull requests", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    permissions: { issues: write }\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /job test may not grant write permissions/);
});

test("allows a write-capable job gated to manual dispatch on the default branch", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: [pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  publish:\n    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.deepEqual(failures, []);
});

test("rejects a write-capable job gated only to the manual event", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: [pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  publish:\n    if: ${{ github.event_name == 'workflow_dispatch' }}\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /job publish may not grant write permissions/);
});

test("rejects a write-capable manual job gated to a non-default ref", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: [pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  publish:\n    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/feature' }}\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /job publish may not grant write permissions/);
});

test("rejects write-capable jobs whose condition also admits pull requests", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: [pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  publish:\n    if: ${{ github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request' }}\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /job publish may not grant write permissions/);
});

test("rejects top-level write permissions on an unconstrained push workflow", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: push\npermissions:\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /may not grant top-level write permissions/);
});

test("rejects a write-capable push job with no default-branch dispatch gate", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: push\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /job publish may not grant write permissions/);
});

test("rejects top-level write permissions on a manual-only workflow", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: workflow_dispatch\npermissions:\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n"
  );
  assert.match(failures.join("\n"), /may not grant top-level write permissions/);
});

test("rejects write permissions on merge-queue and reusable-workflow triggers", () => {
  for (const trigger of ["merge_group", "workflow_call"]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: ${trigger}\npermissions:\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /may not grant top-level write permissions/, trigger);
  }
});

test("allows a write job on a push narrowed to the default branch", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on:\n  push:\n    branches:\n      - main\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.deepEqual(failures, []);
});

test("a push filter that widens beyond the default branch stays untrusted", () => {
  const filters = [
    "    branches:\n      - main\n      - dev",
    "    branches:\n      - main\n    tags:\n      - \"v*\"",
    "    branches-ignore:\n      - dev"
  ];
  for (const filter of filters) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on:\n  push:\n${filter}\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /job publish may not grant write permissions/, filter);
  }
});

test("a default-branch push loses its trust when a ref-selectable trigger joins it", () => {
  for (const extra of ["  pull_request:", "  workflow_dispatch:"]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on:\n  push:\n    branches:\n      - main\n${extra}\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n`
    );
    assert.match(failures.join("\n"), /job publish may not grant write permissions/, extra);
  }
});

test("rejects a reusable-workflow job that inherits caller secrets", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: read\njobs:\n  call:\n    uses: kiaquila/web-design/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1\n    secrets: inherit\n"
  );
  assert.match(failures.join("\n"), /may not inherit caller secrets/);
});

test("keeps explicitly named secrets on a reusable-workflow job", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: read\njobs:\n  call:\n    uses: kiaquila/web-design/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1\n    secrets:\n      TOKEN: ${{ secrets.SCOPED_TOKEN }}\n"
  );
  assert.deepEqual(failures, []);
});

test("rejects an untrusted checkout over the workspace in a write-capable job", () => {
  for (const ref of [
    "${{ github.event.pull_request.head.sha }}",
    "refs/pull/${{ github.event.issue.number }}/head",
    "${{ github.head_ref }}",
    "${{ github.event.comment.body }}",
    "${{ inputs.target_ref }}"
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@PIN\n        with:\n          ref: ${ref}\n      - run: npm ci\n`.replace("PIN", "3d3c42e5aac5ba805825da76410c181273ba90b1")
    );
    assert.match(failures.join("\n"), /checks an untrusted ref out over the workspace/, ref);
  }
});

test("accepts only checkout refs that are provably the trusted branch", () => {
  for (const ref of [
    "${{ github.event.repository.default_branch }}",
    "${{ github.sha }}",
    "${{ github.ref }}",
    "main"
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${ref}\n`
    );
    assert.deepEqual(failures, [], ref);
  }
});

test("a checkout path that lands back on the workspace is not isolation", () => {
  for (const path of [".", "./", "../..", "/tmp/proposed", "${{ inputs.target }}"]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@PIN\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: ${path}\n      - run: npm ci\n`.replace("PIN", "3d3c42e5aac5ba805825da76410c181273ba90b1")
    );
    assert.match(failures.join("\n"), /checks an untrusted ref out over the workspace/, path);
  }
});

test("an isolated checkout stays data and is never executed", () => {
  const executes = [
    "node .proposed/scripts/build.mjs",
    "npm ci --prefix .proposed",
    ".proposed/build.sh",
    "bash .proposed/x.sh"
  ];
  for (const run of executes) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: ${run}\n`
    );
    assert.match(failures.join("\n"), /executes code from the untrusted checkout \.proposed/, run);
  }

  const workingDirectoryForms = [
    "      - run: npm ci\n        working-directory: .proposed\n",
    "      - run: npm ci\n        working-directory: ./.proposed\n",
    "      - run: npm ci\n        working-directory: .proposed/website\n"
  ];
  for (const step of workingDirectoryForms) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: .proposed\n${step}`
    );
    assert.match(failures.join("\n"), /executes code from the untrusted checkout \.proposed/, step);
  }
  const viaDefaults = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: .proposed\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: npm ci\n"
  );
  assert.match(viaDefaults.join("\n"), /executes code from the untrusted checkout \.proposed/);
});

test("a local action or dot-mangled directory cannot reach the isolated checkout", () => {
  const forms = [
    "      - uses: ./candidate/action\n",
    "      - uses: ./candidate\n",
    "      - run: npm ci\n        working-directory: ././candidate\n",
    "      - run: npm ci\n        working-directory: candidate//sub\n"
  ];
  for (const step of forms) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n${step}`
    );
    assert.match(failures.join("\n"), /executes code from the untrusted checkout candidate/, step);
  }
  const safe = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - uses: ./scripts/action\n      - run: npm ci\n        working-directory: candidate-other\n"
  );
  assert.deepEqual(safe, []);
});

test("a workflow-level run default reaches into the isolated checkout too", () => {
  const withDefault = (root, job) =>
    `on: issue_comment\npermissions:\n  contents: write\n${root}jobs:\n  a:\n    runs-on: ubuntu-latest\n${job}    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: npm ci\n`;
  for (const root of [
    "defaults:\n  run:\n    working-directory: candidate\n",
    "defaults:\n  run:\n    working-directory: ././candidate\n"
  ]) {
    const failures = validateWorkflowText(".github/workflows/example.yml", withDefault(root, ""));
    assert.match(failures.join("\n"), /executes code from the untrusted checkout candidate/, root);
  }
  // A job default overrides the workflow default, so this one is safe again.
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      withDefault(
        "defaults:\n  run:\n    working-directory: candidate\n",
        "    defaults:\n      run:\n        working-directory: website\n"
      )
    ),
    []
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      withDefault("defaults:\n  run:\n    working-directory: website\n", "")
    ),
    []
  );
});

test("changing directory into an isolated checkout counts as executing from it", () => {
  for (const run of [
    "cd .proposed && npm ci",
    "cd ./.proposed && npm ci",
    "pushd .proposed && npm ci",
    "cd .proposed/website && npm ci"
  ]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: ${run}\n`
    );
    assert.match(failures.join("\n"), /executes code from the untrusted checkout \.proposed/, run);
  }
  const elsewhere = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: cd website && npm ci\n"
  );
  assert.deepEqual(elsewhere, []);
});

test("passing an isolated checkout to a trusted program is still allowed", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: node scripts/check.mjs --root .proposed\n"
  );
  assert.deepEqual(failures, []);
});

test("keeps an untrusted checkout isolated under its own path", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: node scripts/check.mjs --root .proposed\n"
  );
  assert.deepEqual(failures, []);
});

test("a read-only job may still check out proposed code", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: pull_request\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n"
  );
  assert.deepEqual(failures, []);
});

test("allows top-level write permissions on default-branch-only events", () => {
  for (const trigger of ["issue_comment", "workflow_run", "schedule"]) {
    const failures = validateWorkflowText(
      ".github/workflows/example.yml",
      `on: ${trigger}\npermissions:\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n`
    );
    assert.deepEqual(failures, [], trigger);
  }
});

test("a manual write job stays valid when it keeps the default-branch gate", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  publish:\n    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
  );
  assert.deepEqual(failures, []);
});

test("workflow jobs that execute Node install the pinned runtime first", () => {
  const workflows = readdirSync(resolve(".github/workflows"))
    .filter((file) => file.endsWith(".yml"));
  const setupNode = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
  for (const file of workflows) {
    const workflow = readFileSync(resolve(".github/workflows", file), "utf8");
    const jobBlocks = workflow
      .split(/^jobs:\s*$/m)[1]
      ?.split(/(?=^  [A-Za-z0-9_-]+:\s*$)/m)
      .filter((block) => /^  [A-Za-z0-9_-]+:\s*$/m.test(block)) ?? [];
    for (const job of jobBlocks) {
      if (!/^\s+run:\s*node\b/m.test(job) && !/^\s+run:\s*[|>]\s*$[\s\S]*?^\s+node\b/m.test(job)) {
        continue;
      }
      const nodeCommand = job.search(/^\s+run:\s*node\s+|^\s+node\s+/m);
      const setup = job.indexOf(setupNode);
      assert.ok(setup !== -1 && setup < nodeCommand, `${file} must set up pinned Node before executing it`);
      assert.match(job.slice(setup, nodeCommand), /node-version:\s*["']22\.18\.0["']/);
    }
  }
});

test("trusted YAML policy installs its pinned managed dependency without scripts", () => {
  const packageData = JSON.parse(readFileSync(resolve(".web-design/policy/package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(resolve(".web-design/policy/package-lock.json"), "utf8"));
  const managed = JSON.parse(readFileSync(resolve(".web-design/managed-files.json"), "utf8"));
  assert.equal(packageData.dependencies.yaml, "2.9.0");
  assert.equal(packageLock.packages["node_modules/yaml"].version, "2.9.0");
  assert.ok(managed.files.includes(".web-design/policy/package-lock.json"));
  assert.equal(managed.files.includes("package.json"), false);
  assert.equal(managed.files.includes("package-lock.json"), false);
  const project = JSON.parse(readFileSync(resolve(".web-design/project.json"), "utf8"));
  if (project.governance.mode === "source") {
    const templatePackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    assert.equal(
      templatePackage.scripts.preflight,
      "npm run policy:install && npm run check && npm test"
    );
  }

  const guard = readFileSync(resolve(".github/workflows/repository-guard.yml"), "utf8");
  assert.match(guard, /npm ci --ignore-scripts --prefix \.web-design\/policy/);
  assert.match(guard, /npm ci --ignore-scripts --prefix \.guard-trusted\/\.web-design\/policy/);
  assert.ok(guard.indexOf("npm ci --ignore-scripts") < guard.indexOf("node .guard-trusted/scripts/check-repository.mjs"));

  const baseline = readFileSync(resolve(".github/workflows/baseline-source-verification.yml"), "utf8");
  assert.match(baseline, /run: npm ci --ignore-scripts --prefix \.web-design\/policy/);
  assert.ok(baseline.indexOf("npm ci --ignore-scripts") < baseline.indexOf("node scripts/check-baseline-change.mjs"));

  const osv = readFileSync(resolve(".github/workflows/osv-scan.yml"), "utf8");
  assert.match(osv, /--recursive\s+\./);
});

test("cold source and existing-consumer preflight install only the managed policy dependency", {
  skip: process.env.WEB_DESIGN_COLD_CLONE_CHILD === "1"
}, () => {
  const cold = mkdtempSync(join(tmpdir(), "web-design-cold-clone-"));
  try {
    const listed = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.equal(listed.status, 0, listed.stderr);
    const files = listed.stdout
      .split("\0")
      .filter(Boolean)
      .filter((file) => file !== ".guard-trusted" && !file.startsWith(".guard-trusted/"));
    for (const file of files) {
      const source = resolve(file);
      if (!existsSync(source)) continue;
      const destination = join(cold, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    for (const args of [["init", "-q"], ["add", "-A"]]) {
      const result = spawnSync("git", args, { cwd: cold, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }

    assert.equal(existsSync(join(cold, "node_modules")), false);
    const consumerPackagePath = join(cold, "package.json");
    const projectPath = join(cold, ".web-design/project.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    const lockPath = join(cold, ".web-design/lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    let consumerPackageBytes;

    if (project.governance.mode === "source") {
      const preflight = spawnSync("npm", ["run", "preflight"], {
        cwd: cold,
        encoding: "utf8",
        env: { ...process.env, WEB_DESIGN_COLD_CLONE_CHILD: "1" },
        timeout: 60_000
      });
      assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
      assert.equal(existsSync(join(cold, ".web-design/policy/node_modules/yaml")), true);
      assert.equal(existsSync(join(cold, "node_modules")), false);

      const consumerPackage = JSON.parse(readFileSync(consumerPackagePath, "utf8"));
      delete consumerPackage.scripts["policy:install"];
      consumerPackage.scripts.preflight = "npm run check && npm test";
      consumerPackageBytes = `${JSON.stringify(consumerPackage, null, 2)}\n`;
      writeFileSync(consumerPackagePath, consumerPackageBytes);

      project.commands.check = [{ name: "baseline tests", run: "npm test" }];
      project.governance.mode = "consumer";
      writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
      lock.sourceCommit = "a".repeat(40);
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      rmSync(join(cold, ".web-design/policy/node_modules"), { recursive: true, force: true });
    } else {
      assert.equal(project.governance.mode, "consumer");
      assert.match(lock.sourceCommit, /^[a-f0-9]{40}$/);
      consumerPackageBytes = readFileSync(consumerPackagePath, "utf8");
      assert.equal(existsSync(join(cold, ".web-design/policy/node_modules")), false);
    }

    const consumerInstall = spawnSync(
      "npm",
      ["ci", "--ignore-scripts", "--prefix", ".web-design/policy"],
      { cwd: cold, encoding: "utf8" }
    );
    assert.equal(consumerInstall.status, 0, consumerInstall.stderr || consumerInstall.stdout);
    const consumerPreflight = spawnSync("npm", ["run", "preflight"], {
      cwd: cold,
      encoding: "utf8",
      env: { ...process.env, WEB_DESIGN_COLD_CLONE_CHILD: "1" },
      timeout: 60_000
    });
    assert.equal(consumerPreflight.status, 0, consumerPreflight.stderr || consumerPreflight.stdout);
    assert.equal(readFileSync(consumerPackagePath, "utf8"), consumerPackageBytes);
  } finally {
    rmSync(cold, { recursive: true, force: true });
  }
});

test("project CI installs lockfile dependencies before running configured checks", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const install = workflow.indexOf("npm ci --prefix");
  const checks = workflow.indexOf("node scripts/run-project-checks.mjs");
  assert.match(workflow, /-name package-lock\.json -o -name npm-shrinkwrap\.json/);
  assert.ok(install !== -1 && install < checks);
});

test("CODEOWNERS protects every managed and release-control path", () => {
  const codeowners = readFileSync(resolve(".github/CODEOWNERS"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0]);
  const managed = JSON.parse(readFileSync(resolve(".web-design/managed-files.json"), "utf8"));
  const paths = [
    ...managed.files,
    ".web-design/lock.json",
    ".web-design/release-manifest.json"
  ];
  for (const path of paths) {
    assert.ok(
      codeowners.some((pattern) => {
        const normalized = pattern.replace(/^\//, "");
        return normalized.endsWith("/") ? path.startsWith(normalized) : path === normalized;
      }),
      `${path} must be covered by CODEOWNERS`
    );
  }
});

test("trusted baseline verification is repository-identity and run-SHA bound", () => {
  const workflow = readFileSync(resolve(".github/workflows/baseline-source-verification.yml"), "utf8");
  const codeowners = readFileSync(resolve(".github/CODEOWNERS"), "utf8");
  assert.match(workflow, /GITHUB_REPOSITORY" != "kiaquila\/web-design"/);
  assert.match(workflow, /RUN_HEAD_SHA" != "\$ASSOCIATED_HEAD_SHA"/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(codeowners, /^\/\.github\/ @kiaquila$/m);
});

test("repository guard uses branch policy only for the template-v2 bootstrap", () => {
  const workflow = readFileSync(resolve(".github/workflows/repository-guard.yml"), "utf8");
  assert.equal((workflow.match(/\.guard-trusted\/\.web-design\/project\.json/g) ?? []).length, 2);
  assert.match(workflow, /Template-v2 policy is not on the default branch yet/);
  assert.match(workflow, /Managed baseline policy is not on the default branch yet/);
});

test("GitHub setup records the plan-limited manual protection fallback", () => {
  const setup = readFileSync(resolve("docs/operations/github-setup.md"), "utf8");
  assert.match(setup, /when the repository plan supports it/i);
  assert.match(setup, /exact full head SHA/);
  assert.match(setup, /P0-P2/);
  assert.match(setup, /120-second quiet\s+period/);
  assert.match(setup, /Do not make a private repository public/);
});

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
import { scanRepository, validateProjectConfig, validateWorkflowText } from "../scripts/check-repository.mjs";

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
    // The tool's own command position: `npm run check --prefix website` is the
    // same run as `npm --prefix website run check`, with the flag after it.
    "npm run check --prefix website",
    "npm ci --prefix website && npm run check --prefix website",
    "uv run pytest",
    // Options may sit between the verb and the command for a tool that errors
    // without one, and a formatter asked for a verdict is a real check.
    "make test version=1",
    "uv run npm run check",
    "uv run scripts/check.py",
    "npm run lint",
    "node scripts/lint.mjs",
    "cargo fmt --check",
    "pytest",
    "pytest tests/unit",
    "node scripts/check.mjs",
    "bash scripts/build.sh",
    // The script name follows the verb; flags fit after it, and an option
    // before the verb may still take its own value.
    "npm run check --silent",
    "npm run test --prefix packages/website"
  ];
  for (const run of accepted) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("the onboarding command the README teaches is a valid product check", () => {
  // A consumer replaces this README with its own, so the onboarding text is
  // only the source's to keep true.
  const project = JSON.parse(readFileSync(resolve(".web-design/project.json"), "utf8"));
  if (project.governance.mode !== "source") return;
  const readme = readFileSync(resolve("README.md"), "utf8");
  const documented = [...readme.matchAll(/--check "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(documented.length, "README must document at least one --check command");
  for (const run of documented) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("an abbreviated option is refused rather than resolved", () => {
  // Whether an abbreviation is unambiguous is a question about the tool's
  // whole option list, which this file cannot hold: npm expands `--i` to
  // `--iwr` rather than to `--if-present`. So the check says what it means.
  for (const run of [
    "npm test --vers", "npm run check --pref website", "cargo fmt --check-o",
    "cargo fmt --che", "npm run check --sil"
  ]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must spell out its options rather than abbreviate them"],
      run
    );
  }
});

test("an informational flag beats the verb in front of it", () => {
  for (const run of [
    "npm test --version", "npm run check --help", "go test --version", "pytest --help",
    // Short spellings every tool in these classes reads the same way.
    "pytest -h", "pytest -V", "npm test -h", "tox -h",
    // `-v` is npm's version but pytest's verbosity, so it is judged per tool.
    "npm test -v", "npm run check -v", "make -v", "mvn -v",
    // An option is the only way to neuter a tool that runs the suite alone.
    "pytest --collect-only", "pytest --co", "pytest -v", "tox -e py311",
    // An interpreter option's value is not the file operand.
    "python3 -X pycache_prefix=foo/bar -V", "python3 -X importtime -V",
    // A source string is not a file operand, however path-shaped it looks.
    "python3 -c \"'' # scripts/check.py\"", "node -e \"0 // scripts/check.mjs\"",
    // A separated option value cannot be told from the operand, so an
    // interpreter option that takes one fails closed.
    "python3 -X importtime scripts/check.py"
  ]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must execute a real product check"],
      run
    );
  }
  // The interpreter's own informational flags still count, before the file.
  for (const run of [
    "node -h scripts/check.mjs",
    "python3 --version scripts/check.py",
    // A runtime's terminal modes are its own and there is no end of them, so
    // the file comes first with nothing before it.
    "python3 --help-env scripts/check.py",
    "node --v8-options scripts/check.mjs",
    "node --test tests/a.test.mjs"
  ]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must execute a real product check"],
      run
    );
  }
  // Past `--`, and past a runtime's file operand, the words belong to the
  // script rather than the tool.
  for (const run of [

    "go test -v ./...",
    "python3 scripts/check.py -V",
    "node scripts/check.mjs -h",
    "bash scripts/build.sh --help"
  ]) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("the checks real projects configure stay expressible", () => {
  // Every tightening of the check rules risks refusing a project that was
  // doing nothing wrong, and several rounds of review did exactly that before
  // the reversal was noticed. This is the shape of a consumer's real
  // configuration, one line per ecosystem, kept here so a future rule has to
  // answer for it.
  const realistic = [
    "npm test",
    "npm run check",
    "npm run check --prefix website",
    "npm ci --prefix website && npm run check --prefix website",
    "node scripts/check.mjs",
    "pytest",
    "pytest tests/unit",
    "uv run pytest",
    "python3 scripts/check.py",
    "go test ./...",
    "go vet ./...",
    "cargo test",
    "cargo fmt --check",
    "bundle exec rspec",
    "make check",
    "npm run lint",
    "npm run build && npm test",
    "composer test",
    "mvn verify",
    "gradle test",
    "swift test",
    "dotnet test",
    // Cargo's operand is a test filter, not a subcommand, whatever it says.
    "cargo test list",
    "bash scripts/check.sh"
  ];
  for (const run of realistic) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("a named option's value is read as the path it is", () => {
  // Naming `--prefix` is not the same as reading it: an unconstrained value
  // points npm at an unreviewed package whose script exits zero, without the
  // command looking any different.
  for (const run of [
    "npm run check --prefix /tmp/noop-package",
    "npm run check --prefix=node_modules/noop-package",
    "npm run check --prefix ../outside", "npm run check --prefix packages/@scope/../../../etc",
    "npm run check --prefix node_modules/noop-package",
    "npm run check --prefix dist",
    // `--workspace` takes a name rather than a path, and a name is resolved by
    // reading a manifest this guard does not open, so it is not named at all.
    "npm run test --workspace website", "npm run test --workspace=website",
    // A named option with no value at all is npm's error, and this file's too,
    // and a value that starts with a dash is an option rather than a path.
    "npm run check --prefix", "npm run check --prefix --silent",
    "npm run check --prefix -- --silent"
  ]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must execute a real product check"],
      run
    );
  }
  for (const run of [
    "npm run check --prefix website", "npm run check --prefix=website",
    "npm run check --prefix apps/web",
    // A workspace is reached by the spelling that is a path, and a scoped
    // package sits at a path with an `@` in it.
    "npm run test --prefix packages/website",
    "npm run check --prefix packages/@scope/pkg"
  ]) {
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
  for (const run of ['npm run lint "a!b"', "npm run lint!"]) {
    const valid = structuredClone(config);
    valid.commands.check = [{ name: "site", run }];
    assert.deepEqual(validateProjectConfig(valid, ["no-deploy"]), [], run);
  }
});

test("a leading assignment reconfigures the tool and is refused", () => {
  // `npm_config_if_present=true npm run check` sets the flag through the
  // environment, and `npm_config_script_shell=true npm test` replaces the
  // shell the script runs in. Which names matter is a fact about each tool,
  // so none of them may be set here — a check that needs environment sets it
  // inside the script it runs.
  for (const run of [
    "FOO=bar npm test",
    "FOO='a b' npm test",
    "npm_config_if_present=true npm run check",
    "npm_config_script_shell=true npm test",
    "FOO=bar true"
  ]) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must not set environment variables ahead of the command"],
      run
    );
  }
});

test("a product check may not be wrapped", () => {
  const wrapped = [
    "command true",
    "env -u FOO true",
    "stdbuf -o L true",
    "nice -n 5 npm test",
    "timeout 600 npm --prefix website run check",
    "sudo npm test"
  ];
  for (const run of wrapped) {
    const invalid = structuredClone(config);
    invalid.commands.check = [{ name: "site", run }];
    assert.deepEqual(
      validateProjectConfig(invalid, ["no-deploy"]),
      ["commands.check[0].run must not wrap the product command; the first word decides the exit status"],
      run
    );
  }
});

test("rejects commands that only report success", () => {
  const noOps = [
    "true", ":", "exit 0", "echo ok", "printf ok", "npm test && true", "echo ok && npm test",
    "true ignored", ": ignored", "/bin/true ignored", "/usr/bin/true", "/bin/echo ok",
    // Nothing distinguishes these from the familiar no-ops except that an
    // enumeration had not reached them yet.
    "sleep 0", "sleep 0 && npm test", "test -e package.json", "[ -e package.json ]",
    "cat package.json", "ls", "cd website",
    // Fetching dependencies is how a check gets something to run, not a check.
    "npm install", "npm ci", "npm ci --prefix website", "yarn install", "bundle install",
    // A verdict on the dependency tree, a rewrite of the source, or a server
    // that never returns is not a verdict on the product.
    "npm audit", "cargo fmt", "npm start", "uv sync --no-install-project",
    // npm lists its scripts and exits zero when the name is missing, so the
    // name still has to follow the verb there.
    "npm run --workspace website",
    // And succeeds silently when the script it names is missing.
    "npm run check --if-present", "pnpm run check --if-present",
    "npm run check --if-present=true", "npm run check --if-present=0",
    "npm run check --if-present=no", "npm run check --if-present=FALSE",
    "npm run check --if-present=garbage",
    // `exec` names a command rather than a script the package defines.
    "npm exec true", "npm exec eslint .",
    // npm's built-in `env` script prints the environment and exits zero.
    "npm run env", "pnpm run env",
    // Past `--` the words reach whatever the named script runs, which can be
    // another tool in these same classes — `npm run check -- --dry-run` hands
    // the flag to a `check` script that may be `make test`. Which tool
    // receives them is a fact about a script this guard does not read, so the
    // separator is refused rather than scanned.
    "npm run check -- --help", "npm test -- --version",
    "npm run check -- --dry-run", "npm test -- --if-present",
    "npm test -- -x", 'npm test -- --grep "a|b"', "npm run format -- --check",
    "npm run build -- --tag '#1'", "npm run x -- --shell -c",
    // A double negative turns it back on.
    "npm run check --no-if-present=false", "npm run check --no-if-present=true",
    // The flag is refused in every spelling, set either way: reading its value
    // is the question that kept producing findings.
    "npm run check --if-present=false", "npm run check --no-if-present",
    "npm run check --no-if-present false",
    // The dashes say how the word was typed, not what it means.
    "npm run check -if-present", "npm test -version",

    // After a formatter verdict the trailing words reach the formatter rather
    // than the project.
    "cargo fmt --check -- --help", "cargo fmt --check -- --version",
    "cargo fmt --check -- --help=config", "npm test --version=1",
    // A dispatched command is read like any other check.
    "uv run --no-project true", "uv run echo ok", "bundle exec ls",
    // A runner dispatches to a dependency's binary, which can be a no-op.
    // A runtime that runs an application rather than returning a verdict, and
    // whose own informational surface is idiosyncratic, is not a check tool.
    "java -jar app.jar", "java -X scripts/check.jar",
    // An option that names output reports instead of working: `swift build
    // --show-bin-path` prints a path and compiles nothing.
    "swift build --show-bin-path", "cargo build --list", "npm run check --dry-run",
    "npm test --print-config",
    // The same options with one dash, since how it was typed is not what it
    // means.
    "swift build -show-bin-path", "cargo build -list", "npm run check -dry-run",
    // A single letter means whatever its tool says: `-n` is Make's dry run
    // and pytest's worker count, `-t` marks Make targets done without running
    // them. Only the verbose flag the classes model is readable.
    "make test -n", "make test -t", "npm run check -s",
    // A single-dash word is readable only where the tool spells names that
    // way: `-fn` is Maven's `--fail-never`, `-nis` a Make cluster hiding the
    // dry run, and neither tool documents single-dash names.
    "mvn test -fn", "make test -nt", "make test -nis", "npm run check -ws",
    // Make's documented modes that skip the recipe, in their spelled forms.
    // The work runs and the verdict is thrown away — what `|| true` does one
    // layer up, and refused for the same reason.
    "npm test --script-shell=/bin/true", "make test --ignore-errors",
    "mvn test --fail-never", "ruff check --exit-zero",
    // A wrapper that replaces the test binary, and a reporting name worn as a
    // subcommand rather than a flag.
    "go test -exec /bin/true ./...", "swift test list",
    // Swift puts its options before the subcommand.
    "swift test --configuration debug list",
    // Options are refused by not being named now, which reaches the siblings
    // an enumeration had to be extended for one at a time.
    "go test -toolexec /bin/true ./...", "go test -c ./...", "go test -o /dev/null ./...",
    "go test -count=0 ./...", "go test --count=0 ./...", "cargo test --no-run",
    "gradle test --exclude-task test", "swift test --skip-build",
    "go test -race ./...", "go test -run TestName ./...",
    "swift test -Xswiftc -warnings-as-errors", "make test -nis", "mvn -fn verify",
    "make test --touch", "make test --question", "make test --just-print",
    "make test --recon", "make test --what-if test", "make test --new-file x",
    "make test --assume-new x",

    // A runner reaches for a dependency's binary, which the guard cannot
    // read: an analyser runs as a package script or a script in the tree.
    "npx true", "npx echo ok", "npx --yes true", "npx eslint .", "npx tsc --noEmit",
    // Nothing sits between the verb and the command, so an option's value can
    // never be read as one — the short spelling of a value-taking option was
    // what leaked when the arity table was partial.
    "uv run --locked pytest", "uv run --directory website pytest",
    "uv run --no-project -w pytest true", "bundle exec --keep-file-descriptors rspec",
    // A check-shaped word that is only an argument to the dispatched command.
    "uv run --no-project true pytest", "bundle exec ls pytest",
    // A slash is not a project: a runtime's operand has to be a path this
    // repository could hold.
    "node /dev/null", "bash /dev/null", "node ../outside/run.mjs", "node ~/run.mjs",
    // An allowlisted executable still reports on itself rather than the
    // product when nothing points it at project code.
    "npm --version", "node --version", "node -v", "go version", "npm --prefix website",
    "npm test && npm --version",
    // `npm run` lists the scripts and exits zero; the script name is the target.
    "npm run", "npm run --silent", "npm exec", "npm --prefix website run",
    // An option between the verb and the name swallows the name: this lists
    // one workspace's scripts and exits zero.
    "npm run --workspace website", "npm exec --yes",
    // `config` is the command; `test` is only a key it reads.
    "npm config get test", "npm config get run x", "npm view . scripts",
    // A verb behind the tool's real command is not the command, and a verb
    // that is only an option's value is not one either.
    "npm run --workspace website test",
    "npm --prefix test config get cache",
    "npm --prefix build config list",
    // An option's value is not the command position, even when only options
    // follow it.
    "npm --prefix build --version", "npm --prefix test", "npx --version", "pytest --version"
  ];
  for (const run of noOps) {
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
  expansion.commands.check = [{ name: "site", run: 'npm run lint "$(evil)"' }];
  assert.deepEqual(
    validateProjectConfig(expansion, ["no-deploy"]),
    ["commands.check[0].run must not expand anything outside single quotes"]
  );
  const singleQuoted = structuredClone(config);
  singleQuoted.commands.check = [{ name: "site", run: "npm run lint '$(literal)'" }];
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

test("a workflow the scan cannot read is refused, not skipped", () => {
  // The size and binary caps keep a large asset from being read as text, and
  // they used to skip the file outright — including a workflow, whose
  // contents are the security boundary this guard exists to read. A workflow
  // padded past the cap would otherwise pass every rule by never being read.
  const root = mkdtempSync(join(tmpdir(), "web-design-unreadable-workflow-"));
  try {
    spawnSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const padding = `# ${"pad".repeat(40)}\n`.repeat(20000);
    writeFileSync(
      join(root, ".github/workflows/oversized.yml"),
      `${padding}on: issue_comment\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n`
    );
    writeFileSync(join(root, ".github/workflows/binary.yml"), Buffer.from([0, 1, 2, 3, 0, 0]));
    const { failures } = scanRepository(root);
    assert.match(failures.join("\n"), /Workflow file is too large to validate/);
    assert.match(failures.join("\n"), /Workflow file is not readable text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-all is refused wherever it is asked for", () => {
  // The refusal used to read only the top-level block, so a job could ask for
  // what the workflow could not.
  for (const workflow of [
    "on:\n  push:\n    branches: [main]\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
    "on:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  a:\n    permissions: write-all\n    runs-on: ubuntu-latest\n"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", workflow).join("\n"),
      /may not use write-all permissions/,
      workflow
    );
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

test("a manual write job needs an environment, not only its own condition", () => {
  // A manual run picks a ref and GitHub loads that ref's copy of the file, so
  // a branch could delete the condition before asking for the token. An
  // environment is GitHub's to decide, and a branch cannot rewrite it.
  const gated = (extra) =>
    `on: [pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  publish:\n    if: \${{ github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}\n${extra}    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n`;
  assert.match(
    validateWorkflowText(".github/workflows/example.yml", gated("")).join("\n"),
    /may not grant write permissions/
  );
  assert.deepEqual(
    validateWorkflowText(".github/workflows/example.yml", gated("    environment: release\n")),
    []
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      gated("    environment:\n      name: release\n")
    ),
    []
  );
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

test("a checkout repository override is untrusted even without a ref", () => {
  const workflow = (withLines) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n${withLines}      - run: npm ci\n`;
  for (const withLines of [
    "          repository: ${{ github.event.comment.body }}\n",
    "          repository: octo/evil\n",
    "          repository: octo/evil\n          ref: main\n"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", workflow(withLines)).join("\n"),
      /checks an untrusted ref out over the workspace/,
      withLines
    );
  }
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      workflow("          repository: ${{ github.repository }}\n          ref: main\n")
    ),
    []
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      workflow("          repository: octo/tool\n          path: candidate\n")
    ),
    []
  );
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

test("cd options and parent segments still land in the isolated checkout", () => {
  const step = (run, wd) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n${wd ? `        working-directory: ${wd}\n` : ""}`;
  for (const run of ["cd -P candidate && npm ci", "cd -L -P candidate && npm ci", "cd candidate/sub/.. && npm ci"]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /executes code from the untrusted checkout candidate/,
      run
    );
  }
  assert.match(
    validateWorkflowText(".github/workflows/example.yml", step("npm ci", "candidate/sub/..")).join("\n"),
    /executes code from the untrusted checkout candidate/
  );
  assert.deepEqual(validateWorkflowText(".github/workflows/example.yml", step("cd website && npm ci")), []);
  assert.deepEqual(validateWorkflowText(".github/workflows/example.yml", step("npm ci", "candidate-other")), []);
});

test("the option terminator and a computed working directory are both caught", () => {
  const withStep = (step, rootDefault = "") =>
    `on: issue_comment\npermissions:\n  contents: write\n${rootDefault}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n${step}`;
  for (const run of ["cd -- candidate && npm ci", "cd -P -- candidate && npm ci"]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", withStep(`      - run: ${run}\n`)).join("\n"),
      /executes code from the untrusted checkout candidate/,
      run
    );
  }
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      withStep("      - run: npm ci\n        working-directory: ${{ 'candidate' }}\n")
    ).join("\n"),
    /computed working directory alongside the untrusted checkout candidate/
  );
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      withStep("      - run: npm ci\n", "defaults:\n  run:\n    working-directory: ${{ inputs.dir }}\n")
    ).join("\n"),
    /computed working directory alongside the untrusted checkout candidate/
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      withStep("      - run: npm ci\n        working-directory: website\n")
    ),
    []
  );
});

test("a write-capable job may not name an actor-controlled ref in its shell", () => {
  const shellStep = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n${run.split("\n").map((line) => `          ${line}`).join("\n")}\n`;
  const refused = [
    "gh pr checkout ${{ github.event.issue.number }} && npm ci",
    "gh pr checkout 12",
    "git fetch origin \\\n  refs/pull/12/head:candidate\ngit switch candidate && npm ci",
    "git fetch origin ${{ github.event.workflow_run.head_sha }}",
    "git checkout FETCH_HEAD"
  ];
  for (const run of refused) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", shellStep(run)).join("\n"),
      /names an actor-controlled ref in its shell/,
      run
    );
  }
  for (const run of ["npm ci && npm test", "git fetch origin main && npm ci"]) {
    assert.deepEqual(validateWorkflowText(".github/workflows/example.yml", shellStep(run)), [], run);
  }
});

test("an actor-controlled ref reaching the shell through env is refused", () => {
  const withEnv = (where) =>
    `on: issue_comment\npermissions:\n  contents: write\n${where === "workflow" ? "env:\n  CANDIDATE_REF: ${{ github.event.comment.body }}\n" : ""}jobs:\n  a:\n    runs-on: ubuntu-latest\n${where === "job" ? "    env:\n      CANDIDATE_REF: ${{ github.event.comment.body }}\n" : ""}    steps:\n      - run: git fetch origin "$CANDIDATE_REF:candidate" && git switch candidate && npm ci\n${where === "step" ? "        env:\n          CANDIDATE_REF: ${{ github.event.comment.body }}\n" : ""}`;
  for (const where of ["workflow", "job", "step"]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", withEnv(where)).join("\n"),
      /names an actor-controlled ref in its shell/,
      where
    );
  }
  // With no actor expression in scope the same shell is fine — the name it
  // uses has to be one the workflow set, which is the rule one layer down.
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      withEnv("none").replace(
        "    steps:\n",
        "    env:\n      CANDIDATE_REF: main\n    steps:\n"
      )
    ),
    []
  );
});

test("a computed cd destination fails closed beside an untrusted checkout", () => {
  const step = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n`;
  for (const run of ['target=candidate; cd "$target" && npm ci', 'cd "${DIR}" && npm ci', "cd can* && npm ci", "cd ca?didate && npm ci", "cd cand{i..i}date && npm ci", "cd ~/candidate && npm ci", "cd - && npm ci", "cd cand\\idate && npm ci"]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /executes code from the untrusted checkout candidate/,
      run
    );
  }
  assert.deepEqual(validateWorkflowText(".github/workflows/example.yml", step("cd website && npm ci")), []);
});

test("no environment value may name the untrusted tree", () => {
  const step = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n`;
  for (const run of [
    'PATH="$PWD/candidate:$PATH" evil',
    'export NODE_PATH="$GITHUB_WORKSPACE/candidate"',
    "TARGET=candidate && node run.mjs",
    'X="a b/candidate" && node run.mjs',
    "X=cand\\idate && node run.mjs"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /seeds the environment with the untrusted checkout candidate/,
      run
    );
  }
  const stepEnv =
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - env:\n          EXTRA: candidate\n        run: node run.mjs\n`;
  assert.match(
    validateWorkflowText(".github/workflows/example.yml", stepEnv).join("\n"),
    /seeds the environment with the untrusted checkout candidate/
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('GH_TOKEN="$SOURCE_TOKEN" node scripts/check.mjs --workspace "$GITHUB_WORKSPACE"').replace(
        "      - run:",
        "      - env:\n          SOURCE_TOKEN: ${{ secrets.READ_TOKEN }}\n        run:"
      )
    ),
    []
  );
});

test("a computed environment value fails closed beside an untrusted checkout", () => {
  const jobEnv = (value) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      SEEDED: ${value}\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: node run.mjs\n`;
  for (const value of [
    "${{ format('{0}/{1}', github.workspace, 'candidate') }}",
    "${{ github.workspace }}",
    "${{ github.event.comment.body }}"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", jobEnv(value)).join("\n"),
      /carries a computed environment value alongside the untrusted checkout candidate/,
      value
    );
  }
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      jobEnv("${{ steps.x.outcome == 'ok' && 'candidate' || 'other' }}")
    ).join("\n"),
    /seeds the environment with the untrusted checkout candidate/
  );
  for (const value of [
    "${{ github.token }}",
    "${{ secrets.READ_TOKEN || github.token }}",
    "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    "${{ steps.gate.outcome == 'success' && 'success' || 'failure' }}"
  ]) {
    assert.deepEqual(validateWorkflowText(".github/workflows/example.yml", jobEnv(value)), [], value);
  }
});

test("step outputs cannot launder the untrusted tree into the environment", () => {
  const chain = (seedRun) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - id: seed\n        run: ${seedRun}\n      - env:\n          SEEDED: \${{ steps.seed.outputs.path }}\n        run: node run.mjs\n`;
  for (const seedRun of [
    'echo "path=$PWD/candidate" >> "$GITHUB_OUTPUT"',
    'printf \'path=%s/candidate\\n\' "$PWD" > result && cat result >> "$GITHUB_OUTPUT"',
    'cat result >> "$GITHUB_OUTPUT"'
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", chain(seedRun)).join("\n"),
      /touches the step environment files alongside the untrusted checkout candidate/,
      seedRun
    );
  }
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      chain('y=cand && x="$y"idate && node run.mjs "$x"')
    ).join("\n"),
    /assembles a shell value alongside the untrusted checkout candidate/
  );
  // Even a managed producer cannot hand the value on through an output: what
  // an output holds is whatever its producer put there. A step that needs the
  // value does the work itself.
  assert.match(
    validateWorkflowText(".github/workflows/example.yml", chain("node scripts/seed.mjs")).join("\n"),
    /carries a computed environment value alongside the untrusted checkout candidate/
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: node scripts/verify.mjs\n`
    ),
    []
  );
});

test("an environment-file name cannot be assembled or reached indirectly", () => {
  const step = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n`;
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('name=GITHUB_""OUTPUT; echo "path=$PWD/candidate" >> "${!name}"')
    ).join("\n"),
    /assembles a shell value alongside the untrusted checkout candidate/
  );
  for (const run of [
    'echo "path=x" >> "${!name}"',
    'echo "path=x" >> "${name:-out}"',
    'echo "path=$(pwd)/candidate" >> out',
    "echo `pwd` > out",
    'echo "$((1+1))" > out'
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /expands more than a whole variable alongside the untrusted checkout candidate/,
      run
    );
  }
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('node run.mjs "$GITHUB_WORKSPACE" "${CI}"')
    ),
    []
  );
});

test("an actor-triggered write job is constrained even without a checkout", () => {
  const workflow = (stepYaml) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${stepYaml}`;
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      workflow(
        "      - uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea\n        with:\n          github-token: ${{ github.token }}\n          script: eval(context.payload.comment.body)\n"
      )
    ).join("\n"),
    /uses an action that is not vouched for/
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      workflow("      - uses: ./scripts/action\n      - run: node scripts/handle.mjs\n")
    ),
    []
  );
  // A repository-controlled event keeps its own tooling: the payload is the
  // repository's own, so a deploy job may use its provider's action.
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      "on:\n  push:\n    branches: [main]\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: cloudflare/wrangler-action@da0e0dfe58b7a431659754fdf3f186c529afbe65\n"
    ),
    []
  );
});

test("an expression that cannot be read fails closed in an actor-triggered write job", () => {
  const step = (stepYaml) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${stepYaml}`;
  for (const stepYaml of [
    "      - run: eval \"${{ github['event']['comment']['body'] }}\"\n",
    // A checkout input the checkout rules never read: this one sends the
    // checkout and its write-scoped token to a server the commenter picks.
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: main\n          github-server-url: ${{ github.event.comment.body }}\n",
    // A producer can put the comment body in an output, so an output is not
    // provably free of it.
    "      - id: seed\n        run: node scripts/seed.mjs\n      - env:\n          BODY: ${{ steps.seed.outputs.body }}\n        run: eval \"$BODY\"\n",
    "      - env:\n          BODY: ${{ github['event']['comment']['body'] }}\n        run: node run.mjs\n",
    "      - run: node run.mjs ${{ fromJSON(github.event.comment.body).ref }}\n",
    "      - run: node run.mjs ${{ format('{0}', github.event.comment.body) }}\n"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(stepYaml)).join("\n"),
      /carries an expression that cannot be read/,
      stepYaml
    );
  }
  // The payload can also arrive with no expression at all.
  for (const [stepYaml, expected] of [
    ['      - run: eval "$(jq -r .comment.body \"$GITHUB_EVENT_PATH\")"\n', /runs shell that cannot be read/],
    ['      - run: jq -r .comment.body "$GITHUB_EVENT_PATH" > payload\n', /reads the event payload in its shell/],
    ['      - run: bash -c "$(cat payload)"\n', /runs shell that cannot be read/],
    ['      - run: name=GITHUB_""EVENT_PATH\n', /runs shell that cannot be read/],
    // The same payload reached by walking to it, or by a variable that maps
    // the walk.
    ['      - run: jq -r .comment.body ../../_temp/_github_workflow/event.json > payload\n', /reaches outside the workspace/],
    ['      - run: cat /tmp/_github_workflow/event.json > payload\n', /reaches outside the workspace/],
    ['      - run: cat "$RUNNER_TEMP/_github_workflow/event.json" > payload\n', /reaches outside the workspace/],
    // The escaping path can sit in `env` while the shell names a variable,
    // and a Windows runner path holds no forward slash at all.
    ['      - env:\n          EVENT: ../../_temp/_github_workflow/event.json\n        run: jq -r .comment.body "$EVENT" > payload\n', /reaches outside the workspace/],
    ['      - run: type \'D:\\a\\_temp\\_github_workflow\\event.json\'\n', /reaches outside the workspace/],
    ['      - env:\n          EVENT: D:\\a\\_temp\\_github_workflow\\event.json\n        run: node run.mjs\n', /reaches outside the workspace/],
    // The move can be the escape: the command then names a plain filename.
    ['      - working-directory: ../../_temp/_github_workflow\n        run: jq -r .comment.body event.json > payload\n', /reaches outside the workspace/],
    ['      - working-directory: ${{ github.event.comment.body }}\n        run: node run.mjs\n', /carries an expression that cannot be read/],
    // An operand prefix glued to the climb, and a bare climb with no
    // separator at all.
    ['      - run: dd if=../../_temp/_github_workflow/event.json of=event.json\n', /reaches outside the workspace/],
    ['      - run: cp ../../_temp/_github_workflow/event.json event.json\n', /reaches outside the workspace/],
    ['      - run: cd ..\n', /reaches outside the workspace/],
    // A quote can sit between the operand prefix and the path.
    ['      - run: dd if="/tmp/_github_workflow/event.json" of=event.json\n', /reaches outside the workspace/],
    ['      - run: dd if=\'../../_temp/_github_workflow/event.json\' of=event.json\n', /reaches outside the workspace/],
    // A name bound by `read` is not a name the workflow set.
    ['      - run: printenv > vars && read EVENT < vars && jq -r .comment.body "$EVENT" > payload\n', /uses a variable the workflow did not set/],
    ['      - run: node run.mjs "$SECRET_PATH"\n', /uses a variable the workflow did not set/],
    // A harmless assignment does not make the later reference readable: the
    // name can be rebound in between.
    ['      - env:\n          EVENT: event.json\n        run: EVENT=safe && read EVENT < vars && jq -r .comment.body "$EVENT" > payload\n', /uses a variable the workflow did not set/],
    ['      - env:\n          TARGET: website\n        run: read TARGET < vars && node run.mjs "$TARGET"\n', /moves data through its shell/],
    // A name can be rebound by a file the scan never reads, so the shell does
    // not get to build files, read them back, or source them.
    ['      - env:\n          EVENT: event.json\n        run: printenv > vars\n', /moves data through its shell/],
    ['      - env:\n          EVENT: event.json\n        run: . bind\n', /moves data through its shell/],
    ['      - env:\n          EVENT: event.json\n        run: source bind\n', /moves data through its shell/],
    ['      - run: cat vars | grep EVENT\n', /moves data through its shell/],
    // A program in another language, wearing quotes.
    ['      - run: python3 -c \'import os,json;exec(json.load(open(os.environ["X"]))["b"])\'\n', /quotes a program in its shell/],
    ['      - run: node -e "require(process.env.X)"\n', /quotes a program in its shell/],
    // The same program handed through the door the shell is allowed to use.
    ['      - env:\n          PROGRAM: \'import os;exec(os.environ["X"])\'\n        run: python3 -c "$PROGRAM"\n', /quotes a program in its environment/]
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(stepYaml)).join("\n"),
      expected,
      stepYaml
    );
  }
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('      - env:\n          TARGET: website\n        run: node run.mjs "$TARGET" "$GITHUB_WORKSPACE"\n')
    ),
    []
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('      - run: git -C . pull origin main\n')
    ),
    []
  );
  // A quoted word is still fine when it is a path or a whole variable.
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('      - run: node "$GITHUB_WORKSPACE/scripts/run.mjs"\n')
    ),
    []
  );
  // The forms the baseline's own actor-triggered write jobs rely on.
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step(
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.repository.default_branch }}\n      - env:\n          GITHUB_TOKEN: ${{ github.token }}\n          SOURCE_TOKEN: ${{ secrets.READ_TOKEN || github.token }}\n        run: node scripts/request.mjs\n"
      )
    ),
    []
  );
});

test("a run default that leaves the workspace is refused for every step", () => {
  for (const workflow of [
    "on: issue_comment\npermissions:\n  contents: write\ndefaults:\n  run:\n    working-directory: ../../_temp/_github_workflow\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: jq -r .comment.body event.json > payload\n",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: ../../_temp/_github_workflow\n    steps:\n      - run: jq -r .comment.body event.json > payload\n"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", workflow).join("\n"),
      /reaches outside the workspace/,
      workflow
    );
  }
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: website\n    steps:\n      - run: npm run check\n"
    ),
    []
  );
});

test("a write-capable job may not hand actor input to a workflow it calls", () => {
  const called = (jobYaml) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n${jobYaml}`;
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      called(
        "    uses: ./.github/workflows/inner.yml\n    with:\n      ref: ${{ github.event.comment.body }}\n    secrets:\n      TOKEN: ${{ secrets.TOKEN }}\n"
      )
    ).join("\n"),
    /passes an actor-controlled ref to what it calls/
  );
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      called("    uses: octo/shared/.github/workflows/build.yml@bf251b5aa9c2f7eeb574a96ee720e24f801b7c11\n")
    ).join("\n"),
    /calls a workflow that is not vouched for/
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      called("    uses: ./.github/workflows/inner.yml\n    with:\n      head_sha: ${{ inputs.head_sha }}\n")
    ),
    []
  );
});

test("only vouched-for actions may run beside an untrusted checkout", () => {
  const workflow = (stepYaml) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n${stepYaml}`;
  const scripted =
    "      - uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea\n        with:\n          script: await import(process.env.GITHUB_WORKSPACE + '/candidate/payload.mjs')\n";
  assert.match(
    validateWorkflowText(".github/workflows/example.yml", workflow(scripted)).join("\n"),
    /uses an action that is not vouched for beside the untrusted checkout candidate/
  );
  assert.match(
    validateWorkflowText(
      ".github/workflows/example.yml",
      workflow("      - uses: dawidd6/action-download-artifact@bf251b5aa9c2f7eeb574a96ee720e24f801b7c11\n")
    ).join("\n"),
    /uses an action that is not vouched for beside the untrusted checkout candidate/
  );
  assert.deepEqual(
    validateWorkflowText(".github/workflows/example.yml", workflow("      - uses: ./scripts/action\n")),
    []
  );
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      workflow(
        "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020\n        with:\n          node-version: \"22.18.0\"\n"
      )
    ),
    []
  );
});

test("expression interpolation into the shell fails closed beside an untrusted checkout", () => {
  const step = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n`;
  for (const run of ["echo ${{ github.sha }}", "node run.mjs ${{ github.event.comment.body }}"]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /interpolates an expression into its shell alongside the untrusted checkout candidate/,
      run
    );
  }
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.sha }}\n"
    ),
    []
  );
});

test("the step environment files are off the table beside an untrusted checkout", () => {
  const step = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n`;
  for (const run of [
    'echo "$PWD/candidate" >> "$GITHUB_PATH"',
    'echo "X=1" >> "$GITHUB_ENV"',
    'echo "conclusion=ok" >> "$GITHUB_OUTPUT"',
    'echo "done=1" >> "$GITHUB_STATE"'
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /touches the step environment files alongside the untrusted checkout candidate/,
      run
    );
  }
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      step('node scripts/report.mjs')
    ),
    []
  );
});

test("git global options do not hide the subcommand", () => {
  const shellStep = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
  for (const run of [
    "git -C . pull origin pull/12/head && npm ci",
    "git -c user.name=x pull origin pull/9/head",
    "git --git-dir=.g fetch origin refs/pull/3/head",
    "git -C . checkout FETCH_HEAD",
    "git -p pull origin pull/12/head && npm ci",
    "git --paginate pull origin pull/9/head",
    "git -P fetch origin refs/pull/3/head"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", shellStep(run)).join("\n"),
      /names an actor-controlled ref in its shell/,
      run
    );
  }
  assert.deepEqual(
    validateWorkflowText(".github/workflows/example.yml", shellStep("git -C . pull origin main")),
    []
  );
});

test("a write-capable job may not fetch an actor-selected ref with git", () => {
  const shellStep = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
  for (const run of [
    "git fetch origin pull/${{ github.event.issue.number }}/head && git checkout FETCH_HEAD && npm ci",
    "git fetch origin refs/pull/12/head",
    "git checkout FETCH_HEAD"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", shellStep(run)).join("\n"),
      /names an actor-controlled ref in its shell/,
      run
    );
  }
  assert.deepEqual(validateWorkflowText(".github/workflows/example.yml", shellStep("git fetch origin main && npm ci")), []);
});

test("acquisition is refused by the input, whatever tool would do the fetching", () => {
  const withEnv = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          URL: \${{ github.event.comment.body }}\n        run: ${run}\n`;
  for (const run of [
    'curl -o payload "$URL" && bash payload',
    'wget -O payload "$URL"',
    "node fetch.mjs",
    "echo done"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", withEnv(run)).join("\n"),
      /names an actor-controlled ref in its shell/,
      run
    );
  }
  // A managed script reads the payload from the event file, so nothing
  // actor-controlled has to enter the environment in the first place.
  assert.deepEqual(
    validateWorkflowText(
      ".github/workflows/example.yml",
      "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          GITHUB_TOKEN: ${{ github.token }}\n        run: node scripts/handle-event.mjs\n"
    ),
    []
  );
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

test("a write-capable job may not name the isolated checkout in its shell", () => {
  const step = (run) =>
    `on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          path: candidate\n      - run: ${run}\n`;
  for (const run of [
    "node scripts/check.mjs --root candidate",
    "cp -R candidate staged && node staged/run.mjs",
    'tar -cf out.tar "candidate"'
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /names the untrusted checkout candidate in its shell/,
      run
    );
  }
  for (const run of [
    "./cand''idate/evil",
    "cp -R cand* staged && node staged/run.mjs",
    "./cand{i..i}date/evil",
    "~/candidate/evil",
    "./cand\\idate/evil"
  ]) {
    assert.match(
      validateWorkflowText(".github/workflows/example.yml", step(run)).join("\n"),
      /splices a shell word alongside the untrusted checkout candidate/,
      run
    );
  }
  // A managed script derives the path from the workspace itself, which is how
  // the baseline's own verification reaches its isolated tree.
  assert.deepEqual(
    validateWorkflowText(".github/workflows/example.yml", step("node scripts/verify-baseline-source.mjs")),
    []
  );
});

test("keeps an untrusted checkout isolated under its own path", () => {
  const failures = validateWorkflowText(
    ".github/workflows/example.yml",
    "on: issue_comment\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          path: .proposed\n      - run: node scripts/check.mjs --root \"$GITHUB_WORKSPACE\"\n"
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
    "on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  publish:\n    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}\n    environment: release\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n"
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
  assert.ok(baseline.indexOf("npm ci --ignore-scripts") < baseline.indexOf("node scripts/verify-baseline-source.mjs"));

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
  const script = readFileSync(resolve("scripts/verify-baseline-source.mjs"), "utf8");
  const codeowners = readFileSync(resolve(".github/CODEOWNERS"), "utf8");
  assert.match(workflow, /run: node scripts\/verify-baseline-source\.mjs/);
  assert.match(script, /GITHUB_REPOSITORY !== "kiaquila\/web-design"/);
  // The run SHA and the associated pull-request head still have to agree, and
  // both now come from the event payload rather than from interpolated env.
  assert.match(script, /runHeadSha !== associatedHeadSha/);
  assert.match(script, /readFileSync\(GITHUB_EVENT_PATH, "utf8"\)/);
  assert.match(script, /head_sha: runHeadSha/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.equal(/^\s+[A-Z_]+: \$\{\{ github\.event\./m.test(workflow), false);
  // The owner is the repository's own, so the assertion is about coverage
  // rather than identity: a consumer names itself here.
  assert.match(codeowners, /^\/\.github\/ +@\S+$/m);
  assert.match(codeowners, /^\/scripts\/ +@\S+$/m);
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
